"use strict";

// Shared by the online calendar and the Google/ICS projection. Financial
// values and recorded work are deliberately not part of this projection.
const PlanningCalendar = (() => {
  const excludedStatuses = new Set(["execution", "meal", "drive", "purchase", "material"]);
  const eligible = todo => Boolean(todo && todo.date && !todo.imported && !todo.trashedAt
    && !todo.archivedAt && !excludedStatuses.has(todo.status));

  function select(todos, { userId = "", combined = false } = {}) {
    const groups = new Map();
    for (const todo of todos || []) {
      if (!eligible(todo) || (!combined && (todo.syncUser || todo.createdBy) !== userId)) continue;
      const key = String(todo.assignmentGroupId || todo.id || "");
      if (!key) continue;
      const worker = String(todo.syncUser || todo.createdBy || "");
      const existing = groups.get(key);
      if (existing) {
        existing.assigneeIds = [...new Set([...existing.assigneeIds, worker].filter(Boolean))];
      } else {
        groups.set(key, { ...todo, assignmentGroupId: key, assigneeIds: worker ? [worker] : [] });
      }
    }
    return [...groups.values()];
  }

  function nextDay(date) {
    const value = new Date(`${date}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value.getTime())) throw new Error("Neveljaven datum koledarja.");
    value.setUTCDate(value.getUTCDate() + 1);
    return value.toISOString().slice(0, 10);
  }

  return { eligible, select, nextDay };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PlanningCalendar;
