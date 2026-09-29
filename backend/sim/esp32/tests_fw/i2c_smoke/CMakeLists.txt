# A test firmware for the simulator: an I2C write to 0x3C with the new driver.
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(i2c_smoke)
