const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { normalizeDb, undoArrayPatch } = require("../outputs/server");

function request(port, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await request(port, "/api/health")).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Testni strežnik se ni zagnal.");
}

async function testLogin(port, userId, password) {
  const response = await request(port, "/api/test-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, password })
  });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  return {
    cookie: response.headers["set-cookie"]?.[0] || "",
    csrfToken: body.csrfToken
  };
}

test("Undo ne obravnava naključnega vrstnega reda baze kot poslovne spremembe", () => {
  const before = [{ id: "a", value: 1 }, { id: "b", value: 2 }];
  const after = [{ id: "b", value: 2 }, { id: "a", value: 1 }];
  assert.equal(undoArrayPatch("clientBills", before, after), null);

  const changed = undoArrayPatch("clientBills", before, [{ id: "b", value: 3 }, { id: "a", value: 1 }]);
  assert.deepEqual(changed, {
    changes: [{ id: "b", before: { id: "b", value: 2 } }],
    order: ["a", "b"]
  });
});

test("stari Undo zapisi dobijo dejanski naslov dogodka in stranke", () => {
  const todoId = "11111111-1111-4111-8111-111111111111";
  const billId = "22222222-2222-4222-8222-222222222222";
  const db = {
    todos: [{ id: todoId, title: "Menjava releja", client: "Roman Studen" }],
    clientBills: [{ id: billId, clientName: "Roman Studen" }],
    undoJournal: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        createdAt: "2026-09-03T10:00:00.000Z",
        actorId: "bojan",
        actorName: "Bojan",
        action: "Bojan je ustvaril dogodek »brez naslova«",
        patch: { version: 2, arrays: { todos: { changes: [{ id: todoId, before: null }] } } }
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        createdAt: "2026-09-03T09:00:00.000Z",
        actorId: "bojan",
        actorName: "Bojan",
        action: "Bojan je potrdil obračun za stranko »stranko«",
        patch: { version: 2, arrays: { clientBills: { changes: [{ id: billId, before: null }] } } }
      }
    ]
  };
  const normalized = normalizeDb(db);
  assert.equal(normalized.changed, true);
  assert.match(db.undoJournal[0].action, /»Menjava releja«/);
  assert.match(db.undoJournal[1].action, /»Roman Studen«/);
  assert.equal(normalizeDb(db).changed, false);
});

test("Undo varno vrne zadnje poslovno dejanje in ga ne ponudi dvakrat", { timeout: 20_000 }, async () => {
  const port = 19900 + Math.floor(Math.random() * 200);
  const dataDir = path.join(os.tmpdir(), "indus-ure-undo-" + process.pid + "-" + Date.now());
  const password = "undo-api-local-test-password-123";
  const child = spawn(process.execPath, ["outputs/server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      INDUS_URE_TEST_MODE: "true",
      TEST_LOCAL_LOGIN_PASSWORD: password
    },
    stdio: ["ignore", "ignore", "ignore"]
  });
  try {
    await waitForHealth(port);
    const session = await testLogin(port, "bojan", password);
    const headers = {
      Cookie: session.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken
    };
    const created = await request(port, "/api/todos", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Undo preizkus", client: "Testna stranka", status: "open", assigneeIds: ["bojan"] })
    });
    assert.equal(created.status, 200);

    const journalResponse = await request(port, "/api/undo-journal", { headers: { Cookie: session.cookie } });
    assert.equal(journalResponse.status, 200);
    const journal = JSON.parse(journalResponse.body);
    assert.equal(journal.actions.length, 1);
    assert.match(journal.actions[0].action, /ustvaril dogodek/);
    assert.equal(journal.actions[0].canUndo, true);

    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "db.json"), "utf8"));
    const persistedUndo = persisted.undoJournal?.[0] || {};
    assert.equal(Object.hasOwn(persistedUndo, "beforeState"), false);
    assert.equal(persistedUndo.patch?.version, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(persistedUndo), "utf8") < 20_000);

    const undone = await request(port, "/api/undo-journal/" + encodeURIComponent(journal.actions[0].id), {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(undone.status, 200);
    assert.equal(JSON.parse(undone.body).actions[0].undoneAt.length > 0, true);

    const todos = await request(port, "/api/todos", { headers: { Cookie: session.cookie } });
    assert.equal(todos.status, 200);
    assert.equal(JSON.parse(todos.body).todos.some((todo) => todo.title === "Undo preizkus"), false);

    const repeated = await request(port, "/api/undo-journal/" + encodeURIComponent(journal.actions[0].id), {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(repeated.status, 409);
  } finally {
    child.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
