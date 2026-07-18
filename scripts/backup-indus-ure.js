#!/usr/bin/env node
"use strict";

// Creates a self-contained encrypted recovery package: PostgreSQL dump + media.
// The matching age private key is deliberately never read or stored on the server.

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
const AGE_RECIPIENT = String(process.env.AGE_RECIPIENT || "").trim();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const GOOGLE_DRIVE_OWNER_EMAIL = String(process.env.GOOGLE_DRIVE_OWNER_EMAIL || "bojan@indus.si").trim().toLowerCase();
const GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID = String(process.env.GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID || process.env.GOOGLE_DRIVE_TASKS_FOLDER_ID || "").trim();
const LOCAL_RETENTION_DAYS = Math.max(7, Number(process.env.BACKUP_LOCAL_RETENTION_DAYS || 30));
const OFFSITE_RETENTION_DAYS = Math.max(30, Number(process.env.BACKUP_OFFSITE_RETENTION_DAYS || 90));
const ALERT_SMTP_URL = String(process.env.ALERT_SMTP_URL || "").trim();
const ALERT_EMAIL_FROM = String(process.env.ALERT_EMAIL_FROM || "").trim();
const ALERT_EMAIL_TO = String(process.env.ALERT_EMAIL_TO || "bojan@indus.si").trim();
const APP_ID = "indus-ure-v2";

function requireConfig() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL manjka.");
  if (!AGE_RECIPIENT.startsWith("age1")) throw new Error("AGE_RECIPIENT mora biti javni age prejemnik (age1...).");
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) throw new Error("Google OAuth podatki manjkajo za off-site backup.");
  if (!GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID) throw new Error("GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID manjka.");
}

function isoStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => fs.createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", resolve));
  return hash.digest("hex");
}

async function fileSize(file) {
  return Number((await fsp.stat(file)).size || 0);
}

function decodeUrlComponent(value) {
  try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
}

function pgpassEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

async function dumpDatabase(workDir, destination) {
  const parsed = new URL(DATABASE_URL);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("DATABASE_URL ni veljaven PostgreSQL URL za backup.");
  }
  const host = parsed.hostname;
  const port = parsed.port || "5432";
  const user = decodeUrlComponent(parsed.username);
  const database = decodeUrlComponent(parsed.pathname.replace(/^\//, ""));
  const password = decodeUrlComponent(parsed.password);
  const pgpass = path.join(workDir, ".pgpass");
  await fsp.writeFile(pgpass, `${pgpassEscape(host)}:${pgpassEscape(port)}:${pgpassEscape(database)}:${pgpassEscape(user)}:${pgpassEscape(password)}\n`, { mode: 0o600 });
  const environment = { ...process.env, PGPASSFILE: pgpass };
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) environment.PGSSLMODE = sslMode;
  const args = ["--format=custom", "--no-owner", "--no-acl", `--file=${destination}`, `--host=${host}`, `--port=${port}`, `--dbname=${database}`];
  if (user) args.push(`--username=${user}`);
  await execFileAsync("pg_dump", args, { env: environment, maxBuffer: 2 * 1024 * 1024 });
}

async function copyMediaToBackup(destination) {
  if (!fs.existsSync(MEDIA_DIR)) return;
  const entries = await fsp.readdir(MEDIA_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isFile()) continue;
    await fsp.cp(path.join(MEDIA_DIR, entry.name), path.join(destination, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
      errorOnExist: false
    });
  }
}

async function mediaManifest(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push({
          path: path.relative(root, absolute).split(path.sep).join("/"),
          bytes: await fileSize(absolute),
          sha256: await sha256(absolute)
        });
      }
    }
  }
  if (fs.existsSync(root)) await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function notifyBackupFailure(result) {
  if (!ALERT_SMTP_URL || !ALERT_EMAIL_FROM || !ALERT_EMAIL_TO) return;
  const transport = nodemailer.createTransport(ALERT_SMTP_URL);
  await transport.sendMail({
    from: ALERT_EMAIL_FROM,
    to: ALERT_EMAIL_TO,
    subject: "INDUS URE: neuspesna varnostna kopija",
    text: `Backup ${result.id} ni uspel ob ${result.finishedAt}.\n\n${result.error}`
  });
}

