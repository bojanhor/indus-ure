"use strict";
const { randomUUID } = require("node:crypto");
const groups = require("./task-groups");

function taskGroupRecord(db, user, fields, sharedManualOrderBefore, old = null) {
  const now = new Date().toISOString();
  const item = { ...(old || { id: randomUUID(), ownerId: user.id, createdAt: now }), ...fields, revision: randomUUID(), updatedAt: now };
  if (!old || old.urgent !== item.urgent) {
    item.sharedManualBucket = item.urgent ? "sorted" : "unsorted";
    item.sharedManualOrder = sharedManualOrderBefore(db, { domain: item.urgent ? "urgent" : "active", bucket: item.sharedManualBucket });
  }
  return item;
}

function createTaskGroupHttp({ requireUser, readRequestDb, readBody, sendJson, writeDbAsync, recordAuditLog, sharedManualOrderBefore }) {
  return async (req, res, url) => {
    const match = /^\/api\/task-groups(?:\/([\w-]+))?$/.exec(url.pathname);
    if (!match) return false;
    const user = await requireUser(req, res);
    if (!user) return true;
    const db = await readRequestDb(req);
    const id = match[1];
    const entry = id && groups.index(db).get(id);
    if (id && !groups.maySeeGroup(entry, user)) { sendJson(res, 404, { error: "Skupina ni na voljo." }); return true; }
    if (req.method === "GET") {
      const visible = groups.visible(db, user);
      sendJson(res, 200, id ? { group: visible.find(group => group.id === id) } : { taskGroups: visible });
      return true;
    }
    if (!(req.method === "POST" && !id || ["PUT", "DELETE"].includes(req.method) && id)) {
      sendJson(res, 405, { error: "Nepodprt način." }); return true;
    }
    const body = await readBody(req);
    const old = entry?.group;
    if (old && body.revision !== old.revision) {
      sendJson(res, 409, { error: "Skupina se je medtem spremenila. Zapri in ponovno odpri skupino." }); return true;
    }
    let fields;
    try { fields = req.method === "DELETE" ? {} : groups.clean(body); }
    catch (error) { sendJson(res, 400, { error: error.message }); return true; }
    const item = taskGroupRecord(db, user, fields, sharedManualOrderBefore, old);
    db.taskGroups = (db.taskGroups || []).filter(group => group.id !== id);
    if (req.method !== "DELETE") db.taskGroups.push(item);
    recordAuditLog(db, { actor: user, action: req.method === "DELETE" ? "razpuščena skupina" : old ? "urejena skupina" : "ustvarjena skupina", targetType: "task-group", targetId: item.id });
    await writeDbAsync(db);
    sendJson(res, old ? 200 : 201, { taskGroups: groups.visible(db, user), id: item.id });
    return true;
  };
}
module.exports = { createTaskGroupHttp, taskGroupRecord };
