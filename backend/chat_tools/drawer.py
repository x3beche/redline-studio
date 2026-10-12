"""drawer: the parts drawer and LCSC, as one tool - search and list the
drawer, search LCSC, add a part, get and read its datasheet. Each action is
its own module here (drawer_search.py ... datasheet_read.py, their `PART`);
this file only groups them (`group` in __init__.py)."""

from __future__ import annotations

from . import group
from . import datasheet_get, datasheet_read, drawer_add, drawer_list, drawer_search, lcsc_search

TOOL = group(
    "drawer", label="Parts drawer", order=10,
    about="The parts drawer and LCSC: search and list the drawer, search LCSC, add a part, get and read its datasheet.",
    intro="This workspace's parts drawer and LCSC's catalogue, in one tool.",
    actions={"search": drawer_search.PART, "list": drawer_list.PART, "lcsc": lcsc_search.PART,
             "add": drawer_add.PART, "datasheet_get": datasheet_get.PART, "datasheet_read": datasheet_read.PART})
