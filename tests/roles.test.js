const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ENTRY_EDIT_LOCK_TTL_MS,
  SESSION_TTL_MS,
  TODO_STATUS_DEFINITIONS,
  TODO_EDIT_LOCK_TTL_MS,
  acquireEntryEditLock,
  acquireTodoEditLock,
  acquireTodoAssignmentEditLock,
  activeEntryEditLock,
  activeTodoEditLock,
  canManageEntry,
  canManageFinancialEntry,
  canManageTodo,
  canRecordHoursFor,
  timeEntryTargetIds,
  normalizeWorkerProfile,
  workerHasBusinessData,
  applySharedManualTodoOrder,
  sharedManualTodoGroups,
  preserveTimeEntrySourceProject,
  createSession,
  buildPayrollSnapshot,
  upsertSettlementCorrections,
  buildClientBillSnapshot,
  clientBillableMinutesForTodos,
  clientBillableHoursWarning,
  clientReportSelection,
  clientReportAttachmentSelection,
  attachmentContentDisposition,
  serverRuntimeStatus,
  buildClientReportPdf,
  gmailDraftRaw,
  gmailCompletionRequestRaw,
  cleanTodoCompletionRequests,
  todoCompletionRequestsForAssignment,
  findActiveTodoCompletionRequest,
  cleanTodo,
  cancelClientBill,
  directClientSettlementForTodo,
  clientSettlementForTodo,
  clientBillLockForTodos,
  reconcileTodoArchives,
  archiveRetentionCandidates,
  purgeArchivedTodoGroups,
  entryEditLockConflict,
  sourceTodoForNewEntry,
  entryForUserRole,
  defaultHourlyRateForUser,
  importedTodoWasEdited,
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
  payrollMinutesForTodo,
  validateTodo
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

