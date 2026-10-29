"""app.js in parts (issue #50): templates/app/*.js, joined in the order of order.txt into
one script inside one IIFE. The list and the files on disk must match, and the joined
script must open and close the app's scope exactly once."""

from nora.render import TEMPLATES, app_files, app_js

PARTS = TEMPLATES / "app"


def test_the_list_and_the_files_on_disk_match():
    listed = app_files()
    assert len(listed) == len(set(listed)), "a part listed twice"
    on_disk = sorted(p.name for p in PARTS.glob("*.js"))
    assert sorted(listed) == on_disk, "order.txt and templates/app/*.js differ"


def test_the_parts_join_into_one_scope():
    script = app_js()
    assert script.count("const App = (() => {") == 1
    assert script.startswith("/*") and script.rstrip().endswith("})();")
    first, last = (PARTS / name for name in (app_files()[0], app_files()[-1]))
    assert "const App = (() => {" in first.read_text(encoding="utf-8"), f"{first.name} opens it"
    assert last.read_text(encoding="utf-8").rstrip().endswith("})();"), f"{last.name} closes it"


def test_no_section_is_cut_in_two():
    seam = "  // ------------------------------------------------------------------ "
    for name in app_files()[1:]:
        text = (PARTS / name).read_text(encoding="utf-8")
        assert text.startswith(seam), f"{name} starts at a section"
