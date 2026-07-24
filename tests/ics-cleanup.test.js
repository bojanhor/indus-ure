"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildCleanupPlan } = require("../scripts/cleanup-imported-ics");

test("ICS cleanup removes only the exact requested imported events", () => {
  const imported = (id, title, date, notes = "") => ({ id, title, date, notes, imported: true, importBatchId: "ics-private-20260724" });
  const plan = buildCleanupPlan([
    imported("svejk", "\u0160vejk obra\u010dun stro\u0161kov", "2026-07-17"),
    imported("buffer", "Buffer", "2026-10-06"),
    imported("vinjeta", "Vinjeta tiguan", "2026-09-10"),
    imported("pelji", "Pelji \u0161vejk ?", "2026-08-13"),
    imported("pistola", "Pi\u0161tola", "2026-07-13"),
    imported("kabelgel", "Naro\u010di", "2026-07-14", "Kabelgel\nSet za popravilo"),
    imported("duplicate", "Hobo poka\u017ei domofon", "2026-07-14"),
    imported("keep-hobo", "Hobo poka\u017ei domofon", "2026-07-13"),
    imported("keep-buffer", "Studi buffer", "2026-08-18")
  ]);
  assert.deepEqual(plan.map((item) => item.id).sort(), ["buffer", "duplicate", "kabelgel", "pelji", "pistola", "svejk", "vinjeta"]);
});