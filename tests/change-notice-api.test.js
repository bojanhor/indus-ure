const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function request(port, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const client = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: responseBody }));
    });
    client.on("error", reject);
    if (body) client.write(body);
    client.end();
  });
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await request(port, "/api/health")).status === 200) return;
    } catch {
      // The test server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("Testna instanca INDUS URE se ni zagnala.");
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

async function stop(child) {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("sprememba opravila se označi samo drugemu uporabniku in izgine po izrecni potrditvi", { timeout: 15_000 }, async () => {
  const port = 20500 + Math.floor(Math.random() * 700);
  const dataDir = path.join(os.tmpdir(), `indus-ure-change-notice-${process.pid}-${Date.now()}`);
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
    const bojan = await login(port, "bojan", password);
    const ibro = await login(port, "ibro", password);
    const create = await request(port, "/api/todos", {
      method: "POST",
      headers: bojan,
      body: JSON.stringify({
        title: "Opravilo za pregled",
        client: "Testna stranka",
        status: "open",
        syncUser: "ibro",
        assigneeIds: ["ibro"],
        clientMutationId: "e12d9801-cb3c-41b1-911c-8ef062575901"
      })
    });
    assert.equal(create.status, 200, create.body);
    const id = JSON.parse(create.body).todos.find((todo) => todo.title === "Opravilo za pregled")?.id;
    assert.ok(id);

    const ibroList = await request(port, "/api/todos", { headers: ibro });
    const createdForIbro = JSON.parse(ibroList.body).todos.find((todo) => todo.id === id);
    assert.equal(createdForIbro.changeNotice?.kind, "created");
    assert.equal(createdForIbro.changeNotice?.by, "bojan");

    const seen = await request(port, `/api/todos/${encodeURIComponent(id)}/change-notice/seen`, {
      method: "POST", headers: ibro, body: "{}"
    });
    assert.equal(seen.status, 200, seen.body);
    assert.equal(JSON.parse(seen.body).todos.find((todo) => todo.id === id).changeNotice, null);

    const update = await request(port, `/api/todos/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: ibro,
      body: JSON.stringify({ ...createdForIbro, title: "Opravilo po popravku", baseUpdatedAt: createdForIbro.updatedAt })
    });
    assert.equal(update.status, 200, update.body);
    const bossList = await request(port, "/api/todos", { headers: bojan });
    const changedForBoss = JSON.parse(bossList.body).todos.find((todo) => todo.id === id);
    assert.deepEqual(changedForBoss.changeNotice?.fields, ["title"]);
    assert.equal(changedForBoss.changeNotice?.by, "ibro");
  } finally {
    await stop(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
