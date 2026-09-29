"""Checks a message against messages.schema.json (SPEC section 1).

jsonschema is not in the venv, so this walks the schema file itself with
the few keywords it uses: type, required, properties, const, enum,
minimum, maximum, minLength, pattern and local $ref. The schema file is
the one source; nothing here repeats it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

SCHEMA = json.loads((Path(__file__).with_name("messages.schema.json")).read_text())
TYPES = {"string": str, "boolean": bool, "object": dict, "array": list}


def _is(value, kind: str) -> bool:
    if kind in ("integer", "number") and isinstance(value, bool):
        return False
    if kind == "integer":
        return isinstance(value, int) or (isinstance(value, float) and value.is_integer())
    if kind == "number":
        return isinstance(value, (int, float))
    return isinstance(value, TYPES[kind])


def _check(value, rule: dict, where: str) -> list[str]:
    if "$ref" in rule:
        rule = SCHEMA["$defs"][rule["$ref"].rsplit("/", 1)[1]]
    kinds = rule.get("type")
    if kinds and not any(_is(value, k) for k in ([kinds] if isinstance(kinds, str) else kinds)):
        return [f"{where}: expected {kinds}, got {value!r}"]
    errors = []
    if "const" in rule and value != rule["const"]:
        errors.append(f"{where}: must be {rule['const']!r}")
    if "enum" in rule and value not in rule["enum"]:
        errors.append(f"{where}: must be one of {rule['enum']}")
    if "minimum" in rule and value < rule["minimum"]:
        errors.append(f"{where}: below {rule['minimum']}")
    if "maximum" in rule and value > rule["maximum"]:
        errors.append(f"{where}: above {rule['maximum']}")
    if "minLength" in rule and len(value) < rule["minLength"]:
        errors.append(f"{where}: too short")
    if "pattern" in rule and not re.search(rule["pattern"], value):
        errors.append(f"{where}: does not match {rule['pattern']}")
    for key in rule.get("required", []):
        if key not in value:
            errors.append(f"{where}: missing {key!r}")
    for key, sub in rule.get("properties", {}).items():
        if isinstance(value, dict) and key in value:
            errors += _check(value[key], sub, f"{where}.{key}" if where else key)
    return errors


def validate(msg) -> list[str]:
    """What is wrong with a message; an empty list when nothing is."""
    if not isinstance(msg, dict):
        return ["a message is a JSON object"]
    kind = msg.get("type")
    if f"#/$defs/{kind}" not in {r["$ref"] for r in SCHEMA["oneOf"]}:
        return [f"unknown type {kind!r}"]
    return _check(msg, {"$ref": f"#/$defs/{kind}"}, "")
