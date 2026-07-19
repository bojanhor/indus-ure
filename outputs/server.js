const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const os = require("os");
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
const GOOGLE_DRIVE_SCOPE_VERSION = 1;
const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_DRIVE_TASKS_FOLDER_ID = String(process.env.GOOGLE_DRIVE_TASKS_FOLDER_ID || "").trim();
const GOOGLE_DRIVE_OWNER_EMAIL = String(process.env.GOOGLE_DRIVE_OWNER_EMAIL || "bojan@indus.si").trim().toLowerCase();
const INDUS_GOOGLE_APP_ID = "indus-ure-v1";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = NODE_ENV === "production" ? "__Host-indus-ure" : "indus-ure-session";
const ALERT_SMTP_URL = String(process.env.ALERT_SMTP_URL || "").trim();
const ALERT_EMAIL_FROM = String(process.env.ALERT_EMAIL_FROM || "").trim();
const ALERT_EMAIL_TO = String(process.env.ALERT_EMAIL_TO || "bojan@indus.si").trim();
const MONITOR_INTERVAL_MS = Math.max(60_000, Number(process.env.MONITOR_INTERVAL_MS || 5 * 60_000));
const MONITOR_MAX_RSS_MB = Math.max(256, Number(process.env.MONITOR_MAX_RSS_MB || 1_800));
let pgPool = null;
let pgStore = null;
let pgReady = null;
let mutationQueue = Promise.resolve();
let monitorTimer = null;
let alertTransport = null;
const monitorAlertCooldowns = new Map();

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

function googleWorkspaceFileInfo(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.hostname !== "docs.google.com") return null;
    const match = url.pathname.match(/^\/(document|spreadsheets)\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/);
    if (!match) return null;
    return {
      kind: match[1] === "document" ? "document" : "spreadsheet",
      fileId: match[2],
      url: url.toString()
    };
  } catch {
    return null;
  }
}

