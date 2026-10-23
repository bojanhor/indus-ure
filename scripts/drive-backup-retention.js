"use strict";

const crypto = require("node:crypto");
const { archiveTime, withDeploymentMarkers } = require("./backup-retention");
const APP = "indus-ure-v2";
const ARCHIVE = "recovery-backup", CHECKSUM = "recovery-checksum";
const FIELDS = "id,name,size,md5Checksum,parents,trashed,ownedByMe,appProperties,version";

function driveRetentionPolicy(env = process.env) {
  const mode = env.BACKUP_OFFSITE_RETENTION_MODE ?? "daily3-weekly4-v1";
  if (mode !== "daily3-weekly4-v1") throw new Error("Neveljavna nastavitev BACKUP_OFFSITE_RETENTION_MODE.");
  // The obsolete 90-day/checkpoint settings must not silently override the
  // compact policy. Local retention is separate and remains unchanged.
  return { mode, dailyDays: 3, weeklyCopies: 4, deploymentCopies: 0, timeZone: "Europe/Ljubljana" };
}
function validatePolicy(policy) {
  const expected = driveRetentionPolicy({});
  if (!policy || Object.keys(policy).length !== Object.keys(expected).length
      || Object.keys(expected).some(key => policy[key] !== expected[key])) throw new Error("Neveljavna politika Drive hrambe kopij.");
}

