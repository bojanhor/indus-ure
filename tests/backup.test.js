"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { dumpConsistentDatabase } = require("../scripts/backup-indus-ure");
const { installRestoredMedia } = require("../outputs/server");

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
