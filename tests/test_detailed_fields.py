"""Zoomed-in North Sea field detail uses real SODIR-backed topology."""

from nora.data import load_network

FIELDS = {
    "mikkel",
    "morvin",
    "trestakk",
    "smorbukk_nord",
    "skarv",
    "draugen",
    "aerfugl",
    "tordis",
    "gullfaks_sor",
}

LINKS = {
    "mikkel_asgard": ("mikkel", "asgard"),
    "morvin_asgard": ("morvin", "asgard"),
    "trestakk_asgard": ("trestakk", "asgard"),
    "smorbukk_nord_asgard": ("smorbukk_nord", "asgard"),
    "skarv_asgard_t": ("skarv", "asgard_t"),
    "draugen_asgard_t": ("draugen", "draugen_t"),
    "aerfugl_skarv": ("aerfugl", "skarv"),
    "tordis_gullfaks": ("tordis", "gullfaks"),
    "gullfaks_sor_gullfaks": ("gullfaks_sor", "gullfaks"),
    "asgard_transport_inlet": ("asgard", "asgard_t"),
    "asgard_transport_upper": ("asgard_t", "draugen_t"),
    "asgard_transport": ("draugen_t", "karsto"),
}


def test_missing_asgard_and_statpipe_fields_are_present_without_double_supply():
    net = load_network()
    nodes = net.node_by_id
    assert nodes.keys() >= FIELDS
    for field in FIELDS:
        assert nodes[field].type == "field"
        assert nodes[field].map_min_zoom == 5.5
        # Their production remains inside the existing aggregate area supply. Adding
        # geographic detail must not add it to the deliverable total a second time.
        assert nodes[field].capacity_msm3d == 0


def test_new_feeders_use_real_destinations_and_asgard_transport_tees():
    net = load_network()
    pipes = net.pipeline_by_id
    for pid, ends in LINKS.items():
        assert pid in pipes
        assert (pipes[pid].from_id, pipes[pid].to_id) == ends