test("vo\u017enja in nabava sta obra\u010dunljiva vnosa ur", () => {
  const db = { settings: { billing: { mealPaidMinutes: 45 } } };
  for (const status of ["drive", "purchase"]) {
    const todo = { title: "Vnos ur", status, date: "2026-07-20", start: "08:00", end: "09:00" };
    assert.equal(payrollMinutesForTodo(db, todo), 60);
    assert.equal(validateTodo(todo), "");
  }
  assert.match(validateTodo({ title: "Vnos ur", status: "drive", date: "", start: "", end: "" }), /datum ter uro/);
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
test("naročila uporabljajo ločeno potrditev namesto statusa naročeno", () => {
  assert.equal(TODO_STATUS_DEFINITIONS.order.label, "Naro\u010di-projekt");
  assert.equal(Object.hasOwn(TODO_STATUS_DEFINITIONS, "ordered"), false);

  const database = {
    users: {}, entries: [], debts: [], clients: [],
    todos: [
      { id: "legacy-ordered", title: "Ventil", status: "ordered", syncUser: "ibro" },
      { id: "keep-car", title: "V avto", status: "add_to_car", syncUser: "ibro" }
    ]
  };
  normalizeDb(database);
  assert.deepEqual(database.todos.map((todo) => [todo.status, todo.ordered]), [["order", true], ["add_to_car", false]]);
});
test("legacy vračila ostanejo veljavna, poračun pa je samostojen status", () => {
  assert.equal(TODO_STATUS_DEFINITIONS.return_and_bill.label, "Vrne naj");
  assert.equal(TODO_STATUS_DEFINITIONS.bill.label, "Poračunaj");
  assert.equal(TODO_STATUS_DEFINITIONS.bill.googleColorId, "6");
  assert.equal(TODO_STATUS_DEFINITIONS.return.label, "Vrni");

  const database = {
    users: {}, entries: [], debts: [], clients: [],
    todos: [
      { id: "legacy-return", title: "Staro vračilo", status: "return", syncUser: "ibro" },
      { id: "legacy-return-and-bill", title: "Stari poračun", status: "return_and_bill", syncUser: "ibro" },
      { id: "new-bill", title: "Novi poračun", status: "bill", syncUser: "ibro" }
    ]
  };
  normalizeDb(database);
  assert.deepEqual(database.todos.map((todo) => todo.status), ["return", "return_and_bill", "bill"]);
});
test("osebni predal opravil je ločen po delavcu in varno normaliziran", () => {
  const database = {
    users: {}, entries: [], debts: [], clients: [],
    todos: [{
      id: "bucket-task", title: "Servis", status: "open", syncUser: "ibro",
      userOrderBuckets: { ibro: "unsorted", bojan: "sorted", invalid: "outside" }
    }]
  };
  normalizeDb(database);
  assert.deepEqual(database.todos[0].userOrderBuckets, { ibro: "unsorted", bojan: "sorted" });
});

test("ro\u010dni vrstni red se enkratno preseli iz \u0161efove prioritete na celotno opravilo", () => {
  const database = {
    users: { bojan: boss, ibro: worker }, entries: [], debts: [], clients: [],
    todos: [
      { id: "a-ibro", assignmentGroupId: "a", status: "open", syncUser: "ibro", order: 8, userOrders: { bojan: 3 }, userOrderBuckets: { bojan: "unsorted" } },
      { id: "a-bojan", assignmentGroupId: "a", status: "open", syncUser: "bojan", order: 12, userOrders: { bojan: 3 }, userOrderBuckets: { bojan: "unsorted" } },
      { id: "b-bojan", assignmentGroupId: "b", status: "open", syncUser: "bojan", order: 4, userOrders: { bojan: 1 }, userOrderBuckets: { bojan: "sorted" } }
    ]
  };
  normalizeDb(database);
  assert.deepEqual(
    database.todos.filter((todo) => todo.assignmentGroupId === "a").map((todo) => [todo.sharedManualOrder, todo.sharedManualBucket]),
    [[3, "unsorted"], [3, "unsorted"]]
  );
  assert.deepEqual(database.todos.find((todo) => todo.assignmentGroupId === "b")?.sharedManualOrder, 1);
});

test("delavec spremeni skupni vrstni red samo v svojih vidnih re\u017eah", () => {
  const database = {
    users: { bojan: boss, ibro: worker }, todoEditLocks: {}, entries: [], debts: [], clients: [],
    todos: [
      { id: "a-ibro", assignmentGroupId: "a", status: "open", syncUser: "ibro", sharedManualBucket: "unsorted", sharedManualOrder: 1, history: [] },
      { id: "b-bojan", assignmentGroupId: "b", status: "open", syncUser: "bojan", sharedManualBucket: "unsorted", sharedManualOrder: 2, history: [] },
      { id: "c-ibro", assignmentGroupId: "c", status: "open", syncUser: "ibro", sharedManualBucket: "unsorted", sharedManualOrder: 3, history: [] },
      { id: "c-bojan", assignmentGroupId: "c", status: "open", syncUser: "bojan", sharedManualBucket: "unsorted", sharedManualOrder: 3, history: [] }
    ]
  };
  const result = applySharedManualTodoOrder(database, { ...worker, name: "Ibro" }, {
    sourceId: "c-ibro", targetId: "a-ibro", placement: "before"
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(sharedManualTodoGroups(database, { domain: "active" }).map((group) => group.id), ["c", "b", "a"]);
  assert.deepEqual(
    database.todos.filter((todo) => todo.assignmentGroupId === "c").map((todo) => [todo.sharedManualOrder, todo.sharedManualBucket]),
    [[1, "unsorted"], [1, "unsorted"]],
    "Vse dodelitve istega opravila morajo dobiti isti skupni rang."
  );
  assert.deepEqual(
    sharedManualTodoGroups({ ...database, todos: database.todos.filter((todo) => todo.syncUser === "ibro") }, { domain: "active" }).map((group) => group.id),
    ["c", "a"],
    "Delavec vidi isti relativni vrstni red brez Bojanove skrite naloge."
  );
  assert.match(database.todos.find((todo) => todo.id === "c-ibro")?.history.at(-1)?.action || "", /skupni vrstni red/);
});

test("delavec ne more premikati opravila, ki ga je ustvaril za drugega delavca", () => {
  const database = {
    users: { bojan: boss, ibro: worker }, todoEditLocks: {}, entries: [], debts: [], clients: [],
    todos: [
      { id: "foreign", assignmentGroupId: "foreign", status: "open", syncUser: "bojan", createdBy: "ibro", sharedManualBucket: "unsorted", sharedManualOrder: 1 },
      { id: "own", assignmentGroupId: "own", status: "open", syncUser: "ibro", sharedManualBucket: "unsorted", sharedManualOrder: 2 }
    ]
  };
  const result = applySharedManualTodoOrder(database, worker, { sourceId: "foreign", targetId: "own" });
  assert.equal(result.status, 403);
  assert.match(result.error, /ne sme\u0161/);
});

test("ro\u010dni vrstni red ne me\u0161a nujnih, naro\u010dil in navadnih opravil", () => {
  const database = {
    users: { bojan: boss, ibro: worker }, todoEditLocks: {}, entries: [], debts: [], clients: [],
    todos: [
      { id: "normal", status: "open", syncUser: "ibro", sharedManualBucket: "unsorted", sharedManualOrder: 1 },
      { id: "urgent", status: "open", urgent: true, syncUser: "ibro", sharedManualBucket: "sorted", sharedManualOrder: 1 },
      { id: "order", status: "order", syncUser: "ibro", sharedManualBucket: "sorted", sharedManualOrder: 1 }
    ]
  };
  const result = applySharedManualTodoOrder(database, worker, { sourceId: "normal", targetId: "urgent" });
  assert.equal(result.status, 400);
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

test("izvor projekta vnosa ur je preverjen ob nastanku in ohrani zgodovinski naslov", () => {
  const sourceDb = {
    todos: [
      { id: "project", status: "open", syncUser: "ibro", title: "Montaža omare" },
      { id: "foreign", status: "open", syncUser: "bojan", title: "Tuje opravilo" },
      { id: "old-entry", status: "execution", syncUser: "ibro", title: "Stari vpis" }
    ]
  };
  const linked = preserveTimeEntrySourceProject(sourceDb, worker, {
    status: "execution",
    sourceProjectTodoId: "project",
    sourceProjectTitle: "Ponarejen naslov"
  });
  assert.equal(linked.error, "");
  assert.equal(linked.todo.sourceProjectTodoId, "project");
  assert.equal(linked.todo.sourceProjectTitle, "Montaža omare");
  assert.match(preserveTimeEntrySourceProject(sourceDb, worker, {
    status: "execution", sourceProjectTodoId: "foreign"
  }).error, /ni na voljo/);
  assert.match(preserveTimeEntrySourceProject(sourceDb, worker, {
    status: "execution", sourceProjectTodoId: "old-entry"
  }).error, /ni na voljo/);

  const historical = preserveTimeEntrySourceProject({ todos: [] }, worker, {
    status: "execution", sourceProjectTodoId: "spremenjen"
  }, {
    status: "execution", sourceProjectTodoId: "project", sourceProjectTitle: "Montaža omare"
  });
  assert.equal(historical.error, "");
  assert.equal(historical.todo.sourceProjectTodoId, "project");
  assert.equal(historical.todo.sourceProjectTitle, "Montaža omare");
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
test("delavec lahko navede kilometrino za stranko in označi garancijski projekt", () => {
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
  // Garancija can be marked already on the ordinary project. It only affects
  // client billing once that project is later written as an execution entry.
  assert.equal(ordinaryTask.warranty, true);
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

test("direct client settlement creates an auditable worker credit", () => {
  const database = {
    users: {
      bojan: { id: "bojan", name: "Bojan", role: "boss", billing: { hourlyRate: 15 } },
      ibro: { id: "ibro", name: "Ibro", role: "worker", billing: { hourlyRate: 15 } }
    },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    settings: { billing: { workerOwnVehicleKmRate: 0.22, mealPaidMinutes: 45 } },
    debts: [],
    payrolls: [],
    clientBills: [],
    todos: [{
      id: "entry-1", assignmentGroupId: "event-1", syncUser: "ibro", createdBy: "ibro",
      status: "execution", date: "2026-07-15", start: "08:00", end: "10:00",
      title: "Monta\u017ea", clientId: "jerin", client: "Jerin", billingHourlyRate: 15
    }]
  };
  const zeroDatabase = structuredClone(database);
  const zeroSettled = directClientSettlementForTodo(zeroDatabase, zeroDatabase.todos[0], { confirmed: true, amount: 0, creditWorker: true }, worker);
  assert.ok(zeroSettled.clientBill);
  assert.equal(zeroSettled.clientBill.receivedAmount, 0);
  assert.equal(zeroSettled.clientBill.creditedWorkerId, "");
  assert.equal(zeroDatabase.debts.length, 0);
  const settled = directClientSettlementForTodo(database, database.todos[0], { confirmed: true, amount: 80, creditWorker: true }, worker);
  assert.ok(settled.clientBill);
  assert.equal(settled.clientBill.directSettlement, true);
  assert.equal(settled.clientBill.receivedAmount, 80);
  assert.equal(database.debts.length, 1);
  assert.deepEqual(database.debts[0] && { type: database.debts[0].type, person: database.debts[0].person, amount: database.debts[0].amount }, { type: "client_receipt", person: "ibro", amount: 80 });
  assert.equal(clientSettlementForTodo(database, database.todos[0]).confirmed, true);
  assert.equal(reconcileTodoArchives(database, boss).archived, 0);

  const payroll = buildPayrollSnapshot(database, "ibro", { from: "2026-07-01", to: "2026-07-31" }, { id: "payroll-1", status: "draft" });
  assert.deepEqual(payroll.clientReceiptIds, [database.debts[0].id]);
  assert.equal(payroll.clientReceiptAmount, 80);
  assert.equal(payroll.payoutAmount, 110);
  database.payrolls.push({ ...payroll, status: "confirmed" });
  assert.equal(reconcileTodoArchives(database, boss).archived, 1);

  const denied = cancelClientBill(database, settled.clientBill.id, boss);
  assert.match(denied.error, /obra\u010dun delavca/);
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
test("delo od doma ohrani ročno kilometrino, vendar ne sproži poti v službo", () => {
  const db = {
    users: { ibro: { id: "ibro", billing: { hourlyRate: 20, commuteKmOneWay: 7 } } },
    settings: { billing: { workerOwnVehicleKmRate: 0.22 } },
    payrolls: [],
    todos: [
      { id: "remote-first", syncUser: "ibro", status: "execution", date: "2026-07-20", start: "08:00", end: "09:00", title: "Od doma", billingKm: 3, workFromHome: true },
      { id: "onsite-later", syncUser: "ibro", status: "execution", date: "2026-07-20", start: "10:00", end: "11:00", title: "Na terenu", billingKm: 1, workFromHome: false },
      { id: "remote-only", syncUser: "ibro", status: "execution", date: "2026-07-21", start: "08:00", end: "09:00", title: "Samo doma", billingKm: 2, workFromHome: true }
    ]
  };
  const payroll = buildPayrollSnapshot(db, "ibro", { from: "2026-07-20", to: "2026-07-21" }, { status: "draft" });
  assert.deepEqual(payroll.lines.map((line) => [line.workerKm, line.commuteKm, line.km, line.workFromHome]), [
    [3, 0, 3, true],
    [1, 14, 15, false],
    [2, 0, 2, true]
  ]);
  assert.equal(payroll.km, 20);
});

test("malica sama ne sproži poti v službo", () => {
  const db = {
    users: { ibro: { id: "ibro", billing: { hourlyRate: 20, commuteKmOneWay: 7 } } },
    settings: { billing: { workerOwnVehicleKmRate: 0.22, mealPaidMinutes: 45 } },
    payrolls: [],
    todos: [
      { id: "meal-only", syncUser: "ibro", status: "meal", date: "2026-07-20", start: "08:00", end: "09:00", title: "Malica" },
      { id: "meal-before-work", syncUser: "ibro", status: "meal", date: "2026-07-21", start: "08:00", end: "09:00", title: "Malica" },
      { id: "onsite-after-meal", syncUser: "ibro", status: "execution", date: "2026-07-21", start: "10:00", end: "11:00", title: "Teren" }
    ]
  };
  const payroll = buildPayrollSnapshot(db, "ibro", { from: "2026-07-20", to: "2026-07-21" }, { status: "draft" });
  assert.deepEqual(payroll.lines.map((line) => [line.todoId, line.minutes, line.commuteKm, line.km]), [
    ["meal-only", 45, 0, 0],
    ["meal-before-work", 45, 0, 0],
    ["onsite-after-meal", 60, 14, 14]
  ]);
  assert.deepEqual(payroll.lines.filter((line) => line.status === "meal").map((line) => [line.minutes, line.unpaidMealMinutes]), [[45, 15], [45, 15]]);
});

test("vnos ur ohrani oznako dela od doma, navadno opravilo pa je nima", () => {
  const timeEntry = cleanTodo({ title: "Vpis ur", status: "execution", date: "2026-07-20", start: "08:00", end: "09:00", workFromHome: true });
  const regularTodo = cleanTodo({ title: "Projekt", status: "open", workFromHome: true });
  assert.equal(timeEntry.workFromHome, true);
  assert.equal(regularTodo.workFromHome, false);
  const roleResult = todoForUserRole(worker, { users: { ibro: { id: "ibro", billing: { hourlyRate: 20 } } }, settings: {} }, timeEntry, { ...timeEntry, workFromHome: true });
  assert.equal(roleResult.workFromHome, true);
});

test("pot v sluzbo se obracuna enkrat na dejanski delovni dan", () => {
  const db = {
    users: { ibro: { id: "ibro", billing: { hourlyRate: 20, commuteKmOneWay: 7 } } },
    settings: { billing: { workerOwnVehicleKmRate: 0.22 } },
    payrolls: [],
    todos: [
      { id: "day-one-first", syncUser: "ibro", status: "execution", date: "2026-07-20", start: "08:00", end: "09:00", title: "Prvo", billingKm: 3 },
      { id: "day-one-second", syncUser: "ibro", status: "execution", date: "2026-07-20", start: "10:00", end: "11:00", title: "Drugo", billingKm: 1 },
      { id: "day-two", syncUser: "ibro", status: "execution", date: "2026-07-21", start: "08:00", end: "09:00", title: "Tretje", billingKm: 0 }
    ]
  };
  const payroll = buildPayrollSnapshot(db, "ibro", { from: "2026-07-20", to: "2026-07-21" }, { status: "draft" });
  assert.deepEqual(payroll.lines.map((line) => [line.workerKm, line.commuteKm, line.km]), [[3, 14, 17], [1, 0, 1], [0, 14, 14]]);
  assert.equal(payroll.km, 32);
  assert.equal(payroll.kmAmount, 7.04);
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
  assert.match(payrollSequenceError(payrollDb, "ibro", { from: "2026-08-01", to: "2026-08-31" }), /2026-06-30.*2026-07-01/);
  assert.match(payrollSequenceError(payrollDb, "ibro", { from: "2026-05-01", to: "2026-05-31" }), /Starejšega obračuna/);
  assert.match(payrollSequenceError(payrollDb, "ibro", { from: "2026-06-15", to: "2026-07-15" }), /prekrivata/);
});


test("obračun lahko vključuje današnje ure in podpira oba neprekinjena robova", () => {
  const today = new Date("2026-07-22T12:00:00+02:00");
  assert.equal(payrollPeriodEnded({ from: "2026-07-01", to: "2026-07-22" }, today), true);
  assert.equal(payrollPeriodEnded({ from: "2026-07-01", to: "2026-07-23" }, today), false);
  const base = { payrolls: [{ id: "june", workerId: "ibro", from: "2026-06-01", to: "2026-06-30", status: "confirmed" }] };
  assert.equal(payrollSequenceError(base, "ibro", { from: "2026-06-30", to: "2026-07-10" }), "");
  assert.equal(payrollSequenceError(base, "ibro", { from: "2026-07-01", to: "2026-07-10" }), "");
  assert.match(payrollSequenceError(base, "ibro", { from: "2026-06-29", to: "2026-07-10" }), /prekrivata/);
  assert.match(payrollSequenceError(base, "ibro", { from: "2026-07-02", to: "2026-07-10" }), /2026-06-30.*2026-07-01/);
  const mixed = { payrolls: [
    { id: "june", workerId: "ibro", from: "2026-06-01", to: "2026-06-30", status: "confirmed" },
    { id: "shared", workerId: "ibro", from: "2026-06-30", to: "2026-07-10", status: "confirmed" }
  ] };
  assert.equal(payrollSequenceError(mixed, "ibro", { from: "2026-07-11", to: "2026-07-31" }), "");
});

test("skupni mejni dan ne podvoji ur, zalozitev ali osebnih nakupov", () => {
  const db = {
    users: { ibro: { id: "ibro", billing: { hourlyRate: 20 } } },
    settings: { billing: { workerOwnVehicleKmRate: 0.22 } },
    todos: [
      { id: "locked-work", syncUser: "ibro", status: "execution", date: "2026-07-20", start: "08:00", end: "09:00", title: "Ze obracunano" },
      { id: "fresh-boundary", syncUser: "ibro", status: "execution", date: "2026-07-20", start: "09:00", end: "10:00", title: "Nov mejni vnos" },
      { id: "fresh-next", syncUser: "ibro", status: "execution", date: "2026-07-21", start: "08:00", end: "09:00", title: "Naslednji dan" }
    ],
    debts: [
      { id: "locked-advance", type: "advance", person: "ibro", date: "2026-07-20", amount: 10 },
      { id: "fresh-advance", type: "advance", person: "ibro", date: "2026-07-20", amount: 7 },
      { id: "locked-purchase", type: "personal_purchase", person: "ibro", date: "2026-07-20", amount: 5 },
      { id: "fresh-purchase", type: "personal_purchase", person: "ibro", date: "2026-07-20", amount: 3 }
    ],
    payrolls: [{
      id: "first", workerId: "ibro", from: "2026-07-01", to: "2026-07-20", status: "confirmed",
      lines: [{ todoId: "locked-work" }], advanceIds: ["locked-advance"], personalPurchaseIds: ["locked-purchase"]
    }]
  };
  const snapshot = buildPayrollSnapshot(db, "ibro", { from: "2026-07-20", to: "2026-07-21" }, { id: "second", status: "draft" });
  assert.deepEqual(snapshot.lines.map((line) => line.todoId), ["fresh-boundary", "fresh-next"]);
  assert.deepEqual(snapshot.advanceIds, ["fresh-advance"]);
  assert.deepEqual(snapshot.personalPurchaseIds, ["fresh-purchase"]);
  assert.equal(snapshot.advanceAmount, 7);
  assert.equal(snapshot.personalPurchaseAmount, 3);
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
test("PDF report download permits Unicode customer names", () => {
  const header = attachmentContentDisposition("obra\u010dun-MIZARSTVO KO\u0160NIK d.o.o..pdf");
  assert.match(header, /^attachment; filename="obracun-MIZARSTVO KOSNIK d\.o\.o\.\.pdf";/);
  assert.match(header, /filename\*=UTF-8''obra%C4%8Dun-MIZARSTVO%20KO%C5%A0NIK%20d\.o\.o\.\.pdf$/);
  assert.doesNotMatch(header, /[^\x20-\x7e]/);
});
test("server status returns safe CPU, RAM, disk and backup fields", async () => {
  const status = await serverRuntimeStatus();
  assert.ok(Number.isFinite(status.cpu.loadPercent));
  assert.ok(Number.isFinite(status.ram.usedPercent));
  assert.ok(Number.isFinite(status.uptimeSeconds));
  assert.equal(typeof status.disk.available, "boolean");
  assert.ok(Number.isFinite(status.attachments.count));
  assert.ok(Number.isFinite(status.attachments.totalBytes));
  assert.ok(status.lastBackup === null || Number.isFinite(status.lastBackup.archiveBytes));
});

test("client report PDF builds for a Unicode client without a period", async () => {
  const db = {
    users: { bojan: { id: "bojan", name: "Bojan", role: "boss", billing: { exportTitle: "Bojan \u017dagar" } } },
    clients: [{ clientId: "melita", name: "Melita Zupanec", search: "melita" }],
    todos: [{ id: "melita-work", assignmentGroupId: "melita-event", syncUser: "bojan", status: "execution", date: "2026-07-20", start: "08:00", end: "09:00", title: "Ko\u0161nik \u017d\u0110\u0160\u0106\u010c", clientId: "melita", client: "Melita Zupanec", clientKm: 12, clientVehicle: "van" }]
  };
  const report = clientReportSelection(db, { clientId: "melita", eventIds: ["melita-event"] });
  const pdf = await buildClientReportPdf(db, report, []);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
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
test("arhivski cleanup po poteku hrambe izbriše cel dogodek, priloge in osirotelo začasno stranko", () => {
  const attachmentId = "a".repeat(64);
  const db = {
    settings: { archive: { retentionMonths: 12 } },
    entries: [],
    debts: [],
    attachments: { [attachmentId]: { id: attachmentId, byteSize: 1234 } },
    clients: [
      { clientId: "old-client", name: "Stara začasna", search: "stara", source: "ad-hoc" },
      { clientId: "current-client", name: "Aktivna", search: "aktivna", source: "ad-hoc" }
    ],
    todos: [
      { id: "old-ibro", assignmentGroupId: "old-project", clientId: "old-client", client: "Stara začasna", archivedAt: "2025-07-19T10:00:00.000Z", photos: [{ attachmentId }], driveFiles: [{ fileId: "1wsPGlRaN2M7biJK4zq3KnLSYRXzJX6S1", managed: true, ownerEmail: "bojan@indus.si" }] },
      { id: "old-bojan", assignmentGroupId: "old-project", clientId: "old-client", client: "Stara začasna", archivedAt: "2025-07-20T10:00:00.000Z", photos: [{ attachmentId }], driveFiles: [{ fileId: "1wsPGlRaN2M7biJK4zq3KnLSYRXzJX6S1", managed: true, ownerEmail: "bojan@indus.si" }] },
      { id: "new-project", assignmentGroupId: "new-project", clientId: "current-client", client: "Aktivna", archivedAt: "2025-07-22T10:00:00.000Z", photos: [], driveFiles: [] },
      { id: "partial-ibro", assignmentGroupId: "partial-project", archivedAt: "2025-07-19T10:00:00.000Z", photos: [], driveFiles: [] },
      { id: "partial-bojan", assignmentGroupId: "partial-project", archivedAt: "", photos: [], driveFiles: [] }
    ]
  };
  const candidates = archiveRetentionCandidates(db, new Date("2026-07-21T12:00:00.000Z"));
  assert.deepEqual(candidates.groups.map((group) => group.id), ["old-project"]);
  assert.equal(candidates.groups[0].managedDriveFiles.length, 1);
  const purged = purgeArchivedTodoGroups(db, candidates.groups);
  assert.deepEqual(purged, { groups: 1, todos: 2, attachments: 1, adHocClients: 1 });
  assert.deepEqual(db.todos.map((todo) => todo.id), ["new-project", "partial-ibro", "partial-bojan"]);
  assert.equal(db.attachments[attachmentId], undefined);
  assert.deepEqual(db.clients.map((client) => client.clientId), ["current-client"]);
});

test("completion request is private to its recipient and expires", () => {
  const now = Date.now();
  const tokenHash = "a".repeat(64);
  const requests = cleanTodoCompletionRequests([
    {
      id: "valid-request",
      tokenHash,
      recipientUserId: "ibro",
      recipientEmail: "ibro@example.test",
      requestedBy: "bojan",
      requestedByName: "Bojan",
      comment: "Prosim dopolni opis.",
      createdAt: new Date(now).toISOString(),
      expiresAt: now + 60_000
    },
    {
      id: "expired-request",
      tokenHash: "b".repeat(64),
      recipientUserId: "ibro",
      recipientEmail: "ibro@example.test",
      requestedBy: "bojan",
      expiresAt: now - 1
    }
  ], now);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].recipientUserId, "ibro");
  assert.deepEqual(requests[0].recipientUserIds, ["ibro"]);
  assert.deepEqual(requests[0].recipientEmails, ["ibro@example.test"]);

  const multiRecipient = cleanTodoCompletionRequests([{
    id: "multi-request",
    tokenHash: "c".repeat(64),
    recipientUserIds: ["ibro", "bojan", "ibro"],
    recipientEmails: ["ibro@example.test", "bojan@example.test", "ibro@example.test"],
    requestedBy: "bojan",
    expiresAt: now + 60_000
  }], now);
  assert.deepEqual(multiRecipient[0].recipientUserIds, ["ibro", "bojan"]);
  assert.deepEqual(multiRecipient[0].recipientEmails, ["ibro@example.test", "bojan@example.test"]);

  const delegatedTodo = {
    id: "delegated",
    syncUser: "bojan",
    createdBy: "ibro",
    title: "Dopolni zapis",
    photos: [],
    driveFiles: [],
    completionRequests: requests
  };
  assert.equal(canManageTodo(worker, delegatedTodo), true);
  const visible = visibleTodosForUser({ todos: [delegatedTodo], attachments: [] }, worker);
  assert.equal(visible.length, 1);
  assert.equal(Object.hasOwn(visible[0], "completionRequests"), false);
});

test("completion link stays valid through an assignment copy change", () => {
  const now = Date.now();
  const tokenHash = "d".repeat(64);
  const request = {
    id: "fixed-link",
    tokenHash,
    recipientUserId: "ibro",
    recipientEmail: "ibro@example.test",
    requestedBy: "bojan",
    expiresAt: now + 14 * 24 * 60 * 60 * 1000
  };
  const beforeSave = {
    todos: [
      { id: "old-copy", assignmentGroupId: "shared-task", completionRequests: [request] },
      { id: "other-copy", assignmentGroupId: "shared-task", completionRequests: [] }
    ]
  };
  const preserved = todoCompletionRequestsForAssignment(beforeSave, beforeSave.todos[1], now);
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].tokenHash, tokenHash);

  const afterSave = {
    todos: [{ id: "new-copy", assignmentGroupId: "shared-task", completionRequests: preserved }]
  };
  const match = findActiveTodoCompletionRequest(afterSave, "old-copy", tokenHash, now);
  assert.equal(match?.todo.id, "new-copy");
  assert.equal(match?.request.id, "fixed-link");

  const manyActiveRequests = cleanTodoCompletionRequests(Array.from({ length: 21 }, (_, index) => ({
    id: `request-${index}`,
    tokenHash: String(index % 10).repeat(64),
    recipientUserId: "ibro",
    recipientEmail: "ibro@example.test",
    requestedBy: "bojan",
    expiresAt: now + 60_000
  })), now);
  assert.equal(manyActiveRequests.length, 21);
});

test("completion request email has recipient, subject and encoded body", () => {
  const raw = gmailCompletionRequestRaw({
    to: "ibro@example.test",
    subject: "Dopolnitev opravila",
    text: "Odpri opravilo: https://example.test/?todo=t1&completion=secret"
  });
  const message = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(message, /To: ibro@example\.test/);
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  const body = message.trim().split("\r\n\r\n").at(-1).replace(/\r\n/g, "");
  assert.match(Buffer.from(body, "base64").toString("utf8"), /completion=secret/);
});
test("uvoženi dogodki ostanejo ločeni od ur in obračunov", () => {
  const imported = cleanTodo({ title: "Uvožen koledar", status: "open", imported: true, date: "2026-07-20" });
  const timeEntry = cleanTodo({ title: "Ne sme biti uvožen vpis ur", status: "execution", imported: true, date: "2026-07-20", start: "08:00", end: "09:00" });
  assert.equal(imported.imported, true);
  assert.equal(timeEntry.imported, false);

  const billingDb = {
    users: { ibro: { id: "ibro", billing: { hourlyRate: 15 } } },
    settings: { billing: { workerOwnVehicleKmRate: 0.22 } }, payrolls: [],
    todos: [{ id: "imported-work", syncUser: "ibro", status: "execution", imported: true, date: "2026-07-20", start: "08:00", end: "09:00", title: "Zunanji zapis" }]
  };
  assert.equal(buildPayrollSnapshot(billingDb, "ibro", { from: "2026-07-01", to: "2026-07-31" }, { id: "draft", status: "draft" }).lines.length, 0);
});
test("edited imported event is promoted to normal on save", () => {
  const previous = cleanTodo({ title: "Imported calendar", status: "open", imported: true, date: "2026-07-20", notes: "source" });
  assert.equal(importedTodoWasEdited(previous, { ...previous }), false);
  assert.equal(importedTodoWasEdited(previous, { ...previous, billingHourlyRate: 15, billingKm: 0, clientKm: 0, clientVehicle: "personal" }), false);
  assert.equal(importedTodoWasEdited(previous, { ...previous, title: "Edited calendar" }), true);
  assert.equal(importedTodoWasEdited(previous, { ...previous }, { assignmentsChanged: true }), true);
  const promoted = todoForUserRole(boss, { users: { bojan: { id: "bojan", billing: { hourlyRate: 15 } } }, settings: {} }, previous, { ...previous, title: "Edited calendar", promoteImported: true });
  assert.equal(promoted.imported, false);
});

test("prenos izvajalca po potrjenem obračunu naredi negativno razliko staremu izvajalcu", () => {
  const accountingDb = {
    users: {
      bojan: { id: "bojan", name: "Bojan", billing: { hourlyRate: 25 } },
      ibro: { id: "ibro", name: "Ibro", billing: { hourlyRate: 15 } }
    },
    settings: { billing: { workerOwnVehicleKmRate: 0.22 } },
    todos: [{
      id: "moved-time-entry",
      assignmentGroupId: "event-moved",
      syncUser: "ibro",
      status: "execution",
      date: "2026-07-07",
      start: "08:00",
      end: "09:30",
      title: "Preneseno delo",
      client: "Studi",
      billingHourlyRate: 15,
      billingKm: 0
    }],
    settlementCorrections: [],
    payrolls: [{
      id: "bojan-july",
      workerId: "bojan",
      status: "confirmed",
      from: "2026-07-01",
      to: "2026-07-31",
      lines: [{
        todoId: "moved-time-entry",
        assignmentGroupId: "event-moved",
        workerId: "bojan",
        date: "2026-07-07",
        start: "08:00",
        end: "09:30",
        title: "Preneseno delo",
        client: "Studi",
        status: "execution",
        minutes: 90,
        hours: 1.5,
        hourlyRate: 25,
        workerKm: 0,
        commuteKm: 0,
        km: 0,
        kmRate: 0.22,
        workAmount: 37.5,
        kmAmount: 0,
        totalAmount: 37.5
      }]
    }]
  };
  const moved = accountingDb.todos[0];
  const result = upsertSettlementCorrections(accountingDb, [moved], [moved], boss, "2026-08-05T09:00:00.000Z");
  assert.equal(result.error, "");
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0].workerId, "bojan");
  assert.equal(result.corrections[0].delta.hours, -1.5);
  assert.equal(result.corrections[0].delta.workAmount, -37.5);

  const ibroJuly = buildPayrollSnapshot(accountingDb, "ibro", { from: "2026-07-01", to: "2026-07-31" }, { id: "ibro-july", status: "draft" });
  assert.equal(ibroJuly.lines.filter((line) => line.todoId === "moved-time-entry").length, 1);
  assert.equal(ibroJuly.workAmount, 22.5);

  const bojanAugust = buildPayrollSnapshot(accountingDb, "bojan", { from: "2026-08-01", to: "2026-08-31" }, { id: "bojan-august", status: "draft" });
  assert.equal(bojanAugust.lines.filter((line) => line.correctionId).length, 1);
  assert.equal(bojanAugust.workAmount, -37.5);
});
test("material record is client-billed without worker payroll", () => {
  const db = {
    users: { bojan: { id: "bojan", name: "Bojan", role: "boss" } },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    payrolls: [],
    clientBills: [],
    todos: [{
      id: "material-1", assignmentGroupId: "material-event-1", syncUser: "bojan", status: "material", done: true,
      date: "2026-07-15", title: "Delivery of fuses", clientId: "jerin", client: "Jerin",
      material: "3x C16", materialAmount: 42.5, externalDelivery: true
    }]
  };
  const normalized = cleanTodo(db.todos[0]);
  assert.equal(normalized.done, true);
  assert.equal(normalized.materialAmount, 42.5);
  assert.equal(normalized.clientKm, 0);
  assert.equal(normalized.billingHourlyRate, null);

  assert.equal(reconcileTodoArchives(db, boss).archived, 0);
  const bill = buildClientBillSnapshot(db, { clientId: "jerin", eventIds: ["material-event-1"] }, boss);
  assert.ok(bill);
  assert.deepEqual(bill.eventIds, ["material-event-1"]);
  assert.deepEqual(bill.lines[0] && { status: bill.lines[0].status, materialAmount: bill.lines[0].materialAmount, externalDelivery: bill.lines[0].externalDelivery }, { status: "material", materialAmount: 42.5, externalDelivery: true });
  db.clientBills.push(bill);

  assert.equal(reconcileTodoArchives(db, boss).archived, 1);
  assert.ok(db.todos[0].archivedAt);
  assert.equal(db.todos[0].archivedPayrollId, "");
  assert.equal(db.todos[0].archivedClientBillId, bill.id);
});
test("normalization preserves a material record", () => {
  const database = {
    users: {}, entries: [], debts: [], clients: [], payrolls: [], clientBills: [],
    todos: [{ id: "material-normalize", assignmentGroupId: "material-normalize", syncUser: "bojan", status: "material", done: true, date: "2026-08-06", title: "Material delivery", materialAmount: 18 }]
  };
  normalizeDb(database);
  assert.deepEqual(database.todos[0] && { status: database.todos[0].status, done: database.todos[0].done, materialAmount: database.todos[0].materialAmount }, { status: "material", done: true, materialAmount: 18 });
});
test("note is client-billed without worker payroll or time charges", () => {
  const db = {
    users: { bojan: { id: "bojan", name: "Bojan", role: "boss" } },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    payrolls: [],
    clientBills: [],
    todos: [{
      id: "note-1", assignmentGroupId: "note-event-1", syncUser: "bojan", status: "note", done: true,
      date: "2026-07-15", title: "Dogovor o dobavi", clientId: "jerin", client: "Jerin",
      notes: "Dostava je potrjena.", material: "2x stikalo"
    }]
  };
  const normalized = cleanTodo(db.todos[0]);
  assert.equal(normalized.done, true);
  assert.equal(normalized.billingHourlyRate, null);
  assert.equal(normalized.billingKm, 0);
  assert.equal(normalized.clientKm, 0);
  assert.equal(buildPayrollSnapshot(db, "bojan", "2026-07", { id: "payroll-note", status: "draft" }).lines.length, 0);

  const bill = buildClientBillSnapshot(db, { clientId: "jerin", eventIds: ["note-event-1"] }, boss);
  assert.ok(bill);
  assert.equal(bill.lines[0].status, "note");
  assert.equal(bill.lines[0].clientBillableMinutes, 0);
  assert.equal(bill.lines[0].clientKm, 0);
  db.clientBills.push(bill);

  assert.equal(reconcileTodoArchives(db, boss).archived, 1);
  assert.ok(db.todos[0].archivedAt);
  assert.equal(db.todos[0].archivedPayrollId, "");
});
test("visible todos expose attachment metadata without eager media payloads", () => {
  const attachmentId = "a".repeat(64);
  const db = {
    attachments: {
      [attachmentId]: {
        id: attachmentId,
        data: "data:image/jpeg;base64,AA==",
        thumbnailData: "data:image/jpeg;base64,AA==",
        mimeType: "image/jpeg"
      }
    },
    todos: [{ id: "attachment-lazy", syncUser: "bojan", title: "Priloga", photos: [{ id: "photo-lazy", attachmentId, name: "slika.jpg" }] }]
  };
  const visible = visibleTodosForUser(db, boss);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].photos[0], {
    id: "photo-lazy",
    attachmentId,
    name: "slika.jpg",
    data: "",
    thumbnailData: "",
    url: `/api/attachments/${attachmentId}`,
    thumbnailUrl: `/api/attachments/${attachmentId}/thumbnail`,
    mimeType: "image/jpeg"
  });
});
test("delavec lahko vpisuje ure zase in za delavce, ki jih določi šef", () => {
  const workerDb = {
    users: {
      bojan: { id: "bojan", role: "boss", active: true, timeEntryForIds: ["bojan"] },
      ibro: { id: "ibro", role: "worker", active: true, timeEntryForIds: ["ibro", "maja"] },
      maja: { id: "maja", role: "worker", active: true, timeEntryForIds: ["maja"] },
      marko: { id: "marko", role: "worker", active: false, timeEntryForIds: [] }
    }
  };
  assert.deepEqual(timeEntryTargetIds(workerDb, workerDb.users.ibro), ["ibro", "maja"]);
  assert.equal(canRecordHoursFor(workerDb, workerDb.users.ibro, "ibro"), true);
  assert.equal(canRecordHoursFor(workerDb, workerDb.users.ibro, "maja"), true);
  assert.equal(canRecordHoursFor(workerDb, workerDb.users.ibro, "bojan"), false);
  assert.equal(canRecordHoursFor(workerDb, workerDb.users.ibro, "marko"), false);
  assert.equal(canRecordHoursFor(workerDb, workerDb.users.bojan, "maja"), true);
});

test("normalizacija delavca ohrani neobvezno Google prijavo in odstrani neaktivna pooblastila", () => {
  const users = {
    maja: { id: "maja", name: "Maja", role: "worker", active: true },
    marko: { id: "marko", name: "Marko", role: "worker", active: false }
  };
  assert.equal(normalizeWorkerProfile("maja", users.maja, users), true);
  assert.equal(users.maja.employmentType, "contractor");
  assert.deepEqual(users.maja.timeEntryForIds, ["maja"]);
  users.maja.timeEntryForIds = ["maja", "marko"];
  normalizeWorkerProfile("maja", users.maja, users);
  assert.deepEqual(users.maja.timeEntryForIds, ["maja"]);
});

test("delavec z zgodovino se varno prepozna za deaktivacijo namesto izbrisa", () => {
  const workerDb = {
    entries: [], debts: [], advances: [], personalPurchases: [], payrolls: [], clientBills: [], billingLocks: [], auditLog: [],
    todos: [{ id: "historic", syncUser: "maja", createdBy: "bojan" }]
  };
  assert.equal(workerHasBusinessData(workerDb, "maja"), true);
  assert.equal(workerHasBusinessData(workerDb, "marko"), false);
});

test("ročne ure za obračun stranki ostanejo ločene od ur delavcev", () => {
  const customerDb = {
    users: {
      bojan: { id: "bojan", name: "Bojan", role: "boss" },
      ibro: { id: "ibro", name: "Ibro", role: "worker" },
      maja: { id: "maja", name: "Maja", role: "worker" }
    },
    clients: [{ clientId: "jerin", name: "Jerin", search: "jerin" }],
    settlementCorrections: [],
    clientBills: [],
    todos: [
      { id: "shared-ibro", assignmentGroupId: "shared-project", syncUser: "ibro", status: "execution", date: "2026-08-01", start: "08:00", end: "10:00", title: "Montaža", clientId: "jerin", client: "Jerin", clientBillableMinutes: 90 },
      { id: "shared-maja", assignmentGroupId: "shared-project", syncUser: "maja", status: "execution", date: "2026-08-01", start: "08:00", end: "10:00", title: "Montaža", clientId: "jerin", client: "Jerin", clientBillableMinutes: 90 }
    ]
  };

  assert.equal(clientBillableMinutesForTodos(customerDb.todos), 90, "ročni znesek skupnega dogodka se ne podvoji");
  const bill = buildClientBillSnapshot(customerDb, { clientId: "jerin" }, boss);
  assert.equal(bill.lines[0].clientBillableMinutes, 90);
  const workerUpdate = todoForUserRole(worker, customerDb, customerDb.todos[0], {
    ...customerDb.todos[0],
    end: "11:00",
    clientBillableMinutes: null
  });
  assert.equal(workerUpdate.clientBillableMinutes, 90, "delavec ne more prepisati ?efove ro?ne vrednosti");
  const warning = clientBillableHoursWarning(customerDb.todos, [
    { ...customerDb.todos[0], end: "11:00" },
    customerDb.todos[1]
  ]);
  assert.deepEqual(warning, { clientBillableHours: 1.5, beforeWorkerHours: 4, afterWorkerHours: 5 });
});

test("automatic customer hours use recorded time when manual value is null", () => {
  const automatic = {
    id: "automatic-client-hours",
    status: "execution",
    date: "2026-08-07",
    start: "08:00",
    end: "09:30",
    reportHours: null,
    clientBillableMinutes: null
  };
  assert.equal(clientBillableMinutesForTodos([automatic]), 90);
  assert.equal(clientBillableMinutesForTodos([{ ...automatic, reportHours: 0 }]), 0);
});
