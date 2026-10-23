"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { driveRetentionPolicy, planDriveRetention, manageDriveRetention } = require("../scripts/drive-backup-retention");
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
    async get({ fileId, alt }) { if (!files.has(fileId)) throw Object.assign(new Error("not found"), { code: 404 }); return { data: alt === "media" ? bodies.get(fileId) : structuredClone(files.get(fileId)) }; },
    async update({ fileId, requestBody }) { updates.push(fileId); const f = files.get(fileId); Object.assign(f, structuredClone(requestBody), { version: String(Number(f.version) + 1) }); return { data: { id: fileId } }; },
    async delete({ fileId }) { deleted.push(fileId); files.delete(fileId); return {}; }
  } };
  const fresh = await add("20261007T110000Z", { local: true });
  await add("20261006T110000Z"); await add("20261005T110000Z");
  const old = await add("20261007T100000Z");
  const run = options => manageDriveRetention(drive, "backup-folder", { directory, now, verifiedBackup: fresh, allowPermanentDelete: true, ...options });
  return { directory, drive, files, bodies, deleted, updates, add, fresh, old, run };
}

test("compact Drive policy caps three daily and four completed weeks without extra deployments", () => {
  assert.deepEqual(driveRetentionPolicy({}), { mode: "daily3-weekly4-v1", dailyDays: 3, weeklyCopies: 4,
    deploymentCopies: 0, timeZone: "Europe/Ljubljana" });
  assert.deepEqual(driveRetentionPolicy({ BACKUP_OFFSITE_RETENTION_DAYS: "90", BACKUP_OFFSITE_DEPLOYMENT_COPIES: "3" }), driveRetentionPolicy({}));
  assert.throws(() => driveRetentionPolicy({ BACKUP_OFFSITE_RETENTION_MODE: "unknown" }));
  assert.throws(() => planDriveRetention([], { policy: { ...driveRetentionPolicy({}), dailyDays: 90 } }));
});

function record(iso, deployment = null) {
  return { name: name(new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.000Z$/, "Z")), time: Date.parse(iso), deployment };
}
test("each daily slot keeps only its latest copy; historical slots share copies and checkpoints expire", () => {
  const records = Array.from({ length: 100 }, (_, i) => record(new Date(Date.parse("2026-10-23T10:00:00Z") - i * 86400000).toISOString(), { release: "123abcd" }));
  records.push(record("2026-10-23T08:00:00Z"));
  const plan = planDriveRetention(records, { now: Date.parse("2026-10-23T12:00:00Z") });
  assert.ok(plan.keep.length <= 7);
  assert.deepEqual(plan.slots.daily, ["20261023", "20261022", "20261021"].map(d => name(d + "T100000Z")));
  assert.deepEqual(plan.slots.weekly, ["20261018", "20261011", "20261004", "20260927"].map(d => name(d + "T100000Z")));
  assert.equal(plan.keep.length, 7);
});

test("rotation remains correct after daily pruning for two years, including DST/leap/month/year boundaries", () => {
  let retained = [];
  const history = [];
  const start = Date.parse("2027-01-01T10:00:00Z");
  for (let day = 0; day < 760; day++) {
    // Miss a few scheduled backups, and occasionally publish twice a day.
    if (day % 47 === 23) continue;
    const time = start + day * 86400000;
    const additions = [record(new Date(time).toISOString())];
    if (day % 5 === 0) additions.push(record(new Date(time + 3600000).toISOString()));
    history.push(...additions);
    const options = { now: time + 7200000 };
    const compact = planDriveRetention([...retained, ...additions], options);
    const unlimited = planDriveRetention(history, options);
    assert.deepEqual(compact.slots, unlimited.slots, `lost a rotation candidate on day ${day}`);
    assert.ok(compact.keep.length <= 7, `too many backups on day ${day}`);
    assert.ok(compact.keep.some(row => row.name === additions.at(-1).name));
    retained = compact.keep;
  }
});

test("Ljubljana date boundaries, sparse history and future clock safety", () => {
  const records = ["2026-10-24T22:30:00Z", "2026-10-24T20:00:00Z", "2026-10-23T20:00:00Z", "2026-09-30T10:00:00Z"].map(iso => record(iso));
  const options = { now: Date.parse("2026-10-25T12:00:00Z") };
  const plan = planDriveRetention(records, options);
  assert.equal(plan.slots.daily.length, 3);
  assert.ok(plan.keep.some(r => r.name === records[3].name));
  assert.throws(() => planDriveRetention([...records, record("2026-10-26T10:00:00Z")], options), /prihodnosti/);
  assert.throws(() => planDriveRetention(records, { now: NaN }), /neveljaven/);
  assert.equal(planDriveRetention(records.slice(0, 2), options).keep.length, 2);
});

test("daily and weekly copies overlap on Monday and Tuesday, week three becomes week four", () => {
  const history = Array.from({ length: 50 }, (_, i) => record(new Date(Date.parse("2026-10-26T10:00:00Z") - i * 86400000).toISOString()));
  const monday = planDriveRetention(history, { now: Date.parse("2026-10-26T12:00:00Z") });
  assert.equal(monday.keep.length, 6);
  assert.equal(monday.slots.weekly[0], monday.slots.daily[1]);
  const previous = planDriveRetention(history.filter(r => r.time < Date.parse("2026-10-26")), { now: Date.parse("2026-10-25T12:00:00Z") });
  assert.equal(previous.slots.weekly[2], monday.slots.weekly[3]);
  assert.ok(monday.remove.some(r => r.name === previous.slots.weekly[3]));
});

