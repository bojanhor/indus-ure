const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ENTRY_EDIT_LOCK_TTL_MS,
  SESSION_TTL_MS,
  TODO_EDIT_LOCK_TTL_MS,
  acquireEntryEditLock,
  acquireTodoEditLock,
  acquireTodoAssignmentEditLock,
  activeEntryEditLock,
  activeTodoEditLock,
  canManageEntry,
  canManageFinancialEntry,
  canManageTodo,
  createSession,
  buildPayrollSnapshot,
  buildClientBillSnapshot,
  clientReportSelection,
  clientReportAttachmentSelection,
  buildClientReportPdf,
  gmailDraftRaw,
  cancelClientBill,
  clientBillLockForTodos,
  reconcileTodoArchives,
  entryEditLockConflict,
  sourceTodoForNewEntry,
  entryForUserRole,
  defaultHourlyRateForUser,
  normalizeDb,
  normalizePayroll,
  payrollForUser,
  payrollSequenceError,
  payrollLockForTodos,
  payrollPeriodEnded,
  releaseEntryEditLock,
  releaseTodoEditLock,
  releaseTodoAssignmentEditLock,
  todoAssignmentAssigneeIds,
  todoAssignmentEditLockConflict,
  ownsTodoAssignmentEditLock,
  todoAssignmentItems,
  revokeSession,
  sessionForToken,
  sessionTokenHash,
  syncUserForRequest,
  todoAssigneeForUpdate,
  todoAssigneesForRequest,
  todoEditLockConflict,
  todoForUserRole,
  validTodoAttachmentDataUrl,
  visibleDebtsForUser,
  visibleEntriesForUser,
  visibleTodosForUser,
  payrollMinutesForTodo
} = require("../outputs/server");

const boss = { id: "bojan", role: "boss" };
const worker = { id: "ibro", role: "worker" };
const db = {
  entries: [
    { id: "e1", syncUser: "ibro" },
    { id: "e2", syncUser: "bojan" }
  ],
  todos: [
    { id: "t1", syncUser: "ibro" },
    { id: "t2", syncUser: "bojan" }
  ],
  debts: [
    { id: "d1", person: "ibro" },
    { id: "d2", person: "bojan" }
  ]
};

test("šef vidi vse, delavec pa samo svoje podatke", () => {
  assert.equal(visibleEntriesForUser(db, boss).length, 2);
  assert.deepEqual(visibleEntriesForUser(db, worker).map((item) => item.id), ["e1"]);
  assert.deepEqual(visibleTodosForUser(db, worker).map((item) => item.id), ["t1"]);
  assert.deepEqual(visibleDebtsForUser(db, worker).map((item) => item.id), ["d1"]);
});

test("malica se delavcu plača največ do nastavljene meje", () => {
  const meal = { status: "meal", date: "2026-07-20", start: "12:00", end: "13:00" };
  assert.equal(payrollMinutesForTodo({ settings: { billing: { mealPaidMinutes: 45 } } }, meal), 45);
  assert.equal(payrollMinutesForTodo({ settings: { billing: { mealPaidMinutes: 45 } } }, { ...meal, end: "12:30" }), 30);
});

test("vsako opravilo dobi skriti skupni ID dogodka", () => {
  const legacyDb = {
    users: {},
    entries: [],
    todos: [{ id: "legacy-todo", title: "Staro opravilo", status: "open", syncUser: "ibro" }],
    debts: [],
    clients: []
  };
  const result = normalizeDb(legacyDb);
  assert.equal(result.changed, true);
  assert.equal(legacyDb.todos[0].assignmentGroupId, "legacy-todo");
});
test("vsak delavec vidi vse dodeljene osebe skupnega opravila", () => {
  const groupedDb = {
    todos: [
      { id: "shared-ibro", assignmentGroupId: "shared", syncUser: "ibro" },
      { id: "shared-bojan", assignmentGroupId: "shared", syncUser: "bojan" }
    ]
  };
  const visible = visibleTodosForUser(groupedDb, worker);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].assigneeIds, ["ibro", "bojan"]);
  assert.deepEqual(todoAssignmentAssigneeIds(groupedDb, visible[0]), ["ibro", "bojan"]);
  assert.deepEqual(todoAssignmentItems(groupedDb, visible[0]).map((item) => item.id), ["shared-ibro", "shared-bojan"]);
});

