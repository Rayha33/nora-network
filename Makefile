PY ?= .venv/bin/python
NORA ?= .venv/bin/nora
# The newest Python 3.11+ on PATH: macOS's own /usr/bin/python3 is too old (3.9).
PYTHON ?= $(shell for p in python3.14 python3.13 python3.12 python3.11 python3; do \
	command -v $$p >/dev/null 2>&1 && $$p -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null \
	&& { echo $$p; break; }; done)

.PHONY: help setup check test test-js lint fix build serve edit live clean

help:             ## list the commands
	@grep -E '^[a-z-]+:.*## ' Makefile | sed 's/:.*## /\t/' | expand -t 12

setup:            ## create .venv and install NORA with its dev tools
	@test -n "$(PYTHON)" || { echo "NORA needs Python 3.11 or newer. Install it (python.org, or 'brew install python') and run make setup again."; exit 1; }
	$(PYTHON) -m venv .venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -e '.[dev]'

check: lint       ## everything CI runs: lint, validate, Python and JS tests, build
	$(NORA) validate
	$(PY) -m pytest -q
	@$(MAKE) --no-print-directory test-js
	$(NORA) build

test:             ## Python tests
	$(PY) -m pytest -q

test-js:          ## JavaScript tests for the browser code (needs Node 20+)
	@if command -v node >/dev/null 2>&1; then node --test tests/js/*.test.mjs; \
	else echo "Skipping the JS tests: install Node 20+ to run them (CI always does)."; fi

lint:             ## ruff lint and format check
	$(PY) -m ruff check .
	$(PY) -m ruff format --check .

fix:              ## auto-format and fix lint
	$(PY) -m ruff format .
	$(PY) -m ruff check --fix .

build:            ## build the site into ./site
	$(NORA) build

serve:            ## build and open the site on http://127.0.0.1:8000
	$(NORA) serve

edit:             ## the site with the network editor saving to data/ (right-click in Flow)
	$(NORA) serve --edit

live:             ## replay the first stream as a live feed on http://127.0.0.1:8765
	$(NORA) live

clean:            ## remove build output and caches
	rm -rf site .pytest_cache .ruff_cache
