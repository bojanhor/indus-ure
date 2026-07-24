const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function request(port, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: responseBody }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await request(port, "/api/health");
      if (response.status === 200) return;
    } catch {
      // The server has not finished starting yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("Testna instanca INDUS URE se ni zagnala.");
}

async function stop(child) {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 1_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("časovna serija shrani premik datuma in zaokrožene ure atomarno", { timeout: 15_000 }, async () => {
  const port = 19600 + Math.floor(Math.random() * 900);
  const dataDir = path.join(os.tmpdir(), `indus-ure-day-timeline-${process.pid}-${Date.now()}`);
  const password = "test-only-local-password-123";
  const child = spawn(process.execPath, ["outputs/server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      MEDIA_DIR: path.join(dataDir, "media"),
      DATABASE_URL: "",
      NODE_ENV: "test",
      INDUS_URE_TEST_MODE: "true",
      TEST_LOCAL_LOGIN_PASSWORD: password,
      DISABLE_OPERATIONAL_MONITOR: "true"
    },
    stdio: ["ignore", "ignore", "ignore"]
  });

  try {
    await waitForHealth(port);
    const login = await request(port, "/api/test-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "bojan", password })
    });
    assert.equal(login.status, 200, login.body);
    const loginData = JSON.parse(login.body);
    const cookie = String(login.headers["set-cookie"]?.[0] || "").split(";", 1)[0];
    assert.match(cookie, /^indus-ure-session=/);
    assert.match(loginData.csrfToken, /^[a-f0-9]{48}$/);
    const headers = {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": loginData.csrfToken
    };

    const create = await request(port, "/api/todos", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Premik v dnevnem pogledu",
        status: "execution",
        date: "2026-07-21",
        endDate: "2026-07-21",
        start: "08:00",
        end: "09:00",
        syncUser: "bojan",
        assigneeIds: ["bojan"]
      })
    });
    assert.equal(create.status, 200, create.body);
    const created = JSON.parse(create.body).todos.find((todo) => todo.title === "Premik v dnevnem pogledu");
    assert.ok(created?.id, "Ustvarjeni vnos ur mora biti vrnjen prijavljenemu uporabniku.");
    assert.ok(created.updatedAt, "Vnos mora imeti optimistični čas spremembe.");

    const batch = await request(port, "/api/todos/time-batch", {
      method: "POST",
      headers,
      body: JSON.stringify({
        items: [{
          id: created.id,
          date: "2026-07-22",
          start: "10:13",
          end: "11:44",
          baseUpdatedAt: created.updatedAt
        }]
      })
    });
    assert.equal(batch.status, 200, batch.body);
    const moved = JSON.parse(batch.body).todos.find((todo) => todo.id === created.id);
    assert.deepEqual(
      { date: moved?.date, endDate: moved?.endDate, start: moved?.start, end: moved?.end },
      { date: "2026-07-22", endDate: "2026-07-22", start: "10:15", end: "11:45" }
    );

    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "db.json"), "utf8"));
    const persistedTodo = persisted.todos.find((todo) => todo.id === created.id);
    assert.deepEqual(
      { date: persistedTodo?.date, endDate: persistedTodo?.endDate, start: persistedTodo?.start, end: persistedTodo?.end },
      { date: "2026-07-22", endDate: "2026-07-22", start: "10:15", end: "11:45" },
      "Premik mora preživeti branje iz podatkovne datoteke po API odgovoru."
    );

    // A legitimate lock from the same tab may accompany the batch. An absent
    // or wrong token must still be rejected rather than bypassing the lock.
    const lock = await request(port, `/api/todos/${encodeURIComponent(created.id)}/lock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ lockToken: "" })
    });
    assert.equal(lock.status, 200, lock.body);
    const lockToken = JSON.parse(lock.body).lockToken;
    const rejectedWithoutToken = await request(port, "/api/todos/time-batch", {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{
        id: created.id, date: moved.date, start: "11:00", end: "12:00", baseUpdatedAt: moved.updatedAt
      }] })
    });
    assert.equal(rejectedWithoutToken.status, 409, rejectedWithoutToken.body);
    const savedWithToken = await request(port, "/api/todos/time-batch", {
      method: "POST",
      headers,
      body: JSON.stringify({
        editLockTokens: { [created.id]: lockToken },
        items: [{ id: created.id, date: moved.date, start: "11:00", end: "12:00", baseUpdatedAt: moved.updatedAt }]
      })
    });
    assert.equal(savedWithToken.status, 200, savedWithToken.body);
    const lockedMoved = JSON.parse(savedWithToken.body).todos.find((todo) => todo.id === created.id);
    assert.deepEqual({ start: lockedMoved?.start, end: lockedMoved?.end }, { start: "11:00", end: "12:00" });

    const createSecond = await request(port, "/api/todos", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Drugi premik", status: "execution", date: "2026-07-22", endDate: "2026-07-22",
        start: "13:00", end: "14:00", syncUser: "bojan", assigneeIds: ["bojan"]
      })
    });
    assert.equal(createSecond.status, 200, createSecond.body);
    const second = JSON.parse(createSecond.body).todos.find((todo) => todo.title === "Drugi premik");
    const atomicReject = await request(port, "/api/todos/time-batch", {
      method: "POST",
      headers,
      body: JSON.stringify({
        editLockTokens: { [created.id]: lockToken },
        items: [
          { id: created.id, date: "2026-07-22", start: "12:00", end: "13:00", baseUpdatedAt: lockedMoved.updatedAt },
          { id: second.id, date: "2026-07-22", start: "14:00", end: "15:00", baseUpdatedAt: "stale-revision" }
        ]
      })
    });
    assert.equal(atomicReject.status, 409, atomicReject.body);
    const afterRejectedBatch = JSON.parse(await fs.readFile(path.join(dataDir, "db.json"), "utf8"));
    const unchanged = afterRejectedBatch.todos.find((todo) => todo.id === created.id);
    assert.deepEqual({ start: unchanged?.start, end: unchanged?.end }, { start: "11:00", end: "12:00" }, "Neuspešna serija ne sme delno zapisati prve spremembe.");
  } finally {
    await stop(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});