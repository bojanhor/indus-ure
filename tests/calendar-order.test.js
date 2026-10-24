"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const order = require("../outputs/calendar-order");
const todo = (id, extra = {}) => ({ id, date: "2026-10-24", status: "open", syncUser: "ibro", ...extra });
test("untimed ordering keeps single days first, multi-day shortest first, regardless of manual rank", () => {
  const items = [todo("long", { endDate: "2026-11-15", calendarOrder: -1 }), todo("b", { calendarOrder: 2 }), todo("short", { endDate: "2026-10-25" }), todo("a", { calendarOrder: 1 })];
  assert.deepEqual(items.sort(order.compareUntimed).map(t => t.id), ["a", "b", "short", "long"]);
  assert.equal(order.eligible(items[2]), false);
});
test("shared assignments reorder together; hidden group keeps its slot; schedule never changes", () => {
  const db = { todos: [todo("a", { assignmentGroupId: "one", calendarOrder: 1 }), todo("ab", { assignmentGroupId: "one", syncUser: "bojan", calendarOrder: 1 }), todo("hidden", { syncUser: "bojan", calendarOrder: 2 }), todo("b", { calendarOrder: 3 })] };
  const before = structuredClone(db);
  assert.deepEqual(order.reorder(db, { id: "ibro", role: "worker" }, { sourceId: "b", targetId: "a" }), { changed: true });
  assert.deepEqual(db.todos.map(t => t.calendarOrder), [3, 3, 2, 1]);
  assert.deepEqual(db.todos.map(({ calendarOrder, ...t }) => t), before.todos.map(({ calendarOrder, ...t }) => t));
});
test("ordering rejects foreign, timed, multi-day, other-day and edit-locked events", () => {
  const db = { todos: [todo("a"), todo("private", { syncUser: "bojan" }), todo("time", { start: "08:00", end: "09:00" }), todo("span", { endDate: "2026-10-25" }), todo("tomorrow", { date: "2026-10-25" }), todo("b")] };
  const worker = { id: "ibro", role: "worker" };
  for (const targetId of ["time", "span", "tomorrow"]) assert.equal(order.reorder(db, worker, { sourceId: "a", targetId }).status, 400);
  assert.equal(order.reorder(db, worker, { sourceId: "a", targetId: "private" }).status, 403);
  assert.equal(order.reorder(db, worker, { sourceId: "a", targetId: "b" }, () => true).status, 409);
});