test("rotation survives missed weeks and long outages without inventing weekly copies", () => {
  const history = []; let retained = [];
  for (let day = 0; day < 500; day++) {
    if (day % 91 >= 52 && day % 91 <= 82) continue;
    const time = Date.parse("2026-01-01T10:00:00Z") + day * 86400000;
    const addition = record(new Date(time).toISOString()); history.push(addition);
    const options = { now: time + 3600000 };
    const plan = planDriveRetention([...retained, addition], options);
    assert.deepEqual(plan.slots, planDriveRetention(history, options).slots, `day ${day}`);
    assert.ok(plan.keep.length <= 7);
    assert.ok(plan.keep.length >= Math.min(3, history.length));
    retained = plan.keep;
  }
});

test("permanent Drive deletion needs explicit opt-in, preview still works without it", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ allowPermanentDelete: false }), /izrecno dovoljenje/);
  assert.deepEqual(f.deleted, []);
  assert.ok((await f.run({ allowPermanentDelete: false, dryRun: true })).remove.length);
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

test("deployment markers remain auditable but do not extend compact off-site retention", async t => {
  const f = await fixture(t);
  const protectedCopy = await f.add("20260301T100000Z", { local: true });
  await f.add("20261004T100000Z"); await f.add("20260930T100000Z"); await f.add("20260927T100000Z");
  await markDeploymentBackup(f.directory, { archive: protectedCopy.recoveryFile, release: "123abcd" });
  assert.ok((await f.run({ dryRun: true })).remove.includes(protectedCopy.recoveryFile)); assert.deepEqual(f.updates, []);
  await f.run({ markOnly: true, requiredArchive: protectedCopy.recoveryFile, verifiedBackup: undefined });
  assert.deepEqual(f.deleted, []); assert.equal(f.updates.length, 1);
  await fs.unlink(path.join(f.directory, protectedCopy.recoveryFile + ".deployment.json"));
  assert.ok((await f.run()).removed.includes(protectedCopy.recoveryFile));
});

test("all old deployment checkpoints expire unless selected by a calendar slot", async t => {
  const f = await fixture(t);
  const checkpoints = [];
  for (const day of [1, 2, 3, 4]) checkpoints.push(await f.add(`2026030${day}T100000Z`, { checkpoint: true }));
  const weekly = await f.add("20261004T100000Z"), extra = await f.add("20260930T100000Z");
  const olderWeek = await f.add("20260927T100000Z");
  const result = await f.run();
  assert.equal(result.checkpoints.length, 0);
  for (const p of checkpoints) assert.ok(result.removed.includes(p.recoveryFile));
  assert.ok(result.kept.includes(weekly.recoveryFile)); assert.ok(result.kept.includes(olderWeek.recoveryFile));
  assert.ok(result.removed.includes(extra.recoveryFile));
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

test("latest readable CSV files are never candidates for backup retention", async t => {
  const f = await fixture(t);
  for (const name of ["dogodki.csv", "vpisi-ur.csv"]) {
    f.files.set(name, { id: name, name, parents: ["backup-folder"], ownedByMe: true, trashed: false,
      appProperties: { indusApp: "indus-ure-v2", purpose: `recovery-latest-${name}`, backupId: "old-backup" } });
  }
  const result = await f.run();
  for (const name of ["dogodki.csv", "vpisi-ur.csv"]) {
    assert.ok(result.ignored.includes(name)); assert.ok(f.files.has(name)); assert.ok(!f.deleted.includes(name));
  }
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
  await assert.rejects(f.run({ markOnly: true, requiredArchive: f.fresh.recoveryFile }), /preverjenega para/); assert.deepEqual(f.deleted, []);
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

test("successful delete response without an absent file fails verification", async t => {
  const f = await fixture(t);
  f.drive.files.delete = async () => ({});
  await assert.rejects(f.run(), /ni potrdil trajnega izbrisa/);
  assert.ok(f.files.has(f.old.driveChecksumFileId));
});

test("retained pairs are freshly verified again after deletion", async t => {
  const f = await fixture(t), remove = f.drive.files.delete;
  f.drive.files.delete = async args => {
    const result = await remove(args);
    f.files.get(f.fresh.driveFileId).md5Checksum = "0".repeat(32);
    return result;
  };
  await assert.rejects(f.run(), /spremenila.*md5Checksum/);
});

test("expired local checkpoints missing remotely do not block the next backup", async t => {
  const f = await fixture(t), checkpoints = [];
  for (const day of [1, 2, 3, 4]) {
    const p = await f.add(`2026030${day}T100000Z`, { local: true }); checkpoints.push(p);
    await markDeploymentBackup(f.directory, { archive: p.recoveryFile, release: "123abcd" });
  }
  f.files.delete(checkpoints[0].driveFileId); f.files.delete(checkpoints[0].driveChecksumFileId);
  await f.add("20261004T100000Z"); await f.add("20260930T100000Z"); await f.add("20260927T100000Z");
  const result = await f.run();
  assert.equal(result.checkpoints.length, 0);
  for (const p of checkpoints.slice(1)) assert.ok(result.removed.includes(p.recoveryFile));
  assert.deepEqual((await f.run()).removed, []);
});