function poolForDatabase() {
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  return new Pool({ connectionString: DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });
}

async function ensureBackupTables(pool) {
  await pool.query(`
    create table if not exists indus_backup_runs (
      id text primary key,
      status text not null,
      finished_at timestamptz,
      data jsonb not null,
      created_at timestamptz not null default now()
    );
    create table if not exists indus_meta (
      key text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    );
  `);
}

async function recordRun(pool, id, status, data) {
  await pool.query(
    `insert into indus_backup_runs (id, status, finished_at, data)
     values ($1, $2, now(), $3::jsonb)
     on conflict (id) do update set status = excluded.status, finished_at = excluded.finished_at, data = excluded.data`,
    [id, status, JSON.stringify(data)]
  );
}

async function driveForOwner(pool) {
  const owner = await pool.query(
    "select data from indus_users where lower(coalesce(data->>'email', '')) = $1 limit 1",
    [GOOGLE_DRIVE_OWNER_EMAIL]
  );
  const user = owner.rows[0]?.data;
  const tokens = user?.google?.tokens;
  if (!tokens || !user?.google?.driveScopeVersion) {
    throw new Error("Bojan mora v INDUS URE ponovno povezati Google Drive pred prvim off-site backupom.");
  }
  const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oauth.setCredentials(tokens);
  return google.drive({ version: "v3", auth: oauth });
}

async function metaValue(pool, key) {
  const result = await pool.query("select data from indus_meta where key = $1", [key]);
  return result.rows[0]?.data || null;
}

async function setMetaValue(pool, key, data) {
  await pool.query(
    "insert into indus_meta (key, data) values ($1, $2::jsonb) on conflict (key) do update set data = excluded.data, updated_at = now()",
    [key, JSON.stringify(data)]
  );
}

async function backupDriveFolder(pool, drive) {
  const stored = await metaValue(pool, "backup_drive_folder");
  if (stored?.id) {
    try {
      const existing = await drive.files.get({ fileId: stored.id, fields: "id,name,mimeType,trashed" });
      if (existing.data?.mimeType === "application/vnd.google-apps.folder" && !existing.data.trashed) return existing.data.id;
    } catch {
      // A manually deleted folder is recreated in the approved parent folder.
    }
  }
  const query = [
    `'${GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID.replace(/'/g, "\\'")}' in parents`,
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.folder'",
    `appProperties has { key='indusApp' and value='${APP_ID}' }`,
    "appProperties has { key='purpose' and value='encrypted-backups' }"
  ].join(" and ");
  const found = await drive.files.list({ q: query, fields: "files(id,name,mimeType,createdTime)", orderBy: "createdTime asc", pageSize: 10 });
  let folderId = found.data.files?.[0]?.id || "";
  if (!folderId) {
    const created = await drive.files.create({
      requestBody: {
        name: "INDUS URE – encrypted backups",
        mimeType: "application/vnd.google-apps.folder",
        parents: [GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID],
        appProperties: { indusApp: APP_ID, purpose: "encrypted-backups" }
      },
      fields: "id,name,parents,owners(emailAddress)"
    });
    folderId = created.data.id || "";
    if (!folderId || !(created.data.parents || []).includes(GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID)) {
      throw new Error("Namenske Drive mape za backup ni bilo mogoče varno ustvariti.");
    }
  }
  await setMetaValue(pool, "backup_drive_folder", { id: folderId, parentId: GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID, createdAt: new Date().toISOString() });
  return folderId;
}

async function uploadEncryptedBackup(drive, folderId, file, manifest) {
  const uploaded = await drive.files.create({
    requestBody: {
      name: path.basename(file),
      parents: [folderId],
      mimeType: "application/octet-stream",
      appProperties: { indusApp: APP_ID, purpose: "encrypted-backup", backupId: manifest.id }
    },
    media: { mimeType: "application/octet-stream", body: fs.createReadStream(file) },
    fields: "id,name,webViewLink,size,md5Checksum,createdTime,parents"
  });
  if (!uploaded.data?.id || !(uploaded.data.parents || []).includes(folderId)) throw new Error("Šifriranega backupa ni bilo mogoče preveriti v Google Drive.");
  return uploaded.data;
}

