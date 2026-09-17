#!/usr/bin/env node
"use strict";

// Restore-ready off-site backup. The archive intentionally excludes OAuth
// credentials, login sessions, password hashes and ICS feed tokens.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Pool } = require("pg");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");

const execFileAsync = promisify(execFile);
const DATABASE_URL = process.env.DATABASE_URL || "";
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || "/var/lib/indus-ure/media");
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || "/var/backups/indus-ure");
const APP_DIR = path.resolve(__dirname, "..");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const OWNER_EMAIL = String(process.env.GOOGLE_DRIVE_OWNER_EMAIL || "bojan@indus.si").trim().toLowerCase();
const PARENT_FOLDER_ID = String(process.env.GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID || process.env.GOOGLE_DRIVE_TASKS_FOLDER_ID || "").trim();
const LOCAL_RETENTION_DAYS = Math.max(7, Number(process.env.BACKUP_LOCAL_RETENTION_DAYS || 30));
const OFFSITE_RETENTION_DAYS = Math.max(30, Number(process.env.BACKUP_OFFSITE_RETENTION_DAYS || 90));
const ALERT_SMTP_URL = String(process.env.ALERT_SMTP_URL || "").trim();
const ALERT_EMAIL_FROM = String(process.env.ALERT_EMAIL_FROM || "").trim();
const ALERT_EMAIL_TO = String(process.env.ALERT_EMAIL_TO || "bojan@indus.si").trim();
const APP_ID = "indus-ure-v2";
const PURPOSE = {
  folder: "recovery-backups",
  archive: "recovery-backup",
  checksum: "recovery-checksum",
  instructions: "recovery-restore-instructions"
};

function requireConfig() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL manjka.");
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) throw new Error("Google OAuth podatki manjkajo za off-site backup.");
  if (!PARENT_FOLDER_ID) throw new Error("GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID manjka.");
}
function stamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function literal(value) { return `'${String(value ?? "").replaceAll("'", "''")}'`; }
async function digest(file, algorithm) {
  const hash = crypto.createHash(algorithm);
  await new Promise((resolve, reject) => fs.createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", resolve));
  return hash.digest("hex");
}
async function bytes(file) { return Number((await fsp.stat(file)).size || 0); }
const sha256 = (file) => digest(file, "sha256");
const md5 = (file) => digest(file, "md5");

function pgConnection() {
  const parsed = new URL(DATABASE_URL);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/") throw new Error("DATABASE_URL ni veljaven PostgreSQL URL za backup.");
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    user: decodeURIComponent(parsed.username || ""),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    password: decodeURIComponent(parsed.password || ""),
    sslMode: parsed.searchParams.get("sslmode") || ""
  };
}
function pgpass(value) { return String(value || "").replace(/\\/g, "\\\\").replace(/:/g, "\\:"); }
async function dumpDatabase(workDir, destination, snapshot = "") {
  const db = pgConnection();
  const passfile = path.join(workDir, ".pgpass");
  await fsp.writeFile(passfile, `${pgpass(db.host)}:${pgpass(db.port)}:${pgpass(db.database)}:${pgpass(db.user)}:${pgpass(db.password)}\n`, { mode: 0o600 });
  const env = { ...process.env, PGPASSFILE: passfile };
  if (db.sslMode) env.PGSSLMODE = db.sslMode;
  const args = ["--format=custom", "--no-owner", "--no-acl", `--file=${destination}`, `--host=${db.host}`, `--port=${db.port}`, `--dbname=${db.database}`];
  if (snapshot) args.push(`--snapshot=${snapshot}`);
  for (const table of ["public.indus_users", "public.indus_sessions", "public.indus_meta", "public.indus_notifications", "public.indus_backup_runs"]) args.push(`--exclude-table-data=${table}`);
  if (db.user) args.push(`--username=${db.user}`);
  await execFileAsync("pg_dump", args, { env, maxBuffer: 2 * 1024 * 1024 });
}

