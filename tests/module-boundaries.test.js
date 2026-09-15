"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const manifest = require("../outputs/module-manifest.json");
const { createAttachmentTransfer } = require("../outputs/attachment-transfer");

function factoryFor(item) {
  const file = path.join(__dirname, "../outputs", `${item.name}.js`);
  if (item.source === "server") return require(file)[item.factory];
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context[item.factory];
}

for (const item of manifest) {
  test(`${item.name}: explicit, inert factory with private implementation helpers`, () => {
    const fail = () => { throw new Error("Factory performed work during composition"); };
    const deps = Object.fromEntries([...item.callbacks, ...item.direct].map(name => [name, fail]));
    deps.moduleValues = new Proxy({}, { get: fail, set: fail });
    const api = factoryFor(item)(deps);
    assert.deepEqual(Object.keys(api).sort(), [...item.exports].sort());
    assert.ok(Object.values(api).every(fn => typeof fn === "function"));
    for (const privateName of item.originalFunctions.filter(name => !item.exports.includes(name))) {
      assert.equal(Object.hasOwn(api, privateName), false, `${privateName} must remain private`);
    }
  });
}

test("feature HTTP handlers fall through without authentication, I/O or mutations on an unrelated route", async () => {
  for (const item of manifest.filter(item => item.source === "server")) {
    const fail = () => { throw new Error("Unrelated route caused side effects"); };
    const deps = Object.fromEntries(item.callbacks.map(name => [name, fail]));
    deps.moduleValues = new Proxy({}, { get: fail, set: fail });
    const api = factoryFor(item)(deps);
    for (const name of item.exports.filter(name => name.startsWith("handle"))) {
      assert.equal(await api[name]({ method: "GET" }, {}, new URL("http://localhost/api/unrelated")), false, name);
    }
  }
});

test("feature HTTP handlers stop at authentication and never mutate on a denied request", async () => {
  const cases = [
    ["undo-service", "handleUndoJournal", "GET", "/api/undo-journal"],
    ["undo-service", "handleUndoJournal", "POST", "/api/undo-journal/aaaaaaaa-aaaa-aaaa"],
    ["settlement-service", "handlePayrollList", "GET", "/api/payrolls"],
    ["settlement-service", "handleSettlements", "POST", "/api/client-bills"],
    ["settlement-service", "handleSettlements", "PUT", "/api/payrolls/id"],
    ["settlement-service", "handleClientBillingFields", "POST", "/api/todos/id/client-billing-fields"],
    ["report-service", "handleWorkerReports", "GET", "/api/payroll-export.xlsx"],
    ["report-service", "handleReportDownloads", "POST", "/api/client-report/pdf"],
    ["attachment-transfer", "handleAttachmentUpload", "POST", "/api/todos/image"],
    ["attachment-transfer", "handleAttachmentUpload", "POST", "/api/todos/video"],
    ["attachment-transfer", "handleAttachmentDownload", "GET", `/api/attachments/${"a".repeat(64)}`]
  ];
  for (const [module, handler, method, route] of cases) {
    const item = manifest.find(item => item.name === module);
    const fail = () => { throw new Error("Unauthenticated request reached protected work"); };
    const deps = Object.fromEntries(item.callbacks.map(name => [name, fail]));
    let checked = 0;
    deps.requireUser = async () => { checked++; return null; };
    deps.moduleValues = new Proxy({}, { get: fail, set: fail });
    assert.equal(await factoryFor(item)(deps)[handler]({ method }, {}, new URL(`http://localhost${route}`)), true);
    assert.equal(checked, 1, route);
  }
});

async function imageFixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "indus-image-module-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  let invalid = false, writeFails = false, writes = 0, response;
  const db = { attachments: {}, pending: {} };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
  const api = createAttachmentTransfer({
    requireUser: async () => ({ id: "ibro", name: "Ibro" }),
    runSerializedWork: async work => work(), readRequestDb: async () => db,
    pendingAttachmentMap: snapshot => snapshot.pending,
    attachmentApiUrl: (id, thumbnail) => `/api/attachments/${id}${thumbnail ? "/thumbnail" : ""}`,
    writeDbAsync: async () => { writes++; if (writeFails) throw new Error("Persistence failed"); },
    sendJson: (_res, status, body) => { response = { status, body }; },
    moduleValues: {
      fs, fsp, path, crypto, Transform, pipeline, MEDIA_DIR: dir,
      MAX_TODO_IMAGE_BYTES: 1024, IMAGE_PROCESSOR: "test-image-processor",
      TODO_IMAGE_PROCESS_TIMEOUT_MS: 1000, TODO_IMAGE_DISPLAY_MAX_SIDE: 1920,
      TODO_IMAGE_THUMBNAIL_MAX_SIDE: 320, PENDING_ATTACHMENT_TTL_MS: 60000,
      execFileAsync: async (_command, args) => fsp.writeFile(args[2].split("[")[0], invalid ? Buffer.from("invalid image") : jpeg)
    }
  });
  async function upload() {
    const req = Readable.from([Buffer.from("test image input")]);
    req.method = "POST";
    req.headers = { "content-type": "image/png", "x-indus-file-name": "image.png", "content-length": "16" };
    return api.handleAttachmentUpload(req, {}, new URL("http://localhost/api/todos/image"));
  }
  return { dir, db, upload, response: () => response, writes: () => writes,
    failImage: () => { invalid = true; }, failWrite: () => { writeFails = true; } };
}

test("image upload validates generated JPEGs and persists owned original/thumbnail metadata", async t => {
  const fixture = await imageFixture(t);
  assert.equal(await fixture.upload(), true);
  const { status, body } = fixture.response();
  assert.equal(status, 201);
  const attachment = fixture.db.attachments[body.photo.attachmentId];
  assert.equal(attachment.createdBy, "ibro");
  assert.equal(fixture.db.pending[body.photo.attachmentId].userId, "ibro");
  assert.equal(fs.existsSync(path.join(fixture.dir, attachment.storageKey)), true);
  assert.equal(fs.existsSync(path.join(fixture.dir, attachment.thumbnailKey)), true);
  assert.deepEqual(await fsp.readdir(path.join(fixture.dir, ".uploads")), []);
  fixture.failImage();
  await assert.rejects(fixture.upload(), /veljavne JPEG/);
  assert.equal(fixture.writes(), 1, "invalid generated data never reaches persistence");
  assert.equal(fs.existsSync(path.join(fixture.dir, attachment.storageKey)), true);
});

test("failed image persistence cleans newly created files without deleting deduplicated existing files", async t => {
  const fresh = await imageFixture(t);
  fresh.failWrite();
  await assert.rejects(fresh.upload(), /Persistence failed/);
  assert.deepEqual(await fsp.readdir(path.join(fresh.dir, "objects")), []);
  assert.deepEqual(await fsp.readdir(path.join(fresh.dir, "thumbnails")), []);
  const existing = await imageFixture(t);
  await existing.upload();
  const id = existing.response().body.photo.attachmentId;
  existing.failWrite();
  await assert.rejects(existing.upload(), /Persistence failed/);
  assert.equal(fs.existsSync(path.join(existing.dir, existing.db.attachments[id].storageKey)), true);
  assert.equal(fs.existsSync(path.join(existing.dir, existing.db.attachments[id].thumbnailKey)), true);
});
