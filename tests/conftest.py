from pathlib import Path

import pytest

from nora.data import NODE_COLUMNS, PIPELINE_COLUMNS, load_network

# A five-node network small enough to reason about by hand:
#   gas (60) -> hub -> a_terminal -> market   via pipe_a (cap 40)
#                   -> b_terminal -> market   via pipe_b (cap 30)
NODES = [
    "gas,Gas field,field,NO,60,3,,60,operating,,",
    "hub,Hub,hub,NO,58,2,,,operating,,",
    "a_terminal,Terminal A,terminal,GB,57,-1,,,operating,,",
    "b_terminal,Terminal B,terminal,DE,53,7,,,operating,,",
    "market,Market,market,DE,52,8,,,operating,,",
]
PIPELINES = [
    "feed,Feed,gas,hub,feeder,100,36,100,false,2000,operating,,,",
    "pipe_a,Pipe A,hub,a_terminal,export,300,36,40,false,2000,operating,,,",
    "pipe_b,Pipe B,hub,b_terminal,export,400,36,30,false,2000,operating,,,",
    "a_entry,A entry,a_terminal,market,onshore,,,,false,,operating,,,",
    "b_entry,B entry,b_terminal,market,onshore,,,,false,,operating,,,",
]


def write_network(folder: Path, nodes=NODES, pipelines=PIPELINES) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "nodes.csv").write_text("\n".join([",".join(NODE_COLUMNS), *nodes]) + "\n")
    (folder / "pipelines.csv").write_text(
        "\n".join([",".join(PIPELINE_COLUMNS), *pipelines]) + "\n"
    )
    return folder


@pytest.fixture
def tiny_dir(tmp_path):
    return write_network(tmp_path / "data")


@pytest.fixture
def tiny(tiny_dir):
    return load_network(tiny_dir)


# The same network with a processing plant (capacity 25) between the hub and
# Terminal A, so pipe_a's 40 can no longer be used in full: 25 + 30 = 55.
PLANT_NODES = [
    "gas,Gas field,field,NO,60,3,,60,operating,,",
    "hub,Hub,hub,NO,58,2,,,operating,,",
    "plant,Processing plant,processing,NO,59,5,Gassco,25,operating,,",
    "a_terminal,Terminal A,terminal,GB,57,-1,,,operating,,",
    "b_terminal,Terminal B,terminal,DE,53,7,,,operating,,",
    "market,Market,market,DE,52,8,,,operating,,",
]
PLANT_PIPELINES = [
    "feed,Feed,gas,hub,feeder,100,36,100,false,2000,operating,,,",
    "to_plant,To plant,hub,plant,feeder,50,36,100,false,2000,operating,,,",
    "pipe_a,Pipe A,plant,a_terminal,export,300,36,40,false,2000,operating,,,",
    "pipe_b,Pipe B,hub,b_terminal,export,400,36,30,false,2000,operating,,,",
    "a_entry,A entry,a_terminal,market,onshore,,,,false,,operating,,,",
    "b_entry,B entry,b_terminal,market,onshore,,,,false,,operating,,,",
]


@pytest.fixture
def tiny_plant(tmp_path):
    """The tiny network plus a capacity-limited processing plant on the A route."""
    folder = write_network(tmp_path / "plant_data", PLANT_NODES, PLANT_PIPELINES)
    return load_network(folder)


@pytest.fixture(scope="session")
def north_sea():
    return load_network()
