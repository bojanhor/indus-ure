"use strict";

// settlement-service: explicit dependencies; factory creation has no I/O or UI effects.
function createSettlementService({
  appendTodoRevision,
  audit,
  buildPayrollSnapshot,
  capitalizeTodoText,
  cleanUserId,
  isDateKey,
  isTrashedTodo,
  managedDriveFilesForTodos,
  nonnegativeNumber,
  normalizePayroll,
  payrollForUser,
  payrollLineForTodo,
  payrollPeriodEnded,
  payrollRange,
  payrollSequenceError,
  payrollWorkerForTodo,
  pruneUnusedAdHocClients,
  pruneUnusedTodoAttachments,
  readBody,
  readRequestDb,
  requireUser,
  sendJson,
  serverDateKey,
  todoAssignmentEditLockConflict,
  todoAssignmentItems,
  todoVehicle,
  visibleTodosForUser,
  writeDbAsync,
  moduleValues
}) {
function signedNumber(value, fallback = 0, maximum = 1_000_000) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= maximum ? number : fallback;
}

function correctionDateKey(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Ljubljana", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return parts.year + "-" + parts.month + "-" + parts.day;
}

function confirmedPayrollLineForTodo(db, todoId) {
  const matches = [];
  for (const payroll of db.payrolls || []) {
    if (!["confirmed", "paid"].includes(String(payroll?.status || ""))) continue;
    for (const line of payroll.lines || []) if (String(line?.todoId || "") === String(todoId || "")) matches.push({ payroll, line });
  }
  return matches.sort((left, right) => String(right.payroll.confirmedAt || "").localeCompare(String(left.payroll.confirmedAt || "")))[0] || null;
}

function latestCorrection(db, predicate) {
  return (db.settlementCorrections || []).filter(predicate).sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))[0] || null;
}

function workerCorrectionSnapshot(db, todo, fallback = {}) {
  const raw = payrollLineForTodo(db, todo, todo?.syncUser || todo?.createdBy || "");
  const hourlyRate = nonnegativeNumber(todo?.billingHourlyRate, nonnegativeNumber(fallback.hourlyRate, 0, 10_000), 10_000);
  const kmRate = nonnegativeNumber(fallback.kmRate, nonnegativeNumber(db.settings?.billing?.workerOwnVehicleKmRate, 0, 1_000), 1_000);
  const minutes = Number(raw?.minutes || 0);
  const workerKm = nonnegativeNumber(todo?.billingKm, 0, 1_000_000);
  const commuteKm = nonnegativeNumber(fallback.commuteKm, 0, 1_000_000);
  const km = Number((workerKm + commuteKm).toFixed(2));
  const workAmount = Number((minutes / 60 * hourlyRate).toFixed(2));
  const kmAmount = Number((km * kmRate).toFixed(2));
  return { todoId: String(todo?.id || fallback.todoId || ""), assignmentGroupId: String(todo?.assignmentGroupId || fallback.assignmentGroupId || ""), workerId: String(todo?.syncUser || todo?.createdBy || fallback.workerId || ""), date: isDateKey(todo?.date) ? String(todo.date) : String(fallback.date || ""), start: String(todo?.start || ""), end: String(todo?.end || ""), title: String(todo?.title || fallback.title || "").slice(0, 300), client: String(todo?.client || fallback.client || "").slice(0, 240), status: String(todo?.status || fallback.status || ""), minutes, hours: Number((minutes / 60).toFixed(4)), hourlyRate, workerKm, workFromHome: Boolean(todo?.workFromHome), commuteKm, km, kmRate, workAmount, kmAmount, totalAmount: Number((workAmount + kmAmount).toFixed(2)) };
}

function workerCorrectionDelta(before = {}, after = {}) {
  const result = {};
  for (const key of ["minutes", "hours", "workerKm", "commuteKm", "km", "workAmount", "kmAmount", "totalAmount"]) result[key] = Number((signedNumber(after[key]) - signedNumber(before[key])).toFixed(key === "minutes" ? 0 : 2));
  return result;
}

function zeroWorkerCorrectionSnapshot(baseline = {}) {
  return {
    ...baseline,
    date: "",
    start: "",
    end: "",
    status: "corrected",
    minutes: 0,
    hours: 0,
    workerKm: 0,
    commuteKm: 0,
    km: 0,
    workAmount: 0,
    kmAmount: 0,
    totalAmount: 0
  };
}

function clientCorrectionSnapshot(todos = []) {
  const list = (todos || []).filter(Boolean).slice().sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")) || String(left.start || "").localeCompare(String(right.start || "")));
  const first = list[0] || {};
  const warranty = Boolean(first.warranty);
  const isMaterial = first.status === "material";
  const isClientOnly = isMaterial || first.status === "note";
  return { eventId: todoBillingEventId(first), clientId: String(first.clientId || ""), client: String(first.client || ""), date: String(first.date || ""), start: String(first.start || ""), end: String(first.end || ""), title: String(first.title || "").slice(0, 300), notes: String(first.notes || "").slice(0, 10_000), material: String(first.material || "").slice(0, 10_000), status: String(first.status || ""), externalDelivery: Boolean(first.externalDelivery), materialAmount: isMaterial ? nonnegativeNumber(first.materialAmount, 0, 1_000_000) : 0, warranty, clientKm: warranty || isClientOnly ? 0 : nonnegativeNumber(first.clientKm, 0, 1_000_000), clientVehicle: todoVehicle(first.clientVehicle), hours: warranty || isClientOnly ? 0 : clientBillableHoursForTodos(list), todoIds: list.map((todo) => String(todo.id || "")).filter(Boolean) };
}

function sameValue(left, right) { return JSON.stringify(left || {}) === JSON.stringify(right || {}); }

function pendingCorrectionsForTodo(db, todo) {
  const todoId = String(todo?.id || ""), eventId = todoBillingEventId(todo);
  return (db.settlementCorrections || []).filter((item) => item?.status === "pending" && ((item.type === "worker" && String(item.todoId || "") === todoId) || (item.type === "client" && String(item.eventId || "") === eventId)));
}

