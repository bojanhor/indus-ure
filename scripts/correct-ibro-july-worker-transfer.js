#!/usr/bin/env node
"use strict";

// One-time, reversible correction for seven July 2026 entries that were first
// confirmed under Bojan and subsequently assigned to Ibro.  The old payroll
// stays immutable: this script creates a negative delta for Bojan, while the
// normal entries return to Ibro's still-open July payroll.

const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { PostgresStore } = require("../outputs/postgres-store");
const {
  normalizeDb,
  upsertSettlementCorrections,
  buildPayrollSnapshot,
  reconcileTodoArchives
} = require("../outputs/server");

const BATCH = "ibro-july-2026-worker-transfer-correction-v1";
const ACTOR = { id: "bojan", name: "Bojan" };
const SOURCE_PAYROLL_ID = "2af7e3ef-6e43-4072-b245-d31bfedf3ddf";
const TASK_IDS = [
  "3e62b2aa-91b0-4f24-9e75-0a433fe1a53a",
  "736a5ba6-ed26-4939-a5b2-1bcb90d99034",
  "7c4f88e5-4a22-43b4-9cad-8852344475a3",
  "9c9cbca7-cb81-44b9-b27e-1ed62194b71d",
  "0c58d08e-507d-4486-b65f-b5d91c5b5a47",
  "ed0f4af4-e1a0-4f65-8a24-07456f23ac8a",
  "69a06a09-0eb4-4a69-9265-038714424c44"
];

