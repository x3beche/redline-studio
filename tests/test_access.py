"""Who may do what: every route of the app against every role.

The matrix is built from the app's own route list, so a route added later
is in it without anyone remembering to add it."""
import re

from backend import access


def routes():
    from backend.main import app
    out = []
    for path, ops in app.openapi()["paths"].items():
        for method in ops:
            # A concrete path: every {parameter} becomes one segment.
            out.append((method.upper(), re.sub(r"\{[^}]+\}", "x", path)))
    return out


def test_every_route_is_one_known_action():
    seen = routes()
    assert len(seen) > 100
    for method, path in seen:
        assert access.action(method, path) in {*access.ACTIONS, access.NONE}, (method, path)


def test_the_matrix():
    """Each role may do exactly its actions, on every route."""
    for method, path in routes():
        act = access.action(method, path)
        for role in access.ROLES:
            assert access.allowed(role, act) == (act == access.NONE or act in access.CAN[role]), \
                (role, method, path)


def test_a_viewer_only_looks():
    for method, path in routes():
        act = access.action(method, path)
        if method == "GET" or act == access.NONE:
            continue
        ok = access.allowed("viewer", act)
        # The few writes a viewer may make are checks and lookups that
        # change nothing, the agents' way in (which checks its writes), and
        # moving to another workspace they are a member of.
        assert not ok or (method, path) in {
            ("POST", "/api/boards/x/rules/check"), ("POST", "/api/tools/find"),
            ("POST", "/api/tools/usage"), ("POST", "/api/agent/db"), ("POST", "/api/agent/files/x"),
            ("DELETE", "/api/agent/files/x/x"), ("POST", "/api/workspaces/x/open")}, (method, path)


def test_a_reviewer_draws_but_does_not_queue_build_or_delete():
    r = "reviewer"
    assert access.allowed(r, access.action("POST", "/api/revisions"))                 # a new note
    assert access.allowed(r, access.action("PUT", "/api/revisions/n1"))               # edit it
    assert access.allowed(r, access.action("PATCH", "/api/revisions/n1", {"status": "draft"}))
    assert access.allowed(r, access.action("POST", "/api/chat"))
    assert access.allowed(r, access.action("POST", "/api/questions/q1/answer"))
    assert not access.allowed(r, access.action("PATCH", "/api/revisions/n1", {"status": "queued"}))
    assert not access.allowed(r, access.action("PATCH", "/api/revisions/n1", {}))
    assert not access.allowed(r, access.action("POST", "/api/boards/b/build"))
    assert not access.allowed(r, access.action("POST", "/api/models/iot-fan/case/build"))
    assert not access.allowed(r, access.action("POST", "/api/apps/a/flash"))
    assert not access.allowed(r, access.action("POST", "/api/tools/run"))
    for path in ("/api/revisions/n1", "/api/boards/b", "/api/models/iot-fan/case", "/api/chat"):
        assert not access.allowed(r, access.action("DELETE", path)), path


def test_an_editor_works_but_does_not_manage():
    e = "editor"
    for method, path in (("PATCH", "/api/revisions/n1"), ("POST", "/api/boards/b/build"),
                         ("PUT", "/api/boards/b"), ("DELETE", "/api/boards/b"), ("POST", "/api/agent-tokens"),
                         ("PUT", "/api/tools/data/t")):
        assert access.allowed(e, access.action(method, path)), (method, path)
    for method, path in (("GET", "/api/members"), ("POST", "/api/invites"), ("PATCH", "/api/members/u"),
                         ("PUT", "/api/settings"), ("PUT", "/api/insights/settings")):
        assert not access.allowed(e, access.action(method, path)), (method, path)


def test_admins_and_owners_manage():
    for role in ("admin", "owner"):
        for method, path in (("GET", "/api/members"), ("POST", "/api/invites"), ("DELETE", "/api/members/u"),
                             ("PUT", "/api/settings")):
            assert access.allowed(role, access.action(method, path)), (role, method, path)


def test_signed_out_reaches_only_signing_in():
    for method, path in routes():
        act = access.action(method, path)
        open_ = access.allowed(None, act)
        assert open_ == (path.startswith(("/api/auth/", "/api/invite/")) or path == "/api/health"), (method, path)


def test_the_tool_pages_are_for_looking():
    # A static mount, not in the route list: the rule for its method.
    assert access.action("GET", "/api/tools/files/grid-sketch/index.html") == "view"


def test_agents_work_they_do_not_manage():
    assert "owner" not in access.TOKEN_ROLES and "admin" not in access.TOKEN_ROLES
    for role in access.TOKEN_ROLES:
        assert "members" not in access.CAN[role] and "settings" not in access.CAN[role]


def test_a_refusal_says_who_can():
    msg = access.refusal("reviewer", "run")
    assert "reviewer" in msg and "editor" in msg
