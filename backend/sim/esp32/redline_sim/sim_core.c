/* The bridge: a second UART, one JSON object per line each way. It starts
 * right before app_main (app_main itself is wrapped), and a reader task
 * applies what the runtime sends: pin levels, adc volts, freq inputs and
 * transaction replies.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/uart.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "redline_sim.h"

#ifndef REDLINE_SIM_UART
#define REDLINE_SIM_UART UART_NUM_1
#endif
#define SIM_TIMEOUT_MS 5000   /* guest time; the adapter pauses the VM while it waits */
#define SIM_SLOTS 4
#define SIM_LINE 2400

static bool s_up;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static int8_t s_pin[SIM_PINS];
static float s_volts[SIM_PINS];
static struct { double hz, acc; int64_t t0; } s_freq[SIM_PINS];
static struct { int id; bool busy; int ack; uint8_t *buf; size_t len; SemaphoreHandle_t done; } s_slot[SIM_SLOTS];
static int s_seq;

static void put(const char *s, size_t n) { uart_write_bytes(REDLINE_SIM_UART, s, n); }

void sim_emit(const char *type, const char *fmt, ...) {
    if (!s_up || xPortInIsrContext()) return;   /* never block an ISR */
    char b[192];
    int n = snprintf(b, sizeof b, "{\"type\":\"%s\",\"t\":%lld,", type, (long long)esp_timer_get_time());
    va_list ap;
    va_start(ap, fmt);
    n += vsnprintf(b + n, sizeof b - n - 2, fmt, ap);
    va_end(ap);
    if (n > (int)sizeof b - 3) n = sizeof b - 3;
    b[n++] = '}';
    b[n++] = '\n';
    put(b, n);
}

int sim_pin_in(int g) { return (g >= 0 && g < SIM_PINS) ? s_pin[g] : -1; }
double sim_adc_in(int g) { return (g >= 0 && g < SIM_PINS) ? s_volts[g] : -1; }

double sim_pulses(int g) {
    if (g < 0 || g >= SIM_PINS) return 0;
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&s_lock);
    double p = s_freq[g].acc + s_freq[g].hz * (double)(now - s_freq[g].t0) / 1e6;
    portEXIT_CRITICAL(&s_lock);
    return p;
}

int sim_transact(const char *bus, int addr, const uint8_t *w, size_t wlen, uint8_t *rbuf, size_t rlen) {
    if (!s_up || xPortInIsrContext()) return -1;
    int k = -1, id = 0;
    portENTER_CRITICAL(&s_lock);
    for (int i = 0; i < SIM_SLOTS && k < 0; i++)
        if (!s_slot[i].busy) {
            k = i;
            id = ++s_seq;
            s_slot[i] = (typeof(s_slot[i])){id, true, 0, rbuf, rlen, s_slot[i].done};
        }
    portEXIT_CRITICAL(&s_lock);
    if (k < 0) return -1;
    xSemaphoreTake(s_slot[k].done, 0);          /* a late give from an earlier timeout */
    size_t cap = wlen * 2 + 160;
    char *b = malloc(cap);
    if (!b) { s_slot[k].busy = false; return -1; }
    int n = snprintf(b, cap, "{\"type\":\"i2c\",\"t\":%lld,\"id\":%d,\"bus\":\"%s\",\"addr\":%d,\"write\":\"",
                     (long long)esp_timer_get_time(), id, bus, addr);
    for (size_t i = 0; i < wlen; i++) n += sprintf(b + n, "%02x", w[i]);
    n += snprintf(b + n, cap - n, "\",\"read\":%u}\n", (unsigned)rlen);
    put(b, n);
    free(b);
    int r = xSemaphoreTake(s_slot[k].done, pdMS_TO_TICKS(SIM_TIMEOUT_MS)) ? s_slot[k].ack : -1;
    portENTER_CRITICAL(&s_lock);
    s_slot[k].busy = false;
    portEXIT_CRITICAL(&s_lock);
    return r;
}

/* ---- the few JSON fields the runtime sends ---- */

static const char *field(const char *s, const char *key) {
    char k[24];
    snprintf(k, sizeof k, "\"%s\"", key);
    const char *p = strstr(s, k);
    if (!p) return NULL;
    p = strchr(p + strlen(k), ':');
    if (!p) return NULL;
    for (p++; *p == ' '; p++) {}
    return p;
}

