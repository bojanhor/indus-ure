"use strict";

// Deployment smoke test for the private local video upload flow.  It verifies
// streaming upload, PostgreSQL metadata, media storage and pending-upload cleanup
// without leaving a task or a file behind.
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const path = require("path");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
const PORT = Number(process.env.PORT || 8123);
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || "/var/lib/indus-ure/media");
const OWNER_EMAIL = String(process.env.GOOGLE_DRIVE_OWNER_EMAIL || "bojan@indus.si").trim().toLowerCase();
const COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-indus-ure" : "indus-ure-session";
// The route streams the body unchanged.  A short deterministic sample is enough
// to exercise the same HTTP/storage path as a browser upload.
const SAMPLE_VIDEO = Buffer.from("INDUS-URE-local-video-upload-smoke-test-v2\n", "utf8");

function fail(message) { throw new Error(message); }
function tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }

function requestJson({ token, csrfToken, method, requestPath, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: PORT,
      method,
      path: requestPath,
      headers: {
        Cookie: COOKIE_NAME + "=" + encodeURIComponent(token),
        "X-CSRF-Token": csrfToken,
        ...headers
      },
      timeout: 60000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* handled by caller */ }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Video smoke test je vrnil HTTP ${response.statusCode || 0}: ${String(payload.error || "neveljaven odgovor").slice(0, 400)}`));
          return;
        }
        resolve(payload);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Video smoke test je potekel.")));
    request.on("error", reject);
    request.end(body || undefined);
  });
}

async function ownerFor(pool) {
  const result = await pool.query("select id, data from indus_users where lower(coalesce(data->>'email', '')) = $1 limit 1", [OWNER_EMAIL]);
  const owner = result.rows[0]?.data;
  const ownerId = String(owner?.id || result.rows[0]?.id || "");
  if (!ownerId) fail("Bojanov uporabniški račun ne obstaja.");
  return { ownerId };
}

async function main() {
  if (!DATABASE_URL) fail("Manjka DATABASE_URL za video smoke test.");
  const pool = new Pool({ connectionString: DATABASE_URL });
  let sessionHash = "";
  let attachmentId = "";
  let storedPath = "";
  try {
    const identity = await ownerFor(pool);
    const token = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(24).toString("hex");
    sessionHash = tokenHash(token);
    const session = { userId: identity.ownerId, expiresAt: Date.now() + 300000, csrfToken, smokeTest: true };
    await pool.query("insert into indus_sessions (token_hash, user_id, expires_at, data) values ($1, $2, to_timestamp($3 / 1000.0), $4::jsonb)", [sessionHash, identity.ownerId, session.expiresAt, JSON.stringify(session)]);

    const uploaded = await requestJson({
      token,
      csrfToken,
      method: "POST",
      requestPath: "/api/todos/video",
      body: SAMPLE_VIDEO,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(SAMPLE_VIDEO.length),
        "X-Indus-File-Name": encodeURIComponent("indus-ure-smoke-test.mp4")
      }
    });
    const photo = uploaded.photo || {};
    attachmentId = String(photo.attachmentId || "");
    if (!/^[a-f0-9]{64}$/.test(attachmentId) || photo.mimeType !== "video/mp4") {
      fail("API ni vrnil veljavne zasebne video priloge.");
    }
    const stored = await pool.query("select mime_type, byte_size, storage_key from indus_attachments where id = $1", [attachmentId]);
    const record = stored.rows[0];
    if (!record || String(record.mime_type) !== "video/mp4" || Number(record.byte_size) !== SAMPLE_VIDEO.length || !String(record.storage_key || "").startsWith("objects/")) {
      fail("Video ni bil pravilno zapisan v bazo prilog.");
    }
    storedPath = path.resolve(MEDIA_DIR, String(record.storage_key));
    if (!storedPath.startsWith(`${MEDIA_DIR}${path.sep}`) || !fs.existsSync(storedPath)) {
      fail("Video datoteka manjka v zasebni strežniški shrambi.");
    }
    const bytes = await fsp.readFile(storedPath);
    if (!bytes.equals(SAMPLE_VIDEO)) fail("Shranjeni video se ne ujema z naloženim vzorcem.");

    await requestJson({ token, csrfToken, method: "DELETE", requestPath: `/api/attachments/${attachmentId}/pending` });
    const removed = await pool.query("select 1 from indus_attachments where id = $1", [attachmentId]);
    if (removed.rowCount) fail("Začasna video priloga po čiščenju ostaja v bazi.");
    if (fs.existsSync(storedPath)) fail("Začasna video datoteka po čiščenju ostaja na strežniku.");
    attachmentId = "";
    process.stdout.write(JSON.stringify({ ok: true, bytes: SAMPLE_VIDEO.length, route: "/api/todos/video" }) + "\n");
  } finally {
    if (attachmentId) {
      try {
        const record = await pool.query("select storage_key from indus_attachments where id = $1", [attachmentId]);
        await pool.query("delete from indus_attachments where id = $1", [attachmentId]);
        const key = String(record.rows[0]?.storage_key || "");
        const target = key ? path.resolve(MEDIA_DIR, key) : storedPath;
        if (target && target.startsWith(`${MEDIA_DIR}${path.sep}`)) await fsp.rm(target, { force: true });
      } catch (cleanupError) {
        process.stderr.write("Testnega videa ni bilo mogoče odstraniti: " + String(cleanupError.message || cleanupError) + "\n");
      }
    }
    if (sessionHash) await pool.query("delete from indus_sessions where token_hash = $1", [sessionHash]).catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write("INDUS URE video smoke test ni uspel: " + String(error.message || error) + "\n");
  process.exitCode = 1;
});