function upsertSettlementCorrections(db, beforeTodos, afterTodos, actor, now = new Date().toISOString()) {
  const preliminaryBeforeClient = clientCorrectionSnapshot(beforeTodos);
  const preliminaryAfterClient = clientCorrectionSnapshot(afterTodos);
  const preliminaryEventId = String(preliminaryBeforeClient.eventId || preliminaryAfterClient.eventId || "");
  if (confirmedClientBillByEvent(db).get(preliminaryEventId)
    && preliminaryBeforeClient.clientId && preliminaryAfterClient.clientId
    && preliminaryBeforeClient.clientId !== preliminaryAfterClient.clientId) {
    return { corrections: [], error: "Pri ?e obra?unani storitvi stranke ni mogo?e zamenjati neposredno. Najprej naredi lo?en dobropis." };
  }
  const beforeById = new Map((beforeTodos || []).map((todo) => [String(todo.id || ""), todo]));
  const afterById = new Map((afterTodos || []).map((todo) => [String(todo.id || ""), todo]));
  const result = [];
  for (const [todoId, before] of beforeById) {
    const prior = confirmedPayrollLineForTodo(db, todoId);
    const current = workerCorrectionSnapshot(db, afterById.get(todoId) || { ...before, date: "", start: "", end: "", status: "deleted", billingKm: 0 }, prior?.line || {});
    const priorWorkerId = String(prior?.line?.workerId || "");
    const reassigned = Boolean(priorWorkerId && current.workerId && priorWorkerId !== current.workerId);
    const correctionWorkerId = reassigned ? priorWorkerId : String(current.workerId || priorWorkerId || "");
    const pending = latestCorrection(db, (item) => item?.type === "worker" && item?.status === "pending"
      && String(item.todoId || "") === todoId && String(item.workerId || "") === correctionWorkerId);
    const settled = latestCorrection(db, (item) => item?.type === "worker" && item?.status === "settled"
      && String(item.todoId || "") === todoId && String(item.workerId || "") === correctionWorkerId);
    if (!prior && !pending && !settled) continue;
    const baseline = pending?.before || settled?.after || prior?.line;
    const after = reassigned ? zeroWorkerCorrectionSnapshot(baseline) : current;
    if (sameValue(baseline, after)) {
      if (pending) db.settlementCorrections = db.settlementCorrections.filter((item) => item.id !== pending.id);
      continue;
    }
    // A reassignment after a confirmed payroll is two separate facts: the
    // former worker gets a negative delta in the next account, while the new
    // worker receives the normal live entry in their still-open account.
    const correction = { id: pending?.id || moduleValues.crypto.randomUUID(), type: "worker", status: "pending", todoId, eventId: todoBillingEventId(before), workerId: correctionWorkerId, sourcePayrollId: String(prior?.payroll?.id || pending?.sourcePayrollId || settled?.sourcePayrollId || ""), before: baseline, after, delta: workerCorrectionDelta(baseline, after), effectiveDate: correctionDateKey(new Date(now)), createdAt: pending?.createdAt || now, createdBy: pending?.createdBy || actor?.id || "system", createdByName: pending?.createdByName || actor?.name || "", updatedAt: now, updatedBy: actor?.id || "system", updatedByName: actor?.name || "" };
    if (pending) Object.assign(pending, correction); else db.settlementCorrections.push(correction);
    result.push(correction);
  }
  const beforeClient = clientCorrectionSnapshot(beforeTodos), afterClient = clientCorrectionSnapshot(afterTodos);
  const eventId = String(beforeClient.eventId || afterClient.eventId || "");
  const clientBill = confirmedClientBillByEvent(db).get(eventId);
  const pendingClient = latestCorrection(db, (item) => item?.type === "client" && item?.status === "pending" && String(item.eventId || "") === eventId);
  const settledClient = latestCorrection(db, (item) => item?.type === "client" && item?.status === "settled" && String(item.eventId || "") === eventId);
  if (clientBill || pendingClient || settledClient) {
    const baseline = pendingClient?.before || settledClient?.after || beforeClient;
    if (baseline.clientId && afterClient.clientId && baseline.clientId !== afterClient.clientId) return { corrections: result, error: "Pri ?e obra?unani storitvi stranke ni mogo?e zamenjati neposredno. Najprej naredi lo?en dobropis." };
    if (sameValue(baseline, afterClient)) {
      if (pendingClient) db.settlementCorrections = db.settlementCorrections.filter((item) => item.id !== pendingClient.id);
    } else {
      const delta = { hours: Number((signedNumber(afterClient.hours) - signedNumber(baseline.hours)).toFixed(2)), clientKm: Number((signedNumber(afterClient.clientKm) - signedNumber(baseline.clientKm)).toFixed(2)), materialAmount: Number((signedNumber(afterClient.materialAmount) - signedNumber(baseline.materialAmount)).toFixed(2)) };
      const correction = { id: pendingClient?.id || moduleValues.crypto.randomUUID(), type: "client", status: "pending", eventId, clientId: String(afterClient.clientId || baseline.clientId || ""), clientName: String(afterClient.client || baseline.client || ""), sourceClientBillId: String(clientBill?.id || pendingClient?.sourceClientBillId || settledClient?.sourceClientBillId || ""), before: baseline, after: afterClient, delta, effectiveDate: correctionDateKey(), createdAt: pendingClient?.createdAt || now, createdBy: pendingClient?.createdBy || actor?.id || "system", createdByName: pendingClient?.createdByName || actor?.name || "", updatedAt: now, updatedBy: actor?.id || "system", updatedByName: actor?.name || "" };
      if (pendingClient) Object.assign(pendingClient, correction); else db.settlementCorrections.push(correction);
      result.push(correction);
    }
  }
  return { corrections: result, error: "" };
}

function correctionPayrollLine(correction) {
  const after = correction.after || {}, delta = correction.delta || {};
  return { todoId: "correction:" + correction.id, sourceTodoId: String(correction.todoId || ""), correctionId: String(correction.id || ""), correction: true, assignmentGroupId: String(after.assignmentGroupId || correction.eventId || correction.todoId || ""), workerId: String(correction.workerId || after.workerId || ""), date: String(correction.effectiveDate || correctionDateKey()), start: "", end: "", title: "Popravek: " + String(after.title || "vpis ur").slice(0, 270), client: String(after.client || ""), status: "correction", minutes: Math.round(signedNumber(delta.minutes)), unpaidMealMinutes: 0, hours: signedNumber(delta.hours), hourlyRate: nonnegativeNumber(after.hourlyRate, 0, 10_000), workerKm: signedNumber(delta.workerKm), workFromHome: Boolean(after.workFromHome), commuteKm: signedNumber(delta.commuteKm), km: signedNumber(delta.km), kmRate: nonnegativeNumber(after.kmRate, 0, 1_000), workAmount: Number(signedNumber(delta.workAmount).toFixed(2)), kmAmount: Number(signedNumber(delta.kmAmount).toFixed(2)), totalAmount: Number(signedNumber(delta.totalAmount).toFixed(2)) };
}

function settleCorrectionsForPayroll(db, payroll, actor) {
  const ids = new Set((payroll.lines || []).map((line) => String(line.correctionId || "")).filter(Boolean));
  let changed = 0;
  for (const correction of db.settlementCorrections || []) if (correction.type === "worker" && correction.status === "pending" && ids.has(correction.id)) { correction.status = "settled"; correction.workerPayrollId = payroll.id; correction.settledAt = new Date().toISOString(); correction.settledBy = actor?.id || "system"; changed += 1; }
  return changed;
}

function settleCorrectionsForClientBill(db, bill, actor) {
  const ids = new Set((bill.correctionIds || []).map(String).filter(Boolean));
  let changed = 0;
  for (const correction of db.settlementCorrections || []) if (correction.type === "client" && correction.status === "pending" && ids.has(correction.id)) { correction.status = "settled"; correction.clientBillId = bill.id; correction.settledAt = new Date().toISOString(); correction.settledBy = actor?.id || "system"; changed += 1; }
  return changed;
}

function todoBillingEventId(todo) {
  return String(todo?.assignmentGroupId || todo?.id || "").trim();
}

function todoRequiresClientBilling(todo) {
  return Boolean(todo && !todo.imported && ["execution", "material", "note"].includes(String(todo.status || "")) && String(todo.clientId || todo.client || "").trim());
}

function clientBillIsConfirmed(bill) {
  return moduleValues.CLIENT_BILL_STATUSES.has(String(bill?.status || ""));
}

