#!/usr/bin/env node
"use strict";

// Restores only attachments whose task IDs still exist in production.  It never
// restores an old task, user, calendar state or billing state from the backup.
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Pool } = require("pg");

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 32 * 1024 * 1024;
const DEFAULT_ARCHIVE = "/var/backups/indus-ure/offsite/indus-ure-recovery-20260721T170515Z.tar.gz";
const arg = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? String(process.argv[index + 1] || "") : ""; };
const attachmentId = (value) => /^[a-f0-9]{64}$/.test(String(value || ""));
const taskId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
const safeKey = (value, id, kind) => new RegExp(`^${kind}/${id}\\.(?:jpg|jpeg|png|webp|pdf|mp4|mov|webm|bin)$`, "i").test(String(value || "")) ? String(value) : "";

async function run(command, args, options = {}) { return execFileAsync(command, args, { maxBuffer: MAX_OUTPUT, ...options }); }
async function asPostgres(args, options = {}) { return run("runuser", ["-u", "postgres", "--", ...args], options); }
async function tarBuffer(archive, entry) { return (await run("tar", ["-xOf", archive, entry], { encoding: "buffer" })).stdout; }
async function archiveEntries(archive) { return new Set((await run("tar", ["-tzf", archive])).stdout.split(/\r?\n/).filter(Boolean)); }

async function readBackupRows(databaseName) {
  const sql = `select json_build_object('taskId', t.id, 'photos', t.data->'photos', 'attachments', json_agg(json_build_object('id', a.id, 'mimeType', a.mime_type, 'byteSize', a.byte_size, 'storageKey', a.storage_key, 'thumbnailKey', a.thumbnail_key, 'data', a.data))) from indus_tasks t cross join lateral jsonb_array_elements(coalesce(t.data->'photos','[]'::jsonb)) p join indus_attachments a on a.id = p->>'attachmentId' group by t.id, t.data order by t.id;`;
  const stdout = (await asPostgres(["psql", "-d", databaseName, "-At", "-c", sql])).stdout;
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function writeArchiveFile(archive, mediaDir, entry, targetKey, copied) {
  const target = path.resolve(mediaDir, targetKey);
  if (!target.startsWith(`${mediaDir}${path.sep}`)) throw new Error("Neveljavna ciljna pot priloge.");
  if (fs.existsSync(target)) return;
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.writeFile(target, await tarBuffer(archive, entry), { mode: 0o600 });
  await run("chown", ["indus-ure:indus-ure", target]);
  copied.push(target);
}

async function main() {
  const archive = path.resolve(arg("--archive") || DEFAULT_ARCHIVE);
  const apply = process.argv.includes("--apply");
  const mediaDir = path.resolve(process.env.MEDIA_DIR || "");
  if (!fs.existsSync(archive)) throw new Error(`Recovery paket ne obstaja: ${archive}`);
  if (!process.env.DATABASE_URL || !mediaDir) throw new Error("DATABASE_URL ali MEDIA_DIR manjka.");
  if (apply && typeof process.getuid === "function" && process.getuid() !== 0) throw new Error("Dejansko obnovo zaženi prek sudo.");

  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), "indus-ure-attachment-restore-"));
  const stagingDb = `indus_ure_recovery_${crypto.randomBytes(5).toString("hex")}`;
  const dump = path.join(stage, "database.dump");
  const copied = [];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let databaseCreated = false;
  try {
    await fsp.chmod(stage, 0o755);
    await fsp.writeFile(dump, await tarBuffer(archive, "database.dump"), { mode: 0o644 });
    await asPostgres(["createdb", stagingDb]);
    databaseCreated = true;
    await asPostgres(["pg_restore", "--no-owner", "--no-acl", "-d", stagingDb, dump]);
    const [backupRows, archiveFiles] = await Promise.all([readBackupRows(stagingDb), archiveEntries(archive)]);
    const candidates = new Map();
    for (const row of backupRows) {
      if (!taskId(row.taskId) || !Array.isArray(row.photos) || !Array.isArray(row.attachments)) continue;
      const attachmentById = new Map(row.attachments.filter((item) => attachmentId(item?.id)).map((item) => [item.id, item]));
      const photos = row.photos.filter((photo) => attachmentId(photo?.attachmentId) && attachmentById.has(photo.attachmentId));
      if (photos.length) candidates.set(row.taskId, { photos, attachmentById });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const liveRows = await client.query("select id, data from indus_tasks where id = any($1::text[]) for update", [[...candidates.keys()]]);
      const liveById = new Map(liveRows.rows.map((row) => [String(row.id), row]));
      const plan = [];
      for (const [id, source] of candidates) {
        const live = liveById.get(id);
        if (!live) continue;
        const data = live.data && typeof live.data === "object" ? live.data : {};
        const existing = Array.isArray(data.photos) ? data.photos : [];
        const existingIds = new Set(existing.map((photo) => String(photo?.attachmentId || "")).filter(attachmentId));
        const attachments = [];
        const photos = [];
        for (const photo of source.photos) {
          const attachment = source.attachmentById.get(photo.attachmentId);
          const storageKey = safeKey(attachment.storageKey, attachment.id, "objects");
          if (!storageKey || !archiveFiles.has(`media/${storageKey}`)) continue;
          photos.push(photo);
          attachments.push({ ...attachment, storageKey, thumbnailKey: safeKey(attachment.thumbnailKey, attachment.id, "thumbnails") });
        }
        if (photos.length) plan.push({ id, data, photos: [...existing, ...photos.filter((photo) => !existingIds.has(photo.attachmentId))], attachments });
      }

      if (apply) {
        for (const item of plan) {
          for (const attachment of item.attachments) {
            await writeArchiveFile(archive, mediaDir, `media/${attachment.storageKey}`, attachment.storageKey, copied);
            if (attachment.thumbnailKey && archiveFiles.has(`media/${attachment.thumbnailKey}`)) await writeArchiveFile(archive, mediaDir, `media/${attachment.thumbnailKey}`, attachment.thumbnailKey, copied);
            await client.query(`insert into indus_attachments (id, mime_type, byte_size, storage_key, thumbnail_key, data) values ($1,$2,$3,$4,$5,$6::jsonb) on conflict (id) do nothing`, [attachment.id, attachment.mimeType || "application/octet-stream", Number(attachment.byteSize || 0), attachment.storageKey, attachment.thumbnailKey || "", JSON.stringify(attachment.data || {})]);
          }
          await client.query("update indus_tasks set data = $2::jsonb, updated_at = now() where id = $1", [item.id, JSON.stringify({ ...item.data, photos: item.photos })]);
        }
      }
      await client.query("commit");
      process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry-run", archive, backupTasksWithAttachments: candidates.size, existingTasksMatched: plan.length, attachmentReferencesRestored: plan.flatMap((item) => item.attachments).length, filesCopied: apply ? copied.length : 0, skippedMissingTasks: candidates.size - plan.length })}\n`);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally { client.release(); }
  } catch (error) {
    if (apply) await Promise.all(copied.map((file) => fsp.rm(file, { force: true }).catch(() => {})));
    throw error;
  } finally {
    await pool.end();
    if (databaseCreated) await asPostgres(["dropdb", "--if-exists", stagingDb]).catch(() => {});
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(`Obnova prilog ni uspela: ${error.message}\n`); process.exitCode = 1; });