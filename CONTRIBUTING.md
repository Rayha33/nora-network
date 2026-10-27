# Contributing to NORA

Everyone is welcome: engineers, analysts, students, and anyone curious about how gas
moves around the North Sea. You do not need to be a programmer, and working with an AI
assistant is encouraged.

## Three ways in

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

## How a change reaches the site

```
branch -> pull request -> CI checks + preview link -> review -> merge -> site updates
```

- **CI** runs lint, data validation, tests and a full build (`make check` locally).
- **Preview**: pull requests from branches in this repository get their own copy of the
  site at `https://rayha33.github.io/nora-network/pr-preview/pr-<number>/`. Pull requests
  from forks get the built site as a downloadable artifact on the CI run instead.
- **Merge**: anything merged to `main` is published within a few minutes.

## Good pull requests

- One idea per pull request, with a sentence on what it changes and where to look.
- New data has a source. Estimates are labelled as estimates.
- Tests pass, and new behaviour comes with a test.
- Keep the chart page a single self-contained file (see AGENTS.md).

## For maintainers

- Invite regular contributors as collaborators (Settings → Collaborators) so their
  branches get preview links.
- `main` is protected: changes arrive through pull requests and need the `checks` job
  to pass. Admins can bypass in an emergency.
