/* Which feeds ?live= may connect to (review, 29 Oct). The public site took any URL,
   so a link such as network.html?live=https://example.invalid/stream showed someone
   else's numbers and alarms as NORA's "(live)" data. A feed must come from the site
   itself (`nora live` serves both) or from this computer. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

class RecordingEventSource {
  static opened = [];
  constructor(url) { this.url = url; RecordingEventSource.opened.push(url); }
  addEventListener() {}
  close() {}
}

function start(live) {
  RecordingEventSource.opened = [];
  const loaded = loadApp({ search: `?live=${encodeURIComponent(live)}`, globals: { EventSource: RecordingEventSource } });
  loaded.document.getElementById("speed").options = [{ value: "60" }];
  loaded.document.getElementById("speed").parentElement = { hidden: false };
  loaded.App.start();
  return loaded;
}

test("a feed on another site is refused: the page plays its own data instead", () => {
  for (const url of ["https://example.invalid/stream", "//example.invalid/stream", "javascript:alert(1)"]) {
    const { App } = start(url);
    assert.deepEqual(RecordingEventSource.opened, [], `${url} was connected`);
    assert.equal(App.live.feed, null);
    assert.ok(App.live.stream, "the recorded data plays");
  }
});

test("a feed from the site itself or from this computer connects", () => {
  // The test page is at http://localhost/ (the stub's location).
  for (const [url, want] of [
    ["/stream", "http://localhost/stream"],
    ["http://localhost:8765/stream", "http://localhost:8765/stream"],
    ["http://127.0.0.1:8765/stream", "http://127.0.0.1:8765/stream"],
  ]) {
    const { App } = start(url);
    assert.deepEqual(RecordingEventSource.opened, [want], url);
    assert.ok(App.live.feed);
  }
});
