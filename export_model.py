"""Convert a build123d model into the OCP CAD Viewer format.

    python export_model.py --models-dir DIR --assets-dir DIR <model_name>

Source and output directories are supplied from outside so the backend can run
this script in a temporary directory and store the result in the database.
Module contract: TITLE (optional), PARTS (required), NAMES (optional).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


def load(models_dir: Path, name: str):
    path = models_dir / f"{name}.py"
    if not path.exists():
        raise FileNotFoundError(path)
    spec = importlib.util.spec_from_file_location("model_" + name.replace("/", "_"), path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def export(models_dir: Path, assets_dir: Path, name: str) -> Path:
    from ocp_viewer_core.offline import _convert

    module = load(models_dir, name)
    parts = getattr(module, "PARTS", None)
    if not parts:
        raise AttributeError(f"{name}: PARTS is not defined")
    names = getattr(module, "NAMES", None) or [f"part_{i}" for i in range(len(parts))]

    envelope, _ = _convert(*parts, names=names)
    out = assets_dir / f"{name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(envelope))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--models-dir", required=True, type=Path)
    ap.add_argument("--assets-dir", required=True, type=Path)
    args = ap.parse_args()
    sys.path.insert(0, str(args.models_dir))
    out = export(args.models_dir, args.assets_dir, args.model)
    print(f"{out}  {out.stat().st_size}")


if __name__ == "__main__":
    main()
