"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Fixed, local source only. Assemble into the existing CSP-nonced inline script:
// no dynamic URL/import/eval and no additional browser request on first edit.
const browserModules = [
  ["editor/contact-links", "editor/contact-links.js"],
  ["editor/app-config", "editor/app-config.js"],
  ["planning-calendar", "planning-calendar.js"],
  ["editor/planning-calendar", "editor/planning-calendar.js"],
  ["time-entry-editor", "editor/time-entry.js"],
  ["editor/media-preview", "editor/media-preview.js"],
  ["editor/media-upload", "editor/media-upload.js"],
  ["editor/media-codec", "editor/media-codec.js"],
  ["editor/drafts", "editor/drafts.js"],
  ["editor/task-form", "editor/task-form.js"],
  ["editor/task-dialog", "editor/task-dialog.js"],
  ["editor/task-save", "editor/task-save.js"],
  ["editor/edit-locks", "editor/edit-locks.js"],
  ["editor/worker-billing", "editor/worker-billing.js"],
  ["editor/client-billing", "editor/client-billing.js"],
  ["editor/undo-history", "editor/undo-history.js"],
];
const sources = browserModules.map(([name, file]) => {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  if (/<\/script/i.test(source)) throw new Error("Browser module must not close the inline script");
  return { marker: `/* @indus-module:${name} */`, source };
});

function renderAppShell(template, config = require("./app-config.defaults.json")) {
  template = template.replace("/* @indus-config */ null", () => JSON.stringify(config).replace(/</g, "\\u003c"));
  for (const { marker, source } of sources) {
    if (template.split(marker).length !== 2) throw new Error(`Expected exactly one browser module marker: ${marker}`);
    template = template.replace(marker, () => source);
  }
  return template;
}

module.exports = { renderAppShell };
