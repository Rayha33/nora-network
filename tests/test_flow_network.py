"""The Flow view's vis-network: what pyvis hands the page."""

from nora.render import _flow_view


def test_no_hover_popup_on_nodes_or_lines(north_sea):
    """Ray, 29 Oct, of the hover box ("Johan Sverdrup / 4.6 MSm³/d / 152 bar"): "this
    mouse over popup window is useless and is just standing in the way"."""
    view = _flow_view(north_sea)
    assert view.nodes and view.edges
    assert not [n["id"] for n in view.nodes if "title" in n]
    assert not [e["id"] for e in view.edges if "title" in e]
