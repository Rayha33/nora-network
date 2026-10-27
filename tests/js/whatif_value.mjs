/* Cross-check helper (not a test): print the What-if max flow for offline ids
   given on the command line, so pytest can compare it to Python's analyse(). */

import { loadApp } from "./harness.mjs";

const { App } = loadApp();
for (const id of process.argv.slice(2)) App.whatif.toggle(id);
console.log(JSON.stringify(App.whatif.result()));