async function copyMedia(destination) {
  if (!fs.existsSync(MEDIA_DIR)) return;
  for (const item of await fsp.readdir(MEDIA_DIR, { withFileTypes: true })) {
    if (item.isDirectory() || item.isFile()) await fsp.cp(path.join(MEDIA_DIR, item.name), path.join(destination, item.name), { recursive: true, force: true });
  }
}
function appFilter(source) {
  const relative = path.relative(APP_DIR, source).split(path.sep).join("/");
  if (!relative) return true;
  const parts = relative.split("/");
  if (parts.some((part) => new Set([".git", "node_modules", "data", "coverage", ".codex", ".agents"]).has(part))) return false;
  const name = parts.at(-1);
  return ![".env", ".env.local", ".env.production"].includes(name) && !name.endsWith(".log");
}
async function copyApplication(destination) { await fsp.cp(APP_DIR, destination, { recursive: true, force: true, filter: appFilter }); }
async function mediaManifest(root) {
  const files = [];
  async function walk(folder) {
    for (const item of await fsp.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) files.push({ path: path.relative(root, file).split(path.sep).join("/"), bytes: await bytes(file), sha256: await sha256(file) });
    }
  }
  if (fs.existsSync(root)) await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function sensitiveKey(key) {
  const value = String(key || "").toLowerCase();
  return value === "google" || value === "calendarfeeds" || value === "calendartoken" || /(token|password|secret|credential|authorization|cookie|session|private.?key)/.test(value);
}
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitiveKey(key)).map(([key, item]) => [key, sanitize(item)]));
}
async function writeSanitizedState(pool, destination) {
  const users = await pool.query("select id, data from indus_users order by id");
  const meta = await pool.query("select key, data from indus_meta where key = any($1::text[]) order by key", [["application", "storage_version", "storage_revision"]]);
  const cleanUsers = users.rows.map((row) => ({ id: String(row.id), data: sanitize(row.data) }));
  const cleanMeta = meta.rows.map((row) => ({ key: String(row.key), data: sanitize(row.data) }));
  const json = JSON.stringify({ users: cleanUsers, meta: cleanMeta });
  if (/(refresh_token|access_token|id_token|passwordhash|calendarfeeds|calendartoken)/i.test(json)) throw new Error("Sanitizacija recovery backupa je zaznala skrivnost v paketu.");
  const sql = [
    "-- Generated by INDUS URE. No OAuth credentials, login sessions, password hashes or ICS feed tokens.",
    "begin;", "delete from indus_sessions;", "delete from indus_users;", "delete from indus_meta;"
  ];
  if (cleanUsers.length) sql.push(`insert into indus_users (id, data) values\n${cleanUsers.map((row) => `  (${literal(row.id)}, ${literal(JSON.stringify(row.data))}::jsonb)`).join(",\n")}\non conflict (id) do update set data = excluded.data, updated_at = now();`);
  if (cleanMeta.length) sql.push(`insert into indus_meta (key, data) values\n${cleanMeta.map((row) => `  (${literal(row.key)}, ${literal(JSON.stringify(row.data))}::jsonb)`).join(",\n")}\non conflict (key) do update set data = excluded.data, updated_at = now();`);
  sql.push("commit;", "");
  await fsp.writeFile(destination, sql.join("\n"), { mode: 0o600 });
}

