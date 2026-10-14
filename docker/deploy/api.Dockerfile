# The API for a deployment (docker-compose.yml): the code copied in, the
# packages installed, served by uvicorn without --reload.
#
#   docker build -f docker/deploy/api.Dockerfile -t workbench-api .
#
# The code is not run from where it is copied to. The API starts its work
# containers (KiCad, the drawings, PlatformIO, ...) next to itself through
# the host's Docker socket and hands them paths under the checkout and the
# temporary directory - paths the host has to have too. On start
# docker/deploy/api-entrypoint.sh copies the code from /opt/workbench into
# REDLINE_HOST_DIR, a host directory mounted at the same path inside, and
# runs it from there (docker-compose.yml, DEPLOY.md).
FROM python:3.12-slim-bookworm

# OpenCascade (build123d) wants GL and X libraries even headless; git and
# curl (the health check); the docker CLI for the work containers.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libxrender1 libxext6 libsm6 libx11-6 libfontconfig1 \
        git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
RUN python -m venv /opt/venv
COPY requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install -r /tmp/requirements.txt

# The board room's atopile and easyeda2kicad, in an environment of their own
# as INSTALL.md > The board room has it. WITH_ATO=false leaves them out: the
# board room then says it is not installed.
ARG WITH_ATO=true
RUN if [ "$WITH_ATO" = "true" ]; then \
        python -m venv /opt/ato && /opt/ato/bin/pip install atopile easyeda2kicad kiutils; \
    fi
ENV REDLINE_ATO=/opt/ato/bin/ato \
    REDLINE_EASYEDA=/opt/ato/bin/easyeda2kicad \
    REDLINE_ATO_PYTHON=/opt/ato/bin/python

# The same uid as the work images' users (board in redline-kicad, draw in
# redline-draw): they write into directories the API makes for them.
ARG UID=1000
ARG GID=1000
RUN groupadd -g $GID app && useradd -m -u $UID -g $GID app

COPY . /opt/workbench
RUN chmod -R a+rX /opt/workbench
COPY docker/deploy/api-entrypoint.sh /usr/local/bin/workbench-api
RUN chmod 755 /usr/local/bin/workbench-api

ENV PATH=/opt/venv/bin:$PATH
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS -o /dev/null http://127.0.0.1:8000/api/health || exit 1
ENTRYPOINT ["workbench-api"]
