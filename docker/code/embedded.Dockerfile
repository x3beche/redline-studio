# The Embedded Programming room's machine: STM32 and ESP32 both, built and
# flashed from here, and nothing installed on the host.
#
#   docker build -f docker/code/embedded.Dockerfile -t redline-code-embedded docker/code
#
# Espressif's own image is the base: ESP-IDF with its Xtensa and RISC-V
# compilers and esptool, set up by its entrypoint for every command. On
# top: the Arm compiler and newlib for STM32, CMake and Ninja, a compiler
# for the build machine itself (firmware logic is tested there), and the
# two ways an STM32 is programmed - OpenOCD and stlink.
#
# Called with the project's checkout mounted at its own path; the build
# goes to a directory of Redline's, never into the project's tree. A
# board is reached by passing its /dev/tty* or USB bus through.
FROM espressif/idf:v5.3.1

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib \
      binutils-arm-none-eabi cmake ninja-build make git build-essential \
      openocd stlink-tools usbutils \
 && rm -rf /var/lib/apt/lists/*

# Run as the person's own uid: the IDF tools must be readable by anyone,
# and a HOME that is writable is given at run time.
RUN chmod -R a+rX /opt/esp
