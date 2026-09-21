"""Guncel fan_pro modelini OCP CAD Viewer formatinda assets/model.json'a yazar.

VS Code eklentisinin kullandigi ayni tessellation zinciri (ocp_viewer_core)
kullaniliyor; tarayicidaki three-cad-viewer bu zarfi oldugu gibi okuyor.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "models"))
from ocp_viewer_core.offline import _convert            # noqa: E402
import fan_pro as F                                     # noqa: E402

NAMES = ["govde", "pervane", "pinler", "stator", "sargilar",
         "surucu_karti", "miknatis", "mil"]
OUT = ROOT / "assets" / "model.json"


def main() -> None:
    parts = [F.frame, F.rotor, F.pins, F.stator, F.coils, F.pcb, F.magnet, F.shaft]
    envelope, _mapping = _convert(*parts, names=NAMES)
    OUT.write_text(json.dumps(envelope))
    mb = OUT.stat().st_size / 1e6
    tree = envelope["data"]["shapes"]["parts"]
    print(f"{OUT}  {mb:.2f} MB  parca: {', '.join(p['name'] for p in tree)}")


if __name__ == "__main__":
    main()
