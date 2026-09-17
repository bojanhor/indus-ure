"use strict";
const crypto = require("node:crypto");

// Payroll domain rules; settlement orchestration/HTTP are in settlement-service.js.
function createPayrollRules({ isDateKey, nonnegativeNumber, defaultHourlyRateForUser, cleanUserId, signedNumber, isTrashedTodo, correctionPayrollLine, PAYROLL_STATUSES, PAYROLL_PAID_TODO_STATUSES }) {
// BEGIN preserved payroll rules
function payrollRange(input = {}) {
  input = typeof input === "string" ? { month: input } : (input || {});
  const month = String(input.month || "");
  const legacyMonth = isPayrollMonth(month) ? month : "";
  const from = isDateKey(input.from) ? String(input.from) : (legacyMonth ? `${legacyMonth}-01` : "");
  const to = isDateKey(input.to)
    ? String(input.to)
    : (legacyMonth ? `${legacyMonth}-${String(new Date(Number(legacyMonth.slice(0, 4)), Number(legacyMonth.slice(5, 7)), 0).getDate()).padStart(2, "0")}` : "");
  return from && to && from <= to ? { from, to, month: legacyMonth || from.slice(0, 7) } : null;
}

function payrollNextDate(key) {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

// A worker's payroll periods form an inclusive, contiguous timeline. Each
// calendar day therefore belongs to exactly one payroll: the next period must
// begin on the day after the previous one ends.
function payrollSequenceError(db, workerId, rangeInput, excludeId = "") {
  const range = payrollRange(rangeInput);
  if (!range) return "Obračunsko obdobje ni pravilno.";
  const records = (db.payrolls || [])
    .filter((payroll) => payroll.workerId === workerId && payroll.id !== excludeId)
    .map((payroll) => ({ ...payroll, range: payrollRange(payroll) }))
    .filter((payroll) => payroll.range)
    .map((payroll) => ({ id: payroll.id, from: payroll.range.from, to: payroll.range.to }));
  if (!records.length) return "";
  const earliest = records.slice().sort((left, right) => left.from.localeCompare(right.from))[0];
  if (range.to < earliest.from) return "Starejšega obračuna pred prvim obstoječim obračunom ni mogoče dodati.";
  records.push({ id: excludeId || "candidate", from: range.from, to: range.to });
  records.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    const nextDay = payrollNextDate(previous.to);
    if (current.from <= previous.to) return "Obra\u010dunski obdobji se prekrivata.";
    if (current.from > nextDay) return "Za\u010detek obra\u010duna mora biti " + nextDay + ".";
  }
  return "";
}
function isPayrollMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  return Boolean(match && Number(match[2]) >= 1 && Number(match[2]) <= 12);
}
function payrollPeriodEnded(value, now = new Date()) {
  if (typeof value === "object" && value) {
    const range = payrollRange(value);
    if (!range) return false;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Ljubljana", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    return range.to <= today;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const localParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Ljubljana",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const year = Number(match[1]);
  const month = Number(match[2]);
  const currentYear = Number(localParts.year || 0);
  const currentMonth = Number(localParts.month || 0);
  return year < currentYear || (year === currentYear && month < currentMonth);
}
function scheduledPayrollMinutesForTodo(todo) {
  if (!todo || !/^\d{4}-\d{2}-\d{2}$/.test(String(todo.date || ""))) return null;
  const start = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(todo.start || ""));
  const end = todo.end === "24:00" ? ["24:00", "24", "00"] : /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(todo.end || ""));
  if (!start || !end) return null;
  const minutes = (Number(end[1]) * 60 + Number(end[2])) - (Number(start[1]) * 60 + Number(start[2]));
  return minutes > 0 ? minutes : null;
}

function payrollMinutesForTodo(db, todo) {
  if (!todo || !PAYROLL_PAID_TODO_STATUSES.has(todo.status)) return null;
  const minutes = scheduledPayrollMinutesForTodo(todo);
  if (!minutes) return null;
  if (todo.status === "meal") {
    const mealPaidMinutes = Math.round(nonnegativeNumber(db?.settings?.billing?.mealPaidMinutes, 45, 240));
    return Math.min(minutes, mealPaidMinutes) || null;
  }
  return minutes;
}