function cleanTodoDriveFiles(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).map((item) => {
    const info = googleWorkspaceFileInfo(item?.url);
    if (!info || seen.has(info.fileId)) return null;
    seen.add(info.fileId);
    const managed = Boolean(item?.managed) && String(item?.ownerEmail || "").trim().toLowerCase() === GOOGLE_DRIVE_OWNER_EMAIL;
    return {
      id: String(item?.id || crypto.randomUUID()).slice(0, 100),
      kind: info.kind,
      fileId: info.fileId,
      url: info.url,
      name: String(item?.name || (info.kind === "document" ? "Google Dokument" : "Google Preglednica")).trim().slice(0, 180),
      managed,
      ownerEmail: managed ? GOOGLE_DRIVE_OWNER_EMAIL : "",
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

function storeTodoAttachments(db, todo, user = {}) {
  if (!db.attachments || typeof db.attachments !== "object" || Array.isArray(db.attachments)) db.attachments = {};
  const photos = (todo.photos || []).map((photo) => {
    const data = String(photo.data || "");
    const thumbnailData = String(photo.thumbnailData || "");
    let attachmentId = validTodoAttachmentId(photo.attachmentId) && db.attachments[photo.attachmentId]
      ? photo.attachmentId
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
    return {
      id: photo.id || crypto.randomUUID(),
      attachmentId,
      name: String(photo.name || "priloga").slice(0, 120),
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
  const used = new Set([
    ...(db.todos || []).flatMap((todo) => (todo.photos || []).map((photo) => photo.attachmentId)),
    ...(db.debts || []).flatMap((debt) => (debt.photos || []).map((photo) => photo.attachmentId))
  ].filter(validTodoAttachmentId));
  let changed = false;
  for (const attachmentId of Object.keys(db.attachments || {})) {
    if (used.has(attachmentId)) continue;
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
  if (state.driveScopeVersion !== GOOGLE_DRIVE_SCOPE_VERSION) {
    if (state.tokens || state.driveScopeVersion) changed = true;
    state.tokens = null;
    state.driveScopeVersion = 0;
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
    hourlyRate: nonnegativeNumber(db.settings.billing?.hourlyRate, 15, 10_000),
    // Stara enotna tarifa se uporabi samo za prehod ob nadgradnji.
    kmRate: legacyKmRate,
    workerOwnVehicleKmRate: nonnegativeNumber(db.settings.billing?.workerOwnVehicleKmRate, legacyKmRate, 1_000),
    clientPersonalKmRate: nonnegativeNumber(db.settings.billing?.clientPersonalKmRate, legacyKmRate, 1_000),
    clientVanKmRate: nonnegativeNumber(db.settings.billing?.clientVanKmRate, legacyKmRate, 1_000),
    commuteKmPerDay: nonnegativeNumber(db.settings.billing?.commuteKmPerDay, 28, 1_000_000)
  };
  for (const user of Object.values(db.users)) {
    const currentRate = nonnegativeNumber(user.billing?.hourlyRate, null, 10_000);
    if (!user.billing || currentRate === null) {
      user.billing = { ...(user.billing || {}), hourlyRate: currentRate ?? db.settings.billing.hourlyRate };
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
    for (const field of ["archiveGoogleEventId", "archivedAt", "archivedPayrollId"]) {
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
    const clientKmRate = nonnegativeNumber(next.clientKmRate, null, 1_000);
    if (next.clientKmRate !== clientKmRate) {
      next.clientKmRate = clientKmRate;
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

  return { db, changed };
}

function ensureDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify({ users: defaultUsers, sessions: {}, entries: [], todos: [], attachments: {}, debts: [], clients: [] }, null, 2), "utf8");
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
    role: user.role
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
const PAYROLL_PAID_TODO_STATUSES = new Set(["execution", "meal"]);

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
  return `Delavec lahko ${label} popravi ali izbrise samo na dan vnosa.`;
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
  if (!range) return "Obracunsko obdobje ni pravilno.";
  const records = (db.payrolls || [])
    .filter((payroll) => payroll.workerId === workerId && payroll.id !== excludeId)
    .map((payroll) => ({ ...payroll, range: payrollRange(payroll) }))
    .filter((payroll) => payroll.range)
    .map((payroll) => ({ id: payroll.id, from: payroll.range.from, to: payroll.range.to }));
  if (!records.length) return "";
  const earliest = records.slice().sort((left, right) => left.from.localeCompare(right.from))[0];
  if (range.to < earliest.from) return "Starejsega obracuna pred prvim obstojecim obracunom ni mogoce dodati.";
  records.push({ id: excludeId || "candidate", from: range.from, to: range.to });
  records.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    const expectedFrom = payrollNextDate(previous.to);
    if (current.from < expectedFrom) return "Obracunski obdobji se prekrivata.";
    if (current.from > expectedFrom) return `Zacetek obracuna mora biti ${expectedFrom}, neposredno po prejsnjem obracunu.`;
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
function payrollMinutesForTodo(todo) {
  if (!todo || !PAYROLL_PAID_TODO_STATUSES.has(todo.status) || !/^\d{4}-\d{2}-\d{2}$/.test(String(todo.date || ""))) return null;
  const start = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(todo.start || ""));
  const end = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(todo.end || ""));
  if (!start || !end) return null;
  const minutes = (Number(end[1]) * 60 + Number(end[2])) - (Number(start[1]) * 60 + Number(start[2]));
  return minutes > 0 ? minutes : null;
}

function payrollLineForTodo(db, todo, workerId = "") {
  const minutes = payrollMinutesForTodo(todo);
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
function defaultHourlyRateForUser(db, userId) {
  return nonnegativeNumber(
    db.users?.[userId]?.billing?.hourlyRate,
    nonnegativeNumber(db.settings?.billing?.hourlyRate, 15, 10_000),
    10_000
  );
}

function clientKmRateForVehicle(db, vehicle) {
  const billing = db.settings?.billing || {};
  const fallback = nonnegativeNumber(billing.kmRate, 0.22, 1_000);
  return nonnegativeNumber(vehicle === "van" ? billing.clientVanKmRate : billing.clientPersonalKmRate, fallback, 1_000);
}

function todoForUserRole(user, db, previous, todo) {
  const previousRate = nonnegativeNumber(previous?.billingHourlyRate, null, 10_000);
  const previousKm = nonnegativeNumber(previous?.billingKm, 0, 1_000_000);
  const previousClientKm = nonnegativeNumber(previous?.clientKm, 0, 1_000_000);
  const previousClientVehicle = todoVehicle(previous?.clientVehicle);
  const requestedClientVehicle = todoVehicle(todo.clientVehicle);
  const isCompleted = todo.status === "execution";
  const canSetClientMileage = isCompleted;
  const defaultRate = defaultHourlyRateForUser(db, todo.syncUser || previous?.syncUser || user.id);
  const clientKmRate = clientKmRateForVehicle(db, requestedClientVehicle);
  if (user.role !== "boss") {
    const clientVehicle = canSetClientMileage ? requestedClientVehicle : previousClientVehicle;
    return {
      ...todo,
      billingHourlyRate: isCompleted ? previousRate ?? defaultRate : previousRate,
      billingKm: isCompleted ? nonnegativeNumber(todo.billingKm, previousKm, 1_000_000) : previousKm,
      clientKm: canSetClientMileage ? nonnegativeNumber(todo.clientKm, previousClientKm, 1_000_000) : previousClientKm,
      clientVehicle,
      clientKmRate: canSetClientMileage ? clientKmRateForVehicle(db, clientVehicle) : nonnegativeNumber(previous?.clientKmRate, clientKmRateForVehicle(db, clientVehicle), 1_000)
    };
  }
  return {
    ...todo,
    billingHourlyRate: isCompleted ? nonnegativeNumber(todo.billingHourlyRate, previousRate ?? defaultRate, 10_000) : previousRate,
    billingKm: isCompleted ? nonnegativeNumber(todo.billingKm, previousKm, 1_000_000) : previousKm,
    clientKm: nonnegativeNumber(todo.clientKm, previousClientKm, 1_000_000),
    clientVehicle: requestedClientVehicle,
    clientKmRate
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
    sendJson(res, 401, { error: "Prijava je potekla. Prijavi se se enkrat." });
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
    sendJson(res, 401, { error: "Prijava je potekla. Prijavi se se enkrat." });
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
  if (!entry.date || !entry.start || !entry.end) return "Manjka datum ali cas.";
  if (!["errand", "vacation"].includes(entry.status) && !entry.client) return "Manjka stranka.";
  if (!["errand", "vacation"].includes(entry.status) && !entry.clientId) return "Stranke ni bilo mogoce identificirati.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return "Datum ni pravilen.";
  if (!/^\d{2}:\d{2}$/.test(entry.start) || !/^\d{2}:\d{2}$/.test(entry.end)) return "Cas ni pravilen.";
  if (entry.end <= entry.start) return "Ura do mora biti kasneje kot ura od.";
  return "";
}

function cleanTodo(input) {
  const photos = Array.isArray(input.photos) ? input.photos : [];
  return {
    title: String(input.title || "").trim(),
    date: String(input.date || ""),
    start: roundTimeToQuarterHour(input.start),
    end: roundTimeToQuarterHour(input.end),
    client: String(input.client || "").trim(),
    clientId: String(input.clientId || "").trim(),
    notes: String(input.notes || "").trim(),
    material: String(input.material || "").trim(),
    status: input.status === "billing" ? "execution" : TODO_STATUSES.has(input.status) ? input.status : "open",
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    urgent: ["execution", "billing"].includes(input.status) ? false : Boolean(input.urgent),
    syncUser: cleanUserId(input.syncUser),
    sourceProjectTodoId: String(input.sourceProjectTodoId || "").trim().slice(0, 100),
    done: input.status === "execution",
    billingHourlyRate: nonnegativeNumber(input.billingHourlyRate, null, 10_000),
    billingKm: nonnegativeNumber(input.billingKm, null, 1_000_000),
    clientKm: nonnegativeNumber(input.clientKm, null, 1_000_000),
    clientVehicle: todoVehicle(input.clientVehicle),
    clientKmRate: nonnegativeNumber(input.clientKmRate, null, 1_000),
    driveFiles: cleanTodoDriveFiles(input.driveFiles),
    photos: limitTodoAttachmentsData(photos
      .map((photo) => ({
        id: photo.id || crypto.randomUUID(),
        name: String(photo.name || "priloga").slice(0, 120),
        attachmentId: String(photo.attachmentId || ""),
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
  return error ? error.replace("zalozenega denarja", "osebnega nakupa") : "";
}

function validateAdvance(advance, db) {
  if (!advance.person || !db.users?.[advance.person]) return "Izberi delavca.";
  if (!isDateKey(advance.date)) return "Datum zalozenega denarja ni pravilen.";
  if (!Number.isFinite(advance.amount) || advance.amount <= 0) return "Vnesi znesek.";
  if (!advance.reason) return "Vnesi komentar.";
  if ((advance.photos || []).some((photo) => !validTodoAttachmentDataUrl(photo.data) && !validTodoAttachmentId(photo.attachmentId))) return "Priloga ni veljavna slika ali PDF.";
  return "";
}

function validateClient(client) {
  if (!client.name) return "Manjka naziv stranke.";
  if (client.taxId && !isUsableTaxId(client.taxId)) return "Davcna stevilka ni veljavna.";
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
  if (requireClientId && todo.client && !todo.clientId) return "Stranke ni bilo mogoce identificirati.";
  if (todo.date && !/^\d{4}-\d{2}-\d{2}$/.test(todo.date)) return "Datum opravila ni pravilen.";
  if (Boolean(todo.start) !== Boolean(todo.end)) return "Vnesi obe uri: od in do.";
  if ((todo.start || todo.end) && !todo.date) return "Za opravilo z uro vnesi tudi datum.";
  if (todo.start && (!/^\d{2}:\d{2}$/.test(todo.start) || !/^\d{2}:\d{2}$/.test(todo.end))) return "Cas opravila ni pravilen.";
  if (todo.status === "execution" && (!todo.date || !todo.start || !todo.end)) return "Za zakljuceno opravilo vnesi datum ter uro od in do.";
  if (todo.start && todo.end <= todo.start) return "Ura do mora biti kasneje kot ura od.";
  if ((todo.photos || []).some((photo) => !validTodoAttachmentDataUrl(photo.data) && !validTodoAttachmentId(photo.attachmentId))) return "Priloga ni veljavna slika ali PDF.";
  if ((todo.photos || []).reduce((total, photo) => total + String(photo.data || "").length, 0) > MAX_TODO_ATTACHMENTS_DATA_LENGTH) return "Priloge so skupaj prevelike.";
  if ((todo.photos || []).some((photo) => photo.thumbnailData && !validTodoThumbnailDataUrl(photo.thumbnailData))) return "Predogled PDF priloge ni veljaven.";
  if ((todo.driveFiles || []).length > 12) return "Najvec je 12 Google dokumentov ali preglednic na opravilo.";
  if ((todo.driveFiles || []).some((file) => !validGoogleDriveId(file.fileId) || !googleWorkspaceFileInfo(file.url))) return "Google priponka ni veljaven Dokument ali Preglednica.";
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
      if (!groups.has(key)) groups.set(key, todo);
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

function googleDriveTasksReady() {
  return googleReady() && validGoogleDriveId(GOOGLE_DRIVE_TASKS_FOLDER_ID) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(GOOGLE_DRIVE_OWNER_EMAIL);
}

function googleDriveOwner(db) {
  return userByEmail(db, GOOGLE_DRIVE_OWNER_EMAIL) || null;
}

async function createManagedGoogleDriveFile(req, db, actor, input = {}) {
  if (!googleDriveTasksReady()) {
    throw new Error("Google Dokumenti niso nastavljeni: manjka mapa ali Bojanov e-naslov v okolju streznika.");
  }
  const owner = googleDriveOwner(db);
  if (!owner || Number(owner.google?.driveScopeVersion || 0) !== GOOGLE_DRIVE_SCOPE_VERSION || !owner.google?.tokens) {
    throw new Error("Bojan mora najprej v Nastavitvah povezati Google Dokumente in preglednice.");
  }
  const kind = input.kind === "spreadsheet" ? "spreadsheet" : input.kind === "document" ? "document" : "";
  if (!kind) throw new Error("Izberi Google Dokument ali Google Preglednico.");
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Najprej vpisi ime opravila.");
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
    const ownedByBojan = (created.owners || []).some((item) => String(item.emailAddress || "").toLowerCase() === GOOGLE_DRIVE_OWNER_EMAIL);
    const inConfiguredFolder = (created.parents || []).includes(GOOGLE_DRIVE_TASKS_FOLDER_ID);
    if (!created.id || !created.webViewLink || created.driveId || !ownedByBojan || !inConfiguredFolder) {
      throw new Error("Google datoteke ni bilo mogoce ustvariti kot Bojanovo datoteko v izbrani mapi.");
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
        console.warn(`Google osnutka ${created.id} ni bilo mogoce odstraniti: ${cleanupError.message || cleanupError}`);
      }
    }
    throw error;
  }
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
  const worker = db.users?.[payroll.workerId] || { id: payroll.workerId, name: payroll.workerId };
  const todos = payrollTodosForArchive(db, payroll);
  if (!todos.length) throw new Error("V obračunu ni vnosov ur za arhiv.");
  const now = new Date().toISOString();
  let archivedNow = 0;
  for (const todo of todos) {
    if (todo.archivedAt) continue;
    todo.archivedAt = now;
    todo.archivedPayrollId = payroll.id;
    todo.updatedAt = now;
    todo.updatedBy = actor?.id || payroll.confirmedBy || "system";
    todo.updatedByName = actor?.name || payroll.confirmedByName || "";
    todo.history = [...(todo.history || []), audit(actor || worker, `arhivirano v obračunu ${payroll.month}`)];
    archivedNow += 1;
  }
  return { archived: archivedNow, archiveCalendarName: "interni arhiv" };
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
  const arrays = ["entries", "todos", "debts", "clients", "billingLocks", "payrolls"];
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

async function recordOperationalAlert({ code, severity = "warning", title, message }) {
  const last = Number(monitorAlertCooldowns.get(code) || 0);
  if (Date.now() - last < 6 * 60 * 60 * 1000) return false;
  monitorAlertCooldowns.set(code, Date.now());
  const notification = { id: crypto.randomUUID(), code, severity, title, message, createdAt: new Date().toISOString() };
  if (DATABASE_URL) {
    try {
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
      const backup = await getPgPool().query("select finished_at from indus_backup_runs where status = 'success' order by finished_at desc limit 1");
      const latest = new Date(backup.rows[0]?.finished_at || 0).getTime();
      if (!latest || Date.now() - latest > 36 * 60 * 60 * 1000) {
        issues.push({ code: "backup-stale", severity: "warning", title: "Varnostna kopija je zastarela", message: "Ni potrjene šifrirane varnostne kopije v zadnjih 36 urah." });
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
      const owner = String(user.email || "").toLowerCase() === GOOGLE_DRIVE_OWNER_EMAIL;
      const db = await readDbAsync();
      const driveOwner = googleDriveOwner(db);
      sendJson(res, 200, {
        configured: googleDriveTasksReady(),
        owner,
        connected: Boolean(driveOwner?.google?.tokens && Number(driveOwner.google.driveScopeVersion || 0) === GOOGLE_DRIVE_SCOPE_VERSION)
      });
      return;
    }

    if (url.pathname === "/api/auth/google-url" && req.method === "GET") {
      if (!googleReady()) {
        sendJson(res, 400, { error: "Google prijava se ni nastavljena na strezniku." });
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
        sendJson(res, 403, { error: "Google Dokumente lahko poveze samo Bojanov racun." });
        return;
      }
      if (!googleDriveTasksReady()) {
        sendJson(res, 400, { error: "Google Dokumenti niso nastavljeni: manjka mapa ali Bojanov e-naslov v okolju streznika." });
        return;
      }
      cleanupPendingGoogleStates();
      const state = `drive:${crypto.randomBytes(24).toString("hex")}`;
      pendingGoogleConnections.set(state, { userId: user.id, kind: "drive", startedAt: Date.now() });
      const auth = googleClient(req);
      const authUrl = auth.generateAuthUrl({
        access_type: "offline",
        state,
        scope: [GOOGLE_DRIVE_FILE_SCOPE],

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
          sendText(res, 403, "Ta Google racun nima dostopa do INDUS URE. Dovoljena sta samo Ibro in Bojan.", "text/plain");
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
        sendText(res, 401, "Uporabnik ne obstaja vec.", "text/plain");
        return;
      }
      user.google = user.google || {};
      if (pending.kind !== "drive") {
        sendText(res, 400, "Ta Google povezava ni vec podprta.", "text/plain");
        return;
      }
      const currentDriveScope = Number(user.google?.driveScopeVersion || 0) === GOOGLE_DRIVE_SCOPE_VERSION;
      const refreshToken = result.tokens.refresh_token || (currentDriveScope ? user.google.tokens?.refresh_token : "");
      if (!refreshToken) {
        sendText(res, 400, "Google ni vrnil trajnega dovoljenja. V Google racunu odstrani dostop INDUS URE in poskusi znova.", "text/plain");
        return;
      }
      user.google = {
        tokens: { ...result.tokens, refresh_token: refreshToken },
        connectedAt: new Date().toISOString(),
        driveScopeVersion: GOOGLE_DRIVE_SCOPE_VERSION
      };
      await writeDbAsync(db);
      sendText(res, 200, "Google Dokumenti, preglednice in backup so povezani. Lahko zapres to okno in se vrnes v INDUS URE.", "text/plain");
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

    if (url.pathname === "/api/payrolls" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo sef lahko potrdi obracun." });
        return;
      }
      const body = await readBody(req);
      const workerId = cleanUserId(body.workerId);
      const range = payrollRange(body);
      if (!workerId || !range) {
        sendJson(res, 400, { error: "Delavec ali obracunsko obdobje ni pravilno." });
        return;
      }
      if (!payrollPeriodEnded(range)) {
        sendJson(res, 409, { error: "Obracun lahko potrdis sele po koncu izbranega obracunskega meseca." });
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
        sendJson(res, 409, { error: "Ta obracun je ze potrjen ali placan." });
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
        sendJson(res, 400, { error: "Za izbrano obdobje delavec nima zakljucenih vnosov ur." });
        return;
      }
      if (existingIndex >= 0) db.payrolls[existingIndex] = payroll;
      else db.payrolls.push(payroll);
      // Persist the locked snapshot before internal archival, so a retry can finish safely.
      await writeDbAsync(db);
      await archivePayrollTodos(db, payroll, user);
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
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user), payroll });
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
        sendJson(res, 403, { error: "Samo sef lahko potrjuje ali odpira obracune." });
        return;
      }
      const body = await readBody(req);
      const action = String(body.action || "refresh");
      const db = await readDbAsync();
      const index = db.payrolls.findIndex((payroll) => payroll.id === decodeURIComponent(payrollMatch[1]));
      if (index < 0) {
        sendJson(res, 404, { error: "Obracun ne obstaja." });
        return;
      }
      const current = db.payrolls[index];
      const now = new Date().toISOString();
      if (action === "confirm" && !payrollPeriodEnded(current)) {
        sendJson(res, 409, { error: "Obracun lahko potrdis sele po koncu izbranega obracunskega meseca." });
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
          sendJson(res, 409, { error: "Potrjen obracun najprej ponovno odpri." });
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
          sendJson(res, 400, { error: "Obracun nima zakljucenih vnosov ur." });
          return;
        }
        db.payrolls[index] = payroll;
        await writeDbAsync(db);
        await archivePayrollTodos(db, payroll, user);
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
          sendJson(res, 409, { error: "Kot placanega lahko oznacis samo potrjen obracun." });
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
          sendJson(res, 409, { error: "Obracun je ze odprt za popravke." });
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
        sendJson(res, 400, { error: "Neznano dejanje obracuna." });
        return;
      }
      if (!payroll?.lines.length) {
        sendJson(res, 400, { error: "Obracun nima zakljucenih vnosov ur." });
        return;
      }
      db.payrolls[index] = payroll;
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user), payroll });
      return;
    }

    if (payrollMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo sef lahko brise osnutek obracuna." });
        return;
      }
      const db = await readDbAsync();
      const index = db.payrolls.findIndex((payroll) => payroll.id === decodeURIComponent(payrollMatch[1]));
      if (index < 0) {
        sendJson(res, 404, { error: "Obracun ne obstaja." });
        return;
      }
      if (db.payrolls[index].status !== "draft") {
        sendJson(res, 409, { error: "Potrjenega obracuna ni mogoce izbrisati; najprej ga ponovno odpri." });
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
        sendJson(res, 403, { error: "Samo sef lahko vidi urne postavke delavcev." });
        return;
      }
      const db = await readDbAsync();
      const workers = Object.values(db.users || {}).map((worker) => ({
        id: worker.id,
        name: worker.name,
        role: worker.role,
        hourlyRate: defaultHourlyRateForUser(db, worker.id)
      }));
      sendJson(res, 200, { workers });
      return;
    }

    if (url.pathname === "/api/workers/billing" && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo sef lahko spreminja urne postavke delavcev." });
        return;
      }
      const body = await readBody(req);
      const db = await readDbAsync();
      const workerId = cleanUserId(body.userId);
      const hourlyRate = nonnegativeNumber(body.hourlyRate, null, 10_000);
      if (!db.users?.[workerId] || hourlyRate === null) {
        sendJson(res, 400, { error: "Delavec ali urna postavka ni pravilna." });
        return;
      }
      db.users[workerId].billing = { ...(db.users[workerId].billing || {}), hourlyRate };
      await writeDbAsync(db);
      const workers = Object.values(db.users).map((worker) => ({
        id: worker.id,
        name: worker.name,
        role: worker.role,
        hourlyRate: defaultHourlyRateForUser(db, worker.id)
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
      sendJson(res, 410, { error: "Gesla se ne spreminja v aplikaciji. Prijava je vezana na Google racun." });
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
      if (todoIds.length < 2 || todoIds.length > 500) {
        sendJson(res, 400, { error: "Za razvrscanje posreduj vsaj dve opravili." });
        return;
      }
      const db = await readDbAsync();
      const byId = new Map((db.todos || []).map((todo) => [todo.id, todo]));
      const todos = todoIds.map((id) => byId.get(id));
      const editLockTokens = body.editLockTokens && typeof body.editLockTokens === "object" ? body.editLockTokens : {};
      for (const todo of todos) {
        if (!todo || !canManageTodo(user, todo)) {
          sendJson(res, 403, { error: "Tega vrstnega reda ne smes spreminjati." });
          return;
        }
        if (todo.done || todo.urgent || todo.status === "meal") {
          sendJson(res, 400, { error: "Izbranega opravila ni mogoce rocno razvrscati." });
          return;
        }
        const editLock = todoAssignmentEditLockConflict(db, todo, user, String(editLockTokens[todo.id] || ""));
        if (editLock) {
          sendJson(res, 409, { error: `Opravilo trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
          return;
        }
      }
      const now = new Date().toISOString();
      todos.forEach((todo, index) => {
        todo.userOrders = { ...(todo.userOrders || {}), [user.id]: index + 1 };
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
        sendJson(res, 403, { error: "Samo sef lahko spreminja obracunske nastavitve." });
        return;
      }
      const body = await readBody(req);
      const db = await readDbAsync();
      db.settings = db.settings || {};
      const previousBilling = db.settings.billing || {};
      const legacyKmRate = nonnegativeNumber(body.kmRate, nonnegativeNumber(previousBilling.kmRate, 0.22, 1_000), 1_000);
      db.settings.billing = {
        hourlyRate: nonnegativeNumber(body.hourlyRate, nonnegativeNumber(previousBilling.hourlyRate, 15, 10_000), 10_000),
        // Ohranjeno samo zaradi starih podatkov; UI uporablja tri ločene tarife spodaj.
        kmRate: legacyKmRate,
        workerOwnVehicleKmRate: nonnegativeNumber(body.workerOwnVehicleKmRate, nonnegativeNumber(previousBilling.workerOwnVehicleKmRate, legacyKmRate, 1_000), 1_000),
        clientPersonalKmRate: nonnegativeNumber(body.clientPersonalKmRate, nonnegativeNumber(previousBilling.clientPersonalKmRate, legacyKmRate, 1_000), 1_000),
        clientVanKmRate: nonnegativeNumber(body.clientVanKmRate, nonnegativeNumber(previousBilling.clientVanKmRate, legacyKmRate, 1_000), 1_000),
        commuteKmPerDay: nonnegativeNumber(body.commuteKmPerDay, nonnegativeNumber(previousBilling.commuteKmPerDay, 28, 1_000_000), 1_000_000)
      };
      await writeDbAsync(db);
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
          sendJson(res, 400, { error: "Povezano opravilo ni vec odprto." });
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
      if (index < 0) { sendJson(res, 404, { error: "Zalozeni znesek ne obstaja." }); return; }
      const existing = db.debts[index];
      if (!canManageFinancialEntry(user, existing)) { sendJson(res, 403, { error: financialEntryAccessError(user, existing, "zalozeni znesek") }); return; }
      const usedInConfirmedPayroll = (db.payrolls || []).some((payroll) => ["archiving", "confirmed", "paid"].includes(payroll.status) && (payroll.advanceIds || []).map(String).includes(id));
      if (usedInConfirmedPayroll && user.role !== "boss") { sendJson(res, 409, { error: "Zalozeni znesek je ze del potrjenega obracuna." }); return; }
      let advance = cleanAdvance(await readBody(req));
      if (user.role !== "boss") advance.person = existing.person;
      const validation = validateAdvance(advance, db);
      if (validation) { sendJson(res, 400, { error: validation }); return; }
      if (advance.projectTodoId) {
        const project = db.todos.find((todo) => todo.id === advance.projectTodoId);
        if (!project || !["execution", "open", "in_progress", "internal"].includes(project.status)) { sendJson(res, 400, { error: "Povezano opravilo ni vec odprto." }); return; }
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
        sendJson(res, 403, { error: financialEntryAccessError(user, advance, "zalozeni znesek") });
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
      if (usedInConfirmedPayroll && user.role !== "boss") { sendJson(res, 409, { error: "Osebni nakup je ze del potrjenega obracuna." }); return; }
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
        sendJson(res, 403, { error: "Samo sef lahko ureja dolgove." });
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
        sendJson(res, 403, { error: "Samo Bojan lahko zaklene obracun." });
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
        note: String(body.note || "Obracunano").trim(),
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
        sendJson(res, 403, { error: "Samo sef lahko ureja dolgove." });
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
        sendJson(res, 403, { error: "Samo sef lahko ureja dolgove." });
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
      const assigneeIds = todoAssigneesForRequest(user, body.assigneeIds || todo.syncUser, db.users);
      if (todo.status === "execution" && assigneeIds.length !== 1) {
        sendJson(res, 400, { error: "Zakljucene ure se vpisujejo posebej za enega delavca." });
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
      const body = await readBody(req);
      const db = await readDbAsync();
      const driveFile = await createManagedGoogleDriveFile(req, db, user, body);
      sendJson(res, 201, { driveFile });
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
        sendJson(res, 400, { error: "Nov koledarski vnos lahko ustvaris samo iz svojega opravila z istim datumom." });
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
        sendJson(res, 403, { error: "Tega vnosa ne mores urejati." });
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
        sendJson(res, 403, { error: "Tega vnosa ne mores spreminjati." });
        return;
      }
      const editLock = entryEditLockConflict(id, user, editLockToken);
      if (editLock) {
        sendJson(res, 409, { error: `Vnos trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
        return;
      }
      entry = entryForUserRole(user, entry, db.entries[index]);
      if (user.role !== "boss" && entryIsLocked(db, db.entries[index]) && lockedFieldChanged(db.entries[index], entry)) {
        sendJson(res, 403, { error: "To obdobje je obracunano. Ure, kilometrina in start od doma so zaklenjeni." });
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
        sendJson(res, 403, { error: "Tega vnosa ne mores izbrisati." });
        return;
      }
      const editLock = entryEditLockConflict(id, user, editLockToken);
      if (editLock) {
        sendJson(res, 409, { error: `Vnos trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
        return;
      }
      if (user.role !== "boss" && entryIsLocked(db, entry)) {
        sendJson(res, 403, { error: "To obdobje je obracunano. Vnosa ne mores izbrisati." });
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
        sendJson(res, 403, { error: "Tega opravila ne mores urejati." });
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
        sendJson(res, 403, { error: "Tega opravila ne mores spreminjati." });
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
        sendJson(res, 403, { error: `Opravilo je del potrjenega obracuna za ${db.users?.[payrollLock.workerId]?.name || payrollLock.workerId} (${payrollLock.month}). Sef ga mora najprej ponovno odpreti.` });
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
        history: [...(item.history || []), audit(user, date === previousTodo.date ? "prestavljen v casovnici" : `prestavljen na ${date} v casovnici`)]
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
        sendJson(res, 403, { error: "Tega opravila ne mores spreminjati." });
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
        sendJson(res, 403, { error: `Opravilo je del potrjenega obracuna za ${db.users?.[payrollLock.workerId]?.name || payrollLock.workerId} (${payrollLock.month}). Sef ga mora najprej ponovno odpreti.` });
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

      if (todo.status === "execution" && assigneeIds.length !== 1) {
        sendJson(res, 400, { error: "Zakljucene ure se vpisujejo posebej za enega delavca." });
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
            order: isOpenedTodo ? todo.order : existing.order,
            updatedBy: user.id,
            updatedByName: user.name,
            updatedAt: now,
            history: [...(existing.history || []), audit(user, assignmentsChanged
              ? `dodelitev spremenjena: ${assigneeNames}`
              : todo.done ? "oznaceno opravljeno" : "spremenjeno opravilo")]
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
        sendJson(res, 403, { error: "Tega opravila ne mores izbrisati." });
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
        sendJson(res, 403, { error: `Opravilo je del potrjenega obracuna za ${db.users?.[payrollLock.workerId]?.name || payrollLock.workerId} (${payrollLock.month}). Sef ga mora najprej ponovno odpreti.` });
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
    const message = NODE_ENV === "production" ? "Napaka na strezniku." : (error.message || "Napaka na strezniku.");
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
    const message = NODE_ENV === "production" ? "Napaka na strezniku." : (error.message || "Napaka na strezniku.");
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
    console.warn(`Omreznih URL-jev ni bilo mogoce prebrati: ${error.message || error}`);
    return [];
  }
}

function handleUnexpectedRequestError(error, res) {
  console.error("Nepricakovana napaka zahtevka:", error);
  if (!res.headersSent) {
    sendJson(res, 500, { error: "Napaka na strezniku." });
  } else {
    res.destroy();
  }
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
      if (req.method !== "GET" || req.url.startsWith("/api/google/callback")) {
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
    for (const url of networkUrls()) console.log(`Na istem omrezju: ${url}`);
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
  archivePayrollTodos,
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
  validGoogleDriveId,
  googleWorkspaceFileInfo,
  cleanTodoDriveFiles,
  validateTodo,
  visibleDebtsForUser,
  visibleEntriesForUser,
  visibleTodosForUser
};