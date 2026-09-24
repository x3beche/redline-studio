"""Try what a tool wrote, for real, and say what happened.

    echo '{"kind": "sql", "input": "create table t (id int);"}' \
      | docker run --rm -i --network none redline-tools

One JSON object in on stdin, one out on stdout:
    {"ok": bool, "errors": [{"message", "line"?}], "notes": [...], ...}
`ok` false with `errors` is a finding about the input; a crash of the
checker itself says so in `errors` too, with `internal: true`.

Kinds: sql, prisma, ts, openapi, mermaid, regex, cron.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path("/opt/tools")
BIN = TOOLS / "node_modules/.bin"
PG = Path("/usr/lib/postgresql/16/bin")


def run(cmd: list[str], cwd: str | None = None, timeout: float = 60,
        stdin: str | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, input=stdin, capture_output=True, text=True,
                          timeout=timeout, env={**os.environ, **(env or {})})


def lines_of(text: str) -> list[str]:
    return [ln for ln in text.splitlines() if ln.strip()]


# ---------------- SQL in a PostgreSQL made for this one run ----------------
def check_sql(req: dict, work: Path) -> dict:
    data = work / "pg"
    init = run([str(PG / "initdb"), "-D", str(data), "-U", "postgres", "--auth=trust",
                "-E", "UTF8", "--no-instructions"], timeout=60)
    if init.returncode:
        return {"ok": False, "errors": [{"message": init.stderr.strip(), "internal": True}]}
    start = run([str(PG / "pg_ctl"), "-D", str(data), "-w", "-l", str(work / "pg.log"),
                 "-o", f"-k {work} -c listen_addresses='' -c fsync=off", "start"], timeout=60)
    if start.returncode:
        return {"ok": False, "errors": [{"message": start.stderr.strip(), "internal": True}]}
    try:
        sql = work / "input.sql"
        sql.write_text(req.get("input", ""))
        psql = [str(PG / "psql"), "-h", str(work), "-U", "postgres", "-X", "-q",
                "-v", "ON_ERROR_STOP=1", "-d", "postgres"]
        out = run([*psql, "-f", str(sql)], timeout=60)
        errors = []
        for ln in lines_of(out.stderr):
            m = re.match(r"psql:[^:]+:(\d+): (?:ERROR|FATAL):\s*(.*)", ln)
            if m:
                errors.append({"line": int(m.group(1)), "message": m.group(2)})
            elif errors and not ln.startswith("psql:"):
                errors[-1]["message"] += "\n" + ln.strip()
        tables = run([*psql, "-At", "-c",
                      "select table_name from information_schema.tables "
                      "where table_schema='public' order by 1"], timeout=30)
        made = lines_of(tables.stdout)
        notes = [f"PostgreSQL 16: {len(made)} table(s) created" + (f": {', '.join(made)}" if made else "")]
        return {"ok": out.returncode == 0 and not errors, "errors": errors, "notes": notes,
                "tables": made}
    finally:
        run([str(PG / "pg_ctl"), "-D", str(data), "-m", "immediate", "stop"], timeout=30)


# ---------------- a Prisma schema ----------------
def check_prisma(req: dict, work: Path) -> dict:
    schema = work / "schema.prisma"
    schema.write_text(req.get("input", ""))
    out = run([str(BIN / "prisma"), "validate", f"--schema={schema}"], cwd=str(work),
              timeout=90, env={"HOME": str(work)})
    text = (out.stdout + "\n" + out.stderr).strip()
    if out.returncode == 0:
        return {"ok": True, "errors": [], "notes": [ln for ln in lines_of(text) if "valid" in ln.lower()]
                or ["The schema is valid."]}
    errors = []
    for block in re.split(r"\n(?=error: )", text):
        if block.startswith("error: ") or "error" in block.lower():
            m = re.search(r"schema\.prisma:(\d+)", block)
            errors.append({"message": re.sub(r"\x1b\[[0-9;]*m", "", block.strip())[:1500],
                           **({"line": int(m.group(1))} if m else {})})
    return {"ok": False, "errors": errors or [{"message": text[:1500]}]}


# ---------------- TypeScript against the real libraries ----------------
def check_ts(req: dict, work: Path) -> dict:
    files = req.get("files") or {"input.tsx": req.get("input", "")}
    for name, body in files.items():
        p = work / Path(name).name
        p.write_text(body)
    (work / "node_modules").symlink_to(TOOLS / "node_modules")
    (work / "tsconfig.json").write_text(json.dumps({"compilerOptions": {
        "strict": True, "noEmit": True, "target": "ES2022", "module": "ESNext",
        "moduleResolution": "Bundler", "jsx": "react-jsx", "skipLibCheck": True,
        "esModuleInterop": True, "lib": ["ES2022", "DOM", "DOM.Iterable"]},
        "include": [Path(n).name for n in files]}))
    out = run([str(BIN / "tsc"), "-p", str(work), "--pretty", "false"], cwd=str(work), timeout=120)
    errors = []
    for ln in lines_of(out.stdout):
        m = re.match(r"(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)", ln)
        if m:
            errors.append({"file": m.group(1), "line": int(m.group(2)), "column": int(m.group(3)),
                           "code": m.group(4), "message": m.group(5)})
        elif errors:
            errors[-1]["message"] += " " + ln.strip()
    versions = {}
    for pkg in ("typescript", "zod", "react-hook-form", "@hookform/resolvers", "react"):
        try:
            versions[pkg] = json.loads((TOOLS / "node_modules" / pkg / "package.json").read_text())["version"]
        except (OSError, ValueError, KeyError):
            pass
    return {"ok": out.returncode == 0, "errors": errors,
            "notes": ["tsc --strict with " + ", ".join(f"{k} {v}" for k, v in versions.items())]}


# ---------------- OpenAPI ----------------
def check_openapi(req: dict, work: Path) -> dict:
    import yaml
    try:
        doc = yaml.safe_load(req.get("input", ""))
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        return {"ok": False, "errors": [{"message": f"YAML does not parse: {e}",
                                         **({"line": mark.line + 1} if mark else {})}]}
    try:
        from openapi_spec_validator import validate
    except ImportError:                      # older releases
        from openapi_spec_validator import validate_spec as validate
    try:
        validate(doc)
    except Exception as e:                   # the validator's own error types vary by release
        path = "/".join(str(p) for p in getattr(e, "path", []) or [])
        return {"ok": False, "errors": [{"message": getattr(e, "message", str(e))[:1500],
                                         **({"path": path} if path else {})}]}
    return {"ok": True, "errors": [],
            "notes": [f"Valid OpenAPI {doc.get('openapi', '?')}: "
                      f"{len(doc.get('paths') or {})} path(s)"]}


# ---------------- Mermaid, rendered ----------------
def check_mermaid(req: dict, work: Path) -> dict:
    src = work / "input.mmd"
    src.write_text(req.get("input", ""))
    svg = work / "out.svg"
    theme = req.get("theme") if req.get("theme") in ("default", "dark", "neutral", "forest") else "default"
    out = run([str(BIN / "mmdc"), "-p", str(TOOLS / "puppeteer.json"), "-i", str(src),
               "-o", str(svg), "-t", theme, "-b", "transparent", "-q"],
              cwd=str(work), timeout=120, env={"HOME": str(work)})
    if out.returncode or not svg.exists():
        text = re.sub(r"\x1b\[[0-9;]*m", "", (out.stderr or out.stdout)).strip()
        m = re.search(r"line (\d+)", text)
        first = next((ln for ln in text.splitlines() if "error" in ln.lower() or "Parse" in ln), text[:400])
        return {"ok": False, "errors": [{"message": first.strip()[:800], "detail": text[:3000],
                                         **({"line": int(m.group(1))} if m else {})}]}
    return {"ok": True, "errors": [], "svg": svg.read_text(), "notes": ["Rendered by mermaid-cli"]}


# ---------------- a regex in the real engines ----------------
def check_regex(req: dict, work: Path) -> dict:
    pattern = req.get("pattern", "")
    text = req.get("text", "")
    flags = req.get("flags", "")
    result: dict = {"ok": True, "errors": [], "engines": {}}
    # Python's re, with the Python dialect of the pattern if one was sent.
    py_pat = req.get("python", pattern)
    f = 0
    f |= re.I if "i" in flags else 0
    f |= re.M if "m" in flags else 0
    f |= re.S if "s" in flags else 0
    try:
        rx = re.compile(py_pat, f)
        result["engines"]["python"] = {
            "matches": [{"start": m.start(), "end": m.end(), "text": m.group(0)}
                        for m in rx.finditer(text)][:500]}
    except re.error as e:
        result["ok"] = False
        result["errors"].append({"engine": "python", "message": str(e)})
    # PCRE2 itself, through PHP's preg_match_all: the whole text at once,
    # with i/m/s/u as flags, and each match's byte offset.
    pcre = req.get("pcre", pattern)
    delim = "\x01"
    mods = "".join(f for f in "ims" if f in flags) + "u"
    php = ("$p=getenv('P'); $t=file_get_contents('php://stdin');"
           "$n=@preg_match_all($p,$t,$m,PREG_OFFSET_CAPTURE);"
           "if($n===false){$e=error_get_last();echo json_encode(['error'=>$e?preg_replace('/^preg_match_all\\(\\): /','',$e['message']):preg_last_error_msg()]);exit;}"
           "echo json_encode(['matches'=>array_map(fn($x)=>['text'=>$x[0],'byte'=>$x[1]],$m[0])]);")
    out = run(["php", "-r", php], stdin=text, timeout=20,
              env={"P": delim + pcre + delim + mods})
    try:
        got = json.loads(out.stdout or "{}")
    except ValueError:
        got = {"error": (out.stderr or out.stdout).strip()[:400]}
    if "error" in got:
        result["ok"] = False
        result["errors"].append({"engine": "pcre2", "message": got["error"]})
    else:
        # byte offsets to character offsets, as Python's are
        raw = text.encode()
        result["engines"]["pcre2"] = {"matches": [
            {"start": len(raw[:m["byte"]].decode(errors="ignore")),
             "end": len(raw[:m["byte"]].decode(errors="ignore")) + len(m["text"]),
             "text": m["text"]} for m in got["matches"]][:500]}
    return result


# ---------------- a cron schedule, second opinion ----------------
def check_cron(req: dict, work: Path) -> dict:
    from datetime import datetime
    import pytz
    from croniter import croniter
    expr = req.get("input", "")
    tzname = req.get("tz") or "UTC"
    try:
        tz = pytz.timezone(tzname)
    except pytz.UnknownTimeZoneError:
        return {"ok": False, "errors": [{"message": f"Unknown time zone {tzname}"}]}
    start = req.get("start")
    base = datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(tz) if start \
        else datetime.now(tz)
    if not croniter.is_valid(expr):
        return {"ok": False, "errors": [{"message": f"croniter does not accept '{expr}'"}]}
    it = croniter(expr, base)
    runs = [it.get_next(datetime).isoformat() for _ in range(int(req.get("count", 10)))]
    return {"ok": True, "errors": [], "runs": runs, "notes": [f"croniter, {tzname}"]}


# ---------------- a PDF's text ----------------
def check_pdftext(req: dict, work: Path) -> dict:
    """The text of a PDF (sent as base64 in `input`), page by page, laid out
    as on the page so a table's columns stay columns."""
    import base64
    pdf = work / "in.pdf"
    try:
        pdf.write_bytes(base64.b64decode(req.get("input", ""), validate=False))
    except ValueError:
        return {"ok": False, "errors": [{"message": "input is not base64"}]}
    first, last = int(req.get("first", 1)), int(req.get("last", 0))
    args = ["pdftotext", "-layout", "-f", str(first)] + (["-l", str(last)] if last else [])
    out = run([*args, str(pdf), str(work / "out.txt")], timeout=60)
    if out.returncode:
        return {"ok": False, "errors": [{"message": out.stderr.strip()[:400] or "not a readable PDF"}]}
    text = (work / "out.txt").read_text(errors="replace")
    pages = text.split("\f")
    info = run(["pdfinfo", str(pdf)], timeout=20).stdout
    return {"ok": True, "errors": [], "pages": [p for p in pages if p.strip()][:200],
            "info": dict(l.split(":", 1) for l in info.splitlines() if ":" in l),
            "notes": [f"pdftotext -layout, {len([p for p in pages if p.strip()])} page(s)"]}


KINDS = {"pdftext": check_pdftext, "sql": check_sql, "prisma": check_prisma, "ts": check_ts, "openapi": check_openapi,
         "mermaid": check_mermaid, "regex": check_regex, "cron": check_cron}


def main() -> None:
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        print(json.dumps({"ok": False, "errors": [{"message": f"bad request: {e}", "internal": True}]}))
        return
    kind = req.get("kind")
    if kind not in KINDS:
        print(json.dumps({"ok": False, "errors": [{"message": f"unknown kind {kind!r}; "
                                                   f"one of {sorted(KINDS)}", "internal": True}]}))
        return
    with tempfile.TemporaryDirectory(prefix="check-") as tmp:
        try:
            res = KINDS[kind](req, Path(tmp))
        except subprocess.TimeoutExpired as e:
            res = {"ok": False, "errors": [{"message": f"timed out after {e.timeout:.0f}s"}]}
        except Exception as e:               # report, never a traceback on stdout
            res = {"ok": False, "errors": [{"message": f"{type(e).__name__}: {e}", "internal": True}]}
    res["kind"] = kind
    print(json.dumps(res))


if __name__ == "__main__":
    main()
