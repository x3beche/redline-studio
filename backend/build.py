"""Model build: source comes from the database, work happens in a temporary
directory, output goes back to the database. Nothing persists on disk."""

from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

from . import store

TIMEOUT = 900


async def build(db, model_id: str, script: Path) -> dict:
    doc = await db.models.find_one({"_id": model_id})
    if not doc:
        raise KeyError(model_id)
    if not doc.get("ready"):
        raise ValueError(f"{model_id}: PARTS is not defined")

    tmp = Path(tempfile.mkdtemp(prefix="x3build-"))
    try:
        models_dir = tmp / "models"
        models_dir.mkdir()
        # A model id may contain folders; a flat name is enough in the temp dir.
        flat = model_id.replace("/", "__")
        (models_dir / f"{flat}.py").write_text(doc["source"])
        assets_dir = tmp / "assets"
        # Models tend to write STEP/STL under <root>/exports; we create the
        # directory so model code does not have to.
        (tmp / "exports").mkdir()
        assets_dir.mkdir()

        proc = await asyncio.create_subprocess_exec(
            sys.executable, str(script), flat,
            "--models-dir", str(models_dir), "--assets-dir", str(assets_dir),
            cwd=str(tmp),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(f"{model_id}: build did not finish within {TIMEOUT}s")

        log = out.decode(errors="replace").strip().splitlines()
        if proc.returncode != 0:
            raise RuntimeError("\n".join(log[-8:]) or "build failed")

        stored = {}
        viewer = assets_dir / f"{flat}.json"
        if not viewer.exists():
            raise RuntimeError("viewer payload was not produced")
        stored["viewer"] = await store.put_artifact(
            db, model_id, "viewer", viewer.read_bytes())

        # If the model wrote its own STEP/STL, keep those too.
        for path in sorted((tmp / "exports").glob("*")) if (tmp / "exports").exists() else []:
            label = path.suffix.lstrip(".").lower()
            if label in ("step", "stl", "3mf"):
                stored[label] = await store.put_artifact(
                    db, model_id, label, path.read_bytes())

        return {"model": model_id,
                "artifacts": {k: v["bytes"] for k, v in stored.items()},
                "log": "\n".join(log[-4:])}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
