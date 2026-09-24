# The Mobile Programming room's machine: an Android phone, emulated, with
# adb to photograph it and to list what is on its screen.
#
#   docker build -f docker/code/mobile.Dockerfile -t redline-code-mobile docker/code
#
# Run with /dev/kvm passed through - an x86_64 phone on KVM boots in about
# a minute; without it, not in any useful time - and left running while
# the room is open. Headless: the screen reaches the page as screenshots.
FROM ubuntu:24.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl unzip openjdk-17-jre-headless python3 \
      libpulse0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 \
      libasound2t64 libgl1 libx11-6 libxkbfile1 libxdamage1 libxrandr2 \
      libdbus-1-3 libbsd0 libgbm1 libdrm2 libegl1 \
 && rm -rf /var/lib/apt/lists/*

ENV ANDROID_SDK_ROOT=/opt/android
ENV PATH=$PATH:/opt/android/cmdline-tools/latest/bin:/opt/android/platform-tools:/opt/android/emulator

ARG TOOLS=11076708
RUN mkdir -p /opt/android/cmdline-tools \
 && curl -fsSL -o /tmp/tools.zip \
      https://dl.google.com/android/repository/commandlinetools-linux-${TOOLS}_latest.zip \
 && unzip -q /tmp/tools.zip -d /opt/android/cmdline-tools \
 && mv /opt/android/cmdline-tools/cmdline-tools /opt/android/cmdline-tools/latest \
 && rm /tmp/tools.zip

# Android 14 with the Play Store image: it carries Chrome, which is what a
# mobile web page is judged in, and its DevTools socket is what lists the
# elements on it.
ARG API=34
RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install "platform-tools" "emulator" \
      "system-images;android-${API};google_apis_playstore;x86_64" > /dev/null \
 && echo no | avdmanager create avd -n phone -d pixel_7 \
      -k "system-images;android-${API};google_apis_playstore;x86_64"

# Headless, and quick to come back: the snapshot on exit is what makes the
# second boot seconds instead of a minute.
CMD ["emulator", "-avd", "phone", "-no-window", "-no-audio", "-no-boot-anim", \
     "-gpu", "swiftshader_indirect", "-accel", "on"]
