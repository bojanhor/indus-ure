"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { retentionPolicy, archiveTime, planRetention, inspectRetention, retainLocal, markDeploymentBackup } = require("../scripts/backup-retention");
const { backupDirectoryFromEnvironmentFile } = require("../scripts/mark-backup-deployment");
const now = Date.parse("2026-09-23T12:00:00Z");
const name = stamp => `indus-ure-recovery-${stamp}.tar.gz`;
const row = (stamp, deployment = false) => ({ name: name(stamp), time: archiveTime(name(stamp)), deployment });

test("retention keeps seven local calendar days plus three real deployment checkpoints", () => {
  const records = [
    ...Array.from({ length: 12 }, (_, i) => row(`202609${String(23 - i).padStart(2, "0")}T110000Z`)),
    row("20260923T100000Z"), row("20260922T100000Z"),
    row("20260911T100000Z", true), row("20260910T100000Z", true),
    row("20260909T100000Z", true), row("20260908T100000Z", true)
  ];
  const plan = planRetention(records, { now });
  assert.equal(plan.keep.length, 10);
  assert.ok(plan.keep.some(r => r.name === name("20260917T110000Z")));
  assert.ok(plan.remove.some(r => r.name === name("20260916T110000Z")));
  assert.ok(plan.remove.some(r => r.name === name("20260923T100000Z")));
  assert.deepEqual(plan.keep.filter(r => r.deployment).map(r => r.name), ["20260911T100000Z", "20260910T100000Z", "20260909T100000Z"].map(name));
});

test("retention uses Ljubljana midnight and calendar days across DST", () => {
  const summer = planRetention([row("20260916T220000Z"), row("20260916T215959Z"), row("20260923T000000Z"), row("20260922T000000Z"), row("20260921T000000Z")], { now });
  assert.ok(summer.keep.some(r => r.name === name("20260916T220000Z")));
  assert.ok(summer.remove.some(r => r.name === name("20260916T215959Z")));
  const winter = planRetention([row("20261024T220000Z"), row("20261024T215959Z"), row("20261031T120000Z"), row("20261030T120000Z"), row("20261029T120000Z")], { now: Date.parse("2026-10-31T14:00:00Z") });
  assert.ok(winter.keep.some(r => r.name === name("20261024T220000Z")));
  assert.ok(winter.remove.some(r => r.name === name("20261024T215959Z")));
});

test("retention keeps a three-copy safety floor and future-dated archives", () => {
  assert.equal(planRetention([row("20260901T010000Z"), row("20260901T020000Z")], { now }).remove.length, 0);
  assert.equal(planRetention([1, 2, 3, 4].map(i => row(`20260901T0${i}0000Z`)), { now }).keep.length, 3);
  assert.ok(planRetention([row("20260924T010000Z")], { now }).keep.length === 1);
});

test("retention rejects invalid settings and malformed archive dates", () => {
  assert.deepEqual(retentionPolicy({}), { dailyDays: 7, deploymentCopies: 3, timeZone: "Europe/Ljubljana" });
  for (const value of ["bad", "", "0", "6", "7.5", "Infinity"]) assert.throws(() => retentionPolicy({ BACKUP_LOCAL_RETENTION_DAYS: value }));
  assert.throws(() => retentionPolicy({ BACKUP_LOCAL_DEPLOYMENT_COPIES: "2" }));
  assert.throws(() => planRetention([], { policy: { dailyDays: 0, deploymentCopies: 0, timeZone: "Europe/Ljubljana" } }));
  for (const value of ["../outside.tar.gz", name("20260230T120000Z"), name("20260923T250000Z")]) assert.ok(Number.isNaN(archiveTime(value)));
});

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, "indus-retention-test-"));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), temporaryRoot);
    assert.ok(path.basename(root).startsWith("indus-retention-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const make = async stamp => {
    const file = name(stamp), data = Buffer.from(`archive:${file}`), checksum = crypto.createHash("sha256").update(data).digest("hex");
    await fs.writeFile(path.join(root, file), data);
    await fs.writeFile(path.join(root, file + ".sha256"), `${checksum}  ${file}\n`);
    return { recoveryFile: file, sha256: checksum, bytes: data.length, status: "success", driveFileId: "verified-drive-archive", driveChecksumFileId: "verified-drive-checksum", verified: { localArchive: true, driveSize: true, driveMd5: true, freshDriveRead: true, restoreInstructions: true } };
  };
  const fresh = await make("20260923T110000Z");
  await make("20260922T110000Z"); await make("20260921T110000Z");
  const old = await make("20260801T110000Z");
  return { root, make, fresh, old };
}

test("local pruning requires fresh verified offsite proof and deletes only complete known pairs", async t => {
  const { root, fresh, old } = await fixture(t);
  await fs.writeFile(path.join(root, "manual.dump"), "leave alone");
  await fs.writeFile(path.join(root, name("20260802T110000Z")), "unfinished");
  await fs.mkdir(path.join(root, name("20260803T110000Z")));
  const before = (await fs.readdir(root)).sort();
  for (const proof of [undefined, { ...fresh, status: "failed" }, { ...fresh, verified: {} }, { ...fresh, sha256: "0".repeat(64) }, { ...fresh, bytes: 1 }, old]) {
    await assert.rejects(retainLocal(root, { verifiedBackup: proof, now }));
    assert.deepEqual((await fs.readdir(root)).sort(), before);
  }
  const preview = await inspectRetention(root, { now });
  assert.deepEqual(preview.remove, [old.recoveryFile]);
  assert.deepEqual((await fs.readdir(root)).sort(), before, "preview never mutates files");
  const result = await retainLocal(root, { verifiedBackup: fresh, now });
  assert.deepEqual(result.removed, [old.recoveryFile]);
  assert.equal(result.freedBytes, old.bytes);
  await assert.rejects(fs.stat(path.join(root, old.recoveryFile)), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(root, old.recoveryFile + ".sha256")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(root, "manual.dump"), "utf8"), "leave alone");
  assert.equal(result.ignored.length, 2);
  assert.deepEqual((await retainLocal(root, { verifiedBackup: fresh, now })).removed, [], "repeat is idempotent");
});

