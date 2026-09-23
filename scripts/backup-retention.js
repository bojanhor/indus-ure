"use strict";

const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const ARCHIVE = /^indus-ure-recovery-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.gz$/;
const DAY = 86400000;

function retentionPolicy(environment = process.env) {
  const integer = (key, fallback, min, max) => {
    const value = Number(environment[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Neveljavna nastavitev ${key}.`);
    return value;
  };
  return {
    dailyDays: integer("BACKUP_LOCAL_RETENTION_DAYS", 7, 7, 365),
    deploymentCopies: integer("BACKUP_LOCAL_DEPLOYMENT_COPIES", 3, 3, 100),
    timeZone: "Europe/Ljubljana"
  };
}

function archiveTime(name) {
  const m = ARCHIVE.exec(name);
  if (!m) return NaN;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso ? date.getTime() : NaN;
}

function dayKey(time, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time);
  const value = type => parts.find(part => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function planRetention(records, { now = Date.now(), policy = retentionPolicy({}) } = {}) {
  retentionPolicy({ BACKUP_LOCAL_RETENTION_DAYS: policy.dailyDays, BACKUP_LOCAL_DEPLOYMENT_COPIES: policy.deploymentCopies });
  if (policy.timeZone !== "Europe/Ljubljana") throw new Error("Neveljaven časovni pas hrambe kopij.");
  const today = dayKey(now, policy.timeZone);
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - (policy.dailyDays - 1) * DAY).toISOString().slice(0, 10);
  const sorted = [...records].sort((a, b) => b.time - a.time);
  const keep = new Set(sorted.filter(row => row.deployment).slice(0, policy.deploymentCopies).map(row => row.name));
  const days = new Set();
  for (const row of sorted) {
    const day = dayKey(row.time, policy.timeZone);
    // Future-dated files are never aged out by a possibly incorrect clock.
    if (row.time > now) keep.add(row.name);
    if (day >= cutoff && day <= today && !days.has(day)) { keep.add(row.name); days.add(day); }
  }
  // An initial installation may not yet have three deployment checkpoints.
  for (const row of sorted) { if (keep.size >= Math.min(3, sorted.length)) break; keep.add(row.name); }
  return { keep: sorted.filter(row => keep.has(row.name)), remove: sorted.filter(row => !keep.has(row.name)) };
}

async function safeDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("Mapa varnostnih kopij mora biti absolutna pot.");
  const resolved = path.resolve(directory);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolved === path.parse(resolved).root
      || path.relative(resolved, await fs.realpath(resolved)) !== "") throw new Error("Nevarna mapa varnostnih kopij.");
  return resolved;
}

async function regular(file, maxSize = Infinity) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxSize) throw new Error(`Nevarna datoteka: ${path.basename(file)}.`);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}
async function unchanged(file, previous) {
  const current = await regular(file);
  if (Object.keys(previous).some(key => previous[key] !== current[key])) throw new Error(`Kopija se je med preverjanjem spremenila: ${path.basename(file)}.`);
}
async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventory(directory) {
  const records = [], ignored = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const time = archiveTime(item.name);
    if (!Number.isFinite(time)) continue;
    const file = path.join(directory, item.name);
    // Leave incomplete, non-regular and unknown objects for manual review.
    if (!item.isFile()) { ignored.push(item.name); continue; }
    const stat = await regular(file);
    let checksumStat;
    try { checksumStat = await regular(`${file}.sha256`, 4096); }
    catch (error) { if (error.code !== "ENOENT") throw error; ignored.push(item.name); continue; }
    const checksumText = (await fs.readFile(`${file}.sha256`, "utf8")).trim();
    const checksum = checksumText.match(/^([a-f0-9]{64})  (.+)$/i);
    if (!checksum || checksum[2] !== item.name) throw new Error(`Neveljavna kontrolna datoteka: ${item.name}.`);
    const row = { name: item.name, time, stat, checksumStat, checksum: checksum[1].toLowerCase(), deployment: null, markerStat: null };
    try {
      row.markerStat = await regular(`${file}.deployment.json`, 4096);
      const marker = JSON.parse(await fs.readFile(`${file}.deployment.json`, "utf8"));
      if (marker.format !== "indus-ure-deployment-backup-v1" || marker.archive !== row.name
          || marker.sha256 !== row.checksum || !/^[a-f0-9]{7,40}$/.test(marker.release)) throw new Error("Neveljavna oznaka kopije pred objavo.");
      row.deployment = marker;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    records.push(row);
  }
  return { records, ignored };
}

async function withRetentionLock(directory, action) {
  const root = await safeDirectory(directory);
  const lock = path.join(root, ".retention-lock");
  // Both deployment marking and pruning take this lock. Never remove a lock
  // left by another/crashed process automatically; uncertainty means no prune.
  await fs.mkdir(lock, { mode: 0o700 });
  try { return await action(root); }
  finally { await fs.rmdir(lock); }
}

async function inspectRetention(directory, options = {}) {
  const root = await safeDirectory(directory);
  const { records, ignored } = await inventory(root);
  const plan = planRetention(records, options);
  return {
    kept: plan.keep.map(row => row.name), remove: plan.remove.map(row => row.name), ignored,
    keptBytes: plan.keep.reduce((sum, row) => sum + row.stat.size, 0),
    removableBytes: plan.remove.reduce((sum, row) => sum + row.stat.size, 0)
  };
}

async function retainLocal(directory, { verifiedBackup, now = Date.now(), policy = retentionPolicy({}) } = {}) {
  const proof = verifiedBackup;
  if (!proof || proof.status !== "success" || !proof.verified?.localArchive || !proof.verified?.driveSize
      || !proof.verified?.driveMd5 || !proof.verified?.freshDriveRead || !proof.verified?.restoreInstructions
      || !proof.driveFileId || !proof.driveChecksumFileId
      || !Number.isFinite(archiveTime(proof.recoveryFile)) || Math.abs(now - archiveTime(proof.recoveryFile)) > 6 * 3600000) {
    throw new Error("Čiščenje zahteva novo, lokalno in na Google Drive preverjeno kopijo.");
  }
  return withRetentionLock(directory, async root => {
    const { records, ignored } = await inventory(root);
    const plan = planRetention(records, { now, policy });
    const fresh = plan.keep.find(row => row.name === proof.recoveryFile);
    if (!fresh || fresh.checksum !== proof.sha256 || fresh.stat.size !== proof.bytes) throw new Error("Nova preverjena kopija ni med ohranjenimi kopijami.");
    // Verify ALL retained archives before deleting even the first old file.
    for (const row of plan.keep) {
      if (await sha256(path.join(root, row.name)) !== row.checksum) throw new Error(`SHA-256 preverjanje ohranjene kopije ni uspelo: ${row.name}.`);
    }
    // Preflight the whole plan under the shared lock, not one deletion at a time.
    for (const row of records) {
      await unchanged(path.join(root, row.name), row.stat);
      await unchanged(path.join(root, `${row.name}.sha256`), row.checksumStat);
      if (row.markerStat) await unchanged(path.join(root, `${row.name}.deployment.json`), row.markerStat);
    }
    for (const row of plan.remove) {
      await fs.unlink(path.join(root, row.name));
      await fs.unlink(path.join(root, `${row.name}.sha256`));
      if (row.markerStat) await fs.unlink(path.join(root, `${row.name}.deployment.json`));
    }
    return {
      policy, kept: plan.keep.map(row => row.name), removed: plan.remove.map(row => row.name), ignored,
      keptBytes: plan.keep.reduce((sum, row) => sum + row.stat.size, 0),
      freedBytes: plan.remove.reduce((sum, row) => sum + row.stat.size, 0)
    };
  });
}

async function markDeploymentBackup(directory, { release, archive, notBefore = 0 } = {}) {
  if (!/^[a-f0-9]{7,40}$/.test(release || "") || !Number.isFinite(notBefore) || notBefore < 0
      || (archive && !Number.isFinite(archiveTime(archive)))) throw new Error("Neveljavna zahteva za označitev kopije pred objavo.");
  return withRetentionLock(directory, async root => {
    const { records } = await inventory(root);
    const row = records.sort((a, b) => b.time - a.time).find(item => archive ? item.name === archive : item.stat.mtimeMs >= notBefore);
    if (!row) throw new Error("Nova kopija pred objavo ni najdena.");
    if (await sha256(path.join(root, row.name)) !== row.checksum) throw new Error("Kopija pred objavo nima veljavne kontrolne vsote.");
    await unchanged(path.join(root, row.name), row.stat);
    const marker = { format: "indus-ure-deployment-backup-v1", archive: row.name, sha256: row.checksum, release, markedAt: new Date().toISOString() };
    const target = path.join(root, `${row.name}.deployment.json`);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      // Directory stays private; root-created markers must be readable by the
      // indus-ure service that applies retention after the next verified run.
      await fs.writeFile(temporary, JSON.stringify(marker) + "\n", { flag: "wx", mode: 0o644 });
      await fs.chmod(temporary, 0o644);
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return marker;
  });
}

module.exports = { retentionPolicy, archiveTime, planRetention, inspectRetention, retainLocal, markDeploymentBackup };
if (require.main === module) {
  const args = process.argv.slice(2);
  const preview = args.length === 2 && args[0] === "--inspect"
    ? inspectRetention(args[1], { policy: retentionPolicy() })
    : Promise.reject(new Error("Uporaba (samo pregled): node backup-retention.js --inspect <BACKUP_DIR>"));
  preview.then(result => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
    .catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
}
