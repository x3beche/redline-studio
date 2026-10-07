# The firmware builder: PlatformIO with the ESP32 Arduino platform and the
# usual libraries already in the image, so a build needs no network.
#
#   docker build -t redline-firmware docker/firmware
#
# backend/firmware_build.py runs it once per build:
#   docker run --rm --network none --user <uid> <limits> \
#       -v <project>:/project -w /project redline-firmware pio run -e esp32dev
# The project directory (.cache/firmware/<space>/<id>/ in the checkout)
# keeps its .pio between builds, so a build after a small change only
# compiles what changed.
#
# What the image holds, under /opt/platformio (PLATFORMIO_CORE_DIR):
#   - the platform (pinned: a firmware's platformio.ini names the same one),
#     its toolchain, the Arduino core, esptool and SCons - installed by
#     building the seed project below once;
#   - /opt/libpool: the libraries a firmware is likely to ask for, as
#     PlatformIO installed them for the seed. A firmware's first build
#     copies the ones it lacks from here into its own .pio/libdeps, so
#     `lib_deps` on these resolves offline.
FROM python:3.12-slim-bookworm

ARG PIO_VERSION=6.1.19
ENV PLATFORMIO_CORE_DIR=/opt/platformio \
    PLATFORMIO_SETTING_ENABLE_TELEMETRY=No \
    PLATFORMIO_SETTING_CHECK_PLATFORMIO_INTERVAL=36500 \
    PLATFORMIO_SETTING_CHECK_PRUNE_SYSTEM_THRESHOLD=0 \
    PLATFORMIO_DISABLE_PROGRESSBAR=true \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install "platformio==${PIO_VERSION}"

COPY seed /opt/seed
RUN cd /opt/seed && pio run -e esp32dev \
    && mkdir -p /opt/libpool \
    && cp -r /opt/seed/.pio/libdeps/esp32dev/. /opt/libpool/ \
    && rm -f /opt/libpool/integrity.dat \
    && rm -rf /opt/seed/.pio /opt/platformio/.cache \
    && chmod -R a+rwX /opt/platformio /opt/libpool /opt/seed

# Whoever the build runs as (the API's uid) needs a home PlatformIO may
# write its small state files into.
ENV HOME=/tmp
WORKDIR /project
