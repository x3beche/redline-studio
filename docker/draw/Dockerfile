# Technical drawings (tools/techdraw.py): build123d projects the model's
# edges, fpdf2 lays out the sheet. Its own image, so nothing for drawings
# is installed on the machine.
#
#   docker build -t redline-draw -f docker/draw/Dockerfile docker/draw
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxrender1 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "build123d>=0.12" "fpdf2>=2.8"
RUN useradd -m draw
USER draw
WORKDIR /work
ENTRYPOINT ["python3", "/tools/techdraw.py"]
