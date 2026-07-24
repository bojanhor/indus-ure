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
      const health = await request(port, "/api/health");
      if (health.status === 200) return;
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
  const cookie = response.headers["set-cookie"]?.[0];
  assert.match(cookie || "", /indus-ure-session=/);
  return cookie;
}

test("revizijski API je samo za šefa, je bralni in uporablja obstojno PG-pot", async () => {
  const server = await fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  const marker = 'if (url.pathname === "/api/audit-log" && req.method === "GET") {';
  const start = server.indexOf(marker);
  assert.ok(start >= 0, "Manjka GET /api/audit-log.");
  const end = server.indexOf('if (url.pathname === "/api/notifications"', start);
  assert.ok(end > start, "Blok GET /api/audit-log ni jasno omejen.");
  const route = server.slice(start, end);

  assert.match(route, /await requireUser\(req, res\)/);
  assert.match(route, /user\.role !== "boss"/);
  assert.match(route, /sendJson\(res, 403/);
  assert.match(route, /DATABASE_URL\s*\?\s*await persistedAuditLogForUser/);
  assert.match(route, /retentionDays:\s*AUDIT_LOG_RETENTION_DAYS/);
  assert.doesNotMatch(route, /writeDbAsync\s*\(/, "Branje revizijskega dnevnika ne sme zapisati glavne baze.");
});

test("revizijski API zavrne neprijavljene in delavce, šefu pa vrne varen bralni odgovor", { timeout: 15_000 }, async () => {
  const port = 19600 + Math.floor(Math.random() * 300);
  const dataDir = path.join(os.tmpdir(), `indus-ure-audit-api-${process.pid}-${Date.now()}`);
  const password = "audit-api-local-test-password-123";
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
    assert.equal((await request(port, "/api/audit-log")).status, 401);

    const workerCookie = await testLogin(port, "ibro", password);
    assert.equal((await request(port, "/api/audit-log", { headers: { Cookie: workerCookie } })).status, 403);

    const bossCookie = await testLogin(port, "bojan", password);
    const audit = await request(port, "/api/audit-log", { headers: { Cookie: bossCookie } });
    assert.equal(audit.status, 200);
    const body = JSON.parse(audit.body);
    assert.equal(body.retentionDays, 30);
    assert.equal(body.maxEvents, 500);
    assert.equal(typeof body.truncated, "boolean");
    assert.ok(Array.isArray(body.events));
  } finally {
    child.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
