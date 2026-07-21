const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const PDFDocument = require("pdfkit");
const { PostgresStore } = require("./postgres-store");
const {
  isUsableTaxId,
  normalizeStoredClient,
  normalizeTaxId
} = require("./client-identity");

const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || "127.0.0.1";
const NODE_ENV = process.env.NODE_ENV || "development";
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const root = __dirname;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const dbFile = path.join(dataDir, "db.json");
const MEDIA_DIR = process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : path.join(dataDir, "media");
const DATABASE_URL = process.env.DATABASE_URL || "";
const configuredBojanPassword = process.env.INITIAL_BOJAN_PASSWORD || "";
const configuredIbroPassword = process.env.INITIAL_IBRO_PASSWORD || "";
const initialBojanPassword = configuredBojanPassword || crypto.randomBytes(24).toString("hex");
const initialIbroPassword = configuredIbroPassword || crypto.randomBytes(24).toString("hex");
const resetUserPasswords = process.env.RESET_USER_PASSWORDS === "true";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
// Bump this whenever the Google Workspace consent set changes. A stale Drive-only
// token must never be silently reused for creating Gmail drafts. It remains valid
// for Drive uploads, though: Drive attachment uploads must not be blocked merely
// because the optional Gmail consent was added later.
const GOOGLE_DRIVE_SCOPE_VERSION = 2;
const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const GOOGLE_DRIVE_TASKS_FOLDER_ID = String(process.env.GOOGLE_DRIVE_TASKS_FOLDER_ID || "").trim();
const GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID = String(process.env.GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID || "").trim();
const GOOGLE_DRIVE_OWNER_EMAIL = String(process.env.GOOGLE_DRIVE_OWNER_EMAIL || "bojan@indus.si").trim().toLowerCase();
const INDUS_GOOGLE_APP_ID = "indus-ure-v1";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = NODE_ENV === "production" ? "__Host-indus-ure" : "indus-ure-session";
const ALERT_SMTP_URL = String(process.env.ALERT_SMTP_URL || "").trim();
const ALERT_EMAIL_FROM = String(process.env.ALERT_EMAIL_FROM || "").trim();
const ALERT_EMAIL_TO = String(process.env.ALERT_EMAIL_TO || "bojan@indus.si").trim();
const MONITOR_INTERVAL_MS = Math.max(60_000, Number(process.env.MONITOR_INTERVAL_MS || 5 * 60_000));
const ARCHIVE_RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MONITOR_MAX_RSS_MB = Math.max(256, Number(process.env.MONITOR_MAX_RSS_MB || 1_800));
const REPORT_PDF_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const REPORT_GMAIL_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const REPORT_GMAIL_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
let pgPool = null;
let pgStore = null;
let pgReady = null;
let mutationQueue = Promise.resolve();
let monitorTimer = null;
let alertTransport = null;
const monitorAlertCooldowns = new Map();
let archiveRetentionCleanupLastAt = 0;
let archiveRetentionCleanupPromise = null;

const TODO_STATUS_DEFINITIONS = Object.freeze({
  open: { label: "Čaka", googleColorId: "8" },
  in_progress: { label: "V teku", googleColorId: "9" },
  execution: { label: "Zaklju\u010deno", googleColorId: "10" },
  order: { label: "Naroči", googleColorId: "11" },
  order_car: { label: "Naroči Avto", googleColorId: "11" },
  order_warehouse: { label: "Naroči Sklad.", googleColorId: "11" },
  add_to_car: { label: "Dodaj v avto", googleColorId: "4" },
  ordered: { label: "Naro\u010deno", googleColorId: "7" },
  return_and_bill: { label: "Vrne naj/Poračunaj", googleColorId: "6" },
  return: { label: "!!Vrni", googleColorId: "3" },
  meal: { label: "Malica", googleColorId: "5" },
  internal: { label: "Razno/Interno", googleColorId: "5" },
  drive: { label: "Vožnja", googleColorId: "7" },
  purchase: { label: "Nabava", googleColorId: "6" }
});
const TODO_STATUSES = new Set(Object.keys(TODO_STATUS_DEFINITIONS));
const TIME_ENTRY_TODO_STATUSES = new Set(["execution", "meal", "drive", "purchase"]);
const TODO_VEHICLES = new Set(["personal", "van"]);

function todoVehicle(value) {
  const vehicle = String(value || "");
  return TODO_VEHICLES.has(vehicle) ? vehicle : "personal";
}

const IMAGE_SIGNATURES = {
  png: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  webp: (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP"
};
const MAX_TODO_IMAGE_DATA_LENGTH = 700_000;
const MAX_TODO_PDF_DATA_LENGTH = 2_100_000;
const MAX_TODO_ATTACHMENTS_DATA_LENGTH = 5_000_000;
const MAX_TODO_THUMBNAIL_DATA_LENGTH = 100_000;
// Video is streamed to the application's private media storage. Keep a finite
// limit so a slow or malicious upload cannot exhaust the server disk.
const MAX_VIDEO_BYTES = Math.min(500 * 1024 * 1024, Math.max(20 * 1024 * 1024, Number(process.env.MAX_VIDEO_BYTES || process.env.MAX_DRIVE_VIDEO_BYTES || 200 * 1024 * 1024)));
const PENDING_ATTACHMENT_TTL_MS = 12 * 60 * 60 * 1000;


function validImageDataUrl(value, maxEncodedLength) {
  if (typeof value !== "string" || value.length > maxEncodedLength) return false;
  const match = value.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  const type = match[1] === "jpg" ? "jpeg" : match[1];
  try {
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || !IMAGE_SIGNATURES[type]?.(buffer)) return false;
    return buffer.toString("base64").replace(/=+$/, "") === match[2].replace(/=+$/, "");
  } catch {
    return false;
  }
}

function validPdfDataUrl(value, maxEncodedLength = MAX_TODO_PDF_DATA_LENGTH) {
  if (typeof value !== "string" || value.length > maxEncodedLength) return false;
  const match = value.match(/^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  try {
    const buffer = Buffer.from(match[1], "base64");
    if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") return false;
    return buffer.toString("base64").replace(/=+$/, "") === match[1].replace(/=+$/, "");
  } catch {
    return false;
  }
}

function validTodoAttachmentDataUrl(value) {
  return validImageDataUrl(value, MAX_TODO_IMAGE_DATA_LENGTH) || validPdfDataUrl(value);
}

function validTodoThumbnailDataUrl(value) {
  return validImageDataUrl(value, MAX_TODO_THUMBNAIL_DATA_LENGTH);
}

function limitTodoAttachmentsData(items) {
  let total = 0;
  return items.filter((item) => {
    const length = String(item.data || "").length;
    if (total + length > MAX_TODO_ATTACHMENTS_DATA_LENGTH) return false;
    total += length;
    return true;
  });
}

function validTodoAttachmentId(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function validGoogleDriveId(value) {
  return /^[A-Za-z0-9_-]{10,200}$/.test(String(value || ""));
}

function googleDriveFileInfo(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    if (url.hostname === "docs.google.com") {
      const match = url.pathname.match(/^\/(document|spreadsheets)\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/);
      if (!match) return null;
      return {
        kind: match[1] === "document" ? "document" : "spreadsheet",
        fileId: match[2],
        url: url.toString()
      };
    }
    if (url.hostname === "drive.google.com") {
      const direct = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/);
      const fileId = direct?.[1] || (url.pathname === "/open" ? url.searchParams.get("id") : "");
      if (!validGoogleDriveId(fileId)) return null;
      return { kind: "video", fileId, url: url.toString() };
    }
    return null;
  } catch {
    return null;
  }
}

// Kept for callers that deliberately accept only a Google Doc or Sheet pasted by a user.
function googleWorkspaceFileInfo(value) {
  const info = googleDriveFileInfo(value);
  return info?.kind === "video" ? null : info;
}

function googleDriveDefaultName(kind) {
  if (kind === "spreadsheet") return "Google Preglednica";
  if (kind === "video") return "Video";
  return "Google Dokument";
}

function cleanTodoDriveFiles(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).map((item) => {
    const info = googleWorkspaceFileInfo(item?.url);
    if (!info || seen.has(info.fileId)) return null;
    seen.add(info.fileId);
    return {
      id: String(item?.id || crypto.randomUUID()).slice(0, 100),
      kind: info.kind,
      fileId: info.fileId,
      url: info.url,
      name: String(item?.name || googleDriveDefaultName(info.kind)).trim().slice(0, 180),
      mimeType: "",
      managed: false,
      ownerEmail: "",
      createdBy: String(item?.createdBy || "").slice(0, 100),
      createdByName: String(item?.createdByName || "").slice(0, 120),
      createdAt: String(item?.createdAt || new Date().toISOString()).slice(0, 40)
    };
  }).filter(Boolean).slice(0, 12);
}
function stampTodoDriveFiles(todo, user) {
  return (todo.driveFiles || []).map((file) => ({
    ...file,
    createdBy: file.createdBy || user.id,
    createdByName: file.createdByName || user.name,
    createdAt: file.createdAt || new Date().toISOString()
  }));
}

