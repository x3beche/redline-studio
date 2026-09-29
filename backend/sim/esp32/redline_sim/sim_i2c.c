/* I2C, the new driver (driver/i2c_master.h): every transfer is an `i2c`
 * transaction on the bridge and blocks until the runtime's reply. The bus
 * and device handles are the real driver's; only the transfers are not. */
#include <stdio.h>

#include "driver/i2c_master.h"
#include "redline_sim.h"

#define DEVS 16
static struct { i2c_master_bus_handle_t h; int port; } s_bus[2];
static struct { i2c_master_dev_handle_t h; int port, addr; } s_dev[DEVS];
static int s_next_port;

static int port_of(i2c_master_bus_handle_t h) {
    for (int i = 0; i < 2; i++)
        if (s_bus[i].h == h) return s_bus[i].port;
    return 0;
}

esp_err_t __real_i2c_new_master_bus(const i2c_master_bus_config_t *c, i2c_master_bus_handle_t *ret);
esp_err_t __wrap_i2c_new_master_bus(const i2c_master_bus_config_t *c, i2c_master_bus_handle_t *ret) {
    esp_err_t r = __real_i2c_new_master_bus(c, ret);
    if (r == ESP_OK) {
        int port = c->i2c_port >= 0 ? c->i2c_port : s_next_port;   /* auto: the first free one */
        s_bus[port & 1] = (typeof(s_bus[0])){*ret, port};
        s_next_port = port + 1;
    }
    return r;
}

esp_err_t __real_i2c_master_bus_add_device(i2c_master_bus_handle_t b, const i2c_device_config_t *c, i2c_master_dev_handle_t *ret);
esp_err_t __wrap_i2c_master_bus_add_device(i2c_master_bus_handle_t b, const i2c_device_config_t *c, i2c_master_dev_handle_t *ret) {
    esp_err_t r = __real_i2c_master_bus_add_device(b, c, ret);
    for (int i = 0; r == ESP_OK && i < DEVS; i++)
        if (!s_dev[i].h) {
            s_dev[i] = (typeof(s_dev[0])){*ret, port_of(b), c->device_address};
            break;
        }
    return r;
}

esp_err_t __real_i2c_master_bus_rm_device(i2c_master_dev_handle_t h);
esp_err_t __wrap_i2c_master_bus_rm_device(i2c_master_dev_handle_t h) {
    for (int i = 0; i < DEVS; i++)
        if (s_dev[i].h == h) s_dev[i].h = NULL;
    return __real_i2c_master_bus_rm_device(h);
}

static esp_err_t xfer(i2c_master_dev_handle_t h, const uint8_t *w, size_t wn, uint8_t *r, size_t rn) {
    for (int i = 0; i < DEVS; i++)
        if (h && s_dev[i].h == h) {
            char bus[8];
            snprintf(bus, sizeof bus, "I2C%d", s_dev[i].port);
            int a = sim_transact(bus, s_dev[i].addr, w, wn, r, rn);
            return a > 0 ? ESP_OK : a == 0 ? ESP_ERR_INVALID_STATE : ESP_ERR_TIMEOUT;   /* nack as the driver says it */
        }
    return ESP_ERR_INVALID_ARG;
}

esp_err_t __wrap_i2c_master_transmit(i2c_master_dev_handle_t h, const uint8_t *w, size_t wn, int ms) {
    return xfer(h, w, wn, NULL, 0);
}

esp_err_t __wrap_i2c_master_receive(i2c_master_dev_handle_t h, uint8_t *r, size_t rn, int ms) {
    return xfer(h, NULL, 0, r, rn);
}

esp_err_t __wrap_i2c_master_transmit_receive(i2c_master_dev_handle_t h, const uint8_t *w, size_t wn, uint8_t *r, size_t rn, int ms) {
    return xfer(h, w, wn, r, rn);
}

esp_err_t __wrap_i2c_master_probe(i2c_master_bus_handle_t b, uint16_t addr, int ms) {
    char bus[8];
    snprintf(bus, sizeof bus, "I2C%d", port_of(b));
    return sim_transact(bus, addr, NULL, 0, NULL, 0) > 0 ? ESP_OK : ESP_ERR_NOT_FOUND;
}
