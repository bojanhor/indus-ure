#!/usr/bin/env node
"use strict";

// One-time, reversible import of the legacy "Obračun" notes supplied on
// 2026-08-05.  It intentionally does not read Google services or touch media.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { PostgresStore } = require("../outputs/postgres-store");
const { normalizeDb } = require("../outputs/server");

const DEFAULT_BATCH = "legacy-hours-2025-2026-v1";
const DEFAULT_MISSING_DATE = "2026-08-05";
const IMPORT_LABEL = "enkratni uvoz starih obračunov";
const SKIPPED_CLIENTS = new Set(["češnar"]);

const RAW_ROWS = `
Obračun\tavio: 19.1. menjava stikala za luči spr terasa p25€
Obračun\tbeno štern: 7.10. montaža shelly in wifi extender 4h
Obračun\tčešnar: priklop grelca in ogled rekel 60€ po telefonu z ano
Obračun\tlek: 17.12. pregled programa s programerjem 2h
Obračun\tlht lek: 28.11. zagon prve omare prvi del 7h
Obračun\tlht: talilne varovalke in 6x utp kabel za SB6 planica lek 23.3. 14kos
Obračun\tmarkovič šenčur: 7.10. montaža sirena ajax
Obračun\tbeno: varistorji
Obračun\tJerin: kabli naročilo 9.7
Obračun\tJerin: reed kontakt pozabil obračunati (vprašaj klaro koliko kosov)
Obračun\tsensilab: 4.12. svetovanje 0.5h telefon; nastavitve chiller
Obračun\tsensilab: dostavljen ventilator 120x120 230AC 20.3. p35€
Obračun\tskubin: 5.2. flatbed ozemljitev 1h
Obračun\tsobe kepic: zebra senzorska 1kos z menjavo pri madžarih (pozabil računat)
Obračun\tblaž matjaž: popravilo luči p60€; material psu p80€
Obračun\tstuden: 13.1. priklop stikala na traktor; material: dpm 20€(kabel 70mm2, kabel čevlji, žica, vijaki, mast)
Obračun\tstudi: 21.3. montaža vtgn
Obračun\tstudi: 30.3. izbira črpalke doblič 1h
Obračun\tstudi: rastlinjak 18.4. pastir na polju, grelci rastlinjak, priklop senzor tlaka; material senzor tlaka, 2x rele, DPM 30€ (0,75 kvadrat zica, 3x0,75 kabel 17m, 1x vtičnica za na kabel, 1x c6 varovalka)
Obračun\tstudi 22.4. 6h: agregat vezava mimo fida za instalacijsko omaro in vezava stikal za mizo, material 10 kvadrat zica 2 m, 12x0,75 kabel 7m, 2x m16 uvodnica, 1x potenciometer schrack, 2x 0 1 stikalo schrack
Obračun\tstudi 23.4.  3,5h: montiranje pn cevi za kabel za aagregat in dokoncanje tipk na mizi; material studi: pn cev fi23 4,5m , skobe 12, 2x hrbtni no kontakt;
Obračun\tstudi: 5.5. zalivanje predelava na sistem kjer sami kontroliramo tlak bojan in ibro vsak po 9h
Obračun\tstudi: 6.5. stikalo hladilnica iskanje trase, popis materiala, montaža 5p vtičnice, rastlinjak gel v doze
Obračun\tstudi: 8.5. 5h vezava stikala za ugasa je kompresorja v hladilnici in pregled za ventilator; material: 1x PN cev, 32m kabla 3x0,75, 1 x 230ac rele in podnozje, 1x casovni rele, 4x skobe, 1x stikalo, 6m 1,5 zice
Obračun\tstudi: milwaukee boxi 9.5 sliki
Obračun\tstudi: 9.5. rastlinjak zaključevanje, zagon tlačnega senzorja za zalivanje (dokumentacija in nalepke) 2x4h
Obračun\tstudi: 11.5. dodelava tlak zalivanja bojan in ibro vsak po 4
Obračun\tstudi: 13.5. 2.5 h ibro vezava ventilov do doma in predelava v omari , menjava kabla za pastir in montaza nove vticnice in vtica zanj material: 1x modra vticnica in vtic, uvodnica, 0,75 zica 3m, 1x uvodnica, 3x instalacijsa sponka 2,5mm, 1x cevna varovalka in ohisje zanjo za na sino
Obračun\ttine: 30.1. net izvedba in menjava line okvirjev 2x10h
Obračun\ttine: domofon
Obračun\ttine: luči rexel p400€
Obračun\ttine: luči, instalacija zunaj, menjava okvirčkov, dodatna dela po popisu
Obračun\tdrago dostava omare rekel slabih 200 neto
Obračun\tdrago: 21.3. menjava frekvencer 1f , menjava stikala DY, material freq 1f
Obračun\tdrago: 26.3. odklop motorja sekular 0,5h
Obračun\tdrago: ponovna vezava motorja 30.3. 2h
Obračun\tizolacija sk: 3.3. posodobitev spletna banka oddaljena pomoč 05h
Obračun\tizolacija: 3.4. dobava in montaža monitor Simon, menjava monitorjev in zvočnikov med seboj, test video konferenca
Obračun\tizolacija: 31.3. dobava in montaža PC Darko; ustvarjanje novega računa v google workspace (mail), selitev PC Dragi
Obračun\tbimo: 20.1. menjava induktivcev 1h + induktivci p120€
Obračun\tizolacija sk: 11.5. mailing dodajanje spf check podpisa, ostale informacijske storitve
Obračun\tmarko kern: kabel 5g6 29m dostavljen, račun prejet od rexela na 15.5
Obračun\tZoklar: 25.5 1,5 h: označevanje za štemanje in menjava luči v kopalnici + pred tem ogled oba 1h, +ponudba
Obračun\tkepic izolacija: 3.6 1h plačilne kartice
Obračun\tdrago: 4.6. urgent 1h menjava kontaktorja; kontaktor 230AC 4kW
Obračun\tdamjan posavc: 5.6. 3.5h diagnostika polnilnice
Obračun\tsimon kepic WiFi montaža p145
Obračun\tlht lek
Obračun\tlht sonet
Obračun\tizolacija sk: 2.7. oddaljena pomoč 0.5h hosting, ustvarjanje novega maila 1h
Obračun\tsobe kepic: 1.6. ibro 1,5h ogled za vleko kabla
Obračun\tStudi: 2.6. ibro ventilator; material: 2x m16 uvodnica, rele 230vac in podnožje, c6 varovalka, kabel 3x0,75 30m, 1x vtič in vtičnica, 1x 3fazni vtič stari jugo, 6x pn cev 20 skob; traktor material: 1x stikalo 01, 1x ohišje schneider za stikalo, 1x magnet, 5m 3x0,75 kabel, 1x varovalkica 3a, 1x no kontakt in nosilec, 2x m16 uvodnica; pedala material: 3x konektor, 1x m20 uvodnica
Obračun\tPrince trgovina: 3.6. ibro 0,5h; material: usb adapter za lan
Obračun\tMišel: 3.6. ibro 1,5h menjava konektorja in kamere
Obračun\tBeno pod krvavcem: 4.6. ibro 1h menjava napajalnika; material: napajalnik 12v
Obračun\tŠtef Šlosar: 5.6. ibro 1h odpravljanje napake na mašini
Obračun\tlht: 5.6. ibro 5h programiranje
Obračun\tlht: 6.6. ibro programiranje
Obračun\tDrago žaga: 16.6. ibro inštalacija; material: 78€
Obračun\tDrago žaga: 17.6. ibro inštalacija; material: 78€, kabel 5x2,5 3m, žica 2,5 30m, žica 1,5 20m, varovalke 1f 6x, fid 1x
Obračun\tskladišče: 19.6. ibro urejanje skladišča
Obračun\tSobe kepic: 20.6. ibro vleka kabla; material: kabel 5x6 20m, pn cev 23 4x, skobe 25x, euroflex 20 3m, zidna cev 32 25m, doza ww40 2x, žice 6 kvadrat 35m, žice 4 kvadrat 20m
Obračun\tSobe kepic: 22.6. ibro vleka kabla
Obračun\tMiro janežič: 23.6. ibro 8h inštalacija garderoba; material: 2x okrogla doza
Obračun\tSobe kepic: 27.6. ibro 0,5h; material: 5x16 4m
Obračun\tDrago žaga: 30.6. ibro 1,5h intervencija
Obračun\tDrago žaga: 30.6. ibro 7h rolo vrata
Obračun\tStudi: 1.7. ibro 1,5h bimetal, 1h črpalka; material: 1x bimetal z ohišjem
Obračun\tStudi: 2.7. ibro 1,5h črpalka; material: časovni rele 1x, kondenzator 2x, žica 1,5 kvadrat
Obračun\tTine: led trak v kuhinji, unify UCG in 3x korožnik, poe injector 3x, optika,
Obračun\tstudi: 7.7. reševanje napake na stroju 1,5h
Obračun\tstudi: 9.7. menjava faznega nadzornega releja in menjava filtra elektro omare v rastlinjaku 1,5h; material: 1x fazni nadzorni rele, 1x filter
Obračun\tjerin: 9.7. menjava ventilatorja 1h; material: 1x ventilator
Obračun\tpušavc: 10.7. ogled 1h
Obračun\tsvejk: 11.7. LOGO za vodo 1,5h; material: 3x optosklopnik
Obračun\tlukić: 11.7. montaža LED osvetlitve stopnic 2h; material: LED trak 12V, napajalnik 12V 60W
Obračun\thobič: 14.7. intervencija – menjava varovalke 1h; material: 1x C16 odklopnik
Obračun\tstudi: 15.7. 1.5h diagnostika pomanjkanja vode v vrtini brnik letališče
Obračun\travnikar 20.7. svetovanje filtri in izbira ustreznega filtra 0,5h
Obračun\tJerin: naročilo 21.7. rexel police
`;

