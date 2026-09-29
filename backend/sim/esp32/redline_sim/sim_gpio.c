/* GPIO: outputs are reported on a change; an input the runtime drove reads
 * as that level. */
#include "driver/gpio.h"
#include "esp_attr.h"
#include "freertos/FreeRTOS.h"
#include "redline_sim.h"

static int8_t s_out[SIM_PINS] = {[0 ... SIM_PINS - 1] = -1};

esp_err_t __real_gpio_set_level(gpio_num_t g, uint32_t level);
IRAM_ATTR esp_err_t __wrap_gpio_set_level(gpio_num_t g, uint32_t level) {
    esp_err_t r = __real_gpio_set_level(g, level);
    int v = level ? 1 : 0;
    if (r == ESP_OK && g < SIM_PINS && s_out[g] != v && !xPortInIsrContext()) {
        s_out[g] = v;
        sim_emit("pin", "\"pin\":\"GPIO%d\",\"level\":%d", g, v);
    }
    return r;
}

int __real_gpio_get_level(gpio_num_t g);
IRAM_ATTR int __wrap_gpio_get_level(gpio_num_t g) {
    int v = __real_gpio_get_level(g);
    int in = (g >= 0 && g < SIM_PINS) ? sim_pin_in(g) : -1;
    return in >= 0 ? in : v;
}
