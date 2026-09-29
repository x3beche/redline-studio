/* PCNT: the count is the edges of the `freq` the runtime set on the
 * channel's edge GPIO, over virtual time. */
#include <math.h>

#include "driver/pulse_cnt.h"
#include "redline_sim.h"

#define CHANS 8
static struct { pcnt_channel_handle_t h; pcnt_unit_handle_t unit; int gpio, per_cycle; } s_ch[CHANS];
static struct { pcnt_unit_handle_t h; double zero; } s_unit[CHANS];

static double edges(pcnt_unit_handle_t u) {
    double n = 0;
    for (int i = 0; i < CHANS; i++)
        if (s_ch[i].h && s_ch[i].unit == u) n += sim_pulses(s_ch[i].gpio) * s_ch[i].per_cycle;
    return n;
}

static int unit_slot(pcnt_unit_handle_t u) {
    int free = -1;
    for (int i = 0; i < CHANS; i++) {
        if (s_unit[i].h == u) return i;
        if (!s_unit[i].h && free < 0) free = i;
    }
    if (free >= 0) s_unit[free] = (typeof(s_unit[0])){u, edges(u)};
    return free;
}

esp_err_t __real_pcnt_new_channel(pcnt_unit_handle_t u, const pcnt_chan_config_t *c, pcnt_channel_handle_t *ret);
esp_err_t __wrap_pcnt_new_channel(pcnt_unit_handle_t u, const pcnt_chan_config_t *c, pcnt_channel_handle_t *ret) {
    esp_err_t r = __real_pcnt_new_channel(u, c, ret);
    for (int i = 0; r == ESP_OK && c->edge_gpio_num >= 0 && i < CHANS; i++)
        if (!s_ch[i].h) {
            s_ch[i] = (typeof(s_ch[0])){*ret, u, c->edge_gpio_num, 0};
            unit_slot(u);
            break;
        }
    return r;
}

static int act(pcnt_channel_edge_action_t a) {
    return a == PCNT_CHANNEL_EDGE_ACTION_INCREASE ? 1 : a == PCNT_CHANNEL_EDGE_ACTION_DECREASE ? -1 : 0;
}

esp_err_t __real_pcnt_channel_set_edge_action(pcnt_channel_handle_t h, pcnt_channel_edge_action_t pos, pcnt_channel_edge_action_t neg);
esp_err_t __wrap_pcnt_channel_set_edge_action(pcnt_channel_handle_t h, pcnt_channel_edge_action_t pos, pcnt_channel_edge_action_t neg) {
    esp_err_t r = __real_pcnt_channel_set_edge_action(h, pos, neg);
    for (int i = 0; r == ESP_OK && i < CHANS; i++)
        if (s_ch[i].h == h) {
            int u = unit_slot(s_ch[i].unit);          /* the count so far stays */
            double before = edges(s_ch[i].unit);
            s_ch[i].per_cycle = act(pos) + act(neg);
            if (u >= 0) s_unit[u].zero += edges(s_ch[i].unit) - before;
        }
    return r;
}

esp_err_t __real_pcnt_del_channel(pcnt_channel_handle_t h);
esp_err_t __wrap_pcnt_del_channel(pcnt_channel_handle_t h) {
    for (int i = 0; i < CHANS; i++)
        if (s_ch[i].h == h) s_ch[i].h = NULL;
    return __real_pcnt_del_channel(h);
}

esp_err_t __real_pcnt_unit_clear_count(pcnt_unit_handle_t u);
esp_err_t __wrap_pcnt_unit_clear_count(pcnt_unit_handle_t u) {
    int k = unit_slot(u);
    if (k >= 0) s_unit[k].zero = edges(u);
    return __real_pcnt_unit_clear_count(u);
}

esp_err_t __real_pcnt_unit_get_count(pcnt_unit_handle_t u, int *value);
esp_err_t __wrap_pcnt_unit_get_count(pcnt_unit_handle_t u, int *value) {
    esp_err_t r = __real_pcnt_unit_get_count(u, value);
    int k = unit_slot(u);
    if (r == ESP_OK && k >= 0) *value += (int)floor(edges(u)) - (int)floor(s_unit[k].zero);   /* whole edges, as a counter sees them */
    return r;
}
