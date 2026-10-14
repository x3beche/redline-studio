"""Who may change a Parts product's files, by every way there is to change
them: the Parts page's routes (which the agents' `revisions.py product` and
the MCP server call with a token), the Chat's product tools, and Files'
own routes - which refuse them for everyone (backend/files_virtual.py
parts_owned).

Each way is tried as the owner, an editor, a viewer, a page session (it
only looks), an agent token with each role, and from another workspace (it
sees nothing). The sessions are stood in for (auth.session_user); the
products come from the Parts page's own routes, as test_product_files.py
makes them."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from backend import access, actors, auth, chat_tools, files, scope
from backend import main as M
from backend.chat_tools import Ctx, ToolError
from test_files_folders import Grid
from test_manufacturers import PUBLIC
from test_product_files import PDF, _addr
from test_telegram import FakeDb
from backend import manufacturers as mf

ME = {"type": "user", "id": "u1", "name": "One"}


def run(c):
    return asyncio.run(c)


@pytest.fixture
def env(monkeypatch):
    fake = FakeDb()
    g = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: g)
    monkeypatch.setattr(M, "db", lambda: scope.ScopedDb(fake, scope.current()))
    monkeypatch.setitem(PUBLIC, "www.robo90.com", ["93.184.216.40"])
    monkeypatch.setattr(mf, "_resolve", lambda host: _addr(host))
    who = {"role": "owner", "page": False, "ws": scope.DEFAULT, "token": None}

    async def session(db, cookie):
        return {"user": ME, "workspace": who["ws"], "role": who["role"], "page": who["page"]}

    async def token_agent(db, token):
        return {"actor": {"type": "agent", "id": "pcb room", "name": "pcb room"}, "workspace": who["ws"],
                "role": who["role"]} if token == "rlat_test" else None
    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "session_user", session)
    monkeypatch.setattr(auth, "token_agent", token_agent)
    web = TestClient(M.app)
    web.headers[auth.CSRF_HEADER] = "1"
    web.cookies.set(auth.COOKIE, "x")
    # a site's maker with one product, and a PDF on it - made as the owner, through the page's routes
    m = web.post("/api/manufacturers", json={"url": "https://www.robo90.com/", "name": "Robo90", "explore": False}).json()
    mid = m["manufacturer"]["id"]
    pid = web.post(f"/api/manufacturers/{mid}/products", json={"name": "Hinge"}).json()["product"]["id"]
    url = f"/api/manufacturers/{mid}/products/{pid}/files"
    got = web.post(url, files={"upload": ("hinge.pdf", PDF)}).json()
    fid = got["files"][0]["file"]
    spare = web.post("/api/files", files={"upload": ("spare.pdf", PDF + b"2", "application/pdf")}).json()[0]["id"]
    return {"web": web, "who": who, "fake": fake, "mid": mid, "pid": pid, "url": url, "fid": fid, "spare": spare}


def as_(env, role, page=False, ws=scope.DEFAULT, token=False):
    env["who"].update(role=role, page=page, ws=ws)
    web = env["web"]
    if token:
        web.headers["Authorization"] = "Bearer rlat_test"
    else:
        web.headers.pop("Authorization", None)
    return web


WRITERS = [("owner", False, False), ("editor", False, False), ("editor", False, True), ("reviewer", False, True)]
READERS = [("viewer", False, False), ("owner", True, False), ("viewer", False, True)]


@pytest.mark.parametrize("role,page,token", WRITERS)
def test_the_parts_routes_let_who_may_draw_attach_make_main_and_detach(env, role, page, token):
    web = as_(env, role, page, token=token)
    url, fid, spare = env["url"], env["fid"], env["spare"]
    r = web.post(url + "/attach", json={"files": [spare]})
    assert r.status_code == 200 and r.json()["report"][0]["status"] == "attached", r.text
    assert web.patch(f"{url}/{fid}", json={"main": True}).status_code in (200, 400)   # a PDF is no model: refused, not forbidden
    assert web.delete(f"{url}/{spare}").status_code == 200


@pytest.mark.parametrize("role,page,token", READERS)
def test_the_parts_routes_refuse_who_only_looks(env, role, page, token):
    web = as_(env, role, page, token=token)
    url, fid, spare = env["url"], env["fid"], env["spare"]
    for r in (web.post(url + "/attach", json={"files": [spare]}), web.post(url, files={"upload": ("x.pdf", PDF + b"x")}),
              web.patch(f"{url}/{fid}", json={"main": True}), web.delete(f"{url}/{fid}")):
        assert r.status_code == 403, (role, page, token, r.status_code, r.text)
    assert web.get(url).status_code == 200                       # looking is everyone's


def test_another_workspace_reaches_none_of_it(env):
    web = as_(env, "owner", ws="u2")
    url, fid = env["url"], env["fid"]
    assert web.get(url).status_code == 404
    assert web.delete(f"{url}/{fid}").status_code == 404
    assert web.patch(f"/api/files/{fid}", json={"note": "x"}).status_code == 404
    assert web.delete(f"/api/files/{fid}").status_code == 404


@pytest.mark.parametrize("role,page,token", WRITERS + READERS)
def test_files_own_routes_refuse_a_parts_file_for_everyone(env, role, page, token):
    web = as_(env, role, page, token=token)
    fid = env["fid"]
    for r in (web.patch(f"/api/files/{fid}", json={"name": "x.pdf"}), web.delete(f"/api/files/{fid}"),
              web.post("/api/files/bulk-delete", json={"files": [fid]}), web.post("/api/files/move", json={"files": [fid], "to": ""})):
        assert r.status_code == 403, (role, page, token, r.status_code)
        if role in ("owner", "editor") and not page:
            assert "Parts page" in r.json()["detail"]
    assert web.get(f"/api/files/{fid}").status_code == 200     # reading it is everyone's


# ---------------------------------------------------------------- the Chat's product tools

def _tool(name):
    return chat_tools.tools()[name]


@pytest.mark.parametrize("role,ok", [("owner", True), ("editor", True), ("reviewer", True), ("viewer", False)])
def test_the_chats_product_tools_follow_the_role(env, monkeypatch, role, ok):
    monkeypatch.setattr(access, "current", lambda: role)
    monkeypatch.setattr(actors, "current", lambda: ME)
    db = scope.ScopedDb(env["fake"], scope.DEFAULT)
    ctx = Ctx(db=db, actor=ME, chat="")
    args = {"manufacturer": env["mid"], "product": env["pid"], "files": [env["spare"]]}
    if ok:
        run(_tool("product_file_attach").run(ctx, args))
        run(_tool("product_file_detach").run(ctx, {"manufacturer": env["mid"], "product": env["pid"], "file": env["spare"]}))
    else:
        with pytest.raises(ToolError):
            run(_tool("product_file_attach").run(ctx, args))
        with pytest.raises(ToolError):
            run(_tool("product_file_detach").run(ctx, {"manufacturer": env["mid"], "product": env["pid"], "file": env["fid"]}))


def test_the_chat_detaches_someone_elses_file_only_with_the_right_to_delete(env, monkeypatch):
    monkeypatch.setattr(access, "current", lambda: "reviewer")
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "u9", "name": "Nine"})
    db = scope.ScopedDb(env["fake"], scope.DEFAULT)
    with pytest.raises(ToolError):
        run(_tool("product_file_detach").run(Ctx(db=db, actor={"id": "u9", "name": "Nine"}, chat=""),
                                             {"manufacturer": env["mid"], "product": env["pid"], "file": env["fid"]}))
