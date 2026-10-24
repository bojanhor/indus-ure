"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { MEDIA_LOCK, referencedMediaIds } = require("../outputs/media-lifecycle");
const GRACE_MS = 24 * 3600000;
const BACKUP_LOCK = "indus-ure-recovery-backup";
const MANAGED_NAME = /^([a-f0-9]{64})\.(jpg|jpeg|png|webp|pdf|mp4|mov|webm|m4v|avi|mkv|3gp|bin)$/;
const TABLES = ["indus_meta", "indus_tasks", "indus_task_assignments", "indus_entries", "indus_debts",
  "indus_payrolls", "indus_client_bills", "indus_attachments"];

async function mediaCandidates(mediaDir, references, now = Date.now()) {
  const root = path.resolve(mediaDir);
  if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) throw new Error("Media root must be a real directory.");
  const candidates = [];
  for (const folder of ["objects", "thumbnails"]) {
    const dir = path.join(root, folder);
    const stat = await fs.lstat(dir).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) throw new Error("Unexpected media directory.");
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const match = entry.name.match(MANAGED_NAME);
      if (!match || !entry.isFile() || references.has(match[1])) continue;
      const file = path.join(dir, entry.name), info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || now - info.mtimeMs < GRACE_MS) continue;
      candidates.push({ file, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev });
    }
  }
  return candidates;
}
async function cleanupMedia(client, mediaDir, { proof, dryRun = false, now = Date.now() } = {}) {
  if (!dryRun && (!proof || proof.status !== "success" || !proof.verified?.localArchive
      || !proof.verified?.driveMd5 || !proof.verified?.freshDriveRead || !proof.verified?.readableCsv
      || !Number.isFinite(Date.parse(proof.createdAt)) || Math.abs(now - Date.parse(proof.createdAt)) > 6 * 3600000)) {
    throw new Error("Čiščenje prilog zahteva svežo preverjeno recovery kopijo.");
  }
  // Reentrant on the normal backup connection; also protects standalone QA/dry runs.
  const backupLocked = (await client.query("select pg_try_advisory_lock(hashtext($1)) as locked", [BACKUP_LOCK])).rows[0].locked;
  if (!backupLocked) return { skipped: true, reason: "Varnostna kopija še poteka.", removed: 0, freedBytes: 0 };
  let locked = false;
  const result = { removed: 0, freedBytes: 0, candidates: 0, candidateBytes: 0 };
  try {
    locked = (await client.query("select pg_try_advisory_lock(hashtext($1)) as locked", [MEDIA_LOCK])).rows[0].locked;
    if (!locked) return { skipped: true, reason: "Nalaganje ali shranjevanje prilog še poteka; ponovni poskus ob naslednji kopiji.", removed: 0, freedBytes: 0 };
    await client.query("begin");
    // Same lock/order as save(): no metadata writer can race the reference scan.
    const revision = await client.query("select data from indus_meta where key = 'storage_revision' for update");
    if (revision.rowCount !== 1) throw new Error("Manjka migracija storage_revision; čiščenje ustavljeno.");
    const values = [];
    for (const table of TABLES) {
      const rows = await client.query(table === "indus_attachments"
        ? "select id, storage_key, thumbnail_key, data from indus_attachments"
        : `select data from ${table}`);
      values.push(rows.rows);
    }
    const candidates = await mediaCandidates(mediaDir, referencedMediaIds(values), now);
    result.candidates = candidates.length;
    result.candidateBytes = candidates.reduce((sum, file) => sum + file.size, 0);
    const validateFile = async file => {
      const current = await fs.lstat(file.file);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
          || ["size", "mtimeMs", "ino", "dev"].some(key => current[key] !== file[key])) throw new Error("Datoteka priloge se je med pregledom spremenila.");
    };
    for (const file of candidates) await validateFile(file);
    if (!dryRun) for (const file of candidates) {
      await validateFile(file);
      await fs.unlink(file.file);
      result.removed++; result.freedBytes += file.size;
    }
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    error.mediaCleanup = result;
    throw error;
  } finally {
    try { if (locked) await client.query("select pg_advisory_unlock(hashtext($1))", [MEDIA_LOCK]); }
    finally { await client.query("select pg_advisory_unlock(hashtext($1))", [BACKUP_LOCK]); }
  }
}
module.exports = { referencedMediaIds, mediaCandidates, cleanupMedia };