async function dumpConsistentDatabase(pool, workDir, database, state, { dump = dumpDatabase, writeState = writeSanitizedState } = {}) {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const snapshot = (await client.query("select pg_export_snapshot() as snapshot")).rows[0].snapshot;
    await dump(workDir, database, snapshot);
    await writeState(client, state);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

function restoreGuide() {
  return "INDUS URE - HITRA OBNOVA\n==========================\nPosodobljeno 11. 9. 2026. Velja za Ure, NE za Fakture.\nPodrobnosti: application/OPERATIONS.md in application/DEPLOY-UBUNTU.md.\n\nPaket vsebuje PostgreSQL bazo, priloge, kodo aplikacije in app-config.json. Datoteko app-config.json po pregledu obnovi v /var/lib/indus-ure/app-config.json (lastnik indus-ure, pravice 0600). V testnem okolju je v DATA_DIR. Namenoma NE vsebuje OAuth žetonov, prijavnih sej, hashov gesel, ICS povezav ali /etc/indus-ure.env.\ndatabase.dump in sanitized-state.sql sta zajeta v istem izvoženem PostgreSQL posnetku. Obnovi OBA iz ISTEGA paketa.\n\n1. Prenesi .tar.gz in istoimensko .sha256 datoteko. Preveri in razpakiraj v zasebno mapo:\n   sha256sum -c indus-ure-recovery-....tar.gz.sha256\n   mkdir restore && tar -xzf indus-ure-recovery-....tar.gz -C restore\n   chmod 0644 restore/database.dump restore/sanitized-state.sql\n   Uporabnik postgres potrebuje tudi prehod do te mape. Po obnovi odstrani njegov začasni dostop.\n\n2. Na ciljnem Ubuntu namesti Node 20+, PostgreSQL, nginx, git in tar ter obdelavo slik:\n   sudo apt-get install -y libvips-tools libheif-examples\n   Ustvari uporabnika indus-ure in mape po application/DEPLOY-UBUNTU.md.\n   NAJPREJ preveri obnovo v izolirani bazi in hash prilog. Za redno objavo je obvezen run-indus-ure-postgres-qa; obnovitev produkcije potrebuje posebej dovoljenje lastnika.\n\n3. Pred potrjeno produkcijsko obnovo naredi neodvisno kopijo trenutne baze, medijev in okolja. Ustavi aplikacijo IN vse skripte, timerje ali druge pisce baze. Preveri ciljni strežnik:\n   sudo systemctl stop indus-ure.service indus-ure-worker-digest.timer indus-ure-backup.timer\n   Preveri tudi morebitne že tekoče digest/backup storitve.\n\n4. BAZA - naslednji ukazi PREPIŠEJO indus_ure, nikoli indus_fakture:\n   sudo -u postgres dropdb --if-exists indus_ure\n   sudo -u postgres createdb --owner=indus_ure indus_ure\n   sudo -u postgres pg_restore --no-owner --no-acl --role=indus_ure -d indus_ure restore/database.dump\n   sudo -u postgres psql -v ON_ERROR_STOP=1 -d indus_ure -f restore/sanitized-state.sql\n   Ne izpusti indus_meta/storage_revision. Ne zaganjaj starega pisca brez CAS zaščite.\n\n5. PRILOGE IN KODA:\n   Ohranjen star MEDIA_DIR naj bo ločena pred-obnovitvena kopija; ne briši ga vnaprej.\n   Pripravi prazno /var/lib/indus-ure/media in vanjo kopiraj restore/media/.\n   Lastništvo indus-ure:indus-ure, zasebne mape 0700.\n   Kodo restore/application/ pripravi kot ločeno preverjeno izdajo, npm ci --omit=dev.\n   Ne prepisuj aktivne izdaje. Preklop izvedi šele po testih, z aplikacijo ustavljeno.\n   Nepovezane stare medijske datoteke se namenoma ohranijo; čiščenje ni del obnove.\n\n6. Ročno obnovi /etc/indus-ure.env iz LOČENEGA varnega zapisa:\n   DATABASE_URL, NODE_ENV=production, HOST=127.0.0.1, PORT=8123,\n   MEDIA_DIR=/var/lib/indus-ure/media, PUBLIC_BASE_URL=https://ure.indus.si,\n   Google OAuth, GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID,\n   GOOGLE_DRIVE_TASKS_FOLDER_ID (Dokumenti/Preglednice), GOOGLE_DRIVE_OWNER_EMAIL,\n   BACKUP_DIR=/var/backups/indus-ure.\n   Lokalna javna prijava z geslom NI vključena. Google identitete uporabnikov ostanejo.\n   Izbirna servisna LAN prijava zahteva LAN_SUPPORT_LOGIN_ENABLED, LAN_SUPPORT_LOGIN_PASSWORD\n   (vsaj 24 znakov), izbiro obstoječega uporabnika ter preverjen LAN proxy;\n   natančna imena in omrežne pogoje preveri v OPERATIONS.md. Ne odpiraj je internetu.\n   Skrivnosti in sej ne kopiraj v chat ali Git.\n\n7. Namesti systemd/nginx datoteke iz application/deploy/, nato:\n   sudo systemctl daemon-reload\n   sudo systemctl start indus-ure.service\n   curl --fail http://127.0.0.1:8123/api/health\n   Preveri prijavo, opravilo, prilogo, obračun, števila vrstic in dnevnik napak.\n   Šele po uspešnem preverjanju ponovno vključi prej omogočene timerje.\n\n8. Kot Bojan v Nastavitvah ponovno poveži Google. ICS povezave in seje se ne obnovijo.\n   Ustvari nove read-only ICS povezave ter preveri uspešen nov recovery backup in Drive navodila.\n\nPred produkcijsko obnovo postopek preveri na ločenem testnem strežniku.\n";
}
async function verifyLocalArchive(file) {
  const output = await execFileAsync("tar", ["-tzf", file], { maxBuffer: 16 * 1024 * 1024 });
  const names = String(output.stdout || "").split(/\r?\n/).filter(Boolean);
  for (const required of ["database.dump", "sanitized-state.sql", "media", "application/package.json", "RESTORE-INDUS-URE.txt", "manifest.json"]) {
    if (!names.some((name) => name === required || name.startsWith(`${required}/`))) throw new Error(`Lokalni recovery paket nima: ${required}.`);
  }
}

function poolForDatabase() { return new Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } }); }
async function ensureTables(pool) {
  await pool.query(`
    create table if not exists indus_backup_runs (id text primary key, status text not null, finished_at timestamptz, data jsonb not null, created_at timestamptz not null default now());
    create table if not exists indus_meta (key text primary key, data jsonb not null, updated_at timestamptz not null default now());
    create table if not exists indus_notifications (id text primary key, user_id text not null default '', severity text not null default 'info', read_at timestamptz, data jsonb not null, created_at timestamptz not null default now());
    create index if not exists indus_notifications_user_idx on indus_notifications (user_id, read_at, created_at desc);
  `);
}
async function recordRun(pool, id, status, data) {
  await pool.query("insert into indus_backup_runs (id, status, finished_at, data) values ($1, $2, now(), $3::jsonb) on conflict (id) do update set status = excluded.status, finished_at = excluded.finished_at, data = excluded.data", [id, status, JSON.stringify(data)]);
}
async function clearBackupAlerts(pool) {
  // A successful retry proves the current backup is healthy, but it must not erase a failed backup before it is seen.
  await pool.query("delete from indus_notifications where user_id = $1 and read_at is null and data ->> 'code' = $2", ["bojan", "backup-stale"]);
}
async function recordFailureAlert(pool, result) {
  const existing = await pool.query("select id from indus_notifications where user_id = $1 and read_at is null and data ->> 'code' = $2 limit 1", ["bojan", "backup-failed"]);
  if (existing.rowCount) return;
  const notification = { id: crypto.randomUUID(), code: "backup-failed", severity: "critical", title: "Varnostna kopija ni uspela", message: `Samodejni recovery backup ni uspel: ${result.error}`.slice(0, 900), createdAt: result.finishedAt };
  await pool.query("insert into indus_notifications (id, user_id, severity, data) values ($1, $2, $3, $4::jsonb)", [notification.id, "bojan", notification.severity, JSON.stringify(notification)]);
}
async function notifyFailure(result) {
  if (!ALERT_SMTP_URL || !ALERT_EMAIL_FROM || !ALERT_EMAIL_TO) return;
  await nodemailer.createTransport(ALERT_SMTP_URL).sendMail({ from: ALERT_EMAIL_FROM, to: ALERT_EMAIL_TO, subject: "INDUS URE: neuspesna varnostna kopija", text: `Backup ${result.id} ni uspel ob ${result.finishedAt}.\n\n${result.error}` });
}

