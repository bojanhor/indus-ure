"use strict";

const CalendarDates = (() => {
  const DAY_MS = 86400000;
  // Statutory work-free days, not every commemorative state holiday.
  // Source checked 2026-10-29: https://www.gov.si/teme/drzavni-prazniki-in-dela-prosti-dnevi/
  const fixedHolidays = new Map([
    ["01-01", "Novo leto"], ["01-02", "Novo leto"],
    ["02-08", "Prešernov dan, slovenski kulturni praznik"],
    ["04-27", "Dan upora proti okupatorju"],
    ["05-01", "Praznik dela"], ["05-02", "Praznik dela"],
    ["06-25", "Dan državnosti"], ["08-15", "Marijino vnebovzetje"],
    ["10-31", "Dan reformacije"], ["11-01", "Dan spomina na mrtve"],
    ["12-25", "Božič"], ["12-26", "Dan samostojnosti in enotnosti"]
  ]);

  function utcDate(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) return null;
    const value = new Date(`${key}T00:00:00.000Z`);
    return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === key ? value : null;
  }

  function isoWeek(key) {
    const date = utcDate(key);
    if (!date) return null;
    // The Thursday determines the ISO week-year; UTC avoids DST day lengths.
    date.setUTCDate(date.getUTCDate() + 3 - (date.getUTCDay() + 6) % 7);
    const year = date.getUTCFullYear();
    const first = utcDate(`${String(year).padStart(4, "0")}-01-01`);
    return { year, week: Math.ceil(((date - first) / DAY_MS + 1) / 7) };
  }

  function easterSunday(year) {
    // Gregorian computus, calculated for the displayed year (not a fixed list).
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = (h + l - 7 * m + 114) % 31 + 1;
    return utcDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }

  function workFreeHoliday(key) {
    const date = utcDate(key);
    if (!date) return "";
    const fixed = fixedHolidays.get(key.slice(5));
    if (fixed) return fixed;
    const daysFromEaster = (date - easterSunday(date.getUTCFullYear())) / DAY_MS;
    if (daysFromEaster === 0) return "Velikonočna nedelja";
    if (daysFromEaster === 1) return "Velikonočni ponedeljek";
    if (daysFromEaster === 49) return "Binkoštna nedelja";
    return "";
  }

  return { isoWeek, workFreeHoliday };
})();

if (typeof module !== "undefined") module.exports = CalendarDates;
