"""The Analytics room's per-note figures are the note cards' figures.

The cards cost a note by who did the work (backend/usage.py for_revision:
the calls of the agents that held it and the sub-agents they started) and
say when that could not be told ("approximate"). The room used to add up
every call made while a note's run was open - another agent working at
the same time was billed to it - so the two disagreed. Now note_costs,
top_notes and the per-project split take the cards' numbers.
"""

from __future__ import annotations

from backend import insights

LO, HI = "2026-10-01T00:00:00+00:00", "2026-10-08T00:00:00+00:00"


def doc(rid, cost, calls=3, finished="2026-10-05T10:00:00+00:00", approximate=False):
    return {"_id": rid, "started_at": "2026-10-05T09:00:00+00:00", "finished_at": finished,
            "totals": {"calls": calls, "cost_usd": cost, "billed_tokens": 1000, "thinking": 5},
            "attribution": {"method": "window" if approximate else "agent",
                            "approximate": approximate}}


def run(rid, started="2026-10-05T09:00:00+00:00", finished="2026-10-05T10:00:00+00:00"):
    return {"_id": rid, "revision": rid, "started_at": started, "finished_at": finished}


def test_a_note_costs_what_its_card_says_not_its_window():
    window = {"n1": {"calls": 40, "cost_usd": 9.0, "tokens": 1}}      # others' calls too
    got = insights.note_attribution([doc("n1", 1.25)], window, [run("n1")], LO, HI)
    assert got["n1"] == {"calls": 3, "cost_usd": 1.25, "tokens": 1005,
                         "approximate": False, "method": "agent"}


def test_the_approximate_flag_travels_and_a_note_without_figures_is_approximate():
    window = {"n2": {"calls": 4, "cost_usd": 0.5, "tokens": 9},
              "n3": {"calls": 2, "cost_usd": 0.2, "tokens": 3}}
    got = insights.note_attribution(
        [doc("n1", 1.0, approximate=True)], window,
        [run("n1"), run("n2"), run("n3", finished="2026-09-01T00:00:00+00:00")], LO, HI)
    assert got["n1"]["approximate"] is True
    assert got["n2"] == {"calls": 4, "cost_usd": 0.5, "tokens": 9, "approximate": True,
                         "method": "window"}
    assert "n3" not in got                              # its work finished before the range


def test_a_note_is_in_the_range_its_work_finished_in_or_while_it_runs():
    docs = [doc("old", 5.0, finished="2026-09-20T00:00:00+00:00"),
            doc("live", 0.3, finished=None)]
    got = insights.note_attribution(docs, {}, [], LO, HI)
    assert set(got) == {"live"}


def test_projects_are_their_notes_and_the_rest_is_no_note():
    by_note = {"a1": {"calls": 3, "cost_usd": 1.0, "approximate": False},
               "a2": {"calls": 2, "cost_usd": 0.5, "approximate": True},
               "b1": {"calls": 1, "cost_usd": 0.25, "approximate": False}}
    proj = {"a1": "alpha", "a2": "alpha", "b1": "beta"}.get
    got = insights.project_attribution(by_note, proj, {"cost_usd": 2.0, "calls": 10})
    assert got["alpha"] == {"calls": 5, "cost_usd": 1.5, "approximate": True}
    assert got["beta"]["approximate"] is False
    assert got["(no note)"]["calls"] == 4 and abs(got["(no note)"]["cost_usd"] - 0.25) < 1e-9
    # A note's whole run can reach outside the range: never a negative rest.
    got = insights.project_attribution(by_note, proj, {"cost_usd": 1.0, "calls": 2})
    assert "(no note)" not in got


def test_the_shape_moved_on():
    assert insights.SHAPE >= 7
