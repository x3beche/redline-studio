/* I2C, the legacy driver (driver/i2c.h). The *_device helpers become one
 * transaction each; a command link is shadowed while the app builds it and
 * becomes one transaction at i2c_master_cmd_begin (write, then an optional
 * repeated-start read). Linked only when the app uses the legacy driver. */
#include <stdio.h>
#include <string.h>

#include "driver/i2c.h"
#include "redline_sim.h"

static int one(int port, int addr, const uint8_t *w, size_t wn, uint8_t *r, size_t rn) {
    char bus[8];
    snprintf(bus, sizeof bus, "I2C%d", port);
    int a = sim_transact(bus, addr, w, wn, r, rn);
    return a > 0 ? ESP_OK : a == 0 ? ESP_FAIL : ESP_ERR_TIMEOUT;
}

esp_err_t __wrap_i2c_master_write_to_device(i2c_port_t p, uint8_t addr, const uint8_t *w, size_t wn, TickType_t t) {
    return one(p, addr, w, wn, NULL, 0);
}

esp_err_t __wrap_i2c_master_read_from_device(i2c_port_t p, uint8_t addr, uint8_t *r, size_t rn, TickType_t t) {
    return one(p, addr, NULL, 0, r, rn);
}

esp_err_t __wrap_i2c_master_write_read_device(i2c_port_t p, uint8_t addr, const uint8_t *w, size_t wn, uint8_t *r, size_t rn, TickType_t t) {
    return one(p, addr, w, wn, r, rn);
}

/* ---- command links ---- */
#define LINKS 4
#define WMAX 256
#define RSEG 4
static struct {
    i2c_cmd_handle_t h;
    int addr, want_addr;              /* want_addr: the next written byte is an address */
    size_t wn;
    uint8_t w[WMAX];
    struct { uint8_t *p; size_t n; } rd[RSEG];
    int nrd;
} s_link[LINKS];

static int find(i2c_cmd_handle_t h) {
    for (int i = 0; i < LINKS; i++)
        if (s_link[i].h == h) return i;
    for (int i = 0; i < LINKS; i++)
        if (!s_link[i].h) {
            memset(&s_link[i], 0, sizeof s_link[i]);
            s_link[i].h = h;
            s_link[i].addr = -1;
            return i;
        }
    return -1;
}

static void wbytes(i2c_cmd_handle_t h, const uint8_t *d, size_t n) {
    int k = find(h);
    if (k < 0) return;
    for (size_t i = 0; i < n; i++) {
        if (s_link[k].want_addr) {
            s_link[k].addr = d[i] >> 1;
            s_link[k].want_addr = 0;
        } else if (s_link[k].wn < WMAX) {
            s_link[k].w[s_link[k].wn++] = d[i];
        }
    }
}

static void rbytes(i2c_cmd_handle_t h, uint8_t *d, size_t n) {
    int k = find(h);
    if (k >= 0 && s_link[k].nrd < RSEG) s_link[k].rd[s_link[k].nrd++] = (typeof(s_link[0].rd[0])){d, n};
}

esp_err_t __real_i2c_master_start(i2c_cmd_handle_t h);
esp_err_t __wrap_i2c_master_start(i2c_cmd_handle_t h) {
    int k = find(h);
    if (k >= 0) s_link[k].want_addr = 1;
    return __real_i2c_master_start(h);
}

esp_err_t __real_i2c_master_write_byte(i2c_cmd_handle_t h, uint8_t d, bool ack);
esp_err_t __wrap_i2c_master_write_byte(i2c_cmd_handle_t h, uint8_t d, bool ack) {
    wbytes(h, &d, 1);
    return __real_i2c_master_write_byte(h, d, ack);
}

esp_err_t __real_i2c_master_write(i2c_cmd_handle_t h, const uint8_t *d, size_t n, bool ack);
esp_err_t __wrap_i2c_master_write(i2c_cmd_handle_t h, const uint8_t *d, size_t n, bool ack) {
    wbytes(h, d, n);
    return __real_i2c_master_write(h, d, n, ack);
}

esp_err_t __real_i2c_master_read_byte(i2c_cmd_handle_t h, uint8_t *d, i2c_ack_type_t ack);
esp_err_t __wrap_i2c_master_read_byte(i2c_cmd_handle_t h, uint8_t *d, i2c_ack_type_t ack) {
    rbytes(h, d, 1);
    return __real_i2c_master_read_byte(h, d, ack);
}

esp_err_t __real_i2c_master_read(i2c_cmd_handle_t h, uint8_t *d, size_t n, i2c_ack_type_t ack);
esp_err_t __wrap_i2c_master_read(i2c_cmd_handle_t h, uint8_t *d, size_t n, i2c_ack_type_t ack) {
    rbytes(h, d, n);
    return __real_i2c_master_read(h, d, n, ack);
}

esp_err_t __wrap_i2c_master_cmd_begin(i2c_port_t p, i2c_cmd_handle_t h, TickType_t t) {
    int k = find(h);
    if (k < 0 || s_link[k].addr < 0) return ESP_ERR_INVALID_ARG;
    size_t rn = 0;
    for (int i = 0; i < s_link[k].nrd; i++) rn += s_link[k].rd[i].n;
    uint8_t r[WMAX];
    if (rn > WMAX) rn = WMAX;
    esp_err_t e = one(p, s_link[k].addr, s_link[k].w, s_link[k].wn, r, rn);
    for (int i = 0, o = 0; e == ESP_OK && i < s_link[k].nrd && o < (int)rn; o += s_link[k].rd[i++].n)
        memcpy(s_link[k].rd[i].p, r + o, rn - o < s_link[k].rd[i].n ? rn - o : s_link[k].rd[i].n);
    return e;
}

void __real_i2c_cmd_link_delete(i2c_cmd_handle_t h);
void __wrap_i2c_cmd_link_delete(i2c_cmd_handle_t h) {
    int k = find(h);
    if (k >= 0) s_link[k].h = NULL;
    __real_i2c_cmd_link_delete(h);
}

void __real_i2c_cmd_link_delete_static(i2c_cmd_handle_t h);
void __wrap_i2c_cmd_link_delete_static(i2c_cmd_handle_t h) {
    int k = find(h);
    if (k >= 0) s_link[k].h = NULL;
    __real_i2c_cmd_link_delete_static(h);
}
