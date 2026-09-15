"use strict";

// undo-service: explicit dependencies; factory creation has no I/O or UI effects.
function createUndoService({
  cleanAuditActorName,
  cleanAuditLogText,
  cleanUserId,
  isUnsafeRequest,
  readBody,
  readRequestDb,
  reconcileTodoArchives,
  requireUser,
  scheduleAuditLog,
  sendJson,
  validTodoAttachmentId,
  writeDbAsync,
  moduleValues
}) {
function undoClone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function undoAttachmentMetadata(attachment = {}) {
  const copy = { ...(attachment || {}) };
  // Files stay in protected media storage. History contains only metadata and
  // never a second copy of the original or thumbnail.
  delete copy.data;
  delete copy.thumbnailData;
  return copy;
}

function undoBusinessSnapshot(db = {}) {
  const snapshot = {};
  for (const key of moduleValues.UNDO_ARRAY_SNAPSHOT_KEYS) snapshot[key] = undoClone(db[key] || []);
  snapshot.attachments = Object.fromEntries(Object.entries(db.attachments || {}).map(([id, attachment]) => [id, undoAttachmentMetadata(attachment)]));
  for (const key of moduleValues.UNDO_VALUE_SNAPSHOT_KEYS) snapshot[key] = undoClone(db[key]);
  return snapshot;
}

function undoItemId(key, item) {
  if (!item || typeof item !== "object") return "";
  if (key === "clients") return String(item.clientId || item.id || "").trim();
  if (key === "billingLocks") return String(item.id || (item.workerId && item.month ? item.workerId + ":" + item.month : "")).trim();
  return String(item.id || "").trim();
}

function undoArrayPatch(key, before = [], after = []) {
  const oldItems = Array.isArray(before) ? before : [];
  const newItems = Array.isArray(after) ? after : [];
  if ([...oldItems, ...newItems].some((item) => item && !undoItemId(key, item))) {
    return JSON.stringify(oldItems) === JSON.stringify(newItems) ? null : { replace: undoClone(oldItems) };
  }
  const oldById = new Map(oldItems.map((item) => [undoItemId(key, item), item]));
  const newById = new Map(newItems.map((item) => [undoItemId(key, item), item]));
  const changes = [];
  for (const id of new Set([...oldById.keys(), ...newById.keys()])) {
    const previous = oldById.get(id);
    const next = newById.get(id);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      changes.push({ id, before: previous === undefined ? null : undoClone(previous) });
    }
  }
  const oldOrder = oldItems.map((item) => undoItemId(key, item));
  const newOrder = newItems.map((item) => undoItemId(key, item));
  const order = JSON.stringify(oldOrder) === JSON.stringify(newOrder) ? null : oldOrder;
  // PostgreSQL does not guarantee the incidental order in which unrelated
  // rows are read.  That order is not a business change and must never use
  // up the single undo slot before the actual mutation is written.
  if (!changes.length) return null;
  return { changes, ...(order ? { order } : {}) };
}

function undoAttachmentPatch(before = {}, after = {}) {
  const oldItems = before && typeof before === "object" ? before : {};
  const newItems = after && typeof after === "object" ? after : {};
  const changes = [];
  for (const id of new Set([...Object.keys(oldItems), ...Object.keys(newItems)])) {
    const previous = oldItems[id];
    const next = newItems[id];
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      changes.push({ id, before: previous === undefined ? null : undoAttachmentMetadata(previous) });
    }
  }
  return changes.length ? { changes } : null;
}

function normalizeUndoArrayPatch(key, raw) {
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw.replace)) return { replace: undoClone(raw.replace) };
  const changes = (Array.isArray(raw.changes) ? raw.changes : [])
    .map((change) => ({
      id: undoItemId(key, { id: change?.id, clientId: key === "clients" ? change?.id : "" }),
      before: change && Object.hasOwn(change, "before") ? undoClone(change.before) : null
    }))
    .filter((change) => Boolean(change.id));
  const order = (Array.isArray(raw.order) ? raw.order : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  // Older journals may contain an order-only patch produced by a database
  // read.  It cannot restore any business data, so hide it instead of
  // offering a misleading Undo action.
  return changes.length ? { changes, ...(order.length ? { order } : {}) } : null;
}