function clientBillEventIds(bill) {
  return [...new Set((Array.isArray(bill?.eventIds) ? bill.eventIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
}

function clientForBilling(db, input = {}) {
  const wanted = [input?.clientId, input?.clientName, input?.client]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return null;
  return (db.clients || []).find((client) => [client.clientId, client.id, client.name, client.search, client.taxId, client.registryNumber]
    .filter(Boolean)
    .some((value) => wanted.includes(String(value).trim().toLowerCase()))) || null;
}

function normalizeClientBill(input, db) {
  const client = clientForBilling(db, input || {});
  const clientId = String(client?.clientId || input?.clientId || "").trim().slice(0, 160);
  const clientName = String(client?.name || input?.clientName || input?.client || "").trim().slice(0, 240);
  const eventIds = clientBillEventIds(input);
  if (!clientName || !eventIds.length) return null;
  const lines = (Array.isArray(input?.lines) ? input.lines : []).map((line) => {
    const eventId = String(line?.eventId || line?.assignmentGroupId || "").trim();
    if (!eventIds.includes(eventId)) return null;
    return {
      eventId,
      todoIds: [...new Set((Array.isArray(line?.todoIds) ? line.todoIds : []).map((id) => String(id || "").trim()).filter(Boolean))],
      date: isDateKey(line?.date) ? String(line.date) : "",
      start: String(line?.start || "").slice(0, 5),
      end: String(line?.end || "").slice(0, 5),
      title: String(line?.title || "").trim().slice(0, 300),
      clientKm: nonnegativeNumber(line?.clientKm, 0, 1_000_000),
      clientVehicle: todoVehicle(line?.clientVehicle),
      clientBillableMinutes: normalizedClientBillableMinutes(line?.clientBillableMinutes),
      warranty: Boolean(line?.warranty),
      status: String(line?.status || "").slice(0, 40),
      materialAmount: nonnegativeNumber(line?.materialAmount, 0, 1_000_000),
      externalDelivery: Boolean(line?.externalDelivery),
      clientKmRate: 0
    };
  }).filter(Boolean);
  const createdAt = String(input?.createdAt || new Date().toISOString());
  const status = String(input?.status || "") === "cancelled" ? "cancelled" : "confirmed";
  return {
    id: String(input?.id || moduleValues.crypto.randomUUID()),
    clientId,
    clientName,
    from: isDateKey(input?.from) ? String(input.from) : "",
    to: isDateKey(input?.to) ? String(input.to) : "",
    status,
    eventIds,
    lines,
    createdBy: String(input?.createdBy || "system"),
    createdByName: String(input?.createdByName || ""),
    createdAt,
    confirmedAt: String(input?.confirmedAt || createdAt),
    confirmedBy: String(input?.confirmedBy || input?.createdBy || "system"),
    confirmedByName: String(input?.confirmedByName || input?.createdByName || ""),
    cancelledAt: status === "cancelled" ? String(input?.cancelledAt || createdAt) : "",
    cancelledBy: status === "cancelled" ? String(input?.cancelledBy || "system") : "",
    cancelledByName: status === "cancelled" ? String(input?.cancelledByName || "") : "",
    // A direct settlement records the actual amount paid by the client. The
    // normal client report intentionally does not calculate a client price.
    directSettlement: Boolean(input?.directSettlement),
    receivedAmount: nonnegativeNumber(input?.receivedAmount, 0, 1_000_000),
    creditedWorkerId: cleanUserId(input?.creditedWorkerId),
    creditedWorkerName: String(input?.creditedWorkerName || "").trim().slice(0, 120),
    clientReceiptId: String(input?.clientReceiptId || "").trim().slice(0, 100),
    note: String(input?.note || "").trim().slice(0, 2_000)
  };
}

function cancelClientBill(db, billId, actor = null) {
  const bill = (db.clientBills || []).find((item) => String(item?.id || "") === String(billId || ""));
  if (!bill || !clientBillIsConfirmed(bill)) return null;
  const linkedReceiptId = String(bill.clientReceiptId || "");
  if (linkedReceiptId) {
    const referencedPayroll = (db.payrolls || []).find((payroll) => (payroll.clientReceiptIds || []).map(String).includes(linkedReceiptId));
    if (referencedPayroll) {
      return { error: "Neposrednega poračuna ni mogoče preklicati, ker je plačilo že vključeno v obračun delavca. Najprej odpri ali popravi ta obračun." };
    }
    db.debts = (db.debts || []).filter((item) => String(item?.id || "") !== linkedReceiptId);
  }
  const auditActor = actor || { id: "system", name: "Sistem" };
  const now = new Date().toISOString();
  const eventIds = new Set(clientBillEventIds(bill));
  bill.status = "cancelled";
  bill.cancelledAt = now;
  bill.cancelledBy = auditActor.id;
  bill.cancelledByName = auditActor.name || "";
  for (const todo of db.todos || []) {
    if (!eventIds.has(todoBillingEventId(todo))) continue;
    todo.history = [...(todo.history || []), audit(auditActor, `preklican obračun stranki ${bill.clientName}`)];
  }
  const archive = reconcileTodoArchives(db, auditActor);
  return { clientBill: bill, archive };
}

function confirmedClientBillByEvent(db) {
  const byEvent = new Map();
  for (const bill of db.clientBills || []) {
    if (!clientBillIsConfirmed(bill)) continue;
    for (const eventId of clientBillEventIds(bill)) {
      const current = byEvent.get(eventId);
      if (!current || String(current.confirmedAt || "") <= String(bill.confirmedAt || "")) byEvent.set(eventId, bill);
    }
  }
  return byEvent;
}

function clientBillLockForTodos(db, todos = []) {
  const bills = confirmedClientBillByEvent(db);
  return todos.map((todo) => bills.get(todoBillingEventId(todo))).find(Boolean) || null;
}

function clientBillEditLockMessage(bill) {
  const clientName = String(bill?.clientName || bill?.client || "stranko").trim() || "stranko";
  return `Dogodek je že v potrjenem obračunu stranki ${clientName} in je zaklenjen. Za dodatno delo ali popravek ustvari nov dogodek.`;
}

function clientBillCandidates(db, input = {}) {
  const client = clientForBilling(db, input);
  if (!client) return { client: null, groups: [] };
  const from = isDateKey(input.from) ? String(input.from) : "";
  const to = isDateKey(input.to) ? String(input.to) : "";
  const requestedEventIds = Array.isArray(input?.eventIds)
    ? new Set(input.eventIds.map((id) => String(id || "").trim()).filter(Boolean))
    : null;
  const billed = confirmedClientBillByEvent(db);
  const groups = new Map();
  for (const todo of db.todos || []) {
    if (isTrashedTodo(todo) || !todoRequiresClientBilling(todo)) continue;
    if (String(todo.clientId || "") !== String(client.clientId || "") && String(todo.client || "").trim().toLowerCase() !== String(client.name || "").trim().toLowerCase()) continue;
    if ((from && String(todo.date || "") < from) || (to && String(todo.date || "") > to)) continue;
    const eventId = todoBillingEventId(todo);
    // A confirmed customer bill is immutable.  Older data can still contain
    // pending correction markers from the former workflow, but those markers
    // must never make the original event billable a second time.
    if (!eventId || billed.has(eventId)) continue;
    if (requestedEventIds && !requestedEventIds.has(eventId)) continue;
    if (!groups.has(eventId)) groups.set(eventId, []);
    groups.get(eventId).push(todo);
  }
  return { client, groups: [...groups.entries()].map(([eventId, todos]) => ({ eventId, todos })), requestedEventIds };
}

function optionalReportHours(todo = {}) {
  const raw = todo?.reportHours;
  if (raw === null || raw === "" || typeof raw === "undefined") return null;
  const hours = Number(raw);
  return Number.isFinite(hours) ? hours : null;
}

function todoDurationHours(todo = {}) {
  const reportHours = optionalReportHours(todo);
  if (reportHours !== null) return reportHours;
  const start = /^(\d{2}):(\d{2})$/.exec(String(todo.start || ""));
  const end = /^(\d{2}):(\d{2})$/.exec(String(todo.end || ""));
  if (!start || !end) return 0;
  const startMinutes = Number(start[1]) * 60 + Number(start[2]);
  const endMinutes = Number(end[1]) * 60 + Number(end[2]);
  return endMinutes > startMinutes ? (endMinutes - startMinutes) / 60 : 0;
}

function normalizedClientBillableMinutes(value) {
  const minutes = nonnegativeNumber(value, null, 1_000_000);
  return minutes === null ? null : Math.round(minutes / 15) * 15;
}

function todoClientBillableMinutes(todo = {}) {
  const reportHours = optionalReportHours(todo);
  if (reportHours !== null) return Math.round(reportHours * 60);
  const manual = normalizedClientBillableMinutes(todo.clientBillableMinutes);
  return manual === null ? Math.round(todoDurationHours(todo) * 60) : manual;
}

function clientBillableMinutesForTodos(todos = []) {
  const list = (todos || []).filter(Boolean);
  // An assignment group is one customer event. When its boss has set one
  // shared manual amount, take it once instead of adding the same value for
  // every assigned worker.
  const manual = list.map((todo) => normalizedClientBillableMinutes(todo.clientBillableMinutes))
    .find((minutes) => minutes !== null);
  return manual === undefined ? list.reduce((sum, todo) => sum + todoClientBillableMinutes(todo), 0) : manual;
}

function clientBillableHoursForTodos(todos = []) {
  return Number((clientBillableMinutesForTodos(todos) / 60).toFixed(2));
}

function clientBillableHoursWarning(beforeTodos = [], afterTodos = []) {
  const beforeManual = (beforeTodos || []).map((todo) => normalizedClientBillableMinutes(todo?.clientBillableMinutes))
    .find((minutes) => minutes !== null);
  if (beforeManual === undefined) return null;
  const beforeWorkerMinutes = Math.round((beforeTodos || []).reduce((sum, todo) => sum + todoDurationHours(todo) * 60, 0));
  const afterWorkerMinutes = Math.round((afterTodos || []).reduce((sum, todo) => sum + todoDurationHours(todo) * 60, 0));
  if (beforeWorkerMinutes === afterWorkerMinutes) return null;
  return {
    clientBillableHours: Number((beforeManual / 60).toFixed(2)),
    beforeWorkerHours: Number((beforeWorkerMinutes / 60).toFixed(2)),
    afterWorkerHours: Number((afterWorkerMinutes / 60).toFixed(2))
  };
}

function buildClientBillSnapshot(db, input, actor) {
  const selection = clientBillCandidates(db, input);
  if (!selection.client || !selection.groups.length) return null;
  if (selection.requestedEventIds && selection.groups.length !== selection.requestedEventIds.size) return null;
  const createdAt = new Date().toISOString();
  return normalizeClientBill({
    id: moduleValues.crypto.randomUUID(),
    clientId: selection.client.clientId,
    clientName: selection.client.name,
    from: isDateKey(input?.from) ? String(input.from) : "",
    to: isDateKey(input?.to) ? String(input.to) : "",
    status: "confirmed",
    eventIds: selection.groups.map((group) => group.eventId),
    correctionIds: selection.groups.flatMap((group) => (db.settlementCorrections || [])
      .filter((correction) => correction.type === "client" && correction.status === "pending" && String(correction.eventId || "") === String(group.eventId))
      .map((correction) => correction.id)),
    lines: selection.groups.map((group) => {
      const representative = group.todos.slice().sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")) || String(left.start || "").localeCompare(String(right.start || "")))[0];
      return {
        eventId: group.eventId,
        todoIds: group.todos.map((todo) => todo.id),
        date: representative.date,
        start: representative.start,
        end: representative.end,
        title: representative.title,
        clientKm: representative.clientKm,
        clientVehicle: representative.clientVehicle,
        clientBillableMinutes: clientBillableMinutesForTodos(group.todos),
        warranty: Boolean(representative.warranty),
        status: String(representative.status || ""),
        materialAmount: nonnegativeNumber(representative.materialAmount, 0, 1_000_000),
        externalDelivery: Boolean(representative.externalDelivery),
        clientKmRate: 0
      };
    }),
    createdBy: actor?.id || "system",
    createdByName: actor?.name || "",
    createdAt,
    confirmedAt: createdAt,
    confirmedBy: actor?.id || "system",
    confirmedByName: actor?.name || "",
    directSettlement: Boolean(input?.directSettlement),
    receivedAmount: nonnegativeNumber(input?.receivedAmount, 0, 1_000_000),
    creditedWorkerId: cleanUserId(input?.creditedWorkerId),
    creditedWorkerName: String(input?.creditedWorkerName || "").trim().slice(0, 120),
    clientReceiptId: String(input?.clientReceiptId || "").trim().slice(0, 100)
  }, db);
}

function directClientSettlementRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.confirmed) return null;
  return {
    amount: nonnegativeNumber(value.amount, null, 1_000_000),
    creditWorker: Boolean(value.creditWorker)
  };
}

function directClientSettlementForTodo(db, todo, input, actor) {
  const request = directClientSettlementRequest(input);
  if (!request) return { clientBill: null, clientReceipt: null };
  if (request.amount === null || request.amount < 0) {
    return { error: "Za poraÄŤunano storitev vpiĹˇi prejeti znesek." };
  }
  if (!todoRequiresClientBilling(todo)) {
    return { error: "S stranko lahko neposredno poraÄŤunaĹˇ samo zakljuÄŤen vpis ur z izbrano stranko." };
  }
  const eventId = todoBillingEventId(todo);
  const current = confirmedClientBillByEvent(db).get(eventId);
  if (current) {
    if (current.directSettlement) return { clientBill: current, clientReceipt: current.clientReceiptId ? (db.debts || []).find((item) => item.id === current.clientReceiptId) || null : null };
    return { error: "Ta dogodek je Ĺľe v potrjenem obraÄŤunu stranki." };
  }
  const workerId = payrollWorkerForTodo(todo);
  const creditWorker = request.creditWorker && request.amount > 0;
  if (creditWorker && !db.users?.[workerId]) {
    return { error: "Delavca za plaÄŤilo v dobro ni bilo mogoÄŤe prepoznati." };
  }
  const clientReceiptId = creditWorker ? moduleValues.crypto.randomUUID() : "";
  const clientBill = buildClientBillSnapshot(db, {
    clientId: todo.clientId,
    clientName: todo.client,
    eventIds: [eventId],
    directSettlement: true,
    receivedAmount: request.amount,
    creditedWorkerId: creditWorker ? workerId : "",
    creditedWorkerName: creditWorker ? (db.users[workerId]?.name || workerId) : "",
    clientReceiptId
  }, actor);
  if (!clientBill) return { error: "Dogodka ni bilo mogoÄŤe pripraviti za obraÄŤun stranki." };
  db.clientBills.push(clientBill);
  let clientReceipt = null;
  if (creditWorker) {
    // We never rewrite a confirmed payroll. A late client payment becomes a
    // new credit in today's open settlement, while sourceDate still points to
    // the original work entry.
    const sourcePayroll = confirmedPayrollLineForTodo(db, todo.id);
    const accountingDate = sourcePayroll ? serverDateKey() : String(todo.date || serverDateKey());
    const now = new Date().toISOString();
    clientReceipt = {
      id: clientReceiptId,
      type: "client_receipt",
      person: workerId,
      month: accountingDate.slice(0, 7),
      date: accountingDate,
      sourceDate: String(todo.date || ""),
      amount: Number(request.amount.toFixed(2)),
      reason: `PlaÄŤilo stranke ${todo.client}: ${todo.title || "storitev"}`.slice(0, 2_000),
      projectTodoId: String(todo.id || ""),
      clientBillId: clientBill.id,
      photos: [],
      createdBy: actor?.id || "system",
      createdByName: actor?.name || "",
      createdAt: now,
      updatedBy: actor?.id || "system",
      updatedByName: actor?.name || "",
      updatedAt: now
    };
    db.debts.push(clientReceipt);
  }
  for (const item of db.todos || []) {
    if (todoBillingEventId(item) !== eventId) continue;
    item.history = [...(item.history || []), audit(actor || { id: "system", name: "Sistem" }, creditWorker
      ? `neposredno poraÄŤunano s stranko; ${request.amount.toFixed(2)} EUR v dobro delavca`
      : `neposredno poraÄŤunano s stranko; ${request.amount.toFixed(2)} EUR`)];
  }
  const settledCorrections = settleCorrectionsForClientBill(db, clientBill, actor);
  const archive = reconcileTodoArchives(db, actor);
  return { clientBill, clientReceipt, settledCorrections, archive };
}

function clientSettlementFromBill(bill) {
  if (!bill) return { confirmed: false };
  return {
    confirmed: true,
    direct: Boolean(bill.directSettlement),
    amount: nonnegativeNumber(bill.receivedAmount, 0, 1_000_000),
    creditedWorkerId: String(bill.creditedWorkerId || ""),
    creditedWorkerName: String(bill.creditedWorkerName || ""),
    confirmedAt: String(bill.confirmedAt || ""),
    clientBillId: String(bill.id || "")
  };
}

function clientSettlementForTodo(db, todo) {
  return clientSettlementFromBill(confirmedClientBillByEvent(db).get(todoBillingEventId(todo)));
}

function confirmedPayrollByTodo(db) {
  const byTodo = new Map();
  const todosById = new Map((db.todos || []).map((todo) => [String(todo.id || ""), todo]));
  for (const payroll of db.payrolls || []) {
    if (!["confirmed", "paid"].includes(payroll.status)) continue;
    for (const line of payroll.lines || []) {
      const todoId = String(line?.todoId || "");
      const todo = todosById.get(todoId);
      // A historic line belonging to a former worker is not a settlement for
      // the current worker, nor may it cause the live task to be archived.
      if (todoId && todo && payrollWorkerForTodo(todo) === String(payroll.workerId || "") && !byTodo.has(todoId)) {
        byTodo.set(todoId, payroll);
      }
    }
  }
  return byTodo;
}

function reconcileTodoArchives(db, actor = null) {
  const payrolls = confirmedPayrollByTodo(db);
  const bills = confirmedClientBillByEvent(db);
  const now = new Date().toISOString();
  const auditActor = actor || { id: "system", name: "Sistem" };
  let archived = 0;
  let restored = 0;
  let changed = false;
  for (const todo of db.todos || []) {
    if (isTrashedTodo(todo)) continue;
    const payroll = payrolls.get(String(todo.id || ""));
    const hasPendingCorrection = pendingCorrectionsForTodo(db, todo).length > 0;
    const needsClientBill = todoRequiresClientBilling(todo);
    const bill = needsClientBill ? bills.get(todoBillingEventId(todo)) : null;
    const desiredClientBillId = bill?.id || "";
    const clientOnly = ["material", "note"].includes(todo.status);
    const readyForArchive = Boolean(!hasPendingCorrection && (clientOnly ? bill : (payroll && (!needsClientBill || bill))));
    if (todo.clientBillId !== desiredClientBillId || todo.clientBilledAt !== (bill?.confirmedAt || "")) {
      todo.clientBillId = desiredClientBillId;
      todo.clientBilledAt = bill?.confirmedAt || "";
      todo.updatedAt = now;
      todo.updatedBy = auditActor.id;
      todo.updatedByName = auditActor.name || "";
      changed = true;
    }
    if (readyForArchive) {
      if (!todo.archivedAt || todo.archivedPayrollId !== (clientOnly ? "" : payroll.id) || todo.archivedClientBillId !== desiredClientBillId) {
        todo.archivedAt = todo.archivedAt || now;
        todo.archivedPayrollId = clientOnly ? "" : payroll.id;
        todo.archivedClientBillId = desiredClientBillId;
        todo.updatedAt = now;
        todo.updatedBy = auditActor.id;
        todo.updatedByName = auditActor.name || "";
        todo.history = [...(todo.history || []), audit(auditActor, clientOnly
          ? todo.status === "material"
            ? `arhivirano po potrjenem obračunu materiala za stranko ${bill.clientName}`
            : `arhivirano po potrjenem obračunu zapiska za stranko ${bill.clientName}`
          : needsClientBill
          ? `arhivirano po potrjenem obračunu delavca in stranke ${bill.clientName}`
          : `arhivirano po potrjenem obračunu delavca ${payroll.month}`)];
        archived += 1;
        changed = true;
      }
      continue;
    }
    if (todo.archivedAt || todo.archivedPayrollId || todo.archivedClientBillId) {
      todo.archivedAt = "";
      todo.archivedPayrollId = "";
      todo.archivedClientBillId = "";
      todo.updatedAt = now;
      todo.updatedBy = auditActor.id;
      todo.updatedByName = auditActor.name || "";
      todo.history = [...(todo.history || []), audit(auditActor, clientOnly
        ? todo.status === "material"
          ? "vrnjeno iz arhiva: manjka potrjeni obračun materiala za stranko"
          : "vrnjeno iz arhiva: manjka potrjeni obračun zapiska za stranko"
        : needsClientBill
        ? "vrnjeno iz arhiva: manjka potrjeni obračun stranki ali delavca"
        : "vrnjeno iz arhiva: manjka potrjeni obračun delavca")];
      restored += 1;
      changed = true;
    }
  }
  return { archived, restored, changed };
}

function archiveRetentionMonthsForDb(db) {
  return Math.min(120, Math.max(1, Math.round(nonnegativeNumber(db?.settings?.archive?.retentionMonths, 12, 120))));
}

function archiveRetentionCandidates(db, now = new Date()) {
  const months = archiveRetentionMonthsForDb(db);
  const cutoff = new Date(now instanceof Date ? now.getTime() : new Date(now).getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffMs = cutoff.getTime();
  const byGroup = new Map();
  for (const todo of db.todos || []) {
    if (isTrashedTodo(todo)) continue;
    const groupId = String(todo.assignmentGroupId || todo.id || "");
    if (!groupId) continue;
    const group = byGroup.get(groupId) || [];
    group.push(todo);
    byGroup.set(groupId, group);
  }
  const groups = [];
  for (const [id, todos] of byGroup) {
    const fullyArchived = todos.length > 0 && todos.every((todo) => {
      const archivedAt = new Date(String(todo.archivedAt || "")).getTime();
      return Number.isFinite(archivedAt) && archivedAt < cutoffMs;
    });
    if (!fullyArchived) continue;
    const managedDriveFiles = managedDriveFilesForTodos(todos);
    groups.push({ id, todos, managedDriveFiles });
  }
  return { retentionMonths: months, cutoffAt: cutoff.toISOString(), groups };
}

function purgeArchivedTodoGroups(db, groups) {
  const groupIds = new Set((groups || []).map((group) => String(group.id || "")).filter(Boolean));
  if (!groupIds.size) return { groups: 0, todos: 0, attachments: 0, adHocClients: 0 };
  const beforeTodos = (db.todos || []).length;
  const beforeAttachments = Object.keys(db.attachments || {}).length;
  const beforeClients = (db.clients || []).length;
  db.todos = (db.todos || []).filter((todo) => !groupIds.has(String(todo.assignmentGroupId || todo.id || "")));
  pruneUnusedTodoAttachments(db);
  pruneUnusedAdHocClients(db);
  return {
    groups: groupIds.size,
    todos: beforeTodos - db.todos.length,
    attachments: beforeAttachments - Object.keys(db.attachments || {}).length,
    adHocClients: beforeClients - (db.clients || []).length
  };
}

function payrollTodosForArchive(db, payroll) {
  const todoIds = new Set((payroll.lines || []).map((line) => String(line.todoId || "")).filter(Boolean));
  return (db.todos || []).filter((todo) => todoIds.has(String(todo.id || ""))
    && payrollWorkerForTodo(todo) === String(payroll.workerId || ""));
}

async function archivePayrollTodos(db, payroll, actor) {
  // A completed project entry is archived only after both sides are locked:
  // the worker payroll and the client bill. Internal work and meals have no
  // client side and therefore need only the worker payroll.
  const result = reconcileTodoArchives(db, actor);
  const awaitingClientBilling = payrollTodosForArchive(db, payroll)
    .filter((todo) => todoRequiresClientBilling(todo) && !todo.clientBillId)
    .length;
  return { ...result, awaitingClientBilling, archiveCalendarName: "interni arhiv" };
}

async function handlePayrollList(req, res, url) {
    if (url.pathname === "/api/payrolls" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return true;
      const db = await readRequestDb(req);
      sendJson(res, 200, { payrolls: payrollForUser(db, user) });
      return true;
    }
    return false;
}

async function handleSettlements(req, res, url) {
    if (url.pathname === "/api/client-bills" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Obračune strank vidi samo šef." });
        return true;
      }
      const db = await readRequestDb(req);
      sendJson(res, 200, { clientBills: db.clientBills || [] });
      return true;
    }

    if (url.pathname === "/api/client-bills" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Obračun stranki lahko potrdi samo šef." });
        return true;
      }
      const body = await readBody(req);
      if (body.eventIds !== undefined && !Array.isArray(body.eventIds)) {
        sendJson(res, 400, { error: "Izbrani vpisi za obračun niso pravilni." });
        return true;
      }
      if (Array.isArray(body.eventIds)) {
        body.eventIds = [...new Set(body.eventIds.map((id) => String(id || "").trim()).filter(Boolean))];
        if (!body.eventIds.length) {
          sendJson(res, 400, { error: "Označi vsaj en vpis za obračun stranki." });
          return true;
        }
        if (body.eventIds.length > 2_000) {
          sendJson(res, 400, { error: "Za en obračun lahko izbereš največ 2000 vpisov." });
          return true;
        }
      }
      if ((body.from && !isDateKey(body.from)) || (body.to && !isDateKey(body.to)) || (body.from && body.to && body.from > body.to)) {
        sendJson(res, 400, { error: "Obdobje obračuna stranki ni pravilno." });
        return true;
      }
      const db = await readRequestDb(req);
      const client = clientForBilling(db, body);
      if (!client) {
        sendJson(res, 400, { error: "Stranke ni bilo mogoče prepoznati." });
        return true;
      }
      const clientBill = buildClientBillSnapshot(db, { ...body, clientId: client.clientId, clientName: client.name }, user);
      if (!clientBill) {
        sendJson(res, 409, { error: Array.isArray(body.eventIds) ? "Eden ali več označenih vpisov ni več na voljo za obračun. Osvezi poročilo in preveri izbor." : "Za to stranko v izbranem obdobju ni novih zaključenih storitev za obračun." });
        return true;
      }
      db.clientBills.push(clientBill);
      const settledCorrections = settleCorrectionsForClientBill(db, clientBill, user);
      const archive = reconcileTodoArchives(db, user);
      await writeDbAsync(db);
      sendJson(res, 201, { clientBill, clientBills: db.clientBills, archive, settledCorrections, todos: visibleTodosForUser(db, user) });
      return true;
    }

    const clientBillDeleteMatch = /^\/api\/client-bills\/([^/]+)$/.exec(url.pathname);
    if (clientBillDeleteMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Obračun stranki lahko prekliče samo šef." });
        return true;
      }
      const db = await readRequestDb(req);
      const result = cancelClientBill(db, clientBillDeleteMatch[1], user);
      if (!result) {
        sendJson(res, 404, { error: "Potrjenega obračuna stranki ni bilo mogoče najti." });
        return true;
      }
      if (result.error) {
        sendJson(res, 409, { error: result.error });
        return true;
      }
      await writeDbAsync(db);
      sendJson(res, 200, { clientBill: result.clientBill, clientBills: db.clientBills || [], archive: result.archive, todos: visibleTodosForUser(db, user) });
      return true;
    }
    if (url.pathname === "/api/payrolls" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko potrdi obračun." });
        return true;
      }
      const body = await readBody(req);
      const workerId = cleanUserId(body.workerId);
      const range = payrollRange(body);
      if (!workerId || !range) {
        sendJson(res, 400, { error: "Delavec ali obračunsko obdobje ni pravilno." });
        return true;
      }
      if (!payrollPeriodEnded(range)) {
        sendJson(res, 409, { error: "Obračun lahko potrdiš največ do današnjega dne." });
        return true;
      }
      const db = await readRequestDb(req);
      if (!db.users?.[workerId]) {
        sendJson(res, 400, { error: "Delavec ne obstaja." });
        return true;
      }
      const existingIndex = db.payrolls.findIndex((payroll) => payroll.workerId === workerId && payroll.from === range.from && payroll.to === range.to);
      const previous = existingIndex >= 0 ? db.payrolls[existingIndex] : {};
      const sequenceError = payrollSequenceError(db, workerId, range, previous.id || "");
      if (sequenceError) {
        sendJson(res, 409, { error: sequenceError });
        return true;
      }
      if (previous.status && !["draft", "archiving"].includes(previous.status)) {
        sendJson(res, 409, { error: "Ta obračun je že potrjen ali plačan." });
        return true;
      }
      const now = new Date().toISOString();
      let payroll;
      if (previous.status === "archiving") {
        // Resume exactly the snapshot that was locked before archiving started.
        payroll = normalizePayroll({
          ...previous,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now
        }, db);
      } else {
        payroll = buildPayrollSnapshot(db, workerId, range, {
          ...previous,
          id: previous.id || moduleValues.crypto.randomUUID(),
          status: "archiving",
          createdBy: previous.createdBy || user.id,
          createdByName: previous.createdByName || user.name,
          createdAt: previous.createdAt || now,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now
        }, body.note);
      }
      if (!payroll?.lines.length) {
        sendJson(res, 400, { error: "Za izbrano obdobje delavec nima zaključenih vnosov ur." });
        return true;
      }
      if (existingIndex >= 0) db.payrolls[existingIndex] = payroll;
      else db.payrolls.push(payroll);
      // Persist the locked snapshot before final confirmation, so a retry can finish safely.
      await writeDbAsync(db);
      payroll = normalizePayroll({
        ...payroll,
        status: "confirmed",
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: new Date().toISOString(),
        confirmedAt: payroll.confirmedAt || new Date().toISOString(),
        confirmedBy: user.id,
        confirmedByName: user.name
      }, db);
      const finalIndex = db.payrolls.findIndex((item) => item.id === payroll.id);
      if (finalIndex >= 0) db.payrolls[finalIndex] = payroll;
      else db.payrolls.push(payroll);
      const settledCorrections = settleCorrectionsForPayroll(db, payroll, user);
      const archive = await archivePayrollTodos(db, payroll, user);
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user), payroll, archive, settledCorrections });
      return true;
    }
    const payrollPaymentMatch = url.pathname.match(/^\/api\/payrolls\/([^/]+)\/payments$/);
    if (payrollPaymentMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko evidentira izplačilo." });
        return true;
      }
      const body = await readBody(req);
      const amount = nonnegativeNumber(body.amount, null, 1_000_000);
      const note = String(body.note || "").trim().slice(0, 1_000);
      if (amount === null || amount <= 0) {
        sendJson(res, 400, { error: "Vnesi znesek delnega izplačila." });
        return true;
      }
      const db = await readRequestDb(req);
      const index = db.payrolls.findIndex((payroll) => payroll.id === decodeURIComponent(payrollPaymentMatch[1]));
      if (index < 0) {
        sendJson(res, 404, { error: "Obračun ne obstaja." });
        return true;
      }
      const current = normalizePayroll(db.payrolls[index], db);
      if (!current || !["confirmed", "paid"].includes(current.status)) {
        sendJson(res, 409, { error: "Delno izplačilo je mogoče vpisati samo pri potrjenem obračunu." });
        return true;
      }
      if (amount > current.remainingAmount + 0.005) {
        sendJson(res, 409, { error: `Preostanek za izplačilo je ${current.remainingAmount.toFixed(2)} EUR.` });
        return true;
      }
      const now = new Date().toISOString();
      const payments = [...current.payments, { id: moduleValues.crypto.randomUUID(), amount, note, createdAt: now, createdBy: user.id, createdByName: user.name }];
      const next = normalizePayroll({ ...current, payments, status: "confirmed", updatedAt: now, updatedBy: user.id, updatedByName: user.name }, db);
      if (next.remainingAmount <= 0.005) {
        next.status = "paid";
        next.paidAt = now;
        next.paidBy = user.id;
        next.paidByName = user.name;
      }
      db.payrolls[index] = next;
      await writeDbAsync(db);
      sendJson(res, 201, { payroll: next, payrolls: payrollForUser(db, user) });
      return true;
    }
    const payrollPaymentDeleteMatch = url.pathname.match(/^\/api\/payrolls\/([^/]+)\/payments\/([^/]+)$/);
    if (payrollPaymentDeleteMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko izbriše evidentirano izplačilo." });
        return true;
      }
      const payrollId = decodeURIComponent(payrollPaymentDeleteMatch[1]);
      const paymentId = decodeURIComponent(payrollPaymentDeleteMatch[2]);
      const db = await readRequestDb(req);
      const index = db.payrolls.findIndex((payroll) => payroll.id === payrollId);
      if (index < 0) {
        sendJson(res, 404, { error: "Obračun ne obstaja." });
        return true;
      }
      const current = normalizePayroll(db.payrolls[index], db);
      if (!current || !["confirmed", "paid"].includes(current.status)) {
        sendJson(res, 409, { error: "Izplačilo lahko izbrišeš samo pri potrjenem obračunu." });
        return true;
      }
      if (!(current.payments || []).some((payment) => payment.id === paymentId)) {
        sendJson(res, 404, { error: "Izplačilo ne obstaja." });
        return true;
      }
      const now = new Date().toISOString();
      const payroll = normalizePayroll({
        ...current,
        status: "confirmed",
        payments: current.payments.filter((payment) => payment.id !== paymentId),
        paidAt: "",
        paidBy: "",
        paidByName: "",
        updatedAt: now,
        updatedBy: user.id,
        updatedByName: user.name
      }, db);
      db.payrolls[index] = payroll;
      await writeDbAsync(db);
      sendJson(res, 200, { payroll, payrolls: payrollForUser(db, user) });
      return true;
    }
    const payrollMatch = url.pathname.match(/^\/api\/payrolls\/([^/]+)$/);
    if (payrollMatch && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko potrjuje ali odpira obračune." });
        return true;
      }
      const body = await readBody(req);
      const action = String(body.action || "refresh");
      const db = await readRequestDb(req);
      const index = db.payrolls.findIndex((payroll) => payroll.id === decodeURIComponent(payrollMatch[1]));
      if (index < 0) {
        sendJson(res, 404, { error: "Obračun ne obstaja." });
        return true;
      }
      const current = db.payrolls[index];
      const now = new Date().toISOString();
      if (action === "confirm" && !payrollPeriodEnded(current)) {
        sendJson(res, 409, { error: "Obračun lahko potrdiš največ do današnjega dne." });
        return true;
      }
      if (action === "confirm") {
        const sequenceError = payrollSequenceError(db, current.workerId, current, current.id);
        if (sequenceError) {
          sendJson(res, 409, { error: sequenceError });
          return true;
        }
      }
      let payroll;
      if (action === "refresh") {
        if (current.status !== "draft") {
          sendJson(res, 409, { error: "Potrjen obračun najprej ponovno odpri." });
          return true;
        }
        payroll = buildPayrollSnapshot(db, current.workerId, current, {
          ...current,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now
        }, body.note);
      } else if (action === "confirm") {
        if (!["draft", "archiving"].includes(current.status)) {
          sendJson(res, 409, { error: "Potrdi lahko samo odprt ali nedokončano arhiviran obračun." });
          return true;
        }
        payroll = current.status === "archiving"
          ? normalizePayroll({ ...current, updatedBy: user.id, updatedByName: user.name, updatedAt: now }, db)
          : buildPayrollSnapshot(db, current.workerId, current, {
            ...current,
            status: "archiving",
            updatedBy: user.id,
            updatedByName: user.name,
            updatedAt: now
          }, body.note);
        if (!payroll?.lines.length) {
          sendJson(res, 400, { error: "Obračun nima zaključenih vnosov ur." });
          return true;
        }
        db.payrolls[index] = payroll;
        await writeDbAsync(db);
        payroll = normalizePayroll({
          ...payroll,
          status: "confirmed",
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: new Date().toISOString(),
          confirmedAt: payroll.confirmedAt || new Date().toISOString(),
          confirmedBy: user.id,
          confirmedByName: user.name
        }, db);
      } else if (action === "paid") {
        if (current.status !== "confirmed") {
          sendJson(res, 409, { error: "Kot plačanega lahko označiš samo potrjen obračun." });
          return true;
        }
        payroll = normalizePayroll({
          ...current,
          status: "paid",
          payments: current.remainingAmount > 0.005 ? [...(current.payments || []), { id: moduleValues.crypto.randomUUID(), amount: current.remainingAmount, note: "Celotno izplačilo", createdAt: now, createdBy: user.id, createdByName: user.name }] : current.payments,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          paidAt: now,
          paidBy: user.id,
          paidByName: user.name
        }, db);
      } else if (action === "reopen") {
        if (current.status === "draft") {
          sendJson(res, 409, { error: "Obračun je že odprt za popravke." });
          return true;
        }
        const clientBill = clientBillLockForTodos(db, payrollTodosForArchive(db, current));
        if (clientBill) {
          sendJson(res, 409, { error: `Obračun vsebuje vnos, ki je že v potrjenem obračunu stranki ${clientBill.clientName}. Najprej je potreben kontroliran popravek obračuna stranki.` });
          return true;
        }
        payroll = buildPayrollSnapshot(db, current.workerId, current, {
          ...current,
          status: "draft",
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          paidAt: "",
          paidBy: "",
          paidByName: ""
        }, body.note);
      } else {
        sendJson(res, 400, { error: "Neznano dejanje obračuna." });
        return true;
      }
      if (!payroll?.lines.length) {
        sendJson(res, 400, { error: "Obračun nima zaključenih vnosov ur." });
        return true;
      }
      db.payrolls[index] = payroll;
      const settledCorrections = action === "confirm" ? settleCorrectionsForPayroll(db, payroll, user) : 0;
      const archive = ["confirm", "reopen"].includes(action) ? await archivePayrollTodos(db, payroll, user) : null;
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user), payroll, archive, settledCorrections });
      return true;
    }

    if (payrollMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko briše osnutek obračuna." });
        return true;
      }
      const db = await readRequestDb(req);
      const index = db.payrolls.findIndex((payroll) => payroll.id === decodeURIComponent(payrollMatch[1]));
      if (index < 0) {
        sendJson(res, 404, { error: "Obračun ne obstaja." });
        return true;
      }
      if (db.payrolls[index].status !== "draft") {
        sendJson(res, 409, { error: "Potrjenega obračuna ni mogoče izbrisati; najprej ga ponovno odpri." });
        return true;
      }
      const deleting = db.payrolls[index];
      const laterPayroll = db.payrolls.some((payroll) => payroll.workerId === deleting.workerId && payroll.from > deleting.to);
      if (laterPayroll) {
        sendJson(res, 409, { error: "Osnutka ne moreš izbrisati, ker bi med obračuni nastala luknja." });
        return true;
      }
      db.payrolls.splice(index, 1);
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user) });
      return true;
    }
    return false;
}