function optionsFrom(args) {
  const options = { apply: false, revert: false };
  for (const value of args) {
    if (value === "--apply") options.apply = true;
    else if (value === "--revert") options.revert = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  if (options.apply && options.revert) throw new Error("Use only --apply or --revert.");
  return options;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function sourceLine(db, todoId) {
  const matches = [];
  for (const payroll of db.payrolls || []) {
    if (!["confirmed", "paid"].includes(String(payroll.status || ""))) continue;
    for (const line of payroll.lines || []) {
      if (String(line.todoId || "") === todoId) matches.push({ payroll, line });
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one confirmed source line for ${todoId}, found ${matches.length}.`);
  const match = matches[0];
  if (String(match.payroll.id || "") !== SOURCE_PAYROLL_ID || String(match.payroll.workerId || "") !== "bojan") {
    throw new Error(`Unexpected historical payroll for ${todoId}.`);
  }
  return match;
}

function plan(db) {
  const todosById = new Map((db.todos || []).map((todo) => [String(todo.id || ""), todo]));
  const todos = TASK_IDS.map((id) => {
    const todo = todosById.get(id);
    if (!todo) throw new Error(`Missing task ${id}.`);
    if (String(todo.syncUser || "") !== "ibro") throw new Error(`Task ${id} is no longer assigned to Ibro.`);
    sourceLine(db, id);
    return todo;
  });
  return todos;
}

function expectedPreview(db, todos) {
  const simulated = clone(db);
  const result = upsertSettlementCorrections(simulated, todos, todos, ACTOR);
  if (result.error) throw new Error(result.error);
  if (result.corrections.length !== TASK_IDS.length) throw new Error(`Expected ${TASK_IDS.length} correction rows, received ${result.corrections.length}.`);
  for (const correction of result.corrections) {
    if (correction.type !== "worker" || correction.workerId !== "bojan" || correction.sourcePayrollId !== SOURCE_PAYROLL_ID) {
      throw new Error("Generated correction has an unexpected target.");
    }
  }

  const removedHours = Number((-result.corrections.reduce((sum, item) => sum + Number(item.delta?.hours || 0), 0)).toFixed(2));
  const removedAmount = Number((-result.corrections.reduce((sum, item) => sum + Number(item.delta?.workAmount || 0) + Number(item.delta?.kmAmount || 0), 0)).toFixed(2));
  const ibroDraft = (simulated.payrolls || []).find((payroll) => payroll.workerId === "ibro" && payroll.from === "2026-07-01" && payroll.to === "2026-07-31") || { id: "ibro-july-preview", status: "draft" };
  const ibroJuly = buildPayrollSnapshot(simulated, "ibro", { from: "2026-07-01", to: "2026-07-31" }, ibroDraft);
  const ibroLines = ibroJuly.lines.filter((line) => TASK_IDS.includes(String(line.todoId || "")));
  if (ibroLines.length !== TASK_IDS.length) throw new Error(`Ibro July preview contains ${ibroLines.length} of ${TASK_IDS.length} transferred entries.`);
  const ibroHours = Number(ibroLines.reduce((sum, line) => sum + Number(line.hours || 0), 0).toFixed(2));
  const ibroAmount = Number(ibroLines.reduce((sum, line) => sum + Number(line.totalAmount || 0), 0).toFixed(2));

  return {
    corrections: result.corrections,
    removedHours,
    removedAmount,
    ibroHours,
    ibroAmount,
    effectiveDate: result.corrections[0]?.effectiveDate || ""
  };
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL is missing.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  const store = new PostgresStore(pool, path.resolve(process.env.MEDIA_DIR || "/var/lib/indus-ure/media"));
  try {
    await store.ensure({}, normalizeDb);
    const db = await store.load();
    normalizeDb(db);
    db.settlementCorrectionRuns = Array.isArray(db.settlementCorrectionRuns) ? db.settlementCorrectionRuns : [];
    const existing = db.settlementCorrectionRuns.find((item) => item.id === BATCH && !item.revertedAt);

    if (options.revert) {
      if (!existing) throw new Error("No active correction run is available to revert.");
      const correctionIds = new Set(existing.correctionIds || []);
      const corrections = (db.settlementCorrections || []).filter((item) => correctionIds.has(item.id));
      if (corrections.length !== correctionIds.size) throw new Error("Some correction rows are missing; revert stopped.");
      if (corrections.some((item) => item.status !== "pending")) throw new Error("A correction has already been settled; it may not be reverted automatically.");
      db.settlementCorrections = db.settlementCorrections.filter((item) => !correctionIds.has(item.id));
      existing.revertedAt = nowIso();
      existing.revertedBy = ACTOR.id;
      db.auditLog = Array.isArray(db.auditLog) ? db.auditLog : [];
      db.auditLog.unshift({ id: crypto.randomUUID(), actorId: ACTOR.id, actorName: ACTOR.name, action: "system.revert.ibro-july-worker-transfer-correction", targetType: "settlement_correction", targetId: BATCH, severity: "warning", context: { correctionIds: [...correctionIds] }, createdAt: existing.revertedAt });
      db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
      normalizeDb(db);
      await store.save(db);
      console.log(JSON.stringify({ reverted: BATCH, corrections: correctionIds.size }, null, 2));
      return;
    }

    if (existing) throw new Error("This correction run has already been applied.");
    const todos = plan(db);
    const preview = expectedPreview(db, todos);
    if (!options.apply) {
      console.log(JSON.stringify({
        dryRun: true,
        batch: BATCH,
        tasks: todos.map((todo) => ({ id: todo.id, date: todo.date, title: todo.title })),
        formerWorkerDelta: { worker: "bojan", hours: -preview.removedHours, amount: -preview.removedAmount, effectiveDate: preview.effectiveDate },
        ibroJulyAddition: { worker: "ibro", hours: preview.ibroHours, amount: preview.ibroAmount }
      }, null, 2));
      return;
    }

    const applied = upsertSettlementCorrections(db, todos, todos, ACTOR);
    if (applied.error || applied.corrections.length !== TASK_IDS.length) {
      throw new Error(applied.error || "The correction result did not contain every expected entry.");
    }
    const correctionIds = applied.corrections.map((item) => item.id);
    db.settlementCorrectionRuns.push({
      id: BATCH,
      createdAt: nowIso(),
      createdBy: ACTOR.id,
      sourcePayrollId: SOURCE_PAYROLL_ID,
      taskIds: TASK_IDS,
      correctionIds,
      formerWorkerDelta: { hours: -preview.removedHours, amount: -preview.removedAmount },
      ibroJulyAddition: { hours: preview.ibroHours, amount: preview.ibroAmount }
    });
    const archive = reconcileTodoArchives(db, ACTOR);
    db.auditLog = Array.isArray(db.auditLog) ? db.auditLog : [];
    db.auditLog.unshift({ id: crypto.randomUUID(), actorId: ACTOR.id, actorName: ACTOR.name, action: "system.correct.ibro-july-worker-transfer", targetType: "settlement_correction", targetId: BATCH, severity: "warning", context: { sourcePayrollId: SOURCE_PAYROLL_ID, taskIds: TASK_IDS, correctionIds, formerWorkerDelta: { hours: -preview.removedHours, amount: -preview.removedAmount }, ibroJulyAddition: { hours: preview.ibroHours, amount: preview.ibroAmount }, archive }, createdAt: nowIso() });
    db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
    normalizeDb(db);
    await store.save(db);
    console.log(JSON.stringify({
      applied: BATCH,
      correctionIds,
      formerWorkerDelta: { worker: "bojan", hours: -preview.removedHours, amount: -preview.removedAmount, effectiveDate: preview.effectiveDate },
      ibroJulyAddition: { worker: "ibro", hours: preview.ibroHours, amount: preview.ibroAmount },
      archive
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});