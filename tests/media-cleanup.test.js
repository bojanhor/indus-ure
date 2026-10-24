"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { referencedMediaIds, mediaCandidates, cleanupMedia } = require("../scripts/media-cleanup");
test("references include trash, history, pending upload keys and attachment paths", () => {
  const ids = ["a", "b", "c", "d"].map(c => c.repeat(64));
  const found = referencedMediaIds({ trash: { photos: [{ attachmentId: ids[0] }] }, undo: { before: { thumbnailKey: `thumbnails/${ids[1]}.jpg` } }, pending: { [ids[2]]: {} }, oldUrl: `/api/attachments/${ids[3]}` });
  assert.deepEqual([...found].sort(), ids);
});
test("collector only chooses old unreferenced managed files inside objects/thumbnails", async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "indus-gc-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const now = Date.now(), old = new Date(now - 2 * 86400000), kept = "a".repeat(64), orphan = "b".repeat(64), recent = "c".repeat(64);
  for (const folder of ["objects", "thumbnails", ".uploads"]) {
    await fs.mkdir(path.join(dir, folder));
    for (const name of [`${kept}.jpg`, `${orphan}.jpg`, `${recent}.jpg`, "unknown.jpg"]) {
      const file = path.join(dir, folder, name); await fs.writeFile(file, "data");
      if (!name.startsWith(recent)) await fs.utimes(file, old, old);
    }
  }
  const candidates = await mediaCandidates(dir, new Set([kept]), now);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(f => path.basename(f.file) === `${orphan}.jpg`));
  await assert.rejects(cleanupMedia({}, dir), /preverjeno recovery/);
  const calls = [];
  const client = { query: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.includes("pg_try_advisory")) return { rows: [{ locked: true }] };
    if (sql.includes("storage_revision")) return { rows: [{ data: { revision: 1 } }], rowCount: 1 };
    if (sql.includes("select")) return { rows: [{ data: { attachmentId: kept } }] };
    return { rows: [] };
  } };
  const proof = { status: "success", createdAt: new Date(now).toISOString(), verified: { localArchive: true, driveMd5: true, freshDriveRead: true, readableCsv: true } };
  assert.equal((await cleanupMedia(client, dir, { dryRun: true, now })).candidates, 2);
  assert.equal((await cleanupMedia(client, dir, { proof, now })).removed, 2);
  assert.equal((await mediaCandidates(dir, new Set([kept]), now)).length, 0);
  assert.ok(calls.some(([sql]) => sql.includes("for update")));
  assert.equal(await fs.readFile(path.join(dir, ".uploads", `${orphan}.jpg`), "utf8"), "data");
});
test("busy upload or backup defers GC and releases only acquired locks", async () => {
  const calls = [];
  const client = { query: async (sql, args) => { calls.push([sql, args]); return { rows: [{ locked: args[0] === "indus-ure-recovery-backup" }] }; } };
  assert.equal((await cleanupMedia(client, "/unused", { dryRun: true })).skipped, true);
  assert.equal(calls.filter(([sql]) => sql.includes("unlock")).length, 1);
  assert.equal(calls.some(([sql]) => sql === "begin"), false);
});
test("metadata pruning preserves recoverable history, trash, pending and Undo attachments", () => {
  const { createAttachmentTransfer } = require("../outputs/attachment-transfer");
  const ids = ["a", "b", "c", "d", "e"].map(c => c.repeat(64));
  const api = createAttachmentTransfer({ pendingAttachmentMap: db => db.pending,
    undoProtectedAttachmentIds: () => [ids[3]], validTodoAttachmentId: id => /^[a-f0-9]{64}$/.test(id), moduleValues: {} });
  const db = { todos: [{ trashedAt: '2026-10-24', photos: [{ attachmentId: ids[0] }], revisionHistory: [{ snapshot: { photos: [{ attachmentId: ids[1] }] } }] }],
    pending: { [ids[2]]: {} }, attachments: Object.fromEntries(ids.map(id => [id, { storageKey: `objects/${id}.jpg` }])) };
  assert.equal(api.pruneUnusedTodoAttachments(db), true);
  assert.deepEqual(Object.keys(db.attachments), ids.slice(0, 4));
});
