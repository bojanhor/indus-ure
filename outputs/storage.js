"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { PostgresStore } = require("./postgres-store");

// Storage lifecycle and request snapshots. Normalization and audit hooks stay
// explicit; this facade never imports the HTTP server or changes the schema.
function createStorage({ DATABASE_URL, MEDIA_DIR, dataDir, dbFile, defaultUsers, normalizeDb, ensureAuditLogStore, ensureWorkerDigestRunStore, appendUndoJournalForMutation, undoProtectedAttachmentIds }) {
  let pgPool = null;
  let pgStore = null;
  // Session checks and edit-lock lookups use a separate one-connection read
  // pool, so they do not wait behind full-state snapshots in the main pool.
  let pgFocusedPool = null;
  let pgFocusedStore = null;
  let pgReady = null;

// BEGIN preserved storage lifecycle
function ensureDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify({ users: defaultUsers, sessions: {}, entries: [], todos: [], attachments: {}, debts: [], clients: [], clientBills: [], auditLog: [], undoJournal: [] }, null, 2), "utf8");
    return;
  }

  const { db, changed } = normalizeDb(JSON.parse(fs.readFileSync(dbFile, "utf8")));
  if (changed) writeDb(db);
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbFile, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), "utf8");
}

function getPgPool() {
  if (pgPool) return pgPool;
  const { Pool } = require("pg");
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  // A small VM cannot keep ten full-state PostgreSQL requests in memory.
  // Mutations are already serialized, so three connections cover reads without
  // amplifying memory pressure or row-lock contention.
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: Math.max(1, Math.min(3, Number(process.env.INDUS_URE_PG_POOL_MAX || 3))),
    idleTimeoutMillis: 10_000
  });
  return pgPool;
}

function getPgStore() {
  if (!pgStore) pgStore = new PostgresStore(getPgPool(), MEDIA_DIR);
  return pgStore;
}

function getFocusedPgPool() {
  if (pgFocusedPool) return pgFocusedPool;
  const { Pool } = require("pg");
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pgFocusedPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 10_000,
    application_name: "indus-ure-focused-read"
  });
  return pgFocusedPool;
}

function getFocusedPgStore() {
  if (!pgFocusedStore) pgFocusedStore = new PostgresStore(getFocusedPgPool(), MEDIA_DIR);
  return pgFocusedStore;
}

function initialDatabaseState() {
  return {
    users: JSON.parse(JSON.stringify(defaultUsers)),
    sessions: {},
    entries: [],
    todos: [],
    attachments: {},
    debts: [],
    clients: [],
    billingLocks: [],
    payrolls: [],
    clientBills: [],
    settlementCorrections: [],
    todoCreateReceipts: {},
    workerDigestRuns: [],
    lateTimeEntryReports: [],
    auditLog: [],
    undoJournal: [],
    settings: {},
    calendarToken: crypto.randomBytes(24).toString("hex"),
    syncRevision: 0
  };
}

async function ensurePostgresDb() {
  if (!DATABASE_URL) return;
  if (pgReady) return pgReady;
  pgReady = (async () => {
    // Normalize legacy JSON once before writing relational rows so UUID client references,
    // assignment groups and attachment metadata survive the conversion intact.
    await getPgStore().ensure(initialDatabaseState(), normalizeDb);
    await ensureAuditLogStore();
    await ensureWorkerDigestRunStore();
  })();
  return pgReady;
}

async function readDbAsync() {
  if (!DATABASE_URL) return readDb();
  await ensurePostgresDb();
  // Normalization is an in-memory compatibility view. A GET must never save
  // this snapshot. Persisted migrations run explicitly before HTTP startup.
  return normalizeDb(await getPgStore().load()).db;
}

async function readRequestDb(req) {
  if (!req.indusDb?.todos) req.indusDb = await readDbAsync();
  return req.indusDb;
}

async function migratePostgresNormalization() {
  await ensurePostgresDb();
  for (let attempt = 0; attempt < 3; attempt++) {
    const db = await getPgStore().load();
    const before = JSON.stringify(db);
    normalizeDb(db);
    if (before === JSON.stringify(db)) return;
    try {
      await getPgStore().save(db, { protectedAttachmentIds: [...undoProtectedAttachmentIds(db)] });
      return;
    } catch (error) {
      if (error.code !== "STALE_SNAPSHOT" || attempt === 2) throw error;
    }
  }
}

async function writeDbAsync(db) {
  appendUndoJournalForMutation(db);
  db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
  if (!DATABASE_URL) {
    writeDb(db);
    return;
  }
  await ensurePostgresDb();
  await getPgStore().save(db, { protectedAttachmentIds: [...undoProtectedAttachmentIds(db)] });
}
// END preserved storage lifecycle

  return { ensureDb, readDb, writeDb, getPgPool, getPgStore, getFocusedPgPool, getFocusedPgStore, initialDatabaseState, ensurePostgresDb, readDbAsync, readRequestDb, migratePostgresNormalization, writeDbAsync };
}

module.exports = { createStorage };
