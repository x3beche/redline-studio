# The Embedded Programming room's machine: a cross compiler and the build
# tools a firmware project asks for, and nothing on the host.
#
#   docker build -f docker/code/embedded.Dockerfile -t redline-code-embedded docker/code
#
# Called with the project's checkout mounted at its own path; the build goes
# to a directory of Redline's, never into the project's tree.
FROM ubuntu:24.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib \
      binutils-arm-none-eabi cmake ninja-build make git python3 \
 && rm -rf /var/lib/apt/lists/*
