#!/usr/bin/env node
"use strict";

// One-time, reversible normalization for titles created by legacy hour imports.
// Only a date equal to the event date is removed.  For Ibro's own entries an
// initial "Ibro" marker is also redundant, since the executor is rendered by
// the application separately.

const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { PostgresStore } = require("../outputs/postgres-store");
const { normalizeDb } = require("../outputs/server");

const RUN_ID = "legacy-title-normalization-v1";
const ACTOR = { id: "bojan", name: "Bojan" };

function cli(args) {
  const options = { apply: false, revert: false };
  for (const argument of args) {
    if (argument === "--apply") options.apply = true;
    else if (argument === "--revert") options.revert = true;
    else throw new Error(`Neznan parameter: ${argument}`);
  }
  if (options.apply && options.revert) throw new Error("Uporabi samo --apply ali --revert.");
  return options;
}

function dateTokenPattern(date) {
  const [, , monthRaw, dayRaw] = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!month || !day) return null;
  return new RegExp(`(^|\\s)0?${day}\\s*\\.\\s*0?${month}\\.?(?=\\s|$|[:,;–-])`, "g");
}

function tidyTitle(value) {
  return String(value || "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[\s:;,–-]+/, "")
    .trim();
}

function normalizedTitle(todo) {
  const before = String(todo.title || "");
  let title = before;
  let removedDate = false;
  const datePattern = dateTokenPattern(todo.date);
  if (datePattern) {
    const next = title.replace(datePattern, (match, leading) => {
      removedDate = true;
      return leading;
    });
    title = next;
  }
  let removedIbro = false;
  if (String(todo.syncUser || "") === "ibro") {
    const next = title.trimStart().replace(/^ibro\b[\s:;,–-]*/i, () => {
      removedIbro = true;
      return "";
    });
    title = next;
  }
  if (!removedDate && !removedIbro) return { before, after: before, changed: false, removedDate, removedIbro };
  title = tidyTitle(title);
  return { before, after: title, changed: before !== title, removedDate, removedIbro };
}

function importedHourTodo(todo) {
  return Boolean(String(todo.legacyImportBatchId || "").trim());
}

async function main() {
  const options = cli(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL manjka.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  const store = new PostgresStore(pool, path.resolve(process.env.MEDIA_DIR || "/var/lib/indus-ure/media"));
  try {
    await store.ensure({}, normalizeDb);
    const db = await store.load();
    normalizeDb(db);
    db.legacyTitleNormalizationRuns = Array.isArray(db.legacyTitleNormalizationRuns) ? db.legacyTitleNormalizationRuns : [];
    const priorRun = db.legacyTitleNormalizationRuns.find((run) => run.id === RUN_ID && !run.revertedAt);
    if (options.revert) {
      if (!priorRun) throw new Error("Aktivnega popravka naslovov ni.");
      const changedAt = String(priorRun.appliedAt || "");
      const edits = [];
      for (const item of priorRun.edits || []) {
        const todo = (db.todos || []).find((candidate) => candidate.id === item.id);
        if (!todo) throw new Error(`Manjka vnos ${item.id}; povrnitev je ustavljena.`);
        if (String(todo.updatedAt || "") > changedAt) throw new Error(`Vnos ${todo.title} je bil po popravku urejen; povrnitev je ustavljena.`);
        edits.push({ todo, before: todo.title, after: item.before });
      }
      const now = new Date().toISOString();
      for (const edit of edits) {
        edit.todo.title = edit.after;
        edit.todo.updatedAt = now;
        edit.todo.updatedBy = ACTOR.id;
        edit.todo.updatedByName = ACTOR.name;
        edit.todo.history = [...(edit.todo.history || []), { at: now, by: ACTOR.id, name: ACTOR.name, action: "povrnjen popravek naslova zgodovinskega uvoza" }];
      }
      priorRun.revertedAt = now;
      priorRun.revertedBy = ACTOR.id;
      db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
      normalizeDb(db);
      await store.save(db);
      console.log(JSON.stringify({ reverted: RUN_ID, count: edits.length }, null, 2));
      return;
    }
    if (priorRun) throw new Error("Ta popravek naslovov je že izveden.");
    const edits = (db.todos || [])
      .filter(importedHourTodo)
      .map((todo) => ({ todo, ...normalizedTitle(todo) }))
      .filter((item) => item.changed && item.after);
    const summary = {
      candidates: edits.length,
      removedDate: edits.filter((item) => item.removedDate).length,
      removedIbro: edits.filter((item) => item.removedIbro).length,
      examples: edits.slice(0, 8).map(({ todo, before, after }) => ({ date: todo.date, assignee: todo.syncUser, before, after }))
    };
    if (!options.apply) {
      console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2));
      return;
    }
    const now = new Date().toISOString();
    const record = { id: RUN_ID, appliedAt: now, appliedBy: ACTOR.id, edits: [] };
    for (const edit of edits) {
      record.edits.push({ id: edit.todo.id, before: edit.before, after: edit.after });
      edit.todo.title = edit.after;
      edit.todo.updatedAt = now;
      edit.todo.updatedBy = ACTOR.id;
      edit.todo.updatedByName = ACTOR.name;
      edit.todo.history = [...(edit.todo.history || []), { at: now, by: ACTOR.id, name: ACTOR.name, action: "počiščen naslov zgodovinskega uvoza (datum/izvajalec)" }];
    }
    db.legacyTitleNormalizationRuns.push(record);
    db.auditLog = Array.isArray(db.auditLog) ? db.auditLog : [];
    db.auditLog.unshift({ id: crypto.randomUUID(), actorId: ACTOR.id, actorName: ACTOR.name, action: "system.normalize.legacy-import-titles", targetType: "legacy-import", targetId: RUN_ID, severity: "info", context: { count: edits.length, removedDate: summary.removedDate, removedIbro: summary.removedIbro }, createdAt: now });
    db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
    normalizeDb(db);
    await store.save(db);
    console.log(JSON.stringify({ applied: RUN_ID, ...summary }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
