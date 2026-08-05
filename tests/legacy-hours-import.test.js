"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildImportPlan } = require("../scripts/import-legacy-hours");

test("legacy hours import is complete, dated consistently, and reversible-plan safe", () => {
  const plan = buildImportPlan();
  assert.equal(plan.entries.length, 83);
  assert.deepEqual(plan.skipped.map((item) => item.alias.toLocaleLowerCase("sl")), ["češnar"]);
  assert.equal(Math.max(...plan.entries.map((item) => item.hours)), 10);
  assert.ok(plan.entries.every((item) => item.date && item.start && item.end && ["bojan", "ibro"].includes(item.assignee)));

  const unnamedDate = plan.entries.find((item) => item.source.toLocaleLowerCase("sl").startsWith("beno: varistorji"));
  assert.equal(unnamedDate.alias, "Beno Štern");
  assert.equal(unnamedDate.date, "2026-08-05");
  assert.match(unnamedDate.notes, /datum ni pravi/);

  const repeat = plan.entries.filter((item) => item.source.includes("2x10h"));
  assert.equal(repeat.length, 2);
  assert.ok(repeat.every((item) => item.hours === 10));

  const pair = plan.entries.filter((item) => item.source.includes("vsak po 9h"));
  assert.deepEqual(pair.map((item) => item.assignee).sort(), ["bojan", "ibro"]);

  const noHours = plan.entries.find((item) => item.source.startsWith("avio:"));
  assert.equal(noHours.hours, 1);
  assert.match(noHours.notes, /podatek o urah/);
});
