/* Cross-check helper (not a test): print the data files the editor saves for the steps
   in edits.mjs, so pytest can load them with NORA's own validation. */

import { editedApp } from "./edits.mjs";

console.log(JSON.stringify(editedApp().App.edit.files()));
