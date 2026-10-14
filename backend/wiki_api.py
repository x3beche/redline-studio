"""The project wiki's routes (backend/wiki.py has the rules).

  GET    /api/wiki/projects                     the projects, with how many pages each
  GET    /api/wiki/for?kind=&id=                the project a model, board or firmware is in
  GET    /api/wiki/search?q=&project=           pages with the words (the Wiki room, Ctrl+K)
  GET    /api/wiki/p/{project}                  its pages, pinned first, then the newest
  GET    /api/wiki/p/{project}/{page}           one page, with the pages that link to it
  PUT    /api/wiki/p/{project}/{page}           write it (a new version; `base` checked)
  PATCH  /api/wiki/p/{project}/{page}           pin or unpin it
  DELETE /api/wiki/p/{project}/{page}           delete it and its history
  GET    /api/wiki/p/{project}/{page}/history   its versions, newest first
  GET    /api/wiki/p/{project}/{page}/versions/{n}?against=   one version, and its difference
  POST   /api/wiki/p/{project}/{page}/restore   an old version back, as a new one

Reading is "view"; PUT, PATCH and POST are "edit", DELETE "delete"
(backend/access.py's defaults by method) - viewers read, editors write.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import actors, wiki

router = APIRouter(prefix="/api/wiki")


def _db():
    from .main import db
    return db()


def _fail(exc: wiki.Refused):
    raise HTTPException(exc.status, str(exc)) from exc


class PageIn(BaseModel):
    text: str | None = Field(default=None, max_length=wiki.MAX_TEXT + 1000)
    append: str | None = Field(default=None, max_length=wiki.MAX_TEXT)
    title: str | None = Field(default=None, max_length=wiki.MAX_TITLE)
    summary: str = Field(default="", max_length=wiki.MAX_SUMMARY)
    # The version the change was made on; None for a new page (or "whatever it is now").
    base: int | None = None


class PinIn(BaseModel):
    pinned: bool


class RestoreIn(BaseModel):
    version: int = Field(ge=1)


@router.get("/projects")
async def wiki_projects():
    return await wiki.projects(_db())


@router.get("/for")
async def wiki_for(kind: str, id: str):
    return {"project": await wiki.project_of(_db(), kind, id)}


@router.get("/search")
async def wiki_search(q: str = "", project: str = "", limit: int = 20):
    return await wiki.search(_db(), q, project or None, limit)


@router.get("/p/{project}")
async def wiki_pages(project: str):
    db = _db()
    return {"project": project, "exists": await wiki.exists(db, project), "pages": await wiki.pages(db, project)}


@router.get("/p/{project}/{page}")
async def wiki_page(project: str, page: str):
    got = await wiki.get(_db(), project, page)
    if not got:
        raise HTTPException(404, f"no page {page!r} in {project}'s wiki")
    return got


@router.put("/p/{project}/{page}")
async def wiki_write(project: str, page: str, body: PageIn):
    try:
        got, changed = await wiki.write(_db(), project, page, text=body.text, append=body.append,
                                        summary=body.summary, title=body.title, base=body.base,
                                        by=actors.current())
    except wiki.Refused as exc:
        _fail(exc)
    return {**got, "changed": changed}


@router.patch("/p/{project}/{page}")
async def wiki_pin(project: str, page: str, body: PinIn):
    try:
        return await wiki.set_pinned(_db(), project, page, body.pinned)
    except wiki.Refused as exc:
        _fail(exc)


@router.delete("/p/{project}/{page}")
async def wiki_delete(project: str, page: str):
    if not await wiki.remove(_db(), project, page):
        raise HTTPException(404, f"no page {page!r} in {project}'s wiki")
    return {"deleted": wiki.page_id(project, wiki.slug(page))}


@router.get("/p/{project}/{page}/history")
async def wiki_history(project: str, page: str):
    return await wiki.history(_db(), project, page)


@router.get("/p/{project}/{page}/versions/{n}")
async def wiki_version(project: str, page: str, n: int, against: int | None = None):
    try:
        return await wiki.compare(_db(), project, page, n, against)
    except wiki.Refused as exc:
        _fail(exc)


@router.post("/p/{project}/{page}/restore")
async def wiki_restore(project: str, page: str, body: RestoreIn):
    try:
        return await wiki.restore(_db(), project, page, body.version, by=actors.current())
    except wiki.Refused as exc:
        _fail(exc)
