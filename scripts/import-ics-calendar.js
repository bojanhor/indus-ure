#!/usr/bin/env node
"use strict";

// One-time, reversible ICS importer. Imported items deliberately stay outside
// the ordinary calendar, payroll and client-billing flows (`imported: true`).
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { Pool } = require("pg");
const { PostgresStore } = require("../outputs/postgres-store");
const { normalizeDb } = require("../outputs/server");

const DEFAULT_FROM = "2026-07-01";
const DEFAULT_TO = "2031-06-30";
const TARGET_TIME_ZONE = "Europe/Ljubljana";

function cli(argv) {
  const result = { source: "", from: DEFAULT_FROM, to: DEFAULT_TO, user: "bojan", batch: "", report: "", apply: false, revert: "", force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") result.apply = true;
    else if (argument === "--force") result.force = true;
    else if (["--source", "--from", "--to", "--user", "--batch", "--report", "--revert"].includes(argument)) result[argument.slice(2)] = String(argv[++index] || "");
    else throw new Error(`Neznan parameter: ${argument}`);
  }
  return result;
}

function assertDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} mora biti v obliki LLLL-MM-DD.`);
}

function unescapeIcs(value) {
  return String(value || "").replace(/\\[nN]/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function unfoldIcs(input) {
  return String(input || "").replace(/^\uFEFF/, "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function contentLine(line) {
  const separator = line.indexOf(":");
  if (separator < 0) return null;
  const left = line.slice(0, separator);
  const [rawName, ...parameterParts] = left.split(";");
  const parameters = Object.fromEntries(parameterParts.map((part) => {
    const equals = part.indexOf("=");
    return [part.slice(0, equals).toUpperCase(), equals < 0 ? "" : part.slice(equals + 1)];
  }));
  return { name: rawName.toUpperCase(), parameters, value: line.slice(separator + 1) };
}

function parseIcsEvents(input) {
  const events = [];
  let properties = null;
  for (const line of unfoldIcs(input)) {
    if (line === "BEGIN:VEVENT") { properties = {}; continue; }
    if (line === "END:VEVENT") {
      if (properties) events.push(properties);
      properties = null;
      continue;
    }
    if (!properties) continue;
    const property = contentLine(line);
    if (!property) continue;
    (properties[property.name] ||= []).push(property);
  }
  return events;
}

function first(properties, name) {
  return properties[name]?.[0] || null;
}

function all(properties, name) {
  return properties[name] || [];
}

function localPartsFromUtc(date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TARGET_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}

function parseIcsDate(property) {
  if (!property?.value) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/.exec(property.value.trim());
  if (!match) throw new Error(`Neveljaven ICS datum: ${property.value}`);
  const raw = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0) };
  const allDay = !match[4];
  const parts = match[7] ? localPartsFromUtc(new Date(Date.UTC(raw.year, raw.month - 1, raw.day, raw.hour, raw.minute, raw.second))) : raw;
  return { ...parts, allDay, utc: Boolean(match[7]), date: `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`, time: allDay ? "" : `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}` };
}

function dateTimeKey(value) {
  return value ? `${value.date}T${value.time || "00:00"}` : "";
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftedOccurrence(start, frequency, interval, ordinal, rule) {
  const monthOffset = frequency === "YEARLY" ? ordinal * interval * 12 : ordinal * interval;
  const absoluteMonth = start.year * 12 + (start.month - 1) + monthOffset;
  const year = Math.floor(absoluteMonth / 12);
  const month = (absoluteMonth % 12) + 1;
  const requestedMonth = frequency === "YEARLY" && rule.BYMONTH ? Number(rule.BYMONTH.split(",")[0]) : month;
  const requestedDay = rule.BYMONTHDAY ? Number(rule.BYMONTHDAY.split(",")[0]) : start.day;
  const finalMonth = requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth : month;
  const day = Math.min(Math.max(1, requestedDay), daysInMonth(year, finalMonth));
  return { ...start, year, month: finalMonth, day, date: `${String(year).padStart(4, "0")}-${String(finalMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

function parseRule(value) {
  return Object.fromEntries(String(value || "").split(";").filter(Boolean).map((part) => {
    const equals = part.indexOf("=");
    return [part.slice(0, equals).toUpperCase(), part.slice(equals + 1)];
  }));
}

function recurrenceInstances(event) {
  const startProperty = first(event, "DTSTART");
  const start = parseIcsDate(startProperty);
  const ruleProperty = first(event, "RRULE");
  if (!ruleProperty) return [{ start, recurrenceId: dateTimeKey(start) }];
  const rule = parseRule(ruleProperty.value);
  const frequency = String(rule.FREQ || "").toUpperCase();
  if (!new Set(["YEARLY", "MONTHLY"]).has(frequency)) throw new Error(`Nepodprta ponovitev ${frequency || "?"} za ${unescapeIcs(first(event, "SUMMARY")?.value) || "dogodek"}.`);
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const count = rule.COUNT ? Math.max(0, Number(rule.COUNT)) : 10_000;
  const until = rule.UNTIL ? parseIcsDate({ value: rule.UNTIL }).date + "T" + (parseIcsDate({ value: rule.UNTIL }).time || "23:59") : "9999-12-31T23:59";
  const exdates = new Set(all(event, "EXDATE").flatMap((property) => property.value.split(",")).map((value) => dateTimeKey(parseIcsDate({ value }))));
  const instances = [];
  for (let ordinal = 0; ordinal < Math.min(count, 10_000); ordinal += 1) {
    const occurrence = shiftedOccurrence(start, frequency, interval, ordinal, rule);
    const key = dateTimeKey(occurrence);
    if (key > until) break;
    if (!exdates.has(key)) instances.push({ start: occurrence, recurrenceId: key });
  }
  return instances;
}

function privateReason(summary) {
  const plain = String(summary || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/(^|\s)(bd|bday|birthday)(\s|$)|rojstni|god jutri|obletnica|valentinovo|dan zena/.test(plain)) return "zasebni rojstni dan, god ali obletnica";
  if (/zobar|revmatolog|zdravnik|zdravstven/.test(plain)) return "zasebni zdravstveni dogodek";
  if (/(^|\s)(morje|kolektivc|dopust|vacation)(\s|$)/.test(plain)) return "zasebni dopust ali prosti čas";
  if (/^(alarm notification|idacio)$/i.test(String(summary || "").trim())) return "zasebni/generični opomnik";
  return "";
}

function sourceText(event, name) {
  return unescapeIcs(first(event, name)?.value || "").trim();
}

function timingFor(event, occurrence) {
  const start = parseIcsDate(first(event, "DTSTART"));
  const end = parseIcsDate(first(event, "DTEND"));
  // The app requires a complete same-day time range. Preserve it only when
  // the source gives us one; multi-day and malformed ranges remain date-only.
  if (!start || !end || start.allDay || end.allDay || occurrence.start.allDay || start.date !== end.date || !start.time || !end.time || end.time <= start.time) return { start: "", end: "" };
  return { start: occurrence.start.time, end: end.time };
}

function notesFor(event, occurrence, timing) {
  const parts = [];
  const location = sourceText(event, "LOCATION");
  const description = sourceText(event, "DESCRIPTION");
  if (location) parts.push(location);
  if (description && !/^this is an event reminder$/i.test(description) && description !== location) parts.push(description);
  const end = parseIcsDate(first(event, "DTEND"));
  if (end && !timing.end && (end.date !== occurrence.start.date || end.time !== occurrence.start.time)) parts.push(`Izvorni konec: ${end.date}${end.time ? ` ${end.time}` : ""}`);
  return parts.join("\n\n").slice(0, 12_000);
}

function buildImportPlan(ics, { from = DEFAULT_FROM, to = DEFAULT_TO } = {}) {
  assertDate(from, "Začetek"); assertDate(to, "Konec");
  if (from > to) throw new Error("Začetni datum mora biti pred končnim.");
  const sourceHash = crypto.createHash("sha256").update(ics).digest("hex");
  const allEvents = parseIcsEvents(ics);
  const exceptionEvents = allEvents.filter((event) => first(event, "RECURRENCE-ID"));
  const relevantExceptions = exceptionEvents.filter((event) => {
    const recurrence = parseIcsDate(first(event, "RECURRENCE-ID"));
    return recurrence && recurrence.date >= from && recurrence.date <= to;
  });
  if (relevantExceptions.length) throw new Error("ICS vsebuje spremembe posameznih ponovitev v izbranem obdobju. Uvoz je namenoma ustavljen, da ne bi napačno podvojil dogodkov.");
  const decisions = [];
  for (const event of allEvents.filter((candidate) => !first(candidate, "RECURRENCE-ID"))) {
    const uid = sourceText(event, "UID");
    if (!uid) continue;
    const summary = sourceText(event, "SUMMARY") || "Brez naslova";
    const status = sourceText(event, "STATUS").toUpperCase();
    for (const occurrence of recurrenceInstances(event)) {
      if (occurrence.start.date < from || occurrence.start.date > to) continue;
      const sourceKey = crypto.createHash("sha256").update(`${uid}|${occurrence.recurrenceId}`).digest("hex");
      const reason = status === "CANCELLED" ? "preklican izvorni dogodek" : privateReason(summary);
      const timing = timingFor(event, occurrence);
      decisions.push({ sourceKey, uid, recurrenceId: occurrence.recurrenceId, date: occurrence.start.date, start: timing.start, end: timing.end, allDay: occurrence.start.allDay, summary, status, action: reason ? "ignored" : "import", reason, notes: notesFor(event, occurrence, timing), sourceUpdatedAt: sourceText(event, "LAST-MODIFIED") });
    }
  }
  decisions.sort((left, right) => left.date.localeCompare(right.date) || left.start.localeCompare(right.start) || left.summary.localeCompare(right.summary, "sl"));
  return { format: "indus-ure-ics-import-v1", sourceHash, from, to, sourceEvents: allEvents.length, decisions, imported: decisions.filter((item) => item.action === "import"), ignored: decisions.filter((item) => item.action === "ignored") };
}

function importTodo(decision, user, now, order, batchId) {
  const id = crypto.randomUUID();
  return {
    id, assignmentGroupId: id, title: decision.summary, date: decision.date, start: decision.start, end: decision.end, client: "", clientId: "", notes: decision.notes, material: "", status: "open", imported: true,
    importBatchId: batchId, importSourceKey: decision.sourceKey, importSourceUid: decision.uid, importSourceRecurrenceId: decision.recurrenceId, importSourceUpdatedAt: decision.sourceUpdatedAt,
    order, userOrderBuckets: { [user.id]: "unsorted" }, completionRequests: [], urgent: false, ordered: false, warranty: false, done: false, hoursNeedsReview: false,
    billingHourlyRate: null, billingKm: 0, clientKm: 0, clientVehicle: "personal", clientKmRate: 0, driveFiles: [], photos: [], syncUser: user.id,
    createdBy: user.id, createdByName: user.name || user.id, createdAt: now, updatedBy: user.id, updatedByName: user.name || user.id, updatedAt: now,
    history: [{ at: now, by: user.id, name: user.name || user.id, action: "enkratni uvoz ICS" }]
  };
}

async function applyImport(plan, options) {
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL manjka.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  const mediaDir = path.resolve(process.env.MEDIA_DIR || "/var/lib/indus-ure/media");
  const store = new PostgresStore(pool, mediaDir);
  try {
    await store.ensure({}, normalizeDb);
    const db = await store.load();
    normalizeDb(db);
    const user = db.users?.[options.user];
    if (!user) throw new Error(`Uporabnik ${options.user} ne obstaja.`);
    if (user.role !== "boss") throw new Error("ICS lahko enkratno uvozi samo šef.");
    db.icsImports = Array.isArray(db.icsImports) ? db.icsImports : [];
    if (db.icsImports.some((item) => item.id === options.batch && !item.revertedAt)) throw new Error(`Uvoz ${options.batch} že obstaja. Za povrnitev uporabi --revert ${options.batch}.`);
    const existing = new Set((db.todos || []).map((todo) => String(todo.importSourceKey || "")).filter(Boolean));
    const now = new Date().toISOString();
    let nextOrder = Math.min(0, ...(db.todos || []).map((todo) => Number(todo.order || 0))) - 1;
    const imported = [];
    const duplicates = [];
    for (const decision of plan.imported) {
      if (existing.has(decision.sourceKey)) { duplicates.push(decision.sourceKey); continue; }
      const todo = importTodo(decision, user, now, nextOrder--, options.batch);
      db.todos.push(todo); imported.push(todo);
    }
    db.icsImports.push({ id: options.batch, sourceHash: plan.sourceHash, sourceFile: path.basename(options.source), from: plan.from, to: plan.to, createdAt: now, createdBy: user.id, importedTaskIds: imported.map((todo) => todo.id), duplicateSourceKeys: duplicates, audit: plan.decisions.map(({ notes, ...item }) => item) });
    db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
    normalizeDb(db);
    await store.save(db);
    return { batch: options.batch, imported: imported.length, ignored: plan.ignored.length, duplicates: duplicates.length, sourceHash: plan.sourceHash };
  } finally { await pool.end(); }
}

async function revertImport(batch, force = false) {
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL manjka.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  const store = new PostgresStore(pool, path.resolve(process.env.MEDIA_DIR || "/var/lib/indus-ure/media"));
  try {
    await store.ensure({}, normalizeDb);
    const db = await store.load(); normalizeDb(db);
    const record = (db.icsImports || []).find((item) => item.id === batch && !item.revertedAt);
    if (!record) throw new Error(`Aktivnega uvoza ${batch} ni.`);
    const candidates = (db.todos || []).filter((todo) => todo.importBatchId === batch && todo.imported);
    const edited = candidates.filter((todo) => String(todo.updatedAt || "") > String(record.createdAt || ""));
    if (edited.length && !force) throw new Error(`Po uvozu je bilo urejenih ${edited.length} dogodkov. Za namerno brisanje uporabi --force.`);
    const ids = new Set(candidates.map((todo) => todo.id));
    db.todos = (db.todos || []).filter((todo) => !ids.has(todo.id));
    record.revertedAt = new Date().toISOString(); record.revertedCount = candidates.length;
    db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
    await store.save(db);
    return { batch, reverted: candidates.length, edited: edited.length };
  } finally { await pool.end(); }
}

async function writeAudit(report, destination) {
  if (!destination) return "";
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.writeFile(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
  return destination;
}

async function main() {
  const options = cli(process.argv.slice(2));
  if (options.revert) {
    if (!options.apply) throw new Error("Povrnitev je najprej samo varnostni predogled. Za izvedbo dodaj --apply.");
    process.stdout.write(`${JSON.stringify(await revertImport(options.revert, options.force))}\n`);
    return;
  }
  if (!options.source) throw new Error("Uporaba: node scripts/import-ics-calendar.js --source /varna/pot/koledar.ics [--from 2026-07-01 --to 2031-06-30 --apply].");
  const source = path.resolve(options.source);
  const ics = await fsp.readFile(source, "utf8");
  const plan = buildImportPlan(ics, options);
  options.source = source;
  options.batch ||= `ics-private-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}`;
  const report = { ...plan, batch: options.batch, sourceFile: path.basename(source), generatedAt: new Date().toISOString(), mode: options.apply ? "apply" : "dry-run" };
  if (options.apply) report.result = await applyImport(plan, options);
  const defaultReport = options.apply ? path.join(path.dirname(process.env.MEDIA_DIR || "/var/lib/indus-ure/media"), "imports", `${options.batch}.json`) : "";
  report.auditFile = await writeAudit(report, options.report || defaultReport);
  process.stdout.write(`${JSON.stringify({ batch: report.batch, mode: report.mode, sourceEvents: plan.sourceEvents, import: plan.imported.length, ignored: plan.ignored.length, auditFile: report.auditFile, result: report.result || null })}\n`);
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { buildImportPlan, parseIcsEvents, privateReason, recurrenceInstances };