test("seje preživijo restart in v bazi ne hranijo dejanskega žetona", () => {
  const now = 10_000;
  const sessionDb = { sessions: {} };
  const token = createSession(sessionDb, "bojan", now);
  const hash = sessionTokenHash(token);

  assert.equal(token.length, 64);
  assert.equal(hash.length, 64);
  assert.equal(Object.hasOwn(sessionDb.sessions, token), false);
  const session = sessionForToken(sessionDb, token, now + 1);
  assert.equal(session.userId, "bojan");
  assert.equal(session.expiresAt, now + SESSION_TTL_MS);
  assert.match(session.csrfToken, /^[a-f0-9]{48}$/);

  const restoredDb = JSON.parse(JSON.stringify(sessionDb));
  assert.equal(sessionForToken(restoredDb, token, now + 2)?.userId, "bojan");
  assert.equal(sessionForToken(restoredDb, token, now + SESSION_TTL_MS), null);
  assert.equal(revokeSession(restoredDb, token), true);
  assert.equal(sessionForToken(restoredDb, token, now + 3), null);
});

test("delavec ne more upravljati tujih vnosov ali opravil", () => {
  assert.equal(canManageEntry(worker, db.entries[0]), true);
  assert.equal(canManageEntry(worker, db.entries[1]), false);
  assert.equal(canManageTodo(worker, db.todos[0]), true);
  assert.equal(canManageTodo(worker, db.todos[1]), false);
  const users = { bojan: boss, ibro: worker, marko: { id: "marko", role: "worker" } };
  assert.equal(syncUserForRequest(worker, "bojan", "bojan", users), "ibro");
  assert.equal(syncUserForRequest(boss, "ibro", "", users), "ibro");
  assert.equal(syncUserForRequest(boss, "marko", "", users), "marko");
  assert.equal(syncUserForRequest(boss, "ne-obstaja", "marko", users), "marko");
  assert.deepEqual(todoAssigneesForRequest(worker, ["ibro", "marko", "ibro"], users), ["ibro", "marko"]);
  assert.deepEqual(todoAssigneesForRequest(worker, ["bojan"], users), ["bojan"]);
  assert.deepEqual(todoAssigneesForRequest(worker, [], users), ["ibro"]);
  assert.deepEqual(todoAssigneesForRequest(worker, ["ne-obstaja"], users), ["ibro"]);
});

test("lastnik opravila ga lahko preda veljavnemu delavcu", () => {
  const users = { bojan: boss, ibro: worker, marko: { id: "marko", role: "worker" } };
  assert.equal(todoAssigneeForUpdate(worker, "marko", "ibro", users), "marko");
  assert.equal(todoAssigneeForUpdate(worker, "ne-obstaja", "ibro", users), "ibro");
  assert.equal(todoAssigneeForUpdate(boss, "ibro", "bojan", users), "ibro");
});

