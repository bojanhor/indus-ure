#!/usr/bin/env node
"use strict";

// One-time reconciliation of Ibro's July 2026 source timesheet.
// It is intentionally separate from the app: no production code changes are
// needed. Run with --dry-run first, then --apply. --revert refuses to run if
// a reconciled task has since been edited, unless --force is supplied.

const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { PostgresStore } = require("../outputs/postgres-store");
const { normalizeDb } = require("../outputs/server");

const BATCH = "ibro-july-2026-reconcile-v1";
const ACTOR = { id: "bojan", name: "Bojan" };

const MOVES = [
  ["2026-07-07", "7.7. reševanje napake na stroju 1,5h"],
  ["2026-07-09", "9.7. menjava faznega nadzornega releja in menjava filtra elektro omare v rastlinjaku 1,5h; material: 1x fazni nadzorni rele, 1x filter"],
  ["2026-07-09", "9.7. menjava ventilatorja 1h; material: 1x ventilator"],
  ["2026-07-10", "10.7. ogled 1h"],
  ["2026-07-11", "11.7. LOGO za vodo 1,5h; material: 3x optosklopnik"],
  ["2026-07-11", "11.7. montaža LED osvetlitve stopnic 2h; material: LED trak 12V, napajalnik 12V 60W"],
  ["2026-07-14", "14.7. intervencija – menjava varovalke 1h; material: 1x C16 odklopnik"]
];

// Time slots follow the source order inside a daily row. The old system did
// not state the time of each individual project, so every new item stays
// visibly marked for review in its notes.
const ENTRIES = [
  { date: "2026-07-02", start: "10:00", end: "11:00", client: "JEZERŠEK d.o.o. Luka", title: "Nalaganje programa in razrez profilov", material: "2x pokrovčka za profil", source: "2. 7. 2026: Jezeršek nalaganje programa in razrez profilov 1h" },
  { date: "2026-07-06", start: "07:30", end: "09:00", client: "Cilka", title: "Hladilnik – grelni kabel", source: "6. 7. 2026: Cilka 1,5h hladilnik, grelni kabel" },
  { date: "2026-07-06", start: "09:00", end: "09:30", client: "Anže Mihovec Forma", title: "Tokovniki za odsesovanje", source: "6. 7. 2026: Mihovec 0,5h tokovniki za odsesovanje" },
  { date: "2026-07-06", start: "09:30", end: "10:30", client: "Anže Mihovec Forma", title: "Kamera in internet", source: "6. 7. 2026: Mihovec 1h kamera in internet" },
  { date: "2026-07-06", start: "10:30", end: "12:00", client: "Anže Mihovec Forma", title: "Odpravljanje napake na robni mašini", source: "6. 7. 2026: Mihovec 1,5h odpravljanje napake na robni mašini" },
  { date: "2026-07-07", start: "09:00", end: "10:30", client: "MIZARSTVO KOŠNIK", title: "Nastavitev OpenVPN, ogled kamere in kabel", source: "7. 7. 2026: Košnik 1,5h nastavitev OpenVPN, ogled kamere in kabel" },
  { date: "2026-07-08", start: "07:30", end: "15:30", client: "MIZARSTVO KOŠNIK", title: "Vleka kabla za kamero in montaža stikala za luč v kurilnici", material: "28 m CAT6; 3x 10x10 kanalček 3 m; Euroflex fi12; stikalo, okvir, nosilec in blenda", source: "8. 7. 2026: Košnik" },
  { date: "2026-07-09", start: "10:00", end: "14:00", client: "MIZARSTVO KOŠNIK", title: "Montaža nove kamere in prestavljanje stare kamere", material: "3x kamera; 3x patch kabel; UniFi 2.5 Gb switch; PoE konvertor; 2x modul za vtičnico za na šino; 2x vtičnica TEM; 3 m žice 2,5 mm²; 30 cm šine", source: "9. 7. 2026: Košnik 4h montaža nove kamere in prestavljanje stare kamere" },
  { date: "2026-07-10", start: "09:00", end: "11:30", client: "MIZARSTVO KOŠNIK", title: "Montaža omare, nastavitev kamere in menjava žarnice", material: "Hager omara; 15 m sive cevi fi16; 10 m cevi fi32; 1x žarnica", source: "10. 7. 2026: Košnik 2,5h" },
  { date: "2026-07-13", start: "07:00", end: "18:30", client: "MIZARSTVO KOŠNIK", title: "Dovod za polnilnice", material: "50 m 5x6; 2x 3C32A; 1x FID; 1 m šine; 1 m kanala 25; zbiralka 6 mest; 2x sponke za nulo in zemljo 35 mm; 15 m sive cevi fi32", source: "13. 7. 2026: Košnik" },
  { date: "2026-07-14", start: "08:00", end: "15:00", client: "MIZARSTVO KOŠNIK", title: "Montaža kamer in priprava za polnilnico", material: "5 m CAT6", source: "14. 7. 2026: Košnik 7h" },
  { date: "2026-07-16", start: "07:30", end: "14:30", client: "MIZARSTVO KOŠNIK", title: "Montaža elektro opreme za polnilnice", material: "switch 8 PoE; FID 63 A; 3C63; 3x D02 35 A; žica 10 mm²; zbiralke; 35 Cu sponka; 1C10; UTP 7 m; 8x UTP konektor", source: "16. 7. 2026: Košnik 7h" },
  { date: "2026-07-16", start: "14:30", end: "16:00", client: "Vid Cerklje", title: "Diagnostika ugašanja FID", source: "16. 7. 2026: Vid Cerklje FID 1,5h" },
  { date: "2026-07-16", start: "16:00", end: "17:00", client: "lukić", title: "Dodajanje releja", material: "1x rele z nosilcem; žica 1,5 mm²", source: "16. 7. 2026: Lukić 1h dodajanje releja" },
  { date: "2026-07-17", start: "08:30", end: "11:00", client: "Vid Cerklje", title: "Vezava FID-ov", source: "17. 7. 2026: Vid vezava FID-ov 2,5h; v starem seznamu označeno PORAČUNANO" }
];

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

