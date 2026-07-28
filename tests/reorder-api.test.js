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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await request(port, "/api/health")).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("Testni strežnik se ni zagnal.");
}

async function login(port, userId, password) {
  const response = await request(port, "/api/test-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, password })
  });
  assert.equal(response.status, 200, response.body);
  const data = JSON.parse(response.body);
  return {
    "Content-Type": "application/json",
    Cookie: String(response.headers["set-cookie"]?.[0] || "").split(";", 1)[0],
    "X-CSRF-Token": data.csrfToken
  };
}

async function createTask(port, headers, title, assigneeId) {
  const response = await request(port, "/api/todos", {
    method: "POST",
    headers,
    body: JSON.stringify({ title, status: "open", syncUser: assigneeId, assigneeIds: [assigneeId] })
  });
  assert.equal(response.status, 200, response.body);
  return JSON.parse(response.body).todos.find((todo) => todo.title === title);
}

test("API združi ročni vrstni red med šefom in delavcem, ne da bi premaknil skrite naloge", { timeout: 20_000 }, async () => {
  const port = 20100 + Math.floor(Math.random() * 300);
  const dataDir = path.join(os.tmpdir(), `indus-ure-shared-order-${process.pid}-${Date.now()}`);
  const password = "shared-order-test-password-123";
  const child = spawn(process.execPath, ["outputs/server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: dataDir, MEDIA_DIR: path.join(dataDir, "media"), DATABASE_URL: "",
      NODE_ENV: "test", INDUS_URE_TEST_MODE: "true", TEST_LOCAL_LOGIN_PASSWORD: password, DISABLE_OPERATIONAL_MONITOR: "true"
    },
    stdio: ["ignore", "ignore", "ignore"]
  });
  try {
    await waitForHealth(port);
    const bossHeaders = await login(port, "bojan", password);
    // New tasks appear at the top. Creating them in this order yields A, B, C.
    const c = await createTask(port, bossHeaders, "C - Ibro", "ibro");
    await createTask(port, bossHeaders, "B - Bojan", "bojan");
    const a = await createTask(port, bossHeaders, "A - Ibro", "ibro");
    assert.ok(a?.id && c?.id);

    const workerHeaders = await login(port, "ibro", password);
    const reorder = await request(port, "/api/todos/reorder", {
      method: "POST", headers: workerHeaders,
      body: JSON.stringify({ sourceId: c.id, targetId: a.id, placement: "before" })
    });
    assert.equal(reorder.status, 200, reorder.body);
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "db.json"), "utf8"));
    const ordered = [...persisted.todos]
      .filter((todo) => !todo.done && todo.status === "open")
      .sort((left, right) => Number(left.sharedManualOrder) - Number(right.sharedManualOrder))
      .map((todo) => todo.title);
    assert.deepEqual(ordered, ["C - Ibro", "B - Bojan", "A - Ibro"]);

    const workerTodos = JSON.parse((await request(port, "/api/todos", { headers: workerHeaders })).body).todos
      .sort((left, right) => Number(left.sharedManualOrder) - Number(right.sharedManualOrder))
      .map((todo) => todo.title);
    assert.deepEqual(workerTodos, ["C - Ibro", "A - Ibro"]);

    const workerAttemptOnForeign = await request(port, "/api/todos/reorder", {
      method: "POST", headers: workerHeaders,
      body: JSON.stringify({ sourceId: persisted.todos.find((todo) => todo.title === "B - Bojan").id, targetId: a.id, placement: "before" })
    });
    assert.equal(workerAttemptOnForeign.status, 403, workerAttemptOnForeign.body);
  } finally {
    child.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});