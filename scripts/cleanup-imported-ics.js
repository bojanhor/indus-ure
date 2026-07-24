#!/usr/bin/env node
"use strict";

// Narrow, auditable cleanup for the exact unwanted entries from the 2026 ICS import.
const { Pool } = require("pg");
const { PostgresStore } = require("../outputs/postgres-store");
const { normalizeDb } = require("../outputs/server");

const BATCH = "ics-private-20260724";

function cleanText(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("sl");
}

function cleanupReason(todo) {
  if (!todo?.imported || String(todo.importBatchId || "") !== BATCH) return "";
  const title = cleanText(todo.title);
  if (title === "\u0161vejk obra\u010dun stro\u0161kov") return "ponavljajo\u010d obra\u010dun \u0161vejka";
  if (title === "buffer") return "samostojen buffer";
  if (title === "vinjeta tiguan") return "vinjeta tiguan";
  if (title === "pelji \u0161vejk ?") return "pelji \u0161vejk";
  if (title === "pi\u0161tola") return "pi\u0161tola";
  if (title === "naro\u010di" && cleanText(todo.notes).includes("kabelgel")) return "naro\u010di kabelgel";
  if (title === "hobo poka\u017ei domofon" && String(todo.date || "") === "2026-07-14") return "drugi podvojeni hobo domofon";
  return "";
}

function buildCleanupPlan(todos) {
  return (Array.isArray(todos) ? todos : [])
    .map((todo) => ({ id: String(todo?.id || ""), date: String(todo?.date || ""), title: String(todo?.title || ""), reason: cleanupReason(todo) }))
    .filter((item) => item.id && item.reason)
    .sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL manjka.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  const store = new PostgresStore(pool, process.env.MEDIA_DIR || "/var/lib/indus-ure/media");
  try {
    await store.ensure({}, normalizeDb);
    const db = await store.load();
    normalizeDb(db);
    const plan = buildCleanupPlan(db.todos);
    if (!apply) {
      process.stdout.write(`${JSON.stringify({ mode: "dry-run", batch: BATCH, remove: plan.length, items: plan })}\n`);
      return;
    }
    const ids = new Set(plan.map((item) => item.id));
    db.todos = db.todos.filter((todo) => !ids.has(String(todo.id || "")));
    db.icsImports = Array.isArray(db.icsImports) ? db.icsImports : [];
    const record = db.icsImports.find((item) => item.id === BATCH);
    if (record) {
      record.cleanupHistory = Array.isArray(record.cleanupHistory) ? record.cleanupHistory : [];
      record.cleanupHistory.push({ at: new Date().toISOString(), removed: plan });
    }
    db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
    await store.save(db);
    process.stdout.write(`${JSON.stringify({ mode: "apply", batch: BATCH, removed: plan.length, items: plan })}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { BATCH, buildCleanupPlan, cleanupReason };