function normalizeUndoAttachmentPatch(raw) {
  const changes = (Array.isArray(raw?.changes) ? raw.changes : [])
    .map((change) => ({
      id: validTodoAttachmentId(change?.id) ? String(change.id) : "",
      before: change && Object.hasOwn(change, "before") && change.before && typeof change.before === "object"
        ? undoAttachmentMetadata(change.before)
        : null
    }))
    .filter((change) => Boolean(change.id));
  return changes.length ? { changes } : null;
}

function normalizeUndoPatch(raw) {
  if (!raw || typeof raw !== "object" || Number(raw.version || 0) !== moduleValues.UNDO_JOURNAL_SCHEMA_VERSION) return null;
  const arrays = {};
  for (const key of moduleValues.UNDO_ARRAY_SNAPSHOT_KEYS) {
    const patch = normalizeUndoArrayPatch(key, raw.arrays?.[key]);
    if (patch) arrays[key] = patch;
  }
  const attachments = normalizeUndoAttachmentPatch(raw.attachments);
  const values = {};
  for (const key of moduleValues.UNDO_VALUE_SNAPSHOT_KEYS) {
    if (raw.values && Object.hasOwn(raw.values, key)) values[key] = undoClone(raw.values[key]);
  }
  if (!Object.keys(arrays).length && !attachments && !Object.keys(values).length) return null;
  const patch = {
    version: moduleValues.UNDO_JOURNAL_SCHEMA_VERSION,
    ...(Object.keys(arrays).length ? { arrays } : {}),
    ...(attachments ? { attachments } : {}),
    ...(Object.keys(values).length ? { values } : {})
  };
  return Buffer.byteLength(JSON.stringify(patch), "utf8") <= moduleValues.UNDO_MAX_PATCH_BYTES ? patch : null;
}

function undoPatchFromSnapshots(beforeState = {}, afterState = {}) {
  const arrays = {};
  for (const key of moduleValues.UNDO_ARRAY_SNAPSHOT_KEYS) {
    const patch = undoArrayPatch(key, beforeState[key], afterState[key]);
    if (patch) arrays[key] = patch;
  }
  const attachments = undoAttachmentPatch(beforeState.attachments, afterState.attachments);
  const values = {};
  for (const key of moduleValues.UNDO_VALUE_SNAPSHOT_KEYS) {
    if (JSON.stringify(beforeState[key]) !== JSON.stringify(afterState[key])) values[key] = undoClone(beforeState[key]);
  }
  return normalizeUndoPatch({
    version: moduleValues.UNDO_JOURNAL_SCHEMA_VERSION,
    arrays,
    attachments,
    values
  });
}

function undoPatchPreviousItem(patch, key, context = {}) {
  const changes = patch?.arrays?.[key]?.changes || [];
  const change = changes.find((candidate) => candidate && typeof candidate === "object");
  if (!change) return null;
  if (change.before && typeof change.before === "object") return change.before;
  const id = String(change.id || "");
  if (!id) return null;
  const items = Array.isArray(context?.[key]) ? context[key] : [];
  const idKey = key === "clients" ? "clientId" : "id";
  return items.find((item) => String(item?.[idKey] || item?.id || "") === id) || null;
}

function normalizeLegacyUndoAction(rawAction, patch, context = {}) {
  const todo = undoPatchPreviousItem(patch, "todos", context);
  const clientBill = undoPatchPreviousItem(patch, "clientBills", context);
  const title = cleanAuditLogText(todo?.title || "", 100);
  const clientName = cleanAuditLogText(clientBill?.clientName || clientBill?.client || todo?.client || "", 120);
  let action = rawAction;
  if (title && /\u00bbbrez naslova\u00ab/iu.test(action)) {
    action = action.replace(/\u00bbbrez naslova\u00ab/iu, `\u00bb${title}\u00ab`);
  }
  // A few early client-bill actions were recorded before their customer name
  // was attached to the log context. The bill/todo snapshot is authoritative,
  // so repair only the known generic placeholder, never a real client name.
  if (clientName && /\bstrank[oa]\b/iu.test(action) && /\u00bb(?:stranko|stranka)?\u00ab/iu.test(action)) {
    action = action.replace(/\u00bb(?:stranko|stranka)?\u00ab/iu, `\u00bb${clientName}\u00ab`);
  }
  return action;
}

