# Redline virtual board bridge. Added to an app's build only by the simulator:
#   idf.py -DEXTRA_COMPONENT_DIRS=<this dir> build
# The app's source is untouched; its driver calls are wrapped at link time.
idf_component_register(SRCS "sim_core.c" "sim_gpio.c" "sim_ledc.c" "sim_pcnt.c"
                            "sim_adc.c" "sim_i2c.c" "sim_i2c_legacy.c"
                       INCLUDE_DIRS "."
                       REQUIRES driver esp_driver_uart esp_driver_gpio esp_driver_ledc
                                esp_driver_pcnt esp_driver_i2c esp_adc esp_timer)

set(wrapped app_main
    gpio_set_level gpio_get_level
    ledc_timer_config ledc_channel_config ledc_set_freq ledc_set_duty ledc_update_duty
    ledc_set_duty_and_update ledc_set_fade_with_time ledc_fade_start ledc_stop
    pcnt_new_channel pcnt_del_channel pcnt_channel_set_edge_action
    pcnt_unit_clear_count pcnt_unit_get_count
    adc_oneshot_new_unit adc_oneshot_config_channel adc_oneshot_read
    i2c_new_master_bus i2c_master_bus_add_device i2c_master_bus_rm_device
    i2c_master_transmit i2c_master_receive i2c_master_transmit_receive i2c_master_probe
    i2c_master_write_to_device i2c_master_read_from_device i2c_master_write_read_device
    i2c_master_start i2c_master_write_byte i2c_master_write i2c_master_read_byte
    i2c_master_read i2c_master_cmd_begin i2c_cmd_link_delete i2c_cmd_link_delete_static)
foreach(fn ${wrapped})
    target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=${fn}")
endforeach()