function todoAttachmentContentId(data) {
  const encoded = String(data || "").split(",", 2)[1] || "";
  const bytes = Buffer.from(encoded, "base64");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pendingAttachmentMap(db) {
  if (!db.settings || typeof db.settings !== "object" || Array.isArray(db.settings)) db.settings = {};
  const source = db.settings.pendingAttachments && typeof db.settings.pendingAttachments === "object"
    ? db.settings.pendingAttachments
    : {};
  const now = Date.now();
  const pending = Object.fromEntries(Object.entries(source)
    .filter(([id, item]) => validTodoAttachmentId(id) && item && Number(item.expiresAt) > now && String(item.userId || ""))
    .map(([id, item]) => [id, { userId: String(item.userId), expiresAt: Number(item.expiresAt) }]));
  db.settings.pendingAttachments = pending;
  return pending;
}

function storeTodoAttachments(db, todo, user = {}) {
  if (!db.attachments || typeof db.attachments !== "object" || Array.isArray(db.attachments)) db.attachments = {};
  const pending = pendingAttachmentMap(db);
  const photos = (todo.photos || []).map((photo) => {
    const data = String(photo.data || "");
    const thumbnailData = String(photo.thumbnailData || "");
    const requestedAttachmentId = String(photo.attachmentId || "");
    const staged = pending[requestedAttachmentId];
    let attachmentId = validTodoAttachmentId(requestedAttachmentId) && db.attachments[requestedAttachmentId]
      && (!staged || staged.userId === user.id)
      ? requestedAttachmentId
      : "";
    if (validTodoAttachmentDataUrl(data)) {
      attachmentId = todoAttachmentContentId(data);
      if (!db.attachments[attachmentId]) {
        db.attachments[attachmentId] = {
          id: attachmentId,
          data,
          thumbnailData: validTodoThumbnailDataUrl(thumbnailData) ? thumbnailData : "",
          createdBy: photo.createdBy || user.id || "system",
          createdByName: photo.createdByName || user.name || "",
          createdAt: photo.createdAt || new Date().toISOString()
        };
      }
    }
    if (!attachmentId) return null;
    if (validTodoThumbnailDataUrl(thumbnailData) && !db.attachments[attachmentId].thumbnailData) {
      db.attachments[attachmentId].thumbnailData = thumbnailData;
    }
    if (pending[attachmentId]?.userId === user.id) delete pending[attachmentId];
    return {
      id: photo.id || crypto.randomUUID(),
      attachmentId,
      name: String(photo.name || "priloga").slice(0, 120),
      comment: String(photo.comment || "").trim().slice(0, 500),
      createdBy: photo.createdBy || user.id || "system",
      createdByName: photo.createdByName || user.name || "",
      createdAt: photo.createdAt || new Date().toISOString()
    };
  }).filter(Boolean).slice(0, 8);
  return { ...todo, photos };
}

function attachmentApiUrl(attachmentId, thumbnail = false) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}${thumbnail ? "/thumbnail" : ""}`;
}

function hydrateTodoAttachments(db, todo) {
  return {
    ...todo,
    photos: (todo.photos || []).map((photo) => {
      const attachment = db.attachments?.[photo.attachmentId] || {};
      const data = String(photo.data || attachment.data || "");
      const thumbnailData = String(photo.thumbnailData || attachment.thumbnailData || "");
      const hasStoredOriginal = Boolean(attachment.storageKey);
      const hasStoredThumbnail = Boolean(attachment.thumbnailKey);
      return {
        ...photo,
        data,
        thumbnailData,
        url: hasStoredOriginal ? attachmentApiUrl(photo.attachmentId) : "",
        thumbnailUrl: hasStoredThumbnail ? attachmentApiUrl(photo.attachmentId, true) : "",
        mimeType: String(attachment.mimeType || "")
      };
    }).filter((photo) => validTodoAttachmentDataUrl(photo.data) || Boolean(photo.url))
  };
}

function pruneUnusedTodoAttachments(db) {
  const pending = new Set(Object.keys(pendingAttachmentMap(db)));
  const used = new Set([
    ...(db.todos || []).flatMap((todo) => (todo.photos || []).map((photo) => photo.attachmentId)),
    ...(db.debts || []).flatMap((debt) => (debt.photos || []).map((photo) => photo.attachmentId))
  ].filter(validTodoAttachmentId));
  let changed = false;
  for (const attachmentId of Object.keys(db.attachments || {})) {
    if (used.has(attachmentId) || pending.has(attachmentId)) continue;
    delete db.attachments[attachmentId];
    changed = true;
  }
  return changed;
}
function pruneUnusedAdHocClients(db) {
  const used = new Set();
  for (const item of [...(db.todos || []), ...(db.entries || [])]) {
    const clientId = String(item?.clientId || "").trim();
    const clientName = String(item?.client || "").trim().toLowerCase();
    if (clientId) used.add(`id:${clientId}`);
    if (clientName) used.add(`name:${clientName}`);
  }
  const previous = Array.isArray(db.clients) ? db.clients : [];
  const retained = previous.filter((client) => {
    if (client?.source !== "ad-hoc") return true;
    const clientId = String(client.clientId || client.id || "").trim();
    const names = [client.name, client.search].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
    return (clientId && used.has(`id:${clientId}`)) || names.some((name) => used.has(`name:${name}`));
  });
  if (retained.length === previous.length) return false;
  db.clients = retained;
  return true;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.includes(":")) return String(password) === String(stored);
  const [salt, hash] = stored.split(":");
  return hashPassword(password, salt) === `${salt}:${hash}`;
}

function configuredPasswordForUser(id) {
  if (id === "bojan") return configuredBojanPassword;
  if (id === "ibro") return configuredIbroPassword;
  return "";
}

function googleReady() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

const defaultUsers = {
  bojan: {
    id: "bojan",
    email: "bojan@indus.si",
    name: "Bojan",
    role: "boss",
    passwordHash: hashPassword(initialBojanPassword),
    avatar: ""
  },
  ibro: {
    id: "ibro",
    email: "ibrahim.etemaj04@gmail.com",
    name: "Ibro",
    role: "worker",
    passwordHash: hashPassword(initialIbroPassword),
    avatar: ""
  }
};

const pendingGoogleLogins = new Map();
const pendingGoogleConnections = new Map();
const ENTRY_EDIT_LOCK_TTL_MS = 90_000;
const entryEditLocks = new Map();
const TODO_EDIT_LOCK_TTL_MS = 90_000;
const todoEditLocks = new Map();

function allowedGoogleUsers(db) {
  return Object.values(db.users || {}).filter((user) => user.email);
}

function userByEmail(db, email) {
  const normalized = String(email || "").toLowerCase();
  return allowedGoogleUsers(db).find((user) => String(user.email || "").toLowerCase() === normalized);
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createSession(db, userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString("hex");
  if (!db.sessions || typeof db.sessions !== "object" || Array.isArray(db.sessions)) db.sessions = {};
  for (const [hash, session] of Object.entries(db.sessions)) {
    if (!session || Number(session.expiresAt) <= now) delete db.sessions[hash];
  }
  db.sessions[sessionTokenHash(token)] = {
    userId,
    expiresAt: now + SESSION_TTL_MS,
    csrfToken: crypto.randomBytes(24).toString("hex")
  };
  return token;
}

function sessionForToken(db, token, now = Date.now()) {
  if (!token) return null;
  const session = db.sessions?.[sessionTokenHash(token)];
  if (!session || Number(session.expiresAt) <= now) return null;
  return session;
}

function revokeSession(db, token) {
  if (!token || !db.sessions) return false;
  return delete db.sessions[sessionTokenHash(token)];
}

function requestCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { return [key, decodeURIComponent(value)]; } catch { return [key, ""]; }
  }).filter(([key]) => key));
}

function sessionCookieValue(req) {
  return requestCookies(req)[SESSION_COOKIE_NAME] || "";
}

function setSessionCookie(req, res, token) {
  const secure = NODE_ENV === "production" || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const secure = NODE_ENV === "production" || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
  const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function isUnsafeRequest(req) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase());
}

function validCsrf(req, session) {
  if (!isUnsafeRequest(req)) return true;
  const actual = String(req.headers["x-csrf-token"] || "");
  const expected = String(session?.csrfToken || "");
  if (!actual || !expected || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function normalizeGoogleState(value) {
  const source = value && typeof value === "object" ? value : {};
  const state = {
    tokens: source.tokens || null,
    connectedAt: String(source.connectedAt || ""),
    driveScopeVersion: Number(source.driveScopeVersion || 0)
  };
  let changed = JSON.stringify(source) !== JSON.stringify(state);
  const legacyCalendarConnection = Number(source.scopeVersion || 0) !== 0
    || Boolean(source.calendarId || source.calendarName || source.archiveCalendarId || source.archiveCalendarName || source.syncToken);
  if (legacyCalendarConnection) {
    state.tokens = null;
    state.connectedAt = "";
    state.driveScopeVersion = 0;
    changed = true;
  }

  return { state, changed };
}
function normalizeDb(db = {}) {
  let changed = false;

  if (!db.users) {
    db.users = defaultUsers;
    changed = true;
  }

  for (const [id, user] of Object.entries(defaultUsers)) {
    if (!db.users[id]) {
      db.users[id] = user;
      changed = true;
    } else if (!db.users[id].passwordHash && db.users[id].password) {
      db.users[id].passwordHash = hashPassword(db.users[id].password);
      delete db.users[id].password;
      changed = true;
    }
    if (!db.users[id].email) {
      db.users[id].email = user.email;
      changed = true;
    }
    const normalizedGoogle = normalizeGoogleState(db.users[id].google);
    db.users[id].google = normalizedGoogle.state;
    if (normalizedGoogle.changed) changed = true;
    if (db.users[id].avatar && !validImageDataUrl(db.users[id].avatar, 1_500_000)) {
      db.users[id].avatar = "";
      changed = true;
    }
    if (resetUserPasswords) {
      const configuredPassword = id === "bojan" ? configuredBojanPassword : configuredIbroPassword;
      if (configuredPassword) {
        db.users[id].passwordHash = hashPassword(configuredPassword);
        delete db.users[id].password;
        changed = true;
      }
    }
  }

  for (const [id, user] of Object.entries(db.users)) {
    if (Object.hasOwn(defaultUsers, id)) continue;
    if (!user || typeof user !== "object") {
      delete db.users[id];
      changed = true;
      continue;
    }
    if (user.id !== id) {
      user.id = id;
      changed = true;
    }
    if (!user.name) {
      user.name = id;
      changed = true;
    }
    if (!["boss", "worker"].includes(user.role)) {
      user.role = "worker";
      changed = true;
    }
    const normalizedGoogle = normalizeGoogleState(user.google);
    user.google = normalizedGoogle.state;
    if (normalizedGoogle.changed) changed = true;
    if (user.avatar && !validImageDataUrl(user.avatar, 1_500_000)) {
      user.avatar = "";
      changed = true;
    }
  }

  if (!db.sessions || typeof db.sessions !== "object" || Array.isArray(db.sessions)) {
    db.sessions = {};
    changed = true;
  }
  for (const [hash, session] of Object.entries(db.sessions)) {
    const valid = /^[a-f0-9]{64}$/.test(hash)
      && session && typeof session === "object"
      && Boolean(db.users[session.userId])
      && Number.isFinite(Number(session.expiresAt));
    if (!valid) {
      delete db.sessions[hash];
      changed = true;
    }
  }

  if (!Array.isArray(db.entries)) {
    db.entries = [];
    changed = true;
  }

  if (!Array.isArray(db.todos)) {
    db.todos = [];
    changed = true;
  }

  if (!db.attachments || typeof db.attachments !== "object" || Array.isArray(db.attachments)) {
    db.attachments = {};
    changed = true;
  }

  if (!Array.isArray(db.debts)) {
    db.debts = [];
    changed = true;
  }

  if (!Array.isArray(db.billingLocks)) {
    db.billingLocks = [];
    changed = true;
  }

  if (!Array.isArray(db.payrolls)) {
    db.payrolls = [];
    changed = true;
  }

  if (!Array.isArray(db.clientBills)) {
    db.clientBills = [];
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(db, "appIssues")) {
    delete db.appIssues;
    changed = true;
  }

  if (!db.settings || typeof db.settings !== "object") {
    db.settings = {};
    changed = true;
  }
  if (!db.settings.billing || typeof db.settings.billing !== "object") {
    db.settings.billing = {};
    changed = true;
  }
  const legacyKmRate = nonnegativeNumber(db.settings.billing?.kmRate, 0.22, 1_000);
  db.settings.billing = {
    ...db.settings.billing,
    hourlyRate: nonnegativeNumber(db.settings.billing?.hourlyRate, 15, 10_000),
    // Stara enotna tarifa se uporabi samo za prehod ob nadgradnji.
    kmRate: legacyKmRate,
    workerOwnVehicleKmRate: nonnegativeNumber(db.settings.billing?.workerOwnVehicleKmRate, legacyKmRate, 1_000),
    commuteKmPerDay: nonnegativeNumber(db.settings.billing?.commuteKmPerDay, 28, 1_000_000),
    mealPaidMinutes: Math.round(nonnegativeNumber(db.settings.billing?.mealPaidMinutes, 45, 240))
  };
  if (!db.settings.archive || typeof db.settings.archive !== "object") {
    db.settings.archive = {};
    changed = true;
  }
  const archiveRetentionMonths = Math.min(120, Math.max(1, Math.round(nonnegativeNumber(db.settings.archive?.retentionMonths, 12, 120))));
  if (db.settings.archive.retentionMonths !== archiveRetentionMonths) changed = true;
  db.settings.archive = { ...db.settings.archive, retentionMonths: archiveRetentionMonths };
  for (const user of Object.values(db.users)) {
    const currentRate = nonnegativeNumber(user.billing?.hourlyRate, null, 10_000);
    const exportTitle = String(user.billing?.exportTitle || "").trim().slice(0, 120);
    if (!user.billing || currentRate === null || user.billing.exportTitle !== exportTitle) {
      user.billing = { ...(user.billing || {}), hourlyRate: currentRate ?? db.settings.billing.hourlyRate, exportTitle };
      changed = true;
    } else {
      user.billing.hourlyRate = currentRate;
    }
  }

  if (!Array.isArray(db.clients)) {
    db.clients = [];
    changed = true;
  }

  const clientsBeforeNormalization = JSON.stringify(db.clients);
  const normalizedClients = db.clients
    .map((client) => normalizeStoredClient(client))
    .filter((client) => client.name);
  const clientsById = new Map();
  normalizedClients.forEach((client) => {
    if (!clientsById.has(client.clientId)) clientsById.set(client.clientId, client);
  });
  db.clients = [...clientsById.values()];
  if (JSON.stringify(db.clients) !== clientsBeforeNormalization) {
    changed = true;
  }

  const clientByText = new Map();
  for (const client of db.clients) {
    [client.clientId, client.name, client.search, client.taxId].filter(Boolean).forEach((value) => {
      clientByText.set(String(value).toLowerCase(), client);
    });
  }
  const resolveClient = (value) => clientByText.get(String(value || "").trim().toLowerCase());

  if (!db.calendarToken || String(db.calendarToken).length < 24) {
    db.calendarToken = crypto.randomBytes(24).toString("hex");
    changed = true;
  }
  if (!db.calendarFeeds || typeof db.calendarFeeds !== "object") {
    db.calendarFeeds = {};
    changed = true;
  }
  for (const userId of Object.keys(db.users || {})) {
    if (!db.calendarFeeds[userId] || String(db.calendarFeeds[userId]).length < 24) {
      db.calendarFeeds[userId] = crypto.randomBytes(24).toString("hex");
      changed = true;
    }
  }
  if (!db.calendarFeeds.bossCombined || String(db.calendarFeeds.bossCombined).length < 24) {
    db.calendarFeeds.bossCombined = db.calendarToken;
    changed = true;
  }

  db.entries = db.entries.map((entry) => {
    const next = { ...entry };
    if (next.createdBy === "delavec") {
      next.createdBy = "ibro";
      next.createdByName = "Ibro";
      changed = true;
    }
    if (next.updatedBy === "delavec") {
      next.updatedBy = "ibro";
      next.updatedByName = "Ibro";
      changed = true;
    }
    if (next.createdBy === "sef") {
      next.createdBy = "bojan";
      next.createdByName = "Bojan";
      changed = true;
    }
    if (next.updatedBy === "sef") {
      next.updatedBy = "bojan";
      next.updatedByName = "Bojan";
      changed = true;
    }
    if (!Array.isArray(next.history)) {
      next.history = [];
      changed = true;
    }
    if (typeof next.people !== "string") {
      next.people = "";
      changed = true;
    }
    if (!next.syncUser) {
      next.syncUser = next.createdBy || "ibro";
      changed = true;
    }
    if (typeof next.googleEventId !== "string") {
      next.googleEventId = "";
      changed = true;
    }
    if (typeof next.googleUpdatedAt !== "string") {
      next.googleUpdatedAt = "";
      changed = true;
    }
    if (typeof next.googleSyncedLocalAt !== "string") {
      next.googleSyncedLocalAt = next.updatedAt || next.createdAt || "";
      changed = true;
    }
    if (typeof next.googleManagedByIndus !== "boolean") {
      next.googleManagedByIndus = false;
      changed = true;
    }
    if (typeof next.invoiceSent !== "boolean") {
      next.invoiceSent = false;
      changed = true;
    }
    if (typeof next.invoiceSettled !== "boolean") {
      next.invoiceSettled = false;
      changed = true;
    }
    if (typeof next.invoicePaid !== "boolean") {
      next.invoicePaid = false;
      changed = true;
    }
    if (typeof next.fromHome !== "boolean") {
      next.fromHome = false;
      changed = true;
    }
    if (next.clientId || next.client) {
      const client = resolveClient(next.clientId) || resolveClient(next.client);
      if (client?.clientId && (next.clientId !== client.clientId || next.client !== client.name)) {
        next.clientId = client.clientId;
        next.client = client.name;
        changed = true;
      }
    }
    if (typeof next.sourceTodoId !== "string") {
      next.sourceTodoId = "";
      changed = true;
    }
    return next;
  });

  db.billingLocks = db.billingLocks.map((lock) => ({
    id: lock.id || crypto.randomUUID(),
    from: String(lock.from || ""),
    to: String(lock.to || ""),
    note: String(lock.note || ""),
    createdBy: lock.createdBy || "system",
    createdByName: lock.createdByName || "",
    createdAt: lock.createdAt || new Date().toISOString()
  })).filter((lock) => /^\d{4}-\d{2}-\d{2}$/.test(lock.from) && /^\d{4}-\d{2}-\d{2}$/.test(lock.to));

  const payrollsBeforeNormalization = JSON.stringify(db.payrolls);
  db.payrolls = db.payrolls.map((payroll) => normalizePayroll(payroll, db)).filter(Boolean);
  if (JSON.stringify(db.payrolls) !== payrollsBeforeNormalization) changed = true;

  const clientBillsBeforeNormalization = JSON.stringify(db.clientBills);
  db.clientBills = db.clientBills.map((bill) => normalizeClientBill(bill, db)).filter(Boolean);
  if (JSON.stringify(db.clientBills) !== clientBillsBeforeNormalization) changed = true;

  db.todos = db.todos.map((todo, index) => {
    const next = { ...todo };
    const assignmentGroupId = String(next.assignmentGroupId || next.id || crypto.randomUUID()).trim();
    if (next.assignmentGroupId !== assignmentGroupId) {
      next.assignmentGroupId = assignmentGroupId;
      changed = true;
    }
    if (next.status === "billing") {
      next.status = "execution";
      changed = true;
    } else if (!TODO_STATUSES.has(next.status)) {
      next.status = "open";
      changed = true;
    }
    if (typeof next.order !== "number") {
      next.order = index + 1;
      changed = true;
    }
    const orderBuckets = cleanTodoUserOrderBuckets(next.userOrderBuckets);
    if (JSON.stringify(next.userOrderBuckets || {}) !== JSON.stringify(orderBuckets)) {
      next.userOrderBuckets = orderBuckets;
      changed = true;
    }
    if (typeof next.urgent !== "boolean") {
      next.urgent = false;
      changed = true;
    }
    if (next.done && next.status !== "execution") {
      next.status = "execution";
      changed = true;
    }
    const completed = next.status === "execution";
    if (completed && next.urgent) {
      next.urgent = false;
      changed = true;
    }
    if (next.done !== completed) {
      next.done = completed;
      changed = true;
    }
    for (const field of ["start", "end"]) {
      if (typeof next[field] !== "string") {
        next[field] = "";
        changed = true;
      }
    }
    if (!next.syncUser) {
      next.syncUser = next.createdBy || "ibro";
      changed = true;
    }
    if (typeof next.sourceProjectTodoId !== "string") {
      next.sourceProjectTodoId = "";
      changed = true;
    }
    if (next.clientId || next.client) {
      const client = resolveClient(next.clientId) || resolveClient(next.client);
      if (client?.clientId && (next.clientId !== client.clientId || next.client !== client.name)) {
        next.clientId = client.clientId;
        next.client = client.name;
        changed = true;
      }
    }
    if (typeof next.googleEventId !== "string") {
      next.googleEventId = "";
      changed = true;
    }
    if (typeof next.googleUpdatedAt !== "string") {
      next.googleUpdatedAt = "";
      changed = true;
    }
    if (typeof next.googleSyncedLocalAt !== "string") {
      next.googleSyncedLocalAt = next.updatedAt || next.createdAt || "";
      changed = true;
    }
    if (typeof next.googleManagedByIndus !== "boolean") {
      next.googleManagedByIndus = false;
      changed = true;
    }
    if (typeof next.googleColorId !== "string") {
      next.googleColorId = "";
      changed = true;
    }
    if (typeof next.googleStatusLabel !== "string") {
      next.googleStatusLabel = "";
      changed = true;
    }
    for (const field of ["archiveGoogleEventId", "archivedAt", "archivedPayrollId", "archivedClientBillId", "clientBillId", "clientBilledAt"]) {
      if (typeof next[field] !== "string") {
        next[field] = "";
        changed = true;
      }
    }
    const billingHourlyRate = nonnegativeNumber(next.billingHourlyRate, null, 10_000);
    if (next.billingHourlyRate !== billingHourlyRate) {
      next.billingHourlyRate = billingHourlyRate;
      changed = true;
    }
    const billingKm = nonnegativeNumber(next.billingKm, 0, 1_000_000);
    if (next.billingKm !== billingKm) {
      next.billingKm = billingKm;
      changed = true;
    }
    const clientKm = nonnegativeNumber(next.clientKm, 0, 1_000_000);
    if (next.clientKm !== clientKm) {
      next.clientKm = clientKm;
      changed = true;
    }
    const clientVehicle = todoVehicle(next.clientVehicle);
    if (next.clientVehicle !== clientVehicle) {
      next.clientVehicle = clientVehicle;
      changed = true;
    }
    if (next.clientKmRate !== 0) {
      next.clientKmRate = 0;
      changed = true;
    }
    if (!Array.isArray(next.photos)) {
      next.photos = [];
      changed = true;
    }
    if (!Array.isArray(next.driveFiles)) {
      next.driveFiles = [];
      changed = true;
    }
    const driveFilesBefore = JSON.stringify(next.driveFiles);
    next.driveFiles = cleanTodoDriveFiles(next.driveFiles);
    if (JSON.stringify(next.driveFiles) !== driveFilesBefore) changed = true;
    const photosBefore = JSON.stringify(next.photos);
    next.photos = storeTodoAttachments(db, next, {
      id: next.createdBy || "system",
      name: next.createdByName || ""
    }).photos;
    if (JSON.stringify(next.photos) !== photosBefore) changed = true;
    return next;
  });

  if (pruneUnusedTodoAttachments(db)) changed = true;

  db.debts = db.debts.map((debt) => {
    const type = ["advance", "personal_purchase"].includes(debt.type) ? debt.type : "debt";
    const person = cleanUserId(debt.person) || (["advance", "personal_purchase"].includes(type) ? "" : (["ibro", "bojan"].includes(debt.person) ? debt.person : "ibro"));
    const next = {
      id: debt.id || crypto.randomUUID(),
      type,
      month: /^\d{4}-\d{2}$/.test(String(debt.month || "")) ? String(debt.month) : new Date().toISOString().slice(0, 7),
      date: isDateKey(debt.date) ? String(debt.date) : "",
      person,
      amount: Number(debt.amount || 0),
      reason: String(debt.reason || "").trim(),
      projectTodoId: String(debt.projectTodoId || ""),
      photos: Array.isArray(debt.photos) ? debt.photos : [],
      createdBy: debt.createdBy || "system",
      createdByName: debt.createdByName || "",
      createdAt: debt.createdAt || new Date().toISOString(),
      updatedBy: debt.updatedBy || debt.createdBy || "system",
      updatedByName: debt.updatedByName || debt.createdByName || "",
      updatedAt: debt.updatedAt || debt.createdAt || new Date().toISOString()
    };
    if (["advance", "personal_purchase"].includes(type)) next.photos = storeTodoAttachments(db, next, { id: next.createdBy, name: next.createdByName }).photos;
    return next;
  }).filter((debt) => debt.amount || debt.reason);

  if (reconcileTodoArchives(db).changed) changed = true;
  return { db, changed };
}

function ensureDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify({ users: defaultUsers, sessions: {}, entries: [], todos: [], attachments: {}, debts: [], clients: [], clientBills: [] }, null, 2), "utf8");
    return;
  }

  const { db, changed } = normalizeDb(JSON.parse(fs.readFileSync(dbFile, "utf8")));
  if (changed) writeDb(db);
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbFile, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), "utf8");
}

function getPgPool() {
  if (pgPool) return pgPool;
  const { Pool } = require("pg");
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false }
  });
  return pgPool;
}

function getPgStore() {
  if (!pgStore) pgStore = new PostgresStore(getPgPool(), MEDIA_DIR);
  return pgStore;
}

function initialDatabaseState() {
  return {
    users: JSON.parse(JSON.stringify(defaultUsers)),
    sessions: {},
    entries: [],
    todos: [],
    attachments: {},
    debts: [],
    clients: [],
    billingLocks: [],
    payrolls: [],
    clientBills: [],
    settings: {},
    calendarToken: crypto.randomBytes(24).toString("hex"),
    syncRevision: 0
  };
}

async function ensurePostgresDb() {
  if (!DATABASE_URL) return;
  if (pgReady) return pgReady;
  pgReady = (async () => {
    // Normalize legacy JSON once before writing relational rows so UUID client references,
    // assignment groups and attachment metadata survive the conversion intact.
    await getPgStore().ensure(initialDatabaseState(), normalizeDb);
  })();
  return pgReady;
}

async function readDbAsync() {
  if (!DATABASE_URL) return readDb();
  await ensurePostgresDb();
  const { db, changed } = normalizeDb(await getPgStore().load());
  if (changed) await writeDbAsync(db);
  return db;
}

async function writeDbAsync(db) {
  db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
  if (!DATABASE_URL) {
    writeDb(db);
    return;
  }
  await ensurePostgresDb();
  await getPgStore().save(db);
}

function securityHeaders(extra = {}, nonce = "") {
  const scriptSource = nonce ? `'self' 'nonce-${nonce}'` : "'self'";
  const styleSource = nonce ? `'self' 'nonce-${nonce}'` : "'self'";
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    "Content-Security-Policy": `default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; worker-src 'self'; script-src ${scriptSource}; style-src ${styleSource}`,
    ...(NODE_ENV === "production" ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
    ...extra
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }));
  res.end(JSON.stringify(data));
}

function absoluteBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function sendText(res, status, text, type) {
  res.writeHead(status, securityHeaders({
    "Content-Type": type.includes("charset=") ? type : `${type}; charset=utf-8`,
    "Cache-Control": "no-store"
  }));
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 6_000_000) {
        reject(new Error("Zahteva je prevelika."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Neveljaven JSON."));
      }
    });
  });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email || "",
    name: user.name,
    role: user.role,
    avatar: user.avatar || ""
  };
}

function publicDirectoryUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    exportTitle: String(user.billing?.exportTitle || "")
  };
}

function visibleEntriesForUser(db, user) {
  const entries = db.entries || [];
  if (user.role === "boss") return entries;
  return entries.filter((entry) => (entry.syncUser || entry.createdBy) === user.id);
}

function todoAssignmentItems(db, todo) {
  if (!todo) return [];
  const groupId = String(todo.assignmentGroupId || "");
  if (!groupId) return [todo];
  const grouped = (db.todos || []).filter((item) => item.assignmentGroupId === groupId);
  return grouped.length ? grouped : [todo];
}

function todoAssignmentAssigneeIds(db, todo) {
  return [...new Set(todoAssignmentItems(db, todo)
    .map((item) => cleanUserId(item.syncUser || item.createdBy))
    .filter(Boolean))];
}

function visibleTodosForUser(db, user) {
  const todos = db.todos || [];
  const visible = user.role === "boss"
    ? todos
    : todos.filter((todo) => (todo.syncUser || todo.createdBy) === user.id);
  return visible.map((todo) => hydrateTodoAttachments(db, {
    ...todo,
    assigneeIds: todoAssignmentAssigneeIds(db, todo)
  }));
}

function hydrateDebtAttachments(db, debt) {
  return hydrateTodoAttachments(db, { ...debt, photos: debt.photos || [] });
}

function visibleDebtsForUser(db, user) {
  const debts = db.debts || [];
  const visible = user.role === "boss" ? debts : debts.filter((debt) => debt.person === user.id);
  return visible.map((debt) => hydrateDebtAttachments(db, debt));
}

function visibleAdvancesForUser(db, user) {
  return visibleDebtsForUser(db, user).filter((debt) => debt.type === "advance");
}

function visiblePersonalPurchasesForUser(db, user) {
  return visibleDebtsForUser(db, user).filter((debt) => debt.type === "personal_purchase");
}

function canManageEntry(user, entry) {
  if (!entry) return false;
  if (user.role === "boss") return true;
  return (entry.syncUser || entry.createdBy) === user.id;
}

function publicEntryEditLock(lock) {
  return {
    entryId: lock.entryId,
    lockedById: lock.userId,
    lockedByName: lock.userName,
    expiresAt: new Date(lock.expiresAt).toISOString()
  };
}

function activeEntryEditLock(entryId, now = Date.now()) {
  const id = String(entryId || "");
  const lock = entryEditLocks.get(id);
  if (!lock) return null;
  if (lock.expiresAt <= now) {
    entryEditLocks.delete(id);
    return null;
  }
  return lock;
}

function acquireEntryEditLock(entryId, user, lockToken = "", now = Date.now()) {
  const id = String(entryId || "");
  const active = activeEntryEditLock(id, now);
  if (active && (active.userId !== user.id || active.token !== String(lockToken || ""))) {
    return { ok: false, lock: publicEntryEditLock(active) };
  }
  const lock = {
    entryId: id,
    userId: user.id,
    userName: user.name || user.id,
    token: active?.token || crypto.randomBytes(18).toString("hex"),
    expiresAt: now + ENTRY_EDIT_LOCK_TTL_MS
  };
  entryEditLocks.set(id, lock);
  return { ok: true, token: lock.token, lock: publicEntryEditLock(lock) };
}

function entryEditLockConflict(entryId, user, lockToken = "", now = Date.now()) {
  const active = activeEntryEditLock(entryId, now);
  if (!active) return null;
  if (active.userId === user.id && active.token === String(lockToken || "")) return null;
  return publicEntryEditLock(active);
}

function releaseEntryEditLock(entryId, user, lockToken = "", now = Date.now()) {
  const active = activeEntryEditLock(entryId, now);
  if (!active) return true;
  if (active.userId !== user.id || active.token !== String(lockToken || "")) return false;
  entryEditLocks.delete(String(entryId || ""));
  return true;
}

function publicTodoEditLock(lock) {
  return {
    todoId: lock.todoId,
    lockedById: lock.userId,
    lockedByName: lock.userName,
    expiresAt: new Date(lock.expiresAt).toISOString()
  };
}

function activeTodoEditLock(todoId, now = Date.now()) {
  const id = String(todoId || "");
  const lock = todoEditLocks.get(id);
  if (!lock) return null;
  if (lock.expiresAt <= now) {
    todoEditLocks.delete(id);
    return null;
  }
  return lock;
}

function acquireTodoEditLock(todoId, user, lockToken = "", now = Date.now()) {
  const id = String(todoId || "");
  const active = activeTodoEditLock(id, now);
  if (active && (active.userId !== user.id || active.token !== String(lockToken || ""))) {
    return { ok: false, lock: publicTodoEditLock(active) };
  }
  const lock = {
    todoId: id,
    userId: user.id,
    userName: user.name || user.id,
    token: active?.token || crypto.randomBytes(18).toString("hex"),
    expiresAt: now + TODO_EDIT_LOCK_TTL_MS
  };
  todoEditLocks.set(id, lock);
  return { ok: true, token: lock.token, lock: publicTodoEditLock(lock) };
}

function todoEditLockConflict(todoId, user, lockToken = "", now = Date.now()) {
  const active = activeTodoEditLock(todoId, now);
  if (!active) return null;
  if (active.userId === user.id && active.token === String(lockToken || "")) return null;
  return publicTodoEditLock(active);
}

function ownsTodoAssignmentEditLock(db, todo, user, lockToken = "", now = Date.now()) {
  const token = String(lockToken || "");
  const items = todoAssignmentItems(db, todo);
  return Boolean(token && items.length && items.every((item) => {
    const lock = activeTodoEditLock(item.id, now);
    return lock?.userId === user.id && lock.token === token;
  }));
}

function releaseTodoEditLock(todoId, user, lockToken = "", now = Date.now()) {
  const active = activeTodoEditLock(todoId, now);
  if (!active) return true;
  if (active.userId !== user.id || active.token !== String(lockToken || "")) return false;
  todoEditLocks.delete(String(todoId || ""));
  return true;
}

function todoAssignmentEditLockConflict(db, todo, user, lockToken = "", now = Date.now()) {
  for (const item of todoAssignmentItems(db, todo)) {
    const conflict = todoEditLockConflict(item.id, user, lockToken, now);
    if (conflict) return conflict;
  }
  return null;
}

function acquireTodoAssignmentEditLock(db, todo, user, lockToken = "", now = Date.now()) {
  const items = todoAssignmentItems(db, todo);
  const conflict = todoAssignmentEditLockConflict(db, todo, user, lockToken, now);
  if (conflict) return { ok: false, lock: conflict };
  const existing = items.map((item) => activeTodoEditLock(item.id, now)).find(Boolean);
  const token = existing?.token || crypto.randomBytes(18).toString("hex");
  for (const item of items) {
    todoEditLocks.set(String(item.id), {
      todoId: String(item.id),
      userId: user.id,
      userName: user.name || user.id,
      token,
      expiresAt: now + TODO_EDIT_LOCK_TTL_MS
    });
  }
  const lock = activeTodoEditLock(todo.id, now);
  return { ok: true, token, lock: publicTodoEditLock(lock) };
}

function releaseTodoAssignmentEditLock(db, todo, user, lockToken = "", now = Date.now()) {
  return todoAssignmentItems(db, todo)
    .map((item) => releaseTodoEditLock(item.id, user, lockToken, now)).every(Boolean);
}

function canManageTodo(user, todo) {
  if (!todo) return false;
  if (user.role === "boss") return true;
  return (todo.syncUser || todo.createdBy) === user.id;
}
function sourceTodoForNewEntry(db, user, entry) {
  const sourceTodoId = String(entry.sourceTodoId || "");
  const todo = (db.todos || []).find((item) => item.id === sourceTodoId);
  if (!todo || !canManageTodo(user, todo)) return null;
  if (!todo.date || todo.date !== entry.date) return null;
  if ((db.entries || []).some((item) => item.sourceTodoId === sourceTodoId)) return null;
  return todo;
}

function cleanUserId(value) {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ? id : "";
}
function nonnegativeNumber(value, fallback = null, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= maximum ? number : fallback;
}

const PAYROLL_STATUSES = new Set(["draft", "archiving", "confirmed", "paid"]);
const PAYROLL_PAID_TODO_STATUSES = new Set(TIME_ENTRY_TODO_STATUSES);
const CLIENT_BILL_STATUSES = new Set(["confirmed"]);

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}
function serverDateKey(now = new Date()) {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Ljubljana", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function canManageFinancialEntry(user, entry, now = new Date()) {
  if (!user || !entry) return false;
  if (user.role === "boss") return true;
  return entry.person === user.id && entry.date === serverDateKey(now);
}

function financialEntryAccessError(user, entry, label) {
  if (user?.role === "boss") return "";
  if (entry?.person !== user?.id) return `Lahko urejas samo svoj ${label}.`;
  return `Delavec lahko ${label} popravi ali izbriše samo na dan vnosa.`;
}

function payrollRange(input = {}) {
  input = typeof input === "string" ? { month: input } : (input || {});
  const month = String(input.month || "");
  const legacyMonth = isPayrollMonth(month) ? month : "";
  const from = isDateKey(input.from) ? String(input.from) : (legacyMonth ? `${legacyMonth}-01` : "");
  const to = isDateKey(input.to)
    ? String(input.to)
    : (legacyMonth ? `${legacyMonth}-${String(new Date(Number(legacyMonth.slice(0, 4)), Number(legacyMonth.slice(5, 7)), 0).getDate()).padStart(2, "0")}` : "");
  return from && to && from <= to ? { from, to, month: legacyMonth || from.slice(0, 7) } : null;
}

function payrollNextDate(key) {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

// A worker's payroll periods form one uninterrupted timeline. This prevents
// duplicate, overlapping or skipped periods even if a client bypasses the UI.
function payrollSequenceError(db, workerId, rangeInput, excludeId = "") {
  const range = payrollRange(rangeInput);
  if (!range) return "Obračunsko obdobje ni pravilno.";
  const records = (db.payrolls || [])
    .filter((payroll) => payroll.workerId === workerId && payroll.id !== excludeId)
    .map((payroll) => ({ ...payroll, range: payrollRange(payroll) }))
    .filter((payroll) => payroll.range)
    .map((payroll) => ({ id: payroll.id, from: payroll.range.from, to: payroll.range.to }));
  if (!records.length) return "";
  const earliest = records.slice().sort((left, right) => left.from.localeCompare(right.from))[0];
  if (range.to < earliest.from) return "Starejšega obračuna pred prvim obstoječim obračunom ni mogoče dodati.";
  records.push({ id: excludeId || "candidate", from: range.from, to: range.to });
  records.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    const expectedFrom = payrollNextDate(previous.to);
    if (current.from < expectedFrom) return "Obračunski obdobji se prekrivata.";
    if (current.from > expectedFrom) return `Začetek obračuna mora biti ${expectedFrom}, neposredno po prejšnjem obračunu.`;
  }
  return "";
}

function isPayrollMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  return Boolean(match && Number(match[2]) >= 1 && Number(match[2]) <= 12);
}
function payrollPeriodEnded(value, now = new Date()) {
  if (typeof value === "object" && value) {
    const range = payrollRange(value);
    if (!range) return false;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Ljubljana", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    return range.to < today;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const localParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Ljubljana",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const year = Number(match[1]);
  const month = Number(match[2]);
  const currentYear = Number(localParts.year || 0);
  const currentMonth = Number(localParts.month || 0);
  return year < currentYear || (year === currentYear && month < currentMonth);
}
function payrollMinutesForTodo(db, todo) {
  if (!todo || !PAYROLL_PAID_TODO_STATUSES.has(todo.status) || !/^\d{4}-\d{2}-\d{2}$/.test(String(todo.date || ""))) return null;
  const start = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(todo.start || ""));
  const end = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(todo.end || ""));
  if (!start || !end) return null;
  const minutes = (Number(end[1]) * 60 + Number(end[2])) - (Number(start[1]) * 60 + Number(start[2]));
  if (minutes <= 0) return null;
  if (todo.status === "meal") {
    const mealPaidMinutes = Math.round(nonnegativeNumber(db?.settings?.billing?.mealPaidMinutes, 45, 240));
    return Math.min(minutes, mealPaidMinutes) || null;
  }
  return minutes;
}

function payrollLineForTodo(db, todo, workerId = "") {
  const minutes = payrollMinutesForTodo(db, todo);
  if (!minutes) return null;
  const hourlyRate = nonnegativeNumber(todo.billingHourlyRate, defaultHourlyRateForUser(db, todo.syncUser || todo.createdBy), 10_000);
  const km = nonnegativeNumber(todo.billingKm, 0, 1_000_000);
  // Kilometrina delavca je povračilo za njegovo lastno vozilo.
  // Ne sme se mešati s tarifo, ki se zaračuna stranki za kombi ali osebni avto.
  const kmRate = nonnegativeNumber(
    db.settings?.billing?.workerOwnVehicleKmRate,
    nonnegativeNumber(db.settings?.billing?.kmRate, 0, 1_000),
    1_000
  );
  const hours = minutes / 60;
  const workAmount = Number((hours * hourlyRate).toFixed(2));
  const kmAmount = Number((km * kmRate).toFixed(2));
  return {
    todoId: String(todo.id || ""),
    assignmentGroupId: String(todo.assignmentGroupId || todo.id || ""),
    workerId: String(workerId || todo.syncUser || todo.createdBy || ""),
    date: String(todo.date || ""),
    start: String(todo.start || ""),
    end: String(todo.end || ""),
    title: String(todo.title || "").slice(0, 300),
    client: String(todo.client || "").slice(0, 240),
    minutes,
    hours,
    hourlyRate,
    km,
    kmRate,
    workAmount,
    kmAmount,
    totalAmount: Number((workAmount + kmAmount).toFixed(2))
  };
}

function payrollTotals(lines = []) {
  const minutes = lines.reduce((total, line) => total + Number(line.minutes || 0), 0);
  const workAmount = Number(lines.reduce((total, line) => total + Number(line.workAmount || 0), 0).toFixed(2));
  const km = Number(lines.reduce((total, line) => total + Number(line.km || 0), 0).toFixed(2));
  const kmAmount = Number(lines.reduce((total, line) => total + Number(line.kmAmount || 0), 0).toFixed(2));
  return {
    minutes,
    hours: minutes / 60,
    km,
    workAmount,
    kmAmount,
    totalAmount: Number((workAmount + kmAmount).toFixed(2))
  };
}

function payrollAdvances(db, workerId, range) {
  return (db.debts || []).filter((item) => item.type === "advance" && item.person === workerId && item.date >= range.from && item.date <= range.to);
}

function payrollPersonalPurchases(db, workerId, range) {
  return (db.debts || []).filter((item) => item.type === "personal_purchase" && item.person === workerId && item.date >= range.from && item.date <= range.to);
}

function normalizePayroll(input, db) {
  const workerId = cleanUserId(input?.workerId);
  const range = payrollRange(input);
  if (!workerId || !db.users?.[workerId] || !range) return null;
  const lines = (Array.isArray(input?.lines) ? input.lines : []).map((line) => {
    const minutes = Math.round(Number(line?.minutes || 0));
    const hourlyRate = nonnegativeNumber(line?.hourlyRate, null, 10_000);
    const km = nonnegativeNumber(line?.km, 0, 1_000_000);
    const kmRate = nonnegativeNumber(line?.kmRate, 0, 1_000);
    if (!String(line?.todoId || "") || minutes <= 0 || hourlyRate === null) return null;
    const hours = minutes / 60;
    const workAmount = Number((hours * hourlyRate).toFixed(2));
    const kmAmount = Number((km * kmRate).toFixed(2));
    return {
      todoId: String(line.todoId),
      assignmentGroupId: String(line.assignmentGroupId || line.todoId),
      workerId,
      date: String(line.date || ""),
      start: String(line.start || ""),
      end: String(line.end || ""),
      title: String(line.title || "").slice(0, 300),
      client: String(line.client || "").slice(0, 240),
      minutes,
      hours,
      hourlyRate,
      km,
      kmRate,
      workAmount,
      kmAmount,
      totalAmount: Number((workAmount + kmAmount).toFixed(2))
    };
  }).filter(Boolean);
  const totals = payrollTotals(lines);
  const advanceIds = [...new Set((Array.isArray(input?.advanceIds) ? input.advanceIds : []).map(String).filter(Boolean))];
  const advanceAmount = Number((Number(input?.advanceAmount || 0)).toFixed(2));
  const personalPurchaseIds = [...new Set((Array.isArray(input?.personalPurchaseIds) ? input.personalPurchaseIds : []).map(String).filter(Boolean))];
  const personalPurchaseAmount = Number((Number(input?.personalPurchaseAmount || 0)).toFixed(2));
  const status = PAYROLL_STATUSES.has(input?.status) ? input.status : "draft";
  const payments = (Array.isArray(input?.payments) ? input.payments : []).map((payment) => {
    const amount = nonnegativeNumber(payment?.amount, null, 1_000_000);
    if (amount === null || amount <= 0) return null;
    return { id: String(payment?.id || crypto.randomUUID()), amount: Number(amount.toFixed(2)), note: String(payment?.note || "").trim().slice(0, 1_000), createdAt: String(payment?.createdAt || new Date().toISOString()), createdBy: String(payment?.createdBy || "system"), createdByName: String(payment?.createdByName || "") };
  }).filter(Boolean);
  const createdAt = String(input?.createdAt || new Date().toISOString());
  return finalizePayrollAmounts({
    id: String(input?.id || crypto.randomUUID()),
    workerId,
    month: range.month,
    from: range.from,
    to: range.to,
    status,
    note: String(input?.note || "").trim().slice(0, 2_000),
    lines,
    advanceIds,
    advanceAmount,
    personalPurchaseIds,
    personalPurchaseAmount,
    payoutAmount: Math.max(0, Number((totals.totalAmount + advanceAmount - personalPurchaseAmount).toFixed(2))),
    payments,
    paidAmount: Number((status === "paid" && payments.length === 0 ? Math.max(0, totals.totalAmount + advanceAmount - personalPurchaseAmount) : payments.reduce((sum, payment) => sum + payment.amount, 0)).toFixed(2)),
    remainingAmount: 0,
    ...totals,
    createdBy: String(input?.createdBy || "system"),
    createdByName: String(input?.createdByName || ""),
    createdAt,
    updatedBy: String(input?.updatedBy || input?.createdBy || "system"),
    updatedByName: String(input?.updatedByName || input?.createdByName || ""),
    updatedAt: String(input?.updatedAt || createdAt),
    confirmedAt: String(input?.confirmedAt || ""),
    confirmedBy: String(input?.confirmedBy || ""),
    confirmedByName: String(input?.confirmedByName || ""),
    paidAt: String(input?.paidAt || ""),
    paidBy: String(input?.paidBy || ""),
    paidByName: String(input?.paidByName || "")
  });
}

function finalizePayrollAmounts(payroll) {
  payroll.paidAmount = Math.min(payroll.payoutAmount, Math.max(0, Number(payroll.paidAmount || 0)));
  payroll.remainingAmount = Number((payroll.payoutAmount - payroll.paidAmount).toFixed(2));
  return payroll;
}
function buildPayrollSnapshot(db, workerId, rangeInput, previous = {}, note = undefined) {
  const range = payrollRange(rangeInput);
  if (!range) return null;
  const lockedElsewhere = new Set((db.payrolls || [])
    .filter((payroll) => payroll.id !== previous.id && ["archiving", "confirmed", "paid"].includes(payroll.status))
    .flatMap((payroll) => payroll.lines || [])
    .map((line) => String(line.todoId || "")));
  const lines = (db.todos || [])
    .filter((todo) => (todo.syncUser || todo.createdBy) === workerId && !todo.archivedAt && String(todo.date || "") >= range.from && String(todo.date || "") <= range.to)
    .filter((todo) => !lockedElsewhere.has(String(todo.id || "")))
    .map((todo) => payrollLineForTodo(db, todo, workerId))
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  const advances = payrollAdvances(db, workerId, range);
  const personalPurchases = payrollPersonalPurchases(db, workerId, range);
  return normalizePayroll({ ...previous, workerId, ...range, lines, advanceIds: advances.map((item) => item.id), advanceAmount: advances.reduce((total, item) => total + Number(item.amount || 0), 0), personalPurchaseIds: personalPurchases.map((item) => item.id), personalPurchaseAmount: personalPurchases.reduce((total, item) => total + Number(item.amount || 0), 0), note: note === undefined ? previous.note : note }, db);
}

function payrollForUser(db, user) {
  const payrolls = db.payrolls || [];
  return user.role === "boss" ? payrolls : payrolls.filter((payroll) => payroll.workerId === user.id);
}

function payrollLockForTodos(db, todos = []) {
  const ids = new Set(todos.map((todo) => String(todo?.id || "")).filter(Boolean));
  if (!ids.size) return null;
  return (db.payrolls || []).find((payroll) => ["archiving", "confirmed", "paid"].includes(payroll.status)
    && (payroll.lines || []).some((line) => ids.has(String(line.todoId || "")))) || null;
}

function todoBillingEventId(todo) {
  return String(todo?.assignmentGroupId || todo?.id || "").trim();
}

function todoRequiresClientBilling(todo) {
  return Boolean(todo && todo.status === "execution" && String(todo.clientId || todo.client || "").trim());
}

function clientBillIsConfirmed(bill) {
  return CLIENT_BILL_STATUSES.has(String(bill?.status || ""));
}

function clientBillEventIds(bill) {
  return [...new Set((Array.isArray(bill?.eventIds) ? bill.eventIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
}

function clientForBilling(db, input = {}) {
  const wanted = [input?.clientId, input?.clientName, input?.client]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return null;
  return (db.clients || []).find((client) => [client.clientId, client.id, client.name, client.search, client.taxId]
    .filter(Boolean)
    .some((value) => wanted.includes(String(value).trim().toLowerCase()))) || null;
}

function normalizeClientBill(input, db) {
  const client = clientForBilling(db, input || {});
  const clientId = String(client?.clientId || input?.clientId || "").trim().slice(0, 160);
  const clientName = String(client?.name || input?.clientName || input?.client || "").trim().slice(0, 240);
  const eventIds = clientBillEventIds(input);
  if (!clientName || !eventIds.length) return null;
  const lines = (Array.isArray(input?.lines) ? input.lines : []).map((line) => {
    const eventId = String(line?.eventId || line?.assignmentGroupId || "").trim();
    if (!eventIds.includes(eventId)) return null;
    return {
      eventId,
      todoIds: [...new Set((Array.isArray(line?.todoIds) ? line.todoIds : []).map((id) => String(id || "").trim()).filter(Boolean))],
      date: isDateKey(line?.date) ? String(line.date) : "",
      start: String(line?.start || "").slice(0, 5),
      end: String(line?.end || "").slice(0, 5),
      title: String(line?.title || "").trim().slice(0, 300),
      clientKm: nonnegativeNumber(line?.clientKm, 0, 1_000_000),
      clientVehicle: todoVehicle(line?.clientVehicle),
      warranty: Boolean(line?.warranty),
      clientKmRate: 0
    };
  }).filter(Boolean);
  const createdAt = String(input?.createdAt || new Date().toISOString());
  const status = String(input?.status || "") === "cancelled" ? "cancelled" : "confirmed";
  return {
    id: String(input?.id || crypto.randomUUID()),
    clientId,
    clientName,
    from: isDateKey(input?.from) ? String(input.from) : "",
    to: isDateKey(input?.to) ? String(input.to) : "",
    status,
    eventIds,
    lines,
    createdBy: String(input?.createdBy || "system"),
    createdByName: String(input?.createdByName || ""),
    createdAt,
    confirmedAt: String(input?.confirmedAt || createdAt),
    confirmedBy: String(input?.confirmedBy || input?.createdBy || "system"),
    confirmedByName: String(input?.confirmedByName || input?.createdByName || ""),
    cancelledAt: status === "cancelled" ? String(input?.cancelledAt || createdAt) : "",
    cancelledBy: status === "cancelled" ? String(input?.cancelledBy || "system") : "",
    cancelledByName: status === "cancelled" ? String(input?.cancelledByName || "") : "",
    note: String(input?.note || "").trim().slice(0, 2_000)
  };
}

function cancelClientBill(db, billId, actor = null) {
  const bill = (db.clientBills || []).find((item) => String(item?.id || "") === String(billId || ""));
  if (!bill || !clientBillIsConfirmed(bill)) return null;
  const auditActor = actor || { id: "system", name: "Sistem" };
  const now = new Date().toISOString();
  const eventIds = new Set(clientBillEventIds(bill));
  bill.status = "cancelled";
  bill.cancelledAt = now;
  bill.cancelledBy = auditActor.id;
  bill.cancelledByName = auditActor.name || "";
  for (const todo of db.todos || []) {
    if (!eventIds.has(todoBillingEventId(todo))) continue;
    todo.history = [...(todo.history || []), audit(auditActor, `preklican obračun stranki ${bill.clientName}`)];
  }
  const archive = reconcileTodoArchives(db, auditActor);
  return { clientBill: bill, archive };
}
function confirmedClientBillByEvent(db) {
  const byEvent = new Map();
  for (const bill of db.clientBills || []) {
    if (!clientBillIsConfirmed(bill)) continue;
    for (const eventId of clientBillEventIds(bill)) {
      if (!byEvent.has(eventId)) byEvent.set(eventId, bill);
    }
  }
  return byEvent;
}

function clientBillLockForTodos(db, todos = []) {
  const bills = confirmedClientBillByEvent(db);
  return todos.map((todo) => bills.get(todoBillingEventId(todo))).find(Boolean) || null;
}

function clientBillCandidates(db, input = {}) {
  const client = clientForBilling(db, input);
  if (!client) return { client: null, groups: [] };
  const from = isDateKey(input.from) ? String(input.from) : "";
  const to = isDateKey(input.to) ? String(input.to) : "";
  const requestedEventIds = Array.isArray(input?.eventIds)
    ? new Set(input.eventIds.map((id) => String(id || "").trim()).filter(Boolean))
    : null;
  const billed = confirmedClientBillByEvent(db);
  const groups = new Map();
  for (const todo of db.todos || []) {
    if (!todoRequiresClientBilling(todo)) continue;
    if (String(todo.clientId || "") !== String(client.clientId || "") && String(todo.client || "").trim().toLowerCase() !== String(client.name || "").trim().toLowerCase()) continue;
    if ((from && String(todo.date || "") < from) || (to && String(todo.date || "") > to)) continue;
    const eventId = todoBillingEventId(todo);
    if (!eventId || billed.has(eventId)) continue;
    if (requestedEventIds && !requestedEventIds.has(eventId)) continue;
    if (!groups.has(eventId)) groups.set(eventId, []);
    groups.get(eventId).push(todo);
  }
  return { client, groups: [...groups.entries()].map(([eventId, todos]) => ({ eventId, todos })), requestedEventIds };
}

function todoDurationHours(todo = {}) {
  const start = /^(\d{2}):(\d{2})$/.exec(String(todo.start || ""));
  const end = /^(\d{2}):(\d{2})$/.exec(String(todo.end || ""));
  if (!start || !end) return 0;
  const startMinutes = Number(start[1]) * 60 + Number(start[2]);
  const endMinutes = Number(end[1]) * 60 + Number(end[2]);
  return endMinutes > startMinutes ? (endMinutes - startMinutes) / 60 : 0;
}
function clientReportSelection(db, input = {}) {
  const selection = clientBillCandidates(db, input);
  if (!selection.client || !selection.groups.length) return null;
  if (selection.requestedEventIds && selection.groups.length !== selection.requestedEventIds.size) return null;
  const groups = selection.groups.map((group) => ({
    eventId: group.eventId,
    todos: [...group.todos].sort((left, right) => String(left.date || "").localeCompare(String(right.date || ""))
      || String(left.start || "").localeCompare(String(right.start || ""))
      || String(left.id || "").localeCompare(String(right.id || "")))
  })).sort((left, right) => {
    const leftTodo = left.todos[0] || {};
    const rightTodo = right.todos[0] || {};
    return String(leftTodo.date || "").localeCompare(String(rightTodo.date || ""))
      || String(leftTodo.start || "").localeCompare(String(rightTodo.start || ""))
      || String(leftTodo.title || "").localeCompare(String(rightTodo.title || ""));
  });
  return {
    client: selection.client,
    from: isDateKey(input?.from) ? String(input.from) : "",
    to: isDateKey(input?.to) ? String(input.to) : "",
    groups
  };
}

function safeReportFileName(value, fallback = "priloga") {
  const cleaned = String(value || "").trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return cleaned || fallback;
}

function attachmentMimeExtension(mimeType) {
  const type = String(mimeType || "").toLowerCase();
  if (type === "application/pdf") return ".pdf";
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "text/plain") return ".txt";
  return "";
}

function clientReportAttachmentSelection(report, attachmentIds) {
  const available = new Map();
  for (const group of report.groups || []) {
    for (const todo of group.todos || []) {
      for (const photo of todo.photos || []) {
        const attachmentId = String(photo?.attachmentId || "");
        if (!validTodoAttachmentId(attachmentId) || available.has(attachmentId)) continue;
        available.set(attachmentId, {
          id: attachmentId,
          name: safeReportFileName(photo.name || "priloga"),
          eventId: group.eventId
        });
      }
    }
  }
  const requested = Array.isArray(attachmentIds)
    ? [...new Set(attachmentIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [...available.keys()];
  if (requested.length > 1_000) throw new Error("Za en izvoz lahko izbereš največ 1000 prilog.");
  if (requested.some((id) => !validTodoAttachmentId(id) || !available.has(id))) {
    throw new Error("Izbrana priloga ne pripada oznacenim vpisom poročila.");
  }
  return requested.map((id) => available.get(id));
}

function dataUrlAttachmentBytes(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  return match ? { mimeType: match[1], bytes: Buffer.from(match[2], "base64") } : null;
}

async function loadClientReportAttachments(db, selected = [], { maxAttachmentBytes = REPORT_PDF_MAX_TOTAL_BYTES, maxTotalBytes = REPORT_PDF_MAX_TOTAL_BYTES, destination = "PDF" } = {}) {
  const attachments = [];
  let totalBytes = 0;
  for (const selectedAttachment of selected) {
    let mimeType = "application/octet-stream";
    let bytes = null;
    if (DATABASE_URL) {
      const stored = await getPgStore().getAttachment(selectedAttachment.id, false);
      if (stored) {
        mimeType = String(stored.mimeType || mimeType);
        bytes = await fsp.readFile(stored.filePath);
      }
    } else {
      const parsed = dataUrlAttachmentBytes(db.attachments?.[selectedAttachment.id]?.data);
      if (parsed) {
        mimeType = parsed.mimeType || mimeType;
        bytes = parsed.bytes;
      }
    }
    if (!bytes?.length) throw new Error(`Priloge \"${selectedAttachment.name}\" ni mogoče prebrati.`);
    if (bytes.length > maxAttachmentBytes) {
      throw new Error(`Priloga \"${selectedAttachment.name}\" je prevelika za ${destination} izvoz.`);
    }
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Izbrane priloge so skupaj prevelike za ${destination} izvoz. Izberi manj prilog.`);
    }
    const extension = attachmentMimeExtension(mimeType);
    const baseName = safeReportFileName(selectedAttachment.name || "priloga");
    const filename = extension && !baseName.toLowerCase().endsWith(extension) ? `${baseName}${extension}` : baseName;
    const storedMetadata = db.attachments?.[selectedAttachment.id] || {};
    attachments.push({
      ...selectedAttachment,
      mimeType,
      bytes,
      filename,
      driveFileId: String(storedMetadata.driveFileId || ""),
      driveUrl: String(storedMetadata.driveUrl || "")
    });
  }
  return attachments;
}

function reportPdfFontPath(weight = "regular") {
  return path.resolve(root, "..", "node_modules", "pdfjs-dist", "standard_fonts", weight === "bold" ? "LiberationSans-Bold.ttf" : "LiberationSans-Regular.ttf");
}

function reportPdfDate(date) {
  if (!isDateKey(date)) return "Brez datuma";
  const [year, month, day] = String(date).split("-");
  return `${day}. ${month}. ${year}`;
}

function clientReportExportOptions(input = {}) {
  return {
    worker: input?.worker === "title" ? "title" : "hidden",
    time: input?.time === "shown" ? "shown" : "hidden"
  };
}

function reportPdfAssigneeTitle(db, todo) {
  return String(db.users?.[todo?.syncUser || todo?.createdBy]?.billing?.exportTitle || "").trim() || "Izvajalec";
}

function reportPdfAssignees(db, todos) {
  return [...new Set((todos || []).map((todo) => reportPdfAssigneeTitle(db, todo)))].join(", ");
}

function reportPdfVehicleLabel(vehicle) {
  return vehicle === "van" ? "kombi" : "osebni avto";
}

function reportPdfDriveFileLink(doc, file) {
  const url = String(file?.url || "").trim();
  if (!url) return;
  const label = file?.kind === "video" ? "Video" : "Dokument";
  doc.font(reportPdfFontPath("bold")).fillColor("#1e3430").text(`${label}: `, { continued: true });
  doc.font(reportPdfFontPath()).fillColor("#0d6d95").text(String(file?.name || "Priloga"), { link: url, underline: true });
  doc.fillColor("#263634");
}
function reportPdfAttachmentSummary(attachments = []) {
  const counts = attachments.reduce((summary, attachment) => {
    const type = String(attachment?.mimeType || "").toLowerCase();
    if (type.startsWith("image/")) summary.photos += 1;
    else if (type === "application/pdf") summary.pdfs += 1;
    else summary.files += 1;
    return summary;
  }, { photos: 0, pdfs: 0, files: 0 });
  const plural = (count, one, two, few, many) => count === 1 ? one : count === 2 ? two : count < 5 ? few : many;
  return [
    counts.photos && `${counts.photos} ${plural(counts.photos, "fotografija", "fotografiji", "fotografije", "fotografij")}`,
    counts.pdfs && `${counts.pdfs} ${plural(counts.pdfs, "PDF dokument", "PDF dokumenta", "PDF dokumenti", "PDF dokumentov")}`,
    counts.files && `${counts.files} ${plural(counts.files, "datoteka", "datoteki", "datoteke", "datotek")}`
  ].filter(Boolean).join(", ");
}

function reportPdfAttachmentTitle(attachment, index) {
  const type = String(attachment?.mimeType || "").toLowerCase();
  if (type.startsWith("image/")) return `Fotografija ${index}`;
  if (type === "application/pdf") return `PDF dokument ${index}`;
  return `Priloga ${index}`;
}

function reportPdfAttachmentLinks(doc, attachments = []) {
  if (!attachments.length) return;
  const shared = attachments.filter((attachment) => String(attachment?.driveUrl || "").trim());
  if (!shared.length) {
    reportPdfLine(doc, "Vključene priloge", reportPdfAttachmentSummary(attachments));
    return;
  }
  doc.font(reportPdfFontPath("bold")).fillColor("#1e3430").text("Vključene priloge: ", { continued: true });
  if (shared.length === 1) {
    doc.font(reportPdfFontPath()).fillColor("#0d6d95").text(reportPdfAttachmentSummary(shared), {
      link: shared[0].driveUrl,
      underline: true
    });
  } else {
    shared.forEach((attachment, index) => {
      doc.font(reportPdfFontPath()).fillColor("#0d6d95").text(reportPdfAttachmentTitle(attachment, index + 1), {
        link: attachment.driveUrl,
        underline: true,
        continued: index < shared.length - 1
      });
      if (index < shared.length - 1) doc.text(" · ", { continued: true });
    });
  }
  doc.fillColor("#263634");
}

function reportPdfLine(doc, label, value) {
  if (!value) return;
  doc.font(reportPdfFontPath("bold")).fillColor("#1e3430").text(`${label}: `, { continued: true });
  doc.font(reportPdfFontPath()).fillColor("#263634").text(String(value));
}

function buildClientReportPdf(db, report, attachments = [], exportOptions = {}) {
  const options = clientReportExportOptions(exportOptions);
  const title = `Obračun - ${safeReportFileName(report.client?.name || "stranka")}`;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 46,
      info: { Title: title, Author: "INDUS URE", Subject: "Obračun opravljenih storitev" }
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    try {
      doc.font(reportPdfFontPath("bold")).fontSize(21).fillColor("#0d536b").text("Obračun opravljenih storitev");
      doc.moveDown(0.3);
      doc.font(reportPdfFontPath()).fontSize(11).fillColor("#263634");
      reportPdfLine(doc, "Stranka", report.client?.name || "");
      if (report.client?.email) reportPdfLine(doc, "E-posta", report.client.email);
      reportPdfLine(doc, "Obdobje", report.from || report.to ? `${report.from ? reportPdfDate(report.from) : "-"} - ${report.to ? reportPdfDate(report.to) : "-"}` : "Celotna evidenca");
      doc.moveDown(0.8);

      for (const group of report.groups || []) {
        const todo = group.todos?.[0] || {};
        const warranty = Boolean(todo.warranty);
        const hours = warranty ? 0 : group.todos.reduce((sum, item) => sum + todoDurationHours(item), 0);
        const clientKm = warranty ? 0 : Math.max(0, Number(todo.clientKm || 0));
        const time = options.time === "shown" && todo.start && todo.end ? `  ${todo.start}-${todo.end}` : "";
        doc.font(reportPdfFontPath("bold")).fontSize(13).fillColor("#143b34").text(`${reportPdfDate(todo.date)}${time}`);
        doc.font(reportPdfFontPath("bold")).fontSize(12).fillColor("#161f20").text(String(todo.title || "Brez naziva"));
        doc.font(reportPdfFontPath()).fontSize(10).fillColor("#263634");
        if (options.worker === "title") reportPdfLine(doc, "Izvajalec", reportPdfAssignees(db, group.todos));
        if (warranty) reportPdfLine(doc, "Garancija", "Storitev se ne obračunava stranki.");
        if (hours) reportPdfLine(doc, "Izvedeno", `${hours.toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h`);
        if (clientKm) reportPdfLine(doc, "Stroski prevoza (obe smeri)", `${reportPdfVehicleLabel(todo.clientVehicle)} - ${clientKm.toLocaleString("sl-SI", { maximumFractionDigits: 1 })} km`);
        if (todo.notes) reportPdfLine(doc, "Opis del", todo.notes);
        if (todo.material) reportPdfLine(doc, "Material", todo.material);
        const driveFiles = [...new Map(group.todos.flatMap((item) => item.driveFiles || []).filter((file) => file?.url).map((file) => [file.url, file])).values()];
        for (const file of driveFiles) reportPdfDriveFileLink(doc, file);
        const groupAttachments = attachments.filter((attachment) => attachment.eventId === group.eventId);
        if (groupAttachments.length) reportPdfAttachmentLinks(doc, groupAttachments);
        doc.moveDown(0.75);
        doc.strokeColor("#c8d9d5").lineWidth(1).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
        doc.moveDown(0.75);
      }
      const clientHoursByWorker = new Map();
      const totalClientHours = (report.groups || []).reduce((sum, group) => {
        const representative = group.todos?.[0] || {};
        if (representative.warranty) return sum;
        return sum + (group.todos || []).reduce((hours, item) => {
          const duration = todoDurationHours(item);
          if (options.worker === "title") {
            const label = reportPdfAssigneeTitle(db, item);
            clientHoursByWorker.set(label, (clientHoursByWorker.get(label) || 0) + duration);
          }
          return hours + duration;
        }, 0);
      }, 0);
      doc.moveDown(0.4);
      doc.font(reportPdfFontPath("bold")).fontSize(13).fillColor("#0d536b").text("Izvedeno vseh ur");
      if (options.worker === "title" && clientHoursByWorker.size) {
        [...clientHoursByWorker.entries()].sort(([left], [right]) => left.localeCompare(right, "sl")).forEach(([label, hours]) => {
          reportPdfLine(doc, label, `${hours.toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h`);
        });
        reportPdfLine(doc, "Skupaj", `${totalClientHours.toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h`);
      } else {
        reportPdfLine(doc, "Skupaj", `${totalClientHours.toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h`);
      }
      doc.moveDown(0.5);

      for (const [attachmentIndex, attachment] of attachments.entries()) {
        const image = /^image\/(jpeg|png)$/i.test(String(attachment.mimeType || ""));
        if (image) {
          doc.addPage();
          doc.font(reportPdfFontPath("bold")).fontSize(14).fillColor("#143b34").text(reportPdfAttachmentTitle(attachment, attachmentIndex + 1));
          doc.moveDown(0.5);
          try {
            doc.image(attachment.bytes, {
              fit: [doc.page.width - doc.page.margins.left - doc.page.margins.right, doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 42],
              align: "center",
              valign: "center"
            });
          } catch {
            reportPdfLine(doc, "Priloga", "Slike ni bilo mogoče vgraditi; priložen je izvirnik.");
          }
        }
        doc.file(attachment.bytes, {
          name: attachment.filename,
          type: attachment.mimeType,
          description: `Priloga: ${attachment.name}`,
          relationship: "Supplement"
        });
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function mimeBase64(value) {
  return Buffer.from(value).toString("base64").replace(/.{1,76}/g, "$&\r\n");
}

function gmailDraftRaw({ to, pdf, pdfFilename, attachments = [] }) {
  const boundary = `indus-ure-${crypto.randomBytes(18).toString("hex")}`;
  const text = "Pozdravljeni, v prilogi vam pošiljam obračun opravljenih storitev in porabljenega materiala.\n\nZa pojasnila sem seveda na voljo.";
  const subject = `=?UTF-8?B?${Buffer.from("Obračun", "utf8").toString("base64")}?=`;
  const parts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(text),
    `--${boundary}`,
    `Content-Type: application/pdf; name=\"${pdfFilename}\"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename=\"${pdfFilename}\"`,
    "",
    mimeBase64(pdf)
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name=\"${attachment.filename}\"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename=\"${attachment.filename}\"`,
      "",
      mimeBase64(attachment.bytes)
    );
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

function clientReportFilename(client) {
  const suffix = safeReportFileName(client?.name || "stranka").replace(/\s+/g, "-");
  return `obračun-${suffix || "stranka"}.pdf`;
}
function buildClientBillSnapshot(db, input, actor) {
  const selection = clientBillCandidates(db, input);
  if (!selection.client || !selection.groups.length) return null;
  if (selection.requestedEventIds && selection.groups.length !== selection.requestedEventIds.size) return null;
  const createdAt = new Date().toISOString();
  return normalizeClientBill({
    id: crypto.randomUUID(),
    clientId: selection.client.clientId,
    clientName: selection.client.name,
    from: isDateKey(input?.from) ? String(input.from) : "",
    to: isDateKey(input?.to) ? String(input.to) : "",
    status: "confirmed",
    eventIds: selection.groups.map((group) => group.eventId),
    lines: selection.groups.map((group) => {
      const representative = group.todos.slice().sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")) || String(left.start || "").localeCompare(String(right.start || "")))[0];
      return {
        eventId: group.eventId,
        todoIds: group.todos.map((todo) => todo.id),
        date: representative.date,
        start: representative.start,
        end: representative.end,
        title: representative.title,
        clientKm: representative.clientKm,
        clientVehicle: representative.clientVehicle,
        warranty: Boolean(representative.warranty),
        clientKmRate: 0
      };
    }),
    createdBy: actor?.id || "system",
    createdByName: actor?.name || "",
    createdAt,
    confirmedAt: createdAt,
    confirmedBy: actor?.id || "system",
    confirmedByName: actor?.name || ""
  }, db);
}

function confirmedPayrollByTodo(db) {
  const byTodo = new Map();
  for (const payroll of db.payrolls || []) {
    if (!["confirmed", "paid"].includes(payroll.status)) continue;
    for (const line of payroll.lines || []) {
      const todoId = String(line?.todoId || "");
      if (todoId && !byTodo.has(todoId)) byTodo.set(todoId, payroll);
    }
  }
  return byTodo;
}

function reconcileTodoArchives(db, actor = null) {
  const payrolls = confirmedPayrollByTodo(db);
  const bills = confirmedClientBillByEvent(db);
  const now = new Date().toISOString();
  const auditActor = actor || { id: "system", name: "Sistem" };
  let archived = 0;
  let restored = 0;
  let changed = false;
  for (const todo of db.todos || []) {
    const payroll = payrolls.get(String(todo.id || ""));
    const needsClientBill = todoRequiresClientBilling(todo);
    const bill = needsClientBill ? bills.get(todoBillingEventId(todo)) : null;
    const desiredClientBillId = bill?.id || "";
    const readyForArchive = Boolean(payroll && (!needsClientBill || bill));
    if (todo.clientBillId !== desiredClientBillId || todo.clientBilledAt !== (bill?.confirmedAt || "")) {
      todo.clientBillId = desiredClientBillId;
      todo.clientBilledAt = bill?.confirmedAt || "";
      todo.updatedAt = now;
      todo.updatedBy = auditActor.id;
      todo.updatedByName = auditActor.name || "";
      changed = true;
    }
    if (readyForArchive) {
      if (!todo.archivedAt || todo.archivedPayrollId !== payroll.id || todo.archivedClientBillId !== desiredClientBillId) {
        todo.archivedAt = todo.archivedAt || now;
        todo.archivedPayrollId = payroll.id;
        todo.archivedClientBillId = desiredClientBillId;
        todo.updatedAt = now;
        todo.updatedBy = auditActor.id;
        todo.updatedByName = auditActor.name || "";
        todo.history = [...(todo.history || []), audit(auditActor, needsClientBill
          ? `arhivirano po potrjenem obračunu delavca in stranke ${bill.clientName}`
          : `arhivirano po potrjenem obračunu delavca ${payroll.month}`)];
        archived += 1;
        changed = true;
      }
      continue;
    }
    if (todo.archivedAt || todo.archivedPayrollId || todo.archivedClientBillId) {
      todo.archivedAt = "";
      todo.archivedPayrollId = "";
      todo.archivedClientBillId = "";
      todo.updatedAt = now;
      todo.updatedBy = auditActor.id;
      todo.updatedByName = auditActor.name || "";
      todo.history = [...(todo.history || []), audit(auditActor, needsClientBill
        ? "vrnjeno iz arhiva: manjka potrjeni obračun stranki ali delavca"
        : "vrnjeno iz arhiva: manjka potrjeni obračun delavca")];
      restored += 1;
      changed = true;
    }
  }
  return { archived, restored, changed };
}
function archiveRetentionMonthsForDb(db) {
  return Math.min(120, Math.max(1, Math.round(nonnegativeNumber(db?.settings?.archive?.retentionMonths, 12, 120))));
}

function archiveRetentionCandidates(db, now = new Date()) {
  const months = archiveRetentionMonthsForDb(db);
  const cutoff = new Date(now instanceof Date ? now.getTime() : new Date(now).getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffMs = cutoff.getTime();
  const byGroup = new Map();
  for (const todo of db.todos || []) {
    const groupId = String(todo.assignmentGroupId || todo.id || "");
    if (!groupId) continue;
    const group = byGroup.get(groupId) || [];
    group.push(todo);
    byGroup.set(groupId, group);
  }
  const groups = [];
  for (const [id, todos] of byGroup) {
    const fullyArchived = todos.length > 0 && todos.every((todo) => {
      const archivedAt = new Date(String(todo.archivedAt || "")).getTime();
      return Number.isFinite(archivedAt) && archivedAt < cutoffMs;
    });
    if (!fullyArchived) continue;
    const managedDriveFiles = [...new Map(todos.flatMap((todo) => todo.driveFiles || [])
      .filter((file) => Boolean(file?.managed)
        && String(file.ownerEmail || "").trim().toLowerCase() === GOOGLE_DRIVE_OWNER_EMAIL
        && validGoogleDriveId(file.fileId))
      .map((file) => [String(file.fileId), file])).values()];
    groups.push({ id, todos, managedDriveFiles });
  }
  return { retentionMonths: months, cutoffAt: cutoff.toISOString(), groups };
}

function purgeArchivedTodoGroups(db, groups) {
  const groupIds = new Set((groups || []).map((group) => String(group.id || "")).filter(Boolean));
  if (!groupIds.size) return { groups: 0, todos: 0, attachments: 0, adHocClients: 0 };
  const beforeTodos = (db.todos || []).length;
  const beforeAttachments = Object.keys(db.attachments || {}).length;
  const beforeClients = (db.clients || []).length;
  db.todos = (db.todos || []).filter((todo) => !groupIds.has(String(todo.assignmentGroupId || todo.id || "")));
  pruneUnusedTodoAttachments(db);
  pruneUnusedAdHocClients(db);
  return {
    groups: groupIds.size,
    todos: beforeTodos - db.todos.length,
    attachments: beforeAttachments - Object.keys(db.attachments || {}).length,
    adHocClients: beforeClients - (db.clients || []).length
  };
}

function defaultHourlyRateForUser(db, userId) {
  return nonnegativeNumber(
    db.users?.[userId]?.billing?.hourlyRate,
    nonnegativeNumber(db.settings?.billing?.hourlyRate, 15, 10_000),
    10_000
  );
}

function todoForUserRole(user, db, previous, todo) {
  const previousRate = nonnegativeNumber(previous?.billingHourlyRate, null, 10_000);
  const previousWarranty = Boolean(previous?.warranty);
  const previousKm = nonnegativeNumber(previous?.billingKm, 0, 1_000_000);
  const previousClientKm = nonnegativeNumber(previous?.clientKm, 0, 1_000_000);
  const previousClientVehicle = todoVehicle(previous?.clientVehicle);
  const requestedClientVehicle = todoVehicle(todo.clientVehicle);
  const isCompleted = todo.status === "execution";
  const isMeal = todo.status === "meal";
  const isPaidTime = TIME_ENTRY_TODO_STATUSES.has(todo.status);
  const canSetClientMileage = isCompleted;
  const defaultRate = defaultHourlyRateForUser(db, todo.syncUser || previous?.syncUser || user.id);
  if (user.role !== "boss") {
    return {
      ...todo,
      billingHourlyRate: isPaidTime ? previousRate ?? defaultRate : previousRate,
      billingKm: isMeal ? 0 : isPaidTime ? nonnegativeNumber(todo.billingKm, previousKm, 1_000_000) : previousKm,
      warranty: isMeal ? false : isCompleted ? Boolean(todo.warranty) : previousWarranty,
      clientKm: isMeal ? 0 : canSetClientMileage ? nonnegativeNumber(todo.clientKm, previousClientKm, 1_000_000) : previousClientKm,
      clientVehicle: isMeal ? "personal" : canSetClientMileage ? requestedClientVehicle : previousClientVehicle,
      clientKmRate: 0
    };
  }
  return {
    ...todo,
    billingHourlyRate: isPaidTime ? nonnegativeNumber(todo.billingHourlyRate, previousRate ?? defaultRate, 10_000) : previousRate,
    billingKm: isMeal ? 0 : isPaidTime ? nonnegativeNumber(todo.billingKm, previousKm, 1_000_000) : previousKm,
    warranty: isMeal ? false : isCompleted ? Boolean(todo.warranty) : previousWarranty,
    clientKm: isMeal ? 0 : canSetClientMileage ? nonnegativeNumber(todo.clientKm, previousClientKm, 1_000_000) : previousClientKm,
    clientVehicle: isMeal ? "personal" : requestedClientVehicle,
    clientKmRate: 0
  };
}
function syncUserForRequest(user, requested, fallback = "", users = defaultUsers) {
  const allowed = new Set(Object.keys(users || {}));
  const wanted = cleanUserId(requested);
  const previous = cleanUserId(fallback);
  if (user.role === "boss") {
    if (allowed.has(wanted)) return wanted;
    if (allowed.has(previous)) return previous;
    return user.id;
  }
  return user.id;
}

function todoAssigneeForUpdate(user, requested, fallback = "", users = defaultUsers) {
  const allowed = new Set(Object.keys(users || {}));
  const wanted = cleanUserId(requested);
  const previous = cleanUserId(fallback);
  if (allowed.has(wanted)) return wanted;
  if (allowed.has(previous)) return previous;
  return allowed.has(user.id) ? user.id : "";
}

function todoAssigneesForRequest(user, requested, users = defaultUsers) {
  const allowed = new Set(Object.keys(users || {}));
  const values = Array.isArray(requested) ? requested : [requested];
  const assignees = [...new Set(values
    .map(cleanUserId)
    .filter((id) => allowed.has(id)))];
  if (assignees.length) return assignees;
  return allowed.has(user.id) ? [user.id] : [];
}

function entryForUserRole(user, entry, previous = null) {
  if (user.role === "boss") return entry;
  const previousStatus = previous?.status || "";
  const status = previousStatus === "billed"
    ? "billed"
    : entry.status === "billed" ? "unbilled" : entry.status;
  return {
    ...entry,
    syncUser: user.id,
    status,
    invoiceSent: Boolean(previous?.invoiceSent),
    invoiceSettled: Boolean(previous?.invoiceSettled),
    invoicePaid: Boolean(previous?.invoicePaid)
  };
}

function entryIsLocked(db, entry) {
  return (db.billingLocks || []).some((lock) => entry.date >= lock.from && entry.date <= lock.to);
}

function lockedFieldChanged(oldEntry, newEntry) {
  return oldEntry.start !== newEntry.start
    || oldEntry.end !== newEntry.end
    || Number(oldEntry.km || 0) !== Number(newEntry.km || 0)
    || Boolean(oldEntry.fromHome) !== Boolean(newEntry.fromHome);
}

function attachResolvedClient(db, item, { createAdHoc = false, user = null } = {}) {
  if (!item.client && !item.clientId) return item;
  const wanted = String(item.clientId || item.client || "").trim().toLowerCase();
  let client = (db.clients || []).find((row) => [row.clientId, row.id, row.name, row.search, row.taxId]
    .filter(Boolean)
    .some((value) => String(value).trim().toLowerCase() === wanted));
  if (!client && createAdHoc && item.client) {
    const alias = String(item.client).trim();
    client = normalizeStoredClient({
      name: alias,
      search: alias,
      source: "ad-hoc",
      needsReview: true,
      createdBy: user?.id || "system",
      createdAt: new Date().toISOString()
    });
    db.clients.push(client);
  }
  if (!client?.clientId) return item;
  return { ...item, clientId: client.clientId || client.id, client: client.name };
}

function sessionTokenFromRequest(req) {
  return sessionCookieValue(req);
}

async function getSessionUser(req) {
  if (req.indusSessionUser !== undefined) return req.indusSessionUser;
  const token = sessionTokenFromRequest(req);
  const db = await readDbAsync();
  const session = sessionForToken(db, token);
  req.indusDb = db;
  req.indusSession = session || null;
  req.indusSessionToken = token;
  req.indusSessionUser = session ? (db.users[session.userId] || null) : null;
  return req.indusSessionUser;
}

async function requireUser(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Prijava je potekla. Prijavi se še enkrat." });
    return null;
  }
  if (!validCsrf(req, req.indusSession)) {
    sendJson(res, 403, { error: "Varnostna potrditev seje manjka. Osvezi stran in poskusi znova." });
    return null;
  }
  return user;
}

// The browser asks this endpoint frequently. In PostgreSQL this reads only the
// session, user and revision row rather than loading every task and attachment.
async function requireUserForSyncState(req, res) {
  if (!DATABASE_URL) return requireUser(req, res);
  await ensurePostgresDb();
  const token = sessionTokenFromRequest(req);
  const record = await getPgStore().sessionWithRevision(sessionTokenHash(token));
  if (!record) {
    sendJson(res, 401, { error: "Prijava je potekla. Prijavi se še enkrat." });
    return null;
  }
  req.indusSession = record.session;
  req.indusDb = { syncRevision: record.revision };
  if (!validCsrf(req, record.session)) {
    sendJson(res, 403, { error: "Varnostna potrditev seje manjka. Osvezi stran in poskusi znova." });
    return null;
  }
  return record.user;
}

function audit(user, action) {
  return {
    action,
    by: user.id,
    byName: user.name,
    at: new Date().toISOString()
  };
}

function roundTimeToQuarterHour(value) {
  const time = String(value || "").trim();
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  const rounded = Math.min(23 * 60 + 45, Math.round(minutes / 15) * 15);
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

function cleanEntry(input) {
  const entry = {
    date: String(input.date || ""),
    start: roundTimeToQuarterHour(input.start),
    end: roundTimeToQuarterHour(input.end),
    client: String(input.client || "").trim(),
    clientId: String(input.clientId || "").trim(),
    status: ["billed", "warranty", "unbilled", "errand", "vacation"].includes(input.status) ? input.status : "unbilled",
    work: String(input.work || "").trim(),
    material: String(input.material || "").trim(),
    people: String(input.people || "").trim(),
    syncUser: cleanUserId(input.syncUser),
    km: Number(input.km || 0),
    materialCost: Number(input.materialCost || 0),
    notes: String(input.notes || "").trim(),
    invoiceSent: Boolean(input.invoiceSent),
    invoiceSettled: Boolean(input.invoiceSettled),
    invoicePaid: Boolean(input.invoicePaid),
    fromHome: Boolean(input.fromHome),
    sourceTodoId: String(input.sourceTodoId || "").trim().slice(0, 100)
  };
  if (["errand", "vacation"].includes(entry.status)) {
    entry.client = "";
    entry.clientId = "";
  }
  if (entry.status === "vacation") {
    entry.start = entry.start || "00:00";
    entry.end = entry.end || "23:59";
    entry.km = 0;
  }
  return entry;
}

function validateEntry(entry) {
  if (!entry.date || !entry.start || !entry.end) return "Manjka datum ali čas.";
  if (!["errand", "vacation"].includes(entry.status) && !entry.client) return "Manjka stranka.";
  if (!["errand", "vacation"].includes(entry.status) && !entry.clientId) return "Stranke ni bilo mogoče identificirati.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return "Datum ni pravilen.";
  if (!/^\d{2}:\d{2}$/.test(entry.start) || !/^\d{2}:\d{2}$/.test(entry.end)) return "Čas ni pravilen.";
  if (entry.end <= entry.start) return "Ura do mora biti kasneje kot ura od.";
  return "";
}

function cleanTodoUserOrderBuckets(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .map(([userId, bucket]) => [cleanUserId(userId), String(bucket || "")])
    .filter(([userId, bucket]) => userId && ["sorted", "unsorted"].includes(bucket)));
}

function cleanTodo(input) {
  const isMeal = input.status === "meal";
  const isTimeEntry = TIME_ENTRY_TODO_STATUSES.has(String(input.status || ""));
  const photos = Array.isArray(input.photos) ? input.photos : [];
  return {
    title: isMeal ? "Malica" : String(input.title || "").trim(),
    date: String(input.date || ""),
    start: roundTimeToQuarterHour(input.start),
    end: roundTimeToQuarterHour(input.end),
    client: isMeal ? "" : String(input.client || "").trim(),
    clientId: isMeal ? "" : String(input.clientId || "").trim(),
    notes: isMeal ? "" : String(input.notes || "").trim(),
    material: isMeal ? "" : String(input.material || "").trim(),
    status: input.status === "billing" ? "execution" : TODO_STATUSES.has(input.status) ? input.status : "open",
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    // Older tasks without this field are intentionally shown as sorted.
    userOrderBuckets: cleanTodoUserOrderBuckets(input.userOrderBuckets),
    urgent: isMeal || isTimeEntry || input.status === "billing" ? false : Boolean(input.urgent),
    warranty: input.status === "execution" && Boolean(input.warranty),
    syncUser: cleanUserId(input.syncUser),
    sourceProjectTodoId: String(input.sourceProjectTodoId || "").trim().slice(0, 100),
    done: input.status === "execution",
    billingHourlyRate: nonnegativeNumber(input.billingHourlyRate, null, 10_000),
    billingKm: isMeal ? 0 : nonnegativeNumber(input.billingKm, null, 1_000_000),
    clientKm: isMeal ? 0 : nonnegativeNumber(input.clientKm, null, 1_000_000),
    clientVehicle: isMeal ? "personal" : todoVehicle(input.clientVehicle),
    clientKmRate: 0,
    driveFiles: isMeal ? [] : cleanTodoDriveFiles(input.driveFiles),
    photos: isMeal ? [] : limitTodoAttachmentsData(photos
      .map((photo) => ({
        id: photo.id || crypto.randomUUID(),
        name: String(photo.name || "priloga").slice(0, 120),
        attachmentId: String(photo.attachmentId || ""),
        comment: String(photo.comment || "").trim().slice(0, 500),
        data: String(photo.data || ""),
        thumbnailData: String(photo.thumbnailData || ""),
        createdBy: photo.createdBy || "",
        createdByName: photo.createdByName || "",
        createdAt: photo.createdAt || new Date().toISOString()
      }))
      .filter((photo) => validTodoAttachmentDataUrl(photo.data) || validTodoAttachmentId(photo.attachmentId))
      .slice(0, 8))
  };
}
function cleanClient(input) {
  const taxId = normalizeTaxId(input.taxId || input.clientId || input.id);
  const requestedId = String(input.clientId || input.id || "").trim();
  return normalizeStoredClient({
    id: requestedId,
    clientId: requestedId,
    name: String(input.name || "").trim(),
    search: String(input.search || input.name || "").trim(),
    email: String(input.email || "").trim(),
    phone: String(input.phone || "").trim(),
    address: String(input.address || "").trim(),
    city: String(input.city || "").trim(),
    postal: String(input.postal || "").trim(),
    country: String(input.country || "").trim(),
    taxId,
    vatPayer: Boolean(input.vatPayer),
    source: input.source || (taxId ? "local" : "ad-hoc"),
    needsReview: input.needsReview === undefined ? !taxId : Boolean(input.needsReview),
    createdBy: input.createdBy || "system",
    createdAt: input.createdAt
  });
}

function cleanDebt(input) {
  return {
    month: String(input.month || "").trim(),
    person: ["ibro", "bojan"].includes(input.person) ? input.person : "ibro",
    amount: Number(input.amount || 0),
    reason: String(input.reason || "").trim()
  };
}

function cleanAdvance(input) {
  const photos = Array.isArray(input.photos) ? input.photos : [];
  return {
    type: "advance",
    person: cleanUserId(input.person || input.workerId),
    date: String(input.date || "").trim(),
    amount: Number(input.amount || 0),
    reason: String(input.reason || input.comment || "").trim().slice(0, 2_000),
    projectTodoId: String(input.projectTodoId || "").trim().slice(0, 100),
    photos: limitTodoAttachmentsData(photos.map((photo) => ({
      id: photo.id || crypto.randomUUID(),
      name: String(photo.name || "priloga").slice(0, 120),
      attachmentId: String(photo.attachmentId || ""),
      comment: String(photo.comment || "").trim().slice(0, 500),
      data: String(photo.data || ""),
      thumbnailData: String(photo.thumbnailData || ""),
      createdBy: photo.createdBy || "",
      createdByName: photo.createdByName || "",
      createdAt: photo.createdAt || new Date().toISOString()
    })).filter((photo) => validTodoAttachmentDataUrl(photo.data) || validTodoAttachmentId(photo.attachmentId)).slice(0, 8))
  };
}

function cleanPersonalPurchase(input) {
  return { ...cleanAdvance(input), type: "personal_purchase", projectTodoId: "" };
}

function validatePersonalPurchase(purchase, db) {
  const error = validateAdvance(purchase, db);
  return error ? error.replace("založenega denarja", "osebnega nakupa") : "";
}

function validateAdvance(advance, db) {
  if (!advance.person || !db.users?.[advance.person]) return "Izberi delavca.";
  if (!isDateKey(advance.date)) return "Datum založenega denarja ni pravilen.";
  if (!Number.isFinite(advance.amount) || advance.amount <= 0) return "Vnesi znesek.";
  if (!advance.reason) return "Vnesi komentar.";
  if ((advance.photos || []).some((photo) => !validTodoAttachmentDataUrl(photo.data) && !validTodoAttachmentId(photo.attachmentId))) return "Priloga ni veljavna slika ali PDF.";
  return "";
}

function validateClient(client) {
  if (!client.name) return "Manjka naziv stranke.";
  if (client.taxId && !isUsableTaxId(client.taxId)) return "Davčna številka ni veljavna.";
  return "";
}

function validateDebt(debt) {
  if (!/^\d{4}-\d{2}$/.test(debt.month)) return "Mesec dolga ni pravilen.";
  if (!Number.isFinite(debt.amount) || debt.amount <= 0) return "Vnesi znesek dolga.";
  if (!debt.reason) return "Vnesi zakaj je nastal dolg.";
  return "";
}

function validateTodo(todo, { requireClientId = false } = {}) {
  if (!todo.title) return "Manjka opis opravila.";
  if (requireClientId && todo.client && !todo.clientId) return "Stranke ni bilo mogoče identificirati.";
  if (todo.date && !/^\d{4}-\d{2}-\d{2}$/.test(todo.date)) return "Datum opravila ni pravilen.";
  if (Boolean(todo.start) !== Boolean(todo.end)) return "Vnesi obe uri: od in do.";
  if ((todo.start || todo.end) && !todo.date) return "Za opravilo z uro vnesi tudi datum.";
  if (todo.start && (!/^\d{2}:\d{2}$/.test(todo.start) || !/^\d{2}:\d{2}$/.test(todo.end))) return "Čas opravila ni pravilen.";
  if (TIME_ENTRY_TODO_STATUSES.has(todo.status) && (!todo.date || !todo.start || !todo.end)) {
    const label = todo.status === "meal" ? "malico" : todo.status === "drive" ? "vo\u017enjo" : todo.status === "purchase" ? "nabavo" : "zaklju\u010deno opravilo";
    return `Za ${label} vnesi datum ter uro od in do.`;
  }
  if (todo.start && todo.end <= todo.start) return "Ura do mora biti kasneje kot ura od.";
  if ((todo.photos || []).some((photo) => !validTodoAttachmentDataUrl(photo.data) && !validTodoAttachmentId(photo.attachmentId))) return "Priloga ni veljavna slika ali PDF.";
  if ((todo.photos || []).reduce((total, photo) => total + String(photo.data || "").length, 0) > MAX_TODO_ATTACHMENTS_DATA_LENGTH) return "Priloge so skupaj prevelike.";
  if ((todo.photos || []).some((photo) => photo.thumbnailData && !validTodoThumbnailDataUrl(photo.thumbnailData))) return "Predogled PDF priloge ni veljaven.";
  if ((todo.driveFiles || []).length > 12) return "Največ je 12 zunanjih Google Dokumentov ali Preglednic na opravilo.";
  if ((todo.driveFiles || []).some((file) => {
    const info = googleWorkspaceFileInfo(file?.url);
    return !validGoogleDriveId(file?.fileId) || !info || info.fileId !== file.fileId || (file.kind && info.kind !== file.kind);
  })) return "Zunanja povezava mora biti veljaven Google Dokument ali Preglednica.";
  return "";
}

function stampTodoPhotos(todo, user) {
  return (todo.photos || []).map((photo) => ({
    ...photo,
    createdBy: photo.createdBy || user.id,
    createdByName: photo.createdByName || user.name,
    createdAt: photo.createdAt || new Date().toISOString()
  }));
}

function icsEscape(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\r", "")
    .replaceAll("\n", "\\n");
}

function icsDateTime(date, time) {
  return `${date.replaceAll("-", "")}T${time.replace(":", "")}00`;
}

function icsDate(date) {
  return String(date || "").replaceAll("-", "");
}

function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00`);
  parsed.setDate(parsed.getDate() + days);
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0")
  ].join("");
}

function foldIcsLine(line) {
  const chunks = [];
  let rest = line;
  while (rest.length > 72) {
    chunks.push(rest.slice(0, 72));
    rest = ` ${rest.slice(72)}`;
  }
  chunks.push(rest);
  return chunks.join("\r\n");
}

function buildCalendarIcs(db, { userId = "", combined = false } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const entries = (db.entries || []).filter((entry) => combined || !userId || (entry.syncUser || entry.createdBy) === userId);
  const assignedTodos = (db.todos || []).filter((todo) => combined || !userId || (todo.syncUser || todo.createdBy) === userId);
  const todos = combined
    ? [...assignedTodos.reduce((groups, todo) => {
      const key = todo.assignmentGroupId || todo.id;
      const current = groups.get(key);
      // A shared event remains active until every worker's own settlement is
      // complete. Prefer its unarchived assignment for the combined calendar.
      if (!current || (current.archivedAt && !todo.archivedAt)) groups.set(key, todo);
      return groups;
    }, new Map()).values()]
    : assignedTodos;
  const assigneeNames = (todo) => todoAssignmentAssigneeIds(db, todo)
    .map((id) => db.users?.[id]?.name || id)
    .filter(Boolean)
    .join(", ");
  const calendarName = combined
    ? "INDUS URE - Vsi delavci"
    : `INDUS URE - ${db.users?.[userId]?.name || "Delovni koledar"}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//INDUS URE//Delovni koledar//SL",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${calendarName}`,
    "X-WR-TIMEZONE:Europe/Ljubljana"
  ];

  for (const entry of entries) {
    if (!entry.date || !entry.start || !entry.end) continue;
    const description = [
      entry.work ? `Delo: ${entry.work}` : "",
      entry.material ? `Material: ${entry.material}` : "",
      entry.people ? `Sodelavci: ${entry.people}` : "",
      entry.km ? `Km: ${entry.km}` : "",
      entry.notes ? `Opombe: ${entry.notes}` : "",
      entry.createdByName ? `Dodal: ${entry.createdByName}` : "",
      entry.updatedByName ? `Spremenil: ${entry.updatedByName}` : ""
    ].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:entry-${entry.id}@indus-ure`, `DTSTAMP:${stamp}`);
    if (entry.status === "vacation") {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(entry.date)}`, `DTEND;VALUE=DATE:${addDays(entry.date, 1)}`);
    } else {
      lines.push(`DTSTART;TZID=Europe/Ljubljana:${icsDateTime(entry.date, entry.start)}`, `DTEND;TZID=Europe/Ljubljana:${icsDateTime(entry.date, entry.end)}`);
    }
    lines.push(
      `SUMMARY:${icsEscape(entrySummary(entry))}`,
      `DESCRIPTION:${icsEscape(description)}`,
      "END:VEVENT"
    );
  }

  for (const todo of todos) {
    if (!todo.date || todo.archivedAt) continue;
    const description = [
      todo.client ? `Stranka: ${todo.client}` : "",
      todo.urgent ? "NUJNO: DA" : "",
      combined ? `Za: ${assigneeNames(todo)}` : "",
      `Status: ${todoStatusDefinition(todo.status).label}`,
      todo.notes ? `Opombe: ${todo.notes}` : "",
      todo.createdByName ? `Dodal: ${todo.createdByName}` : ""
    ].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:todo-${combined ? (todo.assignmentGroupId || todo.id) : todo.id}@indus-ure`, `DTSTAMP:${stamp}`);
    if (todo.start && todo.end) {
      lines.push(`DTSTART;TZID=Europe/Ljubljana:${icsDateTime(todo.date, todo.start)}`, `DTEND;TZID=Europe/Ljubljana:${icsDateTime(todo.date, todo.end)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(todo.date)}`, `DTEND;VALUE=DATE:${addDays(todo.date, 1)}`);
    }
    lines.push(`SUMMARY:${icsEscape(`${todo.urgent ? "NUJNO: " : ""}TODO: ${todo.title}`)}`, `DESCRIPTION:${icsEscape(description)}`, "END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function googleRedirectUri(req) {
  return GOOGLE_REDIRECT_URI || `${absoluteBaseUrl(req)}/api/google/callback`;
}

function googleClient(req, tokens) {
  const { google } = require("googleapis");
  const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, googleRedirectUri(req));
  if (tokens) client.setCredentials(tokens);
  return client;
}

function googleDriveFolderReady(folderId) {
  return googleReady() && validGoogleDriveId(folderId) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(GOOGLE_DRIVE_OWNER_EMAIL);
}

function googleDriveTasksReady() {
  return googleDriveFolderReady(GOOGLE_DRIVE_TASKS_FOLDER_ID);
}

function googleDriveAttachmentsReady() {
  return googleDriveFolderReady(GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID);
}

function googleDriveOwner(db) {
  return userByEmail(db, GOOGLE_DRIVE_OWNER_EMAIL) || null;
}

function googleDriveTokenAvailable(user) {
  return Boolean(user?.google?.tokens);
}

function googleWorkspaceTokenAvailable(user) {
  return googleDriveTokenAvailable(user)
    && Number(user.google?.driveScopeVersion || 0) === GOOGLE_DRIVE_SCOPE_VERSION;
}

// A saved OAuth token is not proof that Google still accepts it. Check the
// token with a read-only Drive request before showing the connection as ready.
async function googleDriveConnectionStatus(req, db) {
  const driveOwner = googleDriveOwner(db);
  const configured = googleDriveTasksReady() && googleDriveAttachmentsReady();
  const base = {
    configured,
    tasksFolderConfigured: googleDriveTasksReady(),
    attachmentsFolderConfigured: googleDriveAttachmentsReady(),
    connected: googleDriveTokenAvailable(driveOwner),
    gmailConnected: googleWorkspaceTokenAvailable(driveOwner),
    usable: false,
    reconnectRequired: false,
    checkUnavailable: false
  };
  if (!configured) return base;
  if (!base.connected) return { ...base, reconnectRequired: true };
  try {
    const { google } = require("googleapis");
    const drive = google.drive({ version: "v3", auth: googleClient(req, driveOwner.google.tokens) });
    await drive.about.get({ fields: "user(emailAddress)" });
    return { ...base, usable: true };
  } catch (error) {
    if (googleConnectionFailure(error)) return { ...base, reconnectRequired: true };
    // A temporary Google/network problem must not incorrectly tell Bojan to
    // revoke and reconnect a valid account.
    return { ...base, checkUnavailable: true };
  }
}

async function createManagedGoogleDriveFile(req, db, actor, input = {}) {
  if (!googleDriveTasksReady()) {
    throw new Error("Google Dokumenti niso nastavljeni: manjka mapa ali Bojanov e-naslov v okolju strežnika.");
  }
  const owner = googleDriveOwner(db);
  if (!googleDriveTokenAvailable(owner)) {
    throw new Error("Bojan mora najprej v Nastavitvah povezati Google Dokumente in preglednice.");
  }
  const kind = input.kind === "spreadsheet" ? "spreadsheet" : input.kind === "document" ? "document" : "";
  if (!kind) throw new Error("Izberi Google Dokument ali Google Preglednico.");
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Najprej vpiši ime opravila.");
  const client = String(input.client || "").trim();
  const name = [client, title].filter(Boolean).join(" - ").slice(0, 180);
  const { google } = require("googleapis");
  const drive = google.drive({ version: "v3", auth: googleClient(req, owner.google.tokens) });
  const mimeType = kind === "document"
    ? "application/vnd.google-apps.document"
    : "application/vnd.google-apps.spreadsheet";
  let created = null;
  try {
    const response = await drive.files.create({
      requestBody: {
        name,
        mimeType,
        parents: [GOOGLE_DRIVE_TASKS_FOLDER_ID],
        appProperties: {
          indusApp: INDUS_GOOGLE_APP_ID,
          indusResource: "task-attachment"
        }
      },
      fields: "id,name,mimeType,webViewLink,parents,owners(emailAddress),driveId"
    });
    created = response.data;
    await drive.permissions.create({
      fileId: created.id,
      requestBody: { type: "anyone", role: "reader", allowFileDiscovery: false },
      fields: "id,type,role"
    });
    const ownedByBojan = (created.owners || []).some((item) => String(item.emailAddress || "").toLowerCase() === GOOGLE_DRIVE_OWNER_EMAIL);
    const inConfiguredFolder = (created.parents || []).includes(GOOGLE_DRIVE_TASKS_FOLDER_ID);
    if (!created.id || !created.webViewLink || created.driveId || !ownedByBojan || !inConfiguredFolder) {
      throw new Error("Google datoteke ni bilo mogoče ustvariti kot Bojanovo datoteko v izbrani mapi.");
    }
    return {
      id: crypto.randomUUID(),
      kind,
      fileId: created.id,
      url: created.webViewLink,
      name: String(created.name || name).slice(0, 180),
      managed: true,
      ownerEmail: GOOGLE_DRIVE_OWNER_EMAIL,
      createdBy: actor.id,
      createdByName: actor.name,
      createdAt: new Date().toISOString()
    };
  } catch (error) {
    if (created?.id) {
      try {
        await drive.files.delete({ fileId: created.id });
      } catch (cleanupError) {
        console.warn(`Google osnutka ${created.id} ni bilo mogoče odstraniti: ${cleanupError.message || cleanupError}`);
      }
    }
    throw error;
  }
}

function cleanDriveUploadName(value) {
  return String(value || "video")
    .replace(/[\u0000-\u001f<>:"\\/|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "video";
}

function videoMimeType(value, filename = "") {
  const requested = String(value || "").split(";", 1)[0].trim().toLowerCase();
  if (requested.startsWith("video/")) return requested;
  const extension = path.extname(String(filename || "")).toLowerCase();
  return ({
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".3gp": "video/3gpp"
  })[extension] || "";
}

function limitIncomingVideoStream(stream, maximumBytes) {
  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maximumBytes) {
        const error = new Error("Video je prevelik. Najve\u010dja dovoljena velikost je " + Math.round(maximumBytes / 1024 / 1024) + " MB.");
        stream.destroy(error);
        callback(error);
        return;
      }
      callback(null, chunk);
    }
  });
  stream.once("aborted", () => limiter.destroy(new Error("Prenos videa je bil prekinjen.")));
  stream.once("error", (error) => limiter.destroy(error));
  return stream.pipe(limiter);
}

function videoStorageExtension(mimeType, filename = "") {
  const known = {
    "video/mp4": ".mp4",
    "video/x-m4v": ".m4v",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "video/3gpp": ".3gp"
  };
  return known[String(mimeType || "").toLowerCase()] || path.extname(String(filename || "")).toLowerCase() || ".video";
}

async function receiveLocalTodoVideo(input = {}) {
  const mimeType = videoMimeType(input.mimeType, input.name);
  if (!mimeType) throw new Error("Izberi veljavno video datoteko.");
  const declaredBytes = Number(input.contentLength);
  if (Number.isSafeInteger(declaredBytes) && declaredBytes <= 0) throw new Error("Praznega videa ni mogoče dodati.");
  if (Number.isSafeInteger(declaredBytes) && declaredBytes > MAX_VIDEO_BYTES) throw new Error(`Video je prevelik. Največja dovoljena velikost je ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB.`);

  const uploadDirectory = path.join(MEDIA_DIR, ".uploads");
  await fsp.mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(uploadDirectory, `${crypto.randomUUID()}.part`);
  const digest = crypto.createHash("sha256");
  let byteSize = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > MAX_VIDEO_BYTES) {
        callback(new Error(`Video je prevelik. Največja dovoljena velikost je ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB.`));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  input.stream.once("aborted", () => counter.destroy(new Error("Prenos videa je bil prekinjen.")));
  try {
    await pipeline(input.stream, counter, fs.createWriteStream(temporaryPath, { mode: 0o600 }));
    if (!byteSize) throw new Error("Praznega videa ni mogoče dodati.");
    const attachmentId = digest.digest("hex");
    const storageKey = path.posix.join("objects", `${attachmentId}${videoStorageExtension(mimeType, input.name)}`);
    const targetPath = path.join(MEDIA_DIR, ...storageKey.split("/"));
    await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    let createdFile = false;
    try {
      await fsp.rename(temporaryPath, targetPath);
      createdFile = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await fsp.rm(temporaryPath, { force: true });
    }
    return { attachmentId, mimeType, byteSize, storageKey, targetPath, createdFile };
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
function systemGoogleDriveClient(tokens) {
  const { google } = require("googleapis");
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI || undefined);
  auth.setCredentials(tokens || {});
  return google.drive({ version: "v3", auth });
}

async function deleteRetentionManagedDriveFiles(db, files) {
  if (!files.length) return { deleted: 0, skipped: 0 };
  const owner = googleDriveOwner(db);
  if (!googleDriveTokenAvailable(owner)) throw new Error("Google Drive povezava ni na voljo za čiščenje arhivskih prilog.");
  const drive = systemGoogleDriveClient(owner.google.tokens);
  let deleted = 0;
  let skipped = 0;
  for (const file of files) {
    try {
      const metadata = await drive.files.get({ fileId: file.fileId, fields: "id,appProperties,owners(emailAddress)" });
      const ownedByBojan = (metadata.data.owners || []).some((item) => String(item.emailAddress || "").toLowerCase() === GOOGLE_DRIVE_OWNER_EMAIL);
      if (!ownedByBojan || metadata.data.appProperties?.indusApp !== INDUS_GOOGLE_APP_ID) {
        skipped += 1;
        continue;
      }
      await drive.files.delete({ fileId: file.fileId });
      deleted += 1;
    } catch (error) {
      const status = Number(error?.response?.status || error?.code || 0);
      if (status === 404) continue;
      throw error;
    }
  }
  return { deleted, skipped };
}

async function runArchiveRetentionCleanup() {
  const db = await readDbAsync();
  const candidates = archiveRetentionCandidates(db);
  if (!candidates.groups.length) return { ...candidates, purged: { groups: 0, todos: 0, attachments: 0, adHocClients: 0 }, drive: { deleted: 0, skipped: 0 }, blocked: 0 };
  const approvedGroups = [];
  let blocked = 0;
  const drive = { deleted: 0, skipped: 0 };
  for (const group of candidates.groups) {
    try {
      const result = await deleteRetentionManagedDriveFiles(db, group.managedDriveFiles);
      drive.deleted += result.deleted;
      drive.skipped += result.skipped;
      approvedGroups.push(group);
    } catch (error) {
      blocked += 1;
      console.error(`Arhivske priloge za ${group.id} niso bile očiščene: ${error.message || error}`);
    }
  }
  const purged = purgeArchivedTodoGroups(db, approvedGroups);
  if (purged.todos) await writeDbAsync(db);
  if (blocked) {
    await recordOperationalAlert({
      code: "archive-retention-drive-cleanup-failed",
      severity: "warning",
      title: "Čiščenje arhiva čaka na Google Drive",
      message: `${blocked} arhiviranih dogodkov ni bilo očiščenih, ker njihovih aplikacijskih Drive prilog ni bilo mogoče varno odstraniti. Poveži Google Drive in sistem bo poskusil znova.`
    });
  }
  return { ...candidates, purged, drive, blocked };
}

function scheduleArchiveRetentionCleanup(force = false) {
  if (archiveRetentionCleanupPromise) return archiveRetentionCleanupPromise;
  if (!force && archiveRetentionCleanupLastAt && Date.now() - archiveRetentionCleanupLastAt < ARCHIVE_RETENTION_CLEANUP_INTERVAL_MS) return Promise.resolve(null);
  archiveRetentionCleanupPromise = mutationQueue.then(async () => {
    const result = await runArchiveRetentionCleanup();
    archiveRetentionCleanupLastAt = Date.now();
    if (result.purged.todos) console.info(`Čiščenje arhiva: ${result.purged.todos} dogodkov, ${result.purged.attachments} prilog, ${result.purged.adHocClients} ad-hoc strank.`);
    return result;
  });
  mutationQueue = archiveRetentionCleanupPromise.catch((error) => {
    console.error(`Čiščenje arhiva ni uspelo: ${error.message || error}`);
  });
  return archiveRetentionCleanupPromise.finally(() => { archiveRetentionCleanupPromise = null; });
}

function todoStatusDefinition(status) {
  return TODO_STATUS_DEFINITIONS[status] || TODO_STATUS_DEFINITIONS.open;
}

function entrySummary(entry) {
  const title = entry.work || entry.material || "Delo";
  if (entry.status === "errand") return title || "Opravki";
  if (entry.status === "vacation") return title || "Dopust";
  return `${entry.client || "Stranka"} - ${title}`;
}
function payrollTodosForArchive(db, payroll) {
  const todoIds = new Set((payroll.lines || []).map((line) => String(line.todoId || "")).filter(Boolean));
  return (db.todos || []).filter((todo) => todoIds.has(String(todo.id || "")));
}

async function archivePayrollTodos(db, payroll, actor) {
  // A completed project entry is archived only after both sides are locked:
  // the worker payroll and the client bill. Internal work and meals have no
  // client side and therefore need only the worker payroll.
  const result = reconcileTodoArchives(db, actor);
  const awaitingClientBilling = payrollTodosForArchive(db, payroll)
    .filter((todo) => todoRequiresClientBilling(todo) && !todo.clientBillId)
    .length;
  return { ...result, awaitingClientBilling, archiveCalendarName: "interni arhiv" };
}
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pfb": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function serveStatic(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, securityHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      "Allow": "GET, HEAD"
    }));
    res.end(req.method === "HEAD" ? undefined : "Method not allowed");
    return;
  }

  let pathname;
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, "Bad request", "text/plain");
    return;
  }

  let filePath;
  let cacheControl = "no-store";
  if (pathname === "/" || pathname === "/index.html") {
    filePath = path.join(root, "index.html");
  } else if (["/manifest.webmanifest", "/service-worker.js"].includes(pathname)) {
    filePath = path.join(root, pathname.slice(1));
    cacheControl = "no-cache";
  } else if (pathname.startsWith("/vendor/pdfjs/")) {
    const vendorRoot = path.resolve(root, "..", "node_modules", "pdfjs-dist");
    const relativePath = pathname.slice("/vendor/pdfjs/".length);
    const allowedVendorPath = ["build/", "standard_fonts/", "wasm/"]
      .some((prefix) => relativePath.startsWith(prefix));
    filePath = path.resolve(vendorRoot, relativePath);
    if (!allowedVendorPath || (filePath !== vendorRoot && !filePath.startsWith(`${vendorRoot}${path.sep}`))) {
      sendText(res, 404, "Not found", "text/plain");
      return;
    }
    cacheControl = "public, max-age=31536000, immutable";
  } else if (pathname.startsWith("/assets/")) {
    const assetsRoot = path.join(root, "assets");
    filePath = path.resolve(root, `.${pathname}`);
    if (filePath !== assetsRoot && !filePath.startsWith(`${assetsRoot}${path.sep}`)) {
      sendText(res, 404, "Not found", "text/plain");
      return;
    }
    cacheControl = "public, max-age=86400";
  } else {
    sendText(res, 404, "Not found", "text/plain");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, "Not found", "text/plain");
      return;
    }
    const type = STATIC_TYPES[path.extname(filePath).toLowerCase()];
    if (!type) {
      sendText(res, 404, "Not found", "text/plain");
      return;
    }
    let responseData = data;
    let nonce = "";
    if (filePath === path.join(root, "index.html")) {
      nonce = crypto.randomBytes(18).toString("base64");
      responseData = Buffer.from(data.toString("utf8")
        .replace("<style>", `<style nonce="${nonce}">`)
        .replace("<script>", `<script nonce="${nonce}">`), "utf8");
    }
    res.writeHead(200, securityHeaders({
      "Content-Type": type,
      "Cache-Control": cacheControl,
      "Content-Length": responseData.length
    }, nonce));
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(responseData);
    }
  });
}

function cleanupPendingGoogleStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, startedAt] of pendingGoogleLogins) {
    if (startedAt < cutoff) pendingGoogleLogins.delete(state);
  }
  for (const [state, pending] of pendingGoogleConnections) {
    if (pending.startedAt < cutoff) pendingGoogleConnections.delete(state);
  }
}

async function sendAttachmentFile(res, attachment) {
  const stat = await fsp.stat(attachment.filePath);
  res.writeHead(200, securityHeaders({
    "Content-Type": attachment.mimeType || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": "inline"
  }));
  fs.createReadStream(attachment.filePath).on("error", () => res.destroy()).pipe(res);
}

function attachmentVisibleToUser(db, user, attachmentId) {
  const todoVisible = (db.todos || []).some((todo) => canManageTodo(user, todo)
    && (todo.photos || []).some((photo) => photo.attachmentId === attachmentId));
  const advanceVisible = (db.debts || []).some((debt) => (user.role === "boss" || debt.person === user.id)
    && (debt.photos || []).some((photo) => photo.attachmentId === attachmentId));
  return todoVisible || advanceVisible;
}

const MAX_BROWSER_RESTORE_BYTES = 1_500 * 1024 * 1024;
const MAX_BROWSER_RESTORE_FILES = 20_000;

function browserBackupUser(user = {}) {
  return {
    id: String(user.id || ""),
    email: String(user.email || ""),
    name: String(user.name || ""),
    role: user.role === "boss" ? "boss" : "worker",
    avatar: String(user.avatar || "")
  };
}

function browserBackupState(db) {
  const attachments = Object.fromEntries(Object.entries(db.attachments || {}).map(([id, attachment]) => {
    const copy = { ...attachment };
    delete copy.data;
    delete copy.thumbnailData;
    return [id, copy];
  }));
  return {
    format: "indus-ure-browser-backup-v1",
    exportedAt: new Date().toISOString(),
    includes: ["data", "settings", "media"],
    excludes: ["sessions", "password hashes", "OAuth tokens", "server secrets"],
    snapshot: {
      users: Object.fromEntries(Object.entries(db.users || {}).map(([id, user]) => [id, browserBackupUser(user)])),
      entries: db.entries || [],
      todos: db.todos || [],
      attachments,
      debts: db.debts || [],
      clients: db.clients || [],
      billingLocks: db.billingLocks || [],
      payrolls: db.payrolls || [],
      clientBills: db.clientBills || [],
      settings: db.settings || {}
    }
  };
}

async function sendBrowserBackup(res, db) {
  const archiver = require("archiver");
  const filename = `indus-ure-data-${new Date().toISOString().slice(0, 10)}.zip`;
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (error) => res.destroy(error));
  res.writeHead(200, securityHeaders({
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store"
  }));
  archive.pipe(res);
  archive.append(JSON.stringify(browserBackupState(db), null, 2), { name: "metadata.json" });
  if (fs.existsSync(MEDIA_DIR)) archive.directory(MEDIA_DIR, "media");
  await archive.finalize();
}

function safeRestoreRelativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\u0000")) return "";
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return normalized;
}

async function receiveBrowserRestoreZip(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && (!Number.isFinite(declared) || declared > MAX_BROWSER_RESTORE_BYTES)) throw new Error("Varnostna kopija je prevelika za uvoz.");
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "indus-ure-restore-"));
  const file = path.join(directory, "upload.zip");
  const output = fs.createWriteStream(file, { mode: 0o600 });
  let total = 0;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > MAX_BROWSER_RESTORE_BYTES) req.destroy(new Error("Varnostna kopija je prevelika za uvoz."));
  });
  try {
    await pipeline(req, output);
    if (!total) throw new Error("Varnostna kopija je prazna.");
    return { directory, file };
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function extractBrowserRestoreZip(zipFile, directory) {
  const unzipper = require("unzipper");
  const zip = await unzipper.Open.file(zipFile);
  if (!zip.files.length || zip.files.length > MAX_BROWSER_RESTORE_FILES) throw new Error("ZIP ima neveljavno število datotek.");
  let total = 0;
  for (const entry of zip.files) {
    const relative = safeRestoreRelativePath(entry.path);
    if (!relative || (!relative.startsWith("media/") && relative !== "metadata.json")) throw new Error("ZIP vsebuje nedovoljeno pot.");
    if (entry.type === "Directory") continue;
    const size = Number(entry.uncompressedSize || 0);
    total += size;
    if (!Number.isFinite(size) || total > MAX_BROWSER_RESTORE_BYTES) throw new Error("Razširjena varnostna kopija je prevelika.");
    const destination = path.resolve(directory, relative);
    if (!destination.startsWith(`${directory}${path.sep}`)) throw new Error("ZIP pot ni varna.");
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await pipeline(entry.stream(), fs.createWriteStream(destination, { mode: 0o600 }));
  }
  const metadataPath = path.join(directory, "metadata.json");
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
  } catch {
    throw new Error("ZIP nima veljavne datoteke metadata.json.");
  }
  if (metadata?.format !== "indus-ure-browser-backup-v1" || !metadata.snapshot || typeof metadata.snapshot !== "object") {
    throw new Error("To ni veljavna varnostna kopija INDUS URE.");
  }
  return metadata;
}

function restoredBrowserState(current, metadata) {
  const snapshot = metadata.snapshot || {};
  const arrays = ["entries", "todos", "debts", "clients", "billingLocks", "payrolls", "clientBills"];
  for (const key of arrays) if (snapshot[key] !== undefined && !Array.isArray(snapshot[key])) throw new Error(`Neveljavni podatki: ${key}.`);
  if (snapshot.attachments !== undefined && (typeof snapshot.attachments !== "object" || Array.isArray(snapshot.attachments))) throw new Error("Neveljavni podatki prilog.");
  const importedUsers = snapshot.users && typeof snapshot.users === "object" ? snapshot.users : {};
  const users = Object.fromEntries(Object.entries(current.users || {}).map(([id, currentUser]) => {
    const imported = importedUsers[id] || {};
    return [id, {
      ...currentUser,
      ...browserBackupUser({ ...currentUser, ...imported }),
      passwordHash: currentUser.passwordHash,
      google: currentUser.google
    }];
  }));
  return normalizeDb({
    ...current,
    users,
    sessions: {},
    entries: snapshot.entries || [],
    todos: snapshot.todos || [],
    attachments: snapshot.attachments || {},
    debts: snapshot.debts || [],
    clients: snapshot.clients || [],
    billingLocks: snapshot.billingLocks || [],
    payrolls: snapshot.payrolls || [],
    clientBills: snapshot.clientBills || [],
    settings: snapshot.settings && typeof snapshot.settings === "object" ? snapshot.settings : {},
    restoredAt: new Date().toISOString(),
    restoredFromBrowserBackupAt: String(metadata.exportedAt || "")
  }).db;
}

async function assertRestoredMediaExists(restored, stagedMediaDir) {
  for (const attachment of Object.values(restored.attachments || {})) {
    for (const key of [attachment.storageKey, attachment.thumbnailKey].filter(Boolean)) {
      const relative = safeRestoreRelativePath(key);
      const candidate = relative ? path.resolve(stagedMediaDir, relative) : "";
      if (!candidate || !candidate.startsWith(`${stagedMediaDir}${path.sep}`) || !fs.existsSync(candidate)) {
        throw new Error("Varnostna kopija nima vseh datotek prilog.");
      }
    }
  }
}

async function restoreBrowserBackup(upload, currentDb) {
  if (!DATABASE_URL) throw new Error("Obnova v brskalniku je na voljo samo s PostgreSQL hrambo.");
  const stage = await fsp.mkdtemp(path.join(path.dirname(MEDIA_DIR), ".indus-ure-restore-"));
  let rollbackMedia = "";
  try {
    const metadata = await extractBrowserRestoreZip(upload.file, stage);
    const restored = restoredBrowserState(currentDb, metadata);
    const stagedMedia = path.join(stage, "media");
    await fsp.mkdir(stagedMedia, { recursive: true, mode: 0o700 });
    await assertRestoredMediaExists(restored, stagedMedia);
    if (fs.existsSync(MEDIA_DIR)) {
      rollbackMedia = `${MEDIA_DIR}.before-restore-${Date.now()}`;
      await fsp.rename(MEDIA_DIR, rollbackMedia);
    }
    await fsp.rename(stagedMedia, MEDIA_DIR);
    try {
      await writeDbAsync(restored);
    } catch (error) {
      await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
      if (rollbackMedia && fs.existsSync(rollbackMedia)) await fsp.rename(rollbackMedia, MEDIA_DIR).catch(() => {});
      throw error;
    }
    return { restoredAt: restored.restoredAt, rollbackMedia: rollbackMedia ? path.basename(rollbackMedia) : "" };
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(upload.directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function backupStatus() {
  if (!DATABASE_URL) return [];
  const result = await getPgPool().query("select status, data, created_at, finished_at from indus_backup_runs order by created_at desc limit 12");
  return result.rows.map((row) => ({ ...row.data, status: row.status, createdAt: row.created_at, finishedAt: row.finished_at }));
}
async function sendOperationalAlertEmail(notification) {
  if (!ALERT_SMTP_URL || !ALERT_EMAIL_FROM || !ALERT_EMAIL_TO) return false;
  try {
    if (!alertTransport) alertTransport = require("nodemailer").createTransport(ALERT_SMTP_URL);
    await alertTransport.sendMail({
      from: ALERT_EMAIL_FROM,
      to: ALERT_EMAIL_TO,
      subject: `[INDUS URE] ${notification.title}`,
      text: `${notification.message}\n\nČas: ${notification.createdAt}\nKoda: ${notification.code}`
    });
    return true;
  } catch (error) {
    console.error(`Sistemskega e-poštnega opozorila ni bilo mogoče poslati: ${error.message || error}`);
    return false;
  }
}

async function collapseUnreadOperationalAlerts() {
  if (!DATABASE_URL) return 0;
  const result = await getPgPool().query(
    `delete from indus_notifications
     where id in (
       select id from (
         select id, row_number() over (
           partition by data ->> 'code'
           order by created_at desc, id desc
         ) as row_number
         from indus_notifications
         where user_id = $1
           and read_at is null
           and coalesce(data ->> 'code', '') <> ''
       ) duplicates
       where row_number > 1
     )`,
    ["bojan"]
  );
  return result.rowCount || 0;
}

async function recordOperationalAlert({ code, severity = "warning", title, message }) {
  const last = Number(monitorAlertCooldowns.get(code) || 0);
  if (Date.now() - last < 6 * 60 * 60 * 1000) return false;
  monitorAlertCooldowns.set(code, Date.now());
  const notification = { id: crypto.randomUUID(), code, severity, title, message, createdAt: new Date().toISOString() };
  if (DATABASE_URL) {
    try {
      // This check survives an application restart. An unresolved alert is one
      // condition, not a new notification every time the monitoring job runs.
      const existing = await getPgPool().query(
        `select id from indus_notifications
         where user_id = $1 and read_at is null and data ->> 'code' = $2
         order by created_at desc limit 1`,
        ["bojan", code]
      );
      if (existing.rowCount) {
        await collapseUnreadOperationalAlerts();
        return false;
      }
      await getPgPool().query(
        `insert into indus_notifications (id, user_id, severity, data)
         values ($1, $2, $3, $4::jsonb)`,
        [notification.id, "bojan", severity, JSON.stringify(notification)]
      );
    } catch (error) {
      console.error(`Sistemskega opozorila ni bilo mogoče shraniti: ${error.message || error}`);
    }
  }
  await sendOperationalAlertEmail(notification);
  return true;
}

async function listOperationalNotifications() {
  if (!DATABASE_URL) return [];
  // Read operational alerts are transient: keep the acknowledgement visible in
  // the current dialog, then remove it on the next application refresh.
  await getPgPool().query("delete from indus_notifications where user_id = $1 and read_at is not null", ["bojan"]);
  // Older application restarts may already have produced duplicates. Keep the
  // newest occurrence of each still-active code before showing the list.
  await collapseUnreadOperationalAlerts();
  const result = await getPgPool().query(
    `select id, severity, read_at, data, created_at
     from indus_notifications where user_id = $1 and read_at is null order by created_at desc limit 40`,
    ["bojan"]
  );
  return result.rows.map((row) => ({ ...row.data, id: row.id, severity: row.severity, readAt: row.read_at, createdAt: row.created_at }));
}
async function markOperationalNotificationRead(id) {
  if (!DATABASE_URL) return;
  await getPgPool().query("update indus_notifications set read_at = now() where id = $1 and user_id = $2", [id, "bojan"]);
}

async function runOperationalMonitor() {
  const issues = [];
  if (DATABASE_URL) {
    try {
      await getPgPool().query("select 1");
    } catch {
      issues.push({ code: "database-unreachable", severity: "critical", title: "PostgreSQL ni dosegljiv", message: "Aplikacija se ne more povezati z bazo podatkov." });
    }
    try {
      const latestRun = await getPgPool().query("select status, data, created_at, finished_at from indus_backup_runs order by created_at desc limit 1");
      const recent = latestRun.rows[0];
      if (recent?.status === "failed") {
        const detail = String(recent.data?.error || "Neznana napaka pri nocnem backupu.").slice(0, 600);
        issues.push({ code: "backup-failed", severity: "critical", title: "Varnostna kopija ni uspela", message: `Zadnji samodejni recovery backup ni uspel: ${detail}` });
      }
      const backup = await getPgPool().query("select finished_at from indus_backup_runs where status = 'success' order by finished_at desc limit 1");
      const latest = new Date(backup.rows[0]?.finished_at || 0).getTime();
      if (recent?.status !== "failed" && (!latest || Date.now() - latest > 36 * 60 * 60 * 1000)) {
        issues.push({ code: "backup-stale", severity: "warning", title: "Varnostna kopija je zastarela", message: "Ni preverjene recovery varnostne kopije v zadnjih 36 urah." });
      }
    } catch {
      // Database availability alert above contains the useful information.
    }
  }
  try {
    const stats = await fsp.statfs(MEDIA_DIR);
    const free = Number(stats.bavail || stats.bfree || 0);
    const total = Number(stats.blocks || 0);
    if (total && (1 - free / total) >= 0.85) {
      issues.push({ code: "storage-low", severity: "warning", title: "Na strežniku zmanjkuje prostora", message: "Prostor za priloge je nad 85 % zaseden." });
    }
  } catch {
    issues.push({ code: "media-unavailable", severity: "critical", title: "Mapa prilog ni dosegljiva", message: "Strežnik ne more preveriti ali zapisovati prilog." });
  }
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  if (rssMb > MONITOR_MAX_RSS_MB) {
    issues.push({ code: "memory-high", severity: "warning", title: "Poraba pomnilnika je visoka", message: `Proces INDUS URE porabi ${Math.round(rssMb)} MB RAM.` });
  }
  for (const issue of issues) await recordOperationalAlert(issue);
  scheduleArchiveRetentionCleanup().catch((error) => console.error(`Čiščenje arhiva ni uspelo: ${error.message || error}`));
}

function startOperationalMonitor() {
  if (monitorTimer) return;
  runOperationalMonitor().catch((error) => console.error(`Nadzor strežnika ni uspel: ${error.message || error}`));
  monitorTimer = setInterval(() => runOperationalMonitor().catch((error) => console.error(`Nadzor strežnika ni uspel: ${error.message || error}`)), MONITOR_INTERVAL_MS);
  monitorTimer.unref?.();
}
async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    const pendingAttachmentMatch = url.pathname.match(/^\/api\/attachments\/([a-f0-9]{64})\/pending$/);
    if (pendingAttachmentMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      const attachmentId = pendingAttachmentMatch[1];
      const db = await readDbAsync();
      const pending = pendingAttachmentMap(db);
      if (pending[attachmentId]?.userId !== user.id) {
        sendJson(res, 404, { error: "Začasna priloga ne obstaja." });
        return;
      }
      delete pending[attachmentId];
      delete db.attachments[attachmentId];
      await writeDbAsync(db);
      sendJson(res, 200, { ok: true });
      return;
    }
    const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([a-f0-9]{64})(\/thumbnail)?$/);
    if (attachmentMatch && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const attachmentId = attachmentMatch[1];
      const db = await readDbAsync();
      if (!attachmentVisibleToUser(db, user, attachmentId)) {
        sendJson(res, 404, { error: "Priloga ne obstaja." });
        return;
      }
      if (DATABASE_URL) {
        const attachment = await getPgStore().getAttachment(attachmentId, Boolean(attachmentMatch[2]));
        if (!attachment) {
          sendJson(res, 404, { error: "Priloga ne obstaja." });
          return;
        }
        await sendAttachmentFile(res, attachment);
        return;
      }
      const source = db.attachments?.[attachmentId];
      const dataUrl = attachmentMatch[2] ? source?.thumbnailData : source?.data;
      const match = String(dataUrl || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) {
        sendJson(res, 404, { error: "Priloga ne obstaja." });
        return;
      }
      const bytes = Buffer.from(match[2], "base64");
      res.writeHead(200, securityHeaders({ "Content-Type": match[1], "Content-Length": bytes.length, "Cache-Control": "private, max-age=3600", "Content-Disposition": "inline" }));
      res.end(bytes);
      return;
    }
    if (url.pathname === "/api/health" && req.method === "GET") {
      if (DATABASE_URL) await getPgPool().query("select 1");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/backup/status" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Status varnostnih kopij vidi samo šef." });
        return;
      }
      sendJson(res, 200, { backups: await backupStatus() });
      return;
    }

    if (url.pathname === "/api/backup/export" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Varnostno kopijo lahko izvozi samo šef." });
        return;
      }
      const db = await readDbAsync();
      await sendBrowserBackup(res, db);
      return;
    }

    if (url.pathname === "/api/backup/restore" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Obnovo lahko izvede samo šef." });
        return;
      }
      if (String(req.headers["x-indus-restore-confirm"] || "") !== "OBNOVI") {
        sendJson(res, 400, { error: "Za obnovo je potrebna izrecna potrditev OBNOVI." });
        return;
      }
      const type = String(req.headers["content-type"] || "").toLowerCase();
      if (!type.includes("application/zip")) {
        sendJson(res, 415, { error: "Izberi ZIP varnostno kopijo INDUS URE." });
        return;
      }
      const current = await readDbAsync();
      const upload = await receiveBrowserRestoreZip(req);
      const result = await restoreBrowserBackup(upload, current);
      clearSessionCookie(req, res);
      sendJson(res, 200, { ok: true, ...result, requiresLogin: true });
      return;
    }

    if (url.pathname === "/api/notifications" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Opozorila vidi samo šef." });
        return;
      }
      sendJson(res, 200, { notifications: await listOperationalNotifications() });
      return;
    }

    const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (notificationReadMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Opozorila lahko potrdi samo šef." });
        return;
      }
      await markOperationalNotificationRead(decodeURIComponent(notificationReadMatch[1]));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/google/status" || url.pathname === "/api/google/auth-url" || url.pathname === "/api/google/sync") {
      sendJson(res, 410, { error: "Google Calendar sinhronizacija je bila odstranjena. ICS koledar ostaja samo za branje." });
      return;
    }
    if (url.pathname === "/api/google/drive-status" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      const status = await googleDriveConnectionStatus(req, db);
      sendJson(res, 200, {
        ...status,
        owner: String(user.email || "").toLowerCase() === GOOGLE_DRIVE_OWNER_EMAIL
      });
      return;
    }

    if (url.pathname === "/api/auth/google-url" && req.method === "GET") {
      if (!googleReady()) {
        sendJson(res, 400, { error: "Google prijava se ni nastavljena na strežniku." });
        return;
      }
      cleanupPendingGoogleStates();
      const state = `login:${crypto.randomBytes(24).toString("hex")}`;
      pendingGoogleLogins.set(state, Date.now());
      const auth = googleClient(req);
      const automatic = url.searchParams.get("automatic") === "1";
      const requestedLoginHint = String(url.searchParams.get("login_hint") || "").trim().toLowerCase();
      const loginHint = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestedLoginHint) ? requestedLoginHint.slice(0, 254) : "";
      const authOptions = {
        access_type: "online",
        state,
        scope: ["openid", "email", "profile"],
        include_granted_scopes: true
      };
      if (!automatic) authOptions.prompt = "select_account";
      if (loginHint) authOptions.login_hint = loginHint;
      const authUrl = auth.generateAuthUrl(authOptions);
      sendJson(res, 200, { url: authUrl });
      return;
    }

    if (url.pathname === "/api/google/drive-auth-url" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (String(user.email || "").toLowerCase() !== GOOGLE_DRIVE_OWNER_EMAIL) {
        sendJson(res, 403, { error: "Google Dokumente lahko poveže samo Bojanov račun." });
        return;
      }
      if (!googleDriveTasksReady()) {
        sendJson(res, 400, { error: "Google Dokumenti niso nastavljeni: manjka mapa ali Bojanov e-naslov v okolju strežnika." });
        return;
      }
      cleanupPendingGoogleStates();
      const state = `drive:${crypto.randomBytes(24).toString("hex")}`;
      pendingGoogleConnections.set(state, { userId: user.id, kind: "drive", startedAt: Date.now() });
      const auth = googleClient(req);
      const authUrl = auth.generateAuthUrl({
        access_type: "offline",
        state,
        scope: [GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_GMAIL_COMPOSE_SCOPE],

        include_granted_scopes: true,
        prompt: "consent",
        login_hint: GOOGLE_DRIVE_OWNER_EMAIL
      });
      sendJson(res, 200, { url: authUrl });
      return;
    }

    if (url.pathname === "/api/google/callback" && req.method === "GET") {
      if (!googleReady()) {
        sendText(res, 400, "Google OAuth ni nastavljen.", "text/plain");
        return;
      }
      const token = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";
      const oauthError = url.searchParams.get("error") || "";
      if (oauthError) {
        sendText(res, 400, "Google prijava oziroma povezava je bila preklicana.", "text/plain");
        return;
      }
      if (!code) {
        sendText(res, 400, "Google ni vrnil avtorizacijske kode.", "text/plain");
        return;
      }
      if (token.startsWith("login:")) {
        const startedAt = pendingGoogleLogins.get(token);
        pendingGoogleLogins.delete(token);
        if (!startedAt || Date.now() - startedAt > 10 * 60 * 1000) {
          sendText(res, 401, "Prijava je potekla. Vrni se na INDUS URE in poskusi znova.", "text/plain");
          return;
        }
        const auth = googleClient(req);
        const result = await auth.getToken(code);
        auth.setCredentials(result.tokens);
        const { google } = require("googleapis");
        const oauth2 = google.oauth2({ version: "v2", auth });
        const profile = await oauth2.userinfo.get();
        const email = String(profile.data.email || "").toLowerCase();
        const db = await readDbAsync();
        const user = userByEmail(db, email);
        if (!user) {
          sendText(res, 403, "Ta Google račun nima dostopa do INDUS URE. Dovoljena sta samo Ibro in Bojan.", "text/plain");
          return;
        }
        const sessionToken = createSession(db, user.id);
        await writeDbAsync(db);
        setSessionCookie(req, res, sessionToken);
        const destination = new URL("/", absoluteBaseUrl(req));
        destination.searchParams.set("login", "ok");
        res.writeHead(303, securityHeaders({ Location: destination.toString(), "Cache-Control": "no-store" }));
        res.end();
        return;
      }
      const pending = pendingGoogleConnections.get(token);
      pendingGoogleConnections.delete(token);
      if (!pending || Date.now() - pending.startedAt > 10 * 60 * 1000) {
        sendText(res, 401, "Prijava je potekla. Zapri to okno, prijavi se v INDUS URE in poskusi znova.", "text/plain");
        return;
      }
      const auth = googleClient(req);
      const result = await auth.getToken(code);
      const db = await readDbAsync();
      const user = db.users[pending.userId];
      if (!user) {
        sendText(res, 401, "Uporabnik ne obstaja več.", "text/plain");
        return;
      }
      user.google = user.google || {};
      if (pending.kind !== "drive") {
        sendText(res, 400, "Ta Google povezava ni več podprta.", "text/plain");
        return;
      }

      const refreshToken = result.tokens.refresh_token || user.google.tokens?.refresh_token || "";
      if (!refreshToken) {
        sendText(res, 400, "Google ni vrnil trajnega dovoljenja. V Google računu odstrani dostop INDUS URE in poskusi znova.", "text/plain");
        return;
      }
      user.google = {
        tokens: { ...result.tokens, refresh_token: refreshToken },
        connectedAt: new Date().toISOString(),
        driveScopeVersion: GOOGLE_DRIVE_SCOPE_VERSION
      };
      await writeDbAsync(db);
      sendText(res, 200, "Google Dokumenti, preglednice, Gmail osnutki in backup so povezani. Lahko zapreš to okno in se vrneš v INDUS URE.", "text/plain");
      return;
    }

    if (url.pathname === "/api/calendar-url" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      const baseUrl = absoluteBaseUrl(req);
      const workerUrl = `${baseUrl}/calendar.ics?token=${encodeURIComponent(db.calendarFeeds[user.id])}`;
      sendJson(res, 200, {
        url: workerUrl,
        workerUrl,
        combinedUrl: user.role === "boss" ? `${baseUrl}/calendar.ics?token=${encodeURIComponent(db.calendarFeeds.bossCombined)}` : ""
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      sendJson(res, 410, { error: "Prijava z geslom je izklopljena. Uporabi Google prijavo." });
      return;
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      if (revokeSession(db, sessionTokenFromRequest(req))) await writeDbAsync(db);
      clearSessionCookie(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/me") {
      const user = await requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, {
        user: publicUser(user),
        csrfToken: req.indusSession?.csrfToken || "",
        sessionExpiresAt: req.indusSession?.expiresAt || 0,
        syncRevision: Number(req.indusDb?.syncRevision || 0)
      });
      return;
    }

    if (url.pathname === "/api/sync-state" && req.method === "GET") {
      const user = await requireUserForSyncState(req, res);
      if (!user) return;
      const revision = Number(req.indusDb?.syncRevision || 0);
      const etag = `"indus-${revision}"`;
      if (String(req.headers["if-none-match"] || "") === etag) {
        res.writeHead(304, securityHeaders({ ETag: etag, "Cache-Control": "no-store" }));
        res.end();
        return;
      }
      sendJson(res, 200, { revision, serverTime: new Date().toISOString(), userId: user.id, etag });
      return;
    }

    if (url.pathname === "/api/users" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      const users = Object.values(db.users || {}).map(publicDirectoryUser);
      sendJson(res, 200, { users });
      return;
    }
    if (url.pathname === "/api/payrolls" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { payrolls: payrollForUser(db, user) });
      return;
    }

    if (url.pathname === "/api/client-report/pdf" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "PDF poročilo za stranko lahko pripravi samo šef." });
        return;
      }
      const body = await readBody(req);
      if (body.eventIds !== undefined && !Array.isArray(body.eventIds)) {
        sendJson(res, 400, { error: "Izbrani vpisi za poročilo niso pravilni." });
        return;
      }
      const db = await readDbAsync();
      const report = clientReportSelection(db, body);
      if (!report) {
        sendJson(res, 409, { error: "Izbrani vpisi niso več na voljo za poročilo. Osvezi pogled in preveri izbor." });
        return;
      }
      const requestedAttachments = clientReportAttachmentSelection(report, body.attachmentIds);
      const attachments = await loadClientReportAttachments(db, requestedAttachments, { destination: "PDF" });
      const pdf = await buildClientReportPdf(db, report, attachments, body.exportOptions);
      const filename = clientReportFilename(report.client);
      res.writeHead(200, securityHeaders({
        "Content-Type": "application/pdf",
        "Content-Length": pdf.length,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      }));
      res.end(pdf);
      return;
    }

    if (url.pathname === "/api/client-report/gmail-draft" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss" || String(user.email || "").toLowerCase() !== GOOGLE_DRIVE_OWNER_EMAIL) {
        sendJson(res, 403, { error: "Gmail osnutek lahko ustvari samo Bojanov račun." });
        return;
      }
      const body = await readBody(req);
      if (body.eventIds !== undefined && !Array.isArray(body.eventIds)) {
        sendJson(res, 400, { error: "Izbrani vpisi za poročilo niso pravilni." });
        return;
      }
      const db = await readDbAsync();
      const owner = googleDriveOwner(db);
      if (!googleReady() || !googleWorkspaceTokenAvailable(owner)) {
        sendJson(res, 409, { error: "V Nastavitvah kot Bojan najprej ponovno poveži Google Dokumente, preglednice in Gmail." });
        return;
      }
      const report = clientReportSelection(db, body);
      if (!report) {
        sendJson(res, 409, { error: "Izbrani vpisi niso več na voljo za poročilo. Osvezi pogled in preveri izbor." });
        return;
      }
      const email = String(report.client?.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(res, 409, { error: "V bazi za izbrano stranko ni veljavnega e-postnega naslova." });
        return;
      }
      const requestedAttachments = clientReportAttachmentSelection(report, body.attachmentIds);
      const attachments = await loadClientReportAttachments(db, requestedAttachments, {
        maxAttachmentBytes: REPORT_GMAIL_MAX_ATTACHMENT_BYTES,
        maxTotalBytes: REPORT_GMAIL_MAX_TOTAL_BYTES,
        destination: "Gmail"
      });
      const pdf = await buildClientReportPdf(db, report, attachments, body.exportOptions);
      const filename = clientReportFilename(report.client);
      try {
        const { google } = require("googleapis");
        const gmail = google.gmail({ version: "v1", auth: googleClient(req, owner.google.tokens) });
        const draft = await gmail.users.drafts.create({
          userId: "me",
          requestBody: { message: { raw: gmailDraftRaw({ to: email, pdf, pdfFilename: filename, attachments }) } }
        });
        sendJson(res, 201, { ok: true, draftId: String(draft.data?.id || ""), email });
      } catch (error) {
        console.error("Gmail osnutka ni bilo mogoče ustvariti:", error.message || error);
        sendJson(res, 502, { error: "Gmail osnutka ni bilo mogoče ustvariti. V Nastavitvah ponovno poveži Google račun in poskusi znova." });
      }
      return;
    }
    if (url.pathname === "/api/client-bills" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Obračune strank vidi samo šef." });
        return;
      }
      const db = await readDbAsync();
      sendJson(res, 200, { clientBills: db.clientBills || [] });
      return;
    }

    if (url.pathname === "/api/client-bills" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Obračun stranki lahko potrdi samo šef." });
        return;
      }
      const body = await readBody(req);
      if (body.eventIds !== undefined && !Array.isArray(body.eventIds)) {
        sendJson(res, 400, { error: "Izbrani vpisi za obračun niso pravilni." });
        return;
      }
      if (Array.isArray(body.eventIds)) {
        body.eventIds = [...new Set(body.eventIds.map((id) => String(id || "").trim()).filter(Boolean))];
        if (!body.eventIds.length) {
          sendJson(res, 400, { error: "Označi vsaj en vpis za obračun stranki." });
          return;
        }
        if (body.eventIds.length > 2_000) {
          sendJson(res, 400, { error: "Za en obračun lahko izbereš največ 2000 vpisov." });
          return;
        }
      }
      if ((body.from && !isDateKey(body.from)) || (body.to && !isDateKey(body.to)) || (body.from && body.to && body.from > body.to)) {
        sendJson(res, 400, { error: "Obdobje obračuna stranki ni pravilno." });
        return;
      }
      const db = await readDbAsync();
      const client = clientForBilling(db, body);
      if (!client) {
        sendJson(res, 400, { error: "Stranke ni bilo mogoče prepoznati." });
        return;
      }
      const clientBill = buildClientBillSnapshot(db, { ...body, clientId: client.clientId, clientName: client.name }, user);
      if (!clientBill) {
        sendJson(res, 409, { error: Array.isArray(body.eventIds) ? "Eden ali več označenih vpisov ni več na voljo za obračun. Osvezi poročilo in preveri izbor." : "Za to stranko v izbranem obdobju ni novih zaključenih storitev za obračun." });
        return;
      }
      db.clientBills.push(clientBill);
      const archive = reconcileTodoArchives(db, user);
      await writeDbAsync(db);
      sendJson(res, 201, { clientBill, clientBills: db.clientBills, archive, todos: visibleTodosForUser(db, user) });
      return;
    }

    const clientBillDeleteMatch = /^\/api\/client-bills\/([^/]+)$/.exec(url.pathname);
    if (clientBillDeleteMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Obračun stranki lahko prekliče samo šef." });
        return;
      }
      const db = await readDbAsync();
      const result = cancelClientBill(db, clientBillDeleteMatch[1], user);
      if (!result) {
        sendJson(res, 404, { error: "Potrjenega obračuna stranki ni bilo mogoče najti." });
        return;
      }
      await writeDbAsync(db);
      sendJson(res, 200, { clientBill: result.clientBill, clientBills: db.clientBills || [], archive: result.archive, todos: visibleTodosForUser(db, user) });
      return;
    }
    if (url.pathname === "/api/payrolls" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko potrdi obračun." });
        return;
      }
      const body = await readBody(req);
      const workerId = cleanUserId(body.workerId);
      const range = payrollRange(body);
      if (!workerId || !range) {
        sendJson(res, 400, { error: "Delavec ali obračunsko obdobje ni pravilno." });
        return;
      }
      if (!payrollPeriodEnded(range)) {
        sendJson(res, 409, { error: "Obračun lahko potrdiš šele po koncu izbranega obračunskega meseca." });
        return;
      }
      const db = await readDbAsync();
      if (!db.users?.[workerId]) {
        sendJson(res, 400, { error: "Delavec ne obstaja." });
        return;
      }
      const existingIndex = db.payrolls.findIndex((payroll) => payroll.workerId === workerId && payroll.from === range.from && payroll.to === range.to);
      const previous = existingIndex >= 0 ? db.payrolls[existingIndex] : {};
      const sequenceError = payrollSequenceError(db, workerId, range, previous.id || "");
      if (sequenceError) {
        sendJson(res, 409, { error: sequenceError });
        return;
      }
      if (previous.status && !["draft", "archiving"].includes(previous.status)) {
        sendJson(res, 409, { error: "Ta obračun je že potrjen ali plačan." });
        return;
      }
      const now = new Date().toISOString();
      let payroll;
      if (previous.status === "archiving") {
        // Resume exactly the snapshot that was locked before archiving started.
        payroll = normalizePayroll({
          ...previous,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now
        }, db);
      } else {
        payroll = buildPayrollSnapshot(db, workerId, range, {
          ...previous,
          id: previous.id || crypto.randomUUID(),
          status: "archiving",
          createdBy: previous.createdBy || user.id,
          createdByName: previous.createdByName || user.name,
          createdAt: previous.createdAt || now,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now
        }, body.note);
      }
      if (!payroll?.lines.length) {
        sendJson(res, 400, { error: "Za izbrano obdobje delavec nima zaključenih vnosov ur." });
        return;
      }
      if (existingIndex >= 0) db.payrolls[existingIndex] = payroll;
      else db.payrolls.push(payroll);
      // Persist the locked snapshot before final confirmation, so a retry can finish safely.
      await writeDbAsync(db);
      payroll = normalizePayroll({
        ...payroll,
        status: "confirmed",
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: new Date().toISOString(),
        confirmedAt: payroll.confirmedAt || new Date().toISOString(),
        confirmedBy: user.id,
        confirmedByName: user.name
      }, db);
      const finalIndex = db.payrolls.findIndex((item) => item.id === payroll.id);
      if (finalIndex >= 0) db.payrolls[finalIndex] = payroll;
      else db.payrolls.push(payroll);
      const archive = await archivePayrollTodos(db, payroll, user);
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user), payroll, archive });
      return;
    }
    const payrollPaymentMatch = url.pathname.match(/^\/api\/payrolls\/([^/]+)\/payments$/);
    if (payrollPaymentMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko evidentira izplačilo." });
        return;
      }
      const body = await readBody(req);
      const amount = nonnegativeNumber(body.amount, null, 1_000_000);
      const note = String(body.note || "").trim().slice(0, 1_000);
      if (amount === null || amount <= 0) {
        sendJson(res, 400, { error: "Vnesi znesek delnega izplačila." });
        return;
      }
      const db = await readDbAsync();
      const index = db.payrolls.findIndex((payroll) => payroll.id === decodeURIComponent(payrollPaymentMatch[1]));
      if (index < 0) {
        sendJson(res, 404, { error: "Obračun ne obstaja." });
        return;
      }
      const current = normalizePayroll(db.payrolls[index], db);
      if (!current || !["confirmed", "paid"].includes(current.status)) {
        sendJson(res, 409, { error: "Delno izplačilo je mogoče vpisati samo pri potrjenem obračunu." });
        return;
      }
      if (amount > current.remainingAmount + 0.005) {
        sendJson(res, 409, { error: `Preostanek za izplačilo je ${current.remainingAmount.toFixed(2)} EUR.` });
        return;
      }
      const now = new Date().toISOString();
      const payments = [...current.payments, { id: crypto.randomUUID(), amount, note, createdAt: now, createdBy: user.id, createdByName: user.name }];
      const next = normalizePayroll({ ...current, payments, status: "confirmed", updatedAt: now, updatedBy: user.id, updatedByName: user.name }, db);
      if (next.remainingAmount <= 0.005) {
        next.status = "paid";
        next.paidAt = now;
        next.paidBy = user.id;
        next.paidByName = user.name;
      }
      db.payrolls[index] = next;
      await writeDbAsync(db);
      sendJson(res, 201, { payroll: next, payrolls: payrollForUser(db, user) });
      return;
    }
    const payrollPaymentDeleteMatch = url.pathname.match(/^\/api\/payrolls\/([^/]+)\/payments\/([^/]+)$/);
    if (payrollPaymentDeleteMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko izbriše evidentirano izplačilo." });
        return;
      }
      const payrollId = decodeURIComponent(payrollPaymentDeleteMatch[1]);
      const paymentId = decodeURIComponent(payrollPaymentDeleteMatch[2]);
      const db = await readDbAsync();
      const index = db.payrolls.findIndex((payroll) => payroll.id === payrollId);
      if (index < 0) {
        sendJson(res, 404, { error: "Obračun ne obstaja." });
        return;
      }
      const current = normalizePayroll(db.payrolls[index], db);
      if (!current || !["confirmed", "paid"].includes(current.status)) {
        sendJson(res, 409, { error: "Izplačilo lahko izbrišeš samo pri potrjenem obračunu." });
        return;
      }
      if (!(current.payments || []).some((payment) => payment.id === paymentId)) {
        sendJson(res, 404, { error: "Izplačilo ne obstaja." });
        return;
      }
      const now = new Date().toISOString();
      const payroll = normalizePayroll({
        ...current,
        status: "confirmed",
        payments: current.payments.filter((payment) => payment.id !== paymentId),
        paidAt: "",
        paidBy: "",
        paidByName: "",
        updatedAt: now,
        updatedBy: user.id,
        updatedByName: user.name
      }, db);
      db.payrolls[index] = payroll;
      await writeDbAsync(db);
      sendJson(res, 200, { payroll, payrolls: payrollForUser(db, user) });
      return;
    }
    const payrollMatch = url.pathname.match(/^\/api\/payrolls\/([^/]+)$/);
    if (payrollMatch && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko potrjuje ali odpira obračune." });
        return;
      }
      const body = await readBody(req);
      const action = String(body.action || "refresh");
      const db = await readDbAsync();
      const index = db.payrolls.findIndex((payroll) => payroll.id === decodeURIComponent(payrollMatch[1]));
      if (index < 0) {
        sendJson(res, 404, { error: "Obračun ne obstaja." });
        return;
      }
      const current = db.payrolls[index];
      const now = new Date().toISOString();
      if (action === "confirm" && !payrollPeriodEnded(current)) {
        sendJson(res, 409, { error: "Obračun lahko potrdiš šele po koncu izbranega obračunskega meseca." });
        return;
      }
      if (action === "confirm") {
        const sequenceError = payrollSequenceError(db, current.workerId, current, current.id);
        if (sequenceError) {
          sendJson(res, 409, { error: sequenceError });
          return;
        }
      }
      let payroll;
      if (action === "refresh") {
        if (current.status !== "draft") {
          sendJson(res, 409, { error: "Potrjen obračun najprej ponovno odpri." });
          return;
        }
        payroll = buildPayrollSnapshot(db, current.workerId, current, {
          ...current,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now
        }, body.note);
      } else if (action === "confirm") {
        if (!["draft", "archiving"].includes(current.status)) {
          sendJson(res, 409, { error: "Potrdi lahko samo odprt ali nedokončano arhiviran obračun." });
          return;
        }
        payroll = current.status === "archiving"
          ? normalizePayroll({ ...current, updatedBy: user.id, updatedByName: user.name, updatedAt: now }, db)
          : buildPayrollSnapshot(db, current.workerId, current, {
            ...current,
            status: "archiving",
            updatedBy: user.id,
            updatedByName: user.name,
            updatedAt: now
          }, body.note);
        if (!payroll?.lines.length) {
          sendJson(res, 400, { error: "Obračun nima zaključenih vnosov ur." });
          return;
        }
        db.payrolls[index] = payroll;
        await writeDbAsync(db);
        payroll = normalizePayroll({
          ...payroll,
          status: "confirmed",
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: new Date().toISOString(),
          confirmedAt: payroll.confirmedAt || new Date().toISOString(),
          confirmedBy: user.id,
          confirmedByName: user.name
        }, db);
      } else if (action === "paid") {
        if (current.status !== "confirmed") {
          sendJson(res, 409, { error: "Kot plačanega lahko označiš samo potrjen obračun." });
          return;
        }
        payroll = normalizePayroll({
          ...current,
          status: "paid",
          payments: current.remainingAmount > 0.005 ? [...(current.payments || []), { id: crypto.randomUUID(), amount: current.remainingAmount, note: "Celotno izplačilo", createdAt: now, createdBy: user.id, createdByName: user.name }] : current.payments,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          paidAt: now,
          paidBy: user.id,
          paidByName: user.name
        }, db);
      } else if (action === "reopen") {
        if (current.status === "draft") {
          sendJson(res, 409, { error: "Obračun je že odprt za popravke." });
          return;
        }
        const clientBill = clientBillLockForTodos(db, payrollTodosForArchive(db, current));
        if (clientBill) {
          sendJson(res, 409, { error: `Obračun vsebuje vnos, ki je že v potrjenem obračunu stranki ${clientBill.clientName}. Najprej je potreben kontroliran popravek obračuna stranki.` });
          return;
        }
        payroll = buildPayrollSnapshot(db, current.workerId, current, {
          ...current,
          status: "draft",
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          paidAt: "",
          paidBy: "",
          paidByName: ""
        }, body.note);
      } else {
        sendJson(res, 400, { error: "Neznano dejanje obračuna." });
        return;
      }
      if (!payroll?.lines.length) {
        sendJson(res, 400, { error: "Obračun nima zaključenih vnosov ur." });
        return;
      }
      db.payrolls[index] = payroll;
      const archive = ["confirm", "reopen"].includes(action) ? await archivePayrollTodos(db, payroll, user) : null;
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user), payroll, archive });
      return;
    }

    if (payrollMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko briše osnutek obračuna." });
        return;
      }
      const db = await readDbAsync();
      const index = db.payrolls.findIndex((payroll) => payroll.id === decodeURIComponent(payrollMatch[1]));
      if (index < 0) {
        sendJson(res, 404, { error: "Obračun ne obstaja." });
        return;
      }
      if (db.payrolls[index].status !== "draft") {
        sendJson(res, 409, { error: "Potrjenega obračuna ni mogoče izbrisati; najprej ga ponovno odpri." });
        return;
      }
      const deleting = db.payrolls[index];
      const laterPayroll = db.payrolls.some((payroll) => payroll.workerId === deleting.workerId && payroll.from > deleting.to);
      if (laterPayroll) {
        sendJson(res, 409, { error: "Osnutka ne moreš izbrisati, ker bi med obračuni nastala luknja." });
        return;
      }
      db.payrolls.splice(index, 1);
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user) });
      return;
    }
    if (url.pathname === "/api/workers/billing" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko vidi urne postavke delavcev." });
        return;
      }
      const db = await readDbAsync();
      const workers = Object.values(db.users || {}).map((worker) => ({
        id: worker.id,
        name: worker.name,
        role: worker.role,
        hourlyRate: defaultHourlyRateForUser(db, worker.id),
        exportTitle: String(worker.billing?.exportTitle || "")
      }));
      sendJson(res, 200, { workers });
      return;
    }

    if (url.pathname === "/api/workers/billing" && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko spreminja urne postavke delavcev." });
        return;
      }
      const body = await readBody(req);
      const db = await readDbAsync();
      const workerId = cleanUserId(body.userId);
      const hourlyRate = nonnegativeNumber(body.hourlyRate, null, 10_000);
      const exportTitle = String(body.exportTitle || "").trim().slice(0, 120);
      if (!db.users?.[workerId] || hourlyRate === null) {
        sendJson(res, 400, { error: "Delavec ali urna postavka ni pravilna." });
        return;
      }
      db.users[workerId].billing = { ...(db.users[workerId].billing || {}), hourlyRate, exportTitle };
      await writeDbAsync(db);
      const workers = Object.values(db.users).map((worker) => ({
        id: worker.id,
        name: worker.name,
        role: worker.role,
        hourlyRate: defaultHourlyRateForUser(db, worker.id),
        exportTitle: String(worker.billing?.exportTitle || "")
      }));
      sendJson(res, 200, { workers });
      return;
    }

    if (url.pathname === "/api/profile" && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const db = await readDbAsync();
      const current = db.users[user.id];
      const name = String(body.name || "").trim().slice(0, 120);
      const avatar = String(body.avatar || "");
      if (name.length < 2) {
        sendJson(res, 400, { error: "Ime mora imeti vsaj 2 znaka." });
        return;
      }
      if (avatar && !validImageDataUrl(avatar, 1_500_000)) {
        sendJson(res, 400, { error: "Slika mora biti slikovna datoteka." });
        return;
      }
      current.name = name;
      current.avatar = avatar;
      await writeDbAsync(db);
      sendJson(res, 200, { user: publicUser(current) });
      return;
    }

    if (url.pathname === "/api/password" && req.method === "PUT") {
      sendJson(res, 410, { error: "Gesla se ne spreminja v aplikaciji. Prijava je vezana na Google račun." });
      return;
    }

    if (url.pathname === "/api/entries" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { entries: visibleEntriesForUser(db, user) });
      return;
    }

    if (url.pathname === "/api/todos" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { todos: visibleTodosForUser(db, user) });
      return;
    }

    if (url.pathname === "/api/todos/reorder" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const todoIds = [...new Set((Array.isArray(body.todoIds) ? body.todoIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean))];
      if (todoIds.length < 1 || todoIds.length > 500) {
        sendJson(res, 400, { error: "Za razvrščanje posreduj vsaj dve opravili." });
        return;
      }
      const db = await readDbAsync();
      const byId = new Map((db.todos || []).map((todo) => [todo.id, todo]));
      const todos = todoIds.map((id) => byId.get(id));
      const editLockTokens = body.editLockTokens && typeof body.editLockTokens === "object" ? body.editLockTokens : {};
      for (const todo of todos) {
        if (!todo || !canManageTodo(user, todo)) {
          sendJson(res, 403, { error: "Tega vrstnega reda ne smeš spreminjati." });
          return;
        }
        if (todo.done || todo.urgent || todo.status === "meal") {
          sendJson(res, 400, { error: "Izbranega opravila ni mogoče ročno razvrščati." });
          return;
        }
        const editLock = todoAssignmentEditLockConflict(db, todo, user, String(editLockTokens[todo.id] || ""));
        if (editLock) {
          sendJson(res, 409, { error: `Opravilo trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
          return;
        }
      }
      const requestedOrderUserId = cleanUserId(body.orderUserId);
      const orderUserId = user.role === "boss" && db.users?.[requestedOrderUserId] ? requestedOrderUserId : user.id;
      const requestedBuckets = body.bucketById && typeof body.bucketById === "object" ? body.bucketById : {};
      const now = new Date().toISOString();
      todos.forEach((todo, index) => {
        const requestedBucket = String(requestedBuckets[todo.id] || "");
        const bucket = ["sorted", "unsorted"].includes(requestedBucket)
          ? requestedBucket
          : (todo.userOrderBuckets?.[orderUserId] === "unsorted" ? "unsorted" : "sorted");
        todo.userOrders = { ...(todo.userOrders || {}), [orderUserId]: index + 1 };
        todo.userOrderBuckets = { ...(todo.userOrderBuckets || {}), [orderUserId]: bucket };
        todo.updatedBy = user.id;
        todo.updatedByName = user.name;
        todo.updatedAt = now;
        todo.history = [...(todo.history || []), audit(user, "spremenjen vrstni red")];
      });
      await writeDbAsync(db);
      sendJson(res, 200, { todos: visibleTodosForUser(db, user) });
      return;
    }
    if (url.pathname === "/api/clients" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { clients: db.clients || [] });
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { settings: db.settings || {}, billingLocks: db.billingLocks || [] });
      return;
    }

    if (url.pathname === "/api/settings/billing" && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko spreminja obračunske nastavitve." });
        return;
      }
      const body = await readBody(req);
      const db = await readDbAsync();
      db.settings = db.settings || {};
      const previousBilling = db.settings.billing || {};
      const legacyKmRate = nonnegativeNumber(body.kmRate, nonnegativeNumber(previousBilling.kmRate, 0.22, 1_000), 1_000);
      db.settings.billing = {
        ...previousBilling,
        hourlyRate: nonnegativeNumber(body.hourlyRate, nonnegativeNumber(previousBilling.hourlyRate, 15, 10_000), 10_000),
        // Stara enotna tarifa ostane le za pretekle podatke in kilometrino delavca.
        kmRate: legacyKmRate,
        workerOwnVehicleKmRate: nonnegativeNumber(body.workerOwnVehicleKmRate, nonnegativeNumber(previousBilling.workerOwnVehicleKmRate, legacyKmRate, 1_000), 1_000),
        commuteKmPerDay: nonnegativeNumber(body.commuteKmPerDay, nonnegativeNumber(previousBilling.commuteKmPerDay, 28, 1_000_000), 1_000_000),
        mealPaidMinutes: Math.round(nonnegativeNumber(body.mealPaidMinutes, nonnegativeNumber(previousBilling.mealPaidMinutes, 45, 240), 240))
      };
      const previousArchive = db.settings.archive || {};
      db.settings.archive = {
        ...previousArchive,
        retentionMonths: Math.min(120, Math.max(1, Math.round(nonnegativeNumber(body.archiveRetentionMonths, nonnegativeNumber(previousArchive.retentionMonths, 12, 120), 120))))
      };
      await writeDbAsync(db);
      scheduleArchiveRetentionCleanup(true).catch((error) => console.error(`Čiščenje arhiva ni uspelo: ${error.message || error}`));
      sendJson(res, 200, { settings: db.settings });
      return;
    }

    if (url.pathname === "/api/advances" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { advances: visibleAdvancesForUser(db, user) });
      return;
    }

    if (url.pathname === "/api/advances" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      let advance = cleanAdvance(await readBody(req));
      if (user.role !== "boss") advance.person = user.id;
      const validation = validateAdvance(advance, db);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      if (advance.projectTodoId) {
        const project = db.todos.find((todo) => todo.id === advance.projectTodoId);
        if (!project || !["execution", "open", "in_progress", "internal"].includes(project.status)) {
          sendJson(res, 400, { error: "Povezano opravilo ni več odprto." });
          return;
        }
      }
      advance = storeTodoAttachments(db, advance, user);
      const now = new Date().toISOString();
      db.debts.push({
        id: crypto.randomUUID(),
        ...advance,
        createdBy: user.id,
        createdByName: user.name,
        createdAt: now,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: now
      });
      await writeDbAsync(db);
      sendJson(res, 201, { advances: visibleAdvancesForUser(db, user) });
      return;
    }
    const advanceMatch = url.pathname.match(/^\/api\/advances\/([^/]+)$/);
    if (advanceMatch && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(advanceMatch[1]);
      const db = await readDbAsync();
      const index = db.debts.findIndex((item) => item.id === id && item.type === "advance");
      if (index < 0) { sendJson(res, 404, { error: "Založeni znesek ne obstaja." }); return; }
      const existing = db.debts[index];
      if (!canManageFinancialEntry(user, existing)) { sendJson(res, 403, { error: financialEntryAccessError(user, existing, "založeni znesek") }); return; }
      const usedInConfirmedPayroll = (db.payrolls || []).some((payroll) => ["archiving", "confirmed", "paid"].includes(payroll.status) && (payroll.advanceIds || []).map(String).includes(id));
      if (usedInConfirmedPayroll && user.role !== "boss") { sendJson(res, 409, { error: "Založeni znesek je že del potrjenega obračuna." }); return; }
      let advance = cleanAdvance(await readBody(req));
      if (user.role !== "boss") advance.person = existing.person;
      const validation = validateAdvance(advance, db);
      if (validation) { sendJson(res, 400, { error: validation }); return; }
      if (advance.projectTodoId) {
        const project = db.todos.find((todo) => todo.id === advance.projectTodoId);
        if (!project || !["execution", "open", "in_progress", "internal"].includes(project.status)) { sendJson(res, 400, { error: "Povezano opravilo ni več odprto." }); return; }
      }
      advance = storeTodoAttachments(db, advance, user);
      db.debts[index] = { ...existing, ...advance, id, type: "advance", updatedBy: user.id, updatedByName: user.name, updatedAt: new Date().toISOString() };
      pruneUnusedTodoAttachments(db);
      await writeDbAsync(db);
      sendJson(res, 200, { advances: visibleAdvancesForUser(db, user) });
      return;
    }
    if (advanceMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(advanceMatch[1]);
      const db = await readDbAsync();
      const index = db.debts.findIndex((item) => item.id === id && item.type === "advance");
      if (index < 0) {
        sendJson(res, 404, { error: "Založeni znesek ne obstaja." });
        return;
      }
      const advance = db.debts[index];
      if (!canManageFinancialEntry(user, advance)) {
        sendJson(res, 403, { error: financialEntryAccessError(user, advance, "založeni znesek") });
        return;
      }
      const usedInConfirmedPayroll = (db.payrolls || []).some((payroll) => ["archiving", "confirmed", "paid"].includes(payroll.status)
        && (payroll.advanceIds || []).map(String).includes(id));
      if (usedInConfirmedPayroll && user.role !== "boss") {
        sendJson(res, 409, { error: "Založeni znesek je že del potrjenega obračuna. Šef mora obračun najprej ponovno odpreti." });
        return;
      }
      db.debts.splice(index, 1);
      pruneUnusedTodoAttachments(db);
      await writeDbAsync(db);
      sendJson(res, 200, { advances: visibleAdvancesForUser(db, user) });
      return;
    }
    if (url.pathname === "/api/personal-purchases" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { purchases: visiblePersonalPurchasesForUser(db, user) });
      return;
    }

    if (url.pathname === "/api/personal-purchases" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      let purchase = cleanPersonalPurchase(await readBody(req));
      if (user.role !== "boss") purchase.person = user.id;
      const validation = validatePersonalPurchase(purchase, db);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      purchase = storeTodoAttachments(db, purchase, user);
      const now = new Date().toISOString();
      db.debts.push({
        id: crypto.randomUUID(),
        ...purchase,
        createdBy: user.id,
        createdByName: user.name,
        createdAt: now,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: now
      });
      await writeDbAsync(db);
      sendJson(res, 201, { purchases: visiblePersonalPurchasesForUser(db, user) });
      return;
    }

    const personalPurchaseMatch = url.pathname.match(/^\/api\/personal-purchases\/([^/]+)$/);
    if (personalPurchaseMatch && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(personalPurchaseMatch[1]);
      const db = await readDbAsync();
      const index = db.debts.findIndex((item) => item.id === id && item.type === "personal_purchase");
      if (index < 0) { sendJson(res, 404, { error: "Osebni nakup ne obstaja." }); return; }
      const existing = db.debts[index];
      if (!canManageFinancialEntry(user, existing)) { sendJson(res, 403, { error: financialEntryAccessError(user, existing, "osebni nakup") }); return; }
      const usedInConfirmedPayroll = (db.payrolls || []).some((payroll) => ["archiving", "confirmed", "paid"].includes(payroll.status) && (payroll.personalPurchaseIds || []).map(String).includes(id));
      if (usedInConfirmedPayroll && user.role !== "boss") { sendJson(res, 409, { error: "Osebni nakup je že del potrjenega obračuna." }); return; }
      let purchase = cleanPersonalPurchase(await readBody(req));
      if (user.role !== "boss") purchase.person = existing.person;
      const validation = validatePersonalPurchase(purchase, db);
      if (validation) { sendJson(res, 400, { error: validation }); return; }
      purchase = storeTodoAttachments(db, purchase, user);
      db.debts[index] = { ...existing, ...purchase, id, type: "personal_purchase", updatedBy: user.id, updatedByName: user.name, updatedAt: new Date().toISOString() };
      pruneUnusedTodoAttachments(db);
      await writeDbAsync(db);
      sendJson(res, 200, { purchases: visiblePersonalPurchasesForUser(db, user) });
      return;
    }
    if (personalPurchaseMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(personalPurchaseMatch[1]);
      const db = await readDbAsync();
      const index = db.debts.findIndex((item) => item.id === id && item.type === "personal_purchase");
      if (index < 0) {
        sendJson(res, 404, { error: "Osebni nakup ne obstaja." });
        return;
      }
      const purchase = db.debts[index];
      if (!canManageFinancialEntry(user, purchase)) {
        sendJson(res, 403, { error: financialEntryAccessError(user, purchase, "osebni nakup") });
        return;
      }
      const usedInConfirmedPayroll = (db.payrolls || []).some((payroll) => ["archiving", "confirmed", "paid"].includes(payroll.status)
        && (payroll.personalPurchaseIds || []).map(String).includes(id));
      if (usedInConfirmedPayroll && user.role !== "boss") {
        sendJson(res, 409, { error: "Osebni nakup je že del potrjenega obračuna. Šef mora obračun najprej ponovno odpreti." });
        return;
      }
      db.debts.splice(index, 1);
      pruneUnusedTodoAttachments(db);
      await writeDbAsync(db);
      sendJson(res, 200, { purchases: visiblePersonalPurchasesForUser(db, user) });
      return;
    }
    if (url.pathname === "/api/debts" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { debts: visibleDebtsForUser(db, user) });
      return;
    }

    if (url.pathname === "/api/debts" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko ureja dolgove." });
        return;
      }
      const debt = cleanDebt(await readBody(req));
      const validation = validateDebt(debt);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const db = await readDbAsync();
      const now = new Date().toISOString();
      db.debts.push({
        id: crypto.randomUUID(),
        ...debt,
        createdBy: user.id,
        createdByName: user.name,
        createdAt: now,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: now
      });
      await writeDbAsync(db);
      sendJson(res, 200, { debts: db.debts });
      return;
    }

    if (url.pathname === "/api/clients" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      let client = cleanClient(await readBody(req));
      const validation = validateClient(client);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const db = await readDbAsync();
      const current = db.users[user.id];
      const clientText = [client.name, client.search].map((value) => String(value || "").trim().toLowerCase());
      const existingIndex = db.clients.findIndex((row) => row.clientId === client.clientId
        || (client.taxId && row.taxId === client.taxId)
        || [row.name, row.search].some((value) => clientText.includes(String(value || "").trim().toLowerCase())));
      if (existingIndex >= 0) {
        client = normalizeStoredClient({
          ...db.clients[existingIndex],
          ...client,
          id: db.clients[existingIndex].clientId,
          clientId: db.clients[existingIndex].clientId
        });
        db.clients[existingIndex] = client;
      } else {
        db.clients.push(client);
      }
      await writeDbAsync(db);
      sendJson(res, 200, { clients: db.clients, client });
      return;
    }

    if (url.pathname === "/api/billing-locks" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo Bojan lahko zaklene obračun." });
        return;
      }
      const body = await readBody(req);
      const from = String(body.from || "");
      const to = String(body.to || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
        sendJson(res, 400, { error: "Datum zaklepa ni pravilen." });
        return;
      }
      const db = await readDbAsync();
      db.billingLocks.push({
        id: crypto.randomUUID(),
        from,
        to,
        note: String(body.note || "Obračunano").trim(),
        createdBy: user.id,
        createdByName: user.name,
        createdAt: new Date().toISOString()
      });
      await writeDbAsync(db);
      sendJson(res, 200, { billingLocks: db.billingLocks });
      return;
    }

    const debtMatch = url.pathname.match(/^\/api\/debts\/([^/]+)$/);
    if (debtMatch && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko ureja dolgove." });
        return;
      }
      const id = decodeURIComponent(debtMatch[1]);
      const debt = cleanDebt(await readBody(req));
      const validation = validateDebt(debt);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const db = await readDbAsync();
      const index = db.debts.findIndex((item) => item.id === id);
      if (index < 0) {
        sendJson(res, 404, { error: "Dolg ne obstaja." });
        return;
      }
      db.debts[index] = {
        ...db.debts[index],
        ...debt,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: new Date().toISOString()
      };
      await writeDbAsync(db);
      sendJson(res, 200, { debts: db.debts });
      return;
    }

    if (debtMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo šef lahko ureja dolgove." });
        return;
      }
      const id = decodeURIComponent(debtMatch[1]);
      const db = await readDbAsync();
      db.debts = db.debts.filter((item) => item.id !== id);
      await writeDbAsync(db);
      sendJson(res, 200, { debts: db.debts });
      return;
    }

    if (url.pathname === "/api/todos" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      let todo = cleanTodo(body);
      const validation = validateTodo(todo);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const now = new Date().toISOString();
      const db = await readDbAsync();
      todo = attachResolvedClient(db, todo, { createAdHoc: true, user });
      const resolvedValidation = validateTodo(todo, { requireClientId: true });
      if (resolvedValidation) {
        sendJson(res, 400, { error: resolvedValidation });
        return;
      }
      todo = storeTodoAttachments(db, todo, user);
      const minOrder = db.todos.reduce((min, item) => Math.min(min, Number(item.order || 0)), 0);
      const newOrder = todo.order || minOrder - 1;
      let assigneeIds = todoAssigneesForRequest(user, body.assigneeIds || todo.syncUser, db.users);
      if (todo.status === "meal") assigneeIds = [syncUserForRequest(user, todo.syncUser || assigneeIds[0] || user.id, "", db.users)];
      if (TIME_ENTRY_TODO_STATUSES.has(todo.status) && assigneeIds.length !== 1) {
        sendJson(res, 400, { error: "Vnos ur se vpisuje posebej za enega delavca." });
        return;
      }
      const assignmentGroupId = crypto.randomUUID();
      assigneeIds.forEach((assigneeId, index) => {
        const assignee = db.users[assigneeId];
        const assignedTodo = todoForUserRole(user, db, null, { ...todo, syncUser: assigneeId });
        db.todos.push({
          id: crypto.randomUUID(),
          ...assignedTodo,
          assignmentGroupId,
          photos: stampTodoPhotos(todo, user),
          driveFiles: stampTodoDriveFiles(todo, user),
          syncUser: assigneeId,
          userOrderBuckets: { ...(todo.userOrderBuckets || {}), [assigneeId]: "unsorted" },
          order: newOrder + index,
          createdBy: user.id,
          createdByName: user.name,
          createdAt: now,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          history: [audit(user, `dodano opravilo za ${assignee?.name || assigneeId}`)]
        });
      });
      await writeDbAsync(db);
      sendJson(res, 200, {
        todos: visibleTodosForUser(db, user),
        assignedTo: assigneeIds.map((id) => publicDirectoryUser(db.users[id]))
      });
      return;
    }

    if (url.pathname === "/api/todos/drive-files" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      sendJson(res, 410, { error: "Dokumente in preglednice pripni kot zunanjo povezavo. Drive je rezerviran za varnostne kopije." });
      return;
    }

    if (url.pathname === "/api/todos/video" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      let name = String(req.headers["x-indus-file-name"] || "video");
      try { name = decodeURIComponent(name); } catch { /* keep encoded value */ }
      const received = await receiveLocalTodoVideo({
        stream: req,
        name,
        mimeType: req.headers["content-type"],
        contentLength: req.headers["content-length"]
      });
      try {
        const photo = await runSerializedWork(async () => {
          const db = await readDbAsync();
          const pending = pendingAttachmentMap(db);
          db.attachments[received.attachmentId] = {
            ...(db.attachments[received.attachmentId] || {}),
            id: received.attachmentId,
            mimeType: received.mimeType,
            byteSize: received.byteSize,
            storageKey: received.storageKey,
            thumbnailKey: "",
            createdBy: user.id,
            createdByName: user.name,
            createdAt: new Date().toISOString()
          };
          pending[received.attachmentId] = { userId: user.id, expiresAt: Date.now() + PENDING_ATTACHMENT_TTL_MS };
          await writeDbAsync(db);
          return {
            id: crypto.randomUUID(),
            attachmentId: received.attachmentId,
            name: "Video",
            comment: "",
            createdBy: user.id,
            createdByName: user.name,
            createdAt: new Date().toISOString(),
            mimeType: received.mimeType,
            url: attachmentApiUrl(received.attachmentId),
            thumbnailUrl: ""
          };
        });
        sendJson(res, 201, { photo });
      } catch (error) {
        if (received.createdFile) await fsp.rm(received.targetPath, { force: true }).catch(() => {});
        throw error;
      }
      return;
    }

    if (url.pathname === "/api/entries" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      let entry = cleanEntry(await readBody(req));
      entry = entryForUserRole(user, entry);
      const validation = validateEntry(entry);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const now = new Date().toISOString();
      const db = await readDbAsync();
      const sourceTodo = sourceTodoForNewEntry(db, user, entry);
      if (!sourceTodo) {
        sendJson(res, 400, { error: "Nov koledarski vnos lahko ustvariš samo iz svojega opravila z istim datumom." });
        return;
      }
      entry = attachResolvedClient(db, entry);
      const resolvedValidation = validateEntry(entry);
      if (resolvedValidation) {
        sendJson(res, 400, { error: resolvedValidation });
        return;
      }
      entry.syncUser = sourceTodo.syncUser;
      db.entries.push({
        id: crypto.randomUUID(),
        ...entry,
        createdBy: user.id,
        createdByName: user.name,
        createdAt: now,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: now,
        history: [audit(user, "dodano iz opravila")]
      });
      await writeDbAsync(db);
      sendJson(res, 200, {
        entries: visibleEntriesForUser(db, user),
        todos: visibleTodosForUser(db, user)
      });
      return;
    }

    const entryLockMatch = url.pathname.match(/^\/api\/entries\/([^/]+)\/lock$/);
    if (entryLockMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(entryLockMatch[1]);
      const body = await readBody(req);
      const db = await readDbAsync();
      const entry = db.entries.find((item) => item.id === id);
      if (!canManageEntry(user, entry)) {
        sendJson(res, 403, { error: "Tega vnosa ne moreš urejati." });
        return;
      }
      const result = acquireEntryEditLock(id, user, body.lockToken);
      if (!result.ok) {
        sendJson(res, 409, { error: `Vnos trenutno ureja ${result.lock.lockedByName || result.lock.lockedById}.`, lock: result.lock });
        return;
      }
      sendJson(res, 200, { lockToken: result.token, lock: result.lock });
      return;
    }

    if (entryLockMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(entryLockMatch[1]);
      const body = await readBody(req);
      releaseEntryEditLock(id, user, body.lockToken);
      sendJson(res, 200, { ok: true });
      return;
    }

    const match = url.pathname.match(/^\/api\/entries\/([^/]+)$/);
    if (match && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(match[1]);
      const body = await readBody(req);
      const editLockToken = String(body.editLockToken || "");
      let entry = cleanEntry(body);
      const validation = validateEntry(entry);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const db = await readDbAsync();
      entry = attachResolvedClient(db, entry);
      const resolvedValidation = validateEntry(entry);
      if (resolvedValidation) {
        sendJson(res, 400, { error: resolvedValidation });
        return;
      }
      const index = db.entries.findIndex((item) => item.id === id);
      if (index < 0) {
        sendJson(res, 404, { error: "Vnos ne obstaja." });
        return;
      }
      if (!canManageEntry(user, db.entries[index])) {
        sendJson(res, 403, { error: "Tega vnosa ne moreš spreminjati." });
        return;
      }
      const editLock = entryEditLockConflict(id, user, editLockToken);
      if (editLock) {
        sendJson(res, 409, { error: `Vnos trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
        return;
      }
      entry = entryForUserRole(user, entry, db.entries[index]);
      if (user.role !== "boss" && entryIsLocked(db, db.entries[index]) && lockedFieldChanged(db.entries[index], entry)) {
        sendJson(res, 403, { error: "To obdobje je obračunano. Ure, kilometrina in start od doma so zaklenjeni." });
        return;
      }
      entry.sourceTodoId = db.entries[index].sourceTodoId || "";
      db.entries[index] = {
        ...db.entries[index],
        ...entry,
        syncUser: syncUserForRequest(user, entry.syncUser, db.entries[index].syncUser, db.users),
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: new Date().toISOString(),
        history: [...(db.entries[index].history || []), audit(user, "spremenjeno")]
      };
      await writeDbAsync(db);
      releaseEntryEditLock(id, user, editLockToken);
      sendJson(res, 200, { entries: visibleEntriesForUser(db, user) });
      return;
    }

    if (match && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(match[1]);
      const body = await readBody(req);
      const editLockToken = String(body.editLockToken || "");
      const db = await readDbAsync();
      const entry = db.entries.find((item) => item.id === id);
      if (!canManageEntry(user, entry)) {
        sendJson(res, 403, { error: "Tega vnosa ne moreš izbrisati." });
        return;
      }
      const editLock = entryEditLockConflict(id, user, editLockToken);
      if (editLock) {
        sendJson(res, 409, { error: `Vnos trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
        return;
      }
      if (user.role !== "boss" && entryIsLocked(db, entry)) {
        sendJson(res, 403, { error: "To obdobje je obračunano. Vnosa ne moreš izbrisati." });
        return;
      }
      db.entries = db.entries.filter((item) => item.id !== id);
      await writeDbAsync(db);
      releaseEntryEditLock(id, user, editLockToken);
      sendJson(res, 200, { entries: visibleEntriesForUser(db, user) });
      return;
    }

    const todoLockMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/lock$/);
    if (todoLockMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoLockMatch[1]);
      const body = await readBody(req);
      const db = await readDbAsync();
      const todo = db.todos.find((item) => item.id === id);
      if (!canManageTodo(user, todo)) {
        sendJson(res, 403, { error: "Tega opravila ne moreš urejati." });
        return;
      }
      const result = acquireTodoAssignmentEditLock(db, todo, user, body.lockToken);
      if (!result.ok) {
        sendJson(res, 409, { error: `Opravilo trenutno ureja ${result.lock.lockedByName || result.lock.lockedById}.`, lock: result.lock });
        return;
      }
      sendJson(res, 200, { lockToken: result.token, lock: result.lock });
      return;
    }

    if (todoLockMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoLockMatch[1]);
      const body = await readBody(req);
      const db = await readDbAsync();
      const todo = db.todos.find((item) => item.id === id);
      if (todo) {
        releaseTodoAssignmentEditLock(db, todo, user, body.lockToken);
      } else {
        releaseTodoEditLock(id, user, body.lockToken);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    const todoTimeMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/time$/);
    if (todoTimeMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoTimeMatch[1]);
      const body = await readBody(req);
      const editLockToken = String(body.editLockToken || "");
      const db = await readDbAsync();
      const previousTodo = db.todos.find((item) => item.id === id);
      if (!canManageTodo(user, previousTodo)) {
        sendJson(res, 403, { error: "Tega opravila ne moreš spreminjati." });
        return;
      }
      const editLock = todoAssignmentEditLockConflict(db, previousTodo, user, editLockToken);
      if (editLock || !ownsTodoAssignmentEditLock(db, previousTodo, user, editLockToken)) {
        const activeLock = activeTodoEditLock(previousTodo.id);
        const lock = editLock || (activeLock ? publicTodoEditLock(activeLock) : null);
        sendJson(res, 409, { error: lock ? `Opravilo trenutno ureja ${lock.lockedByName || lock.lockedById}.` : "Opravilo pred premikom ni zaklenjeno.", lock });
        return;
      }
      const start = roundTimeToQuarterHour(body.start);
      const end = roundTimeToQuarterHour(body.end);
      const date = isDateKey(body.date) ? String(body.date) : previousTodo.date;
      const validation = validateTodo({ ...previousTodo, date, start, end });
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const assignmentItems = todoAssignmentItems(db, previousTodo);
      const payrollLock = payrollLockForTodos(db, assignmentItems);
      if (payrollLock) {
        sendJson(res, 403, { error: `Opravilo je del potrjenega obračuna za ${db.users?.[payrollLock.workerId]?.name || payrollLock.workerId} (${payrollLock.month}). Šef ga mora najprej ponovno odpreti.` });
        return;
      }
      const clientBillLock = clientBillLockForTodos(db, assignmentItems);
      if (clientBillLock) {
        sendJson(res, 403, { error: `Opravilo je že v potrjenem obračunu stranki ${clientBillLock.clientName} in ga ni več mogoče spreminjati.` });
        return;
      }
      const now = new Date().toISOString();
      const assignmentIds = new Set(assignmentItems.map((item) => item.id));
      db.todos = db.todos.map((item) => assignmentIds.has(item.id) ? {
        ...item,
        start,
        end,
        date,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: now,
        history: [...(item.history || []), audit(user, date === previousTodo.date ? "prestavljen v časovnici" : `prestavljen na ${date} v časovnici`)]
      } : item);
      await writeDbAsync(db);
      releaseTodoAssignmentEditLock(db, previousTodo, user, editLockToken);
      sendJson(res, 200, { todos: visibleTodosForUser(db, user) });
      return;
    }
    const todoMatch = url.pathname.match(/^\/api\/todos\/([^/]+)$/);
    if (todoMatch && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoMatch[1]);
      const body = await readBody(req);
      const editLockToken = String(body.editLockToken || "");
      let todo = cleanTodo(body);
      const validation = validateTodo(todo);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const db = await readDbAsync();
      todo = attachResolvedClient(db, todo, { createAdHoc: true, user });
      const resolvedValidation = validateTodo(todo, { requireClientId: true });
      if (resolvedValidation) {
        sendJson(res, 400, { error: resolvedValidation });
        return;
      }
      todo = storeTodoAttachments(db, todo, user);
      const index = db.todos.findIndex((item) => item.id === id);
      if (index < 0) {
        sendJson(res, 404, { error: "Opravilo ne obstaja." });
        return;
      }
      if (!canManageTodo(user, db.todos[index])) {
        sendJson(res, 403, { error: "Tega opravila ne moreš spreminjati." });
        return;
      }
      const previousTodo = db.todos[index];
      const editLock = todoAssignmentEditLockConflict(db, previousTodo, user, editLockToken);
      if (editLock) {
        sendJson(res, 409, { error: `Opravilo trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
        return;
      }
      const baseUpdatedAt = String(body.baseUpdatedAt || "");
      const ownsEditLock = ownsTodoAssignmentEditLock(db, previousTodo, user, editLockToken);
      if (baseUpdatedAt && baseUpdatedAt !== String(previousTodo.updatedAt || "") && !ownsEditLock) {
        sendJson(res, 409, { error: "Opravilo je bilo medtem spremenjeno na drugi napravi." });
        return;
      }
      const assignmentItems = todoAssignmentItems(db, previousTodo);
      const payrollLock = payrollLockForTodos(db, assignmentItems);
      if (payrollLock) {
        sendJson(res, 403, { error: `Opravilo je del potrjenega obračuna za ${db.users?.[payrollLock.workerId]?.name || payrollLock.workerId} (${payrollLock.month}). Šef ga mora najprej ponovno odpreti.` });
        return;
      }
      const clientBillLock = clientBillLockForTodos(db, assignmentItems);
      if (clientBillLock) {
        sendJson(res, 403, { error: `Opravilo je že v potrjenem obračunu stranki ${clientBillLock.clientName} in ga ni več mogoče spreminjati.` });
        return;
      }
      const currentAssigneeIds = todoAssignmentAssigneeIds(db, previousTodo);
      let assigneeIds;
      if (Array.isArray(body.assigneeIds)) {
        assigneeIds = [...new Set(body.assigneeIds
          .map(cleanUserId)
          .filter((assigneeId) => Boolean(db.users?.[assigneeId])))];
        if (!assigneeIds.length) {
          sendJson(res, 400, { error: "Izberi vsaj enega delavca." });
          return;
        }
      } else {
        const nextAssignee = todoAssigneeForUpdate(user, todo.syncUser, previousTodo.syncUser, db.users);
        assigneeIds = currentAssigneeIds.filter((assigneeId) => assigneeId !== previousTodo.syncUser);
        if (!assigneeIds.includes(nextAssignee)) assigneeIds.push(nextAssignee);
      }

      if (todo.status === "meal") assigneeIds = [syncUserForRequest(user, todo.syncUser || assigneeIds[0] || previousTodo.syncUser || user.id, previousTodo.syncUser, db.users)];
      if (TIME_ENTRY_TODO_STATUSES.has(todo.status) && assigneeIds.length !== 1) {
        sendJson(res, 400, { error: "Vnos ur se vpisuje posebej za enega delavca." });
        return;
      }
      const desiredAssignees = new Set(assigneeIds);
      const existingByAssignee = new Map();
      const removedTodos = [];
      for (const item of assignmentItems) {
        const assigneeId = cleanUserId(item.syncUser || item.createdBy);
        if (!desiredAssignees.has(assigneeId) || existingByAssignee.has(assigneeId)) {
          removedTodos.push(item);
        } else {
          existingByAssignee.set(assigneeId, item);
        }
      }
releaseTodoAssignmentEditLock(db, previousTodo, user, editLockToken);
      const assignmentGroupId = previousTodo.assignmentGroupId || crypto.randomUUID();
      const now = new Date().toISOString();
      const sharedPhotos = stampTodoPhotos(todo, user);
      const sharedDriveFiles = stampTodoDriveFiles(todo, user);
      const assignmentsChanged = [...currentAssigneeIds].sort().join(",") !== [...assigneeIds].sort().join(",");
      const assigneeNames = assigneeIds.map((assigneeId) => db.users[assigneeId]?.name || assigneeId).join(", ");
      const updatedGroup = [];

      for (const assigneeId of assigneeIds) {
        const existing = existingByAssignee.get(assigneeId);
        if (existing) {
          const isOpenedTodo = existing.id === previousTodo.id;
          const adjusted = todoForUserRole(user, db, existing, {
            ...todo,
            syncUser: assigneeId,
            billingHourlyRate: isOpenedTodo ? todo.billingHourlyRate : existing.billingHourlyRate,
            billingKm: isOpenedTodo ? todo.billingKm : existing.billingKm
          });
          updatedGroup.push({
            ...existing,
            ...adjusted,
            assignmentGroupId,
            photos: sharedPhotos.map((photo) => ({ ...photo })),
            driveFiles: sharedDriveFiles.map((file) => ({ ...file })),
            syncUser: assigneeId,
            userOrderBuckets: { ...(existing.userOrderBuckets || {}) },
            order: isOpenedTodo ? todo.order : existing.order,
            updatedBy: user.id,
            updatedByName: user.name,
            updatedAt: now,
            history: [...(existing.history || []), audit(user, assignmentsChanged
              ? `dodelitev spremenjena: ${assigneeNames}`
              : todo.done ? "označeno opravljeno" : "spremenjeno opravilo")]
          });
          continue;
        }

        const assignedTodo = todoForUserRole(user, db, null, {
          ...todo,
          syncUser: assigneeId,
          billingHourlyRate: null,
          billingKm: null
        });
        updatedGroup.push({
          id: crypto.randomUUID(),
          ...assignedTodo,
          assignmentGroupId,
          photos: sharedPhotos.map((photo) => ({ ...photo })),
          driveFiles: sharedDriveFiles.map((file) => ({ ...file })),
          syncUser: assigneeId,
          userOrderBuckets: { ...(todo.userOrderBuckets || {}), [assigneeId]: "unsorted" },
          order: todo.order,
          createdBy: previousTodo.createdBy || user.id,
          createdByName: previousTodo.createdByName || user.name,
          createdAt: previousTodo.createdAt || now,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          history: [...(previousTodo.history || []), audit(user, `dodeljeno uporabniku ${db.users[assigneeId]?.name || assigneeId}`)]
        });
      }

      const oldGroupIds = new Set(assignmentItems.map((item) => item.id));
      db.todos = db.todos.filter((item) => !oldGroupIds.has(item.id));
      db.todos.push(...updatedGroup);
      pruneUnusedTodoAttachments(db);
      pruneUnusedAdHocClients(db);
      await writeDbAsync(db);
      releaseTodoAssignmentEditLock(db, previousTodo, user, editLockToken);
      sendJson(res, 200, { todos: visibleTodosForUser(db, user) });
      return;
    }

    if (todoMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoMatch[1]);
      const body = await readBody(req);
      const editLockToken = String(body.editLockToken || "");
      const db = await readDbAsync();
      const todo = db.todos.find((item) => item.id === id);
      if (!canManageTodo(user, todo)) {
        sendJson(res, 403, { error: "Tega opravila ne moreš izbrisati." });
        return;
      }
      const editLock = todoAssignmentEditLockConflict(db, todo, user, editLockToken);
      if (editLock) {
        sendJson(res, 409, { error: `Opravilo trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
        return;
      }
      const baseUpdatedAt = String(body.baseUpdatedAt || "");
      const ownsEditLock = ownsTodoAssignmentEditLock(db, todo, user, editLockToken);
      if (baseUpdatedAt && baseUpdatedAt !== String(todo.updatedAt || "") && !ownsEditLock) {
        sendJson(res, 409, { error: "Opravilo je bilo medtem spremenjeno na drugi napravi." });
        return;
      }
      const assignmentItems = todoAssignmentItems(db, todo);
      const payrollLock = payrollLockForTodos(db, assignmentItems);
      if (payrollLock) {
        sendJson(res, 403, { error: `Opravilo je del potrjenega obračuna za ${db.users?.[payrollLock.workerId]?.name || payrollLock.workerId} (${payrollLock.month}). Šef ga mora najprej ponovno odpreti.` });
        return;
      }
      const clientBillLock = clientBillLockForTodos(db, assignmentItems);
      if (clientBillLock) {
        sendJson(res, 403, { error: `Opravilo je že v potrjenem obračunu stranki ${clientBillLock.clientName} in ga ni več mogoče izbrisati.` });
        return;
      }
releaseTodoAssignmentEditLock(db, todo, user, editLockToken);
      const removedIds = new Set(assignmentItems.map((item) => item.id));
      db.todos = db.todos.filter((item) => !removedIds.has(item.id));
      pruneUnusedTodoAttachments(db);
      pruneUnusedAdHocClients(db);
      await writeDbAsync(db);
      releaseTodoAssignmentEditLock(db, todo, user, editLockToken);
      sendJson(res, 200, { todos: visibleTodosForUser(db, user) });
      return;
    }

    sendJson(res, 404, { error: "API pot ne obstaja." });
  } catch (error) {
    console.error("API napaka:", error);
    const message = NODE_ENV === "production" ? "Napaka na strežniku." : (error.message || "Napaka na strežniku.");
    sendJson(res, 500, { error: message });
  }
}

