"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { driveRetentionPolicy, manageDriveRetention } = require("../scripts/drive-backup-retention");
const { markDeploymentBackup } = require("../scripts/backup-retention");
const now = Date.parse("2026-10-07T12:00:00Z");
const name = stamp => `indus-ure-recovery-${stamp}.tar.gz`;
const hash = (algorithm, value) => crypto.createHash(algorithm).update(value).digest("hex");

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, "indus-drive-retention-"));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    assert.ok(path.basename(directory).startsWith("indus-drive-retention-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const files = new Map(), bodies = new Map(), deleted = [], updates = [];
  let serial = 0;
  const add = async (stamp, { local = false, checkpoint = false } = {}) => {
    const archiveName = name(stamp), archive = Buffer.from(archiveName), sha256 = hash("sha256", archive);
    const sidecar = `${sha256}  ${archiveName}\n`, backupId = `backup-${++serial}`;
    const ids = [];
    for (const [suffix, purpose, content] of [["", "recovery-backup", archive], [".sha256", "recovery-checksum", sidecar]]) {
      const id = `${backupId}${suffix ? "-checksum" : "-archive"}`;
      ids.push(id);
      const props = { indusApp: "indus-ure-v2", purpose, backupId };
      if (checkpoint && !suffix) Object.assign(props, { deploymentRelease: "123abcd", deploymentSha256: sha256 });
      files.set(id, { id, name: archiveName + suffix, size: String(Buffer.byteLength(content)), md5Checksum: hash("md5", content),
        ownedByMe: true, trashed: false, parents: ["backup-folder"], appProperties: props, version: "1" });
      bodies.set(id, String(content));
    }
    if (local) { await fs.writeFile(path.join(directory, archiveName), archive); await fs.writeFile(path.join(directory, archiveName + ".sha256"), sidecar); }
    return { status: "success", recoveryFile: archiveName, bytes: archive.length, md5: hash("md5", archive), sha256, driveFolderId: "backup-folder", driveFileId: ids[0], driveChecksumFileId: ids[1],
      verified: { localArchive: true, driveSize: true, driveMd5: true, freshDriveRead: true, restoreInstructions: true } };
  };
  const drive = { files: {
    async list({ pageToken }) { const all = [...files.values()], start = Number(pageToken || 0); return { data: { files: structuredClone(all.slice(start, start + 4)), nextPageToken: start + 4 < all.length ? String(start + 4) : undefined } }; },
    async get({ fileId, alt }) { if (!files.has(fileId)) throw new Error("not found"); return { data: alt === "media" ? bodies.get(fileId) : structuredClone(files.get(fileId)) }; },
    async update({ fileId, requestBody }) { updates.push(fileId); const f = files.get(fileId); Object.assign(f, structuredClone(requestBody), { version: String(Number(f.version) + 1) }); return { data: { id: fileId } }; },
    async delete({ fileId }) { deleted.push(fileId); files.delete(fileId); return {}; }
  } };
  const fresh = await add("20261007T110000Z", { local: true });
  await add("20261006T110000Z"); await add("20261005T110000Z");
  const old = await add("20261007T100000Z");
  const run = options => manageDriveRetention(drive, "backup-folder", { directory, now, verifiedBackup: fresh, ...options });
  return { directory, drive, files, bodies, deleted, updates, add, fresh, old, run };
}

test("Drive policy is 90 Ljubljana calendar days plus at least three deployment copies", () => {
  assert.deepEqual(driveRetentionPolicy({}), { dailyDays: 90, deploymentCopies: 3, timeZone: "Europe/Ljubljana" });
  for (const v of ["NaN", "", "29", "366", "90.1"]) assert.throws(() => driveRetentionPolicy({ BACKUP_OFFSITE_RETENTION_DAYS: v }));
  assert.throws(() => driveRetentionPolicy({ BACKUP_OFFSITE_DEPLOYMENT_COPIES: "2" }));
});

test("Drive preview paginates, never writes, and pruning removes only extra complete pairs", async t => {
  const f = await fixture(t);
  const preview = await f.run({ dryRun: true, verifiedBackup: undefined });
  assert.deepEqual(preview.remove, [f.old.recoveryFile]); assert.deepEqual(f.deleted, []); assert.deepEqual(f.updates, []);
  const result = await f.run();
  assert.deepEqual(result.removed, [f.old.recoveryFile]);
  assert.deepEqual(f.deleted, [f.old.driveFileId, f.old.driveChecksumFileId]);
  assert.equal(result.freedBytes, f.old.bytes + Buffer.byteLength(f.bodies.get(f.old.driveChecksumFileId)));
  assert.deepEqual((await f.run()).removed, []);
});

test("local checkpoint markers migrate to Drive and survive without the original local server", async t => {
  const f = await fixture(t);
  const protectedCopy = await f.add("20260301T100000Z", { local: true });
  await markDeploymentBackup(f.directory, { archive: protectedCopy.recoveryFile, release: "123abcd" });
  assert.ok((await f.run({ dryRun: true })).kept.includes(protectedCopy.recoveryFile)); assert.deepEqual(f.updates, []);
  await f.run({ markOnly: true, verifiedBackup: undefined });
  assert.deepEqual(f.deleted, []); assert.equal(f.updates.length, 1);
  await fs.unlink(path.join(f.directory, protectedCopy.recoveryFile + ".deployment.json"));
  assert.ok((await f.run()).kept.includes(protectedCopy.recoveryFile));
});

test("the fourth old checkpoint expires but one daily copy survives 90 calendar days", async t => {
  const f = await fixture(t);
  const checkpoints = [];
  for (const day of [1, 2, 3, 4]) checkpoints.push(await f.add(`2026030${day}T100000Z`, { checkpoint: true }));
  const boundary = await f.add("20260709T220000Z"), expired = await f.add("20260709T215959Z");
  const result = await f.run();
  assert.equal(result.checkpoints.length, 3);
  assert.ok(result.removed.includes(checkpoints[0].recoveryFile));
  assert.ok(result.kept.includes(boundary.recoveryFile)); assert.ok(result.removed.includes(expired.recoveryFile));
});

test("missing, stale or mismatching fresh backup proof prevents all Drive deletions", async t => {
  const f = await fixture(t);
  for (const proof of [undefined, { ...f.fresh, verified: {} }, { ...f.fresh, driveFolderId: "wrong" }, { ...f.fresh, md5: "0".repeat(32) },
    { ...f.fresh, sha256: "0".repeat(64) }, { ...f.fresh, driveFileId: f.old.driveFileId }, { ...f.fresh, recoveryFile: name("20261006T110000Z") }]) {
    await assert.rejects(f.run({ verifiedBackup: proof })); assert.deepEqual(f.deleted, []);
  }
});

test("foreign, malformed, incomplete and unknown files are left untouched", async t => {
  const f = await fixture(t);
  for (const stamp of ["20260101T100000Z", "20260102T100000Z", "20260103T100000Z", "20260104T100000Z"]) {
    const p = await f.add(stamp), file = f.files.get(p.driveFileId);
    if (stamp.includes("0101")) file.ownedByMe = false;
    if (stamp.includes("0102")) file.appProperties.indusApp = "another-app";
    if (stamp.includes("0103")) f.files.delete(p.driveChecksumFileId);
    if (stamp.includes("0104")) file.name = "manual-backup.tar.gz";
  }
  const result = await f.run(); assert.deepEqual(result.removed, [f.old.recoveryFile]); assert.equal(result.ignored.length, 7);
});

test("corrupt sidecars, checkpoint hashes, or a changed retained archive block the entire plan", async t => {
  const f = await fixture(t);
  const original = f.bodies.get(f.old.driveChecksumFileId);
  f.bodies.set(f.old.driveChecksumFileId, "corrupt");
  await assert.rejects(f.run(), /kontrolna/); assert.deepEqual(f.deleted, []);
  f.bodies.set(f.old.driveChecksumFileId, original);
  const props = f.files.get(f.old.driveFileId).appProperties;
  Object.assign(props, { deploymentRelease: "123abcd", deploymentSha256: "0".repeat(64) });
  await assert.rejects(f.run(), /oznaka/); assert.deepEqual(f.deleted, []);
  delete props.deploymentRelease; delete props.deploymentSha256;
  const get = f.drive.files.get;
  f.drive.files.get = async args => { const r = await get(args); if (args.fileId === f.fresh.driveFileId && !args.alt) r.data.md5Checksum = "0".repeat(32); return r; };
  await assert.rejects(f.run(), /spremenila.*md5Checksum/); assert.deepEqual(f.deleted, []);
});

test("Drive-only version changes, including a fresh SHA sidecar, do not invalidate intact backups", async t => {
  const f = await fixture(t), get = f.drive.files.get;
  f.drive.files.get = async args => {
    const response = await get(args);
    if (!args.alt) {
      const file = f.files.get(args.fileId);
      file.version = String(Number(file.version) + 1);
      response.data.version = file.version;
      response.data.appProperties = Object.fromEntries(Object.entries(file.appProperties).reverse());
    }
    return response;
  };
  const result = await f.run();
  assert.deepEqual(result.removed, [f.old.recoveryFile]);
  assert.ok(f.files.has(f.fresh.driveFileId));
  assert.ok(f.files.has(f.fresh.driveChecksumFileId));
});

test("content, identity, ownership, location and checkpoint changes still stop deletion", async t => {
  const mutations = {
    md5Checksum: file => { file.md5Checksum = "0".repeat(32); }, // same size!
    size: file => { file.size = String(Number(file.size) + 1); },
    id: file => { file.id = "other-file"; },
    name: file => { file.name += ".changed"; },
    ownedByMe: file => { file.ownedByMe = false; },
    parents: file => { file.parents = ["other-folder"]; },
    trashed: file => { file.trashed = true; },
    appProperties: file => { file.appProperties.deploymentRelease = "123abcd"; }
  };
  for (const [key, mutate] of Object.entries(mutations)) await t.test(key, async t => {
    const f = await fixture(t), get = f.drive.files.get;
    f.drive.files.get = async args => {
      const response = await get(args);
      if (args.fileId === f.old.driveFileId && !args.alt) mutate(response.data);
      return response;
    };
    await assert.rejects(f.run(), new RegExp(`spremenila.*${key}`));
    assert.deepEqual(f.deleted, []);
  });
});

test("a same-sized sidecar content change is rejected even when its Drive version also changes", async t => {
  const f = await fixture(t), get = f.drive.files.get;
  f.drive.files.get = async args => {
    const response = await get(args);
    if (args.fileId === f.fresh.driveChecksumFileId && !args.alt) {
      response.data.version = "4";
      response.data.md5Checksum = "0".repeat(32);
    }
    return response;
  };
  await assert.rejects(f.run(), /spremenila.*sha256.*md5Checksum/);
  assert.deepEqual(f.deleted, []);
});

test("deletion candidates are rechecked after preflight, not just once", async t => {
  const f = await fixture(t), get = f.drive.files.get;
  let reads = 0;
  f.drive.files.get = async args => {
    const response = await get(args);
    if (args.fileId === f.old.driveFileId && !args.alt && ++reads === 2) response.data.md5Checksum = "0".repeat(32);
    return response;
  };
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /md5Checksum/);
    assert.deepEqual(error.driveRetention.removed, []);
    return true;
  });
  assert.deepEqual(f.deleted, []);
});