test("delavski vnos ne more nastaviti obračuna ali računa", () => {
  const created = entryForUserRole(worker, {
    syncUser: "bojan",
    status: "billed",
    invoiceSent: true,
    invoiceSettled: true,
    invoicePaid: true
  });
  assert.equal(created.syncUser, "ibro");
  assert.equal(created.status, "unbilled");
  assert.equal(created.invoiceSent, false);
  assert.equal(created.invoiceSettled, false);
  assert.equal(created.invoicePaid, false);

  const existing = entryForUserRole(worker, { ...created, status: "warranty" }, {
    status: "billed",
    invoiceSent: true,
    invoiceSettled: true,
    invoicePaid: false
  });
  assert.equal(existing.status, "billed");
  assert.equal(existing.invoiceSent, true);
  assert.equal(existing.invoiceSettled, true);

  assert.equal(existing.invoicePaid, false);
});
test("delavec v zaključenem vnosu ur lahko navede kilometrino za stranko", () => {
  const billingDb = {
    users: {
      bojan: { id: "bojan", role: "boss", billing: { hourlyRate: 25 } },
      ibro: { id: "ibro", role: "worker", billing: { hourlyRate: 18 } }
    },
    settings: { billing: { hourlyRate: 15, kmRate: 0.22, workerOwnVehicleKmRate: 0.37, clientPersonalKmRate: 0.34, clientVanKmRate: 0.48 } }
  };
  const previous = {
    id: "t1",
    syncUser: "ibro",
    status: "execution",
    billingHourlyRate: 22,
    billingKm: 5,
    clientKm: 18,
    clientVehicle: "van"
  };

  assert.equal(defaultHourlyRateForUser(billingDb, "ibro"), 18);

  const workerChange = todoForUserRole(worker, billingDb, previous, {
    ...previous,
    billingHourlyRate: 999,
    billingKm: 999,
    clientKm: 999,
    clientVehicle: "personal",
    warranty: true
  });
  assert.equal(workerChange.billingHourlyRate, 22);
  assert.equal(workerChange.billingKm, 999);
  assert.equal(workerChange.clientKm, 999);
  assert.equal(workerChange.clientVehicle, "personal");
  assert.equal(workerChange.clientKmRate, 0);
  assert.equal(workerChange.warranty, true);

  const bossChange = todoForUserRole(boss, billingDb, previous, {
    ...previous,
    billingHourlyRate: 30,
    billingKm: 12.5,
    clientKm: 24,
    clientVehicle: "personal"
  });
  assert.equal(bossChange.billingHourlyRate, 30);
  assert.equal(bossChange.billingKm, 12.5);
  assert.equal(bossChange.clientKm, 24);
  assert.equal(bossChange.clientVehicle, "personal");
  assert.equal(bossChange.clientKmRate, 0);

  const newlyCompleted = todoForUserRole(worker, billingDb, null, {
    syncUser: "ibro",
    status: "execution",
    billingHourlyRate: 500,
    billingKm: 100,
    clientKm: 36,
    clientVehicle: "van",
    warranty: true
  });
  assert.equal(newlyCompleted.billingHourlyRate, 18);
  assert.equal(newlyCompleted.billingKm, 100);
  assert.equal(newlyCompleted.clientKm, 36);
  assert.equal(newlyCompleted.clientVehicle, "van");
  assert.equal(newlyCompleted.clientKmRate, 0);
  assert.equal(newlyCompleted.warranty, true);

  const ordinaryTask = todoForUserRole(worker, billingDb, previous, {
    ...previous,
    status: "open",
    warranty: true,
    clientKm: 999,
    clientVehicle: "personal"
  });
  assert.equal(ordinaryTask.clientKm, 18);
  assert.equal(ordinaryTask.clientVehicle, "van");
  assert.equal(ordinaryTask.warranty, false);
});

test("nov koledarski vnos mora izvirati iz lastnega opravila z istim datumom", () => {
  const sourceDb = {
    todos: [
      { id: "own", syncUser: "ibro", date: "2026-07-15" },
      { id: "other", syncUser: "bojan", date: "2026-07-15" }
    ],
    entries: []
  };
  const ownEntry = { sourceTodoId: "own", date: "2026-07-15" };

  assert.equal(sourceTodoForNewEntry(sourceDb, worker, ownEntry)?.id, "own");
  assert.equal(sourceTodoForNewEntry(sourceDb, worker, { ...ownEntry, date: "2026-07-16" }), null);
  assert.equal(sourceTodoForNewEntry(sourceDb, worker, { sourceTodoId: "other", date: "2026-07-15" }), null);
  assert.equal(sourceTodoForNewEntry(sourceDb, boss, { sourceTodoId: "other", date: "2026-07-15" })?.id, "other");

  sourceDb.entries.push({ id: "entry", sourceTodoId: "own" });
  assert.equal(sourceTodoForNewEntry(sourceDb, worker, ownEntry), null);
});

test("koledarski vnos lahko istočasno ureja samo en uporabnik ali zavihek", () => {
  const entryId = "entry-lock-test";
  const bojan = { id: "bojan", name: "Bojan", role: "boss" };
  const ibro = { id: "ibro", name: "Ibro", role: "worker" };
  const startedAt = 1_000;

  const first = acquireEntryEditLock(entryId, bojan, "", startedAt);
  assert.equal(first.ok, true);
  assert.ok(first.token);
  assert.equal(activeEntryEditLock(entryId, startedAt + 1)?.userId, "bojan");

  const otherUser = acquireEntryEditLock(entryId, ibro, "", startedAt + 2);
  assert.equal(otherUser.ok, false);
  assert.equal(otherUser.lock.lockedByName, "Bojan");
  assert.equal(acquireEntryEditLock(entryId, bojan, "", startedAt + 3).ok, false);
  assert.equal(entryEditLockConflict(entryId, bojan, first.token, startedAt + 4), null);
  assert.equal(entryEditLockConflict(entryId, ibro, "", startedAt + 4)?.lockedById, "bojan");
  assert.equal(releaseEntryEditLock(entryId, ibro, "", startedAt + 5), false);
  assert.equal(releaseEntryEditLock(entryId, bojan, first.token, startedAt + 5), true);
  assert.equal(activeEntryEditLock(entryId, startedAt + 6), null);

  const expiring = acquireEntryEditLock(entryId, bojan, "", startedAt + 10);
  assert.equal(expiring.ok, true);
  const afterExpiry = acquireEntryEditLock(entryId, ibro, "", startedAt + 10 + ENTRY_EDIT_LOCK_TTL_MS + 1);
  assert.equal(afterExpiry.ok, true);
  assert.equal(afterExpiry.lock.lockedByName, "Ibro");
  assert.equal(releaseEntryEditLock(entryId, ibro, afterExpiry.token, startedAt + 10 + ENTRY_EDIT_LOCK_TTL_MS + 2), true);
});