function payrollLineForTodo(db, todo, workerId = "") {
  const minutes = payrollMinutesForTodo(db, todo);
  if (!minutes) return null;
  const scheduledMinutes = scheduledPayrollMinutesForTodo(todo) || minutes;
  const unpaidMealMinutes = todo.status === "meal" ? Math.max(0, scheduledMinutes - minutes) : 0;
  const hourlyRate = nonnegativeNumber(todo.billingHourlyRate, defaultHourlyRateForUser(db, todo.syncUser || todo.createdBy), 10_000);
  const workerKm = nonnegativeNumber(todo.billingKm, 0, 1_000_000);
  // Kilometrina delavca je povračilo za njegovo lastno vozilo.
  // Ne sme se mešati s tarifo, ki se zaračuna stranki za kombi ali osebni avto.
  const kmRate = nonnegativeNumber(
    db.settings?.billing?.workerOwnVehicleKmRate,
    nonnegativeNumber(db.settings?.billing?.kmRate, 0, 1_000),
    1_000
  );
  const hours = minutes / 60;
  const workAmount = Number((hours * hourlyRate).toFixed(2));
  const kmAmount = Number((workerKm * kmRate).toFixed(2));
  return {
    todoId: String(todo.id || ""),
    assignmentGroupId: String(todo.assignmentGroupId || todo.id || ""),
    workerId: String(workerId || todo.syncUser || todo.createdBy || ""),
    date: String(todo.date || ""),
    start: String(todo.start || ""),
    end: String(todo.end || ""),
    title: String(todo.title || "").slice(0, 300),
    client: String(todo.client || "").slice(0, 240),
    status: String(todo.status || ""),
    minutes,
    unpaidMealMinutes,
    hours,
    hourlyRate,
    workerKm,
    workFromHome: Boolean(todo.workFromHome),
    commuteEligible: Boolean(todo.commuteEligible),
    commuteKm: 0,
    km: workerKm,
    kmRate,
    workAmount,
    kmAmount,
    totalAmount: Number((workAmount + kmAmount).toFixed(2))
  };
}

function commuteKmOneWayForUser(db, userId) {
  return nonnegativeNumber(db.users?.[userId]?.billing?.commuteKmOneWay, 0, 1_000_000);
}

// Each worker gets the commute reimbursement once for a worked day, never once
// per task. It is attached to the first chronological line so the immutable
// payroll snapshot remains compatible with the existing task-based archive.
function withDailyCommuteInPayroll(db, workerId, lines = []) {
  const commuteKm = Number((commuteKmOneWayForUser(db, workerId) * 2).toFixed(2));
  if (!commuteKm) return lines;
  const appliedDates = new Set();
  return lines.map((line) => {
    const workerKm = nonnegativeNumber(line.workerKm, nonnegativeNumber(line.km, 0, 1_000_000), 1_000_000);
    // A remote entry is paid normally, but it cannot trigger the daily commute.
    // Do not mark its date as used so the first later on-site entry still gets
    // the one return journey reimbursement.
    // A meal is paid time but never represents a journey to work.  It must
    // neither receive the daily commute nor consume that day's commute slot.
    const addCommute = line.status !== "meal" && Boolean(line.commuteEligible) && !Boolean(line.workFromHome) && !appliedDates.has(line.date);
    if (addCommute) appliedDates.add(line.date);
    const lineCommuteKm = addCommute ? commuteKm : 0;
    const km = Number((workerKm + lineCommuteKm).toFixed(2));
    const kmAmount = Number((km * Number(line.kmRate || 0)).toFixed(2));
    return {
      ...line,
      workerKm,
      workFromHome: Boolean(line.workFromHome),
      commuteKm: lineCommuteKm,
      km,
      kmAmount,
      totalAmount: Number((Number(line.workAmount || 0) + kmAmount).toFixed(2))
    };
  });
}

function payrollTotals(lines = []) {
  const minutes = lines.reduce((total, line) => total + Number(line.minutes || 0), 0);
  const workAmount = Number(lines.reduce((total, line) => total + Number(line.workAmount || 0), 0).toFixed(2));
  const km = Number(lines.reduce((total, line) => total + Number(line.km || 0), 0).toFixed(2));
  const kmAmount = Number(lines.reduce((total, line) => total + Number(line.kmAmount || 0), 0).toFixed(2));
  return {
    minutes,
    hours: minutes / 60,
    km,
    workAmount,
    kmAmount,
    totalAmount: Number((workAmount + kmAmount).toFixed(2))
  };
}

