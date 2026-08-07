const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

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