test("isto opravilo lahko istočasno ureja samo en uporabnik ali zavihek", () => {
  const todoId = "todo-lock-test";
  const bojan = { id: "bojan", name: "Bojan", role: "boss" };
  const ibro = { id: "ibro", name: "Ibro", role: "worker" };
  const startedAt = 2_000;

  const first = acquireTodoEditLock(todoId, bojan, "", startedAt);
  assert.equal(first.ok, true);
  assert.ok(first.token);
  assert.equal(activeTodoEditLock(todoId, startedAt + 1)?.userId, "bojan");

  const otherUser = acquireTodoEditLock(todoId, ibro, "", startedAt + 2);
  assert.equal(otherUser.ok, false);
  assert.equal(otherUser.lock.lockedByName, "Bojan");
  assert.equal(acquireTodoEditLock(todoId, bojan, "", startedAt + 3).ok, false);
  assert.equal(acquireTodoEditLock(todoId, bojan, first.token, startedAt + 3).ok, true);
  assert.equal(todoEditLockConflict(todoId, bojan, first.token, startedAt + 4), null);
  assert.equal(todoEditLockConflict(todoId, bojan, "", startedAt + 4)?.lockedById, "bojan");
  assert.equal(todoEditLockConflict(todoId, ibro, "", startedAt + 4)?.lockedById, "bojan");
  assert.equal(releaseTodoEditLock(todoId, ibro, "", startedAt + 5), false);
  assert.equal(releaseTodoEditLock(todoId, bojan, first.token, startedAt + 5), true);
  assert.equal(activeTodoEditLock(todoId, startedAt + 6), null);

  const expiring = acquireTodoEditLock(todoId, bojan, "", startedAt + 10);
  assert.equal(expiring.ok, true);
  const afterExpiry = acquireTodoEditLock(todoId, ibro, "", startedAt + 10 + TODO_EDIT_LOCK_TTL_MS + 1);
  assert.equal(afterExpiry.ok, true);
  assert.equal(afterExpiry.lock.lockedByName, "Ibro");
  assert.equal(releaseTodoEditLock(todoId, ibro, afterExpiry.token, startedAt + 10 + TODO_EDIT_LOCK_TTL_MS + 2), true);
});

test("zaklep skupnega opravila velja za vse dodeljene delavce", () => {
  const groupDb = {
    todos: [
      { id: "group-ibro", assignmentGroupId: "group", syncUser: "ibro" },
      { id: "group-bojan", assignmentGroupId: "group", syncUser: "bojan" }
    ]
  };
  const bojan = { id: "bojan", name: "Bojan", role: "boss" };
  const ibro = { id: "ibro", name: "Ibro", role: "worker" };
  const startedAt = 5_000;
  const lock = acquireTodoAssignmentEditLock(groupDb, groupDb.todos[0], ibro, "", startedAt);
  assert.equal(lock.ok, true);
  assert.equal(activeTodoEditLock("group-ibro", startedAt + 1)?.token, lock.token);
  assert.equal(activeTodoEditLock("group-bojan", startedAt + 1)?.token, lock.token);
  assert.equal(todoAssignmentEditLockConflict(groupDb, groupDb.todos[1], bojan, "", startedAt + 2)?.lockedById, "ibro");
  assert.equal(ownsTodoAssignmentEditLock(groupDb, groupDb.todos[0], ibro, lock.token, startedAt + 2), true);
  assert.equal(ownsTodoAssignmentEditLock(groupDb, groupDb.todos[0], ibro, "wrong-token", startedAt + 2), false);
  assert.equal(releaseTodoAssignmentEditLock(groupDb, groupDb.todos[0], ibro, lock.token, startedAt + 3), true);
  assert.equal(activeTodoEditLock("group-ibro", startedAt + 4), null);
  assert.equal(activeTodoEditLock("group-bojan", startedAt + 4), null);
});

