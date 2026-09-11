"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PostgresStore } = require("../outputs/postgres-store");

function fakePool() {
  const calls = [];
  const state = { revision: 7 };
  const client = { release() {}, async query(sql) {
    calls.push(sql);
    if (/select data.*storage_revision/.test(sql)) return { rows: [{ data: { revision: state.revision } }], rowCount: 1 };
    if (sql === "select id, data from indus_tasks") return { rows: [{ id: "task", data: { title: "Before", assignmentGroupId: "task" } }], rowCount: 1 };
    if (sql === "select id, task_id, data from indus_task_assignments") return { rows: [{ id: "assignment", task_id: "task", data: { id: "assignment", taskId: "task", syncUser: "ibro", billingWorkerKm: 19 } }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  return { calls, state, connect: async () => client, query: () => { throw new Error("A full snapshot must not use separate pool queries"); } };
}

test("Postgres full read uses one read-only repeatable snapshot and preserves worker km", async () => {
  const pool = fakePool();
  const store = new PostgresStore(pool, path.resolve("test-results/media"));
  const db = await store.load();
  assert.equal(pool.calls[0], "begin isolation level repeatable read read only");
  assert.equal(pool.calls.at(-1), "commit");
  assert.equal(db.todos[0].billingWorkerKm, 19);
  assert.ok(pool.calls.every(sql => !/^(insert|update|delete)/i.test(sql)));
});

test("stale or detached Postgres snapshots fail before any write", async () => {
  const pool = fakePool();
  const store = new PostgresStore(pool, path.resolve("test-results/media"));
  const db = await store.load();
  await assert.rejects(store.save(structuredClone(db)), { code: "STALE_SNAPSHOT", status: 409 });
  pool.state.revision++;
  pool.calls.length = 0;
  await assert.rejects(store.save(db), { code: "STALE_SNAPSHOT", status: 409 });
  assert.ok(pool.calls.some(sql => /for update/.test(sql)));
  assert.equal(pool.calls.at(-1), "rollback");
  assert.ok(pool.calls.every(sql => !/^(insert|update|delete)/i.test(sql)));
});

test("single task edit does not upsert its unchanged assignment or other tables", async () => {
  const pool = fakePool();
  const store = new PostgresStore(pool, path.resolve("test-results/media"));
  const db = await store.load();
  db.todos[0].title = "After";
  pool.calls.length = 0;
  await store.save(db);
  const writes = pool.calls.filter(sql => /^(insert|update|delete)/i.test(sql));
  assert.equal(writes.filter(sql => /insert into indus_tasks /.test(sql)).length, 1);
  assert.equal(writes.filter(sql => /indus_task_assignments|indus_clients|indus_sessions|indus_attachments|indus_payrolls/.test(sql)).length, 0);
  assert.equal(writes.length, 3, "one task plus application metadata and the CAS revision");
});

test("HTTP reads cannot persist normalization; attachment GET uses targeted access queries", () => {
  const source = fs.readFileSync(path.join(__dirname, "../outputs/server.js"), "utf8");
  const read = source.slice(source.indexOf("async function readDbAsync()"), source.indexOf("async function readRequestDb("));
  assert.doesNotMatch(read, /writeDbAsync|\.save\(/);
  const attachment = source.slice(source.indexOf('if (attachmentMatch && req.method === "GET")'), source.indexOf('if (url.pathname === "/api/health"'));
  assert.match(attachment, /attachmentAccessSeed\(attachmentId\)/);
  assert.doesNotMatch(attachment, /readDbAsync\(/);
  assert.match(source, /if \(error.code === "STALE_SNAPSHOT"\)[\s\S]{0,100}sendJson\(res, 409/);
  assert.match(source, /await migratePostgresNormalization\(\);/);
});