async function driveForOwner(pool) {
  const result = await pool.query("select data from indus_users where lower(coalesce(data->>'email', '')) = $1 limit 1", [OWNER_EMAIL]);
  const user = result.rows[0]?.data;
  if (!user?.google?.tokens || !user?.google?.driveScopeVersion) throw new Error("Bojan mora v INDUS URE ponovno povezati Google Drive pred prvim off-site backupom.");
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  auth.setCredentials(user.google.tokens);
  return google.drive({ version: "v3", auth });
}
async function meta(pool, key) { return (await pool.query("select data from indus_meta where key = $1", [key])).rows[0]?.data || null; }
async function setMeta(pool, key, value) { await pool.query("insert into indus_meta (key, data) values ($1, $2::jsonb) on conflict (key) do update set data = excluded.data, updated_at = now()", [key, JSON.stringify(value)]); }
async function backupFolder(pool, drive) {
  const stored = await meta(pool, "backup_drive_folder");
  if (stored?.id) {
    try {
      const current = await drive.files.get({ fileId: stored.id, fields: "id,mimeType,trashed" });
      if (current.data?.mimeType === "application/vnd.google-apps.folder" && !current.data.trashed) return current.data.id;
    } catch {}
  }
  const q = [`'${PARENT_FOLDER_ID.replace(/'/g, "\\'")}' in parents`, "trashed = false", "mimeType = 'application/vnd.google-apps.folder'", `appProperties has { key='indusApp' and value='${APP_ID}' }`, `appProperties has { key='purpose' and value='${PURPOSE.folder}' }`].join(" and ");
  const found = await drive.files.list({ q, fields: "files(id)", orderBy: "createdTime asc", pageSize: 10 });
  let id = found.data.files?.[0]?.id || "";
  if (!id) {
    const created = await drive.files.create({ requestBody: { name: "INDUS URE - recovery backups", mimeType: "application/vnd.google-apps.folder", parents: [PARENT_FOLDER_ID], appProperties: { indusApp: APP_ID, purpose: PURPOSE.folder } }, fields: "id,parents" });
    id = created.data?.id || "";
    if (!id || !(created.data.parents || []).includes(PARENT_FOLDER_ID)) throw new Error("Namenske Drive mape za backup ni mogoče varno ustvariti.");
  }
  await setMeta(pool, "backup_drive_folder", { id, parentId: PARENT_FOLDER_ID, createdAt: new Date().toISOString() });
  return id;
}
async function upload(drive, folderId, localFile, purpose, backupId = "", mimeType = "application/octet-stream") {
  const result = await drive.files.create({
    requestBody: { name: path.basename(localFile), parents: [folderId], mimeType, appProperties: { indusApp: APP_ID, purpose, ...(backupId ? { backupId } : {}) } },
    media: { mimeType, body: fs.createReadStream(localFile) },
    fields: "id,name,size,md5Checksum,parents,trashed"
  });
  if (!result.data?.id || result.data.trashed || !(result.data.parents || []).includes(folderId)) throw new Error(`Google Drive ni sprejel ${path.basename(localFile)}.`);
  return result.data;
}
async function verifyDrive(drive, folderId, localFile, remote) {
  const [size, localMd5, fetched] = await Promise.all([bytes(localFile), md5(localFile), drive.files.get({ fileId: remote.id, fields: "id,size,md5Checksum,parents,trashed" })]);
  const fresh = fetched.data || {};
  if (fresh.trashed || !(fresh.parents || []).includes(folderId)) throw new Error(`Google Drive datoteke ${path.basename(localFile)} ni v pravi mapi.`);
  if (Number(fresh.size || 0) !== size) throw new Error(`Google Drive velikost ni pravilna: ${path.basename(localFile)}.`);
  if (!fresh.md5Checksum || fresh.md5Checksum.toLowerCase() !== localMd5.toLowerCase()) throw new Error(`Google Drive MD5 preverjanje ni uspelo: ${path.basename(localFile)}.`);
  return { id: fresh.id, bytes: size, md5: localMd5 };
}
async function upsertInstructions(drive, folderId, file) {
  const q = [`'${folderId.replace(/'/g, "\\'")}' in parents`, "trashed = false", `appProperties has { key='indusApp' and value='${APP_ID}' }`, `appProperties has { key='purpose' and value='${PURPOSE.instructions}' }`].join(" and ");
  const found = await drive.files.list({ q, fields: "files(id)", orderBy: "createdTime desc", pageSize: 1 });
  const requestBody = { name: path.basename(file), mimeType: "text/plain", appProperties: { indusApp: APP_ID, purpose: PURPOSE.instructions } };
  const existing = found.data.files?.[0]?.id;
  const remote = existing
    ? (await drive.files.update({ fileId: existing, requestBody, media: { mimeType: "text/plain", body: fs.createReadStream(file) }, fields: "id,size,md5Checksum,parents,trashed" })).data
    : await upload(drive, folderId, file, PURPOSE.instructions, "", "text/plain");
  return verifyDrive(drive, folderId, file, remote);
}
async function driveFiles(drive, q) {
  const files = []; let pageToken = "";
  do {
    const result = await drive.files.list({ q, fields: "nextPageToken,files(id,createdTime,appProperties)", pageSize: 1000, pageToken: pageToken || undefined });
    files.push(...(result.data.files || [])); pageToken = result.data.nextPageToken || "";
  } while (pageToken);
  return files;
}
async function retainDrive(drive, folderId) {
  const files = await driveFiles(drive, [`'${folderId.replace(/'/g, "\\'")}' in parents`, "trashed = false", `appProperties has { key='indusApp' and value='${APP_ID}' }`].join(" and "));
  const cutoff = Date.now() - OFFSITE_RETENTION_DAYS * 86400000;
  const expiredIds = new Set(files.filter((file) => file.appProperties?.purpose === PURPOSE.archive && new Date(file.createdTime || 0).getTime() < cutoff).map((file) => file.appProperties?.backupId).filter(Boolean));
  for (const file of files.filter((file) => expiredIds.has(file.appProperties?.backupId))) await drive.files.delete({ fileId: file.id });
}
async function retainLocal() {
  const cutoff = Date.now() - LOCAL_RETENTION_DAYS * 86400000;
  for (const item of await fsp.readdir(BACKUP_DIR, { withFileTypes: true })) {
    if (!item.isFile() || !/^indus-ure-recovery-.*\.tar\.gz(?:\.sha256)?$/.test(item.name)) continue;
    const file = path.join(BACKUP_DIR, item.name);
    if ((await fsp.stat(file)).mtimeMs < cutoff) await fsp.rm(file, { force: true });
  }
}

