"use strict";

const CalendarOrder = (() => {
  const groupId = todo => String(todo.assignmentGroupId || todo.id || "");
  const eligible = todo => Boolean(todo?.date && !todo.start && !todo.end && !todo.trashedAt
    && !todo.archivedAt && !todo._absence && (!todo.endDate || todo.endDate === todo.date)
    && !["execution", "meal", "drive", "purchase", "material"].includes(todo.status));
  const rank = todo => Number.isFinite(Number(todo.calendarOrder)) ? Number(todo.calendarOrder) : 0;
  const duration = todo => Math.max(0, Date.parse(todo.endDate || todo.date) - Date.parse(todo.date)) || 0;
  function compareUntimed(a, b) {
    return duration(a) - duration(b) || compare(a, b);
  }
  function compare(a, b) {
    return rank(a) - rank(b) || Number(a.done || false) - Number(b.done || false)
      || Number(b.urgent || false) - Number(a.urgent || false)
      || Number(a.sharedManualOrder || a.order || 0) - Number(b.sharedManualOrder || b.order || 0)
      || groupId(a).localeCompare(groupId(b));
  }
  function reorder(db, user, input, lockConflict = () => null) {
    const byId = new Map((db.todos || []).map(todo => [todo.id, todo]));
    const source = byId.get(input.sourceId), target = byId.get(input.targetId);
    if (!eligible(source) || !eligible(target) || source.date !== target.date || groupId(source) === groupId(target)) {
      return { status: 400, error: "Razvrščaš lahko enodnevna opravila brez ure znotraj istega dne." };
    }
    const groups = new Map();
    for (const todo of db.todos) if (eligible(todo) && todo.date === source.date) {
      const id = groupId(todo);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(todo);
    }
    const visible = group => user.role === "boss" || group.some(todo => todo.syncUser === user.id || todo.createdBy === user.id);
    for (const item of [source, target]) {
      if (!visible(groups.get(groupId(item)))) return { status: 403, error: "Tega vrstnega reda ne smeš spreminjati." };
      for (const todo of groups.get(groupId(item))) {
        const lock = lockConflict(todo);
        if (lock) return { status: 409, error: "Opravilo trenutno ureja drug uporabnik. Poskusi pozneje." };
      }
    }
    const ordered = [...groups.values()].sort((a, b) => compare(a[0], b[0]));
    const selected = ordered.filter(visible).filter(group => groupId(group[0]) !== groupId(source));
    const index = selected.findIndex(group => groupId(group[0]) === groupId(target));
    selected.splice(index + (input.placement === "after" ? 1 : 0), 0, groups.get(groupId(source)));
    let cursor = 0;
    const result = ordered.map(group => visible(group) ? selected[cursor++] : group);
    result.forEach((group, index) => group.forEach(todo => { todo.calendarOrder = index + 1; }));
    return { changed: true };
  }
  return { eligible, compare, compareUntimed, duration, reorder };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CalendarOrder;