test("priloge sprejmejo pravi PDF in zavrnejo preimenovano datoteko", () => {
  const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.7\n%%EOF").toString("base64")}`;
  assert.equal(validTodoAttachmentDataUrl(pdf), true);
  const disguised = `data:application/pdf;base64,${Buffer.from("<html>ni pdf</html>").toString("base64")}`;
  assert.equal(validTodoAttachmentDataUrl(disguised), false);
  const html = `data:text/html;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`;
  assert.equal(validTodoAttachmentDataUrl(html), false);
});

test("obračun naredi nespremenljiv posnetek ur posameznega delavca", () => {
  const db = {
    users: {
      bojan: { id: "bojan", name: "Bojan", role: "boss", billing: { hourlyRate: 25 } },
      ibro: { id: "ibro", name: "Ibro", role: "worker", billing: { hourlyRate: 18 } }
    },
    settings: { billing: { hourlyRate: 15, kmRate: 0.22, workerOwnVehicleKmRate: 0.37, clientPersonalKmRate: 0.35, clientVanKmRate: 0.48 } },
    payrolls: [],
    todos: [
      { id: "t-ibro", assignmentGroupId: "g-1", syncUser: "ibro", status: "execution", date: "2026-07-15", start: "08:00", end: "10:30", title: "Montaža", client: "Jerin", billingHourlyRate: 20, billingKm: 12 },
      { id: "t-malica", syncUser: "ibro", status: "meal", date: "2026-07-15", start: "10:30", end: "11:15", title: "Malica", billingKm: 0 },
      { id: "t-bojan", syncUser: "bojan", status: "execution", date: "2026-07-15", start: "08:00", end: "09:00", title: "Pregled", billingHourlyRate: 25, billingKm: 0 },
      { id: "t-open", syncUser: "ibro", status: "open", date: "2026-07-15", start: "10:30", end: "11:30", title: "Odprto" },
      { id: "t-order", syncUser: "ibro", status: "order", date: "2026-07-15", start: "11:30", end: "12:00", title: "Naroči material", billingHourlyRate: 18, billingKm: 30 },
      { id: "t-progress", syncUser: "ibro", status: "in_progress", date: "2026-07-15", start: "12:00", end: "13:00", title: "V teku", billingHourlyRate: 18, billingKm: 30 }
    ]
  };
  const draft = buildPayrollSnapshot(db, "ibro", "2026-07", { id: "p-1", status: "draft" });
  assert.equal(draft.lines.length, 2);
  assert.equal(draft.minutes, 195);
  assert.equal(draft.hours, 3.25);
  assert.equal(draft.workAmount, 63.5);
  assert.equal(draft.kmAmount, 4.44);
  assert.equal(draft.totalAmount, 67.94);
  db.payrolls = [{ ...draft, status: "confirmed" }];
  assert.equal(payrollLockForTodos(db, [db.todos[0]])?.id, "p-1");
  assert.equal(payrollLockForTodos(db, [db.todos[1]])?.id, "p-1");
  assert.deepEqual(payrollForUser(db, db.users.ibro).map((payroll) => payroll.id), ["p-1"]);
  assert.equal(payrollForUser(db, db.users.bojan).length, 1);
});
test("delna izplačila se seštejejo in zmanjšajo preostanek", () => {
  const db = { users: { ibro: { id: "ibro" } } };
  const payroll = normalizePayroll({
    workerId: "ibro", from: "2026-07-01", to: "2026-07-31", status: "confirmed",
    lines: [{ todoId: "t1", minutes: 60, hourlyRate: 20 }],
    payments: [{ id: "pay-1", amount: 7.5, note: "akontacija" }]
  }, db);
  assert.equal(payroll.payoutAmount, 20);
  assert.equal(payroll.paidAmount, 7.5);
  assert.equal(payroll.remainingAmount, 12.5);
});
test("obračun podpira poljubno obdobje in prišteje založen denar", () => {
  const db = {
    users: { ibro: { id: "ibro", billing: { hourlyRate: 20 } } },
    settings: { billing: { workerOwnVehicleKmRate: 0.22 } },
    payrolls: [],
    debts: [{ id: "a-1", type: "advance", person: "ibro", date: "2026-07-17", amount: 12.5 }],
    todos: [
      { id: "before", syncUser: "ibro", status: "execution", date: "2026-07-14", start: "08:00", end: "09:00", title: "Pred" },
      { id: "inside", syncUser: "ibro", status: "execution", date: "2026-07-16", start: "08:00", end: "10:00", title: "V obdobju" },
      { id: "after", syncUser: "ibro", status: "execution", date: "2026-07-19", start: "08:00", end: "09:00", title: "Po" }
    ]
  };
  const payroll = buildPayrollSnapshot(db, "ibro", { from: "2026-07-15", to: "2026-07-18" }, { status: "draft" });
  assert.deepEqual(payroll.lines.map((line) => line.todoId), ["inside"]);
  assert.equal(payroll.advanceAmount, 12.5);
  assert.equal(payroll.payoutAmount, 52.5);
});
test("osebni nakup se odšteje od izplačila delavca", () => {
  const db = {
    users: { ibro: { id: "ibro", billing: { hourlyRate: 20 } } },
    settings: { billing: { workerOwnVehicleKmRate: 0.22 } },
    payrolls: [],
    debts: [{ id: "purchase-1", type: "personal_purchase", person: "ibro", date: "2026-07-17", amount: 7.5 }],
    todos: [{ id: "inside", syncUser: "ibro", status: "execution", date: "2026-07-16", start: "08:00", end: "10:00", title: "V obdobju" }]
  };
  const payroll = buildPayrollSnapshot(db, "ibro", { from: "2026-07-15", to: "2026-07-18" }, { status: "draft" });
  assert.deepEqual(payroll.personalPurchaseIds, ["purchase-1"]);
  assert.equal(payroll.personalPurchaseAmount, 7.5);
  assert.equal(payroll.payoutAmount, 32.5);
});
test("obračun je mogoče potrditi šele po koncu izbranega meseca", () => {
  assert.equal(payrollPeriodEnded("2026-07", new Date("2026-07-31T12:00:00Z")), false);
  assert.equal(payrollPeriodEnded("2026-07", new Date("2026-08-01T12:00:00Z")), true);
  assert.equal(payrollPeriodEnded("2026-08", new Date("2026-08-01T12:00:00Z")), false);
});
test("obračunska obdobja delavca morajo biti neprekinjena", () => {
  const payrollDb = {
    payrolls: [
      { id: "june", workerId: "ibro", from: "2026-06-01", to: "2026-06-30", status: "confirmed" }
    ]
  };
  assert.equal(payrollSequenceError(payrollDb, "ibro", { from: "2026-07-01", to: "2026-07-31" }), "");
  assert.match(payrollSequenceError(payrollDb, "ibro", { from: "2026-08-01", to: "2026-08-31" }), /Začetek obračuna mora biti 2026-07-01/);
  assert.match(payrollSequenceError(payrollDb, "ibro", { from: "2026-05-01", to: "2026-05-31" }), /Starejšega obračuna/);
  assert.match(payrollSequenceError(payrollDb, "ibro", { from: "2026-06-15", to: "2026-07-15" }), /prekrivata/);
});