function payrollAdvances(db, workerId, range) {
  return (db.debts || []).filter((item) => item.type === "advance" && item.person === workerId && item.date >= range.from && item.date <= range.to);
}

function payrollPersonalPurchases(db, workerId, range) {
  return (db.debts || []).filter((item) => item.type === "personal_purchase" && item.person === workerId && item.date >= range.from && item.date <= range.to);
}

function payrollClientReceipts(db, workerId, range) {
  return (db.debts || []).filter((item) => item.type === "client_receipt" && item.person === workerId && item.date >= range.from && item.date <= range.to);
}

function payrollWorkerForTodo(todo) {
  return String(todo?.syncUser || todo?.createdBy || "").trim();
}

function normalizePayroll(input, db) {
  const workerId = cleanUserId(input?.workerId);
  const range = payrollRange(input);
  if (!workerId || !db.users?.[workerId] || !range) return null;
  const lines = (Array.isArray(input?.lines) ? input.lines : []).map((line) => {
    const correction = Boolean(line?.correction || line?.correctionId);
    const minutes = Math.round(Number(line?.minutes || 0));
    const hourlyRate = nonnegativeNumber(line?.hourlyRate, null, 10_000);
    const commuteKm = correction ? signedNumber(line?.commuteKm) : nonnegativeNumber(line?.commuteKm, 0, 1_000_000);
    const workerKm = correction ? signedNumber(line?.workerKm) : nonnegativeNumber(line?.workerKm, Math.max(0, nonnegativeNumber(line?.km, 0, 1_000_000) - commuteKm), 1_000_000);
    const km = correction ? signedNumber(line?.km, workerKm + commuteKm) : Number((workerKm + commuteKm).toFixed(2));
    const kmRate = nonnegativeNumber(line?.kmRate, 0, 1_000);
    if (!String(line?.todoId || "") || (!correction && minutes <= 0) || (correction && !Number.isFinite(minutes)) || hourlyRate === null) return null;
    const scheduledMinutes = correction ? null : scheduledPayrollMinutesForTodo(line);
    const unpaidMealMinutes = !correction && String(line?.status || "") === "meal"
      ? Math.max(0, Number.isFinite(scheduledMinutes) ? scheduledMinutes - minutes : Math.round(Number(line?.unpaidMealMinutes || 0)))
      : 0;
    const hours = correction ? signedNumber(line?.hours, minutes / 60) : minutes / 60;
    const workAmount = correction ? signedNumber(line?.workAmount, hours * hourlyRate) : Number((hours * hourlyRate).toFixed(2));
    const kmAmount = correction ? signedNumber(line?.kmAmount, km * kmRate) : Number((km * kmRate).toFixed(2));
    return {
      todoId: String(line.todoId),
      sourceTodoId: correction ? String(line?.sourceTodoId || "") : "",
      correctionId: correction ? String(line?.correctionId || "") : "",
      correction,
      assignmentGroupId: String(line.assignmentGroupId || line.todoId),
      workerId,
      date: String(line.date || ""),
      start: String(line.start || ""),
      end: String(line.end || ""),
      title: String(line.title || "").slice(0, 300),
      client: String(line.client || "").slice(0, 240),
      status: String(line.status || ""),
      minutes,
      unpaidMealMinutes,
      hours,
      hourlyRate,
      workerKm,
      workFromHome: Boolean(line?.workFromHome),
      commuteKm,
      km,
      kmRate,
      workAmount: Number(workAmount.toFixed(2)),
      kmAmount: Number(kmAmount.toFixed(2)),
      totalAmount: Number((correction ? signedNumber(line?.totalAmount, workAmount + kmAmount) : workAmount + kmAmount).toFixed(2))
    };
  }).filter(Boolean);
  const totals = payrollTotals(lines);
  const advanceIds = [...new Set((Array.isArray(input?.advanceIds) ? input.advanceIds : []).map(String).filter(Boolean))];
  const advanceAmount = Number((Number(input?.advanceAmount || 0)).toFixed(2));
  const clientReceiptIds = [...new Set((Array.isArray(input?.clientReceiptIds) ? input.clientReceiptIds : []).map(String).filter(Boolean))];
  const clientReceiptAmount = Number((Number(input?.clientReceiptAmount || 0)).toFixed(2));
  const personalPurchaseIds = [...new Set((Array.isArray(input?.personalPurchaseIds) ? input.personalPurchaseIds : []).map(String).filter(Boolean))];
  const personalPurchaseAmount = Number((Number(input?.personalPurchaseAmount || 0)).toFixed(2));
  const status = PAYROLL_STATUSES.has(input?.status) ? input.status : "draft";
  const payments = (Array.isArray(input?.payments) ? input.payments : []).map((payment) => {
    const amount = nonnegativeNumber(payment?.amount, null, 1_000_000);
    if (amount === null || amount <= 0) return null;
    return { id: String(payment?.id || crypto.randomUUID()), amount: Number(amount.toFixed(2)), note: String(payment?.note || "").trim().slice(0, 1_000), createdAt: String(payment?.createdAt || new Date().toISOString()), createdBy: String(payment?.createdBy || "system"), createdByName: String(payment?.createdByName || "") };
  }).filter(Boolean);
  const createdAt = String(input?.createdAt || new Date().toISOString());
  return finalizePayrollAmounts({
    id: String(input?.id || crypto.randomUUID()),
    workerId,
    month: range.month,
    from: range.from,
    to: range.to,
    status,
    note: String(input?.note || "").trim().slice(0, 2_000),
    lines,
    advanceIds,
    advanceAmount,
    clientReceiptIds,
    clientReceiptAmount,
    personalPurchaseIds,
    personalPurchaseAmount,
    payoutAmount: Number((totals.totalAmount + advanceAmount + clientReceiptAmount - personalPurchaseAmount).toFixed(2)),
    payments,
    paidAmount: Number((status === "paid" && payments.length === 0 ? Math.max(0, totals.totalAmount + advanceAmount + clientReceiptAmount - personalPurchaseAmount) : payments.reduce((sum, payment) => sum + payment.amount, 0)).toFixed(2)),
    remainingAmount: 0,
    ...totals,
    createdBy: String(input?.createdBy || "system"),
    createdByName: String(input?.createdByName || ""),
    createdAt,
    updatedBy: String(input?.updatedBy || input?.createdBy || "system"),
    updatedByName: String(input?.updatedByName || input?.createdByName || ""),
    updatedAt: String(input?.updatedAt || createdAt),
    confirmedAt: String(input?.confirmedAt || ""),
    confirmedBy: String(input?.confirmedBy || ""),
    confirmedByName: String(input?.confirmedByName || ""),
    paidAt: String(input?.paidAt || ""),
    paidBy: String(input?.paidBy || ""),
    paidByName: String(input?.paidByName || "")
  });
}

