"""A long conversation draws its last lines only, more as the reader scrolls up.

The owner's Chat room got heavy and its scrolling slow on a long thread:
every answer was on the page, with its maths, code and pictures. Now an
AI conversation (rooms/commandcode.ts) and a room's agent thread
(rooms/agent-thread.ts) draw the last 20 (rooms/log-window.ts), 20 more
each time the top is reached, with the line on screen kept in place; a
line asked for above them (a search hit, a queued note's link) widens
what is shown. These read the page's source, as the other page tests do.
"""
import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "frontend/src/app"
WIN = (APP / "rooms/log-window.ts").read_text()
CC = (APP / "rooms/commandcode.ts").read_text()
TH = (APP / "rooms/agent-thread.ts").read_text()


def test_the_window_is_twenty_and_grows_by_twenty_from_the_end():
    assert "export const LOG_STEP = 20;" in WIN
    assert "Math.max(0, total - this.size())" in WIN
    assert "this.size.update(n => n + LOG_STEP)" in WIN
    # The row on screen is measured before and after, and the scroll moved by the difference.
    assert "anchor.getBoundingClientRect().top - top0" in WIN
    assert "el.scrollTop += d" in WIN


def test_the_conversation_draws_the_window_not_every_line():
    assert re.search(r"@for \(m of shown\(\); track m\.id; let j = \$index", CC)
    assert "@for (m of messages();" not in CC
    # Index-based helpers still get the line's place in the whole conversation.
    assert "@let i = j + shownFrom();" in CC
    assert "this.win.scrolled(this.messages().length)" in CC


def test_a_new_conversation_starts_at_its_last_twenty():
    body = CC[CC.index("  open(id: string"):]
    assert "this.win.reset();" in body[:300]
    new = CC[CC.index("this.api.create().subscribe"):]
    assert "this.win.reset();" in new[:300]


def test_a_search_hit_above_the_window_is_brought_in():
    body = CC[CC.index("  private scrollTo(mid: string)"):]
    assert "this.win.include(this.messages().findIndex(m => m.id === mid)" in body[:300]


def test_the_room_thread_is_windowed_too():
    assert re.search(r"@for \(it of shown\(\); track it\.key; let j = \$index", TH)
    assert "@let i = j + shownFrom();" in TH
    assert '(scroll)="win.scrolled(items().length)"' in TH
    assert "this.win.reset(); this.load(true);" in TH
    assert "this.win.include(l.findIndex(x => x.m?._id === at), l.length);" in TH
