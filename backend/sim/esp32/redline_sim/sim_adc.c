/* ADC oneshot: a read returns the volts the runtime set on the channel's
 * GPIO, scaled by the channel's attenuation (0 V when nothing is set). */
#include "esp_adc/adc_oneshot.h"
#include "redline_sim.h"

static struct { adc_oneshot_unit_handle_t h; adc_unit_t unit; } s_units[2];
static struct { adc_atten_t atten; int bits; } s_cfg[2][10];

static int unit_of(adc_oneshot_unit_handle_t h) {
    for (int i = 0; i < 2; i++)
        if (s_units[i].h == h) return s_units[i].unit;
    return -1;
}

esp_err_t __real_adc_oneshot_new_unit(const adc_oneshot_unit_init_cfg_t *c, adc_oneshot_unit_handle_t *ret);
esp_err_t __wrap_adc_oneshot_new_unit(const adc_oneshot_unit_init_cfg_t *c, adc_oneshot_unit_handle_t *ret) {
    esp_err_t r = __real_adc_oneshot_new_unit(c, ret);
    if (r == ESP_OK && c->unit_id < 2) s_units[c->unit_id] = (typeof(s_units[0])){*ret, c->unit_id};
    return r;
}

esp_err_t __real_adc_oneshot_config_channel(adc_oneshot_unit_handle_t h, adc_channel_t ch, const adc_oneshot_chan_cfg_t *c);
esp_err_t __wrap_adc_oneshot_config_channel(adc_oneshot_unit_handle_t h, adc_channel_t ch, const adc_oneshot_chan_cfg_t *c) {
    esp_err_t r = __real_adc_oneshot_config_channel(h, ch, c);
    int u = unit_of(h);
    if (r == ESP_OK && u >= 0 && ch < 10) s_cfg[u][ch] = (typeof(s_cfg[0][0])){c->atten, c->bitwidth};
    return r;
}

/* Not the real read: QEMU has no analog front end. */
esp_err_t __wrap_adc_oneshot_read(adc_oneshot_unit_handle_t h, adc_channel_t ch, int *out) {
    static const double full_scale[] = {0.95, 1.25, 1.75, 3.1};   /* ESP32, per attenuation */
    int u = unit_of(h), io = -1;
    if (u < 0 || ch >= 10 || !out || adc_oneshot_channel_to_io(u, ch, &io) != ESP_OK) return ESP_ERR_INVALID_ARG;
    int bits = s_cfg[u][ch].bits ? s_cfg[u][ch].bits : 12;
    int max = (1 << bits) - 1, a = s_cfg[u][ch].atten;
    double v = sim_adc_in(io), fs = full_scale[a < 4 ? a : 3];
    int raw = v <= 0 ? 0 : (int)(v / fs * max + 0.5);
    *out = raw > max ? max : raw;
    return ESP_OK;
}
