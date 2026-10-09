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
import os
import sys
import time
from pathlib import Path

# Seconds each phase took (load = the model and what it imports, tessellate
# = the viewer's payload, step = the STEP), said in the build's log.
TIMES: dict[str, float] = {}


class _phase:
    def __init__(self, name: str):
        self.name = name

    def __enter__(self):
        self.t0 = time.perf_counter()

    def __exit__(self, *exc):
        TIMES[self.name] = round(TIMES.get(self.name, 0) + time.perf_counter() - self.t0, 2)


def module_name(name: str) -> str:
    """The module the target runs as: not its import name, so a model that
    imports it back gets a module of its own, as it always did."""
    return "model_" + name.replace("/", "_")


def load(models_dir: Path, name: str):
    path = models_dir / f"{name}.py"
    if not path.exists():
        raise FileNotFoundError(path)
    spec = importlib.util.spec_from_file_location(module_name(name), path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def export(models_dir: Path, assets_dir: Path, name: str, marker=None) -> Path:
    from ocp_viewer_core.offline import _convert

    with _phase("load"):
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
    with _phase("tessellate"):
        envelope, _ = _convert(root, names=[root.label]) if root is not None \
            else _convert(*parts, names=names)
    # The model's own part names, whatever the tree's depth: the editor's
    # Part field offers these.
    envelope["names"] = names
    out = assets_dir / f"{name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(envelope))
    with _phase("step"):
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
    ap.add_argument("--warm", action="store_true",
                    help="only import the model the way a model using it does, so the "
                         "component cache has it (backend/build.py)")
    ap.add_argument("--flag", default=None,
                    help="with --warm: REDLINE_IMPORT_ONLY while it is imported")
    args = ap.parse_args()
    # Models this one imports come from the component cache when their
    # result is kept (backend/buildcache.py); the model itself always runs.
    # Warming, it is an import like any other and is kept too.
    # Bare model imports (`import lid`) go to the model the importer's
    # project means, per importing module (backend/modnames.py). The
    # target runs as model_<flat>: that module is the target model too.
    from backend import modnames
    names = modnames.read(args.models_dir)
    target_id = None
    if names is not None and not args.warm:
        target_id = next((i for i in names.module if i.replace("/", "__") == args.model), None)
    target = None if args.warm else (names.module[target_id] if target_id else args.model)
    modnames.install(args.models_dir, {module_name(args.model): target_id} if target_id else None)
    from backend import buildcache
    cache = buildcache.install(args.models_dir, args.models_dir.parent, target=target)
    if args.warm and cache is None:
        print("warm: the component cache is off")
        return
    # In front of the cache: whatever it serves, what a component made is
    # marked as that component's (the viewer's tree groups by it).
    from backend import assembly
    marker = assembly.install(args.models_dir, target=target)
    # The same answers to the questions a model asks many times, without
    # the setup each time (backend/fastgeom.py).
    from backend import fastgeom
    fastgeom.install()
    sys.path.insert(0, str(args.models_dir))
    if args.warm:
        warm(args.model, args.flag)
        buildcache.finish(cache)
        print(f"warm: {args.model} ({args.flag or 'standalone'}) {json.dumps(cache.stats)}")
        return
    out = export(args.models_dir, args.assets_dir, args.model, marker)
    print("timing: " + ", ".join(f"{k} {v:.1f}s" for k, v in TIMES.items()))
    print(f"{out}  {out.stat().st_size}")
    buildcache.finish(cache, args.assets_dir / f"{args.model}.cache.json")


def warm(name: str, flag: str | None) -> None:
    """Import `name` as a model that uses it would, REDLINE_IMPORT_ONLY as
    that model sets it: what the import makes goes into the component cache
    under the key that model's build will look for."""
    import importlib
    if flag is None:
        os.environ.pop("REDLINE_IMPORT_ONLY", None)
    else:
        os.environ["REDLINE_IMPORT_ONLY"] = flag
    with _phase("load"):
        importlib.import_module(name)


if __name__ == "__main__":
    main()
