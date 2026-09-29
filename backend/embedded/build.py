"""What the build made: what fills flash (by group, archive, file), size history, commits and diffs.

Routes under /api/embedded/<app>/... (rooms/fw-*.ts, rooms/code-view.ts)."""

from fastapi import APIRouter

router = APIRouter(prefix="/api/embedded")