function cli(argv) {
  const options = { apply: false, revert: "", batch: DEFAULT_BATCH, report: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--force") options.force = true;
    else if (["--batch", "--report", "--revert"].includes(argument)) options[argument.slice(2)] = String(argv[++index] || "");
    else throw new Error(`Neznan parameter: ${argument}`);
  }
  return options;
}

function normal(value) { return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("sl"); }
function cleanLine(value) { return String(value || "").trim().replace(/\s+/g, " "); }
function parseDate(text) {
  const match = /(?:^|\s)([0-3]?\d)\.\s*([01]?\d)\.?\b/.exec(text);
  if (!match) return { date: DEFAULT_MISSING_DATE, missing: true };
  const day = Number(match[1]); const month = Number(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return { date: DEFAULT_MISSING_DATE, missing: true };
  // October–December are from the preceding calendar year; the rest are 2026.
  const year = month >= 10 ? 2025 : 2026;
  return { date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, missing: false };
}
function aliasFor(text) {
  const colon = /^([^:]+):\s*(.*)$/.exec(text);
  if (colon) {
    const alias = cleanLine(colon[1]);
    if (normal(alias).startsWith("lht ")) return { alias: "lht", description: `${alias.slice(4)}: ${cleanLine(colon[2])}` };
    return { alias, description: cleanLine(colon[2]) };
  }
  const lower = normal(text);
  for (const [prefix, alias] of [["simon kepic", "Simon Kepic"], ["lht lek", "lht"], ["lht sonet", "lht"], ["drago ", "drago"], ["studi ", "studi"], ["tine ", "tine"], ["ravnikar ", "ravnikar"]]) {
    if (lower === prefix.trim() || lower.startsWith(prefix)) return { alias, description: cleanLine(text.slice(prefix.trim().length)) };
  }
  const beforeDate = /^(.+?)\s+[0-3]?\d\.\s*[01]?\d\.?\b/.exec(text);
  if (beforeDate) return { alias: cleanLine(beforeDate[1]), description: text };
  const [first = "", ...rest] = cleanLine(text).split(" ");
  return { alias: first, description: rest.join(" ") };
}
function hoursFor(text) {
  const paired = /\bbojan\s+in\s+ibro\s+vsak\s+po\s+(\d+(?:[.,]\d+)?)\s*h?\b/i.exec(text);
  if (paired) return { hours: Number(paired[1].replace(",", ".")), repeats: 1, assignees: ["bojan", "ibro"], missing: false };
  const repeated = /\b(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*h\b/i.exec(text);
  if (repeated) return { hours: Number(repeated[2].replace(",", ".")), repeats: Number(repeated[1]), assignees: null, missing: false };
  const zeroFive = /(?:^|\s)05\s*h\b/i.test(text);
  if (zeroFive) return { hours: 0.5, repeats: 1, assignees: null, missing: false };
  const matches = [...text.matchAll(/(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*h\b/ig)];
  if (matches.length) return { hours: matches.reduce((sum, match) => sum + Number(match[1].replace(",", ".")), 0), repeats: 1, assignees: null, missing: false };
  return { hours: 1, repeats: 1, assignees: null, missing: true };
}
function assigneeFor(text, explicit = null) {
  if (explicit) return explicit;
  return /\bibro\b/i.test(text) ? ["ibro"] : ["bojan"];
}
function timeRange(hours) {
  const rounded = Math.max(15, Math.round(hours * 4) * 15);
  if (rounded > 16 * 60) throw new Error(`Vnos z ${hours} h zahteva ročni razrez.`);
  const startMinutes = rounded > 12 * 60 ? 0 : 8 * 60;
  const endMinutes = startMinutes + rounded;
  const display = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { start: display(startMinutes), end: display(endMinutes), hours: rounded / 60 };
}
function titleFor(description) {
  const title = cleanLine(description).replace(/^[:;,-]+\s*/, "");
  return (title || "Vpis ur iz starega sistema").slice(0, 180);
}
function parseRows(raw = RAW_ROWS) {
  return raw.split(/\r?\n/).map(cleanLine).filter(Boolean).map((line) => {
    const text = line.replace(/^obračun\s*/i, "").trim();
    const { alias: rawAlias, description } = aliasFor(text);
    const alias = normal(rawAlias) === "beno" ? "Beno Štern" : rawAlias;
    const date = parseDate(text);
    const hourInfo = hoursFor(text);
    return { source: text, alias, description: description || text, date, hourInfo };
  });
}
function buildImportPlan(raw = RAW_ROWS) {
  const skipped = []; const entries = [];
  for (const row of parseRows(raw)) {
    if (SKIPPED_CLIENTS.has(normal(row.alias))) { skipped.push({ ...row, reason: "uporabnik je zahteval izpust" }); continue; }
    const assignees = assigneeFor(row.source, row.hourInfo.assignees);
    for (let part = 0; part < row.hourInfo.repeats; part += 1) for (const assignee of assignees) {
      const time = timeRange(row.hourInfo.hours);
      const notes = [
        row.description,
        row.date.missing ? "Opomba: datum ni pravi; v starem sistemu ni bil vnešen." : "",
        row.hourInfo.missing ? "Opomba: podatek o urah v starem sistemu ni bil vnešen; uvoženo kot 1 h." : ""
      ].filter(Boolean).join("\n\n");
      entries.push({
        source: row.source, alias: row.alias, date: row.date.date, dateMissing: row.date.missing,
        hours: time.hours, hoursMissing: row.hourInfo.missing, assignee, start: time.start, end: time.end,
        title: row.hourInfo.repeats > 1 ? `${titleFor(row.description)} (del ${part + 1}/${row.hourInfo.repeats})` : titleFor(row.description), notes
      });
    }
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return { format: "indus-ure-legacy-hours-v1", fingerprint, entries, skipped };
}
function hourlyRate(db, userId) {
  const personal = Number(db.users?.[userId]?.billing?.hourlyRate);
  const common = Number(db.settings?.billing?.hourlyRate);
  return Number.isFinite(personal) && personal >= 0 ? personal : (Number.isFinite(common) && common >= 0 ? common : 15);
}
function clientForAlias(db, alias, now, createdClientIds) {
  const found = (db.clients || []).find((client) => [client.clientId, client.id, client.name, client.search]
    .some((value) => normal(value) === normal(alias)));
  if (found) return found;
  const clientId = crypto.randomUUID();
  const client = {
    id: clientId, clientId, name: alias, search: alias, email: "", phone: "", contacts: [], address: "", city: "", postal: "", country: "", taxId: "", registryNumber: "",
    vatPayer: false, source: "ad-hoc", needsReview: true, createdBy: "bojan", createdAt: now, updatedAt: now
  };
  db.clients.push(client); createdClientIds.push(clientId); return client;
}
async function applyImport(plan, options) {
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL manjka.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  const store = new PostgresStore(pool, path.resolve(process.env.MEDIA_DIR || "/var/lib/indus-ure/media"));
  try {
    await store.ensure({}, normalizeDb); const db = await store.load(); normalizeDb(db);
    if (!db.users?.bojan || !db.users?.ibro) throw new Error("Uporabnika Bojan ali Ibro manjkata.");
    db.legacyHourImports = Array.isArray(db.legacyHourImports) ? db.legacyHourImports : [];
    if (db.legacyHourImports.some((item) => item.id === options.batch && !item.revertedAt)) throw new Error(`Uvoz ${options.batch} že obstaja.`);
    const now = new Date().toISOString(); const ids = []; const createdClientIds = [];
    let order = Math.min(0, ...(db.todos || []).map((todo) => Number(todo.order || 0))) - 1;
    for (const entry of plan.entries) {
      const client = clientForAlias(db, entry.alias, now, createdClientIds);
      const id = crypto.randomUUID();
      db.todos.push({
        id, assignmentGroupId: id, legacyImportBatchId: options.batch, legacySource: entry.source,
        title: entry.title, notes: entry.notes, material: "", date: entry.date, endDate: entry.date, start: entry.start, end: entry.end,
        client: client.name, clientId: client.clientId, clientContactIds: [], clientContacts: [], status: "execution", done: true,
        syncUser: entry.assignee, createdBy: "bojan", createdByName: db.users.bojan.name || "Bojan", createdAt: now, updatedBy: "bojan", updatedByName: db.users.bojan.name || "Bojan", updatedAt: now,
        billingHourlyRate: hourlyRate(db, entry.assignee), billingKm: 0, clientKm: 0, clientVehicle: "personal", clientKmRate: 0,
        hoursNeedsReview: entry.hoursMissing || entry.dateMissing, workFromHome: false, warranty: false, urgent: false, ordered: false, calendarOnly: false,
        order: order--, userOrderBuckets: { [entry.assignee]: "unsorted" }, sharedManualBucket: "sorted", sharedManualOrder: 0,
        completionRequests: [], driveFiles: [], photos: [], history: [{ at: now, by: "bojan", name: db.users.bojan.name || "Bojan", action: `${IMPORT_LABEL}: ${entry.source}` }]
      });
      ids.push(id);
    }
    db.legacyHourImports.push({ id: options.batch, format: plan.format, fingerprint: plan.fingerprint, createdAt: now, createdBy: "bojan", todoIds: ids, createdClientIds, skipped: plan.skipped.map((item) => ({ alias: item.alias, source: item.source, reason: item.reason })) });
    db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
    normalizeDb(db); await store.save(db);
    return { batch: options.batch, imported: ids.length, skipped: plan.skipped.length, createdAdHocClients: createdClientIds.length };
  } finally { await pool.end(); }
}
async function revertImport(batch, force = false) {
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL manjka.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  const store = new PostgresStore(pool, path.resolve(process.env.MEDIA_DIR || "/var/lib/indus-ure/media"));
  try {
    await store.ensure({}, normalizeDb); const db = await store.load(); normalizeDb(db);
    const record = (db.legacyHourImports || []).find((item) => item.id === batch && !item.revertedAt);
    if (!record) throw new Error(`Aktivnega uvoza ${batch} ni.`);
    const candidates = (db.todos || []).filter((todo) => todo.legacyImportBatchId === batch);
    const edited = candidates.filter((todo) => String(todo.updatedAt || "") > String(record.createdAt || ""));
    if (edited.length && !force) throw new Error(`Po uvozu je bilo urejenih ${edited.length} vnosov. Za namerno povrnitev uporabi --force.`);
    const ids = new Set(candidates.map((todo) => todo.id)); db.todos = db.todos.filter((todo) => !ids.has(todo.id));
    const usedClientIds = new Set(db.todos.map((todo) => String(todo.clientId || "")).filter(Boolean));
    const removable = new Set((record.createdClientIds || []).map(String).filter((id) => !usedClientIds.has(id)));
    db.clients = (db.clients || []).filter((client) => !removable.has(String(client.clientId || client.id || "")));
    record.revertedAt = new Date().toISOString(); record.revertedCount = candidates.length; record.revertedClients = removable.size;
    db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1; normalizeDb(db); await store.save(db);
    return { batch, reverted: candidates.length, removedAdHocClients: removable.size, edited: edited.length };
  } finally { await pool.end(); }
}
async function writeReport(payload, destination) {
  const file = path.resolve(destination || path.join(path.dirname(process.env.MEDIA_DIR || "/var/lib/indus-ure/media"), "imports", `${payload.batch}.json`));
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fsp.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 }); return file;
}
async function main() {
  const options = cli(process.argv.slice(2));
  if (options.revert) { const result = await revertImport(options.revert, options.force); process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  const plan = buildImportPlan(); const report = { batch: options.batch, generatedAt: new Date().toISOString(), mode: options.apply ? "apply" : "dry-run", ...plan };
  if (options.apply) report.result = await applyImport(plan, options);
  report.auditFile = await writeReport(report, options.report); process.stdout.write(`${JSON.stringify({ batch: report.batch, mode: report.mode, entries: plan.entries.length, skipped: plan.skipped.length, auditFile: report.auditFile, result: report.result || null })}\n`);
}
if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
module.exports = { RAW_ROWS, buildImportPlan, parseRows, parseDate, hoursFor };
