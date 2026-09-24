# The Web Programming room's machine: a browser to photograph pages with,
# and what a web project's own checks usually need.
#
#   docker build -f docker/code/web.Dockerfile -t redline-code-web docker/code
#
# Called with the project's checkout mounted at the same path it has on the
# host, and with the host's network, so the dev server it photographs is
# the one the person is looking at. Ubuntu 24.04 like the host, so a
# project's own virtualenv - built against the host's python3.12 - still
# runs in here.
FROM ubuntu:24.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git python3 python3-venv \
      nodejs npm \
      fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
      libgl1 libglu1-mesa libxrender1 libxext6 libsm6 \
 && rm -rf /var/lib/apt/lists/*

# Chrome from Google's own repository: the page is judged as a real
# browser draws it, and its DevTools protocol is what lists the elements.
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# The photographer's one dependency, kept out of the system python.
RUN python3 -m venv /opt/shoot && /opt/shoot/bin/pip install --no-cache-dir 'websockets>=12'