test("lost local checkpoints and conflicting locks fail closed", async t => {
  const f = await fixture(t);
  await markDeploymentBackup(f.directory, { archive: f.fresh.recoveryFile, release: "123abcd" });
  f.files.delete(f.fresh.driveChecksumFileId);
  await assert.rejects(f.run(), /preverjenega para/); assert.deepEqual(f.deleted, []);
  await fs.mkdir(path.join(f.directory, ".retention-lock"));
  await assert.rejects(f.run(), { code: "EEXIST" }); assert.deepEqual(f.deleted, []);
});

test("partial deletion failures preserve progress and never prune an incomplete pair on retry", async t => {
  const f = await fixture(t);
  const remove = f.drive.files.delete;
  f.drive.files.delete = async arg => { if (arg.fileId === f.old.driveChecksumFileId) throw new Error("network"); return remove(arg); };
  await assert.rejects(f.run(), error => { assert.deepEqual(error.driveRetention.removed, [f.old.recoveryFile]); assert.equal(error.driveRetention.freedBytes, f.old.bytes); return true; });
  f.drive.files.delete = remove;
  const retry = await f.run(); assert.deepEqual(retry.removed, []); assert.ok(retry.ignored.includes(f.old.driveChecksumFileId));
});

test("a fourth local checkpoint already removed remotely does not block safe retries", async t => {
  const f = await fixture(t), checkpoints = [];
  for (const day of [1, 2, 3, 4]) {
    const p = await f.add(`2026030${day}T100000Z`, { local: true }); checkpoints.push(p);
    await markDeploymentBackup(f.directory, { archive: p.recoveryFile, release: "123abcd" });
  }
  f.files.delete(checkpoints[0].driveFileId); f.files.delete(checkpoints[0].driveChecksumFileId);
  const result = await f.run();
  assert.equal(result.checkpoints.length, 3);
  for (const p of checkpoints.slice(1)) assert.ok(result.kept.includes(p.recoveryFile));
});
