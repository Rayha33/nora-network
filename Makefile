PY ?= .venv/bin/python
NORA ?= .venv/bin/nora

.PHONY: setup check test lint fix build serve live clean

setup:            ## create .venv and install NORA with its dev tools
	python3 -m venv .venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -e '.[dev]'

check: lint       ## everything CI runs
	$(NORA) validate
	$(PY) -m pytest -q
	$(NORA) build

test:
	$(PY) -m pytest -q

lint:
	$(PY) -m ruff check .
	$(PY) -m ruff format --check .

fix:              ## auto-format and fix lint
	$(PY) -m ruff format .
	$(PY) -m ruff check --fix .

build:
	$(NORA) build

serve:            ## build and open the site on http://127.0.0.1:8000
	$(NORA) serve

live:             ## replay the first stream as a live feed on http://127.0.0.1:8765
	$(NORA) live

clean:
	rm -rf site .pytest_cache .ruff_cache