function normal(value) { return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("sl"); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function nowIso() { return new Date().toISOString(); }
function audit(by, action, at) { return { at, by: ACTOR.id, byName: ACTOR.name, action: `${by}: ${action}` }; }

function hourlyRate(db, userId) {
  const value = Number(db.users?.[userId]?.billing?.hourlyRate);
  return Number.isFinite(value) && value >= 0 ? value : 15;
}

function clientByName(db, wanted) {
  const needle = normal(wanted);
  return (db.clients || []).find((client) => [client.clientId, client.id, client.alias, client.name, client.search]
    .some((value) => normal(value) === needle));
}

function getOrCreateClient(db, alias, createdClientIds, at) {
  const existing = clientByName(db, alias);
  if (existing) return existing;
  if (alias !== "Cilka") throw new Error(`Manjka pričakovana obstoječa stranka: ${alias}`);
  const clientId = crypto.randomUUID();
  const client = {
    id: clientId, clientId, name: "Cilka", search: "Cilka", email: "", phone: "", contacts: [], address: "", city: "", postal: "", country: "", taxId: "", registryNumber: "",
    vatPayer: false, source: "ad-hoc", needsReview: true, createdBy: ACTOR.id, createdAt: at, updatedAt: at
  };
  db.clients.push(client);
  createdClientIds.push(clientId);
  return client;
}

function findMoveTodo(db, date, title) {
  const matches = (db.todos || []).filter((todo) => String(todo.date) === date && String(todo.title) === title && String(todo.syncUser) === "bojan");
  if (matches.length !== 1) throw new Error(`Pričakoval sem natanko en Bojanov vnos za prenos: ${date} – ${title}; najdeno: ${matches.length}`);
  const todo = matches[0];
  if (String(todo.archivedPayrollId || "") || String(todo.archivedClientBillId || "")) throw new Error(`Vnos ${title} je že arhiviran in ga ne prenesem brez ločenega obračunskega popravka.`);
  return todo;
}

function findDuplicate(db, entry) {
  return (db.todos || []).some((todo) => String(todo.date) === entry.date && String(todo.syncUser) === "ibro" && normal(todo.title) === normal(entry.title));
}

function makeTodo(db, entry, at, order) {
  const client = getOrCreateClient(db, entry.client, order.createdClientIds, at);
  const id = crypto.randomUUID();
  const note = [
    `Enkratna uskladitev Ibrovih ur: ${entry.source}.`,
    "Čas projekta je razporejen po vrstnem redu opisa; stari seznam ni imel ure posameznega projekta."
  ].join("\n\n");
  return {
    id, assignmentGroupId: id, legacyImportBatchId: BATCH, legacySource: entry.source,
    title: entry.title, notes: note, material: entry.material || "", date: entry.date, endDate: entry.date, start: entry.start, end: entry.end,
    client: client.name, clientId: client.clientId, clientContactIds: [], clientContacts: [], status: "execution", done: true,
    syncUser: "ibro", createdBy: ACTOR.id, createdByName: ACTOR.name, createdAt: at, updatedBy: ACTOR.id, updatedByName: ACTOR.name, updatedAt: at,
    billingHourlyRate: hourlyRate(db, "ibro"), billingKm: 0, clientKm: 0, clientVehicle: "personal", clientKmRate: 0,
    hoursNeedsReview: true, workFromHome: false, warranty: false, urgent: false, ordered: false, calendarOnly: false,
    order: order.value--, userOrderBuckets: { ibro: "unsorted" }, sharedManualBucket: "sorted", sharedManualOrder: 0,
    completionRequests: [], driveFiles: [], photos: [], imported: false,
    history: [audit("enkratna uskladitev Ibrovih ur", entry.source, at)]
  };
}

function makeHistoricClientBill(todo, at) {
  const id = crypto.randomUUID();
  return {
    id, clientId: todo.clientId, clientName: todo.client, from: todo.date, to: todo.date, status: "confirmed",
    eventIds: [todo.assignmentGroupId || todo.id],
    lines: [{ eventId: todo.assignmentGroupId || todo.id, todoIds: [todo.id], date: todo.date, start: todo.start, end: todo.end, title: todo.title, clientKm: 0, clientVehicle: "personal", warranty: false, clientKmRate: 0 }],
    createdBy: ACTOR.id, createdByName: ACTOR.name, createdAt: at, confirmedAt: at, confirmedBy: ACTOR.id, confirmedByName: ACTOR.name,
    note: "Zgodovinski prenos: uporabnik je potrdil, da je bil ta vpis v starem sistemu že poračunan s stranko."
  };
}

function plan(db) {
  const moveTodos = MOVES.map(([date, title]) => findMoveTodo(db, date, title));
  const duplicateEntries = ENTRIES.filter((entry) => findDuplicate(db, entry));
  if (duplicateEntries.length) throw new Error(`Manjkajoči vnosi že obstajajo: ${duplicateEntries.map((item) => `${item.date} ${item.title}`).join("; ")}`);
  return { moveTodos, entries: ENTRIES };
}

function summarize(planned) {
  const movedMinutes = planned.moveTodos.reduce((total, todo) => {
    const [sh, sm] = String(todo.start || "").split(":").map(Number); const [eh, em] = String(todo.end || "").split(":").map(Number);
    return total + ((eh * 60 + em) - (sh * 60 + sm));
  }, 0);
  const createdMinutes = planned.entries.reduce((total, todo) => {
    const [sh, sm] = todo.start.split(":").map(Number); const [eh, em] = todo.end.split(":").map(Number);
    return total + ((eh * 60 + em) - (sh * 60 + sm));
  }, 0);
  return { moves: planned.moveTodos.length, movedHours: movedMinutes / 60, creates: planned.entries.length, createdHours: createdMinutes / 60 };
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
    db.legacyHourImports = Array.isArray(db.legacyHourImports) ? db.legacyHourImports : [];
    const record = db.legacyHourImports.find((item) => item.id === BATCH && !item.revertedAt);
    if (options.revert) {
      if (!record) throw new Error("Aktivnega paketa za povrnitev ni.");
      const affected = [...(record.createdTodoIds || []), ...(record.movedTodos || []).map((item) => item.id)];
      const edited = (db.todos || []).filter((todo) => affected.includes(todo.id) && String(todo.updatedAt || "") > String(record.createdAt || ""));
      if (edited.length && !options.force) throw new Error(`Po uskladitvi je bilo urejenih ${edited.length} vnosov; povrnitev je zaradi varnosti ustavljena.`);
      const removed = new Set(record.createdTodoIds || []);
      db.todos = (db.todos || []).filter((todo) => !removed.has(todo.id));
      for (const original of record.movedTodos || []) {
        const index = db.todos.findIndex((todo) => todo.id === original.id);
        if (index < 0) throw new Error(`Manjka preneseni vnos ${original.id}; povrnitev je ustavljena.`);
        db.todos[index] = original;
      }
      const billIds = new Set(record.createdClientBillIds || []);
      db.clientBills = (db.clientBills || []).filter((bill) => !billIds.has(bill.id));
      for (const clientId of record.createdClientIds || []) {
        const stillUsed = (db.todos || []).some((todo) => todo.clientId === clientId);
        if (!stillUsed) db.clients = (db.clients || []).filter((client) => client.clientId !== clientId);
      }
      record.revertedAt = nowIso(); record.revertedBy = ACTOR.id;
      db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
      normalizeDb(db); await store.save(db);
      console.log(JSON.stringify({ reverted: BATCH, removedTodos: removed.size, restoredMoves: (record.movedTodos || []).length }, null, 2));
      return;
    }
    if (record) throw new Error("Ta paket uskladitve je že uporabljen.");
    const planned = plan(db);
    const result = summarize(planned);
    if (!options.apply) { console.log(JSON.stringify({ batch: BATCH, dryRun: true, ...result, moves: planned.moveTodos.map((todo) => ({ id: todo.id, date: todo.date, title: todo.title })), creates: planned.entries }, null, 2)); return; }
    const at = nowIso();
    const batchRecord = { id: BATCH, format: "indus-ure-ibro-july-reconcile-v1", createdAt: at, createdBy: ACTOR.id, movedTodos: planned.moveTodos.map(clone), createdTodoIds: [], createdClientIds: [], createdClientBillIds: [] };
    for (const todo of planned.moveTodos) {
      todo.syncUser = "ibro"; todo.billingHourlyRate = hourlyRate(db, "ibro"); todo.updatedAt = at; todo.updatedBy = ACTOR.id; todo.updatedByName = ACTOR.name;
      todo.userOrderBuckets = { ...(todo.userOrderBuckets || {}), ibro: "unsorted" };
      todo.history = [...(todo.history || []), audit("enkratna uskladitev Ibrovih ur", "prenesen z Bojana na Ibra po izvorni evidenci", at)];
    }
    const order = { value: Math.min(0, ...(db.todos || []).map((todo) => Number(todo.order || 0))) - 1, createdClientIds: batchRecord.createdClientIds };
    const created = planned.entries.map((entry) => makeTodo(db, entry, at, order));
    db.todos.push(...created); batchRecord.createdTodoIds = created.map((todo) => todo.id);
    const billed = created.find((todo) => todo.date === "2026-07-17" && todo.client === (clientByName(db, "Vid Cerklje") || {}).name);
    if (!billed) throw new Error("Manjka ustvarjeni vpis Vid Cerklje za 17. julij.");
    const bill = makeHistoricClientBill(billed, at);
    db.clientBills = Array.isArray(db.clientBills) ? db.clientBills : []; db.clientBills.push(bill); batchRecord.createdClientBillIds.push(bill.id);
    billed.clientBillId = bill.id; billed.clientBilledAt = at;
    billed.history = [...(billed.history || []), audit("enkratna uskladitev Ibrovih ur", "zgodovinsko označeno kot obračunano s stranko", at)];
    db.legacyHourImports.push(batchRecord);
    db.auditLog = Array.isArray(db.auditLog) ? db.auditLog : [];
    db.auditLog.unshift({ id: crypto.randomUUID(), actorId: ACTOR.id, actorName: ACTOR.name, action: "system.reconcile.ibro-july-2026", targetType: "timesheet", targetId: BATCH, severity: "info", context: { movedHours: result.movedHours, createdHours: result.createdHours, clientBillId: bill.id }, createdAt: at });
    db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
    normalizeDb(db); await store.save(db);
    console.log(JSON.stringify({ batch: BATCH, applied: true, ...result, clientBillId: bill.id }, null, 2));
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