const DAY = 86400000;
const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Ljubljana", year: "numeric", month: "2-digit", day: "2-digit" });
function calendarDay(time) {
  const parts = localDate.formatToParts(time);
  const part = type => Number(parts.find(p => p.type === type).value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY;
}
function planDriveRetention(records, { now = Date.now(), policy = driveRetentionPolicy({}) } = {}) {
  validatePolicy(policy);
  if (!Number.isFinite(now) || records.some(row => !Number.isFinite(row.time) || row.time > now)) {
    // Do not prune on an invalid/backwards clock, rather than silently exceed
    // the seven-copy cap or delete a future-dated recovery point.
    throw new Error("Drive hramba: neveljaven čas ali kopija z datumom v prihodnosti.");
  }
  const today = calendarDay(now), sorted = [...records].sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
  const rows = sorted.map(row => ({ row, day: calendarDay(row.time) }));
  const keep = new Set(), daily = new Set(), slots = {};
  for (const { row, day } of rows) {
    if (day >= today - 2 && !daily.has(day)) { keep.add(row.name); daily.add(day); }
  }
  slots.daily = [...keep];
  // Four completed Monday-Sunday weeks. Week 3 is a necessary staging point:
  // it becomes week 4 next Monday without retaining hidden extra candidates.
  // The latest ongoing-week copy survives in the daily slots until rollover.
  const mondayEpoch = 4; // 1970-01-05 in UTC calendar-day coordinates.
  const weekStart = Math.floor((today - mondayEpoch) / 7) * 7 + mondayEpoch;
  slots.weekly = [];
  for (let week = 1; week <= policy.weeklyCopies; week++) {
    const from = weekStart - week * 7, to = from + 7;
    const match = rows.find(({ day }) => day >= from && day < to);
    slots.weekly.push(match?.row.name || null);
    if (match) keep.add(match.row.name);
  }
  // Preserve a minimum of three complete recovery points when available,
  // including during first installation or after gaps in scheduled backups.
  for (const row of sorted) { if (keep.size >= Math.min(3, sorted.length)) break; keep.add(row.name); }
  return { keep: sorted.filter(row => keep.has(row.name)), remove: sorted.filter(row => !keep.has(row.name)), slots };
}
function owned(file, folderId) {
  return file?.id && !file.trashed && file.ownedByMe === true && file.parents?.includes(folderId)
    && file.appProperties?.indusApp === APP;
}
function safetyMetadata(file) {
  // Drive's version also changes for internal, non-content updates (e.g. a
  // freshly uploaded text sidecar). Compare content and deletion authority,
  // not that opaque counter. Date + size alone cannot prove equal content.
  return { id: file.id, name: file.name, size: file.size, md5Checksum: file.md5Checksum,
    ownedByMe: file.ownedByMe, trashed: Boolean(file.trashed),
    parents: [...(file.parents || [])].sort(), appProperties: Object.entries(file.appProperties || {}).sort() };
}
function signature(file) { return JSON.stringify(safetyMetadata(file)); }
async function freshFile(drive, folderId, file) {
  const fresh = (await drive.files.get({ fileId: file.id, fields: FIELDS })).data;
  const before = safetyMetadata(file), after = safetyMetadata(fresh);
  const changed = Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (!owned(fresh, folderId) || changed.length) throw new Error(`Drive kopija se je med preverjanjem spremenila: ${file.name} (polja: ${changed.join(", ") || "lastništvo/mesto"}).`);
  return fresh;
}
async function inventory(drive, folderId) {
  if (!/^[\w-]+$/.test(folderId || "")) throw new Error("Neveljavna mapa Drive kopij.");
  const files = [], groups = new Map(), ignored = [];
  let pageToken;
  do {
    const result = await drive.files.list({ q: `'${folderId}' in parents and trashed = false and appProperties has { key='indusApp' and value='${APP}' }`,
      fields: `nextPageToken,files(${FIELDS})`, pageSize: 1000, pageToken });
    files.push(...(result.data.files || [])); pageToken = result.data.nextPageToken;
  } while (pageToken);
  for (const file of files) {
    const p = file.appProperties || {};
    if (!owned(file, folderId) || ![ARCHIVE, CHECKSUM].includes(p.purpose) || !p.backupId) { ignored.push(file.id); continue; }
    if (!groups.has(p.backupId)) groups.set(p.backupId, []);
    groups.get(p.backupId).push(file);
  }
  const records = [], names = new Set();
  for (const [backupId, pair] of groups) {
    const archive = pair.find(f => f.appProperties.purpose === ARCHIVE);
    const checksum = pair.find(f => f.appProperties.purpose === CHECKSUM);
    if (pair.length !== 2 || !archive || !checksum || !Number.isFinite(archiveTime(archive.name))
        || checksum.name !== `${archive.name}.sha256` || !Number.isSafeInteger(Number(archive.size)) || Number(archive.size) <= 0
        || !Number.isSafeInteger(Number(checksum.size)) || Number(checksum.size) <= 0 || Number(checksum.size) > 4096
        || ![archive, checksum].every(f => /^[a-f0-9]{32}$/i.test(f.md5Checksum || "") && f.version)) {
      ignored.push(...pair.map(f => f.id)); continue;
    }
    if (names.has(archive.name)) throw new Error(`Podvojeno ime recovery kopije na Drivu: ${archive.name}.`);
    names.add(archive.name);
    const p = archive.appProperties;
    let deployment = null;
    if (p.deploymentRelease || p.deploymentSha256) {
      if (!/^[a-f0-9]{7,40}$/.test(p.deploymentRelease || "") || !/^[a-f0-9]{64}$/.test(p.deploymentSha256 || "")) throw new Error("Neveljavna Drive oznaka kopije pred objavo.");
      deployment = { release: p.deploymentRelease, sha256: p.deploymentSha256 };
    }
    records.push({ name: archive.name, time: archiveTime(archive.name), backupId, archive, checksum, deployment });
  }
  return { records, ignored };
}
async function readChecksum(drive, row) {
  const response = await drive.files.get({ fileId: row.checksum.id, alt: "media" }, { responseType: "text", maxContentLength: 4096 });
  const content = Buffer.from(String(response.data), "utf8");
  const match = content.toString("utf8").trim().match(/^([a-f0-9]{64})  (.+)$/i);
  if (content.length !== Number(row.checksum.size) || crypto.createHash("md5").update(content).digest("hex") !== row.checksum.md5Checksum.toLowerCase()
      || !match || match[2] !== row.name) throw new Error(`Neveljavna Drive kontrolna datoteka: ${row.name}.`);
  if (row.deployment && row.deployment.sha256 !== match[1].toLowerCase()) throw new Error(`Napačna Drive oznaka kopije pred objavo: ${row.name}.`);
  row.sha256 = match[1].toLowerCase();
}
async function eachLimited(rows, fn) {
  let cursor = 0;
  // Await every started request even when one fails; no unobserved writes.
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (cursor < rows.length) { const row = rows[cursor++]; await fn(row); }
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}
async function verifyDeleted(drive, fileId) {
  try { await drive.files.get({ fileId, fields: "id" }); }
  catch (error) {
    if (Number(error.code || error.response?.status) === 404) return;
    throw error;
  }
  throw new Error(`Drive ni potrdil trajnega izbrisa kopije: ${fileId}.`);
}
async function syncMarkers(drive, folderId, records, localMarkers, dryRun, requiredArchive) {
  // Deployment metadata is audit information, not extra off-site retention.
  // Old local checkpoints can outlive their remote copies. Only the exact
  // checkpoint requested by a deployment must still exist remotely.
  if (requiredArchive && (!localMarkers.some(m => m.archive === requiredArchive)
      || !records.some(r => r.name === requiredArchive))) throw new Error(`Zaščitena lokalna kopija nima preverjenega para na Drivu: ${requiredArchive}.`);
  const markers = localMarkers.filter(m => records.some(r => r.name === m.archive));
  // Validate the complete bootstrap before writing even the first marker.
  for (const marker of markers) {
    const row = records.find(r => r.name === marker.archive);
    if (!row || marker.sha256 !== row.sha256 || !/^[a-f0-9]{7,40}$/.test(marker.release)) throw new Error(`Zaščitena lokalna kopija nima preverjenega para na Drivu: ${marker.archive}.`);
    if (row.deployment && (row.deployment.release !== marker.release || row.deployment.sha256 !== marker.sha256)) throw new Error(`Nasprotujoča oznaka kopije pred objavo: ${row.name}.`);
  }
  for (const marker of markers) {
    const row = records.find(r => r.name === marker.archive);
    if (row.deployment) continue;
    if (!dryRun) {
      await freshFile(drive, folderId, row.archive);
      const appProperties = { ...row.archive.appProperties, deploymentRelease: marker.release, deploymentSha256: marker.sha256 };
      await drive.files.update({ fileId: row.archive.id, requestBody: { appProperties }, fields: "id" });
      const updated = (await drive.files.get({ fileId: row.archive.id, fields: FIELDS })).data;
      // Only the explicitly written app properties may change; the opaque
      // Drive version is deliberately excluded from all safety comparisons.
      if (!owned(updated, folderId) || signature({ ...updated, appProperties: row.archive.appProperties }) !== signature(row.archive)
          || updated.appProperties.deploymentRelease !== marker.release || updated.appProperties.deploymentSha256 !== marker.sha256) throw new Error("Drive ni potrdil zaščite kopije pred objavo.");
      row.archive = updated;
    }
    row.deployment = { release: marker.release, sha256: marker.sha256 };
  }
}
function checkProof(proof, folderId, now, kept) {
  if (!proof || proof.status !== "success" || !["localArchive", "driveSize", "driveMd5", "freshDriveRead", "restoreInstructions"].every(k => proof.verified?.[k] === true)
      || proof.driveFolderId !== folderId || !Number.isFinite(archiveTime(proof.recoveryFile)) || Math.abs(now - archiveTime(proof.recoveryFile)) > 6 * 3600000) throw new Error("Drive čiščenje zahteva novo, lokalno in oddaljeno preverjeno kopijo.");
  const row = kept.find(r => r.name === proof.recoveryFile);
  if (!row || row.archive.id !== proof.driveFileId || row.checksum.id !== proof.driveChecksumFileId || row.sha256 !== proof.sha256
      || Number(row.archive.size) !== proof.bytes || row.archive.md5Checksum !== proof.md5) throw new Error("Nova preverjena Drive kopija ni med ohranjenimi kopijami.");
}

async function manageDriveRetention(drive, folderId, { directory, verifiedBackup, now = Date.now(), policy = driveRetentionPolicy({}), dryRun = false, markOnly = false, requiredArchive, allowPermanentDelete = false } = {}) {
  validatePolicy(policy);
  return withDeploymentMarkers(directory, async markers => {
    const { records, ignored } = await inventory(drive, folderId);
    await eachLimited(records, row => readChecksum(drive, row));
    const plan = planDriveRetention(records, { now, policy });
    await syncMarkers(drive, folderId, records, markers, dryRun, requiredArchive);
    const result = { policy, kept: plan.keep.map(r => r.name), checkpoints: plan.keep.filter(r => r.deployment).map(r => r.name),
      slots: plan.slots, keptBytes: plan.keep.reduce((n, r) => n + Number(r.archive.size) + Number(r.checksum.size), 0),
      remove: plan.remove.map(r => r.name), removed: [], ignored, freedBytes: 0,
      removableBytes: plan.remove.reduce((n, r) => n + Number(r.archive.size) + Number(r.checksum.size), 0) };
    if (markOnly) return result;
    if (!dryRun) checkProof(verifiedBackup, folderId, now, plan.keep);
    // Check the entire inventory against fresh metadata before ANY deletion.
    await eachLimited(records, async row => { await freshFile(drive, folderId, row.archive); await freshFile(drive, folderId, row.checksum); });
    if (dryRun) return result;
    if (plan.remove.length && allowPermanentDelete !== true) throw new Error("Trajni izbris Drive kopij ni omogočen: BACKUP_OFFSITE_DELETE_APPROVED=true zahteva izrecno dovoljenje lastnika.");
    try {
      for (const row of plan.remove) {
        // Recheck just before deleting. Writers in this app share the PG and
        // local retention locks; external unexpected edits fail closed.
        await freshFile(drive, folderId, row.archive);
        await freshFile(drive, folderId, row.checksum);
        await drive.files.delete({ fileId: row.archive.id });
        await verifyDeleted(drive, row.archive.id);
        result.freedBytes += Number(row.archive.size);
        result.removed.push(row.name);
        await drive.files.delete({ fileId: row.checksum.id });
        await verifyDeleted(drive, row.checksum.id);
        result.freedBytes += Number(row.checksum.size);
      }
      // Confirm all retained pairs still match the verified preflight inventory.
      await eachLimited(plan.keep, async row => { await freshFile(drive, folderId, row.archive); await freshFile(drive, folderId, row.checksum); });
    } catch (error) {
      // Keep an audit of completed deletions even if a later request fails.
      error.driveRetention = result;
      throw error;
    }
    return result;
  });
}

module.exports = { driveRetentionPolicy, planDriveRetention, manageDriveRetention };
