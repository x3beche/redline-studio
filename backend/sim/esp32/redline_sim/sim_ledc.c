/* LEDC: QEMU does not model it, so the duty and frequency the app asked for
 * are kept here and sent as `pwm` on the channel's GPIO when they change. */
#include "driver/ledc.h"
#include "redline_sim.h"

#define MODES LEDC_SPEED_MODE_MAX
static struct { int gpio, timer; uint32_t duty, target; double sent_duty, sent_hz; } ch[MODES][LEDC_CHANNEL_MAX];
static struct { uint32_t hz, bits; } tm[MODES][LEDC_TIMER_MAX];

static bool ok_ch(int m, int c) { return m >= 0 && m < MODES && c >= 0 && c < LEDC_CHANNEL_MAX && ch[m][c].gpio > 0; }

static void report(int m, int c) {
    if (!ok_ch(m, c)) return;
    int t = ch[m][c].timer;
    double hz = tm[m][t].hz, duty = tm[m][t].bits ? (double)ch[m][c].duty / (double)(1u << tm[m][t].bits) : 0;
    if (duty > 1) duty = 1;
    if (duty == ch[m][c].sent_duty && hz == ch[m][c].sent_hz) return;
    ch[m][c].sent_duty = duty;
    ch[m][c].sent_hz = hz;
    sim_emit("pwm", "\"pin\":\"GPIO%d\",\"duty\":%.4f,\"hz\":%.0f", ch[m][c].gpio - 1, duty, hz);
}

esp_err_t __real_ledc_timer_config(const ledc_timer_config_t *c);
esp_err_t __wrap_ledc_timer_config(const ledc_timer_config_t *c) {
    esp_err_t r = __real_ledc_timer_config(c);
    if (r == ESP_OK && !c->deconfigure) {
        tm[c->speed_mode][c->timer_num].hz = c->freq_hz;
        tm[c->speed_mode][c->timer_num].bits = c->duty_resolution;
        for (int i = 0; i < LEDC_CHANNEL_MAX; i++)
            if (ch[c->speed_mode][i].timer == (int)c->timer_num) report(c->speed_mode, i);
    }
    return r;
}

esp_err_t __real_ledc_channel_config(const ledc_channel_config_t *c);
esp_err_t __wrap_ledc_channel_config(const ledc_channel_config_t *c) {
    esp_err_t r = __real_ledc_channel_config(c);
    if (r == ESP_OK) {
        ch[c->speed_mode][c->channel] = (typeof(ch[0][0])){c->gpio_num + 1, c->timer_sel, c->duty, c->duty, -1, -1};
        report(c->speed_mode, c->channel);
    }
    return r;
}

esp_err_t __real_ledc_set_freq(ledc_mode_t m, ledc_timer_t t, uint32_t hz);
esp_err_t __wrap_ledc_set_freq(ledc_mode_t m, ledc_timer_t t, uint32_t hz) {
    esp_err_t r = __real_ledc_set_freq(m, t, hz);
    if (r == ESP_OK) {
        tm[m][t].hz = hz;
        for (int i = 0; i < LEDC_CHANNEL_MAX; i++)
            if (ch[m][i].timer == (int)t) report(m, i);
    }
    return r;
}

esp_err_t __real_ledc_set_duty(ledc_mode_t m, ledc_channel_t c, uint32_t duty);
esp_err_t __wrap_ledc_set_duty(ledc_mode_t m, ledc_channel_t c, uint32_t duty) {
    esp_err_t r = __real_ledc_set_duty(m, c, duty);
    if (r == ESP_OK && ok_ch(m, c)) ch[m][c].target = duty;
    return r;
}

esp_err_t __real_ledc_update_duty(ledc_mode_t m, ledc_channel_t c);
esp_err_t __wrap_ledc_update_duty(ledc_mode_t m, ledc_channel_t c) {
    esp_err_t r = __real_ledc_update_duty(m, c);
    if (r == ESP_OK && ok_ch(m, c)) {
        ch[m][c].duty = ch[m][c].target;
        report(m, c);
    }
    return r;
}

esp_err_t __real_ledc_set_duty_and_update(ledc_mode_t m, ledc_channel_t c, uint32_t duty, uint32_t hpoint);
esp_err_t __wrap_ledc_set_duty_and_update(ledc_mode_t m, ledc_channel_t c, uint32_t duty, uint32_t hpoint) {
    esp_err_t r = __real_ledc_set_duty_and_update(m, c, duty, hpoint);
    if (r == ESP_OK && ok_ch(m, c)) {
        ch[m][c].duty = ch[m][c].target = duty;
        report(m, c);
    }
    return r;
}

/* A fade lands on its target at once. */
esp_err_t __real_ledc_set_fade_with_time(ledc_mode_t m, ledc_channel_t c, uint32_t target, int ms);
esp_err_t __wrap_ledc_set_fade_with_time(ledc_mode_t m, ledc_channel_t c, uint32_t target, int ms) {
    esp_err_t r = __real_ledc_set_fade_with_time(m, c, target, ms);
    if (r == ESP_OK && ok_ch(m, c)) ch[m][c].target = target;
    return r;
}

esp_err_t __real_ledc_fade_start(ledc_mode_t m, ledc_channel_t c, ledc_fade_mode_t f);
esp_err_t __wrap_ledc_fade_start(ledc_mode_t m, ledc_channel_t c, ledc_fade_mode_t f) {
    if (ok_ch(m, c)) {
        ch[m][c].duty = ch[m][c].target;
        report(m, c);
    }
    return __real_ledc_fade_start(m, c, f);
}

esp_err_t __real_ledc_stop(ledc_mode_t m, ledc_channel_t c, uint32_t idle);
esp_err_t __wrap_ledc_stop(ledc_mode_t m, ledc_channel_t c, uint32_t idle) {
    esp_err_t r = __real_ledc_stop(m, c, idle);
    if (r == ESP_OK && ok_ch(m, c)) {
        ch[m][c].duty = idle && tm[m][ch[m][c].timer].bits ? 1u << tm[m][ch[m][c].timer].bits : 0;
        report(m, c);
    }
    return r;
}
