const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ENTRY_EDIT_LOCK_TTL_MS,
  TODO_EDIT_LOCK_TTL_MS,
  acquireEntryEditLock,
  acquireTodoEditLock,
  activeEntryEditLock,
  activeTodoEditLock,
  canManageEntry,
  canManageTodo,
  entryEditLockConflict,
  sourceTodoForNewEntry,
  entryForUserRole,
  defaultHourlyRateForUser,
  releaseEntryEditLock,
  releaseTodoEditLock,
  syncUserForRequest,
  todoAssigneeForUpdate,
  todoAssigneesForRequest,
  todoEditLockConflict,
  todoForUserRole,
  visibleDebtsForUser,
  visibleEntriesForUser,
  visibleTodosForUser
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

test("sef vidi vse, delavec pa samo svoje podatke", () => {
  assert.equal(visibleEntriesForUser(db, boss).length, 2);
  assert.deepEqual(visibleEntriesForUser(db, worker).map((item) => item.id), ["e1"]);
  assert.deepEqual(visibleTodosForUser(db, worker).map((item) => item.id), ["t1"]);
  assert.deepEqual(visibleDebtsForUser(db, worker).map((item) => item.id), ["d1"]);
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

test("delavski vnos ne more nastaviti obracuna ali racuna", () => {
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
test("obracunske podatke zakljucenega opravila lahko spremeni samo sef", () => {
  const billingDb = {
    users: {
      bojan: { id: "bojan", role: "boss", billing: { hourlyRate: 25 } },
      ibro: { id: "ibro", role: "worker", billing: { hourlyRate: 18 } }
    },
    settings: { billing: { hourlyRate: 15 } }
  };
  const previous = {
    id: "t1",
    syncUser: "ibro",
    status: "execution",
    billingHourlyRate: 22,
    billingKm: 5
  };

  assert.equal(defaultHourlyRateForUser(billingDb, "ibro"), 18);

  const workerChange = todoForUserRole(worker, billingDb, previous, {
    ...previous,
    billingHourlyRate: 999,
    billingKm: 999
  });
  assert.equal(workerChange.billingHourlyRate, 22);
  assert.equal(workerChange.billingKm, 5);

  const bossChange = todoForUserRole(boss, billingDb, previous, {
    ...previous,
    billingHourlyRate: 30,
    billingKm: 12.5
  });
  assert.equal(bossChange.billingHourlyRate, 30);
  assert.equal(bossChange.billingKm, 12.5);

  const newlyCompleted = todoForUserRole(worker, billingDb, null, {
    syncUser: "ibro",
    status: "execution",
    billingHourlyRate: 500,
    billingKm: 100
  });
  assert.equal(newlyCompleted.billingHourlyRate, 18);
  assert.equal(newlyCompleted.billingKm, 0);
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

test("koledarski vnos lahko istocasno ureja samo en uporabnik ali zavihek", () => {
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

test("isto opravilo lahko istocasno ureja samo en uporabnik ali zavihek", () => {
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
  assert.equal(todoEditLockConflict(todoId, bojan, first.token, startedAt + 4), null);
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
