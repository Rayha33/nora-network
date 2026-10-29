import pytest

from nora.data import DataError, Node, load_network

from .conftest import NODES, PIPELINES, write_network


def problems_for(tmp_path, nodes=NODES, pipelines=PIPELINES) -> list[str]:
    with pytest.raises(DataError) as caught:
        load_network(write_network(tmp_path / "data", nodes, pipelines))
    return caught.value.problems


def test_the_north_sea_data_is_valid(north_sea):
    # Trimmed to what a North Sea operator watches (Ray, 29 Oct): 40 nodes, 40 lines
    assert len(north_sea.nodes) >= 35
    assert len(north_sea.pipelines) >= 35


def test_every_pipeline_connects_known_nodes(north_sea):
    ids = {node.id for node in north_sea.nodes}
    for pipe in north_sea.pipelines:
        assert pipe.from_id in ids and pipe.to_id in ids


def test_typo_in_a_node_reference_suggests_the_fix(tmp_path):
    broken = [PIPELINES[0].replace("gas,hub", "gas,hbu"), *PIPELINES[1:]]
    [problem] = problems_for(tmp_path, pipelines=broken)
    assert "pipelines.csv line 2" in problem
    assert "did you mean 'hub'" in problem


def test_all_problems_are_reported_at_once(tmp_path):
    nodes = [NODES[0].replace(",field,", ",feild,"), NODES[1].replace(",58,", ",158,"), *NODES[2:]]
    problems = problems_for(tmp_path, nodes=nodes)
    assert any("did you mean 'field'" in p for p in problems)
    assert any("'lat' must be -90 to 90" in p for p in problems)


def test_duplicate_ids_point_to_the_first_use(tmp_path):
    problems = problems_for(tmp_path, nodes=[*NODES, NODES[1]])
    assert any("already used on nodes.csv line 3" in p for p in problems)


def test_a_field_needs_a_capacity(tmp_path):
    nodes = [NODES[0].replace(",60,operating", ",,operating"), *NODES[1:]]
    assert any("needs 'capacity_msm3d'" in p for p in problems_for(tmp_path, nodes=nodes))


def test_parallel_lines_must_be_one_row(tmp_path):
    duplicate = PIPELINES[1].replace("pipe_a,Pipe A", "pipe_a2,Pipe A2")
    problems = problems_for(tmp_path, pipelines=[*PIPELINES, duplicate])
    assert any("already modelled" in p for p in problems)


def test_unquoted_comma_is_explained(tmp_path):
    nodes = [*NODES[:-1], "market,Market, big,market,DE,52,8,,,operating,,,,,,"]
    assert any("wrap text containing commas" in p for p in problems_for(tmp_path, nodes=nodes))


def test_a_node_is_active_between_startup_and_retirement():
    node = Node(
        id="x",
        name="X",
        type="field",
        country="NO",
        lat=60,
        lon=3,
        operator="",
        capacity_msm3d=1.0,
        status="operating",
        startup=1990,
        shutdown=2010,
        source="",
        notes="",
        line=1,
    )
    assert not node.active_in(1989)
    assert node.active_in(1990)
    assert node.active_in(2009)
    assert not node.active_in(2010)  # the first year it was gone

    timeless = Node(
        id="y",
        name="Y",
        type="field",
        country="NO",
        lat=60,
        lon=3,
        operator="",
        capacity_msm3d=1.0,
        status="operating",
        startup=None,
        shutdown=None,
        source="",
        notes="",
        line=1,
    )
    assert timeless.active_in(1900)
    assert timeless.active_in(2100)


def test_nodes_in_year_filters_and_sorts(tmp_path):
    nodes = [
        "gas,Gas field,field,NO,60,3,,60,operating,1990,,test/",
        "hub,Hub,hub,NO,58,2,,,operating,,,test/",
        "a_terminal,Terminal A,terminal,GB,57,-1,,,operating,,,test/",
        "b_terminal,Terminal B,terminal,DE,53,7,,,operating,,,test/",
        "market,Market,market,DE,52,8,,,operating,,,test/",
        "future,Future field,field,NO,61,4,,10,planned,2030,,test/",
        "old,Old field,field,NO,59,2,,5,decommissioned,1970,1990,test/",
    ]
    network = load_network(write_network(tmp_path / "data", nodes=nodes))
    timeless = ["a_terminal", "b_terminal", "hub", "market"]
    assert [n.id for n in network.nodes_in_year(1985)] == [*timeless, "old"]
    assert [n.id for n in network.nodes_in_year(1995)] == [
        "a_terminal",
        "b_terminal",
        "gas",
        "hub",
        "market",
    ]
    assert [n.id for n in network.nodes_in_year(2026)] == [
        "a_terminal",
        "b_terminal",
        "gas",
        "hub",
        "market",
    ]
    assert [n.id for n in network.nodes_in_year(2031)] == [
        "a_terminal",
        "b_terminal",
        "future",
        "gas",
        "hub",
        "market",
    ]


