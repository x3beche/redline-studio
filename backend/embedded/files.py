"""The code editor on a firmware: the project's files on disk - list, read, write - with git status.

Routes under /api/embedded/<app>/... (rooms/fw-*.ts, rooms/code-view.ts)."""

from fastapi import APIRouter

router = APIRouter(prefix="/api/embedded")
