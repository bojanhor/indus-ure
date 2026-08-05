#!/usr/bin/env node
"use strict";

// Reopens the premature July 2026 payroll confirmation for Ibro and rebuilds
// it using the application's own payroll calculation. It is a one-off,
// reversible operational correction, not production application code.

const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { PostgresStore } = require("../outputs/postgres-store");
const { normalizeDb, buildPayrollSnapshot, clientBillLockForTodos } = require("../outputs/server");

const RECORD_ID = "ibro-july-2026-payroll-reopen-v1";
const PAYROLL_ID = "57c46fff-bba1-47d7-8752-42a9f22979f2";
const ACTOR = { id: "bojan", name: "Bojan" };

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function cli(args) {
  const options = { apply: false, revert: false, force: false };
  for (const argument of args) {
    if (argument === "--apply") options.apply = true;
    else if (argument === "--revert") options.revert = true;
    else if (argument === "--force") options.force = true;
    else throw new Error(`Neznan parameter: ${argument}`);
  }
  if (options.apply && options.revert) throw new Error("Uporabi samo --apply ali --revert.");
  return options;
}

async function main() {
  const options = cli(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL manjka.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  const store = new PostgresStore(pool, path.resolve(process.env.MEDIA_DIR || "/var/lib/indus-ure/media"));
  try {
    await store.ensure({}, normalizeDb);
    const db = await store.load(); normalizeDb(db);
    db.manualReconciliationRecords = Array.isArray(db.manualReconciliationRecords) ? db.manualReconciliationRecords : [];
    const previousRecord = db.manualReconciliationRecords.find((record) => record.id === RECORD_ID && !record.revertedAt);
    const index = db.payrolls.findIndex((payroll) => payroll.id === PAYROLL_ID);
    if (index < 0) throw new Error("Ibrov julijski obračun ne obstaja.");
    const current = db.payrolls[index];

    if (options.revert) {
      if (!previousRecord) throw new Error("Aktivnega popravka za povrnitev ni.");
      if (String(current.updatedAt || "") > String(previousRecord.createdAt || "") && !options.force) {
        throw new Error("Julijski obračun je bil po ponovnem odprtju že urejen; povrnitev je zaradi varnosti ustavljena.");
      }
      db.payrolls[index] = previousRecord.payrollBefore;
      previousRecord.revertedAt = new Date().toISOString(); previousRecord.revertedBy = ACTOR.id;
      db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
      normalizeDb(db); await store.save(db);
      console.log(JSON.stringify({ reverted: RECORD_ID, payrollId: PAYROLL_ID }, null, 2));
      return;
    }
    if (previousRecord) throw new Error("Julijski obračun je že ponovno odprt s tem paketom.");
    if (current.workerId !== "ibro" || current.from !== "2026-07-01" || current.to !== "2026-07-31") throw new Error("Najdeni obračun ni Ibrov julijski obračun.");
    if (current.status !== "confirmed") throw new Error(`Julijski obračun ni v stanju confirmed (trenutno: ${current.status}).`);
    if ((current.payments || []).length || Number(current.paidAmount || 0) > 0) throw new Error("Julij vsebuje izplačilo; potrebna je ročna obravnava.");
    const lockedTodos = (current.lines || []).map((line) => (db.todos || []).find((todo) => todo.id === line.todoId)).filter(Boolean);
    const clientBill = clientBillLockForTodos(db, lockedTodos);
    if (clientBill) throw new Error(`Julijski obračun vsebuje že obračunan vpis stranki ${clientBill.clientName}; potrebna je ločena korekcija.`);
    const now = new Date().toISOString();
    const reopened = buildPayrollSnapshot(db, "ibro", current, {
      ...current,
      status: "draft",
      payments: [], paidAmount: 0, remainingAmount: 0,
      confirmedAt: "", confirmedBy: "", confirmedByName: "",
      paidAt: "", paidBy: "", paidByName: "",
      updatedAt: now, updatedBy: ACTOR.id, updatedByName: ACTOR.name,
      note: String(current.note || "").trim()
    });
    if (!reopened || !reopened.lines.length) throw new Error("Po ponovnem izračunu julij nima vnosov ur.");
    const summary = { payrollId: PAYROLL_ID, beforeLines: (current.lines || []).length, afterLines: reopened.lines.length, hours: reopened.hours, totalAmount: reopened.totalAmount, status: reopened.status };
    if (!options.apply) { console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2)); return; }
    db.payrolls[index] = reopened;
    db.manualReconciliationRecords.push({ id: RECORD_ID, createdAt: now, createdBy: ACTOR.id, payrollBefore: clone(current) });
    db.auditLog = Array.isArray(db.auditLog) ? db.auditLog : [];
    db.auditLog.unshift({ id: crypto.randomUUID(), actorId: ACTOR.id, actorName: ACTOR.name, action: "system.reopen.ibro-july-payroll", targetType: "payroll", targetId: PAYROLL_ID, severity: "info", context: summary, createdAt: now });
    db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
    normalizeDb(db); await store.save(db);
    console.log(JSON.stringify({ applied: true, ...summary }, null, 2));
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
