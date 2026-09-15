"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Fixed, local source only. Assemble into the existing CSP-nonced inline script:
// no dynamic URL/import/eval and no additional browser request on first edit.
const marker = "/* @indus-module:time-entry-editor */";
const editorSource = fs.readFileSync(path.join(__dirname, "editor", "time-entry.js"), "utf8");
if (/<\/script/i.test(editorSource)) throw new Error("Editor module must not close the inline script");

function renderAppShell(template) {
  if (template.split(marker).length !== 2) throw new Error("Expected exactly one time-entry editor module marker");
  return template.replace(marker, () => editorSource);
}

module.exports = { renderAppShell };
