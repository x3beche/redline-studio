"""Routing rules: a person's edits kept, patterns applied, problems named."""
from backend import rules

NETS = ["gnd", "vbus", "v3v3", "dp", "dn", "usb_cc1", "usb_cc2", "led_a", "sw1"]


def test_derive_has_a_list_of_pours():
    r = rules.derive(NETS)
    assert r["pours"][0]["net"] == "gnd"
    assert "pour" not in r
    assert rules.check(r, NETS) == []


def test_old_single_pour_becomes_a_list():
    old = rules.derive(NETS)
    old["pour"] = old.pop("pours")[0]
    fixed = rules.normalise(old)
    assert fixed["pours"][0]["net"] == "gnd" and "pour" not in fixed


def test_pattern_catches_nets_and_merge_leaves_them_to_it():
    r = rules.derive(NETS)
    r["classes"].append({"name": "CC", "track": 0.2, "clearance": 0.2, "via": 0.6,
                         "drill": 0.3, "nets": [], "patterns": ["usb_cc*"]})
    assert sorted(rules.members(r, NETS)["CC"]) == ["usb_cc1", "usb_cc2"]
    merged = rules.merge(r, NETS + ["usb_cc3"])
    assert "usb_cc3" in rules.members(merged, NETS + ["usb_cc3"])["CC"]
    routed = rules.resolved(merged, NETS + ["usb_cc3"])
    assert "usb_cc3" in next(c for c in routed["classes"] if c["name"] == "CC")["nets"]


def test_named_net_beats_a_pattern():
    r = rules.derive(NETS)
    r["classes"].append({"name": "All", "track": 0.3, "clearance": 0.2, "via": 0.6,
                         "drill": 0.3, "nets": [], "patterns": ["*"]})
    got = rules.members(r, NETS)
    assert "vbus" in got["Power"] and "vbus" not in got["All"]
    assert "led_a" in got["All"]


def test_a_pair_left_in_default_gets_its_own_class_to_route():
    r = rules.derive(NETS)
    r["pairs"].append({"name": "LED", "p": "led_a", "n": "sw1", "width": 0.3, "gap": 0.2})
    assert rules.check(r, NETS) == []
    routed = rules.resolved(r, NETS)
    led = next(c for c in routed["classes"] if c["name"] == "LED")
    assert led["track"] == 0.3 and set(led["nets"]) == {"led_a", "sw1"}


def test_problems_name_their_field():
    r = rules.derive(NETS)
    r["classes"][1]["track"] = 0.05
    r["classes"].append(dict(rules.SCHEMA["classes"]["new"]))
    r["pairs"].append({"name": "X", "p": "dp", "n": "dp", "width": 0.2, "gap": 0.15})
    r["pours"].append({"net": "nope", "layers": [], "clearance": 0.3, "connection": "solid"})
    got = "\n".join(rules.check(r, NETS))
    assert "classes.Power.track:" in got
    assert "classes.#4.name: a class needs a name" in got
    assert "pairs.X: the two halves are the same net" in got
    assert "pours.nope.net: nope is not a net" in got
    assert "pours.nope.layers: pour on at least one layer" in got


def test_default_cannot_go():
    r = rules.derive(NETS)
    r["classes"] = r["classes"][1:]
    assert any("Default" in p for p in rules.check(r, NETS))


def test_every_schema_section_has_fields():
    for key, section in rules.SCHEMA.items():
        assert section["fields"], key
        if section["list"]:
            assert set(section["new"]) >= {f["key"] for f in section["fields"]}


def test_a_class_wider_than_a_pad_it_reaches_is_a_problem_not_a_fix():
    r = rules.derive(NETS)
    pads = {"v3v3": {"width": 0.36, "who": "U24 pad 5"}}
    got = rules.check(r, NETS, pads)
    assert any(p.startswith("classes.Power.track:") and "U24 pad 5" in p for p in got)
    r["classes"][1]["track"] = 0.36
    assert rules.check(r, NETS, pads) == []


def test_pours_carry_their_edge_gap():
    old = rules.derive(NETS)
    del old["pours"][0]["edge"]
    assert rules.normalise(old)["pours"][0]["edge"] == rules.SCHEMA["pours"]["new"]["edge"]
