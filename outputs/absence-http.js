"use strict";
const crypto = require("node:crypto");
const absences = require("./absence-model");

function createAbsenceHttp({ requireUser, readRequestDb, readBody, writeDbAsync, sendJson, recordAuditLog }) {
  return async function handleAbsences(req, res, url) {
    const match = url.pathname.match(/^\/api\/absences(?:\/([^/]+))?$/);
    if (!match) return false;
    const user = await requireUser(req, res);
    if (!user) return true;
    const db = await readRequestDb(req);
    const id = match[1] || "";
    const previous = (db.absences || []).find(item => item.id === id && !item.deletedAt);
    if (id && !absences.canView(previous, user)) { sendJson(res, 404, { error: "Odsotnost ni na voljo." }); return true; }
    if (req.method === "GET") { sendJson(res, 200, id ? { absence: absences.visible(db, user).find(item => item.id === id) } : { absences: absences.visible(db, user) }); return true; }
    if (!(req.method === "POST" && !id || ["PUT", "DELETE"].includes(req.method) && id)) { sendJson(res, 405, { error: "Nepodprt način." }); return true; }
    if (id && !absences.canEdit(previous, user)) { sendJson(res, 403, { error: "Odsotnost lahko urejata samo odsotni delavec in šef." }); return true; }
    const input = await readBody(req);
    if (req.method !== "DELETE" && user.role !== "boss" && input.workerId && input.workerId !== user.id) {
      sendJson(res, 403, { error: "Delavec lahko vpiše odsotnost samo sebi." }); return true;
    }
    if (previous && (!input.baseUpdatedAt || input.baseUpdatedAt !== previous.updatedAt)) {
      sendJson(res, 409, { error: "Odsotnost se je medtem spremenila. Zapri in ponovno odpri zapis; spremembe niso shranjene." }); return true;
    }
    let fields;
    try { fields = req.method === "DELETE" ? {} : absences.clean(input, db.users, user, previous); }
    catch (error) { sendJson(res, 400, { error: error.message }); return true; }
    const now = new Date(Math.max(Date.now(), Date.parse(previous?.updatedAt || "") + 1 || 0)).toISOString();
    const item = { ...(previous || { id: crypto.randomUUID(), createdBy: user.id, createdAt: now }), ...fields,
      updatedAt: now, updatedBy: user.id, ...(req.method === "DELETE" ? { deletedAt: now } : {}) };
    db.absences = previous ? db.absences.map(old => old.id === id ? item : old) : [...(db.absences || []), item];
    recordAuditLog(db, { actor: user, action: req.method === "DELETE" ? "izbrisana odsotnost" : previous ? "spremenjena odsotnost" : "dodana odsotnost",
      targetType: "absence", targetId: item.id, context: { workerId: item.workerId, date: item.date, endDate: item.endDate } });
    await writeDbAsync(db);
    sendJson(res, previous ? 200 : 201, { absences: absences.visible(db, user), id: item.id });
    return true;
  };
}
module.exports = { createAbsenceHttp };