async function handleClientBillingFields(req, res, url) {
    const todoClientBillingFieldsMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/client-billing-fields$/);
    if (todoClientBillingFieldsMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Podatke za obračun stranki lahko spreminja samo šef." });
        return true;
      }
      const id = decodeURIComponent(todoClientBillingFieldsMatch[1]);
      const body = await readBody(req);
      const editableFields = ["title", "notes", "clientBillableHours", "clientKm"];
      const requested = editableFields.filter((field) => Object.hasOwn(body, field));
      if (requested.length !== 1) {
        sendJson(res, 400, { error: "Izberi natanko eno polje za hitro urejanje." });
        return true;
      }
      const field = requested[0];
      const db = await readRequestDb(req);
      const previousTodo = (db.todos || []).find((item) => String(item.id || "") === id);
      if (!previousTodo || isTrashedTodo(previousTodo)) {
        sendJson(res, 404, { error: "Opravilo ne obstaja." });
        return true;
      }
      const assignmentItems = todoAssignmentItems(db, previousTodo);
      const clientBillLock = clientBillLockForTodos(db, assignmentItems);
      if (clientBillLock) {
        sendJson(res, 403, { error: clientBillEditLockMessage(clientBillLock) });
        return true;
      }
      const editLock = todoAssignmentEditLockConflict(db, previousTodo, user, "");
      if (editLock) {
        sendJson(res, 409, { error: `Opravilo trenutno ureja ${editLock.lockedByName || editLock.lockedById}.` });
        return true;
      }
      const baseUpdatedAt = String(body.baseUpdatedAt || "");
      if (baseUpdatedAt && baseUpdatedAt !== String(previousTodo.updatedAt || "")) {
        sendJson(res, 409, { error: "Dogodek je bil medtem spremenjen na drugi napravi." });
        return true;
      }

      const changes = {};
      if (field === "title") {
        const title = capitalizeTodoText(String(body.title || "").slice(0, 300));
        if (!title) {
          sendJson(res, 400, { error: "Naslov dogodka ne sme biti prazen." });
          return true;
        }
        changes.title = title;
      } else if (field === "notes") {
        changes.notes = capitalizeTodoText(String(body.notes || "").slice(0, 10_000));
      } else {
        if (String(previousTodo.status || "") !== "execution") {
          sendJson(res, 409, { error: "Ure in strošek prevoza sta na voljo samo pri izvedeni storitvi." });
          return true;
        }
        const raw = String(body[field] ?? "").trim().replace(",", ".");
        if (!raw) {
          sendJson(res, 400, { error: field === "clientKm" ? "Vpiši kilometre ali izrecno 0." : "Vpiši ure za obračun ali izrecno 0." });
          return true;
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > (field === "clientKm" ? 1_000_000 : 16_666.67)) {
          sendJson(res, 400, { error: field === "clientKm" ? "Strošek prevoza mora biti med 0 in 1.000.000 km." : "Ure za obračun niso veljavne." });
          return true;
        }
        if (field === "clientKm") changes.clientKm = Number(value.toFixed(2));
        else changes.clientBillableMinutes = normalizedClientBillableMinutes(Math.round(value * 60));
      }

      const actionLabels = {
        title: "naslov",
        notes: "opis del",
        clientBillableHours: "ure za obračun",
        clientKm: "strošek prevoza"
      };
      const action = `spremenjeno v poročilu stranke: ${actionLabels[field]}`;
      const now = new Date().toISOString();
      const assignmentIds = new Set(assignmentItems.map((item) => String(item.id || "")));
      db.todos = db.todos.map((item) => {
        if (!assignmentIds.has(String(item.id || ""))) return item;
        const next = {
          ...item,
          ...changes,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          history: [...(item.history || []), audit(user, action)]
        };
        next.revisionHistory = appendTodoRevision(item, next, user, action, now);
        return next;
      });
      await writeDbAsync(db);
      sendJson(res, 200, { todos: visibleTodosForUser(db, user) });
      return true;
    }
    return false;
}

  return {
    signedNumber,
    latestCorrection,
    pendingCorrectionsForTodo,
    upsertSettlementCorrections,
    correctionPayrollLine,
    settleCorrectionsForPayroll,
    settleCorrectionsForClientBill,
    todoBillingEventId,
    todoRequiresClientBilling,
    clientForBilling,
    normalizeClientBill,
    cancelClientBill,
    confirmedClientBillByEvent,
    clientBillLockForTodos,
    clientBillEditLockMessage,
    clientBillCandidates,
    todoDurationHours,
    normalizedClientBillableMinutes,
    todoClientBillableMinutes,
    clientBillableMinutesForTodos,
    clientBillableHoursForTodos,
    clientBillableHoursWarning,
    buildClientBillSnapshot,
    directClientSettlementRequest,
    directClientSettlementForTodo,
    clientSettlementFromBill,
    clientSettlementForTodo,
    reconcileTodoArchives,
    archiveRetentionMonthsForDb,
    archiveRetentionCandidates,
    purgeArchivedTodoGroups,
    archivePayrollTodos,
    handlePayrollList,
    handleSettlements,
    handleClientBillingFields
  };
}

module.exports = { createSettlementService };
