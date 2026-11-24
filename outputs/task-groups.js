"use strict";

const TaskGroups = (() => {
  const eventId = todo => String(todo.assignmentGroupId || todo.id || "");
  const eligible = todo => Boolean(todo && !todo.done && !todo.imported
    && !["execution", "meal", "drive", "purchase", "material", "note"].includes(todo.status));
  const active = todo => eligible(todo) && !todo.trashedAt && !todo.archivedAt;
  const idForCard = id => `org:${id}`;
  const dateOk = value => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  const assigned = (todo, id) => Boolean(id && (todo.syncUser || todo.createdBy) === id);
  const maySeeTodo = (todo, user) => Boolean(user && (user.role === "boss" || assigned(todo, user.id) || todo.createdBy === user.id));
  function index(db) {
    const groups = new Map((db.taskGroups || []).map(group => [group.id, { group, todos: [] }]));
    const memberships = new Map((db.taskGroupMembers || []).map(member => [member.id, member.groupId]));
    for (const todo of db.todos || []) {
      if (active(todo)) groups.get(memberships.get(eventId(todo)))?.todos.push(todo);
    }
    return groups;
  }
  function maySeeGroup(entry, user) {
    return Boolean(entry && user && (user.role === "boss" || entry.group.ownerId === user.id || entry.todos.some(todo => assigned(todo, user.id))));
  }
  function visible(db, user) {
    return [...index(db).values()].filter(entry => maySeeGroup(entry, user)).map(({ group, todos }) => ({
      ...group, eventIds: [...new Set(todos.filter(todo => maySeeTodo(todo, user)).map(eventId))]
    }));
  }
  function clean(input) {
    const title = String(input.title || "").trim().slice(0, 160);
    if (!title) throw Error("Vpiši ime skupine.");
    const date = String(input.date || ""), endDate = String(input.endDate || date);
    const start = String(input.start || ""), end = String(input.end || "");
    if ((date || endDate) && (!dateOk(date) || !dateOk(endDate) || endDate < date)) throw Error("Izberi veljaven datum skupine.");
    if ((start || end) && (!date || date !== endDate || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)
      || !/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(end) || start >= end)) {
      throw Error("Termin z uro mora biti znotraj enega dne, ura Do pa za uro Od.");
    }
    return { title, description: String(input.description || "").trim().slice(0, 1000), date, endDate, start, end, urgent: input.urgent === true };
  }
  function prune(db) {
    if (!Array.isArray(db.taskGroupMembers)) return;
    const eligibleEvents = new Set((db.todos || []).filter(eligible).map(eventId));
    const groupIds = new Set((db.taskGroups || []).map(group => group.id));
    db.taskGroupMembers = db.taskGroupMembers.filter(member => eligibleEvents.has(member.id) && groupIds.has(member.groupId));
  }
  const card = (group, assigneeIds = []) => ({ ...group, id: idForCard(group.id), groupId: group.id, status: "open",
    title: group.title, assigneeIds, _taskGroup: true, done: false });
  function exported(db, { combined = false, userId = "" } = {}) {
    const viewer = combined ? { role: "boss" } : db.users?.[userId];
    return [...index(db).values()].filter(entry => entry.group.date && maySeeGroup(entry, viewer)).map(({ group, todos }) => {
      const members = new Map();
      // Personal Google/ICS mirrors assignment-based planning visibility.
      for (const todo of todos) if ((combined || assigned(todo, userId)) && !members.has(eventId(todo))) members.set(eventId(todo), todo);
      const order = todo => todo.urgent ? 0 : ["order", "order_car", "order_warehouse", "add_to_car"].includes(todo.status) ? 1 : todo.sharedManualBucket === "unsorted" ? 2 : 3;
      return { ...card(group), assignmentGroupId: idForCard(group.id), notes: "", client: "",
        members: [...members.values()].sort((a, b) => order(a) - order(b) || Number(a.sharedManualOrder || 0) - Number(b.sharedManualOrder || 0))
          .map(todo => ({ id: todo.id, title: todo.title })) };
    });
  }
  return { eventId, eligible, active, idForCard, index, maySeeGroup, maySeeTodo, visible, clean, prune, card, exported };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TaskGroups;