test("delavec lahko založeni znesek ali osebni nakup ureja samo na dan vnosa, šef pa vedno", () => {
  const entry = { person: "ibro", date: "2026-07-19" };
  const sameDay = new Date("2026-07-19T12:00:00+02:00");
  const nextDay = new Date("2026-07-20T12:00:00+02:00");
  assert.equal(canManageFinancialEntry(worker, entry, sameDay), true);
  assert.equal(canManageFinancialEntry(worker, entry, nextDay), false);
  assert.equal(canManageFinancialEntry(worker, { ...entry, person: "bojan" }, sameDay), false);
  assert.equal(canManageFinancialEntry(boss, { ...entry, date: "2020-01-01" }, nextDay), true);
});
test("zaključeno projektno opravilo se arhivira šele po obračunu delavca in stranke", () => {
  const db = {
    users: { bojan: { id: "bojan", name: "Bojan", role: "boss" }, ibro: { id: "ibro", name: "Ibro", role: "worker" } },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    payrolls: [{ id: "payroll-ibro", workerId: "ibro", status: "confirmed", month: "2026-07", lines: [{ todoId: "work-1" }] }],
    clientBills: [],
    todos: [{ id: "work-1", assignmentGroupId: "project-1", syncUser: "ibro", status: "execution", date: "2026-07-15", start: "08:00", end: "10:00", title: "Montaža", clientId: "jerin", client: "Jerin" }]
  };

  const beforeClientBill = reconcileTodoArchives(db, boss);
  assert.equal(beforeClientBill.archived, 0);
  assert.equal(db.todos[0].archivedAt, undefined);

  const clientBill = buildClientBillSnapshot(db, { clientId: "jerin", from: "2026-07-01", to: "2026-07-31" }, boss);
  assert.ok(clientBill);
  assert.deepEqual(clientBill.eventIds, ["project-1"]);
  db.clientBills.push(clientBill);

  const afterBoth = reconcileTodoArchives(db, boss);
  assert.equal(afterBoth.archived, 1);
  assert.ok(db.todos[0].archivedAt);
  assert.equal(db.todos[0].archivedPayrollId, "payroll-ibro");
  assert.equal(db.todos[0].archivedClientBillId, clientBill.id);
  assert.equal(clientBillLockForTodos(db, db.todos)?.id, clientBill.id);
  assert.equal(buildClientBillSnapshot(db, { clientId: "jerin" }, boss), null);
});