function normalizeUndoJournal(raw, context = {}) {
  const values = Array.isArray(raw) ? raw : [];
  return values
    // Version 1 stored whole database copies. They are intentionally dropped
    // during the migration: retaining them would keep the performance issue.
    .map((record) => ({ record, patch: normalizeUndoPatch(record?.patch) }))
    .filter(({ record, patch }) => record && typeof record === "object" && patch)
    .map(({ record, patch }) => {
      const rawAction = cleanAuditLogText(record.action || "Spremenjeni podatki", 220) || "Spremenjeni podatki";
      const action = normalizeLegacyUndoAction(rawAction, patch, context);
      return {
        id: /^[a-f0-9-]{16,80}$/i.test(String(record.id || "")) ? String(record.id) : moduleValues.crypto.randomUUID(),
        createdAt: Number.isFinite(Date.parse(record.createdAt)) ? String(record.createdAt) : new Date().toISOString(),
        actorId: cleanUserId(record.actorId) || "system",
        actorName: cleanAuditActorName(record.actorName, "Sistem"),
        action,
        route: cleanAuditLogText(record.route || "", 180),
        patch,
        undoneAt: Number.isFinite(Date.parse(record.undoneAt)) ? String(record.undoneAt) : "",
        undoneBy: cleanUserId(record.undoneBy),
        undoneByName: cleanAuditActorName(record.undoneByName, ""),
        undoAction: cleanAuditLogText(record.undoAction || "", 220)
      };
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, moduleValues.UNDO_JOURNAL_LIMIT);
}

function undoProtectedAttachmentIds(db = {}) {
  const protectedIds = new Set();
  const includePatch = (patch) => {
    for (const change of patch?.attachments?.changes || []) {
      if (change?.before && validTodoAttachmentId(change.id)) protectedIds.add(change.id);
    }
  };
  for (const record of normalizeUndoJournal(db.undoJournal)) includePatch(record.patch);
  for (const attachmentId of Object.keys(moduleValues.activeUndoCapture?.beforeState?.attachments || {})) {
    if (validTodoAttachmentId(attachmentId)) protectedIds.add(attachmentId);
  }
  return protectedIds;
}

function undoChangedItem(before = [], after = [], idKey = "id") {
  const oldItems = new Map((Array.isArray(before) ? before : []).map((item) => [String(item?.[idKey] || item?.id || ""), item]));
  const newItems = new Map((Array.isArray(after) ? after : []).map((item) => [String(item?.[idKey] || item?.id || ""), item]));
  for (const [id, item] of newItems) {
    if (!id) continue;
    if (!oldItems.has(id) || JSON.stringify(oldItems.get(id)) !== JSON.stringify(item)) return item;
  }
  for (const [id, item] of oldItems) {
    if (id && !newItems.has(id)) return item;
  }
  return null;
}

function undoActionLabel({ req, actor, beforeState, afterState }) {
  const pathname = new URL(req.url, "http://undo.local").pathname;
  const method = String(req.method || "").toUpperCase();
  const prefix = cleanAuditActorName(actor?.name, "Uporabnik") + " je";
  const todo = undoChangedItem(beforeState.todos, afterState.todos);
  const client = undoChangedItem(beforeState.clients, afterState.clients, "clientId");
  const clientBill = undoChangedItem(beforeState.clientBills, afterState.clientBills);
  const payroll = undoChangedItem(beforeState.payrolls, afterState.payrolls);
  const debt = undoChangedItem(beforeState.debts, afterState.debts);
  if (pathname.startsWith("/api/todos")) {
    const title = cleanAuditLogText(todo?.title || "brez naslova", 100);
    if (method === "POST" && pathname === "/api/todos") return prefix + " ustvaril dogodek \u00bb" + title + "\u00ab";
    if (method === "DELETE") return prefix + " izbrisal dogodek \u00bb" + title + "\u00ab";
    if (pathname.endsWith("/reorder")) return prefix + " prerazvrstil opravila";
    if (pathname.endsWith("/bulk-client")) return prefix + " paketno zamenjal stranko pri izbranih dogodkih";
    return prefix + " spremenil dogodek \u00bb" + title + "\u00ab";
  }
  if (pathname.startsWith("/api/clients")) {
    const name = cleanAuditLogText(client?.alias || client?.name || "stranko", 100);
    return method === "POST" && pathname === "/api/clients"
      ? prefix + " dodal stranko \u00bb" + name + "\u00ab"
      : method === "DELETE" ? prefix + " izbrisal stranko \u00bb" + name + "\u00ab" : prefix + " uredil stranko \u00bb" + name + "\u00ab";
  }
  if (pathname.startsWith("/api/client-bills")) {
    const name = cleanAuditLogText(clientBill?.clientName || clientBill?.client || "stranko", 100);
    return method === "POST" ? prefix + " potrdil obra\u010dun za stranko \u00bb" + name + "\u00ab" : prefix + " spremenil obra\u010dun stranke \u00bb" + name + "\u00ab";
  }
  if (pathname.startsWith("/api/payrolls")) {
    const workerName = cleanAuditLogText(payroll?.workerName || payroll?.personName || payroll?.workerId || "delavca", 100);
    return prefix + " spremenil obra\u010dun ur za " + workerName;
  }
  if (pathname.startsWith("/api/advances")) return prefix + " spremenil zalo\u017eena sredstva" + (debt?.reason ? ": " + cleanAuditLogText(debt.reason, 90) : "");
  if (pathname.startsWith("/api/personal-purchases")) return prefix + " spremenil osebni nakup" + (debt?.reason ? ": " + cleanAuditLogText(debt.reason, 90) : "");
  if (pathname.startsWith("/api/settings")) return prefix + " spremenil nastavitve obra\u010dunavanja";
  return prefix + " spremenil podatke";
}

function undoEligibleRequest(req) {
  if (!isUnsafeRequest(req)) return false;
  const pathname = new URL(req.url, "http://undo.local").pathname;
  if (/^\/api\/todos\/(?:video|drive-files|[^/]+\/(?:lock|completion-request|share-pdf-ticket))/.test(pathname)) return false;
  if (/^\/api\/(?:attachments|notifications|auth|google|login|logout|password|profile|billing-locks|undo-journal|backup)\b/.test(pathname)) return false;
  return /^\/api\/(?:todos(?:\/|$)|entries(?:\/|$)|clients(?:\/|$)|client-bills(?:\/|$)|payrolls(?:\/|$)|advances(?:\/|$)|personal-purchases(?:\/|$)|debts(?:\/|$)|settings\/billing$)/.test(pathname);
}

function appendUndoJournalForMutation(db) {
  const capture = moduleValues.activeUndoCapture;
  if (!capture || capture.recorded || !capture.actor) return false;
  const afterState = undoBusinessSnapshot(db);
  const patch = undoPatchFromSnapshots(capture.beforeState, afterState);
  if (!patch) return false;
  const record = {
    id: moduleValues.crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    actorId: cleanUserId(capture.actor.id) || "system",
    actorName: cleanAuditActorName(capture.actor.name, "Sistem"),
    action: undoActionLabel({ req: capture.req, actor: capture.actor, beforeState: capture.beforeState, afterState }),
    route: new URL(capture.req.url, "http://undo.local").pathname,
    patch,
    undoneAt: "",
    undoneBy: "",
    undoneByName: "",
    undoAction: ""
  };
  db.undoJournal = normalizeUndoJournal([record, ...(db.undoJournal || [])]);
  capture.recorded = true;
  return true;
}

function currentUndoRecord(db = {}) {
  return normalizeUndoJournal(db.undoJournal).find((record) => !record.undoneAt) || null;
}

function restoreUndoArrayPatch(db, key, patch) {
  if (Array.isArray(patch?.replace)) {
    db[key] = undoClone(patch.replace);
    return;
  }
  const current = Array.isArray(db[key]) ? db[key] : [];
  const items = new Map(current.map((item) => [undoItemId(key, item), item]).filter(([id]) => id));
  for (const change of patch?.changes || []) {
    if (change.before === null) items.delete(change.id);
    else items.set(change.id, undoClone(change.before));
  }
  const restored = [];
  const used = new Set();
  for (const id of patch?.order || []) {
    const item = items.get(id);
    if (item) {
      restored.push(item);
      used.add(id);
    }
  }
  for (const item of current) {
    const id = undoItemId(key, item);
    if (id && !used.has(id) && items.has(id)) {
      restored.push(items.get(id));
      used.add(id);
    }
  }
  for (const [id, item] of items) {
    if (!used.has(id)) restored.push(item);
  }
  db[key] = restored;
}

function restoreUndoPatch(db, patch) {
  const normalized = normalizeUndoPatch(patch);
  if (!normalized) throw new Error("Zgodovina za to dejanje ni več veljavna.");
  for (const key of moduleValues.UNDO_ARRAY_SNAPSHOT_KEYS) {
    if (normalized.arrays?.[key]) restoreUndoArrayPatch(db, key, normalized.arrays[key]);
  }
  if (normalized.attachments) {
    const attachments = { ...(db.attachments || {}) };
    for (const change of normalized.attachments.changes || []) {
      if (change.before === null) delete attachments[change.id];
      else attachments[change.id] = { ...(attachments[change.id] || {}), ...undoAttachmentMetadata(change.before), id: change.id };
    }
    db.attachments = attachments;
  }
  for (const key of moduleValues.UNDO_VALUE_SNAPSHOT_KEYS) {
    if (normalized.values && Object.hasOwn(normalized.values, key)) db[key] = undoClone(normalized.values[key]);
  }
}

function visibleUndoJournal(db, user) {
  const current = currentUndoRecord(db);
  return normalizeUndoJournal(db.undoJournal).map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    actorId: record.actorId,
    actorName: record.actorName,
    action: record.action,
    undoneAt: record.undoneAt,
    undoneBy: record.undoneBy,
    undoneByName: record.undoneByName,
    undoAction: record.undoAction,
    canUndo: !record.undoneAt && record.id === current?.id
      && (user?.role === "boss" || String(record.actorId) === String(user?.id))
  }));
}

