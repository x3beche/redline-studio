"""A real board: the ports plugged in, flashing, and the serial monitor.

Routes under /api/embedded/<app>/... (rooms/fw-*.ts, rooms/code-view.ts)."""

from fastapi import APIRouter

router = APIRouter(prefix="/api/embedded")
