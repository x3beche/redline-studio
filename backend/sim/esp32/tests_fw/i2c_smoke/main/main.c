/* Writes 00 af (an SSD1306 "display on") to 0x3C, then reads two bytes
 * back, and prints what came of each. */
#include <stdio.h>

#include "driver/i2c_master.h"
#include "esp_timer.h"

void app_main(void) {
    i2c_master_bus_config_t bc = {.i2c_port = 0, .sda_io_num = 21, .scl_io_num = 22,
                                  .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
                                  .flags.enable_internal_pullup = true};
    i2c_master_bus_handle_t bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x3C,
                              .scl_speed_hz = 400000};
    i2c_master_dev_handle_t dev;
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &dev));
    printf("i2c smoke start\n");
    uint8_t w[] = {0x00, 0xAF}, r[2] = {0};
    int64_t t0 = esp_timer_get_time();
    esp_err_t e = i2c_master_transmit(dev, w, sizeof w, 100);
    printf("write %s after %lld us\n", esp_err_to_name(e), (long long)(esp_timer_get_time() - t0));
    e = i2c_master_transmit_receive(dev, w, 1, r, sizeof r, 100);
    printf("read %s %02x %02x\n", esp_err_to_name(e), r[0], r[1]);
}
