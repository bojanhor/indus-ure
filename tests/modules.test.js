"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createStorage } = require("../outputs/storage");
const { createAttachmentModel } = require("../outputs/attachment-model");
const { createPayrollRules } = require("../outputs/payroll-rules");
const { renderAppShell } = require("../outputs/app-shell");

test("contact links recognize phones, emails and URLs without linking dates, amounts, tax IDs or executable markup", () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../outputs/editor/contact-links.js"), "utf8"), context);
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const links = context.createContactLinks({ escapeHtml });
  const html = links.render('041 123 456; +386 (0)41 234 567; servis@example.si; https://example.si/a?q=1&b=2; www.example.si.');
  assert.match(html, /href="tel:041123456"/);
  assert.match(html, /href="tel:\+38641234567"/);
  assert.match(html, /href="mailto:servis@example.si"/);
  assert.match(html, /href="https:\/\/www.example.si"/);
  assert.match(html, /q=1&amp;b=2/);
  assert.match(html, /rel="noopener noreferrer"/);
  for (const value of ['23. 9. 2026', '2026-09-23', '08:00-09:00', '12345678', '1500,00 EUR', '1,5 h', 'javascript:alert(1)', '<img src=x onerror="alert(1)">']) {
    assert.equal(links.matches(value).length, 0, value);
    assert.doesNotMatch(links.render(value), /<img|<script|href=/);
  }
});

function storageFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indus-module-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let audits = 0;
  const users = { ibro: { name: "Ibro" } };
  const storage = createStorage({
    DATABASE_URL: "", MEDIA_DIR: path.join(dir, "media"), dataDir: dir,
    dbFile: path.join(dir, "db.json"), defaultUsers: users,
    normalizeDb: (db) => ({ db, changed: false }),
    ensureAuditLogStore: async () => {}, ensureWorkerDigestRunStore: async () => {},
    appendUndoJournalForMutation: () => { audits++; }, undoProtectedAttachmentIds: () => new Set()
  });
  return { storage, users, dir, audits: () => audits };
}

test("storage factory is inert and independent; initial users are copied", (t) => {
  const a = storageFixture(t), b = storageFixture(t);
  assert.equal(fs.existsSync(path.join(a.dir, "db.json")), false);
  const initial = a.storage.initialDatabaseState();
  initial.users.ibro.name = "Changed";
  assert.equal(a.users.ibro.name, "Ibro");
  assert.equal(b.storage.initialDatabaseState().users.ibro.name, "Ibro");
  assert.notEqual(initial.calendarToken, b.storage.initialDatabaseState().calendarToken);
});

test("storage request cache is local; mutation keeps audit and revision semantics", async (t) => {
  const { storage, audits } = storageFixture(t);
  const first = {}, second = {};
  const db = await storage.readRequestDb(first);
  assert.equal(await storage.readRequestDb(first), db);
  assert.notEqual(await storage.readRequestDb(second), db);
  db.todos.push({ id: "example" });
  await storage.writeDbAsync(db);
  assert.equal(audits(), 1);
  assert.equal((await storage.readDbAsync()).syncRevision, 1);
  assert.equal((await storage.readDbAsync()).todos[0].id, "example");
});

function payrollRules() {
  return createPayrollRules({
    isDateKey: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || ""),
    nonnegativeNumber: (value, fallback, max) => Number.isFinite(Number(value)) && value != null ? Math.max(0, Math.min(max, Number(value))) : fallback,
    defaultHourlyRateForUser: () => 10, cleanUserId: (id) => id,
    signedNumber: (value) => Number(value), isTrashedTodo: (todo) => !!todo.trashedAt,
    correctionPayrollLine: () => null,
    PAYROLL_STATUSES: new Set(["draft", "archiving", "confirmed", "paid"]),
    PAYROLL_PAID_TODO_STATUSES: new Set(["execution", "drive", "purchase", "meal"])
  });
}

