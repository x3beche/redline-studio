# kicad-cli, and nothing else we have to put on the machine.
#
# The board room needs three things KiCad can do and atopile cannot: draw
# a placed board as layers, export it as a 3D model, and run DRC over it.
# All three are `kicad-cli`, which ships inside the KiCad package - so the
# package goes in a container and the machine stays clean.
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

# Nothing is written outside the mount, and nothing runs as root that does
# not have to.
RUN useradd -m -u 1000 board || true
USER board
WORKDIR /work

ENTRYPOINT ["kicad-cli"]
CMD ["--version"]
