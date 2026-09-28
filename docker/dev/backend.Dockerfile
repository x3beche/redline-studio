# Development image for the API: the OS layer only.
#
# The source is not copied in - compose mounts the checkout at the same path
# it has on the host, and uvicorn --reload picks up every edit. Python
# packages live in the `venv` volume and are installed by backend.sh on start,
# so a new line in requirements.txt does not need a rebuild either.
FROM python:3.12-slim-bookworm

# OpenCascade (build123d) wants GL and X libraries even headless; git for the
# code rooms; the docker CLI so the API can start KiCad and the room images
# next to itself through the host's socket.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libxrender1 libxext6 libsm6 libx11-6 libfontconfig1 \
        build-essential git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# Same uid as the WSL user, so files the API writes into the checkout
# (.cache, __pycache__) stay editable from the host.
ARG UID=1000
ARG GID=1000
RUN groupadd -g $GID dev && useradd -m -u $UID -g $GID dev \
    && mkdir /venv && chown dev:dev /venv
USER dev