async function main() {
  const id = `backup-${stamp()}-${crypto.randomBytes(4).toString("hex")}`;
  const pool = poolForDatabase(); let work = "";
  try {
    requireConfig();
    await ensureTables(pool);
    await fsp.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
    work = await fsp.mkdtemp(path.join(BACKUP_DIR, ".working-"));
    const database = path.join(work, "database.dump"), state = path.join(work, "sanitized-state.sql"), media = path.join(work, "media"), application = path.join(work, "application"), guide = path.join(work, "RESTORE-INDUS-URE.txt"), manifestPath = path.join(work, "manifest.json");
    const archive = path.join(BACKUP_DIR, `indus-ure-recovery-${stamp()}.tar.gz`), checksumPath = `${archive}.sha256`;
    await fsp.mkdir(media, { recursive: true, mode: 0o700 });
    await dumpConsistentDatabase(pool, work, database, state);
    await copyMedia(media);
    await copyApplication(application);
    const configuration = require("../outputs/app-config").createAppConfig({
      file: path.join(process.env.NODE_ENV === "production" ? "/var/lib/indus-ure" : (process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(APP_DIR, "outputs", "data")), "app-config.json")
    }).get();
    await fsp.writeFile(path.join(work, "app-config.json"), JSON.stringify(configuration, null, 2), { mode: 0o600 });
    await fsp.writeFile(guide, restoreGuide(), { mode: 0o600 });
    const manifest = { format: "indus-ure-recovery-v2", id, createdAt: new Date().toISOString(), application: "INDUS URE", database: "database.dump", sanitizedState: "sanitized-state.sql", media: "media", applicationSource: "application", configuration: "app-config.json", applicationSecretsIncluded: false, excluded: ["OAuth tokens", "password hashes", "active sessions", "ICS feed tokens", "server environment secrets"], mediaFiles: await mediaManifest(media), verification: ["local tar listing", "SHA-256 sidecar", "Google Drive size", "Google Drive MD5", "fresh Drive metadata read"], restore: "Follow RESTORE-INDUS-URE.txt." };
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await execFileAsync("tar", ["-C", work, "-czf", archive, "database.dump", "sanitized-state.sql", "media", "application", "app-config.json", "RESTORE-INDUS-URE.txt", "manifest.json"], { maxBuffer: 2 * 1024 * 1024 });
    await verifyLocalArchive(archive);
    const checksum = await sha256(archive);
    await fsp.writeFile(checksumPath, `${checksum}  ${path.basename(archive)}\n`, { mode: 0o600 });
    const drive = await driveForOwner(pool), folderId = await backupFolder(pool, drive);
    const [remoteArchive, remoteChecksum, instructions] = await Promise.all([
      upload(drive, folderId, archive, PURPOSE.archive, id), upload(drive, folderId, checksumPath, PURPOSE.checksum, id, "text/plain"), upsertInstructions(drive, folderId, guide)
    ]);
    const [archiveCheck, checksumCheck] = await Promise.all([verifyDrive(drive, folderId, archive, remoteArchive), verifyDrive(drive, folderId, checksumPath, remoteChecksum)]);
    await retainDrive(drive, folderId); await retainLocal();
    const result = { id, status: "success", createdAt: manifest.createdAt, recoveryFile: path.basename(archive), checksumFile: path.basename(checksumPath), bytes: archiveCheck.bytes, sha256: checksum, driveFileId: archiveCheck.id, driveChecksumFileId: checksumCheck.id, driveFolderId: folderId, verified: { localArchive: true, driveSize: true, driveMd5: true, freshDriveRead: true, restoreInstructions: Boolean(instructions.id) } };
    await recordRun(pool, id, "success", result); await clearBackupAlerts(pool); process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const result = { id, status: "failed", finishedAt: new Date().toISOString(), error: error.message || String(error) };
    try { await recordRun(pool, id, "failed", result); } catch {}
    try { await recordFailureAlert(pool, result); } catch (notifyError) { process.stderr.write(`Backup app notification failed: ${notifyError.message || notifyError}\n`); }
    try { await notifyFailure(result); } catch (notifyError) { process.stderr.write(`Backup email notification failed: ${notifyError.message || notifyError}\n`); }
    process.stderr.write(`INDUS URE backup failed: ${result.error}\n`); process.exitCode = 1;
  } finally {
    if (work) await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
  }
}
if (require.main === module) main();
module.exports = { dumpConsistentDatabase, dumpDatabase, writeSanitizedState, sanitize, restoreGuide };