async function handleCalendarFeed(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const db = await readDbAsync();
    const token = url.searchParams.get("token") || "";
    const combined = token === db.calendarFeeds?.bossCombined;
    const worker = Object.entries(db.calendarFeeds || {})
      .find(([id, value]) => id !== "bossCombined" && value === token)?.[0] || "";
    if (!combined && !worker) {
      sendText(res, 403, "Forbidden", "text/plain");
      return;
    }
    sendText(res, 200, buildCalendarIcs(db, {
      userId: worker,
      combined
    }), "text/calendar");
  } catch (error) {
    console.error("Napaka koledarskega feeda:", error);
    const message = NODE_ENV === "production" ? "Napaka na strežniku." : (error.message || "Napaka na strežniku.");
    sendText(res, 500, message, "text/plain");
  }
}

function networkUrls() {
  if (["127.0.0.1", "::1", "localhost"].includes(HOST)) return [];
  try {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((item) => item && item.family === "IPv4" && !item.internal)
      .map((item) => `http://${item.address}:${PORT}`);
  } catch (error) {
    console.warn(`Omrežnih URL-jev ni bilo mogoče prebrati: ${error.message || error}`);
    return [];
  }
}

function googleConnectionFailure(error) {
  const status = Number(error?.response?.status || error?.code || 0);
  const message = String(error?.response?.data?.error?.message || error?.message || "").toLowerCase();
  return status === 401 || status === 403
    || /invalid_grant|invalid credentials|unauthenticated|login required|token has been expired|invalid token/.test(message);
}