static bool is(const char *s, const char *type) {
    const char *p = field(s, "type");
    return p && *p == '"' && strncmp(p + 1, type, strlen(type)) == 0 && p[1 + strlen(type)] == '"';
}

static int pin_of(const char *s) {
    const char *p = field(s, "pin");
    if (!p) return -1;
    if (*p == '"') p++;
    if (strncmp(p, "GPIO", 4) == 0) p += 4;
    int g = atoi(p);
    return g >= 0 && g < SIM_PINS ? g : -1;
}

static double num(const char *s, const char *key, double dflt) {
    const char *p = field(s, key);
    if (!p) return dflt;
    if (*p == 't') return 1;
    if (*p == 'f') return 0;
    return strtod(p, NULL);
}

static int hexval(char c) {
    return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

static void apply(const char *s) {
    int g = pin_of(s);
    if (is(s, "pin") && g >= 0) {
        s_pin[g] = num(s, "level", 0) ? 1 : 0;
    } else if (is(s, "adc") && g >= 0) {
        s_volts[g] = num(s, "volts", 0);
    } else if (is(s, "freq") && g >= 0) {
        int64_t now = esp_timer_get_time();
        double hz = num(s, "hz", 0);
        portENTER_CRITICAL(&s_lock);
        s_freq[g].acc += s_freq[g].hz * (double)(now - s_freq[g].t0) / 1e6;
        s_freq[g].t0 = now;
        s_freq[g].hz = hz;
        portEXIT_CRITICAL(&s_lock);
    } else if (is(s, "reply")) {
        int id = (int)num(s, "id", -1);
        for (int i = 0; i < SIM_SLOTS; i++) {
            if (!s_slot[i].busy || s_slot[i].id != id) continue;
            const char *d = field(s, "data");
            size_t n = 0;
            if (d && *d == '"')
                for (d++; n < s_slot[i].len && hexval(d[0]) >= 0 && hexval(d[1]) >= 0; d += 2)
                    s_slot[i].buf[n++] = (uint8_t)(hexval(d[0]) << 4 | hexval(d[1]));
            if (n < s_slot[i].len) memset(s_slot[i].buf + n, 0xff, s_slot[i].len - n);
            s_slot[i].ack = num(s, "ack", 1) ? 1 : 0;
            xSemaphoreGive(s_slot[i].done);
        }
    }
}

static void reader(void *arg) {
    static char line[SIM_LINE];
    int n = 0;
    uint8_t buf[128];
    for (;;) {
        int got = uart_read_bytes(REDLINE_SIM_UART, buf, 1, portMAX_DELAY);   /* wake on the first byte */
        size_t more = 0;
        uart_get_buffered_data_len(REDLINE_SIM_UART, &more);
        if (got == 1 && more) got += uart_read_bytes(REDLINE_SIM_UART, buf + 1, more < sizeof buf ? more : sizeof buf - 1, 0);
        for (int i = 0; i < got; i++) {
            if (buf[i] == '\n') {
                line[n < SIM_LINE ? n : SIM_LINE - 1] = 0;
                if (n < SIM_LINE) apply(line);
                n = 0;
            } else if (n < SIM_LINE) {
                line[n++] = (char)buf[i];
            }
        }
    }
}

static void sim_start(void) {
    memset(s_pin, -1, sizeof s_pin);
    for (int i = 0; i < SIM_PINS; i++) s_volts[i] = -1;
    for (int i = 0; i < SIM_SLOTS; i++) s_slot[i].done = xSemaphoreCreateBinary();
    uart_config_t c = {.baud_rate = 115200, .data_bits = UART_DATA_8_BITS, .parity = UART_PARITY_DISABLE,
                       .stop_bits = UART_STOP_BITS_1, .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
                       .source_clk = UART_SCLK_DEFAULT};
    uart_driver_install(REDLINE_SIM_UART, 4096, 0, 0, NULL, 0);
    uart_param_config(REDLINE_SIM_UART, &c);
    s_up = true;
    static const char hello[] = "{\"type\":\"hello\",\"sim\":\"redline-esp32\"}\n";
    put(hello, sizeof hello - 1);
    xTaskCreate(reader, "redline_sim", 4096, NULL, configMAX_PRIORITIES - 2, NULL);
}

extern void __real_app_main(void);
void __wrap_app_main(void) {
    sim_start();
    __real_app_main();
}
