"use strict";

const crypto = require("crypto");
const http = require("http");
const { Pool } = require("pg");
const { google } = require("googleapis");

const DATABASE_URL = process.env.DATABASE_URL || "";
const PORT = Number(process.env.PORT || 8123);
const OWNER_EMAIL = String(process.env.GOOGLE_DRIVE_OWNER_EMAIL || "bojan@indus.si").trim().toLowerCase();
const FOLDER_ID = String(process.env.GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID || "").trim();
const CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
const REDIRECT_URI = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
const COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-indus-ure" : "indus-ure-session";
const SAMPLE_VIDEO = Buffer.from("INDUS-URE-video-upload-smoke-test-v1\n", "utf8");

function fail(message) { throw new Error(message); }
function tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }

function postVideo(token, csrfToken) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: PORT,
      method: "POST",
      path: "/api/todos/drive-video",
      headers: {
        Cookie: COOKIE_NAME + "=" + encodeURIComponent(token),
        "X-CSRF-Token": csrfToken,
        "Content-Type": "video/mp4",
        "Content-Length": String(SAMPLE_VIDEO.length),
        "X-Indus-File-Name": encodeURIComponent("indus-ure-smoke-test.mp4"),
        "X-Indus-Task-Title": encodeURIComponent("Samodejni video test"),
        "X-Indus-Client": encodeURIComponent("INDUS URE")
      },
      timeout: 60000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* handled below */ }
        if (response.statusCode !== 201) {
          reject(new Error("Video smoke test je vrnil HTTP " + String(response.statusCode || 0) + ": " + String(body.error || "neveljaven odgovor").slice(0, 400)));
          return;
        }
        resolve(body.driveFile || {});
      });
    });
    request.on("timeout", () => request.destroy(new Error("Video smoke test je potekel.")));
    request.on("error", reject);
    request.end(SAMPLE_VIDEO);
  });
}

function oauthFor(tokens) {
  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  auth.setCredentials(tokens || {});
  return google.drive({ version: "v3", auth });
}

async function ownerFor(pool) {
  const result = await pool.query("select id, data from indus_users where lower(coalesce(data->>'email', '')) = $1 limit 1", [OWNER_EMAIL]);
  const owner = result.rows[0]?.data;
  const ownerId = String(owner?.id || result.rows[0]?.id || "");
  if (!ownerId || !owner?.google?.tokens || !owner?.google?.driveScopeVersion) fail("Bojanov Google Drive ni povezan.");
  return { owner, ownerId };
}

async function main() {
  if (!DATABASE_URL || !FOLDER_ID || !CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) fail("Manjkajo nastavitve za video smoke test.");
  const pool = new Pool({ connectionString: DATABASE_URL });
  let sessionHash = "";
  let fileId = "";
  let owner = null;
  try {
    const identity = await ownerFor(pool);
    owner = identity.owner;
    const token = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(24).toString("hex");
    sessionHash = tokenHash(token);
    const session = { userId: identity.ownerId, expiresAt: Date.now() + 300000, csrfToken, smokeTest: true };
    await pool.query("insert into indus_sessions (token_hash, user_id, expires_at, data) values ($1, $2, to_timestamp($3 / 1000.0), $4::jsonb)", [sessionHash, identity.ownerId, session.expiresAt, JSON.stringify(session)]);

    const uploaded = await postVideo(token, csrfToken);
    fileId = String(uploaded.fileId || "");
    if (!fileId || uploaded.kind !== "video" || uploaded.managed !== true) fail("API ni vrnil veljavne upravljane video priloge.");

    const drive = oauthFor(owner.google.tokens);
    const checked = await Promise.all([
      drive.files.get({ fileId, fields: "id,size,parents,owners(emailAddress),appProperties" }),
      drive.permissions.list({ fileId, fields: "permissions(type,role,allowFileDiscovery)" })
    ]);
    const details = checked[0].data || {};
    const permissions = checked[1].data.permissions || [];
    const ownedByBojan = (details.owners || []).some((item) => String(item.emailAddress || "").toLowerCase() === OWNER_EMAIL);
    const sharedByLink = permissions.some((item) => item.type === "anyone" && item.role === "reader" && item.allowFileDiscovery === false);
    if (Number(details.size || 0) !== SAMPLE_VIDEO.length || !(details.parents || []).includes(FOLDER_ID) || !ownedByBojan || details.appProperties?.indusResource !== "task-video-attachment" || !sharedByLink) {
      fail("Nalozenega videa ni bilo mogoce preveriti v pravilni Drive mapi, lastnistvu ali skupni rabi.");
    }
    await drive.files.delete({ fileId });
    fileId = "";
    process.stdout.write(JSON.stringify({ ok: true, bytes: SAMPLE_VIDEO.length, route: "/api/todos/drive-video" }) + "\n");
  } finally {
    if (fileId && owner?.google?.tokens) {
      try { await oauthFor(owner.google.tokens).files.delete({ fileId }); } catch (cleanupError) {
        process.stderr.write("Testnega videa ni bilo mogoce odstraniti: " + String(cleanupError.message || cleanupError) + "\n");
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
