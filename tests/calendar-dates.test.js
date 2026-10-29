"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isoWeek, workFreeHoliday } = require("../outputs/calendar-dates");

test("ISO weeks belong to their Thursday, including year boundaries and DST", () => {
  for (const [key, year, week] of [
    ["2020-12-28", 2020, 53], ["2021-01-03", 2020, 53], ["2021-01-04", 2021, 1],
    ["2024-12-30", 2025, 1], ["2026-01-01", 2026, 1], ["2026-10-26", 2026, 44],
    ["2026-12-31", 2026, 53], ["2027-01-01", 2026, 53], ["2027-01-04", 2027, 1],
    ["2026-03-29", 2026, 13], ["2026-03-30", 2026, 14], ["2026-10-25", 2026, 43]
  ]) assert.deepEqual(isoWeek(key), { year, week }, key);
});

test("Slovenian statutory work-free days include movable Easter/Pentecost but not working holidays", () => {
  const fixed = ["01-01", "01-02", "02-08", "04-27", "05-01", "05-02", "06-25", "08-15", "10-31", "11-01", "12-25", "12-26"];
  for (const day of fixed) assert.ok(workFreeHoliday(`2026-${day}`), day);
  for (const [easter, monday, pentecost] of [
    ["2024-03-31", "2024-04-01", "2024-05-19"],
    ["2025-04-20", "2025-04-21", "2025-06-08"],
    ["2026-04-05", "2026-04-06", "2026-05-24"],
    ["2027-03-28", "2027-03-29", "2027-05-16"],
    ["2038-04-25", "2038-04-26", "2038-06-13"]
  ]) {
    assert.equal(workFreeHoliday(easter), "Velikonočna nedelja");
    assert.equal(workFreeHoliday(monday), "Velikonočni ponedeljek");
    assert.equal(workFreeHoliday(pentecost), "Binkoštna nedelja");
  }
  for (const day of ["06-08", "08-07", "08-17", "09-15", "09-23", "10-25", "11-10", "11-23", "04-07", "11-02"]) {
    assert.equal(workFreeHoliday(`2026-${day}`), "", day);
  }
});

test("invalid dates are not marked as holidays or numbered weeks", () => {
  for (const value of ["", null, undefined, "2026-02-30", "2026-2-8", "2026-13-01", "invalid"]) {
    assert.equal(isoWeek(value), null);
    assert.equal(workFreeHoliday(value), "");
  }
});
