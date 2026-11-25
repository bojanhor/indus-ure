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
  const endDate = item => item.date ? (item.endDate || item.date) : "";
  const sameDates = (a, b) => (a.date || "") === (b.date || "") && endDate(a) === endDate(b);
  const followsDate = (member, todo, group) => member?.inheritDate ?? (!todo.date || sameDates(todo, group));
  function withGroupDate(todo, group) {
    if (!group?.date) return todo;
    // A timed task stays on one day. The group supplies dates, never hours.
    return { ...todo, date: group.date, endDate: todo.start || todo.end ? group.date : endDate(group) };
  }
  function scheduleIndex(db) {
    const groups = new Map((db.taskGroups || []).map(group => [group.id, group]));
    return new Map((db.taskGroupMembers || []).map(member => [member.id, { member, group: groups.get(member.groupId) }]));
  }
  function effectiveTodo(todo, schedules) {
    const schedule = active(todo) && schedules.get(eventId(todo));
    return schedule?.group && followsDate(schedule.member, todo, schedule.group) ? withGroupDate(todo, schedule.group) : todo;
  }
  function calendarTodos(db) {
    const schedules = scheduleIndex(db);
    return (db.todos || []).map(todo => effectiveTodo(todo, schedules));
  }
  function freezeFollowers(db, { group, todos }) {
    const byId = new Map(todos.map(todo => [eventId(todo), todo]));
    db.taskGroupMembers = (db.taskGroupMembers || []).map(member => {
      const todo = byId.get(member.id);
      return member.groupId === group.id && member.inheritDate == null && todo
        ? { ...member, inheritDate: followsDate(member, todo, group) } : member;
    });
  }
  // Apply only after the task mutation has passed its edit and billing locks.
  function updateMembershipDate(db, previous, next, explicit = false) {
    if (!active(previous) || !active(next)) return;
    const schedules = scheduleIndex(db);
    const { member, group } = schedules.get(eventId(previous)) || {};
    if (!group) return;
    const effective = effectiveTodo(previous, schedules);
    if (sameDates(next, effective) || (!explicit && sameDates(next, previous))) return;
    if (!group.date || !sameDates(next, withGroupDate(next, group))) {
      db.taskGroupMembers = db.taskGroupMembers.filter(item => item.id !== member.id);
    } else if (member.inheritDate !== true) {
      db.taskGroupMembers = db.taskGroupMembers.map(item => item.id === member.id ? { ...item, inheritDate: true } : item);
    }
  }
  function visible(db, user) {
    const schedules = scheduleIndex(db);
    return [...index(db).values()].filter(entry => maySeeGroup(entry, user)).map(({ group, todos }) => {
      const visibleTodos = todos.filter(todo => maySeeTodo(todo, user));
      return {
        ...group, eventIds: [...new Set(visibleTodos.map(eventId))],
        dateFollowerIds: [...new Set(visibleTodos.filter(todo => followsDate(schedules.get(eventId(todo))?.member, todo, group)).map(eventId))]
      };
    });
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
  return { eventId, eligible, active, idForCard, index, maySeeGroup, maySeeTodo, visible, clean, prune, card, exported,
    sameDates, followsDate, withGroupDate, scheduleIndex, effectiveTodo, calendarTodos, freezeFollowers, updateMembershipDate };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TaskGroups;