test("payroll module keeps inclusive boundaries and refuses overlapping periods", () => {
  const rules = payrollRules();
  assert.deepEqual(rules.payrollRange("2026-07"), { from: "2026-07-01", to: "2026-07-31", month: "2026-07" });
  const db = { payrolls: [{ id: "july", workerId: "ibro", month: "2026-07" }] };
  assert.equal(rules.payrollSequenceError(db, "ibro", { from: "2026-08-01", to: "2026-08-31" }), "");
  assert.notEqual(rules.payrollSequenceError(db, "ibro", { from: "2026-07-31", to: "2026-08-31" }), "");
});

test("payroll module retains meal cap, independent rate and one commute per day", () => {
  const rules = payrollRules();
  const db = { settings: { billing: { mealPaidMinutes: 45, workerOwnVehicleKmRate: 0.22 } }, users: { ibro: { billing: { commuteKmOneWay: 5 } } } };
  const base = { id: "meal", syncUser: "ibro", date: "2026-07-25", start: "08:00", end: "09:00", status: "meal", billingHourlyRate: 15, commuteEligible: true };
  const meal = rules.payrollLineForTodo(db, base);
  assert.equal(meal.workAmount, 11.25);
  assert.equal(meal.unpaidMealMinutes, 15);
  const work = rules.payrollLineForTodo(db, { ...base, id: "work", status: "execution", billingHourlyRate: 10 });
  const lines = rules.withDailyCommuteInPayroll(db, "ibro", [meal, work, { ...work, todoId: "later" }]);
  assert.deepEqual(lines.map((line) => line.commuteKm), [0, 10, 0]);
  assert.equal(rules.payrollTotals(lines).totalAmount, 33.45);
});

function attachments() {
  return createAttachmentModel({ MAX_TODO_IMAGE_DATA_LENGTH: 1024, MAX_TODO_PDF_DATA_LENGTH: 1024, MAX_TODO_ATTACHMENTS_DATA_LENGTH: 2048, MAX_TODO_THUMBNAIL_DATA_LENGTH: 1024, MAX_TODO_ATTACHMENTS: 40 });
}

test("attachment module checks signatures and keeps hydration metadata-only", () => {
  const model = attachments();
  const data = "data:image/png;base64," + Buffer.from([137,80,78,71,13,10,26,10]).toString("base64");
  assert.equal(model.validTodoAttachmentDataUrl(data), true);
  assert.equal(model.validTodoAttachmentDataUrl("data:image/png;base64,aGVsbG8="), false);
  const db = {};
  const todo = model.storeTodoAttachments(db, { id: "task", photos: [{ data, thumbnailData: data, name: "photo.png" }] }, { id: "ibro" });
  assert.equal(todo.photos.length, 1);
  assert.equal(todo.photos[0].attachmentId, model.todoAttachmentContentId(data));
  const photo = model.hydrateTodoAttachments(db, todo).photos[0];
  assert.equal(photo.data, "");
  assert.equal(photo.thumbnailData, "");
  assert.equal(photo.url, `/api/attachments/${todo.photos[0].attachmentId}`);
  assert.equal(photo.thumbnailUrl, `${photo.url}/thumbnail`);
});

test("attachment module preserves staged ownership and the 40-file limit", () => {
  const model = attachments(), id = "a".repeat(64);
  const db = { attachments: { [id]: { storageKey: "photo" } }, settings: { pendingAttachments: { [id]: { userId: "ibro", expiresAt: Date.now() + 60000 } } } };
  const todo = { photos: Array.from({ length: 45 }, () => ({ attachmentId: id })) };
  assert.equal(model.storeTodoAttachments(db, todo, { id: "bojan" }).photos.length, 0);
  assert.equal(model.storeTodoAttachments(db, todo, { id: "ibro" }).photos.length, 40);
  assert.equal(db.settings.pendingAttachments[id], undefined);
});

function editorFixture() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../outputs/editor/time-entry.js"), "utf8"), context);
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: "", textContent: "", dataset: {}, disabled: false,
        classList: { contains: (name) => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) }, setAttribute() {} });
    }
    return nodes.get(id);
  };
  const state = { user: { id: "ibro" } }, stored = new Map();
  const editor = context.createTimeEntryEditor({ $, state,
    parseBillingNumber: (value) => Number(value.replace(",", ".")),
    clearFormValidationError() {}, updateTodoFormLateTimeEntryNotice() {},
    localStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) }
  });
  return { editor, $, state, stored, context };
}

