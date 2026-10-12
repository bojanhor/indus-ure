"use strict";

const Absences = (() => {
  const reasons = { vacation: "Dopust", illness: "Bolezen" };
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  const canView = (item, user) => Boolean(item && user && !item.deletedAt
    && (user.role === "boss" || item.workerId === user.id || (item.viewerIds || []).includes(user.id)));
  const canEdit = (item, user) => Boolean(item && user && (user.role === "boss" || item.workerId === user.id));
  const visible = (db, user) => (db.absences || []).filter(item => canView(item, user))
    .map(item => ({ ...item, workerName: db.users?.[item.workerId]?.name || item.workerId, canEdit: canEdit(item, user) }));
  function clean(input, users, actor, previous = null) {
    const workerId = actor.role === "boss" ? String(input.workerId || "") : actor.id;
    if (previous && actor.role !== "boss" && String(input.workerId || workerId) !== previous.workerId) throw new Error("Delavec lahko ureja samo svojo odsotnost.");
    if (!users[workerId] || (users[workerId].active === false && previous?.workerId !== workerId)) throw new Error("Izberi aktivnega delavca.");
    if (!validDate(input.date) || !validDate(input.endDate) || input.endDate < input.date) throw new Error("Izberi veljavna datuma odsotnosti (do ne sme biti pred od).");
    if (!Object.hasOwn(reasons, input.reason)) throw new Error("Izberi razlog: bolezen ali dopust.");
    const viewers = Array.isArray(input.viewerIds) ? input.viewerIds.map(String) : [];
    if (viewers.some(id => !users[id])) throw new Error("Izbrana oseba za ogled ne obstaja.");
    return { workerId, date: input.date, endDate: input.endDate, reason: input.reason,
      viewerIds: [...new Set([workerId, ...Object.values(users).filter(user => user.role === "boss").map(user => user.id), ...viewers])],
      deletedAt: "" };
  }
  function calendarItem(item, { external = false } = {}) {
    // Whitelist: medical/vacation reason and viewer list never enter exports.
    return { id: item.id, assignmentGroupId: `absence-${item.id}`, status: "absence", _absence: true,
      title: external ? "Odsotnost" : `Odsotnost · ${reasons[item.reason] || ""}`,
      date: item.date, endDate: item.endDate, start: "", end: "", assigneeIds: [item.workerId],
      syncUser: item.workerId, createdAt: item.createdAt, updatedAt: item.updatedAt, client: "", notes: "" };
  }
  function exported(db, { userId = "", combined = false } = {}) {
    const viewer = combined ? { role: "boss" } : db.users?.[userId];
    return visible(db, viewer).map(item => calendarItem(item, { external: true }));
  }
  return { reasons, validDate, canView, canEdit, visible, clean, calendarItem, exported };
})();
if (typeof module !== "undefined" && module.exports) module.exports = Absences;