test("obračun stranki vsebuje samo označene dogodke", () => {
  const db = {
    users: { bojan: { id: "bojan", name: "Bojan", role: "boss" } },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    payrolls: [],
    clientBills: [],
    todos: [
      { id: "work-a", assignmentGroupId: "project-a", syncUser: "bojan", status: "execution", date: "2026-07-15", start: "08:00", end: "09:00", title: "A", clientId: "jerin", client: "Jerin" },
      { id: "work-b", assignmentGroupId: "project-b", syncUser: "bojan", status: "execution", warranty: true, date: "2026-07-16", start: "08:00", end: "09:00", title: "B", clientId: "jerin", client: "Jerin" }
    ]
  };

  const selected = buildClientBillSnapshot(db, { clientId: "jerin", eventIds: ["project-b"] }, boss);
  assert.ok(selected);
  assert.deepEqual(selected.eventIds, ["project-b"]);
  assert.equal(selected.lines[0].warranty, true);
  assert.equal(buildClientBillSnapshot(db, { clientId: "jerin", eventIds: ["ne-obstaja"] }, boss), null);
});
test("prevoz za stranko obdrži samo kilometre brez denarne tarife", () => {
  const billingDb = {
    users: { bojan: { id: "bojan", name: "Bojan", role: "boss" } },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    settings: { billing: { kmRate: 0.42, clientVanKmRate: 0, clientPersonalKmRate: 0 } },
    payrolls: [],
    clientBills: [],
    todos: [{
      id: "work-km", assignmentGroupId: "project-km", syncUser: "bojan", status: "execution",
      date: "2026-07-15", start: "08:00", end: "09:00", title: "Servis", clientId: "jerin", client: "Jerin",
      clientKm: 20, clientVehicle: "van", clientKmRate: 0
    }]
  };
  const bill = buildClientBillSnapshot(billingDb, { clientId: "jerin", eventIds: ["project-km"] }, boss);
  assert.equal(bill.lines[0].clientKmRate, 0);
});
test("izvoz poročila sprejme samo izbrane dogodke in njihove priloge", async () => {
  const attachmentId = "a".repeat(64);
  const db = {
    users: { bojan: { id: "bojan", name: "Bojan", role: "boss" } },
    clients: [{ clientId: "jerin", name: "Jerin", email: "stranka@example.com", search: "jerin" }],
    payrolls: [],
    clientBills: [],
    todos: [{
      id: "work-a", assignmentGroupId: "project-a", syncUser: "bojan", status: "execution",
      date: "2026-07-15", start: "08:00", end: "10:00", title: "Montaža", clientId: "jerin", client: "Jerin",
      photos: [{ id: "photo-a", attachmentId, name: "dokaz.jpg" }]
    }]
  };
  const report = clientReportSelection(db, { clientId: "jerin", eventIds: ["project-a"] });
  assert.equal(report.groups.length, 1);
  const attachments = clientReportAttachmentSelection(report, [attachmentId]);
  assert.equal(attachments.length, 1);
  assert.throws(() => clientReportAttachmentSelection(report, ["b".repeat(64)]), /ne pripada/);
  const pdf = await buildClientReportPdf(db, report, []);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  const linkedPdf = await buildClientReportPdf(db, report, [{ ...attachments[0], mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff]), filename: "dokaz.jpg", driveUrl: "https://drive.google.com/file/d/test-photo/view" }]);
  assert.match(linkedPdf.toString("latin1"), /drive\.google\.com/);
  const raw = Buffer.from(gmailDraftRaw({
    to: "stranka@example.com",
    pdf,
    pdfFilename: "obračun.pdf",
    attachments: []
  }), "base64url").toString("utf8");
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /Content-Type: application\/pdf/);
});
test("preklic obračuna stranki odklene in vrne arhiviran dogodek", () => {
  const db = {
    users: { bojan: { id: "bojan", name: "Bojan", role: "boss" }, ibro: { id: "ibro", name: "Ibro", role: "worker" } },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    payrolls: [{ id: "payroll-ibro", workerId: "ibro", status: "confirmed", month: "2026-07", lines: [{ todoId: "work-1" }] }],
    clientBills: [],
    todos: [{ id: "work-1", assignmentGroupId: "project-1", syncUser: "ibro", status: "execution", date: "2026-07-15", start: "08:00", end: "10:00", title: "Montaža", clientId: "jerin", client: "Jerin" }]
  };
  const bill = buildClientBillSnapshot(db, { clientId: "jerin", eventIds: ["project-1"] }, boss);
  db.clientBills.push(bill);
  reconcileTodoArchives(db, boss);
  assert.ok(db.todos[0].archivedAt);

  const result = cancelClientBill(db, bill.id, boss);
  assert.ok(result);
  assert.equal(result.clientBill.status, "cancelled");
  normalizeDb(db);
  assert.equal(db.clientBills[0].status, "cancelled");
  assert.equal(result.archive.restored, 1);
  assert.equal(db.todos[0].archivedAt, "");
  assert.equal(db.todos[0].clientBillId, "");
  assert.equal(clientBillLockForTodos(db, db.todos), null);
});
test("skupni dogodek ostane aktiven, dokler obračun ni potrjen za vsakega izvajalca", () => {
  const db = {
    users: {
      bojan: { id: "bojan", name: "Bojan", role: "boss" },
      ibro: { id: "ibro", name: "Ibro", role: "worker" },
      maja: { id: "maja", name: "Maja", role: "worker" }
    },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    payrolls: [{ id: "payroll-ibro", workerId: "ibro", status: "confirmed", month: "2026-07", lines: [{ todoId: "work-ibro" }] }],
    clientBills: [],
    todos: [
      { id: "work-ibro", assignmentGroupId: "project-shared", syncUser: "ibro", status: "execution", date: "2026-07-15", start: "08:00", end: "10:00", title: "Montaža", clientId: "jerin", client: "Jerin" },
      { id: "work-maja", assignmentGroupId: "project-shared", syncUser: "maja", status: "execution", date: "2026-07-15", start: "08:00", end: "10:00", title: "Montaža", clientId: "jerin", client: "Jerin" }
    ]
  };
  db.clientBills.push(buildClientBillSnapshot(db, { clientId: "jerin" }, boss));
  reconcileTodoArchives(db, boss);
  assert.ok(db.todos[0].archivedAt);
  assert.equal(db.todos[1].archivedAt, undefined);
  assert.equal(db.todos[1].clientBillId, db.clientBills[0].id);
});

test("migracija vrne prezgodaj arhivirano projektno opravilo, dokler obračun stranki ne obstaja", () => {
  const db = {
    users: { ibro: { id: "ibro", name: "Ibro", role: "worker" } },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    payrolls: [{ id: "payroll-ibro", workerId: "ibro", status: "confirmed", month: "2026-07", lines: [{ todoId: "legacy-work" }] }],
    todos: [{ id: "legacy-work", assignmentGroupId: "legacy-project", syncUser: "ibro", status: "execution", done: true, date: "2026-07-15", start: "08:00", end: "10:00", title: "Montaža", clientId: "jerin", client: "Jerin", archivedAt: "2026-07-31T10:00:00.000Z", archivedPayrollId: "payroll-ibro" }]
  };
  const normalized = normalizeDb(db);
  assert.equal(normalized.changed, true);
  assert.equal(db.todos[0].archivedAt, "");
  assert.equal(db.todos[0].archivedPayrollId, "");
});