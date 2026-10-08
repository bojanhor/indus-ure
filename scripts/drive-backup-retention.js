"use strict";

const crypto = require("node:crypto");
const { archiveTime, planRetention, withDeploymentMarkers } = require("./backup-retention");
const APP = "indus-ure-v2";
const ARCHIVE = "recovery-backup", CHECKSUM = "recovery-checksum";
const FIELDS = "id,name,size,md5Checksum,parents,trashed,ownedByMe,appProperties,version";

function driveRetentionPolicy(env = process.env) {
  const integer = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Neveljavna nastavitev ${key}.`);
    return n;
  };
  return { dailyDays: integer("BACKUP_OFFSITE_RETENTION_DAYS", 90, 30, 365),
    deploymentCopies: integer("BACKUP_OFFSITE_DEPLOYMENT_COPIES", 3, 3, 100), timeZone: "Europe/Ljubljana" };
}
function validatePolicy(policy) {
  driveRetentionPolicy({ BACKUP_OFFSITE_RETENTION_DAYS: policy.dailyDays, BACKUP_OFFSITE_DEPLOYMENT_COPIES: policy.deploymentCopies });
  if (policy.timeZone !== "Europe/Ljubljana") throw new Error("Neveljaven časovni pas hrambe kopij.");
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
async function syncMarkers(drive, folderId, records, localMarkers, dryRun, deploymentCopies) {
  const checkpointNames = new Set([...records.filter(r => r.deployment).map(r => r.name), ...localMarkers.map(m => m.archive)]);
  const required = new Set([...checkpointNames].sort((a, b) => archiveTime(b) - archiveTime(a)).slice(0, deploymentCopies));
  // An interrupted previous cleanup may already have removed an obsolete
  // fourth checkpoint remotely but not locally. It must not block the next
  // run; a missing REQUIRED checkpoint always does.
  const markers = localMarkers.filter(m => required.has(m.archive));
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

async function manageDriveRetention(drive, folderId, { directory, verifiedBackup, now = Date.now(), policy = driveRetentionPolicy({}), dryRun = false, markOnly = false } = {}) {
  validatePolicy(policy);
  return withDeploymentMarkers(directory, async markers => {
    const { records, ignored } = await inventory(drive, folderId);
    await eachLimited(records, row => readChecksum(drive, row));
    await syncMarkers(drive, folderId, records, markers, dryRun, policy.deploymentCopies);
    const plan = planRetention(records, { now, policy });
    const result = { policy, kept: plan.keep.map(r => r.name), checkpoints: plan.keep.filter(r => r.deployment).map(r => r.name),
      remove: plan.remove.map(r => r.name), removed: [], ignored, freedBytes: 0,
      removableBytes: plan.remove.reduce((n, r) => n + Number(r.archive.size) + Number(r.checksum.size), 0) };
    if (markOnly) return result;
    if (!dryRun) checkProof(verifiedBackup, folderId, now, plan.keep);
    // Check the entire inventory against fresh metadata before ANY deletion.
    await eachLimited(records, async row => { await freshFile(drive, folderId, row.archive); await freshFile(drive, folderId, row.checksum); });
    if (dryRun) return result;
    try {
      for (const row of plan.remove) {
        // Recheck just before deleting. Writers in this app share the PG and
        // local retention locks; external unexpected edits fail closed.
        await freshFile(drive, folderId, row.archive);
        await freshFile(drive, folderId, row.checksum);
        await drive.files.delete({ fileId: row.archive.id });
        result.freedBytes += Number(row.archive.size);
        result.removed.push(row.name);
        await drive.files.delete({ fileId: row.checksum.id });
        result.freedBytes += Number(row.checksum.size);
      }
    } catch (error) {
      // Keep an audit of completed deletions even if a later request fails.
      error.driveRetention = result;
      throw error;
    }
    return result;
  });
}

module.exports = { driveRetentionPolicy, manageDriveRetention };