test("editor keeps manual client hours independent from worker time", () => {
  const { editor, $ } = editorFixture();
  $("todoFormStart").value = "08:00";
  $("todoFormEnd").value = "09:30";
  editor.syncTodoFormClientBillableHours();
  assert.equal($("todoFormClientBillableHours").value, "1,5");
  $("todoFormClientBillableHours").dataset.manual = "true";
  $("todoFormClientBillableHours").value = "2,5";
  $("todoFormEnd").value = "11:00";
  editor.syncTodoFormClientBillableHours();
  assert.equal(editor.todoFormClientBillableMinutes(), 150);
  assert.equal($("todoFormClientBillableHours").value, "2,5");
  assert.match($("todoFormClientBillableHoursNote").textContent, /ne bo spremenila/);
  editor.syncTodoFormClientBillableHours({ reset: true });
  assert.equal($("todoFormClientBillableHours").value, "3");
});

test("editor selection keeps suggested end time, duration and remembered user time", () => {
  const { editor, $, stored } = editorFixture();
  $("todoFormStart").value = "08:00";
  $("todoFormEnd").value = "09:00";
  $("todoFormEnd").dataset.autoSuggested = "true";
  editor.setTodoFormQuickTime("start", { hour: 10, minute: 15 });
  assert.equal($("todoFormEnd").value, "11:15");
  assert.equal($("todoFormQuickTimeDuration").textContent, "Skupaj 1 h");
  assert.equal(stored.get("indus-ure-last-time-ibro"), "10:15");
  editor.setTodoFormQuickTime("end", { hour: 12, minute: 45 });
  assert.equal($("todoFormEnd").dataset.autoSuggested, "false");
  assert.equal(editor.todoTimePickerDurationLabel(), "Skupaj 2 h 30 min");
});

test("app shell assembles exactly once without another script request", () => {
  const template = fs.readFileSync(path.join(__dirname, "../outputs/index.html"), "utf8");
  const html = renderAppShell(template);
  assert.equal((html.match(/function createTimeEntryEditor\(/g) || []).length, 1);
  assert.doesNotMatch(html, /@indus-module:/);
  assert.equal((html.match(/<script\b/g) || []).length, (template.match(/<script\b/g) || []).length);
  assert.throws(() => renderAppShell(html), /exactly one/);
  assert.throws(() => renderAppShell(template + "/* @indus-module:time-entry-editor */"), /exactly one/);
});

test("time picker preserves edited duration and caps at same-day midnight without changing manual client hours", () => {
  const { editor, $, state } = editorFixture();
  $("todoFormStart").value = "08:15";
  $("todoFormEnd").value = "10:45";
  $("todoFormClientBillableHours").dataset.manual = "true";
  $("todoFormClientBillableHours").value = "4";
  editor.setTodoFormQuickTime("start", { hour: 12 });
  editor.setTodoFormQuickTime("start", { minute: 30 });
  assert.equal($("todoFormEnd").value, "15:00");
  editor.setTodoFormQuickTime("start", { hour: 23 });
  editor.setTodoFormQuickTime("start", { minute: 0 });
  assert.equal($("todoFormEnd").value, "24:00");
  assert.equal(editor.todoFormWorkerMinutes(), 60);
  assert.equal($("todoFormQuickTimeEnd").textContent, "Do 24:00");
  assert.equal($("todoFormClientBillableHours").value, "4");
  assert.equal(state.todoTimeShiftDuration, null);
  editor.normalizeTodoFormTimes();
  assert.equal($("todoFormEnd").value, "24:00");
});

test("payroll counts midnight as the end of the same day", () => {
  const rules = createPayrollRules({ PAYROLL_PAID_TODO_STATUSES: new Set(["execution"]) });
  const todo = { date: "2026-09-17", start: "23:00", end: "24:00", status: "execution" };
  assert.equal(rules.scheduledPayrollMinutesForTodo(todo), 60);
  assert.equal(rules.payrollMinutesForTodo({}, todo), 60);
  assert.equal(rules.scheduledPayrollMinutesForTodo({ ...todo, end: "24:15" }), null);
});
