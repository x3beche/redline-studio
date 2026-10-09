# TraceMaker, the board router (https://github.com/DingoOz/TraceMaker,
# GPL-3.0-or-later): run as a program of its own, never linked into Redline.
#
#   docker build -f docker/tracemaker.Dockerfile -t redline-tracemaker .
#
# Built on Ubuntu 26.04 with GCC 15, what it is developed and tested on, and
# CPU only: the GPU paths have CPU twins that give the same boards. The
# runtime image keeps the source's LICENSE and NOTICE next to the binaries.
FROM ubuntu:26.04 AS build
ARG TRACEMAKER_REF=f5be62b504a7
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      g++-15 cmake ninja-build git ca-certificates python3 python3-yaml python3-dev \
      libboost-dev libboost-system-dev libeigen3-dev nlohmann-json3-dev libcli11-dev \
      libsqlite3-dev libzstd-dev catch2 pybind11-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/DingoOz/TraceMaker /src && cd /src && git checkout ${TRACEMAKER_REF}
WORKDIR /src
RUN cmake --preset cpu-only -DTM_BUILD_TESTS=OFF -DTM_BUILD_PYTHON=OFF -DTM_WERROR=OFF \
 && cmake --build --preset cpu-only --target tracemaker tracemaker-place \
 && strip build/cpu-only/src/app/tracemaker build/cpu-only/src/place/tracemaker-place

FROM ubuntu:26.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      libsqlite3-0 libzstd1 python3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/cpu-only/src/app/tracemaker /usr/local/bin/tracemaker
COPY --from=build /src/build/cpu-only/src/place/tracemaker-place /usr/local/bin/tracemaker-place
COPY --from=build /src/LICENSE /src/NOTICE /usr/share/doc/tracemaker/
# The relay: runs the router and writes what its viewer stream says into
# /work/live.jsonl, for Redline's own board view to draw while it routes.
COPY docker/tm_relay.py /opt/tm_relay.py
ENTRYPOINT ["tracemaker"]
