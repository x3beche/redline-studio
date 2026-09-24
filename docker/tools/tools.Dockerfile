# The Tools tab's machine: one image for every tool, used offline.
#
#   docker build -f docker/tools/tools.Dockerfile -t redline-tools docker/tools
#
# The tools draw and write in the browser; this is where what they write is
# tried for real - SQL run in PostgreSQL, a Prisma schema validated, the
# TypeScript they generate compiled against the real libraries, an OpenAPI
# document validated, Mermaid rendered, a regex run in Python and PCRE, a
# cron schedule cross-checked. Everything is installed at build time; a
# check runs with --network none.
#
# The first two layers are the Web Programming image's own, word for word,
# so Docker shares them rather than storing them twice.
FROM ubuntu:24.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git python3 python3-venv \
      nodejs npm \
      fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
      libgl1 libglu1-mesa libxrender1 libxext6 libsm6 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# PostgreSQL to run generated SQL in; PCRE2 for the regex dialect.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      postgresql-16 pcre2-utils xz-utils \
 && rm -rf /var/lib/apt/lists/*

# The Python side - YAML, the OpenAPI validator, croniter - in a virtualenv
# of its own, since Ubuntu does not package the validator.
RUN python3 -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir pyyaml openapi-spec-validator croniter pytz

# Node 22, apart from Ubuntu's 18: Prisma 7 and mermaid-cli need a newer one.
ARG NODE=22.19.0
RUN curl -fsSL https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-x64.tar.xz \
      | tar -xJ -C /opt && mv /opt/node-v${NODE}-linux-x64 /opt/node
ENV PATH=/opt/node/bin:$PATH

# The libraries generated code is compiled against, pinned, installed once.
WORKDIR /opt/tools
ENV PUPPETEER_SKIP_DOWNLOAD=1 PRISMA_HIDE_UPDATE_MESSAGE=1 CHECKPOINT_DISABLE=1
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund \
      typescript@5 zod@3 react@19 @types/react@19 react-hook-form@7 @hookform/resolvers@3 \
      prisma@7 @mermaid-js/mermaid-cli@11 \
 && npx prisma --version >/dev/null \
 && npm cache clean --force

COPY check.py /opt/tools/check.py
COPY puppeteer.json /opt/tools/puppeteer.json
RUN useradd -m -u 1000 -o tool 2>/dev/null || true
ENTRYPOINT ["/opt/py/bin/python", "/opt/tools/check.py"]
