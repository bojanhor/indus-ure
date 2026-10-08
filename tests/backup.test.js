"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { dumpConsistentDatabase } = require("../scripts/backup-indus-ure");
const { installRestoredMedia } = require("../outputs/server");
const { runBackupRetention, backupCleanupIssue } = require("../outputs/backup-status");

function verifiedBackup() {
  return { status: "success", recoveryFile: "verified.tar.gz", bytes: 123, sha256: "original-sha",
    verified: { localArchive: true, driveSize: true, driveMd5: true, freshDriveRead: true, restoreInstructions: true } };
}

test("successful cleanup records both outcomes without a warning", async () => {
  const result = verifiedBackup(), steps = [];
  await runBackupRetention(result, {
    drive: async () => { steps.push("drive"); return { removed: ["old"], freedBytes: 12 }; },
    local: async () => { steps.push("local"); return { removed: [], freedBytes: 0 }; }
  });
  assert.deepEqual(steps, ["drive", "local"]);
  assert.equal(result.status, "success");
  assert.equal(result.cleanupStatus, "success");
  assert.equal(result.driveRetention.status, "success");
  assert.equal(result.localRetention.status, "success");
  assert.equal(backupCleanupIssue(result), null);
});

test("Drive cleanup failure preserves backup proof and partial progress, skips local deletion and warns separately", async () => {
  const result = verifiedBackup(), proof = structuredClone(result);
  const error = Object.assign(new Error("Drive unavailable"), { driveRetention: { removed: ["old"], freedBytes: 12 } });
  await runBackupRetention(result, {
    drive: async () => { throw error; },
    local: async () => assert.fail("Local deletion must not run")
  });
  for (const key of Object.keys(proof)) assert.deepEqual(result[key], proof[key]);
  assert.equal(result.cleanupStatus, "warning");
  assert.equal(result.driveRetention.status, "failed");
  assert.deepEqual(result.driveRetention.removed, ["old"]);
  assert.equal(result.driveRetention.freedBytes, 12);
  assert.equal(result.localRetention.status, "skipped");
  const issue = backupCleanupIssue(result);
  assert.equal(issue.code, "backup-cleanup-failed");
  assert.equal(issue.severity, "warning");
  assert.match(issue.title, /Kopija je uspela/);
  assert.match(issue.message, /Drive unavailable/);
});

test("local cleanup failure preserves the successful off-site copy and cleanup result", async () => {
  const result = verifiedBackup();
  await runBackupRetention(result, {
    drive: async () => ({ removed: ["old"], freedBytes: 12 }),
    local: async () => { throw new Error("local lock"); }
  });
  assert.equal(result.status, "success");
  assert.equal(result.driveRetention.status, "success");
  assert.equal(result.localRetention.status, "failed");
  assert.match(backupCleanupIssue(result).message, /Lokalno: local lock/);
});

test("unverified or failed backups never run cleanup or masquerade as cleanup warnings", async () => {
  for (const result of [{ status: "failed" }, { ...verifiedBackup(), verified: { driveSize: true } }]) {
    await assert.rejects(runBackupRetention(result, {
      drive: async () => assert.fail("No cleanup before verification"),
      local: async () => assert.fail("No cleanup before verification")
    }), /uspešno preverjeno/);
  }
  assert.equal(backupCleanupIssue({ status: "failed", cleanupStatus: "warning" }), null);
  assert.equal(backupCleanupIssue({ status: "success" }), null); // legacy records
});

test("browser restore retains live media and rejects conflicting immutable content", async () => {
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "indus-restore-test-"));
  try {
    const stage = path.join(root, "stage"), live = path.join(root, "live");
    fs.mkdirSync(stage); fs.mkdirSync(live);
    fs.writeFileSync(path.join(stage, "restored.bin"), "restored");
    fs.writeFileSync(path.join(live, "concurrent.bin"), "concurrent");
    const db = { attachments: { a: { storageKey: "restored.bin" } } };
    await installRestoredMedia(db, stage, live);
    await installRestoredMedia(db, stage, live);
    assert.equal(fs.readFileSync(path.join(live, "concurrent.bin"), "utf8"), "concurrent");
    fs.unlinkSync(path.join(stage, "restored.bin"));
    fs.writeFileSync(path.join(stage, "restored.bin"), "conflicting");
    await assert.rejects(installRestoredMedia(db, stage, live), /drugačno vsebino/);
    assert.equal(fs.readFileSync(path.join(live, "restored.bin"), "utf8"), "restored");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recovery dump and sanitized rows share one exported PostgreSQL snapshot", async () => {
  const steps = [];
  const client = { query: async sql => { steps.push(sql); return { rows: [{ snapshot: "qa-snapshot" }] }; }, release: () => steps.push("release") };
  await dumpConsistentDatabase({ connect: async () => client }, "work", "dump", "state", {
    dump: async (work, dest, snapshot) => { assert.equal(snapshot, "qa-snapshot"); steps.push("dump"); },
    writeState: async connection => { assert.equal(connection, client); steps.push("state"); }
  });
  assert.deepEqual(steps, ["begin isolation level repeatable read read only", "select pg_export_snapshot() as snapshot", "dump", "state", "commit", "release"]);
});

test("a failed recovery dump releases its transaction without publishing metadata", async () => {
  const steps = [];
  const client = { query: async sql => { steps.push(sql); return { rows: [{ snapshot: "qa" }] }; }, release: () => steps.push("release") };
  await assert.rejects(dumpConsistentDatabase({ connect: async () => client }, "work", "dump", "state", {
    dump: async () => { throw new Error("failed dump"); }, writeState: async () => { throw new Error("must not run"); }
  }), /failed dump/);
  assert.deepEqual(steps.slice(-2), ["rollback", "release"]);
});

test("recovery guide makes dump readable and restores with the application role", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "backup-indus-ure.js"), "utf8");
  assert.match(source, /chmod 0644 restore\/database\.dump restore\/sanitized-state\.sql/);
  assert.match(source, /pg_restore --no-owner --no-acl --role=indus_ure -d indus_ure restore\/database\.dump/);
  assert.match(source, /apt-get install -y libvips-tools libheif-examples/);
  const deployGuide = fs.readFileSync(path.join(__dirname, "..", "DEPLOY-UBUNTU.md"), "utf8");
  assert.match(deployGuide, /libvips-tools libheif-examples/);
});
