"use strict";

// Regression test for the staged local-video flow. A video is uploaded before
// its task is saved, so only its uploader may preview it during that short
// pending period. The test uses an actual 8 MiB stream and removes all data.
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const REPO_ROOT = path.resolve(__dirname, "..");
const TEST_PASSWORD = "pending-video-preview-test-password-2026";
const SAMPLE_BYTES = 8 * 1024 * 1024;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, pathname, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: Number(res.statusCode || 0), headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error("Video regression test je potekel.")));
    req.on("error", reject);
    req.end(body || undefined);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function startTestApp() {
  const port = await reservePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "indus-ure-pending-video-"));
  let output = "";
  const child = spawn(process.execPath, ["outputs/server.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      INDUS_URE_TEST_MODE: "true",
      TEST_LOCAL_LOGIN_PASSWORD: TEST_PASSWORD,
      DATA_DIR: dataDir,
      MEDIA_DIR: path.join(dataDir, "media"),
      DATABASE_URL: "",
      DISABLE_OPERATIONAL_MONITOR: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const append = (chunk) => { output = (output + String(chunk)).slice(-6_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Testni strežnik se je ustavil: " + output);
    try {
      const health = await request(port, "/api/health");
      if (health.status === 200) return { port, dataDir, child };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopChild(child);
  await fs.rm(dataDir, { recursive: true, force: true });
  throw new Error("Testni strežnik se ni zagnal: " + output);
}

async function localLogin(port, userId) {
  const response = await request(port, "/api/test-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: Buffer.from(JSON.stringify({ userId, password: TEST_PASSWORD }))
  });
  assert.equal(response.status, 200, response.body.toString("utf8"));
  const cookie = response.headers["set-cookie"]?.[0] || "";
  assert.match(cookie, /indus-ure-session=/);
  return { cookie, csrfToken: JSON.parse(response.body.toString("utf8")).csrfToken };
}

async function main() {
  let app;
  try {
    app = await startTestApp();
    const [ibro, bojan] = await Promise.all([localLogin(app.port, "ibro"), localLogin(app.port, "bojan")]);
    const sample = Buffer.alloc(SAMPLE_BYTES, 0x56);
    const upload = await request(app.port, "/api/todos/video", {
      method: "POST",
      headers: {
        Cookie: ibro.cookie,
        "X-CSRF-Token": ibro.csrfToken,
        "Content-Type": "video/mp4",
        "Content-Length": String(sample.length),
        "X-Indus-File-Name": encodeURIComponent("video-preview-smoke.mp4")
      },
      body: sample
    });
    assert.equal(upload.status, 201, upload.body.toString("utf8"));
    const photo = JSON.parse(upload.body.toString("utf8")).photo;
    assert.match(String(photo?.url || ""), /^\/api\/attachments\/[a-f0-9]{64}$/);

    const pendingDb = JSON.parse(await fs.readFile(path.join(app.dataDir, "db.json"), "utf8"));
    assert.equal(pendingDb.settings?.pendingAttachments?.[photo.attachmentId]?.userId, "ibro");

    const ownerPreview = await request(app.port, photo.url, { headers: { Cookie: ibro.cookie } });
    assert.equal(ownerPreview.status, 200, ownerPreview.body.toString("utf8"));
    assert.deepEqual(ownerPreview.body, sample);

    const otherPreview = await request(app.port, photo.url, { headers: { Cookie: bojan.cookie } });
    assert.equal(otherPreview.status, 404, "Drug uporabnik ne sme videti začasnega videa.");

    const cleanup = await request(app.port, photo.url + "/pending", {
      method: "DELETE",
      headers: { Cookie: ibro.cookie, "X-CSRF-Token": ibro.csrfToken }
    });
    assert.equal(cleanup.status, 200, cleanup.body.toString("utf8"));
    const afterCleanup = await request(app.port, photo.url, { headers: { Cookie: ibro.cookie } });
    assert.equal(afterCleanup.status, 404, "Začasni video mora po čiščenju izginiti.");

    process.stdout.write(JSON.stringify({ ok: true, uploadedBytes: sample.length, ownerPreview: ownerPreview.status, otherUserPreview: otherPreview.status }) + "\n");
  } finally {
    if (app) {
      await stopChild(app.child);
      await fs.rm(app.dataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write("Pending video preview test ni uspel: " + String(error.stack || error) + "\n");
  process.exitCode = 1;
});