function finalizePayrollAmounts(payroll) {
  payroll.payoutAmount = Number(Number(payroll.payoutAmount || 0).toFixed(2));
  if (payroll.payoutAmount <= 0) {
    payroll.paidAmount = 0;
    payroll.remainingAmount = payroll.payoutAmount;
    return payroll;
  }
  payroll.paidAmount = Math.min(payroll.payoutAmount, Math.max(0, Number(payroll.paidAmount || 0)));
  payroll.remainingAmount = Number((payroll.payoutAmount - payroll.paidAmount).toFixed(2));
  return payroll;
}
function lockedPayrollLineTodoIds(db, excludeId = "", workerId = "") {
  return new Set((db.payrolls || [])
    .filter((payroll) => payroll.id !== excludeId
      && ["archiving", "confirmed", "paid"].includes(payroll.status)
      && (!workerId || String(payroll.workerId || "") === String(workerId)))
    .flatMap((payroll) => payroll.lines || [])
    .map((line) => String(line.todoId || ""))
    .filter(Boolean));
}

function lockedPayrollFinancialIds(db, field, excludeId = "") {
  return new Set((db.payrolls || [])
    .filter((payroll) => payroll.id !== excludeId && ["archiving", "confirmed", "paid"].includes(payroll.status))
    .flatMap((payroll) => Array.isArray(payroll[field]) ? payroll[field] : [])
    .map((id) => String(id || ""))
    .filter(Boolean));
}
function buildPayrollSnapshot(db, workerId, rangeInput, previous = {}, note = undefined) {
  const range = payrollRange(rangeInput);
  if (!range) return null;
  // A task transferred after a confirmed account remains available to its new
  // worker. The former worker is balanced by a separate correction row.
  const lockedElsewhere = lockedPayrollLineTodoIds(db, previous.id, workerId);
  const lockedAdvanceIds = lockedPayrollFinancialIds(db, "advanceIds", previous.id);
  const lockedClientReceiptIds = lockedPayrollFinancialIds(db, "clientReceiptIds", previous.id);
  const lockedPersonalPurchaseIds = lockedPayrollFinancialIds(db, "personalPurchaseIds", previous.id);
  const taskLines = withDailyCommuteInPayroll(db, workerId, (db.todos || [])
    .filter((todo) => !todo.imported && !isTrashedTodo(todo) && (todo.syncUser || todo.createdBy) === workerId && !todo.archivedAt && String(todo.date || "") >= range.from && String(todo.date || "") <= range.to)
    .filter((todo) => !lockedElsewhere.has(String(todo.id || "")))
    .map((todo) => payrollLineForTodo(db, todo, workerId))
    .filter(Boolean));
  const correctionLines = (db.settlementCorrections || [])
    .filter((correction) => correction.type === "worker" && correction.status === "pending" && String(correction.workerId || "") === workerId)
    .filter((correction) => String(correction.effectiveDate || "") >= range.from && String(correction.effectiveDate || "") <= range.to)
    .map(correctionPayrollLine)
    .filter((line) => !lockedElsewhere.has(String(line.todoId || "")));
  const lines = [...taskLines, ...correctionLines]
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  const advances = payrollAdvances(db, workerId, range)
    .filter((item) => !lockedAdvanceIds.has(String(item.id || "")));
  const clientReceipts = payrollClientReceipts(db, workerId, range)
    .filter((item) => !lockedClientReceiptIds.has(String(item.id || "")));
  const personalPurchases = payrollPersonalPurchases(db, workerId, range)
    .filter((item) => !lockedPersonalPurchaseIds.has(String(item.id || "")));
  return normalizePayroll({ ...previous, workerId, ...range, lines, advanceIds: advances.map((item) => item.id), advanceAmount: advances.reduce((total, item) => total + Number(item.amount || 0), 0), clientReceiptIds: clientReceipts.map((item) => item.id), clientReceiptAmount: clientReceipts.reduce((total, item) => total + Number(item.amount || 0), 0), personalPurchaseIds: personalPurchases.map((item) => item.id), personalPurchaseAmount: personalPurchases.reduce((total, item) => total + Number(item.amount || 0), 0), note: note === undefined ? previous.note : note }, db);
}