def test_retirement_year_before_startup_is_explained(tmp_path):
    nodes = [*NODES, "old,Old field,field,NO,59,2,,5,decommissioned,1990,1970,test/"]
    assert any(
        "'shutdown' = 1970 is before 'startup' = 1990" in p
        for p in problems_for(tmp_path, nodes=nodes)
    )


def test_norpipe_runs_from_draupner_s_to_npt_with_ekofisk_tied_in(north_sea):
    """Ray, 29 Oct (his Area D screen): "the line should go directly from DRP S to NPT
    (Nordpipe Terminal) and then have Ekofisk being connected on to that pipeline
    somewhere along it"."""
    lines = {p.id: p for p in north_sea.pipelines}
    tee = north_sea.node_by_id["ekofisk_tee"]
    assert tee.type == "tee"
    assert (lines["statpipe_ekofisk"].from_id, lines["statpipe_ekofisk"].to_id) == (
        "draupner_s",
        "ekofisk_tee",
    )
    assert (lines["norpipe"].from_id, lines["norpipe"].to_id) == ("ekofisk_tee", "emden")
    assert (lines["ekofisk_tie_in"].from_id, lines["ekofisk_tie_in"].to_id) == (
        "ekofisk",
        "ekofisk_tee",
    )
    assert north_sea.node_by_id["baltic_tie"].type == "tee", "the Baltic Pipe tie-in is one too"


def test_heimdal_is_a_t_on_heimskringla_from_oseberg_to_st_fergus_and_draupner(north_sea):
    """Ray, 29 Oct: "there is no Heimdal anymore, it is just a T connection now and the
    line is called Heimskringla going from Oseberg to St. Fergus and Draupner"."""
    tee = north_sea.node_by_id["heimdal"]
    assert tee.type == "tee" and tee.name == "Heimskringla tie-in"
    lines = {p.id: p for p in north_sea.pipelines}
    legs = {p.id: p for p in north_sea.pipelines if p.from_id == "heimdal" or p.to_id == "heimdal"}
    # Gassco's schematic (#38): Grane takes gas at the T, and each leg has a tie-in on it
    # (Mariner on the St Fergus leg, Jotun on the Draupner leg) before it lands.
    assert {(p.from_id, p.to_id) for p in legs.values()} == {
        ("oseberg", "heimdal"),
        ("heimdal", "mariner_tee"),
        ("heimdal", "jotun_tee"),
        ("heimdal", "grane"),
    }
    assert (lines["vesterled"].from_id, lines["vesterled"].to_id) == ("mariner_tee", "st_fergus")
    assert (lines["statpipe_heimdal"].from_id, lines["statpipe_heimdal"].to_id) == (
        "jotun_tee",
        "draupner_s",
    )
    heimskringla = [p for p in legs.values() if p.id != "grane_gas_import"]
    heimskringla += [lines["vesterled"], lines["statpipe_heimdal"]]
    assert all(p.name.startswith("Heimskringla") for p in heimskringla)


def test_gassco_schematic_fields_join_at_their_real_tie_ins(north_sea):
    """Issue #38: each field from Gassco's schematic joins where SODIR, NSTA or the
    operator says it does, and every new row cites its source."""
    lines = {p.id: p for p in north_sea.pipelines}
    nodes = north_sea.node_by_id
    expected = {
        "gina_krog_sleipner": ("gina_krog", "sleipner"),
        "ivar_aasen_edvard_grieg": ("ivar_aasen", "edvard_grieg"),
        "dvalin_gas": ("dvalin", "dvalin_tee"),
        "polarled_north": ("aasta_hansteen", "dvalin_tee"),
        "polarled": ("dvalin_tee", "nyhamna"),
        "valhall_norpipe": ("valhall", "ekofisk_tee"),
        "jotun_gas": ("jotun", "jotun_tee"),
        "martin_linge_gas": ("martin_linge", "fuka_tee"),
        "fuka": ("fuka_tee", "st_fergus"),
        "mariner_gas_import": ("mariner_tee", "mariner"),
        "grane_gas_import": ("heimdal", "grane"),
    }
    for pid, ends in expected.items():
        assert (lines[pid].from_id, lines[pid].to_id) == ends, pid
        assert lines[pid].source.startswith("https://"), pid
        for node in ends:
            assert nodes[node].source.startswith("https://"), node
    for tee in ("dvalin_tee", "jotun_tee", "fuka_tee", "mariner_tee"):
        assert nodes[tee].type == "tee"
    # Mariner and Grane take gas (fuel, injection); they are neither supply nor exit.
    assert nodes["mariner"].capacity_msm3d == nodes["grane"].capacity_msm3d == 0


def test_the_southern_north_sea_fields_and_bacton_are_gone(north_sea):
    """Ray, 29 Oct: "remove" (the Southern North Sea fields), then "remove bacton". The IUK
    interconnector, which ran from Bacton to Zeebrugge, went with it; Zeebrugge stays."""
    ids = {n.id for n in north_sea.nodes} | {p.id for p in north_sea.pipelines}
    assert not ids & {"sns_fields", "sns_bacton", "bacton", "iuk"}
    assert {"zeebrugge", "zeepipe_1"} <= ids
