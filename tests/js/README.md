# JavaScript tests

These tests load the real app templates — `app.js`, `map.js`, `flow.js` — in a
Node `vm` context with a minimal DOM stub and the committed fixture payload,
so the JavaScript the site ships is exercised on every PR.

## Run

```bash
node --test "tests/js/*.test.mjs"
```

(Quote the glob — `node --test` takes file arguments or a directory, but the
glob is expanded by the shell only when quoted patterns are used portably
across shells.)

## Layout

- `stub.mjs` — minimal DOM/browser stubs (`document`, `matchMedia`,
  `localStorage`, `location`, `history`, `EventSource`, canvas) enough for the
  templates' load-time code. No real browser needed.
- `harness.mjs` — `loadApp()` / `loadPayload()` / `assertHealthy()`: reads each
  template with `fs.readFileSync` and evaluates it in a `vm` context primed
  with the stubs and the fixture payload. `App` is lexical (`const`), so the
  harness reads it back with a second `vm.runInContext("App", ctx)`.
- `fixtures/build_payload.py` — regenerates `fixtures/payload.json` from the
  real `render.py` payload builder; `tests/test_js_harness.py` fails if the
  committed fixture drifts.
- `*.test.mjs` — `node:test` suites.
- `total.test.mjs` — pins the market-total invariant from issue #13.

## Adding a test

Write `tests/js/foo.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, assertHealthy } from "./harness.mjs";

test("something", () => {
  const App = loadApp();
  assertHealthy();
  // App.nodeIds, App.pipeIds, App.register(...) are the public surface
});
```

The JS tests run in CI alongside pytest (see `.github/workflows/ci.yml`,
"JS tests" step).
`app.js` is kept in parts in `src/nora/templates/app/` (issue #50). `harness.mjs`
joins them in the order of `app/order.txt`, as `render.py` does; use `appSource()` or
`templateSource("app.js")` rather than reading a file called app.js.
