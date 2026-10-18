const base = require("./playwright.config.cjs");

// Firefox retargets the compatibility click differently when a pointerup
// closes a dialog. Keep this regression gate in addition to Chromium E2E.
module.exports = {
  ...base,
  testMatch: ["day-timeline-open.spec.cjs", "project-hours-existing.spec.cjs", "todo-october-18.spec.cjs"],
  outputDir: "test-results/firefox",
  use: { ...base.use, browserName: "firefox" }
};
