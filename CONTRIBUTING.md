# Contributing to NORA

Everyone is welcome: engineers, analysts, students, and anyone curious about how gas
moves around the North Sea. You do not need to be a programmer, and working with an AI
assistant is encouraged.

## Three ways in

### The five-minute local path

```bash
git clone https://github.com/Rayha33/nora-network.git
cd nora-network
make setup
make check
make serve
```

`make serve` builds and opens the app locally. Start with the data files for network
corrections (`data/nodes.csv`, `data/pipelines.csv`), `data/streams/` for readings and
replay configuration, or `nora.toml` for display and alarm thresholds. Feature code is
under `src/nora/`; [AGENTS.md](AGENTS.md) maps the modules and their boundaries. Run
`make check` before opening a pull request.

### 1. Fix or add data, in the browser

1. Open [`data/nodes.csv`](data/nodes.csv) or [`data/pipelines.csv`](data/pipelines.csv) on GitHub and press the pencil icon.
2. Make the change and put a link to your source in the `source` column.
3. Choose **Propose changes**. GitHub opens a pull request for you.

The checks tell you within a minute if something does not fit (with the line number),
and a preview link of the chart with your change is posted on the pull request.
Column meanings are in [data/README.md](data/README.md).

### 2. Build a feature with an AI assistant

1. Press **Code → Codespaces → Create codespace** on the repository page
   (or clone it and run `make setup`).
2. Ask your assistant for the change. It will find [AGENTS.md](AGENTS.md), which explains
   how NORA fits together and the rules that keep it working.
3. Run `make check` and `make serve` to see the result.
4. Commit to a branch and open a pull request.

Good first tasks are labelled
[good first issue](https://github.com/Rayha33/nora-network/labels/good%20first%20issue).

### 3. Suggest something

Open an [issue](https://github.com/Rayha33/nora-network/issues/new/choose) for a data
correction, an idea or a bug, or start a
[discussion](https://github.com/Rayha33/nora-network/discussions).

## Fork, clone, and keep your copy current

You can run NORA from a direct clone. To propose changes without collaborator access,
fork it first on GitHub, then clone your fork:

```bash
gh repo fork Rayha33/nora-network --clone
cd nora-network
make setup
make check
```

Without the GitHub CLI, press **Fork** on the repository page, then use your own GitHub
username:

```bash
git clone https://github.com/YOUR-USERNAME/nora-network.git
cd nora-network
git remote add upstream https://github.com/Rayha33/nora-network.git
make setup
```

Create a branch for each change, push it to your fork, and open a pull request against
`Rayha33/nora-network:main`. To update your fork later:

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
```

## How a change reaches the site

```
branch -> pull request -> CI checks + built site -> review -> merge -> site updates
```

- **CI** runs lint, data validation, tests and a full build (`make check` locally).
- **Preview**: every pull request's CI run keeps the built site as a downloadable
  artifact; `make serve` shows it locally. There are no hosted preview sites.
- **Merge**: anything merged to `main` is published at https://factorlab.app/nora-network/
  within about 10 minutes.

## Good pull requests

- One idea per pull request, with a sentence on what it changes and where to look.
- New data has a source. Estimates are labelled as estimates.
- Tests pass, and new behaviour comes with a test.
- Keep the chart page a single self-contained file (see AGENTS.md).

## For maintainers

- Invite regular contributors as collaborators (Settings → Collaborators) so their
  branches get preview links. External contributors can always fork and open a pull request.
- `main` is protected by repository rules: changes arrive through pull requests and need
  the `checks` job to pass. Administrators can bypass in an emergency.
