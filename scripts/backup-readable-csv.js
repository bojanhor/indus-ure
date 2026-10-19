"use strict";

// Portable, read-only recovery views. Never serialize whole user/profile rows.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const TIME_STATUSES = new Set(["execution", "meal", "drive", "purchase"]);
const STATUS_LABELS = {
  open: "Čaka", in_progress: "V teku", execution: "Zaključeno", order: "Naroči-projekt",
  order_car: "Naroči Avto", order_warehouse: "Naroči Sklad.", add_to_car: "Dodaj v avto",
  return_and_bill: "Vrne naj", bill: "Poračunaj", return: "Vrni", meal: "Malica",
  internal: "Razno/Interno", drive: "Vožnja", purchase: "Nabava", note: "Zapisek", material: "Material"
};
const number = value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const hours = minutes => minutes === null ? null : Number((minutes / 60).toFixed(6));
const yes = value => value ? "Da" : "Ne";
function durationMinutes(item) {
  const clock = (value, end = false) => {
    if (end && value === "24:00") return 1440;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = clock(item.start), end = clock(item.end, true);
  return start !== null && end !== null && end > start ? end - start : null;
}
function cell(value) {
  let text = typeof value === "number" ? String(value).replace(".", ",") : String(value ?? "");
  // Quoting alone does not stop Excel/Sheets from executing user-authored text.
  if (typeof value !== "number" && (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function csv(headers, rows) {
  return "\uFEFF" + [headers, ...rows].map(row => row.map(cell).join(";")).join("\r\n") + "\r\n";
}
const COMMON = ["Vrsta zapisa", "ID dogodka", "Datum od", "Datum do", "Ura od", "Ura do", "Cel dan",
  "Stranka", "Naziv stranke v imeniku", "ID stranke", "Naslov", "Opis del", "Material",
  "Status", "Status (koda)", "Stanje zapisa", "Nujno", "Garancija", "Potreben pregled ur",
  "Ustvarjeno", "Spremenjeno", "V košu od", "Izvoz (UTC)", "ID varnostne kopije"];
function recordState(item, assignments = []) {
  if (item.trashedAt) return "Koš";
  const archived = assignments.filter(a => a.archivedAt).length;
  if (assignments.length && archived === assignments.length) return "Arhiv";
  if (archived) return "Delno arhivirano";
  return item.archivedAt ? "Arhiv" : "Aktivno";
}
function renderReadableCsv({ tasks = [], assignments = [], entries = [], users = [], clients = [] }, { backupId, createdAt }) {
  if (!backupId || !Number.isFinite(Date.parse(createdAt))) throw new Error("CSV zahteva ID in datum varnostne kopije.");
  const names = new Map(users.map(u => [u.id, u.name || u.id]));
  const customers = new Map(clients.map(c => [c.clientId, c.name || c.alias || c.clientId]));
  const grouped = new Map(tasks.map(t => [t.id, []]));
  for (const a of assignments) {
    if (!grouped.has(a.taskId)) throw new Error(`CSV: dodelitev ${a.id} nima dogodka.`);
    grouped.get(a.taskId).push(a);
  }
  const worker = a => a.syncUser || a.workerId || a.createdBy || "";
  const common = (item, kind, state) => [kind, item.id, item.date, item.endDate || item.date,
    item.calendarOnly ? "" : item.start, item.calendarOnly ? "" : item.end,
    yes(item.calendarOnly || (item.date && !item.start && !item.end)), item.client,
    customers.get(item.clientId) || item.client, item.clientId, item.title || item.work, item.notes, item.material,
    STATUS_LABELS[item.status] || item.status, item.status, state, yes(item.urgent), yes(item.warranty), yes(item.hoursNeedsReview),
    item.createdAt, item.updatedAt, item.trashedAt, createdAt, backupId];
  const eventRows = [], hourRows = [];
  const ordered = [...tasks].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || a.id.localeCompare(b.id));
  for (const task of ordered) {
    const assigned = grouped.get(task.id).sort((a, b) => a.id.localeCompare(b.id));
    const ids = [...new Set(assigned.map(worker).filter(Boolean))];
    const kind = TIME_STATUSES.has(task.status) ? "Vpis ur" : "Opravilo";
    const item = { ...task, createdAt: task.createdAt || assigned[0]?.createdAt,
      updatedAt: [task.updatedAt, ...assigned.map(a => a.updatedAt)].filter(Boolean).sort().at(-1) };
    eventRows.push([...common(item, kind, recordState(task, assigned)), ids.map(id => names.get(id) || id).join(" | "),
      ids.join(" | "), assigned.map(a => a.id).join(" | "), assigned.filter(a => a.archivedAt).map(a => names.get(worker(a)) || worker(a)).join(" | "),
      task.sourceProjectTodoId, task.sourceProjectTitle, number(task.materialAmount), task.people || ""]);
    if (!TIME_STATUSES.has(task.status)) continue;
    if (!assigned.length) throw new Error(`CSV: vpis ur ${task.id} nima izvajalca.`);
    const minutes = durationMinutes(task), manual = number(task.clientBillableMinutes);
    const clientMinutes = task.status !== "execution" || task.warranty ? 0
      : manual ?? (minutes === null ? null : minutes * assigned.length);
    assigned.forEach((a, index) => {
      const merged = { ...task, ...a, id: task.id };
      hourRows.push([...common(merged, kind, recordState(merged)), a.id, names.get(worker(a)) || worker(a), worker(a),
        minutes, hours(minutes), index === 0 ? clientMinutes : null, index === 0 ? hours(clientMinutes) : null,
        assigned.length > 1 ? "Ure stranke veljajo za cel dogodek; izpisane samo v prvi vrstici." : "",
        index === 0 ? manual : null, number(a.billingKm), number(task.clientKm), task.clientVehicle,
        number(a.billingHourlyRate), a.archivedPayrollId, a.archivedClientBillId, a.archivedAt,
        task.sourceProjectTodoId, task.sourceProjectTitle]);
    });
  }
  // Legacy calendar entries are preserved separately, not counted a second time as payroll hours.
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = worker(entry);
    eventRows.push([...common(entry, "Stari koledarski vnos", recordState(entry)), names.get(id) || id, id, "", "",
      entry.sourceTodoId, "", number(entry.materialCost), entry.people]);
  }
  return [
    { name: "dogodki.csv", rows: eventRows.length, content: csv([...COMMON, "Izvajalci", "ID izvajalcev", "ID dodelitev", "Arhivirano za",
      "Izvorno opravilo ID", "Izvorno opravilo", "Znesek materiala (vpisan)", "Osebe (stari vnos)"], eventRows) },
    { name: "vpisi-ur.csv", rows: hourRows.length, content: csv([...COMMON, "ID vpisa", "Delavec", "ID delavca", "Vpisane minute", "Vpisane ure",
      "Minute za stranko (dogodek, enkrat)", "Ure za stranko (dogodek, enkrat)", "Opomba o skupnih urah", "Nastavljene minute za stranko",
      "Km delavca (vpisano)", "Km stranke (vpisano)", "Vozilo stranke", "Urna postavka (vpisana)", "ID obračuna delavca",
      "ID obračuna stranke", "Arhivirano od", "Izvorno opravilo ID", "Izvorno opravilo"], hourRows) }
  ];
}
async function readReadableSnapshot(client) {
  // The caller supplies its already-open repeatable-read transaction, not a pool.
  const tasks = (await client.query("select id, data from indus_tasks order by id")).rows.map(r => ({ ...r.data, id: r.id }));
  const assignments = (await client.query("select id, task_id, worker_id, data from indus_task_assignments order by id")).rows
    .map(r => ({ ...r.data, id: r.id, taskId: r.task_id, workerId: r.worker_id }));
  const entries = (await client.query("select id, data from indus_entries order by id")).rows.map(r => ({ ...r.data, id: r.id }));
  const users = (await client.query("select id, data->>'name' as name from indus_users order by id")).rows;
  const clients = (await client.query("select client_id, data->>'name' as name, data->>'alias' as alias from indus_clients order by client_id")).rows
    .map(r => ({ ...r, clientId: r.client_id }));
  return { tasks, assignments, entries, users, clients };
}
async function writeReadableCsv(client, workDir, metadata) {
  const exports = renderReadableCsv(await readReadableSnapshot(client), metadata);
  for (const file of exports) {
    await fs.writeFile(path.join(workDir, file.name), file.content, { mode: 0o600 });
  }
  return exports.map(({ name, rows, content }) => ({ name, rows, bytes: Buffer.byteLength(content),
    sha256: crypto.createHash("sha256").update(content).digest("hex") }));
}
module.exports = { renderReadableCsv, readReadableSnapshot, writeReadableCsv, durationMinutes, STATUS_LABELS };
