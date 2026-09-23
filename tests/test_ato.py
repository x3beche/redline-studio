"""The netlist is the board's artefact, so reading it has to be right.

These run against the real output of `ato build` - the text below was
produced by atopile 0.2.69 from two components and three nets, not
written by hand. A parser tested only on what its author imagined the
format to be is a parser tested on nothing.
"""

from backend import ato

# Trimmed from build/default.net, keeping the shapes that matter: a
# component with its libsource and sheetpath, and nets with one and two
# nodes on them.
REAL = r'''(export (version "E")
  (design
    (source "unknown")
    (date "")
    (tool "atopile"))
  (components
    (comp (ref "U1")
      (value "?")
      (footprint "lib:R0402")
      (libsource (lib "lib") (part "C25744") (description "elec/src/main.ato:R0402"))
      (sheetpath (names "/tmp/x3ato-abc123/elec/src/main.ato:App::r1") (tstamps "8c97"))
      (tstamps "8c97"))
    (comp (ref "U2")
      (value "10k")
      (footprint "lib:C0402")
      (libsource (lib "lib") (part "C1525") (description "elec/src/main.ato:C0402"))
      (sheetpath (names "/tmp/x3ato-abc123/elec/src/main.ato:App::c1") (tstamps "3f85"))
      (tstamps "3f85")))
  (libparts
    (libpart (lib "lib") (part "C25744")
      (description "elec/src/main.ato:R0402")
      (pins
        (pin (num "1") (name "1") (type "stereo")))))
  (nets
    (net (code "1") (name "vcc")
      (node (ref "U1") (pin "1") (pintype "stereo")))
    (net (code "2") (name "p2")
      (node (ref "U2") (pin "1") (pintype "stereo"))
      (node (ref "U1") (pin "2") (pintype "stereo")))
    (net (code "3") (name "gnd")
      (node (ref "U2") (pin "2") (pintype "stereo")))))
'''


def test_the_components_come_out_with_what_identifies_them():
    g = ato.graph(REAL)
    u1, u2 = g["components"]
    assert u1["ref"] == "U1"                  # not the first token, a child
    assert u1["footprint"] == "lib:R0402"
    assert u1["part"] == "C25744"
    assert u2["ref"] == "U2"
    assert u2["value"] == "10k"


def test_a_component_points_back_at_the_line_that_made_it():
    """A mark on a box has to lead somewhere, the way a mark on a face
    leads back to the constant behind it."""
    g = ato.graph(REAL)
    assert g["components"][0]["where"] == "elec/src/main.ato:App::r1"


def test_the_temporary_directory_is_not_part_of_the_answer():
    """Every build runs somewhere else; that path means nothing tomorrow."""
    g = ato.graph(REAL)
    for c in g["components"]:
        assert "/tmp/" not in (c["where"] or "")


def test_nets_keep_every_pin_on_them():
    g = ato.graph(REAL)
    by = {n["name"]: n for n in g["nets"]}
    assert set(by) == {"vcc", "p2", "gnd"}
    assert [(n["ref"], n["pin"]) for n in by["p2"]["nodes"]] \
        == [("U2", "1"), ("U1", "2")]
    assert len(by["vcc"]["nodes"]) == 1


def test_the_counts_are_what_the_room_puts_on_screen():
    g = ato.graph(REAL)
    assert g["counts"] == {"components": 2, "nets": 3, "joins": 4}


def test_libparts_are_not_mistaken_for_components():
    """`libparts` carries (part ...) too, and a loose search finds it."""
    g = ato.graph(REAL)
    assert len(g["components"]) == 2


def test_an_empty_netlist_is_empty_rather_than_an_exception():
    g = ato.graph("(export (version \"E\"))")
    assert g["components"] == [] and g["nets"] == []
    assert g["counts"]["joins"] == 0


def test_quoted_brackets_do_not_break_the_reader():
    text = '(export (components (comp (ref "U(1)") (value "a b"))))'
    g = ato.graph(text)
    assert g["components"][0]["ref"] == "U(1)"
    assert g["components"][0]["value"] == "a b"


# ---------------- the bill ----------------
def test_the_bom_reads_as_rows_of_named_cells():
    csv = "Comment,Designator,Footprint,LCSC,Price\nC25744,U1,R0402,C25744,0.00\n"
    rows = ato.bom(csv)
    assert rows == [{"comment": "C25744", "designator": "U1",
                     "footprint": "R0402", "lcsc": "C25744", "price": "0.00"}]


def test_a_grouped_designator_stays_one_cell():
    """atopile writes two parts of the same kind as one row with a quoted
    designator list. Splitting on commas shifts every column after it."""
    csv = 'Comment,Designator,Footprint,LCSC,Price\nC25744,"U4,U5",R0402,C25744,0.02\n'
    row = ato.bom(csv)[0]
    assert row["designator"] == "U4,U5"
    assert row["footprint"] == "R0402"           # not "U5"
    assert row["lcsc"] == "C25744"
    assert row["price"] == "0.02"


def test_an_empty_bom_is_no_rows_rather_than_a_header():
    assert ato.bom("") == []
    assert ato.bom("Comment,Designator\n") == []


def test_the_project_file_names_the_entry_module():
    """The entry is what the build starts from; getting it wrong builds
    nothing and says little about why."""
    assert "elec/src/main.ato:Board" in ato.PROJECT.format(entry="Board")


# ---------------- parts ----------------
def test_only_an_lcsc_number_is_taken_for_one():
    """A part number is what the footprint and the 3D model are fetched
    by; anything else would send somebody else's API a shrug."""
    from backend import lcsc
    for good in ("C25744", "C1525", "C2827148"):
        assert lcsc.looks_like_a_part(good)
    for bad in ("", None, "R0402", "25744", "C", "C12", "CX1234",
                " C25744 x", "0402"):
        assert not lcsc.looks_like_a_part(bad), bad


def test_a_part_number_with_space_round_it_is_still_one():
    from backend import lcsc
    assert lcsc.looks_like_a_part(" C25744 ".strip())
