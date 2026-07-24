const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DELETED_TODO_RETENTION_DAYS,
  cleanTodo,
  isTrashedTodo,
  purgeExpiredTrashedTodoGroups,
  restoreTrashedTodoGroup,
  trashTodoGroup,
  visibleTodosForUser,
  visibleTrashedTodosForUser
} = require("../outputs/server");

const actor = { id: "bojan", name: "Bojan", role: "boss" };
const worker = { id: "ibro", name: "Ibro", role: "worker" };

function testDb() {
  const attachmentId = "a".repeat(64);
  return {
    users: { bojan: actor, ibro: worker },
    clients: [{ clientId: "client-1", name: "Začasna", search: "Zacasna", source: "ad-hoc" }],
    entries: [],
    debts: [],
    attachments: { [attachmentId]: { id: attachmentId, mimeType: "image/jpeg" } },
    todos: [
      { id: "assignment-a", assignmentGroupId: "event-1", title: "Servis", clientId: "client-1", client: "Začasna", status: "open", syncUser: "bojan", photos: [{ id: "p1", attachmentId }], history: [] },
      { id: "assignment-b", assignmentGroupId: "event-1", title: "Servis", clientId: "client-1", client: "Začasna", status: "open", syncUser: "ibro", photos: [{ id: "p1", attachmentId }], history: [] }
    ]
  };
}

test("izbrisano skrije cel skupni dogodek in ga obnovi brez izgube priloge", () => {
  const db = testDb();
  trashTodoGroup(db, db.todos[0], actor, "2026-07-01T10:00:00.000Z");
  assert.equal(db.todos.every(isTrashedTodo), true);
  assert.equal(visibleTodosForUser(db, actor).length, 0);
  const trashed = visibleTrashedTodosForUser(db, actor);
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].id, "assignment-a");
  assert.equal(trashed[0].assigneeIds.length, 2);
  assert.equal(trashed[0].restoreUntil, "2026-07-31T10:00:00.000Z");
  assert.equal(Object.keys(db.attachments).length, 1);

  restoreTrashedTodoGroup(db, db.todos[1], actor, "2026-07-02T10:00:00.000Z");
  assert.equal(db.todos.some(isTrashedTodo), false);
  assert.equal(visibleTodosForUser(db, actor).length, 2);
  assert.equal(Object.keys(db.attachments).length, 1);
});

test("koš po 30 dneh trajno odstrani celo skupino in samo osirotele podatke", () => {
  const db = testDb();
  trashTodoGroup(db, db.todos[0], actor, "2026-01-01T00:00:00.000Z");
  const result = purgeExpiredTrashedTodoGroups(db, Date.parse("2026-02-01T00:00:00.000Z"));
  assert.equal(DELETED_TODO_RETENTION_DAYS, 30);
  assert.deepEqual(result, { groups: 1, todos: 2, attachments: 1, adHocClients: 1 });
  assert.equal(db.todos.length, 0);
  assert.equal(Object.keys(db.attachments).length, 0);
  assert.equal(db.clients.length, 0);
});

test("samo datirano opravilo lahko ostane samo v koledarju", () => {
  assert.equal(cleanTodo({ title: "Dated", date: "2026-07-01", calendarOnly: true }).calendarOnly, true);
  assert.equal(cleanTodo({ title: "Undated", calendarOnly: true }).calendarOnly, false);
});
test("delno izbrisana skupina se nikoli ne počisti", () => {
  const db = testDb();
  db.todos[0].trashedAt = "2026-01-01T00:00:00.000Z";
  db.todos[0].trashedBy = actor.id;
  db.todos[0].trashedByName = actor.name;
  const result = purgeExpiredTrashedTodoGroups(db, Date.parse("2026-02-01T00:00:00.000Z"));
  assert.deepEqual(result, { groups: 0, todos: 0, attachments: 0, adHocClients: 0 });
  assert.equal(db.todos.length, 2);
  assert.equal(isTrashedTodo(db.todos[0]), true);
  assert.equal(isTrashedTodo(db.todos[1]), false);
});

test("nepotrjeno čiščenje ohrani aplikacijsko Drive prilogo", () => {
  const db = testDb();
  const managed = { fileId: "managed_file_123", managed: true, ownerEmail: "bojan@indus.si" };
  db.todos.forEach((todo) => { todo.driveFiles = [{ ...managed }]; });
  trashTodoGroup(db, db.todos[0], actor, "2026-01-01T00:00:00.000Z");
  const result = purgeExpiredTrashedTodoGroups(db, Date.parse("2026-02-01T00:00:00.000Z"));
  assert.deepEqual(result, { groups: 0, todos: 0, attachments: 0, adHocClients: 0 });
  assert.equal(db.todos.length, 2);
});