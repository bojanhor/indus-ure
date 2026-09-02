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

test("sprememba opravila ostane zasebna do potrditve prejemnika, sprememba z obvestilom pa navede dejanska polja", { timeout: 15_000 }, async () => {
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
    assert.equal(createdForIbro.changeNoticesByUser, undefined, "Delavec ne sme dobiti oznak drugih prejemnikov.");

    const acknowledge = await request(port, `/api/todos/${encodeURIComponent(id)}/change-notice/seen`, {
      method: "POST", headers: ibro, body: "{}"
    });
    assert.equal(acknowledge.status, 200, acknowledge.body);
    assert.equal(JSON.parse(acknowledge.body).todos.find((todo) => todo.id === id).changeNotice, null, "Prebrano takoj odstrani le prejemnikovo oznako.");

    const markAgain = await request(port, `/api/todos/${encodeURIComponent(id)}/change-notice`, {
      method: "POST", headers: bojan, body: "{}"
    });
    assert.equal(markAgain.status, 200, markAgain.body);
    const ibroMarkedAgain = await request(port, "/api/todos", { headers: ibro });
    const markedForIbro = JSON.parse(ibroMarkedAgain.body).todos.find((todo) => todo.id === id);
    assert.equal(markedForIbro.changeNotice?.kind, "manual");

    const ticket = await request(port, `/api/todos/${encodeURIComponent(id)}/share-pdf-ticket`, {
      method: "POST", headers: ibro, body: "{}"
    });
    assert.equal(ticket.status, 201, ticket.body);
    const downloadUrl = JSON.parse(ticket.body).downloadUrl;
    assert.match(downloadUrl, /^\/api\/todos\/share-pdf-download\?ticket=/);
    const wrongSessionDownload = await request(port, downloadUrl, { headers: bojan });
    assert.equal(wrongSessionDownload.status, 410, wrongSessionDownload.body);
    const pdf = await request(port, downloadUrl, { headers: ibro });
    assert.equal(pdf.status, 200, pdf.body);
    assert.match(String(pdf.headers["content-type"] || ""), /^application\/pdf/);
    assert.match(pdf.body, /^%PDF-/);

    const bossAfterCreate = await request(port, "/api/todos", { headers: bojan });
    const createdForBoss = JSON.parse(bossAfterCreate.body).todos.find((todo) => todo.id === id);
    assert.equal(createdForBoss.changeNotice, null, "Avtor oznake je ne prejme sam.");
    assert.equal(createdForBoss.changeNoticesByUser?.ibro?.kind, "manual", "Šef potrebuje trenutno oznako za Ibrov delavski pogled.");

    const bossAcknowledgesIbro = await request(port, `/api/todos/${encodeURIComponent(id)}/change-notice/seen?recipient=ibro`, {
      method: "POST", headers: bojan, body: "{}"
    });
    assert.equal(bossAcknowledgesIbro.status, 200, bossAcknowledgesIbro.body);
    assert.equal(JSON.parse(bossAcknowledgesIbro.body).todos.find((todo) => todo.id === id).changeNoticesByUser?.ibro, undefined, "Šef lahko v Ibrovem pogledu odstrani Ibrovo oznako.");
    const ibroAfterBossAcknowledgement = await request(port, "/api/todos", { headers: ibro });
    assert.equal(JSON.parse(ibroAfterBossAcknowledgement.body).todos.find((todo) => todo.id === id).changeNotice, null, "Šefovo Prebrano odstrani oznako tudi iz delavčevega pogleda.");

    const workerCannotAcknowledgeBoss = await request(port, `/api/todos/${encodeURIComponent(id)}/change-notice/seen?recipient=bojan`, {
      method: "POST", headers: ibro, body: "{}"
    });
    assert.equal(workerCannotAcknowledgeBoss.status, 403, workerCannotAcknowledgeBoss.body);

    const markForSave = await request(port, `/api/todos/${encodeURIComponent(id)}/change-notice`, {
      method: "POST", headers: bojan, body: "{}"
    });
    assert.equal(markForSave.status, 200, markForSave.body);
    const ibroBeforeSave = await request(port, "/api/todos", { headers: ibro });
    const markedForSave = JSON.parse(ibroBeforeSave.body).todos.find((todo) => todo.id === id);
    assert.equal(markedForSave.changeNotice?.kind, "manual");

    const update = await request(port, `/api/todos/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: ibro,
      body: JSON.stringify({ ...markedForSave, title: "Opravilo po popravku", notifyOthers: true, baseUpdatedAt: markedForSave.updatedAt })
    });
    assert.equal(update.status, 200, update.body);
    const ibroAfterSave = await request(port, "/api/todos", { headers: ibro });
    assert.equal(JSON.parse(ibroAfterSave.body).todos.find((todo) => todo.id === id).changeNotice, null, "Samo uspešno shranjevanje prejemnika porabi njegovo oznako.");
    const bossList = await request(port, "/api/todos", { headers: bojan });
    const changedForBoss = JSON.parse(bossList.body).todos.find((todo) => todo.id === id);
    assert.equal(changedForBoss.changeNotice?.kind, "updated");
    assert.deepEqual(changedForBoss.changeNotice?.fields, ["title"]);
    assert.equal(changedForBoss.changeNotice?.by, "ibro");

    const createHours = await request(port, "/api/todos", {
      method: "POST",
      headers: bojan,
      body: JSON.stringify({
        title: "Vpis ur brez oznake",
        client: "Testna stranka",
        status: "execution",
        date: "2026-09-02",
        start: "08:00",
        end: "09:00",
        syncUser: "ibro",
        assigneeIds: ["ibro"],
        clientMutationId: "911d7801-cb3c-41b1-8ef0-e12d9801c901"
      })
    });
    assert.equal(createHours.status, 200, createHours.body);
    const hoursId = JSON.parse(createHours.body).todos.find((todo) => todo.title === "Vpis ur brez oznake")?.id;
    assert.ok(hoursId);
    const ibroAfterHoursCreate = await request(port, "/api/todos", { headers: ibro });
    const hoursForIbro = JSON.parse(ibroAfterHoursCreate.body).todos.find((todo) => todo.id === hoursId);
    assert.equal(hoursForIbro.changeNotice, null, "Nov vpis ur ne ustvari oznake opravila.");

    const attemptToMarkHours = await request(port, `/api/todos/${encodeURIComponent(hoursId)}/change-notice`, {
      method: "POST", headers: bojan, body: "{}"
    });
    assert.equal(attemptToMarkHours.status, 409, attemptToMarkHours.body);
    assert.match(JSON.parse(attemptToMarkHours.body).error, /Vpisov ur ni mogoče označevati/);

    const updateHours = await request(port, `/api/todos/${encodeURIComponent(hoursId)}`, {
      method: "PUT",
      headers: ibro,
      body: JSON.stringify({ ...hoursForIbro, notes: "Dopolnjen opis ur", notifyOthers: true, baseUpdatedAt: hoursForIbro.updatedAt })
    });
    assert.equal(updateHours.status, 200, updateHours.body);
    const bossAfterHoursUpdate = await request(port, "/api/todos", { headers: bojan });
    const updatedHoursForBoss = JSON.parse(bossAfterHoursUpdate.body).todos.find((todo) => todo.id === hoursId);
    assert.equal(updatedHoursForBoss.changeNotice, null, "Tudi urejen vpis ur ne dobi oznake spremembe.");
    assert.equal(updatedHoursForBoss.changeNoticesByUser, undefined, "Vpis ur nima niti skritih oznak za druge uporabnike.");
  } finally {
    await stop(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("šef lahko v poročilu neposredno spremeni obračunska polja, potrjen obračun pa jih zaklene", { timeout: 15_000 }, async () => {
  const port = 21250 + Math.floor(Math.random() * 700);
  const dataDir = path.join(os.tmpdir(), `indus-ure-client-billing-fields-${process.pid}-${Date.now()}`);
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
        title: "Hitro urejanje obračuna",
        client: "Poročilna testna stranka",
        status: "execution",
        date: "2026-08-20",
        start: "08:00",
        end: "09:00",
        syncUser: "ibro",
        assigneeIds: ["ibro"],
        clientMutationId: "1c548b70-a2bb-4b41-91c0-8e38ab588a10"
      })
    });
    assert.equal(create.status, 200, create.body);
    const created = JSON.parse(create.body).todos.find((todo) => todo.title === "Hitro urejanje obračuna");
    assert.ok(created?.id);
    const eventId = String(created.assignmentGroupId || created.id);

    const notes = await request(port, `/api/todos/${encodeURIComponent(created.id)}/client-billing-fields`, {
      method: "POST", headers: bojan,
      body: JSON.stringify({ notes: "Opis iz poročila", baseUpdatedAt: created.updatedAt })
    });
    assert.equal(notes.status, 200, notes.body);
    const afterNotes = JSON.parse(notes.body).todos.filter((todo) => String(todo.assignmentGroupId || todo.id) === eventId);
    assert.equal(afterNotes.length, 1);
    assert.ok(afterNotes.every((todo) => todo.notes === "Opis iz poročila"));

    const afterNotesTodo = afterNotes.find((todo) => todo.id === created.id);
    const hours = await request(port, `/api/todos/${encodeURIComponent(created.id)}/client-billing-fields`, {
      method: "POST", headers: bojan,
      body: JSON.stringify({ clientBillableHours: 2.25, baseUpdatedAt: afterNotesTodo.updatedAt })
    });
    assert.equal(hours.status, 200, hours.body);
    const afterHours = JSON.parse(hours.body).todos.filter((todo) => String(todo.assignmentGroupId || todo.id) === eventId);
    assert.ok(afterHours.every((todo) => todo.clientBillableMinutes === 135));

    const forbidden = await request(port, `/api/todos/${encodeURIComponent(created.id)}/client-billing-fields`, {
      method: "POST", headers: ibro, body: JSON.stringify({ clientKm: 12 })
    });
    assert.equal(forbidden.status, 403, forbidden.body);

    const bill = await request(port, "/api/client-bills", {
      method: "POST", headers: bojan,
      body: JSON.stringify({
        clientId: created.clientId,
        clientName: created.client,
        from: "2026-08-20",
        to: "2026-08-20",
        eventIds: [eventId]
      })
    });
    assert.equal(bill.status, 201, bill.body);
    const locked = await request(port, `/api/todos/${encodeURIComponent(created.id)}/client-billing-fields`, {
      method: "POST", headers: bojan, body: JSON.stringify({ title: "Ne sme se spremeniti" })
    });
    assert.equal(locked.status, 403, locked.body);
    assert.match(JSON.parse(locked.body).error, /zaklenjen/);
  } finally {
    await stop(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
