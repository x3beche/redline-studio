"""Convert a build123d model into the OCP CAD Viewer format.

    python export_model.py --models-dir DIR --assets-dir DIR <model_name>

Source and output directories are supplied from outside so the backend can run
this script in a temporary directory and store the result in the database.
Module contract: TITLE (optional), PARTS (required), NAMES (optional).
Parts that came from another model or a board it imports are grouped under
one node per component in the viewer's tree (backend/assembly.py).
A STEP of PARTS is written to exports/ too, unless the model wrote one.
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


def export(models_dir: Path, assets_dir: Path, name: str, marker=None) -> Path:
    from ocp_viewer_core.offline import _convert

    module = load(models_dir, name)
    parts = getattr(module, "PARTS", None)
    if not parts:
        raise AttributeError(f"{name}: PARTS is not defined")
    names = getattr(module, "NAMES", None) or [f"part_{i}" for i in range(len(parts))]
    names = [str(n) for n in names]

    # One node per component it uses (backend/assembly.py); a model that
    # uses none is exported flat, as it always was.
    root = None
    if marker is not None:
        try:
            from backend import assembly
            title = getattr(module, "TITLE", None) or name.split("__")[-1]
            root = assembly.tree(list(parts), names, str(title), marker.titles, marker.sizes)
        except Exception as exc:                     # noqa: BLE001 - flat, then
            print(f"note: parts not grouped ({type(exc).__name__}: {exc})")
            root = None
    envelope, _ = _convert(root, names=[root.label]) if root is not None \
        else _convert(*parts, names=names)
    # The model's own part names, whatever the tree's depth: the editor's
    # Part field offers these.
    envelope["names"] = names
    out = assets_dir / f"{name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(envelope))
    step_of(parts, name, root)
    return out


def step_of(parts, name: str, root=None) -> None:
    """A STEP of the model, for releases and drawings, unless its script
    wrote its own into exports/ (the build keeps what is there). Never
    fails the build: the viewer's payload is what a build is for. With
    components grouped it is an assembly with the same named nodes."""
    exports = Path("exports")
    if not exports.is_dir() or any(exports.glob("*.step")) or any(exports.glob("*.stp")):
        return
    try:
        from build123d import Compound, Shape, export_step
        shapes = [p for p in parts if isinstance(p, Shape)]
        if not shapes:
            return
        whole = root if root is not None else \
            shapes[0] if len(shapes) == 1 else Compound(children=shapes)
        export_step(whole, str(exports / f"{name.split('__')[-1]}.step"))
    except Exception as exc:                         # noqa: BLE001
        print(f"no STEP written: {type(exc).__name__}: {exc}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--models-dir", required=True, type=Path)
    ap.add_argument("--assets-dir", required=True, type=Path)
    args = ap.parse_args()
    # Models this one imports come from the component cache when their
    # result is kept (backend/buildcache.py); the model itself always runs.
    from backend import buildcache
    cache = buildcache.install(args.models_dir, args.models_dir.parent, target=args.model)
    # In front of the cache: whatever it serves, what a component made is
    # marked as that component's (the viewer's tree groups by it).
    from backend import assembly
    marker = assembly.install(args.models_dir, target=args.model)
    sys.path.insert(0, str(args.models_dir))
    out = export(args.models_dir, args.assets_dir, args.model, marker)
    print(f"{out}  {out.stat().st_size}")
    buildcache.finish(cache, args.assets_dir / f"{args.model}.cache.json")


if __name__ == "__main__":
    main()
