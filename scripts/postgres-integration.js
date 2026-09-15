"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { Pool } = require("pg");
const { PostgresStore } = require("../outputs/postgres-store");
const { normalizeDb, createSession, sessionTokenHash, attachmentVisibleToUser } = require("../outputs/server");
const { dumpConsistentDatabase, dumpDatabase, sanitize } = require("./backup-indus-ure");

const expected = process.env.PG_QA_DATABASE || "";
const url = new URL(process.env.DATABASE_URL || "postgresql://invalid/invalid");
if (!/^indus_ure_qa_[a-z0-9_]+$/.test(expected) || decodeURIComponent(url.pathname.slice(1)) !== expected
    || !["127.0.0.1", "localhost"].includes(url.hostname) || process.env.NODE_ENV !== "test") {
  throw new Error("PostgreSQL QA refuses a non-isolated database or environment.");
}
const media = path.resolve(process.env.MEDIA_DIR || "");
const reportPath = process.env.PG_QA_REPORT;
if (!reportPath || !media.includes("indus-ure-qa-")) throw new Error("Private QA media/report paths are required.");
const pool = new Pool({ connectionString: url.href, max: 4 });
const secondPool = new Pool({ connectionString: url.href, max: 2 });
const store = new PostgresStore(pool, media);
const other = new PostgresStore(secondPool, media);
const checks = [];
const check = (name, details = {}) => { checks.push({ name, pass: true, ...details }); console.log(JSON.stringify({ check: name, ok: true, ...details })); };
const tables = ["indus_users", "indus_sessions", "indus_clients", "indus_tasks", "indus_task_assignments", "indus_entries", "indus_attachments", "indus_debts", "indus_payrolls", "indus_client_bills", "indus_billing_locks", "indus_meta"];
const keyFor = table => table === "indus_clients" ? "client_id" : table === "indus_sessions" ? "token_hash" : table === "indus_meta" ? "key" : "id";
async function fingerprints() {
  const result = {};
  for (const table of tables) {
    const rows = await pool.query(`select ${keyFor(table)} as id, xmin::text as version from ${table}`);
    result[table] = Object.fromEntries(rows.rows.map(row => [row.id, row.version]));
  }
  return result;
}
async function digest(recovery = false) {
  const result = {};
  for (const table of tables) {
    const rows = await pool.query(`select data from ${table} order by ${keyFor(table)}`);
    let data = rows.rows;
    if (recovery && table === "indus_sessions") data = [];
    if (recovery && ["indus_users", "indus_meta"].includes(table)) data = data.map(row => ({ data: sanitize(row.data) }));
    result[table] = { count: data.length, sha256: crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex") };
  }
  return result;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); }
  throw new Error(`Timeout: ${label}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await until(() => child.exitCode !== null || child.signalCode !== null, "QA server stop");
}
async function main() {
  const actual = await pool.query("select current_database() as name");
  assert.equal(actual.rows[0].name, expected);
  const mode = process.argv[2] || "--fresh";
  if (["--verify-restore", "--verify-recovery"].includes(mode)) {
    const original = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.deepEqual(await digest(), mode === "--verify-recovery" ? original.recoveryDigest : original.restoreDigest);
    const file = await store.getAttachment(original.attachmentId);
    assert.ok(file);
    assert.equal(crypto.createHash("sha256").update(await fs.readFile(file.filePath)).digest("hex"), original.attachmentId);
    check(mode === "--verify-recovery" ? "restore.real_sanitized_recovery_format_and_media_hash" : "restore.database_rows_and_media_hash");
    return;
  }
  if (mode === "--upgrade") {
    const before = await digest();
    await store.ensure({});
    const db = await store.load();
    normalizeDb(db);
    await store.save(db);
    const after = await digest();
    for (const table of tables.filter(table => !["indus_meta", "indus_sessions", "indus_attachments"].includes(table))) {
      assert.equal(after[table].count, before[table].count, `Upgrade changed ${table} count`);
    }
    const beforeNoop = await fingerprints();
    const normalizedAgain = await store.load();
    normalizeDb(normalizedAgain);
    await store.save(normalizedAgain);
    const afterNoop = await fingerprints();
    for (const table of tables.filter(table => !["indus_meta", "indus_sessions"].includes(table))) assert.deepEqual(afterNoop[table], beforeNoop[table], `Normalization is not idempotent for ${table}`);
    check("upgrade.production_clone_preserves_business_counts_and_is_idempotent");
    // This mode already requires a private QA database. Exercise the deployed
    // version against the upgraded clone, never against production itself.
    const previousServer = await fs.realpath("/opt/indus-ure/current/outputs/server.js");
    assert.match(previousServer, /^\/opt\/indus-ure\/releases\/[a-f0-9]{7,40}\/outputs\/server\.js$/);
    const previous = require(previousServer);
    const { PostgresStore: PreviousStore } = require(path.join(path.dirname(previousServer), "postgres-store.js"));
    const previousStore = new PreviousStore(pool, media);
    const rollbackBefore = await digest();
    const rollbackDb = await previousStore.load();
    previous.normalizeDb(rollbackDb);
    await previousStore.save(rollbackDb);
    const rollbackAfter = await digest();
    for (const table of tables.filter(table => !["indus_meta", "indus_sessions"].includes(table))) {
      assert.deepEqual(rollbackAfter[table], rollbackBefore[table], `Code rollback changed ${table}`);
    }
    const forward = await store.load();
    const beforeForward = JSON.stringify(forward);
    normalizeDb(forward);
    assert.equal(JSON.stringify(forward), beforeForward, "Forward reload after rollback changes normalized data");
    check("rollback.previous_code_reads_writes_and_forward_reload", { previousRelease: path.basename(path.dirname(path.dirname(previousServer))) });
    await fs.writeFile(reportPath, JSON.stringify({ checks, before, after, passed: true }, null, 2));
    return;
  }
  assert.equal(mode, "--fresh");
  await store.ensure({ users: {}, sessions: {}, settings: {}, todos: [] }, normalizeDb);
  await other.ensure({});
  let db = await store.load();
  const clientId = crypto.randomUUID();
  db.clients.push({ clientId, id: clientId, name: "Izolirana QA stranka", alias: "QA", source: "ad-hoc" });
  const ids = Array.from({ length: 500 }, () => crypto.randomUUID());
  for (const [index, id] of ids.entries()) db.todos.push({ id, assignmentGroupId: id, title: `QA ${index}`, status: "open", clientId, client: "Izolirana QA stranka", syncUser: index === 1 ? "ibro" : "bojan", createdBy: "bojan", billingWorkerKm: 19, photos: [] });
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
  const attachmentId = crypto.createHash("sha256").update(bytes).digest("hex");
  db.attachments[attachmentId] = { id: attachmentId, data: `data:image/png;base64,${bytes.toString("base64")}`, name: "qa.png", mimeType: "image/png" };
  db.todos[0].photos = [{ attachmentId, name: "qa.png" }];
  normalizeDb(db);
  const bossToken = createSession(db, "bojan");
  const workerToken = createSession(db, "ibro");
  const headers = token => ({ Cookie: `indus-ure-session=${token}`, "X-CSRF-Token": db.sessions[sessionTokenHash(token)].csrfToken, "Content-Type": "application/json" });
  const boss = headers(bossToken), worker = headers(workerToken);
  await store.save(db);
  db = await store.load();
  assert.equal(db.todos.find(item => item.id === ids[0]).billingWorkerKm, 19);
  check("relational.roundtrip_worker_km");

  const before = await fingerprints();
  db.todos.find(item => item.id === ids[0]).title = "Targeted change";
  const saveStart = performance.now();
  await store.save(db);
  const saveMs = performance.now() - saveStart;
  const after = await fingerprints();
  for (const table of tables.filter(table => !["indus_meta", "indus_tasks"].includes(table))) assert.deepEqual(after[table], before[table], `Unexpected row churn in ${table}`);
  const changed = Object.keys(after.indus_tasks).filter(id => after.indus_tasks[id] !== before.indus_tasks[id]);
  assert.deepEqual(changed, [ids[0]]);
  check("writes.one_changed_task_of_500", { changedTasks: changed.length, saveMs: Math.round(saveMs) });

  let a = await store.load(), b = await other.load();
  a.todos.find(item => item.id === ids[0]).title = "Concurrent winner";
  b.todos.find(item => item.id === ids[1]).title = "Stale loser";
  b.payrolls.push({ id: "must-not-exist", workerId: "ibro" });
  b.attachments["f".repeat(64)] = { data: "data:image/png;base64,AQID" };
  await store.save(a);
  const revisionBefore = (await digest()).indus_meta;
  await assert.rejects(other.save(b), { code: "STALE_SNAPSHOT" });
  assert.deepEqual((await digest()).indus_meta, revisionBefore);
  assert.equal((await pool.query("select 1 from indus_payrolls where id = 'must-not-exist'")).rowCount, 0);
  await assert.rejects(fs.stat(path.join(media, "objects", "f".repeat(64) + ".png")), { code: "ENOENT" });
  b = await other.load();
  b.todos.find(item => item.id === ids[1]).title = "Fresh retry";
  await other.save(b);
  assert.equal((await store.load()).todos.find(item => item.id === ids[0]).title, "Concurrent winner");
  check("concurrency.stale_snapshot_has_no_partial_rows_or_media_and_fresh_retry_preserves_winner");

  a = await store.load(); b = await other.load();
  a.settings.race = "a"; b.settings.race = "b";
  const race = await Promise.allSettled([store.save(a), other.save(b)]);
  assert.equal(race.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(race.find(item => item.status === "rejected").reason.code, "STALE_SNAPSHOT");
  check("concurrency.two_connections_have_one_CAS_winner");

  const writer = await other.load();
  const oldTitle = writer.todos.find(item => item.id === ids[0]).title;
  const oldName = writer.users.ibro.name;
  writer.todos.find(item => item.id === ids[0]).title = "New consistent task";
  writer.users.ibro.name = "New consistent user";
  let injected = false;
  const injectedPool = { connect: async () => {
    const connection = await pool.connect();
    return { release: () => connection.release(), query: async (...args) => {
      const result = await connection.query(...args);
      if (!injected && args[0] === "select id, data from indus_users") { injected = true; await other.save(writer); }
      return result;
    } };
  } };
  const consistent = await new PostgresStore(injectedPool, media).load();
  assert.equal(consistent.users.ibro.name, oldName);
  assert.equal(consistent.todos.find(item => item.id === ids[0]).title, oldTitle);
  check("reads.repeatable_snapshot_never_mixes_parallel_commit");

  const seed = await store.attachmentAccessSeed(attachmentId);
  assert.equal(seed.todos.length, 1);
  assert.equal(attachmentVisibleToUser(seed, { id: "ibro", role: "worker" }, attachmentId), false);
  assert.equal(attachmentVisibleToUser(seed, { id: "bojan", role: "boss" }, attachmentId), true);
  check("attachments.targeted_access_preserves_permissions");

  const port = 26000 + Math.floor(Math.random() * 2000);
  let output = "";
  const child = spawn(process.execPath, ["--require", "./scripts/pg-qa-instrumentation.js", "outputs/server.js"], {
    cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DISABLE_OPERATIONAL_MONITOR: "true", NODE_ENV: "test", INDUS_URE_TEST_MODE: "false" }
  });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const fullLoads = () => (output.match(/PG_QA_FULL_LOAD/g) || []).length;
  const request = (pathname, options = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, { ...options, headers: options.headers || boss });
  try {
    await until(async () => { try { return (await request("/api/health")).ok; } catch { return false; } }, "QA HTTP startup");
    const beforeGet = await digest();
    const bootstrap = await request("/api/bootstrap");
    assert.equal(bootstrap.status, 200);
    await bootstrap.arrayBuffer();
    assert.deepEqual(await digest(), beforeGet);
    check("http.GET_bootstrap_does_not_write_normalization");
    const loadCount = fullLoads();
    let response = await request(`/api/attachments/${attachmentId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    response = await request(`/api/attachments/${attachmentId}`, { headers: worker });
    assert.equal(response.status, 404);
    await response.arrayBuffer();
    assert.equal(fullLoads(), loadCount);
    check("http.attachment_zero_full_snapshots_and_unauthorized_404");

    const createBody = name => ({ title: name, clientId, client: "Izolirana QA stranka", status: "open", syncUser: "ibro", assigneeIds: ["ibro"], clientMutationId: crypto.randomUUID() });
    const two = await Promise.all([request("/api/todos", { method: "POST", body: JSON.stringify(createBody("HTTP boss")) }), request("/api/todos", { method: "POST", headers: worker, body: JSON.stringify(createBody("HTTP worker")) })]);
    for (const response of two) assert.equal(response.status, 200, await response.text());
    const persisted = await store.load();
    assert.equal(persisted.todos.filter(todo => ["HTTP boss", "HTTP worker"].includes(todo.title)).length, 2);
    check("http.two_parallel_sessions_keep_both_changes");

    const beforeClientValidation = await store.load();
    for (const headers of [boss, worker]) {
      for (const status of ["execution", "drive", "purchase"]) {
        const invalidHours = { ...createBody("Missing client must not save"), status, client: " ", clientId: "", date: "2032-03-15", endDate: "2032-03-15", start: "08:00", end: "09:00" };
        const rejected = await request("/api/todos", { method: "POST", headers, body: JSON.stringify(invalidHours) });
        assert.equal(rejected.status, 400, await rejected.text());
      }
      const planned = beforeClientValidation.todos.find(todo => todo.title === "HTTP worker");
      const rejectedEdit = await request(`/api/todos/${planned.id}`, { method: "PUT", headers, body: JSON.stringify({ ...planned, status: "execution", client: "", clientId: "", date: "2032-03-15", endDate: "2032-03-15", start: "08:00", end: "09:00" }) });
      assert.equal(rejectedEdit.status, 400, await rejectedEdit.text());
    }
    const afterClientValidation = await store.load();
    assert.deepEqual(afterClientValidation.todos, beforeClientValidation.todos);
    assert.deepEqual(afterClientValidation.clients, beforeClientValidation.clients);
    check("http.hours_require_client_for_both_roles_without_partial_writes");

    const body = JSON.stringify(createBody("Must not partially save"));
    const countBeforeSlow = fullLoads();
    let finish;
    const slowResponse = new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/todos", method: "POST", headers: { ...boss, "Content-Length": Buffer.byteLength(body) } }, res => {
        let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject); req.setTimeout(12000, () => req.destroy(new Error("slow request timed out")));
      req.write(body.slice(0, 10)); finish = () => req.end(body.slice(10));
    });
    await until(() => fullLoads() > countBeforeSlow, "HTTP mutation captured snapshot");
    const external = await other.load(); external.settings.externalMarker = "preserve-script-change"; await other.save(external);
    finish();
    const conflict = await slowResponse;
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(JSON.parse(conflict.text).code, "STALE_SNAPSHOT");
    const final = await store.load();
    assert.equal(final.settings.externalMarker, "preserve-script-change");
    assert.equal(final.todos.some(todo => todo.title === "Must not partially save"), false);
    check("http.script_race_returns_409_without_partial_business_write");
  } finally { await stop(child); }
  const recoveryDigest = await digest(true);
  const workDir = path.dirname(reportPath);
  await dumpConsistentDatabase(pool, workDir, path.join(workDir, "recovery.dump"), path.join(workDir, "recovery.sql"), {
    dump: async (...args) => {
      await dumpDatabase(...args);
      // A real concurrent commit between pg_dump and sanitized-state.sql must
      // not leak newer user/meta data into the older recovery snapshot.
      const during = await other.load();
      during.users.ibro.name = "Written during backup";
      during.settings.afterBackupSnapshot = true;
      await other.save(during);
    }
  });
  check("backup.exported_snapshot_spans_real_concurrent_commit");
  await fs.writeFile(reportPath, JSON.stringify({ checks, passed: true, attachmentId, recoveryDigest, restoreDigest: await digest() }, null, 2));
}
main().then(() => { console.log(JSON.stringify({ passed: true, checks: checks.length })); }).catch(error => {
  console.error(error.stack || error.message); process.exitCode = 1;
}).finally(async () => { await Promise.all([pool.end(), secondPool.end()]); });
