"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildImportPlan, privateReason } = require("../scripts/import-ics-calendar");

test("ICS importer separates private events and preserves valid timed work events", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:work-1",
    "DTSTART:20260707T080000",
    "DTEND:20260707T093000",
    "SUMMARY:Servis crpalke",
    "DESCRIPTION:Preveri tesnilo",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:private-1",
    "DTSTART;VALUE=DATE:20260708",
    "DTEND;VALUE=DATE:20260709",
    "SUMMARY:Berta bd",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
  const plan = buildImportPlan(ics, { from: "2026-07-01", to: "2031-06-30" });
  assert.equal(plan.imported.length, 1);
  assert.equal(plan.ignored.length, 1);
  assert.equal(plan.imported[0].start, "08:00");
  assert.equal(plan.imported[0].end, "09:30");
  assert.equal(plan.imported[0].notes, "Preveri tesnilo");
  assert.match(plan.ignored[0].reason, /rojstni/);
  assert.match(privateReason("Dopust na morju"), /dopust/);
});

test("ICS importer excludes a recurring private birthday in every in-range year", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:private-recurring",
    "DTSTART;VALUE=DATE:20250710",
    "DTEND;VALUE=DATE:20250711",
    "RRULE:FREQ=YEARLY;COUNT=8",
    "SUMMARY:Oli bd",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
  const plan = buildImportPlan(ics, { from: "2026-07-01", to: "2031-06-30" });
  assert.equal(plan.imported.length, 0);
  assert.equal(plan.ignored.length, 5);
});