async function enforceDriveRetention(drive, folderId) {
  const result = await drive.files.list({
    q: [
      `'${folderId.replace(/'/g, "\\'")}' in parents`,
      "trashed = false",
      `appProperties has { key='indusApp' and value='${APP_ID}' }`,
      "appProperties has { key='purpose' and value='encrypted-backup' }"
    ].join(" and "),
    fields: "files(id,createdTime)",
    pageSize: 1000
  });
  const cutoff = Date.now() - OFFSITE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  await Promise.all((result.data.files || [])
    .filter((file) => new Date(file.createdTime || 0).getTime() < cutoff)
    .map((file) => drive.files.delete({ fileId: file.id }).catch(() => {})));
}

async function removeOldLocalBackups() {
  const cutoff = Date.now() - LOCAL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
  await Promise.all(files
    .filter((entry) => entry.isFile() && /^indus-ure-recovery-.*\.age(?:\.sha256)?$/.test(entry.name))
    .map(async (entry) => {
      const file = path.join(BACKUP_DIR, entry.name);
      if ((await fsp.stat(file)).mtimeMs < cutoff) await fsp.rm(file, { force: true });
    }));
}

async function main() {
  requireConfig();
  const id = `backup-${isoStamp()}-${crypto.randomBytes(4).toString("hex")}`;
  const pool = poolForDatabase();
  let workDir = "";
  try {
    await ensureBackupTables(pool);
    await fsp.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
    workDir = await fsp.mkdtemp(path.join(BACKUP_DIR, ".working-"));
    const dump = path.join(workDir, "database.dump");
    const media = path.join(workDir, "media");
    const packageFile = path.join(workDir, "recovery.tar.gz");
    const encrypted = path.join(BACKUP_DIR, `indus-ure-recovery-${isoStamp()}.tar.gz.age`);
    await fsp.mkdir(media, { recursive: true, mode: 0o700 });
    await dumpDatabase(workDir, dump);
    await copyMediaToBackup(media);
    const mediaFiles = await mediaManifest(media);
    const manifest = {
      format: "indus-ure-encrypted-recovery-v1",
      id,
      createdAt: new Date().toISOString(),
      application: "INDUS URE",
      database: "database.dump",
      media: "media",
      applicationSecretsIncluded: false,
      databaseMayContainOAuthTokens: true,
      mediaFiles,
      restore: "Decrypt with the private age key, restore database.dump with pg_restore, then copy media/ to MEDIA_DIR. Recreate server environment secrets separately."
    };
    await fsp.writeFile(path.join(workDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await execFileAsync("tar", ["-C", workDir, "-czf", packageFile, "database.dump", "media", "manifest.json"], { maxBuffer: 2 * 1024 * 1024 });
    await execFileAsync("age", ["-r", AGE_RECIPIENT, "-o", encrypted, packageFile], { maxBuffer: 2 * 1024 * 1024 });
    const checksum = await sha256(encrypted);
    await fsp.writeFile(`${encrypted}.sha256`, `${checksum}  ${path.basename(encrypted)}\n`, { mode: 0o600 });
    const drive = await driveForOwner(pool);
    const folderId = await backupDriveFolder(pool, drive);
    const uploaded = await uploadEncryptedBackup(drive, folderId, encrypted, manifest);
    if (Number(uploaded.size || 0) !== await fileSize(encrypted)) throw new Error("Google Drive ni potrdil celotne velikosti sifriranega backupa.");
    await enforceDriveRetention(drive, folderId);
    await removeOldLocalBackups();
    const result = { id, status: "success", createdAt: manifest.createdAt, encryptedFile: path.basename(encrypted), bytes: await fileSize(encrypted), sha256: checksum, driveFileId: uploaded.id, driveFolderId: folderId };
    await recordRun(pool, id, "success", result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const result = { id, status: "failed", finishedAt: new Date().toISOString(), error: error.message || String(error) };
    try { await recordRun(pool, id, "failed", result); } catch {}
    try { await notifyBackupFailure(result); } catch (notifyError) { process.stderr.write(`Backup alert email failed: ${notifyError.message || notifyError}\n`); }
    process.stderr.write(`INDUS URE backup failed: ${result.error}\n`);
    process.exitCode = 1;
  } finally {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
  }
}

main();