function actionableGoogleDriveError(error) {
  const message = String(error?.message || "");
  if (/^Bojan mora najprej v Nastavitvah povezati Google (Drive|Dokumente)/.test(message)) {
    return { status: 409, code: "google_drive_reconnect_required", error: "Google Drive ni povezan. Kot Bojan ga v Nastavitvah poveži in nato poskusi znova." };
  }
  if (/^Video priloge niso nastavljene:|^Drive mapa za priloge ni nastavljena\./.test(message)) {
    return { status: 503, error: "Mapa Google Drive za priloge in videe ni nastavljena na strežniku." };
  }
  return null;
}
function handleUnexpectedRequestError(error, res) {
  console.error("Nepricakovana napaka zahtevka:", error);
  if (!res.headersSent) {
    const actionable = actionableGoogleDriveError(error);
    if (actionable) {
      sendJson(res, actionable.status, { error: actionable.error, code: actionable.code || "" });
      return;
    }
    if (googleConnectionFailure(error)) {
      sendJson(res, 409, { code: "google_drive_reconnect_required", error: "Povezava z Google Drive ni več veljavna. V Nastavitvah jo kot Bojan ponovno poveži in poskusi znova." });
      return;
    }
    sendJson(res, 500, { error: "Napaka na strežniku." });
  } else {
    res.destroy();
  }
}

