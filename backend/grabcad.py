"""GrabCAD's library as a search-and-link source (backend/linked.py).

GrabCAD's models are downloaded with a GrabCAD account, so Workbench never
fetches grabcad.com - no page, no login, nothing to get past. A model is
found through a web search of what the search engine has indexed of
grabcad.com/library: its page (https://grabcad.com/library/<slug>, the slug
its key), its title, and what the snippet says of it - who uploaded it, its
formats, its likes and downloads. The person opens the page, downloads the
files there (Download files, with a free GrabCAD login), picks the STEP and
drops it - or the ZIP GrabCAD gives - on the saved model: a ZIP is unpacked
here and its STEP and mesh files kept. Each model is under its uploader's
terms, so every result says to check its licence, and a saved one has a
field for it.
"""

from __future__ import annotations

import re

from . import linked

GID = "grabcad"
SITE = "https://grabcad.com"
DOMAIN = "grabcad.com"
HOW = "Open → Download files (needs a free GrabCAD login) → pick the STEP"
CAUTION = "Check the model's licence on its page before using it in a product."

_SLUG = r"([a-z0-9][a-z0-9-]{1,150})"
_IN_URL = re.compile(r"grabcad\.com/library/" + _SLUG + r"(?:[/?#]|$)", re.I)
# Library pages that are not a model.
_NOT_MODELS = {"software", "categories", "category", "tag", "tags", "new", "popular", "search", "trending",
               "collections", "featured", "challenges"}
_FORMATS = (("STEP / IGES", r"STEP\s*/\s*IGES"), ("STEP", r"\bSTEP\b"), ("IGES", r"\bIGES\b"), ("STL", r"\bSTL\b"),
            ("SOLIDWORKS", r"\bSOLIDWORKS\b|\bSolidWorks\b"), ("Fusion 360", r"\bFusion 360\b"),
            ("Inventor", r"\bInventor\b"), ("CATIA", r"\bCATIA\b"), ("Creo", r"\bCreo\b"), ("Rhino", r"\bRhino\b"),
            ("Parasolid", r"\bParasolid\b"), ("OBJ", r"\bOBJ\b"), ("SketchUp", r"\bSketchUp\b"),
            ("Solid Edge", r"\bSolid Edge\b"), ("Onshape", r"\bOnshape\b"), ("NX", r"\bNX\b"))
_AUTHOR = re.compile(r"\b(?:[Uu]ploaded by|by)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,3})")
_COUNTS = re.compile(r"(\d[\d,.]*k?)\s+(likes?|downloads?|comments?)\b", re.I)


def url_of(slug: str) -> str:
    return f"{SITE}/library/{slug}"


def slug_of(text: str) -> str | None:
    """A model's slug out of its address, or the slug itself."""
    s = (text or "").strip()
    if m := _IN_URL.search(s):
        slug = m.group(1).lower()
        return None if slug in _NOT_MODELS else slug
    return s if re.fullmatch(_SLUG, s) and "-" in s and s not in _NOT_MODELS else None


def facts_of(text: str) -> dict[str, str]:
    """What a snippet says of a model: its formats, likes, downloads."""
    out: dict[str, str] = {}
    fmts: list[str] = []
    for name, rx in _FORMATS:
        if re.search(rx, text or "") and not any(name in f for f in fmts):
            fmts.append(name)
    if fmts:
        out["Formats"] = ", ".join(fmts[:6])
    for n, what in _COUNTS.findall(text or ""):
        label = what.lower().rstrip("s").capitalize() + "s"
        out.setdefault(label, n)
    return out


def parse(rows: list[dict]) -> list[dict]:
    """Search results as GrabCAD models, each once, in the order found:
    {key, title, url, author, specs, snippet, source}. Only results that
    are a model's own page count."""
    seen: dict[str, dict] = {}
    for r in rows:
        url = str(r.get("url") or "")
        slug = (m.group(1).lower() if (m := _IN_URL.search(url)) else None)
        if not slug or slug in _NOT_MODELS or slug in seen:
            continue
        title = linked.clean_title(str(r.get("title") or ""), "GrabCAD", r"3D CAD Model Library",
                                   r"Free CAD Designs, Files & 3D Models", "GrabCAD")
        desc = str(r.get("description") or "")
        a = _AUTHOR.search(desc) or _AUTHOR.search(str(r.get("title") or ""))
        seen[slug] = {"key": slug, "title": title[:200] or slug.replace("-", " "), "url": url_of(slug),
                      "author": a.group(1).strip() if a else "", "specs": facts_of(f"{title}. {desc}"),
                      "snippet": desc[:300], "source": url}
    return list(seen.values())


def searches(q: str) -> list[str]:
    return [f"{q} library", f"{q} STEP CAD model"]


KIND = linked.register(linked.Kind(
    id=GID, name="GrabCAD", domain=DOMAIN, site=SITE, noun="model", key_label="Model", how=HOW, caution=CAUTION,
    summary="Models saved from GrabCAD's library: found through a web search, never read from its site; each links "
            "to its page, and its files, downloaded there, are kept here for the CAD models.",
    key_of=slug_of, url_of=url_of, searches=searches, parse=parse, search_site=DOMAIN,
    accept=(".step", ".stp", ".stl", ".3mf", ".obj", ".zip"), extra=("licence", "author")))
