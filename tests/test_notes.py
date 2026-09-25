"""A note is text; what would be fields elsewhere is read out of it."""
from backend import access, notes


def test_the_text_says_what_the_note_is():
    got = notes.read("# Fan noise at 60%\nTry the #pwm curve on @controller, #Fan too\n- [ ] measure\n- [x] log it\n")
    assert got["title"] == "Fan noise at 60%"
    assert got["tags"] == ["fan", "pwm"]                # a heading is not a tag; lower case
    assert got["mentions"] == ["controller"]
    assert got["todo"] == {"open": 1, "done": 1}


def test_a_title_without_markdown():
    assert notes.title_of("\n\n- [ ] buy #parts for the stand") == "buy parts for the stand"
    assert notes.title_of("Check the USB-C footprint #pcb #todo") == "Check the USB-C footprint"
    assert notes.title_of("") == ""


def test_colours_and_anchors_are_not_tags():
    assert notes.read("colour #ff0000 and a/b#c and &#39;")["tags"] == []


def test_reviewers_take_notes_viewers_do_not():
    for m, p in (("POST", "/api/notes"), ("PATCH", "/api/notes/n1"), ("POST", "/api/notes/n1/send")):
        assert access.allowed("reviewer", access.action(m, p)) and not access.allowed("viewer", access.action(m, p))