function runSerializedWork(work) {
  const execution = mutationQueue.then(work);
  mutationQueue = execution.catch((error) => {
    console.error(`Zaporedna sprememba ni uspela: ${error.message || error}`);
  });
  return execution;
}

function runSerializedMutation(req, res) {
  const execution = mutationQueue.then(() => handleApi(req, res));
  mutationQueue = execution.catch((error) => handleUnexpectedRequestError(error, res));
}

async function start() {
  if (NODE_ENV === "production" && !DATABASE_URL) {
    throw new Error("V produkciji mora biti nastavljen DATABASE_URL.");
  }
  if (DATABASE_URL) {
    await ensurePostgresDb();
    console.log("Shranjevanje: Postgres baza prek DATABASE_URL");
  } else {
    ensureDb();
    console.log(`Shranjevanje: lokalna datoteka ${dbFile}`);
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      // A video upload only creates a Drive file; it does not alter app state. Do
      // not hold the global mutation queue while a large body is streaming.
      const streamedVideoUpload = req.method === "POST" && req.url.startsWith("/api/todos/video");
      if (streamedVideoUpload) {
        handleApi(req, res).catch((error) => handleUnexpectedRequestError(error, res));
      } else if (req.method !== "GET" || req.url.startsWith("/api/google/callback")) {
        runSerializedMutation(req, res);
      } else {
        handleApi(req, res).catch((error) => handleUnexpectedRequestError(error, res));
      }
      return;
    }
    if (req.url.startsWith("/calendar.ics")) {
      handleCalendarFeed(req, res).catch((error) => handleUnexpectedRequestError(error, res));
      return;
    }
    serveStatic(req, res);
  });
  // ZIP restore can be large; ordinary API bodies still have their own small limits.
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  startOperationalMonitor();

  server.listen(PORT, HOST, () => {
    console.log(`INDUS URE lokalno: http://127.0.0.1:${PORT}`);
    for (const url of networkUrls()) console.log(`Na istem omrežju: ${url}`);
    console.log("Uporabnika: bojan in ibro");
  });

}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  ENTRY_EDIT_LOCK_TTL_MS,
  TODO_EDIT_LOCK_TTL_MS,
  GOOGLE_DRIVE_SCOPE_VERSION,
  INDUS_GOOGLE_APP_ID,
  TODO_STATUS_DEFINITIONS,
  SESSION_TTL_MS,
  acquireEntryEditLock,
  acquireTodoEditLock,
  acquireTodoAssignmentEditLock,
  activeEntryEditLock,
  activeTodoEditLock,
  todoAssignmentAssigneeIds,
  todoAssignmentEditLockConflict,
  ownsTodoAssignmentEditLock,
  todoAssignmentItems,
  releaseTodoAssignmentEditLock,
  entryEditLockConflict,
  buildCalendarIcs,
  buildPayrollSnapshot,
  buildClientBillSnapshot,
  clientReportSelection,
  clientReportAttachmentSelection,
  buildClientReportPdf,
  gmailDraftRaw,
  archivePayrollTodos,
  cancelClientBill,
  clientBillLockForTodos,
  reconcileTodoArchives,
  archiveRetentionMonthsForDb,
  archiveRetentionCandidates,
  purgeArchivedTodoGroups,
  canManageEntry,
  canManageFinancialEntry,
  canManageTodo,
  sourceTodoForNewEntry,
  defaultHourlyRateForUser,
  entryForUserRole,
  createSession,
  normalizeDb,
  normalizePayroll,
  payrollForUser,
  payrollSequenceError,
  payrollLockForTodos,
  payrollTotals,
  payrollPeriodEnded,
  payrollMinutesForTodo,
  pruneUnusedAdHocClients,
  releaseEntryEditLock,
  releaseTodoEditLock,
  syncUserForRequest,
  todoAssigneeForUpdate,
  todoAssigneesForRequest,
  revokeSession,
  todoEditLockConflict,
  todoForUserRole,
  sessionForToken,
  sessionTokenHash,
  validTodoAttachmentDataUrl,
  videoMimeType,
  validGoogleDriveId,
  googleDriveFileInfo,
  googleWorkspaceFileInfo,
  cleanTodoDriveFiles,
  validateTodo,
  visibleDebtsForUser,
  visibleEntriesForUser,
  visibleTodosForUser,
};