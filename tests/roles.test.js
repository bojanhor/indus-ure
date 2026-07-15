const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canManageEntry,
  canManageTodo,
  entryForUserRole,
  syncUserForRequest,
  todoAssigneesForRequest,
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
