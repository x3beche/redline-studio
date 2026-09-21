"""fan_pro modelinden, uzerine cizilebilir olcekli gorunumler uretir.

    .venv/bin/python views.py

Modeli bastan kurar, STEP/STL'i tazeler ve views/ altina 6 ortografik
gorunum yazar. Her goruntude 10 mm izgara var ve olcek iki eksende de
ayni (10.24 piksel = 1 mm), boylece uzerine cizilen isaret mm'ye cevrilebilir.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "models"))

from build123d import Compound, ExportSVG   # noqa: E402
import fan_pro as F                          # noqa: E402

OUT = ROOT / "views"
TMP = Path("/tmp")
DPI = 260
PAD = 90                       # beyaz kenar boslugu, piksel
PPM = DPI / 25.4               # piksel / mm

# ad: (kamera, yukari, yatay etiket, dikey etiket, genislik_mm, yukseklik_mm)
VIEWS = {
    "01_ust": ((0, 0, 400), (0, 1, 0), "X +sag", "Y +yukari", 120, 120),
    "02_alt": ((0, 0, -400), (0, 1, 0), "X +sol", "Y +yukari", 120, 120),
    "03_yuz_artiX_HEADER": ((400, 0, 0), (0, 0, 1), "Y +sag", "Z +yukari", 120, 25),
    "04_yuz_artiY": ((0, 400, 0), (0, 0, 1), "X +sol", "Z +yukari", 120, 25),
    "05_yuz_eksiX": ((-400, 0, 0), (0, 0, 1), "Y +sol", "Z +yukari", 120, 25),
    "06_yuz_eksiY": ((0, -400, 0), (0, 0, 1), "X +sag", "Z +yukari", 120, 25),
}


def main():
    OUT.mkdir(exist_ok=True)
    shape = Compound(children=[F.frame, F.rotor, F.pins, F.stator, F.coils,
                               F.pcb, F.magnet, F.shaft])
    for name, (eye, up, hlab, vlab, w_mm, h_mm) in VIEWS.items():
        # look_at mutlaka kamera ekseni uzerinde olmali; (0,0,12) verilince
        # gorus ekseni 1.72 derece yatiyor ve yan gorunuse sahte yukseklik
        # bindiriyordu (en/boy 4.17 cikiyordu, 4.80 olmasi gerekirken).
        visible, _ = shape.project_to_viewport(viewport_origin=eye,
                                               viewport_up=up, look_at=(0, 0, 0))
        svg = TMP / f"{name}.svg"
        exporter = ExportSVG(scale=1, margin=0)
        exporter.add_layer("v", line_weight=0.25, line_color=(0, 0, 0))
        exporter.add_shape(visible, layer="v")
        exporter.write(str(svg))

        box = [float(v) for v in
               re.search(r'viewBox="([^"]+)"', svg.read_text()).group(1).split()]
        wpx, hpx = round(box[2] * PPM), round(box[3] * PPM)

        raw = TMP / f"{name}_raw.png"
        subprocess.run(["convert", "-background", "white", "-density", str(DPI),
                        str(svg), "-flatten", "-resize", f"{wpx}x{hpx}!",
                        str(raw)], check=True)

        grid = []
        for mm in range(-int(w_mm // 2), int(w_mm // 2) + 1, 10):
            x = PAD + (mm + w_mm / 2) * PPM
            grid.append(f"line {x:.1f},{PAD} {x:.1f},{PAD + hpx}")
        lows = 0 if h_mm <= 30 else -int(h_mm // 2)
        for mm in range(lows, lows + int(h_mm) + 1, 10):
            y = PAD + hpx - (mm - lows) * PPM
            grid.append(f"line {PAD},{y:.1f} {PAD + wpx},{y:.1f}")

        subprocess.run([
            "convert", str(raw), "-bordercolor", "white", "-border", f"{PAD}x{PAD}",
            "-fill", "none", "-stroke", "#b9d4f0", "-strokewidth", "1",
            "-draw", " ".join(grid),
            "-stroke", "none", "-fill", "#21618c", "-pointsize", "34",
            "-gravity", "NorthWest", "-annotate", "+14+14",
            f"{name}   yatay: {hlab}   dikey: {vlab}   izgara: 10 mm",
            str(OUT / f"{name}.png")], check=True)
        print(f"{name:24s} {wpx}x{hpx} px   {PPM:.2f} px/mm")
    print(f"\n{len(VIEWS)} gorunum -> {OUT}")


if __name__ == "__main__":
    main()