async function handleUndoJournal(req, res, url) {
    if (url.pathname === "/api/undo-journal" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return true;
      const db = await readRequestDb(req);
      sendJson(res, 200, {
        actions: visibleUndoJournal(db, user),
        locked: Boolean(moduleValues.undoSystemLock),
        maxActions: moduleValues.UNDO_JOURNAL_LIMIT
      });
      return true;
    }
    const undoMatch = url.pathname.match(/^\/api\/undo-journal\/([a-f0-9-]{16,80})$/);
    if (undoMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
      const body = await readBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: "Za razveljavitev je potrebna izrecna potrditev." });
        return true;
      }
      const db = await readRequestDb(req);
      const current = currentUndoRecord(db);
      const requestedId = undoMatch[1];
      if (!current || current.id !== requestedId) {
        sendJson(res, 409, { error: "To dejanje ni več zadnje. Najprej razveljavi novejše dejanje." });
        return true;
      }
      if (user.role !== "boss" && String(current.actorId) !== String(user.id)) {
        sendJson(res, 403, { error: "Razveljaviš lahko samo svoje zadnje dejanje." });
        return true;
      }
      moduleValues.undoSystemLock = {
        actionId: current.id,
        startedAt: new Date().toISOString(),
        actorId: user.id,
        actorName: user.name || user.id
      };
      try {
        restoreUndoPatch(db, current.patch);
        // Billing and archive flags are derived from confirmed payrolls and
        // client bills.  Recalculate them after every undo so an entry whose
        // client bill was restored/deleted immediately returns to the list of
        // open client-billing items.
        reconcileTodoArchives(db, user);
        const undoneAt = new Date().toISOString();
        db.undoJournal = normalizeUndoJournal(db.undoJournal).map((record) => record.id === current.id
          ? {
            ...record,
            undoneAt,
            undoneBy: user.id,
            undoneByName: user.name || user.id,
            undoAction: (user.name || user.id) + " je razveljavil: " + record.action
          }
          : record);
        await writeDbAsync(db);
        scheduleAuditLog({
          actor: user,
          action: "undo.applied",
          targetType: "undo",
          targetId: current.id,
          context: { action: current.action }
        });
        sendJson(res, 200, {
          ok: true,
          undoneAction: current.action,
          actions: visibleUndoJournal(db, user),
          syncRevision: db.syncRevision
        });
      } finally {
        moduleValues.undoSystemLock = null;
      }
      return true;
    }
    return false;
}

  return {
    undoBusinessSnapshot,
    undoArrayPatch,
    normalizeUndoJournal,
    undoProtectedAttachmentIds,
    undoEligibleRequest,
    appendUndoJournalForMutation,
    handleUndoJournal
  };
}

module.exports = { createUndoService };
