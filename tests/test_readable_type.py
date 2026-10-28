"""Ray's type rule for the Flow view's own labels: never smaller than 11 px."""

from nora.render import FLOW_OPTIONS


def test_flow_line_labels_are_at_least_11px():
    assert FLOW_OPTIONS["edges"]["font"]["size"] >= 11
    assert FLOW_OPTIONS["nodes"]["font"]["size"] >= 11
