const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("Postgres store singleton is initialized before database startup", async () => {
  const serverSource = await fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(serverSource, /let pgStore = null;/);
});

test("nepooblaščena Google prijava ima splošno zavrnitev in trajni zapis", async () => {
  const [server, store] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "postgres-store.js"), "utf8")
  ]);
  assert.match(server, /async function recordDeniedGoogleLogin\(email\)/);
  assert.match(server, /sendText\(res, 403, "Dostop je zavrnjen\.", "text\/plain"\)/);
  assert.match(server, /insert into indus_access_attempts/);
  assert.match(store, /create table if not exists indus_access_attempts/);
});

test("front-end naročila in foto urejevalnik ohranita dogovorjeni mobilni prikaz", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /function todoOrderingSort\(a, b\) \{[\s\S]*?orderedDifference/);
  assert.match(html, /ordered-confirmed/);
  assert.match(html, /photo-editor-main-tools/);
  assert.match(html, /#photoEditorDialog \{ inset: 0; width: 100vw;/);
  assert.match(html, /function attachmentLabel\(photo\) \{[\s\S]*?return "Fotografija";/);
  assert.match(html, /\$\("photoEditorTitle"\)\.textContent = "Uredi fotografijo";/);
  assert.doesNotMatch(html, /\$\("photoEditorTitle"\)\.textContent = `Uredi:/);
  assert.match(html, /photoEditorPendingActions/);
  assert.match(html, /function confirmPhotoEditorPendingOperation\(\)/);
  assert.match(html, /function cancelPhotoEditorPendingOperation\(\)/);
  assert.match(html, /function beginPhotoEditorPinch\(editor, shell\)/);
  assert.match(html, /lostpointercapture/);
  assert.doesNotMatch(html, /photoEditorCropActions|photoEditorApplyCrop|photoEditorCancelCrop/);
  assert.match(html, /todoFormFooterActions/);
  assert.match(html, /function autosizeTodoNarrativeFields\(\)/);
  assert.match(html, /function dayTimelineDragAutoScrollVelocity\(clientY\)/);
  assert.match(html, /todoTextOrderMarker/);
  assert.match(html, /id="activeWorkContext"/);
  assert.match(html, /todoSectionCollapseStorageKey/);
  assert.match(html, /todo-order-section-toggle/);
  assert.match(html, /#todoFormNotes,[\s\S]*?#todoFormMaterial \{[\s\S]*?overflow-y: hidden;/);
  assert.match(html, /function autosizeTodoNarrativeFields\(\) \{[\s\S]*?field\.style\.height = "0px";[\s\S]*?field\.scrollHeight/);
  assert.match(html, /autosizeTodoNarrativeFieldsAfterLayout\(\);/);
  assert.match(html, /id="serverStatusBtn"/);
  assert.match(html, /id="serverStatusDialog"/);
  assert.match(html, /todo-card-badges/);
  assert.match(html, /todo-card-header/);
  assert.match(html, /todo-ordering-chip/);
  assert.match(html, /\.todo-card-badges \.todo-chip \{\s*min-height: 38px;/);
  assert.match(html, /\.todo-title-row \.todo-tools \{[\s\S]*?flex-direction: column;/);
  assert.match(html, /\.main,\s*\.sidebar \{ padding: 8px; \}/);
  assert.match(html, /\.todo-title-row \.todo-client-name \{[\s\S]*?flex: 1 1 0;/);
  assert.doesNotMatch(html, /serverStatusPanel/);
});
test("obračunsko obdobje samodejno sledi novemu dnevu, ročna izbira pa ostane ločena po delavcu", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /billingRangeSelections: \{\}/);
  assert.match(html, /function billingRangeSelectionForWorker\(workerId\)/);
  assert.match(html, /function billingTodayKey\(now = new Date\(\)\)/);
  assert.doesNotMatch(html, /billingYesterdayKey/);
  assert.match(html, /openCoversNewestRange/);
  assert.match(html, /function staleOpenBillingPayroll\(workerId\)/);
  assert.match(html, /billingStaleDraftNotice/);
  assert.match(html, /function lockedBillingFinancialIds\(workerId, field\)/);
  assert.match(html, /const from = previous \? previous\.to/);
  assert.match(html, /saveBillingRangeSelection\(billingWorkerId\(\), \{ from: \$\("billingFrom"\)\.value, to: \$\("billingTo"\)\.value \}\);/);
  assert.match(html, /saveBillingRangeSelection\(state\.billingWorkerId, \{ from: button\.dataset\.from, to: button\.dataset\.to \}\);/);
});
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

test("HTML shell has a strict nonce CSP and PWA endpoints", { timeout: 15_000 }, async () => {
  const port = 18200 + Math.floor(Math.random() * 700);
  const dataDir = path.join(os.tmpdir(), `indus-ure-http-test-${process.pid}-${Date.now()}`);
  const child = spawn(process.execPath, ["outputs/server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: "development" },
    stdio: ["ignore", "ignore", "ignore"]
  });
  try {
    let health = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        health = await request(port, "/api/health");
        if (health.status === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health?.status, 200);
    const page = await request(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"] || "", /script-src 'self' 'nonce-/);
    assert.doesNotMatch(page.headers["content-security-policy"] || "", /unsafe-inline/);
    const nonce = /<script nonce="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(nonce);
    const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(page.body, new RegExp(`<style nonce="${escapedNonce}"`));
    const worker = await request(port, "/service-worker.js");
    assert.equal(worker.status, 200);
    assert.equal(worker.headers["cache-control"], "no-cache");
  } finally {
    child.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
test("lokalna testna instanca omogoča ločeno prijavo samo v testnem načinu", { timeout: 15_000 }, async () => {
  const port = 18900 + Math.floor(Math.random() * 700);
  const dataDir = path.join(os.tmpdir(), `indus-ure-test-login-${process.pid}-${Date.now()}`);
  const password = "test-only-local-password-123";
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
    let health = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        health = await request(port, "/api/health");
        if (health.status === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health?.status, 200);
    const mode = await request(port, "/api/test-mode");
    assert.deepEqual(JSON.parse(mode.body), { enabled: true, localNetwork: "192.168.50.0/24" });
    const denied = await request(port, "/api/test-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "bojan", password: "wrong-password" })
    });
    assert.equal(denied.status, 401);
    const login = await request(port, "/api/test-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "bojan", password })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"]?.[0];
    assert.match(cookie || "", /indus-ure-session=/);
    const me = await request(port, "/api/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.equal(JSON.parse(me.body).user.id, "bojan");
  } finally {
    child.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("completion request UI and authenticated link flow are present", async () => {
  const [server, html] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8")
  ]);
  assert.match(server, /TODO_COMPLETION_REQUEST_TTL_MS/);
  assert.match(server, /\/completion-request\$/);
  assert.match(server, /gmailCompletionRequestRaw/);
  assert.match(html, /id="completionRequestDialog"/);
  assert.match(html, /function openCompletionRequestFromLink\(\)/);
  assert.match(html, /requestTodoCompletion/);
  assert.match(html, /params\.set\("return_to", returnTo\)/);
});