test("a corrupt retained archive prevents every deletion", async t => {
  const { root, fresh, old } = await fixture(t);
  await fs.writeFile(path.join(root, name("20260922T110000Z")), "corrupt");
  const before = (await fs.readdir(root)).sort();
  await assert.rejects(retainLocal(root, { verifiedBackup: fresh, now }), /SHA-256/);
  assert.deepEqual((await fs.readdir(root)).sort(), before);
  assert.ok(await fs.stat(path.join(root, old.recoveryFile)));
});

test("deployment marking survives daily retention and the fourth oldest checkpoint expires", async t => {
  const { root, make, fresh, old } = await fixture(t);
  const checkpoints = [old];
  for (const day of [2, 3, 4]) checkpoints.push(await make(`2026080${day}T110000Z`));
  for (const copy of checkpoints) await markDeploymentBackup(root, { release: "00dee4c", archive: copy.recoveryFile });
  const result = await retainLocal(root, { verifiedBackup: fresh, now });
  assert.deepEqual(result.removed, [old.recoveryFile]);
  await assert.rejects(fs.stat(path.join(root, old.recoveryFile + ".deployment.json")), { code: "ENOENT" });
  for (const copy of checkpoints.slice(1)) assert.ok(result.kept.includes(copy.recoveryFile));
});

test("deployment marking selects a newly completed backup, validates its hash and rejects traversal", async t => {
  const { root, fresh } = await fixture(t);
  const mark = await markDeploymentBackup(root, { release: "00dee4c", notBefore: Date.now() - 60000 });
  assert.equal(mark.archive, fresh.recoveryFile);
  await assert.rejects(markDeploymentBackup(root, { release: "00dee4c", notBefore: Date.now() + 60000 }));
  await assert.rejects(markDeploymentBackup(root, { release: "00dee4c", archive: "../outside" }));
  await assert.rejects(markDeploymentBackup(root, { release: "unknown" }));
  await fs.writeFile(path.join(root, fresh.recoveryFile), "corrupt");
  await assert.rejects(markDeploymentBackup(root, { release: "00dee4c", archive: fresh.recoveryFile }), /kontrolne vsote/);
});

test("a conflicting retention lock or corrupt deployment marker never permits pruning", async t => {
  const { root, fresh } = await fixture(t);
  const lock = path.join(root, ".retention-lock");
  await fs.mkdir(lock);
  await assert.rejects(retainLocal(root, { verifiedBackup: fresh, now }), { code: "EEXIST" });
  await assert.rejects(markDeploymentBackup(root, { release: "00dee4c" }), { code: "EEXIST" });
  assert.ok((await fs.stat(lock)).isDirectory(), "another process's lock is not removed");
  await fs.rmdir(lock);
  await fs.writeFile(path.join(root, fresh.recoveryFile + ".deployment.json"), "{}");
  await assert.rejects(retainLocal(root, { verifiedBackup: fresh, now }), /oznaka/);
});

test("symlinked backup directories and checksum files are refused", { skip: process.platform === "win32" && "Windows symlink creation requires a privilege; mandatory Linux release tests cover this" }, async t => {
  const { root, fresh, old } = await fixture(t);
  const link = root + "-link";
  t.after(() => fs.unlink(link).catch(() => {}));
  await fs.symlink(root, link);
  await assert.rejects(retainLocal(link, { verifiedBackup: fresh, now }), /Nevarna mapa/);
  await fs.unlink(path.join(root, old.recoveryFile + ".sha256"));
  await fs.symlink(path.join(root, fresh.recoveryFile + ".sha256"), path.join(root, old.recoveryFile + ".sha256"));
  await assert.rejects(retainLocal(root, { verifiedBackup: fresh, now }), /Nevarna datoteka/);
  assert.ok(await fs.stat(path.join(root, old.recoveryFile)));
});

test("deployment helper reads only the backup directory setting and deployment gates marking after success", async t => {
  const { root } = await fixture(t);
  const env = path.join(root, "test.env");
  await fs.writeFile(env, 'NOT_NEEDED=private\nBACKUP_DIR="/var/backups/indus-ure/offsite"\n');
  assert.equal(backupDirectoryFromEnvironmentFile(env), "/var/backups/indus-ure/offsite");
  await fs.writeFile(env, 'BACKUP_DIR=/one\nBACKUP_DIR=/two\n');
  assert.throws(() => backupDirectoryFromEnvironmentFile(env));
  const deploy = await fs.readFile(path.join(__dirname, "../scripts/server/deploy-indus-ure"), "utf8");
  assert.match(deploy, /flock -n 9/);
  assert.ok(deploy.indexOf('== success ]]') < deploy.indexOf('scripts/mark-backup-deployment.js'));
  assert.match(deploy, /checkpoint_tool="\$current\/scripts\/mark-backup-deployment\.js"/);
  const backup = await fs.readFile(path.join(__dirname, "../scripts/backup-indus-ure.js"), "utf8");
  assert.ok(backup.indexOf('verifyDrive(drive, folderId, archive') < backup.indexOf('await retainLocal(BACKUP_DIR'));
  assert.match(backup, /pg_try_advisory_lock/);
});