function payrollForUser(db, user) {
  const payrolls = db.payrolls || [];
  return user.role === "boss" ? payrolls : payrolls.filter((payroll) => payroll.workerId === user.id);
}

function payrollLockForTodos(db, todos = []) {
  const todoWorkerById = new Map(todos
    .filter(Boolean)
    .map((todo) => [String(todo.id || ""), payrollWorkerForTodo(todo)])
    .filter(([id, workerId]) => id && workerId));
  if (!todoWorkerById.size) return null;
  return (db.payrolls || []).find((payroll) => ["archiving", "confirmed", "paid"].includes(payroll.status)
    && (payroll.lines || []).some((line) => String(payroll.workerId || "") === todoWorkerById.get(String(line.todoId || "")))) || null;
}
// END preserved payroll rules
  return { payrollRange, payrollNextDate, payrollSequenceError, isPayrollMonth, payrollPeriodEnded, scheduledPayrollMinutesForTodo, payrollMinutesForTodo, payrollLineForTodo, commuteKmOneWayForUser, withDailyCommuteInPayroll, payrollTotals, payrollAdvances, payrollPersonalPurchases, payrollClientReceipts, payrollWorkerForTodo, normalizePayroll, finalizePayrollAmounts, lockedPayrollLineTodoIds, lockedPayrollFinancialIds, buildPayrollSnapshot, payrollForUser, payrollLockForTodos };
}

module.exports = { createPayrollRules };
