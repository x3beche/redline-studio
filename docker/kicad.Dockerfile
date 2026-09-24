# kicad-cli, and nothing else we have to put on the machine.
#
# The board room needs what KiCad can do and atopile cannot: place a board,
# draw its schematic, route it, run DRC over it, and draw and export the
# result. KiCad, its libraries and the autorouter all go in a container,
# and the machine stays clean.
#
#   docker build -f docker/kicad.Dockerfile -t redline-kicad .
#
# It is called with a directory mounted at /work and the file to act on
# given relative to that; nothing else crosses the boundary.
FROM debian:trixie-slim

# kicad-cli lives in the kicad package; the footprint and 3D-model
# libraries are separate and are what a board render is made of.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      kicad kicad-footprints kicad-packages3d \
 && rm -rf /var/lib/apt/lists/*

# The rest of the pipeline, in its own layer so the one above stays cached:
#
# - kicad-symbols: the standard schematic symbols. A resistor, a capacitor,
#   an LED is drawn from these; everything else from its LCSC symbol.
# - a Java runtime and Freerouting: the autorouter. KiCad writes the board
#   out as Specctra DSN with the net classes on it, Freerouting routes it,
#   and the session comes back into KiCad. Freerouting 2.4 is built for
#   Java 25 (class file 69) and will not start on 21.
ARG FREEROUTING=2.4.1
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      kicad-symbols openjdk-25-jre-headless ca-certificates curl \
 && curl -fsSL -o /opt/freerouting.jar \
      "https://github.com/freerouting/freerouting/releases/download/v${FREEROUTING}/freerouting-${FREEROUTING}.jar" \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Nothing is written outside the mount, and nothing runs as root that does
# not have to.
RUN useradd -m -u 1000 board || true
USER board
WORKDIR /work

ENTRYPOINT ["kicad-cli"]
CMD ["--version"]
