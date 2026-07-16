const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const {
  DEFAULT_CLIENT_SHEET_RANGE,
  clientToSheetRow,
  findFirstEmptyClientRow,
  isUsableTaxId,
  normalizeStoredClient,
  normalizeTaxId,
  parseSheetClients,
  rekeyClientReferences,
  sheetAppendRange,
  sheetRowRange
} = require("./client-sync");

const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || "127.0.0.1";
const NODE_ENV = process.env.NODE_ENV || "development";
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const root = __dirname;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const dbFile = path.join(dataDir, "db.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const configuredBojanPassword = process.env.INITIAL_BOJAN_PASSWORD || "";
const configuredIbroPassword = process.env.INITIAL_IBRO_PASSWORD || "";
const initialBojanPassword = configuredBojanPassword || crypto.randomBytes(24).toString("hex");
const initialIbroPassword = configuredIbroPassword || crypto.randomBytes(24).toString("hex");
const resetUserPasswords = process.env.RESET_USER_PASSWORDS === "true";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "";
const GOOGLE_SHEETS_RANGE = String(process.env.GOOGLE_SHEETS_RANGE || DEFAULT_CLIENT_SHEET_RANGE).replace(/:[I-L]$/i, ":M");
const GOOGLE_CALENDAR_SCOPE_VERSION = 2;
const INDUS_GOOGLE_APP_ID = "indus-ure-v1";
const GOOGLE_SYNC_INTERVAL_MS = Math.max(60_000, Number(process.env.GOOGLE_SYNC_INTERVAL_MS || 60_000));
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let pgPool = null;
let pgReady = null;
let mutationQueue = Promise.resolve();

const TODO_STATUS_DEFINITIONS = Object.freeze({
  open: { label: "Čaka", googleColorId: "8" },
  in_progress: { label: "V teku", googleColorId: "9" },
  execution: { label: "Zaklju\u010deno", googleColorId: "10" },
  order: { label: "Naroči", googleColorId: "11" },
  order_car: { label: "Naroči Avto", googleColorId: "11" },
  order_warehouse: { label: "Naroči Sklad.", googleColorId: "11" },
  add_to_car: { label: "Dodaj v avto", googleColorId: "4" },
  return_and_bill: { label: "Vrne naj/Poračunaj", googleColorId: "6" },
  return: { label: "!!Vrni", googleColorId: "3" },
  meal: { label: "Malica", googleColorId: "5" },
  internal: { label: "Razno/Interno", googleColorId: "5" }
});
const TODO_STATUSES = new Set(Object.keys(TODO_STATUS_DEFINITIONS));

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

function hydrateTodoAttachments(db, todo) {
  return {
    ...todo,
    photos: (todo.photos || []).map((photo) => ({
      ...photo,
      data: String(photo.data || db.attachments?.[photo.attachmentId]?.data || ""),
      thumbnailData: String(photo.thumbnailData || db.attachments?.[photo.attachmentId]?.thumbnailData || "")
    })).filter((photo) => validTodoAttachmentDataUrl(photo.data))
  };
}

function pruneUnusedTodoAttachments(db) {
  const used = new Set((db.todos || []).flatMap((todo) => (todo.photos || []).map((photo) => photo.attachmentId)).filter(validTodoAttachmentId));
  let changed = false;
  for (const attachmentId of Object.keys(db.attachments || {})) {
    if (used.has(attachmentId)) continue;
    delete db.attachments[attachmentId];
    changed = true;
  }
  return changed;
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
  const token = crypto.randomBytes(24).toString("hex");
  if (!db.sessions || typeof db.sessions !== "object" || Array.isArray(db.sessions)) db.sessions = {};
  for (const [hash, session] of Object.entries(db.sessions)) {
    if (!session || Number(session.expiresAt) <= now) {
      delete db.sessions[hash];
    }
  }
  db.sessions[sessionTokenHash(token)] = { userId, expiresAt: now + SESSION_TTL_MS };
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
    if (!db.users[id].google) {
      db.users[id].google = { tokens: null, calendarId: "", calendarName: "", connectedAt: "", scopeVersion: 0 };
      changed = true;
    }
    const googleState = db.users[id].google;
    if (Number(googleState.scopeVersion || 0) !== GOOGLE_CALENDAR_SCOPE_VERSION) {
      if (googleState.tokens || googleState.calendarId || googleState.syncToken) {
        googleState.tokens = null;
        googleState.calendarId = "";
        googleState.calendarName = "";
        googleState.syncToken = "";
        changed = true;
      }
      if (Number(googleState.scopeVersion || 0) !== 0) {
        googleState.scopeVersion = 0;
        changed = true;
      }
    }
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
    if (!user.google) {
      user.google = { tokens: null, calendarId: "", calendarName: "", connectedAt: "", scopeVersion: 0 };
      changed = true;
    }
    const googleState = user.google;
    if (Number(googleState.scopeVersion || 0) !== GOOGLE_CALENDAR_SCOPE_VERSION) {
      if (googleState.tokens || googleState.calendarId || googleState.syncToken) {
        googleState.tokens = null;
        googleState.calendarId = "";
        googleState.calendarName = "";
        googleState.syncToken = "";
        changed = true;
      }
      if (Number(googleState.scopeVersion || 0) !== 0) {
        googleState.scopeVersion = 0;
        changed = true;
      }
    }
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

  if (!db.settings || typeof db.settings !== "object") {
    db.settings = {};
    changed = true;
  }
  if (!db.settings.billing || typeof db.settings.billing !== "object") {
    db.settings.billing = {};
    changed = true;
  }
  db.settings.billing = {
    hourlyRate: Number(db.settings.billing?.hourlyRate || 15),
    kmRate: Number(db.settings.billing?.kmRate || 0.22),
    commuteKmPerDay: Number(db.settings.billing?.commuteKmPerDay || 28)
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
    if (!Array.isArray(next.photos)) {
      next.photos = [];
      changed = true;
    }
    const photosBefore = JSON.stringify(next.photos);
    next.photos = storeTodoAttachments(db, next, {
      id: next.createdBy || "system",
      name: next.createdByName || ""
    }).photos;
    if (JSON.stringify(next.photos) !== photosBefore) changed = true;
    return next;
  });

  if (pruneUnusedTodoAttachments(db)) changed = true;

  db.debts = db.debts.map((debt) => ({
    id: debt.id || crypto.randomUUID(),
    month: /^\d{4}-\d{2}$/.test(String(debt.month || "")) ? String(debt.month) : new Date().toISOString().slice(0, 7),
    person: ["ibro", "bojan"].includes(debt.person) ? debt.person : "ibro",
    amount: Number(debt.amount || 0),
    reason: String(debt.reason || "").trim(),
    createdBy: debt.createdBy || "system",
    createdByName: debt.createdByName || "",
    createdAt: debt.createdAt || new Date().toISOString(),
    updatedBy: debt.updatedBy || debt.createdBy || "system",
    updatedByName: debt.updatedByName || debt.createdByName || "",
    updatedAt: debt.updatedAt || debt.createdAt || new Date().toISOString()
  })).filter((debt) => debt.amount || debt.reason);

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

async function ensurePostgresDb() {
  if (!DATABASE_URL) return;
  if (pgReady) return pgReady;
  pgReady = (async () => {
    const pool = getPgPool();
    await pool.query(`
      create table if not exists app_state (
        id text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    const existing = await pool.query("select data from app_state where id = $1", ["main"]);
    if (existing.rowCount === 0) {
      await pool.query(
        "insert into app_state (id, data) values ($1, $2::jsonb)",
        ["main", JSON.stringify({ users: defaultUsers, sessions: {}, entries: [], todos: [], attachments: {}, debts: [], clients: [], calendarToken: crypto.randomBytes(24).toString("hex") })]
      );
      return;
    }
    const { db, changed } = normalizeDb(existing.rows[0].data);
    if (changed) {
      await pool.query(
        "update app_state set data = $1::jsonb, updated_at = now() where id = $2",
        [JSON.stringify(db), "main"]
      );
    }
  })();
  return pgReady;
}

async function readDbAsync() {
  if (!DATABASE_URL) return readDb();
  await ensurePostgresDb();
  const result = await getPgPool().query("select data from app_state where id = $1", ["main"]);
  const { db, changed } = normalizeDb(result.rows[0]?.data || {});
  if (changed) await writeDbAsync(db);
  return db;
}

async function writeDbAsync(db) {
  if (!DATABASE_URL) {
    writeDb(db);
    return;
  }
  await ensurePostgresDb();
  await getPgPool().query(
    "update app_state set data = $1::jsonb, updated_at = now() where id = $2",
    [JSON.stringify(db), "main"]
  );
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
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

function visibleDebtsForUser(db, user) {
  const debts = db.debts || [];
  if (user.role === "boss") return debts;
  return debts.filter((debt) => debt.person === user.id);
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

function defaultHourlyRateForUser(db, userId) {
  return nonnegativeNumber(
    db.users?.[userId]?.billing?.hourlyRate,
    nonnegativeNumber(db.settings?.billing?.hourlyRate, 15, 10_000),
    10_000
  );
}

function todoForUserRole(user, db, previous, todo) {
  const previousRate = nonnegativeNumber(previous?.billingHourlyRate, null, 10_000);
  const previousKm = nonnegativeNumber(previous?.billingKm, 0, 1_000_000);
  if (todo.status !== "execution") {
    return { ...todo, billingHourlyRate: previousRate, billingKm: previousKm };
  }
  const defaultRate = defaultHourlyRateForUser(db, todo.syncUser || previous?.syncUser || user.id);
  if (user.role !== "boss") {
    return {
      ...todo,
      billingHourlyRate: previousRate ?? defaultRate,
      billingKm: previousKm
    };
  }
  return {
    ...todo,
    billingHourlyRate: nonnegativeNumber(todo.billingHourlyRate, previousRate ?? defaultRate, 10_000),
    billingKm: nonnegativeNumber(todo.billingKm, previousKm, 1_000_000)
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
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

async function getSessionUser(req) {
  const token = sessionTokenFromRequest(req);
  const db = await readDbAsync();
  const session = sessionForToken(db, token);
  if (!session) return null;
  return db.users[session.userId] || null;
}

async function requireUser(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Prijava je potekla. Prijavi se se enkrat." });
    return null;
  }
  return user;
}

function audit(user, action) {
  return {
    action,
    by: user.id,
    byName: user.name,
    at: new Date().toISOString()
  };
}

function cleanEntry(input) {
  const entry = {
    date: String(input.date || ""),
    start: String(input.start || ""),
    end: String(input.end || ""),
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
    start: String(input.start || "").trim(),
    end: String(input.end || "").trim(),
    client: String(input.client || "").trim(),
    clientId: String(input.clientId || "").trim(),
    notes: String(input.notes || "").trim(),
    status: input.status === "billing" ? "execution" : TODO_STATUSES.has(input.status) ? input.status : "open",
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    urgent: ["execution", "billing"].includes(input.status) ? false : Boolean(input.urgent),
    syncUser: cleanUserId(input.syncUser),
    sourceProjectTodoId: String(input.sourceProjectTodoId || "").trim().slice(0, 100),
    done: input.status === "execution",
    billingHourlyRate: nonnegativeNumber(input.billingHourlyRate, null, 10_000),
    billingKm: nonnegativeNumber(input.billingKm, null, 1_000_000),
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
    if (!todo.date || todo.done) continue;
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

function googleEventDescription(fields, notes = "") {
  const lines = ["INDUS URE"];
  for (const [label, value] of Object.entries(fields)) {
    lines.push(`${label}: ${value ?? ""}`);
  }
  lines.push("Opombe:");
  if (notes) lines.push(String(notes).trim());
  return lines.join("\n");
}

function todoStatusDefinition(status) {
  return TODO_STATUS_DEFINITIONS[status] || TODO_STATUS_DEFINITIONS.open;
}

function todoStatusFromGoogle(value, fallback = "open") {
  const normalized = String(value || "").trim().toLocaleLowerCase("sl");
  const match = Object.entries(TODO_STATUS_DEFINITIONS)
    .find(([, definition]) => definition.label.toLocaleLowerCase("sl") === normalized);
  if (match) return match[0];
  if (normalized === "odprto") return "open";
  if (normalized === "izvedba") return "execution";
  if (normalized === "obračun" || normalized === "obracun") return "execution";
  return TODO_STATUSES.has(fallback) ? fallback : "open";
}

function googleEventPrivateProperties(event) {
  return event?.extendedProperties?.private || {};
}

function googleItemType(item) {
  return Array.isArray(item?.photos) ? "todo" : "entry";
}

function isIndusOwnedGoogleEvent(event, item = null, userId = "", expectedType = "") {
  const privateProps = googleEventPrivateProperties(event);
  const type = expectedType || (item ? googleItemType(item) : "");
  const completeLegacyMarker = Boolean(privateProps.indusId && privateProps.indusType && privateProps.indusUser);
  if (privateProps.indusApp !== INDUS_GOOGLE_APP_ID && !completeLegacyMarker) return false;
  if (!privateProps.indusId || !privateProps.indusType || !privateProps.indusUser) return false;
  if (item && privateProps.indusId !== item.id) return false;
  if (type && privateProps.indusType !== type) return false;
  if (userId && privateProps.indusUser !== userId) return false;
  if (item?.syncUser && privateProps.indusUser !== item.syncUser) return false;
  if (item?.googleEventId && event?.id && item.googleEventId !== event.id) return false;
  return true;
}

function indusGooglePrivateProperties(item, type) {
  return {
    indusApp: INDUS_GOOGLE_APP_ID,
    indusId: item.id,
    indusType: type,
    indusUser: item.syncUser || item.createdBy || ""
  };
}

function parseGoogleEventDescription(value) {
  const lines = String(value || "").replaceAll("\r", "").split("\n");
  const isIndus = lines[0]?.trim() === "INDUS URE";
  if (!isIndus) return { isIndus: false, fields: {}, notes: String(value || "").trim() };
  const fields = {};
  const notes = [];
  let readingNotes = false;
  for (const line of lines.slice(1)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!readingNotes && match && match[1].trim().toLowerCase() === "opombe") {
      readingNotes = true;
      if (match[2]) notes.push(match[2]);
    } else if (readingNotes) {
      notes.push(line);
    } else if (match) {
      fields[match[1].trim().toLowerCase()] = match[2].trim();
    }
  }
  return { isIndus: true, fields, notes: notes.join("\n").trim() };
}

function entrySummary(entry) {
  const title = entry.work || entry.material || "Delo";
  if (entry.status === "errand") return title || "Opravki";
  if (entry.status === "vacation") return title || "Dopust";
  return `${entry.client || "Stranka"} - ${title}`;
}

function clientTaxIdForItem(db, item) {
  const client = (db.clients || []).find((candidate) => candidate.clientId === item.clientId);
  return client?.taxId || "";
}

function entryToGoogleEvent(entry, clientTaxId = "") {
  const event = {
    summary: entrySummary(entry),
    description: googleEventDescription({
      Stranka: entry.client || "",
      Davcna: clientTaxId || (isUsableTaxId(entry.clientId) ? entry.clientId : ""),
      Delo: entry.work || "",
      Material: entry.material || "",
      Sodelavci: entry.people || "",
      Km: Number(entry.km || 0)
    }, entry.notes),
    extendedProperties: { private: indusGooglePrivateProperties(entry, "entry") }
  };
  if (entry.status === "vacation") {
    event.start = { date: entry.date };
    event.end = { date: addDaysDashed(entry.date, 1) };
    return event;
  }
  return {
    ...event,
    start: { dateTime: `${entry.date}T${entry.start}:00`, timeZone: "Europe/Ljubljana" },
    end: { dateTime: `${entry.date}T${entry.end}:00`, timeZone: "Europe/Ljubljana" }
  };
}

function todoToGoogleEvent(todo, clientTaxId = "") {
  const status = todoStatusDefinition(todo.status);
  const event = {
    summary: `${todo.urgent ? "NUJNO: " : ""}TODO: ${todo.title}`,
    description: googleEventDescription({
      Vrsta: "opravilo",
      Stranka: todo.client || "",
      Davcna: clientTaxId || (isUsableTaxId(todo.clientId) ? todo.clientId : ""),
      Status: status.label,
      Nujno: todo.urgent ? "DA" : "NE"
    }, todo.notes),
    colorId: status.googleColorId,
    extendedProperties: { private: indusGooglePrivateProperties(todo, "todo") }
  };
  if (todo.start && todo.end) {
    return {
      ...event,
      start: { dateTime: `${todo.date}T${todo.start}:00`, timeZone: "Europe/Ljubljana" },
      end: { dateTime: `${todo.date}T${todo.end}:00`, timeZone: "Europe/Ljubljana" }
    };
  }
  return { ...event, start: { date: todo.date }, end: { date: addDaysDashed(todo.date, 1) } };
}

function addDaysDashed(date, days) {
  const parsed = new Date(`${date}T00:00:00`);
  parsed.setDate(parsed.getDate() + days);
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0")
  ].join("-");
}

function googleEventChanged(event, item) {
  return Boolean(event.updated && event.updated !== item.googleUpdatedAt);
}

function localItemChanged(item) {
  return Boolean(item.updatedAt && item.updatedAt !== item.googleSyncedLocalAt);
}

function remoteGoogleChangeWins(event, item) {
  if (!localItemChanged(item)) return true;
  const remoteTime = new Date(event.updated || 0).getTime();
  const localTime = new Date(item.updatedAt || 0).getTime();
  return Number.isFinite(remoteTime) && remoteTime >= localTime;
}

async function ensureGoogleCalendar(calendar, user) {
  if (Number(user.google?.scopeVersion || 0) !== GOOGLE_CALENDAR_SCOPE_VERSION) {
    throw new Error("Google dovoljenja je treba ponovno potrditi.");
  }
  const name = `INDUS URE - ${user.name || user.id}`;
  if (user.google?.calendarId) return user.google.calendarId;
  const created = await calendar.calendars.insert({
    requestBody: { summary: name, description: "Namenski koledar aplikacije INDUS URE", timeZone: "Europe/Ljubljana" }
  });
  user.google.calendarId = created.data.id;
  user.google.calendarName = created.data.summary || name;
  user.google.calendarCreatedByApp = true;
  user.google.syncToken = "";
  return user.google.calendarId;
}

function resolveGoogleClient(db, parsed, summary, existing = {}) {
  const clients = db.clients || [];
  const taxId = normalizeTaxId(parsed.fields.davcna || "");
  let client = existing.clientId ? clients.find((item) => item.clientId === existing.clientId) : null;
  client = client || (isUsableTaxId(taxId)
    ? clients.find((item) => normalizeTaxId(item.taxId) === taxId)
    : null);
  const requestedName = String(parsed.fields.stranka || existing.client || "").trim().toLowerCase();
  if (!client && requestedName) {
    client = clients.find((item) => [item.name, item.search].some((value) => String(value || "").trim().toLowerCase() === requestedName));
  }
  if (!client) {
    const normalizedSummary = String(summary || "").trim().toLowerCase();
    client = [...clients]
      .sort((a, b) => String(b.name || "").length - String(a.name || "").length)
      .find((item) => [item.name, item.search].filter(Boolean).some((value) => normalizedSummary.startsWith(`${String(value).trim().toLowerCase()} - `)));
  }
  return client
    ? { client: client.name, clientId: client.clientId || client.taxId || "" }
    : { client: existing.client || parsed.fields.stranka || "", clientId: existing.clientId || "" };
}

function workFromGoogleSummary(summary, client = "") {
  const value = String(summary || "Google dogodek").trim();
  const prefix = `${String(client).trim()} - `;
  return client && value.toLowerCase().startsWith(prefix.toLowerCase()) ? value.slice(prefix.length).trim() : value;
}

function entryFromGoogleEvent(event, user, db = {}, existing = null) {
  const allDay = Boolean(event.start?.date);
  const start = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!allDay && (!start || !end)) return null;
  const date = allDay ? event.start.date : [
    start.getFullYear(),
    String(start.getMonth() + 1).padStart(2, "0"),
    String(start.getDate()).padStart(2, "0")
  ].join("-");
  const time = (value) => `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  const parsed = parseGoogleEventDescription(event.description);
  const clientRef = resolveGoogleClient(db, parsed, event.summary, existing || {});
  const titleChanged = Boolean(existing && String(event.summary || "") !== entrySummary(existing));
  const work = titleChanged || !parsed.isIndus
    ? workFromGoogleSummary(event.summary, clientRef.client)
    : parsed.fields.delo || existing?.work || workFromGoogleSummary(event.summary, clientRef.client);
  const now = new Date().toISOString();
  const hasClient = Boolean(clientRef.clientId);
  return {
    id: existing?.id || crypto.randomUUID(),
    date,
    start: allDay ? existing?.start || "00:00" : time(start),
    end: allDay ? existing?.end || "23:59" : time(end),
    client: hasClient ? clientRef.client : "",
    clientId: hasClient ? clientRef.clientId : "",
    status: allDay ? "vacation" : existing?.status || (hasClient ? "unbilled" : "errand"),
    work,
    material: parsed.isIndus ? parsed.fields.material || "" : existing?.material || "",
    people: parsed.isIndus ? parsed.fields.sodelavci || "" : existing?.people || "",
    km: parsed.isIndus ? Number(parsed.fields.km || 0) : Number(existing?.km || 0),
    materialCost: Number(existing?.materialCost || 0),
    notes: parsed.notes,
    syncUser: user.id,
    sourceTodoId: existing?.sourceTodoId || "",
    googleEventId: event.id || existing?.googleEventId || "",
    googleUpdatedAt: event.updated || "",
    googleSyncedLocalAt: now,
    googleManagedByIndus: true,
    createdBy: existing?.createdBy || user.id,
    createdByName: existing?.createdByName || user.name,
    createdAt: existing?.createdAt || now,
    updatedBy: user.id,
    updatedByName: user.name,
    updatedAt: now,
    history: [...(existing?.history || []), audit(user, existing ? "spremenjeno v Google" : "uvozeno iz Google")]
  };
}

function todoFromGoogleEvent(event, user, db = {}, existing = null) {
  const allDay = Boolean(event.start?.date);
  const startDateTime = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const endDateTime = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!allDay && (!startDateTime || !endDateTime)) return null;
  const date = allDay ? event.start.date : [
    startDateTime.getFullYear(),
    String(startDateTime.getMonth() + 1).padStart(2, "0"),
    String(startDateTime.getDate()).padStart(2, "0")
  ].join("-");
  const time = (value) => `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  const parsed = parseGoogleEventDescription(event.description);
  const clientRef = resolveGoogleClient(db, parsed, event.summary, existing || {});
  const now = new Date().toISOString();
  const status = todoStatusFromGoogle(parsed.fields.status, existing?.status || "open");
  return {
    id: existing?.id || crypto.randomUUID(),
    title: String(event.summary || "Google opravilo").replace(/^NUJNO:\s*/i, "").replace(/^TODO:\s*/i, ""),
    date,
    start: allDay ? "" : time(startDateTime),
    end: allDay ? "" : time(endDateTime),
    client: clientRef.client,
    clientId: clientRef.clientId,
    notes: parsed.notes,
    status,
    order: Number(existing?.order || 0),
    urgent: String(parsed.fields.nujno || "").toUpperCase() === "DA" || /^NUJNO:/i.test(String(event.summary || "")),
    done: status === "execution",
    billingHourlyRate: status === "execution"
      ? nonnegativeNumber(existing?.billingHourlyRate, defaultHourlyRateForUser(db, user.id), 10_000)
      : nonnegativeNumber(existing?.billingHourlyRate, null, 10_000),
    billingKm: nonnegativeNumber(existing?.billingKm, 0, 1_000_000),
    photos: existing?.photos || [],
    syncUser: user.id,
    googleEventId: event.id || existing?.googleEventId || "",
    googleUpdatedAt: event.updated || "",
    googleSyncedLocalAt: now,
    googleManagedByIndus: true,
    googleColorId: String(event.colorId || ""),
    googleStatusLabel: String(parsed.fields.status || ""),
    createdBy: existing?.createdBy || user.id,
    createdByName: existing?.createdByName || user.name,
    createdAt: existing?.createdAt || now,
    updatedBy: user.id,
    updatedByName: user.name,
    updatedAt: now,
    history: [...(existing?.history || []), audit(user, existing ? "spremenjeno v Google" : "uvozeno iz Google")]
  };
}

async function listGoogleEvents(calendar, calendarId) {
  const events = [];
  let pageToken = "";
  do {
    const request = { calendarId, maxResults: 2500, showDeleted: false };
    if (pageToken) request.pageToken = pageToken;
    const response = await calendar.events.list(request);
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || "";
  } while (pageToken);
  return events;
}

function googleEventTimeMatches(actual = {}, expected = {}) {
  if (expected.date) return String(actual.date || "") === String(expected.date);
  if (expected.dateTime) {
    return String(actual.dateTime || "").slice(0, 19) === String(expected.dateTime).slice(0, 19);
  }
  return !actual.date && !actual.dateTime;
}

function googleEventMatchesRequest(event, requestBody) {
  const actualPrivate = googleEventPrivateProperties(event);
  const expectedPrivate = requestBody.extendedProperties?.private || {};
  const colorMatches = !Object.hasOwn(requestBody, "colorId")
    || String(event.colorId || "") === String(requestBody.colorId || "");
  return String(event.summary || "") === String(requestBody.summary || "")
    && String(event.description || "") === String(requestBody.description || "")
    && colorMatches
    && googleEventTimeMatches(event.start, requestBody.start)
    && googleEventTimeMatches(event.end, requestBody.end)
    && Object.entries(expectedPrivate).every(([key, value]) => String(actualPrivate[key] || "") === String(value || ""));
}

function markGoogleItemSynced(item, event, requestBody, expectedType = "") {
  item.googleUpdatedAt = event.updated || item.googleUpdatedAt || new Date().toISOString();
  item.googleSyncedLocalAt = item.updatedAt || item.createdAt || new Date().toISOString();
  item.googleManagedByIndus = true;
  if (expectedType === "todo") {
    item.googleColorId = String(requestBody.colorId || "");
    item.googleStatusLabel = todoStatusDefinition(item.status).label;
  }
}

function resetGoogleItemSync(item) {
  item.googleEventId = "";
  item.googleUpdatedAt = "";
  item.googleSyncedLocalAt = item.updatedAt || "";
  item.googleManagedByIndus = false;
  item.googleColorId = "";
  item.googleStatusLabel = "";
}

async function verifyOwnedGoogleEvent(calendar, calendarId, item, expectedType = "") {
  try {
    const response = await calendar.events.get({ calendarId, eventId: item.googleEventId });
    return {
      event: response.data,
      missing: false,
      owned: isIndusOwnedGoogleEvent(response.data, item, item.syncUser, expectedType)
    };
  } catch (error) {
    if (Number(error.code || error.response?.status) === 404) {
      return { event: null, missing: true, owned: false };
    }
    throw error;
  }
}

async function pushGoogleItem(calendar, calendarId, item, requestBody, expectedType = "") {
  let response;
  if (item.googleEventId) {
    const verification = await verifyOwnedGoogleEvent(calendar, calendarId, item, expectedType);
    if (verification.missing) {
      item.googleEventId = "";
    } else if (!verification.owned) {
      console.warn(`Google dogodek ${item.googleEventId} ni dokazljivo ustvarjen v INDUS URE; sprememba je preskocena.`);
      return false;
    }
  }
  if (item.googleEventId) {
    response = await calendar.events.patch({ calendarId, eventId: item.googleEventId, requestBody, sendUpdates: "none" });
  } else {
    response = await calendar.events.insert({ calendarId, requestBody, sendUpdates: "none" });
    item.googleEventId = response.data.id || "";
  }
  markGoogleItemSynced(item, response.data, requestBody, expectedType);
  return true;
}

async function deleteOwnedGoogleEvent(calendar, calendarId, item, expectedType = "") {
  if (!item?.googleEventId) return false;
  const verification = await verifyOwnedGoogleEvent(calendar, calendarId, item, expectedType);
  if (verification.missing) return true;
  if (!verification.owned) {
    console.warn(`Google dogodek ${item.googleEventId} ni dokazljivo ustvarjen v INDUS URE; brisanje je preskoceno.`);
    return false;
  }
  await calendar.events.delete({ calendarId, eventId: item.googleEventId, sendUpdates: "none" }).catch((error) => {
    if (Number(error.code || error.response?.status) !== 404) throw error;
  });
  return true;
}

async function reconcileGoogleCalendar(calendar, calendarId, db, user) {
  const records = new Map();
  for (const item of db.entries.filter((entry) => entry.syncUser === user.id)) {
    records.set("entry:" + item.id, {
      item,
      type: "entry",
      eligible: Boolean(item.date && item.start && item.end),
      locked: Boolean(activeEntryEditLock(item.id))
    });
  }
  for (const item of db.todos.filter((todo) => todo.syncUser === user.id)) {
    records.set("todo:" + item.id, {
      item,
      type: "todo",
      eligible: Boolean(item.date && !item.done),
      locked: Boolean(activeTodoEditLock(item.id))
    });
  }

  const remoteGroups = new Map();
  const remoteEvents = await listGoogleEvents(calendar, calendarId);
  for (const event of remoteEvents) {
    if (!event?.id || event.status === "cancelled") continue;
    const privateProps = googleEventPrivateProperties(event);
    const type = privateProps.indusType;
    if (!["entry", "todo"].includes(type)) continue;
    if (!isIndusOwnedGoogleEvent(event, null, user.id, type)) continue;
    const key = type + ":" + privateProps.indusId;
    if (!remoteGroups.has(key)) remoteGroups.set(key, []);
    remoteGroups.get(key).push(event);
  }

  let pushed = 0;
  let removed = 0;
  for (const [key, events] of remoteGroups) {
    const record = records.get(key);
    if (record?.locked) continue;
    if (!record || !record.eligible) {
      for (const event of events) {
        const privateProps = googleEventPrivateProperties(event);
        const stub = { id: privateProps.indusId, syncUser: user.id, googleEventId: event.id };
        if (await deleteOwnedGoogleEvent(calendar, calendarId, stub, privateProps.indusType)) removed++;
      }
      if (record) resetGoogleItemSync(record.item);
      continue;
    }

    const preferred = events.find((event) => event.id === record.item.googleEventId) || events[0];
    record.remoteEvent = preferred;
    record.item.googleEventId = preferred.id;
    for (const duplicate of events.filter((event) => event.id !== preferred.id)) {
      const stub = { id: record.item.id, syncUser: user.id, googleEventId: duplicate.id };
      if (await deleteOwnedGoogleEvent(calendar, calendarId, stub, record.type)) removed++;
    }
  }

  for (const record of records.values()) {
    if (record.locked) continue;
    if (!record.eligible) {
      if (!record.remoteEvent) resetGoogleItemSync(record.item);
      continue;
    }
    const requestBody = record.type === "entry"
      ? entryToGoogleEvent(record.item, clientTaxIdForItem(db, record.item))
      : todoToGoogleEvent(record.item, clientTaxIdForItem(db, record.item));
    if (record.remoteEvent && googleEventMatchesRequest(record.remoteEvent, requestBody)) {
      markGoogleItemSynced(record.item, record.remoteEvent, requestBody, record.type);
      continue;
    }
    if (!record.remoteEvent) resetGoogleItemSync(record.item);
    if (await pushGoogleItem(calendar, calendarId, record.item, requestBody, record.type)) pushed++;
  }

  return { pushed, removed, pulled: 0, conflicts: 0 };
}

async function syncGoogleForUser(req, db, user) {
  if (!googleReady()) throw new Error("Google OAuth se ni nastavljen.");
  if (!user.google?.tokens || Number(user.google.scopeVersion || 0) !== GOOGLE_CALENDAR_SCOPE_VERSION) {
    throw new Error("Najprej potrdi omejen dostop do namenskega INDUS koledarja.");
  }
  const { google } = require("googleapis");
  const auth = googleClient(req, user.google.tokens);
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = await ensureGoogleCalendar(calendar, user);
  const result = await reconcileGoogleCalendar(calendar, calendarId, db, user);
  user.google.calendarId = calendarId;
  user.google.syncToken = "";
  user.google.lastSyncAt = new Date().toISOString();
  return { ...result, direction: "app_to_google", calendarName: user.google.calendarName || ("INDUS URE - " + user.name) };
}

async function syncClientsWithSheets(db, user) {
  if (!GOOGLE_SHEETS_ID) throw new Error("GOOGLE_SHEETS_ID ni nastavljen na strezniku.");
  if (!user.google?.tokens) throw new Error("Najprej povezi Google racun.");
  const { google } = require("googleapis");
  const auth = googleClient({ headers: { host: "localhost" } }, user.google.tokens);
  const sheets = google.sheets({ version: "v4", auth });
  const remote = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: GOOGLE_SHEETS_RANGE
  }).catch((error) => {
    throw new Error(`Google Sheets ni mogoce prebrati (${GOOGLE_SHEETS_RANGE}): ${error.message}`);
  });
  const rows = remote.data.values || [];
  const previousClients = db.clients || [];
  const parsed = parseSheetClients(rows, previousClients);
  const syncedIds = new Set(parsed.clients.map((client) => client.clientId));
  const localClients = previousClients
    .map((client) => normalizeStoredClient(client))
    .filter((client) => client.source !== "google-sheets" && !syncedIds.has(client.clientId));
  const nextClients = [...parsed.clients, ...localClients];
  const references = rekeyClientReferences(db, previousClients, nextClients);
  db.clients = nextClients;
  return {
    imported: parsed.total,
    total: parsed.total,
    usable: parsed.usable,
    missingTax: parsed.missingTax,
    duplicateTax: parsed.duplicateTax,
    issues: parsed.issues.slice(0, 100),
    updatedReferences: references.updated,
    unresolvedReferences: references.unresolved.slice(0, 100)
  };
}

async function upsertClientInSheets(client, user) {
  if (!GOOGLE_SHEETS_ID) throw new Error("GOOGLE_SHEETS_ID ni nastavljen na strezniku.");
  if (!user.google?.tokens) throw new Error("Najprej povezi Google racun z dovoljenjem za Google Sheets.");
  const { google } = require("googleapis");
  const auth = googleClient({ headers: { host: "localhost" } }, user.google.tokens);
  const sheets = google.sheets({ version: "v4", auth });
  const remote = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: GOOGLE_SHEETS_RANGE
  });
  const rows = remote.data.values || [];
  const matches = rows.slice(1)
    .map((row, index) => ({ row, rowNumber: index + 2, taxId: normalizeTaxId(row[7]) }))
    .filter((item) => item.taxId === client.taxId);
  if (matches.length > 1) {
    throw new Error(`Davcna ${client.taxId} se v Google Sheetu pojavi veckrat. Najprej odpravi podvojene vrstice.`);
  }
  if (matches.length === 1) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: sheetRowRange(GOOGLE_SHEETS_RANGE, matches[0].rowNumber),
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [clientToSheetRow(client, matches[0].row)] }
    });
    return { action: "updated", row: matches[0].rowNumber };
  }
  const emptyRow = findFirstEmptyClientRow(rows);
  if (emptyRow) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: sheetRowRange(GOOGLE_SHEETS_RANGE, emptyRow),
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [clientToSheetRow(client, rows[emptyRow - 1] || [])] }
    });
    return { action: "created", row: emptyRow };
  }
  const appended = await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: sheetAppendRange(GOOGLE_SHEETS_RANGE),
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [clientToSheetRow(client)] }
  });
  return { action: "created", range: appended.data.updates?.updatedRange || "" };
}

async function deleteGoogleEventForItem(req, db, item) {
  if (!googleReady() || !item?.googleEventId || !item.syncUser) return false;
  const user = db.users[item.syncUser];
  if (!user?.google?.tokens || !user.google.calendarId) return false;
  try {
    const { google } = require("googleapis");
    const auth = googleClient(req, user.google.tokens);
    const calendar = google.calendar({ version: "v3", auth });
    return deleteOwnedGoogleEvent(calendar, user.google.calendarId, item, googleItemType(item));
  } catch (error) {
    console.warn(`Google dogodka ni bilo mogoce izbrisati: ${error.message || error}`);
    return false;
  }
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
  ".woff2": "font/woff2"
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
    res.writeHead(200, securityHeaders({
      "Content-Type": type,
      "Cache-Control": cacheControl,
      "Content-Length": data.length
    }));
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(data);
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

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/health" && req.method === "GET") {
      if (DATABASE_URL) await getPgPool().query("select 1");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/google/status" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, {
        configured: googleReady(),
        connected: Boolean(user.google?.tokens && Number(user.google.scopeVersion || 0) === GOOGLE_CALENDAR_SCOPE_VERSION),
        direction: "app_to_google",
        calendarName: user.google?.calendarName || "",
        lastSyncAt: user.google?.lastSyncAt || "",
        syncIntervalMs: GOOGLE_SYNC_INTERVAL_MS
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

    if (url.pathname === "/api/google/auth-url" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!googleReady()) {
        sendJson(res, 400, { error: "Google OAuth se ni nastavljen na strezniku." });
        return;
      }
      cleanupPendingGoogleStates();
      const state = `connect:${crypto.randomBytes(24).toString("hex")}`;
      pendingGoogleConnections.set(state, { userId: user.id, startedAt: Date.now() });
      const auth = googleClient(req);
      const authUrl = auth.generateAuthUrl({
        access_type: "offline",
        state,
        scope: [
          "https://www.googleapis.com/auth/calendar.app.created",
          "https://www.googleapis.com/auth/spreadsheets"
        ],
        include_granted_scopes: false,
        prompt: "consent"
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
        const html = `<!doctype html>
<html lang="sl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>INDUS URE</title>
</head>
<body>
  <p>Prijava je uspela. Odpiram INDUS URE...</p>
  <script>
    localStorage.setItem("indus-ure-token", ${JSON.stringify(sessionToken)});
    localStorage.setItem("indus-ure-google-email", ${JSON.stringify(email)});
    sessionStorage.removeItem("indus-ure-auto-login-at");
    location.replace("/");
  </script>
</body>
</html>`;
        sendText(res, 200, html, "text/html; charset=utf-8");
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
      const currentScope = Number(user.google.scopeVersion || 0) === GOOGLE_CALENDAR_SCOPE_VERSION;
      const refreshToken = result.tokens.refresh_token || (currentScope ? user.google.tokens?.refresh_token : "");
      if (!refreshToken) {
        sendText(res, 400, "Google ni vrnil trajnega dovoljenja. V Google racunu odstrani dostop INDUS URE in poskusi znova.", "text/plain");
        return;
      }
      user.google.tokens = { ...result.tokens, refresh_token: refreshToken };
      user.google.connectedAt = new Date().toISOString();
      user.google.scopeVersion = GOOGLE_CALENDAR_SCOPE_VERSION;
      if (!currentScope) {
        user.google.calendarId = "";
        user.google.calendarName = "";
        user.google.calendarCreatedByApp = false;
        user.google.syncToken = "";
        user.google.lastSyncAt = "";
      }
      await writeDbAsync(db);
      sendText(res, 200, "Google racun je povezan. Lahko zapres to okno in v INDUS URE kliknes Google sync.", "text/plain");
      return;
    }

    if (url.pathname === "/api/google/sync" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      const current = db.users[user.id];
      const result = await syncGoogleForUser(req, db, current);
      await writeDbAsync(db);
      sendJson(res, 200, { ok: true, ...result, entries: visibleEntriesForUser(db, current), todos: visibleTodosForUser(db, current) });
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
      const db = await readDbAsync();
      if (revokeSession(db, sessionTokenFromRequest(req))) await writeDbAsync(db);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/me") {
      const user = await requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, { user: publicUser(user) });
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
      db.settings.billing = {
        hourlyRate: Number(body.hourlyRate || 15),
        kmRate: Number(body.kmRate || 0.22),
        commuteKmPerDay: Number(body.commuteKmPerDay || 28)
      };
      await writeDbAsync(db);
      sendJson(res, 200, { settings: db.settings });
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
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo sef lahko dodaja ali spreminja stranke." });
        return;
      }
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
      if (!client.taxId) {
        await writeDbAsync(db);
        sendJson(res, 200, { clients: db.clients, sheetWrite: { action: "pending" }, sync: null });
        return;
      }
      const sheetWrite = await upsertClientInSheets(client, current);
      const sync = await syncClientsWithSheets(db, current);
      await writeDbAsync(db);
      sendJson(res, 200, { clients: db.clients, sheetWrite, sync });
      return;
    }

    if (url.pathname === "/api/clients/sync" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Samo sef lahko sinhronizira stranke." });
        return;
      }
      const db = await readDbAsync();
      const current = db.users[user.id];
      const result = await syncClientsWithSheets(db, current);
      await writeDbAsync(db);
      sendJson(res, 200, { clients: db.clients || [], ...result });
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
      const assignmentGroupId = crypto.randomUUID();
      assigneeIds.forEach((assigneeId, index) => {
        const assignee = db.users[assigneeId];
        const assignedTodo = todoForUserRole(user, db, null, { ...todo, syncUser: assigneeId });
        db.todos.push({
          id: crypto.randomUUID(),
          ...assignedTodo,
          assignmentGroupId,
          photos: stampTodoPhotos(todo, user),
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
      setTimeout(queueBackgroundGoogleSync, 0);
      sendJson(res, 200, {
        todos: visibleTodosForUser(db, user),
        assignedTo: assigneeIds.map((id) => publicDirectoryUser(db.users[id]))
      });
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
      const completedTodo = todoForUserRole(user, db, sourceTodo, {
        ...sourceTodo,
        status: "execution",
        done: true
      });
      Object.assign(sourceTodo, completedTodo, {
        billingKm: Number(entry.km || 0),
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: now,
        history: [...(sourceTodo.history || []), audit(user, "zakljuceno z vnosom v koledar")]
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
      await deleteGoogleEventForItem(req, db, entry);
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
      const assignmentItems = todoAssignmentItems(db, previousTodo);
      const editLock = todoAssignmentEditLockConflict(db, previousTodo, user, editLockToken);
      if (editLock) {
        sendJson(res, 409, { error: `Opravilo trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
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
      for (const removedTodo of removedTodos) {
        if (removedTodo.googleEventId && !(await deleteGoogleEventForItem(req, db, removedTodo))) {
          sendJson(res, 502, { error: "Dodelitve ni bilo mogoce varno odstraniti iz starega koledarja." });
          return;
        }
      }

      releaseTodoAssignmentEditLock(db, previousTodo, user, editLockToken);
      const assignmentGroupId = previousTodo.assignmentGroupId || crypto.randomUUID();
      const now = new Date().toISOString();
      const sharedPhotos = stampTodoPhotos(todo, user);
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
      await writeDbAsync(db);
      setTimeout(queueBackgroundGoogleSync, 0);
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
      await deleteGoogleEventForItem(req, db, todo);
      releaseTodoAssignmentEditLock(db, todo, user, editLockToken);
      db.todos = db.todos.filter((item) => item.id !== id);
      pruneUnusedTodoAttachments(db);
      await writeDbAsync(db);
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

async function syncConnectedGoogleCalendars() {
  if (!googleReady()) return;
  const db = await readDbAsync();
  let changed = false;
  for (const user of Object.values(db.users || {})) {
    if (!user.google?.tokens || Number(user.google.scopeVersion || 0) !== GOOGLE_CALENDAR_SCOPE_VERSION) continue;
    try {
      const result = await syncGoogleForUser({ headers: { host: "localhost" } }, db, user);
      changed = true;
      if (result.pushed || result.removed) {
        console.log("Google koledar " + user.id + ": posodobljeno " + result.pushed + ", odstranjeno " + result.removed + ".");
      }
    } catch (error) {
      console.error(`Google koledarja za ${user.id} ni bilo mogoce sinhronizirati: ${error.message || error}`);
    }
  }
  if (changed) await writeDbAsync(db);
}

function queueBackgroundGoogleSync() {
  mutationQueue = mutationQueue
    .then(() => syncConnectedGoogleCalendars())
    .catch((error) => console.error(`Google sync v ozadju ni uspel: ${error.message || error}`));
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

  if (GOOGLE_SHEETS_ID) {
    try {
      const db = await readDbAsync();
      const bojan = db.users?.bojan;
      if (bojan?.google?.tokens) {
        const result = await syncClientsWithSheets(db, bojan);
        await writeDbAsync(db);
        console.log(`Google Sheets stranke: ${result.usable}/${result.total} uporabnih, ${result.updatedReferences} referenc posodobljenih.`);
      } else {
        console.warn("Google Sheets stranke: Bojanov Google racun se ni povezan.");
      }
    } catch (error) {
      console.error(`Google Sheets strank ob zagonu ni bilo mogoce sinhronizirati: ${error.message || error}`);
    }
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
  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  server.listen(PORT, HOST, () => {
    console.log(`INDUS URE lokalno: http://127.0.0.1:${PORT}`);
    for (const url of networkUrls()) console.log(`Na istem omrezju: ${url}`);
    console.log("Uporabnika: bojan in ibro");
  });
  const googleSyncTimer = setInterval(queueBackgroundGoogleSync, GOOGLE_SYNC_INTERVAL_MS);
  googleSyncTimer.unref();
  const initialGoogleSyncTimer = setTimeout(queueBackgroundGoogleSync, 15_000);
  initialGoogleSyncTimer.unref();
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
  GOOGLE_CALENDAR_SCOPE_VERSION,
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
  todoAssignmentItems,
  releaseTodoAssignmentEditLock,
  deleteOwnedGoogleEvent,
  entryEditLockConflict,
  googleEventMatchesRequest,
  isIndusOwnedGoogleEvent,
  pushGoogleItem,
  reconcileGoogleCalendar,
  buildCalendarIcs,
  canManageEntry,
  canManageTodo,
  sourceTodoForNewEntry,
  defaultHourlyRateForUser,
  entryForUserRole,
  createSession,
  entryFromGoogleEvent,
  entryToGoogleEvent,
  googleEventChanged,
  localItemChanged,
  normalizeDb,
  parseGoogleEventDescription,
  releaseEntryEditLock,
  releaseTodoEditLock,
  remoteGoogleChangeWins,
  syncUserForRequest,
  todoAssigneeForUpdate,
  todoAssigneesForRequest,
  revokeSession,
  todoEditLockConflict,
  todoForUserRole,
  sessionForToken,
  sessionTokenHash,
  todoFromGoogleEvent,
  todoToGoogleEvent,
  validTodoAttachmentDataUrl,
  validateTodo,
  visibleDebtsForUser,
  visibleEntriesForUser,
  visibleTodosForUser
};
