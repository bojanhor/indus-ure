"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { dumpConsistentDatabase, upsertReadableCsv } = require("../scripts/backup-indus-ure");
const { renderReadableCsv, durationMinutes, STATUS_LABELS } = require("../scripts/backup-readable-csv");
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
  await runBackupRetention(result, { drive: async () => ({ removed: [] }), local: async () => ({ removed: [] }) });
  assert.equal(result.cleanupStatus, "success");
  assert.equal(result.localRetention.status, "success");
  assert.equal(backupCleanupIssue(result), null);
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
    writeState: async connection => { assert.equal(connection, client); steps.push("state"); },
    writeCsv: async connection => { assert.equal(connection, client); steps.push("csv"); return []; }
  });
  assert.deepEqual(steps, ["begin isolation level repeatable read read only", "select pg_export_snapshot() as snapshot", "dump", "state", "csv", "commit", "release"]);
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

function parseCsv(content) {
  assert.ok(content.startsWith("\uFEFF"));
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 1; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      if (quoted && content[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ";") { row.push(field); field = ""; }
    else if (!quoted && c === "\r" && content[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; }
    else field += c;
  }
  assert.equal(quoted, false); assert.equal(field, ""); assert.deepEqual(row, []);
  const [headers, ...records] = rows;
  for (const record of records) assert.equal(record.length, headers.length);
  return records.map(record => Object.fromEntries(headers.map((h, i) => [h, record[i]])));
}
const csvMetadata = { backupId: "backup-test", createdAt: "2026-10-19T03:00:00Z" };
function readableFixture() {
  return {
    users: [{ id: "bojan", name: "Bojan", google: { tokens: "SECRET" } }, { id: "ibro", name: "Ibro", passwordHash: "SECRET" }],
    clients: [{ clientId: "c", name: "Podjetje Ščž", email: "SECRET" }],
    tasks: [
      { id: "plan", title: 'Omarica; "Ščž"', notes: "Prva vrstica\nDruga vrstica", material: "6 kontaktorjev", date: "2026-10-14", clientId: "c", client: "Stranka", status: "open", calendarOnly: true, start: "08:00", end: "09:00", revisionHistory: ["SECRET"] },
      { id: "hour", status: "execution", date: "2026-10-14", start: "16:15", end: "18:15", clientBillableMinutes: 0, clientKm: 2.5 },
      { id: "trash", status: "open", trashedAt: "2026-10-18T10:00:00Z", title: "=HYPERLINK(1)" }
    ],
    assignments: [
      { id: "p1", taskId: "plan", syncUser: "bojan" }, { id: "p2", taskId: "plan", syncUser: "ibro", archivedAt: "old" },
      { id: "h1", taskId: "hour", syncUser: "ibro", billingKm: 0, archivedAt: "old", archivedPayrollId: "pay", archivedClientBillId: "bill" }
    ],
    entries: [{ id: "legacy", syncUser: "ibro", status: "billed", work: "Star koledarski vnos", sourceTodoId: "plan" }]
  };
}
test("CSV preserves all events, groups co-workers, distinguishes archive/trash and excludes secrets", () => {
  const files = renderReadableCsv(readableFixture(), csvMetadata);
  assert.deepEqual(files.map(f => [f.name, f.rows]), [["dogodki.csv", 4], ["vpisi-ur.csv", 1]]);
  assert.ok(files.every(f => !f.content.includes("SECRET")));
  const events = parseCsv(files[0].content), plan = events.find(r => r["ID dogodka"] === "plan");
  assert.equal(plan.Naslov, 'Omarica; "Ščž"'); assert.equal(plan["Opis del"], "Prva vrstica\nDruga vrstica");
  assert.equal(plan.Izvajalci, "Bojan | Ibro"); assert.equal(plan["Stanje zapisa"], "Delno arhivirano");
  assert.equal(plan["Ura od"], ""); assert.equal(plan["Cel dan"], "Da");
  assert.equal(plan["Naziv stranke v imeniku"], "Podjetje Ščž");
  assert.equal(events.find(r => r["ID dogodka"] === "trash")["Stanje zapisa"], "Koš");
  assert.equal(events.find(r => r["ID dogodka"] === "legacy")["Vrsta zapisa"], "Stari koledarski vnos");
  const [hour] = parseCsv(files[1].content);
  assert.equal(hour["Vpisane ure"], "2"); assert.equal(hour["Ure za stranko (dogodek, enkrat)"], "0");
  assert.equal(hour["Km delavca (vpisano)"], "0"); assert.equal(hour["Km stranke (vpisano)"], "2,5");
  assert.equal(hour["Urna postavka (vpisana)"], ""); assert.equal(hour["Stanje zapisa"], "Arhiv");
  assert.equal(hour["ID obračuna delavca"], "pay"); assert.equal(hour["ID obračuna stranke"], "bill");
  assert.equal(hour["ID varnostne kopije"], csvMetadata.backupId);
});
test("CSV never executes formula-like text, including leading whitespace and multiline fields", () => {
  for (const title of ["=1+1", "+cmd", "-cmd", "@SUM(1)", " \t=1", "\rmalicious", "\nmalicious", "\t1"]) {
    const fixture = readableFixture(); fixture.tasks[0].title = title;
    const record = parseCsv(renderReadableCsv(fixture, csvMetadata)[0].content).find(r => r["ID dogodka"] === "plan");
    assert.equal(record.Naslov, "'" + title);
  }
});
test("CSV handles missing hours, midnight, warranty and shared client hours without double counting", () => {
  assert.equal(durationMinutes({ start: "23:30", end: "24:00" }), 30);
  for (const data of [{}, { start: "08:00", end: "08:00" }, { start: "25:00", end: "26:00" }]) assert.equal(durationMinutes(data), null);
  const fixture = readableFixture(); const hour = fixture.tasks.find(t => t.id === "hour");
  fixture.assignments.push({ id: "h2", taskId: "hour", syncUser: "bojan" });
  hour.clientBillableMinutes = 90;
  let records = parseCsv(renderReadableCsv(fixture, csvMetadata)[1].content);
  assert.deepEqual(records.map(r => r["Ure za stranko (dogodek, enkrat)"]), ["1,5", ""]);
  hour.clientBillableMinutes = null;
  records = parseCsv(renderReadableCsv(fixture, csvMetadata)[1].content);
  assert.deepEqual(records.map(r => r["Ure za stranko (dogodek, enkrat)"]), ["4", ""]);
  hour.warranty = true;
  assert.equal(parseCsv(renderReadableCsv(fixture, csvMetadata)[1].content)[0]["Ure za stranko (dogodek, enkrat)"], "0");
  hour.status = "meal"; hour.warranty = false; hour.end = "";
  records = parseCsv(renderReadableCsv(fixture, csvMetadata)[1].content);
  assert.equal(records[0]["Vpisane ure"], ""); assert.equal(records[0]["Ure za stranko (dogodek, enkrat)"], "0");
});
test("CSV remains valid when empty and fails closed on orphaned records", () => {
  for (const file of renderReadableCsv({}, csvMetadata)) assert.deepEqual(parseCsv(file.content), []);
  assert.throws(() => renderReadableCsv({ assignments: [{ id: "orphan", taskId: "unknown" }] }, csvMetadata), /nima dogodka/);
  assert.throws(() => renderReadableCsv({ tasks: [{ id: "orphan", status: "execution" }] }, csvMetadata), /nima izvajalca/);
  assert.deepEqual(STATUS_LABELS, Object.fromEntries(Object.entries(require("../outputs/server").TODO_STATUS_DEFINITIONS).map(([key, value]) => [key, value.label])));
});
test("CSV generation failure rolls back the snapshot before any publishing", async () => {
  const steps = [];
  const client = { query: async sql => { steps.push(sql); return { rows: [{ snapshot: "qa" }] }; }, release: () => steps.push("release") };
  await assert.rejects(dumpConsistentDatabase({ connect: async () => client }, "work", "dump", "state", {
    dump: async () => {}, writeState: async () => {}, writeCsv: async () => { throw new Error("CSV failed"); }
  }), /CSV failed/);
  assert.deepEqual(steps.slice(-2), ["rollback", "release"]);
});

async function csvDriveFixture(t) {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "indus-csv-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "dogodki.csv"), content = renderReadableCsv(readableFixture(), csvMetadata)[0].content;
  fs.writeFileSync(file, content);
  const files = new Map(), calls = [];
  const save = async (op, args) => {
    calls.push(op); let body = "";
    for await (const chunk of args.media.body) body += chunk.toString("utf8");
    assert.equal(body, content);
    const id = args.fileId || "csv-id", old = files.get(id) || {};
    const metadata = { ...old, ...args.requestBody, id, parents: old.parents || args.requestBody.parents,
      ownedByMe: true, trashed: false, size: String(Buffer.byteLength(body)), md5Checksum: require("crypto").createHash("md5").update(body).digest("hex") };
    files.set(id, metadata); return { data: structuredClone(metadata) };
  };
  const drive = { files: {
    list: async () => ({ data: { files: [...files.values()] } }),
    get: async ({ fileId }) => ({ data: structuredClone(files.get(fileId)) }),
    create: args => save("create", args), update: args => save("update", args)
  } };
  return { file, drive, files, calls, metadata: { ...csvMetadata, rows: 4 } };
}
test("latest Drive CSV retains its ID and parent and verifies every upload by size and hash", async t => {
  const f = await csvDriveFixture(t);
  const first = await upsertReadableCsv(f.drive, "folder", f.file, f.metadata);
  const second = await upsertReadableCsv(f.drive, "folder", f.file, { ...f.metadata, backupId: "next" });
  assert.equal(first.id, second.id); assert.deepEqual(f.calls, ["create", "update"]);
  assert.equal(f.files.size, 1); assert.deepEqual(f.files.get(first.id).parents, ["folder"]);
  assert.equal(f.files.get(first.id).appProperties.backupId, "next");
});
test("Drive CSV refuses moved/unowned files and duplicates without overwriting", async t => {
  const f = await csvDriveFixture(t);
  await upsertReadableCsv(f.drive, "folder", f.file, f.metadata);
  const original = structuredClone(f.files.get("csv-id"));
  for (const patch of [{ parents: ["elsewhere"] }, { ownedByMe: false }, { trashed: true }, { mimeType: "text/plain" }, { appProperties: {} }]) {
    f.files.set("csv-id", { ...original, ...patch });
    await assert.rejects(upsertReadableCsv(f.drive, "folder", f.file, f.metadata), /upravljani mapi/);
  }
  f.files.set("csv-id", original); f.files.set("duplicate", { ...original, id: "duplicate" });
  await assert.rejects(upsertReadableCsv(f.drive, "folder", f.file, f.metadata), /Podvojeni/);
  assert.deepEqual(f.calls, ["create"]);
});
test("CSV upload with incorrect content is not reported as verified", async t => {
  const f = await csvDriveFixture(t), get = f.drive.files.get;
  f.drive.files.get = async args => { const response = await get(args); response.data.md5Checksum = "bad"; return response; };
  await assert.rejects(upsertReadableCsv(f.drive, "folder", f.file, f.metadata), /MD5/);
});
