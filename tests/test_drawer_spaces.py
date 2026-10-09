"""A drawer is an account's: parts are cached once for the server, but each
space sees, finds and drops only the parts it fetched, added or built with.
Parts from before drawers were per space are the default space's."""
import asyncio

from backend import lcsc, scope


def matches(doc: dict, q: dict) -> bool:
    for k, v in q.items():
        if k == "$and":
            if not all(matches(doc, x) for x in v):
                return False
        elif k == "$or":
            if not any(matches(doc, x) for x in v):
                return False
        elif isinstance(v, dict) and "$exists" in v:
            if (k in doc) != v["$exists"]:
                return False
        elif isinstance(doc.get(k), list):
            if v not in doc[k]:
                return False
        elif doc.get(k) != v:
            return False
    return True


class Parts:
    def __init__(self, rows):
        self.rows = {r["_id"]: dict(r) for r in rows}

    async def find_one(self, q, projection=None):
        return next((dict(d) for d in self.rows.values() if matches(d, q)), None)

    async def update_one(self, q, upd):
        d = await self.find_one(q)
        if not d:
            return
        d = self.rows[d["_id"]]
        for k, v in (upd.get("$set") or {}).items():
            if "." in k:
                a, b = k.split(".", 1)
                d.setdefault(a, {})[b] = v
            else:
                d[k] = v
        for k in upd.get("$unset") or {}:
            a, _, b = k.partition(".")
            (d.get(a) or {}).pop(b, None) if b else d.pop(a, None)

    async def delete_one(self, q):
        d = await self.find_one(q)
        if d:
            del self.rows[d["_id"]]

    def visible(self, ws):
        return sorted(i for i, d in self.rows.items() if matches(d, lcsc.held_by(ws)))


def run(c):
    return asyncio.run(c)


def test_old_parts_are_the_default_space_s_and_no_one_else_s():
    p = Parts([{"_id": "C1001"}, {"_id": "C1002"}])
    db = {lcsc.PARTS: p}
    assert p.visible(scope.DEFAULT) == ["C1001", "C1002"]
    assert p.visible("team2") == []
    assert run(lcsc.holds(db, "C1001", "team2")) is None and run(lcsc.holds(db, "C1001", scope.DEFAULT))


def test_holding_and_letting_go_per_space():
    p = Parts([{"_id": "C1001"}])
    db = {lcsc.PARTS: p}
    run(lcsc.hold(db, "C1001", "team2"))
    assert p.rows["C1001"]["spaces"] == [scope.DEFAULT, "team2"] and "team2" in p.rows["C1001"]["held"]
    assert p.visible("team2") == ["C1001"] and p.visible(scope.DEFAULT) == ["C1001"] and p.visible("team3") == []
    # dropping it from one drawer keeps the cache for the other
    assert run(lcsc.let_go(db, "C1001", scope.DEFAULT)) is True
    assert p.visible(scope.DEFAULT) == [] and p.visible("team2") == ["C1001"]
    assert run(lcsc.let_go(db, "C1001", "team3")) is False
    # the last drawer lets go: the cached part goes
    assert run(lcsc.let_go(db, "C1001", "team2")) is True and "C1001" not in p.rows


def test_fetch_puts_a_cached_part_in_the_asking_space(monkeypatch):
    p = Parts([{"_id": "C1001", "footprint": "(fp)", "artifacts": {"model": {"bytes": 1}}, "model_kind": "step"}])
    db = {lcsc.PARTS: p}
    tok = scope.WORKSPACE.set("team2")
    try:
        run(lcsc.fetch(db, "C1001"))
    finally:
        scope.WORKSPACE.reset(tok)
    assert p.visible("team2") == ["C1001"] and p.visible(scope.DEFAULT) == ["C1001"]
