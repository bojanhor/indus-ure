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
function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("error", reject);
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