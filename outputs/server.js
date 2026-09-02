const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");
const PDFDocument = require("pdfkit");
const archiver = require("archiver");
const { PostgresStore } = require("./postgres-store");
const {
  isUsableTaxId,
  isStableClientId,
  normalizeStoredClient,
  normalizeClientContacts,
  normalizeTaxId,
  normalizeRegistryNumber,
  normalizedText
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
// A deliberately separate, LAN-only browser test instance may use a password
// because Google's OAuth redirect cannot target a private-network IP address.
// This is impossible to enable in production: both NODE_ENV=test and the
// explicit opt-in flag are required.
const LOCAL_TEST_MODE = NODE_ENV === "test" && process.env.INDUS_URE_TEST_MODE === "true";
const TEST_LOCAL_LOGIN_PASSWORD = String(process.env.TEST_LOCAL_LOGIN_PASSWORD || "");
// A support login is deliberately narrower than the test instance: it is
// available only through the local Nginx proxy for the private LAN.  The Node
// process itself is bound to loopback, so a client cannot forge these proxy
// headers by connecting to the application directly.
const LAN_SUPPORT_LOGIN_RUNTIME = NODE_ENV === "production"
  || (NODE_ENV === "test" && process.env.INDUS_URE_LAN_SUPPORT_TEST_MODE === "true");
const LAN_SUPPORT_LOGIN_ENABLED = LAN_SUPPORT_LOGIN_RUNTIME && process.env.LAN_SUPPORT_LOGIN_ENABLED === "true";
const LAN_SUPPORT_LOGIN_PASSWORD = String(process.env.LAN_SUPPORT_LOGIN_PASSWORD || "");
const TEST_LOCAL_NETWORK = String(process.env.TEST_LOCAL_NETWORK || "192.168.50.");
const configuredBojanPassword = process.env.INITIAL_BOJAN_PASSWORD || "";
const configuredIbroPassword = process.env.INITIAL_IBRO_PASSWORD || "";
const initialBojanPassword = configuredBojanPassword || crypto.randomBytes(24).toString("hex");
const initialIbroPassword = configuredIbroPassword || crypto.randomBytes(24).toString("hex");
const resetUserPasswords = process.env.RESET_USER_PASSWORDS === "true";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
// Stable only on this server; never returned to clients. A dedicated env value
// lets an operator rotate the audit source pseudonyms independently if needed.
const AUDIT_LOG_HMAC_KEY = String(process.env.AUDIT_LOG_HMAC_KEY || GOOGLE_CLIENT_SECRET || DATABASE_URL || crypto.randomBytes(32).toString("hex"));
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
// Public PRS records are published by AJPES through OPSI.  The endpoint and
// resource ID are deliberately fixed: this is a bounded server-side lookup,
// not a proxy capable of fetching an arbitrary user-supplied URL.
const OPSI_PRS_RESOURCE_ID = "beb70929-3d0d-41c6-9af2-25d525d906d3";
const OPSI_PRS_SEARCH_URL = "https://podatki.gov.si/api/3/action/datastore_search";
const AJPES_LOOKUP_TIMEOUT_MS = 8_000;
const INDUS_GOOGLE_APP_ID = "indus-ure-v1";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = NODE_ENV === "production" ? "__Host-indus-ure" : "indus-ure-session";
const ALERT_SMTP_URL = String(process.env.ALERT_SMTP_URL || "").trim();
const ALERT_EMAIL_FROM = String(process.env.ALERT_EMAIL_FROM || "").trim();
const ALERT_EMAIL_TO = String(process.env.ALERT_EMAIL_TO || "bojan@indus.si").trim();
const MONITOR_INTERVAL_MS = Math.max(60_000, Number(process.env.MONITOR_INTERVAL_MS || 5 * 60_000));
const OPERATIONAL_MONITOR_ENABLED = process.env.DISABLE_OPERATIONAL_MONITOR !== "true";
const ARCHIVE_RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A normal delete is intentionally reversible. Keeping a short, fixed
// retention period avoids turning the trash into a second long-term archive.
const DELETED_TODO_RETENTION_DAYS = 30;
const DELETED_TODO_RETENTION_MS = DELETED_TODO_RETENTION_DAYS * 24 * 60 * 60 * 1000;
// A small, privacy-conscious activity trail is kept alongside application
// state. It is deliberately not a raw HTTP/request-body log: passwords,
// OAuth/session material and attachment contents must never reach it.
const AUDIT_LOG_RETENTION_DAYS = 30;
const AUDIT_LOG_RETENTION_MS = AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const AUDIT_LOG_MAX_EVENTS = 10_000;
// Undo is intentionally a short, ordered safety net. It keeps business-state
// snapshots only: sessions, OAuth credentials, notifications and attachment
// payloads never enter the journal.
const UNDO_JOURNAL_LIMIT = 20;
const UNDO_JOURNAL_SCHEMA_VERSION = 2;
const UNDO_MAX_PATCH_BYTES = 512 * 1024;
// A per-event version view is intentionally compact and separate from Undo.
// It lets the boss inspect prior form content without retaining file payloads.
const TODO_REVISION_HISTORY_LIMIT = 12;
const TODO_REVISION_TEXT_LIMIT = 12_000;
const UNDO_ARRAY_SNAPSHOT_KEYS = [
  "todos", "entries", "debts", "advances", "personalPurchases",
  "clients", "billingLocks", "payrolls", "clientBills", "settlementCorrections"
];
const UNDO_VALUE_SNAPSHOT_KEYS = ["settings", "calendarToken"];
const MONITOR_MAX_RSS_MB = Math.max(256, Number(process.env.MONITOR_MAX_RSS_MB || 1_800));
const MONITOR_DISK_WARNING_PERCENT = Math.min(99, Math.max(90, Number(process.env.MONITOR_DISK_WARNING_PERCENT || 90)));
const REPORT_PDF_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const REPORT_GMAIL_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const REPORT_GMAIL_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
// A direct browser navigation is more reliable than a fetch-to-Blob download
// on mobile Firefox.  The ticket contains no report data, expires quickly and
// is bound to the session that created it.
const CLIENT_REPORT_DOWNLOAD_TICKET_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENT_REPORT_DOWNLOAD_TICKETS = 200;
const WORKER_DIGEST_RUN_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
// A late time-entry report is kept independently of the ordinary daily
// summary.  A worker may still correct yesterday's entry; the correction is
// never silently lost and Bojan receives the exact before/after record.
const LATE_TIME_ENTRY_REPORT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const LATE_TIME_ENTRY_REPORT_SENDING_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_LATE_TIME_ENTRY_REPORTS = 10_000;
let pgPool = null;
let pgStore = null;
let pgReady = null;
let auditLogStoreReady = null;
let workerDigestStoreReady = null;
let auditLogStoreCleanupAt = 0;
let mutationQueue = Promise.resolve();
let activeUndoCapture = null;
let undoSystemLock = null;
let monitorTimer = null;
let alertTransport = null;
const monitorAlertCooldowns = new Map();
const testLoginFailures = new Map();
const auditLogCooldowns = new Map();
const clientReportDownloadTickets = new Map();
const todoSharePdfDownloadTickets = new Map();
let archiveRetentionCleanupLastAt = 0;
let archiveRetentionCleanupPromise = null;
let lateTimeEntryReportDeliveryScheduled = false;
const execFileAsync = promisify(execFile);

const TODO_STATUS_DEFINITIONS = Object.freeze({
  open: { label: "Čaka", googleColorId: "8" },
  in_progress: { label: "V teku", googleColorId: "9" },
  execution: { label: "Zaklju\u010deno", googleColorId: "10" },
  order: { label: "Naro\u010di-projekt", googleColorId: "11" },
  order_car: { label: "Naroči Avto", googleColorId: "11" },
  order_warehouse: { label: "Naroči Sklad.", googleColorId: "11" },
  add_to_car: { label: "Dodaj v avto", googleColorId: "4" },
  // Keep the legacy ID intact: existing tasks become the distinct "Vrne naj"
  // state without a data migration.
  return_and_bill: { label: "Vrne naj", googleColorId: "4" },
  // A separate, darker orange settlement status. Keeping it in the server
  // registry makes validation and the read-only ICS calendar consistent.
  bill: { label: "Poračunaj", googleColorId: "6" },
  // Do not rename the old ID; only remove its legacy visual prefix.
  return: { label: "Vrni", googleColorId: "3" },
  meal: { label: "Malica", googleColorId: "5" },
  internal: { label: "Razno/Interno", googleColorId: "5" },
  drive: { label: "Vožnja", googleColorId: "7" },
  purchase: { label: "Nabava", googleColorId: "6" },
  note: { label: "Zapisek", googleColorId: "7" },
  material: { label: "Material", googleColorId: "7" }
});
const TODO_STATUSES = new Set(Object.keys(TODO_STATUS_DEFINITIONS));
const TIME_ENTRY_TODO_STATUSES = new Set(["execution", "meal", "drive", "purchase"]);
const ORDER_TODO_STATUSES = new Set(["order", "order_car", "order_warehouse"]);
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
// Server-stored image/video attachments contain only metadata in the task
// record, so a field visit can safely keep a substantial photo set. Keep
// this in sync with the form limit in index.html.
const MAX_TODO_ATTACHMENTS = 40;
const MAX_TODO_THUMBNAIL_DATA_LENGTH = 100_000;
// Video is streamed to the application's private media storage. Keep a finite
// limit so a slow or malicious upload cannot exhaust the server disk.
const MAX_VIDEO_BYTES = Math.min(500 * 1024 * 1024, Math.max(20 * 1024 * 1024, Number(process.env.MAX_VIDEO_BYTES || process.env.MAX_DRIVE_VIDEO_BYTES || 200 * 1024 * 1024)));
// Photos are streamed directly to the server and converted there. This keeps
// HEIC/HEIF usable even where the browser cannot decode it, while the saved
// JPEG remains small enough for the editor and report viewer.
const MAX_TODO_IMAGE_BYTES = Math.min(50 * 1024 * 1024, Math.max(5 * 1024 * 1024, Number(process.env.MAX_TODO_IMAGE_BYTES || 25 * 1024 * 1024)));
const TODO_IMAGE_DISPLAY_MAX_SIDE = 2_560;
const TODO_IMAGE_THUMBNAIL_MAX_SIDE = 420;
const TODO_IMAGE_PROCESS_TIMEOUT_MS = 90_000;
const IMAGE_PROCESSOR = String(process.env.INDUS_IMAGE_PROCESSOR || "vips").trim() || "vips";
const PENDING_ATTACHMENT_TTL_MS = 12 * 60 * 60 * 1000;
const TODO_CREATE_RECEIPT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_TODO_CREATE_RECEIPTS = 10_000;


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
  }).filter(Boolean).slice(0, MAX_TODO_ATTACHMENTS);
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
      const originalData = String(attachment.data || "");
      const hasOriginal = Boolean(attachment.storageKey || originalData);
      const hasThumbnail = Boolean(attachment.thumbnailKey || attachment.thumbnailData);
      const dataMimeType = (originalData.match(/^data:([^;,]+)[;,]/i) || [])[1] || "";
      return {
        ...photo,
        // The bootstrap response intentionally contains metadata only. Media is
        // fetched from the protected attachment route after the user explicitly
        // opens it, so opening a task or report never downloads all its files.
        data: "",
        thumbnailData: "",
        url: hasOriginal ? attachmentApiUrl(photo.attachmentId) : "",
        thumbnailUrl: hasThumbnail ? attachmentApiUrl(photo.attachmentId, true) : "",
        mimeType: String(attachment.mimeType || photo.mimeType || dataMimeType || "")
      };
    }).filter((photo) => Boolean(photo.url))
  };
}

function undoClone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function undoAttachmentMetadata(attachment = {}) {
  const copy = { ...(attachment || {}) };
  // Files stay in protected media storage. History contains only metadata and
  // never a second copy of the original or thumbnail.
  delete copy.data;
  delete copy.thumbnailData;
  return copy;
}

function undoBusinessSnapshot(db = {}) {
  const snapshot = {};
  for (const key of UNDO_ARRAY_SNAPSHOT_KEYS) snapshot[key] = undoClone(db[key] || []);
  snapshot.attachments = Object.fromEntries(Object.entries(db.attachments || {}).map(([id, attachment]) => [id, undoAttachmentMetadata(attachment)]));
  for (const key of UNDO_VALUE_SNAPSHOT_KEYS) snapshot[key] = undoClone(db[key]);
  return snapshot;
}

function undoItemId(key, item) {
  if (!item || typeof item !== "object") return "";
  if (key === "clients") return String(item.clientId || item.id || "").trim();
  if (key === "billingLocks") return String(item.id || (item.workerId && item.month ? item.workerId + ":" + item.month : "")).trim();
  return String(item.id || "").trim();
}

function undoArrayPatch(key, before = [], after = []) {
  const oldItems = Array.isArray(before) ? before : [];
  const newItems = Array.isArray(after) ? after : [];
  if ([...oldItems, ...newItems].some((item) => item && !undoItemId(key, item))) {
    return JSON.stringify(oldItems) === JSON.stringify(newItems) ? null : { replace: undoClone(oldItems) };
  }
  const oldById = new Map(oldItems.map((item) => [undoItemId(key, item), item]));
  const newById = new Map(newItems.map((item) => [undoItemId(key, item), item]));
  const changes = [];
  for (const id of new Set([...oldById.keys(), ...newById.keys()])) {
    const previous = oldById.get(id);
    const next = newById.get(id);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      changes.push({ id, before: previous === undefined ? null : undoClone(previous) });
    }
  }
  const oldOrder = oldItems.map((item) => undoItemId(key, item));
  const newOrder = newItems.map((item) => undoItemId(key, item));
  const order = JSON.stringify(oldOrder) === JSON.stringify(newOrder) ? null : oldOrder;
  // PostgreSQL does not guarantee the incidental order in which unrelated
  // rows are read.  That order is not a business change and must never use
  // up the single undo slot before the actual mutation is written.
  if (!changes.length) return null;
  return { changes, ...(order ? { order } : {}) };
}

function undoAttachmentPatch(before = {}, after = {}) {
  const oldItems = before && typeof before === "object" ? before : {};
  const newItems = after && typeof after === "object" ? after : {};
  const changes = [];
  for (const id of new Set([...Object.keys(oldItems), ...Object.keys(newItems)])) {
    const previous = oldItems[id];
    const next = newItems[id];
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      changes.push({ id, before: previous === undefined ? null : undoAttachmentMetadata(previous) });
    }
  }
  return changes.length ? { changes } : null;
}

function normalizeUndoArrayPatch(key, raw) {
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw.replace)) return { replace: undoClone(raw.replace) };
  const changes = (Array.isArray(raw.changes) ? raw.changes : [])
    .map((change) => ({
      id: undoItemId(key, { id: change?.id, clientId: key === "clients" ? change?.id : "" }),
      before: change && Object.hasOwn(change, "before") ? undoClone(change.before) : null
    }))
    .filter((change) => Boolean(change.id));
  const order = (Array.isArray(raw.order) ? raw.order : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  // Older journals may contain an order-only patch produced by a database
  // read.  It cannot restore any business data, so hide it instead of
  // offering a misleading Undo action.
  return changes.length ? { changes, ...(order.length ? { order } : {}) } : null;
}

function normalizeUndoAttachmentPatch(raw) {
  const changes = (Array.isArray(raw?.changes) ? raw.changes : [])
    .map((change) => ({
      id: validTodoAttachmentId(change?.id) ? String(change.id) : "",
      before: change && Object.hasOwn(change, "before") && change.before && typeof change.before === "object"
        ? undoAttachmentMetadata(change.before)
        : null
    }))
    .filter((change) => Boolean(change.id));
  return changes.length ? { changes } : null;
}

function normalizeUndoPatch(raw) {
  if (!raw || typeof raw !== "object" || Number(raw.version || 0) !== UNDO_JOURNAL_SCHEMA_VERSION) return null;
  const arrays = {};
  for (const key of UNDO_ARRAY_SNAPSHOT_KEYS) {
    const patch = normalizeUndoArrayPatch(key, raw.arrays?.[key]);
    if (patch) arrays[key] = patch;
  }
  const attachments = normalizeUndoAttachmentPatch(raw.attachments);
  const values = {};
  for (const key of UNDO_VALUE_SNAPSHOT_KEYS) {
    if (raw.values && Object.hasOwn(raw.values, key)) values[key] = undoClone(raw.values[key]);
  }
  if (!Object.keys(arrays).length && !attachments && !Object.keys(values).length) return null;
  const patch = {
    version: UNDO_JOURNAL_SCHEMA_VERSION,
    ...(Object.keys(arrays).length ? { arrays } : {}),
    ...(attachments ? { attachments } : {}),
    ...(Object.keys(values).length ? { values } : {})
  };
  return Buffer.byteLength(JSON.stringify(patch), "utf8") <= UNDO_MAX_PATCH_BYTES ? patch : null;
}

function undoPatchFromSnapshots(beforeState = {}, afterState = {}) {
  const arrays = {};
  for (const key of UNDO_ARRAY_SNAPSHOT_KEYS) {
    const patch = undoArrayPatch(key, beforeState[key], afterState[key]);
    if (patch) arrays[key] = patch;
  }
  const attachments = undoAttachmentPatch(beforeState.attachments, afterState.attachments);
  const values = {};
  for (const key of UNDO_VALUE_SNAPSHOT_KEYS) {
    if (JSON.stringify(beforeState[key]) !== JSON.stringify(afterState[key])) values[key] = undoClone(beforeState[key]);
  }
  return normalizeUndoPatch({
    version: UNDO_JOURNAL_SCHEMA_VERSION,
    arrays,
    attachments,
    values
  });
}

function normalizeUndoJournal(raw) {
  const values = Array.isArray(raw) ? raw : [];
  return values
    // Version 1 stored whole database copies. They are intentionally dropped
    // during the migration: retaining them would keep the performance issue.
    .map((record) => ({ record, patch: normalizeUndoPatch(record?.patch) }))
    .filter(({ record, patch }) => record && typeof record === "object" && patch)
    .map(({ record, patch }) => {
      const title = (patch.arrays?.todos?.changes || [])
        .map((change) => String(change?.before?.title || "").trim())
        .find(Boolean) || "";
      const rawAction = cleanAuditLogText(record.action || "Spremenjeni podatki", 220) || "Spremenjeni podatki";
      const action = title && /\u00bbbrez naslova\u00ab/iu.test(rawAction)
        ? rawAction.replace(/\u00bbbrez naslova\u00ab/iu, `\u00bb${title.slice(0, 100)}\u00ab`)
        : rawAction;
      return {
        id: /^[a-f0-9-]{16,80}$/i.test(String(record.id || "")) ? String(record.id) : crypto.randomUUID(),
        createdAt: Number.isFinite(Date.parse(record.createdAt)) ? String(record.createdAt) : new Date().toISOString(),
        actorId: cleanUserId(record.actorId) || "system",
        actorName: cleanAuditActorName(record.actorName, "Sistem"),
        action,
        route: cleanAuditLogText(record.route || "", 180),
        patch,
        undoneAt: Number.isFinite(Date.parse(record.undoneAt)) ? String(record.undoneAt) : "",
        undoneBy: cleanUserId(record.undoneBy),
        undoneByName: cleanAuditActorName(record.undoneByName, ""),
        undoAction: cleanAuditLogText(record.undoAction || "", 220)
      };
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, UNDO_JOURNAL_LIMIT);
}

function undoProtectedAttachmentIds(db = {}) {
  const protectedIds = new Set();
  const includePatch = (patch) => {
    for (const change of patch?.attachments?.changes || []) {
      if (change?.before && validTodoAttachmentId(change.id)) protectedIds.add(change.id);
    }
  };
  for (const record of normalizeUndoJournal(db.undoJournal)) includePatch(record.patch);
  for (const attachmentId of Object.keys(activeUndoCapture?.beforeState?.attachments || {})) {
    if (validTodoAttachmentId(attachmentId)) protectedIds.add(attachmentId);
  }
  return protectedIds;
}

function undoChangedItem(before = [], after = [], idKey = "id") {
  const oldItems = new Map((Array.isArray(before) ? before : []).map((item) => [String(item?.[idKey] || item?.id || ""), item]));
  const newItems = new Map((Array.isArray(after) ? after : []).map((item) => [String(item?.[idKey] || item?.id || ""), item]));
  for (const [id, item] of newItems) {
    if (!id) continue;
    if (!oldItems.has(id) || JSON.stringify(oldItems.get(id)) !== JSON.stringify(item)) return item;
  }
  for (const [id, item] of oldItems) {
    if (id && !newItems.has(id)) return item;
  }
  return null;
}

function undoActionLabel({ req, actor, beforeState, afterState }) {
  const pathname = new URL(req.url, "http://undo.local").pathname;
  const method = String(req.method || "").toUpperCase();
  const prefix = cleanAuditActorName(actor?.name, "Uporabnik") + " je";
  const todo = undoChangedItem(beforeState.todos, afterState.todos);
  const client = undoChangedItem(beforeState.clients, afterState.clients, "clientId");
  const clientBill = undoChangedItem(beforeState.clientBills, afterState.clientBills);
  const payroll = undoChangedItem(beforeState.payrolls, afterState.payrolls);
  const debt = undoChangedItem(beforeState.debts, afterState.debts);
  if (pathname.startsWith("/api/todos")) {
    const title = cleanAuditLogText(todo?.title || "brez naslova", 100);
    if (method === "POST" && pathname === "/api/todos") return prefix + " ustvaril dogodek \u00bb" + title + "\u00ab";
    if (method === "DELETE") return prefix + " izbrisal dogodek \u00bb" + title + "\u00ab";
    if (pathname.endsWith("/reorder")) return prefix + " prerazvrstil opravila";
    if (pathname.endsWith("/bulk-client")) return prefix + " paketno zamenjal stranko pri izbranih dogodkih";
    return prefix + " spremenil dogodek \u00bb" + title + "\u00ab";
  }
  if (pathname.startsWith("/api/clients")) {
    const name = cleanAuditLogText(client?.alias || client?.name || "stranko", 100);
    return method === "POST" && pathname === "/api/clients"
      ? prefix + " dodal stranko \u00bb" + name + "\u00ab"
      : method === "DELETE" ? prefix + " izbrisal stranko \u00bb" + name + "\u00ab" : prefix + " uredil stranko \u00bb" + name + "\u00ab";
  }
  if (pathname.startsWith("/api/client-bills")) {
    const name = cleanAuditLogText(clientBill?.clientName || clientBill?.client || "stranko", 100);
    return method === "POST" ? prefix + " potrdil obra\u010dun za stranko \u00bb" + name + "\u00ab" : prefix + " spremenil obra\u010dun stranke \u00bb" + name + "\u00ab";
  }
  if (pathname.startsWith("/api/payrolls")) {
    const workerName = cleanAuditLogText(payroll?.workerName || payroll?.personName || payroll?.workerId || "delavca", 100);
    return prefix + " spremenil obra\u010dun ur za " + workerName;
  }
  if (pathname.startsWith("/api/advances")) return prefix + " spremenil zalo\u017eena sredstva" + (debt?.reason ? ": " + cleanAuditLogText(debt.reason, 90) : "");
  if (pathname.startsWith("/api/personal-purchases")) return prefix + " spremenil osebni nakup" + (debt?.reason ? ": " + cleanAuditLogText(debt.reason, 90) : "");
  if (pathname.startsWith("/api/settings")) return prefix + " spremenil nastavitve obra\u010dunavanja";
  return prefix + " spremenil podatke";
}

function undoEligibleRequest(req) {
  if (!isUnsafeRequest(req)) return false;
  const pathname = new URL(req.url, "http://undo.local").pathname;
  if (/^\/api\/todos\/(?:video|drive-files|[^/]+\/(?:lock|completion-request|share-pdf-ticket))/.test(pathname)) return false;
  if (/^\/api\/(?:attachments|notifications|auth|google|login|logout|password|profile|billing-locks|undo-journal|backup)\b/.test(pathname)) return false;
  return /^\/api\/(?:todos(?:\/|$)|entries(?:\/|$)|clients(?:\/|$)|client-bills(?:\/|$)|payrolls(?:\/|$)|advances(?:\/|$)|personal-purchases(?:\/|$)|debts(?:\/|$)|settings\/billing$)/.test(pathname);
}

function appendUndoJournalForMutation(db) {
  const capture = activeUndoCapture;
  if (!capture || capture.recorded || !capture.actor) return false;
  const afterState = undoBusinessSnapshot(db);
  const patch = undoPatchFromSnapshots(capture.beforeState, afterState);
  if (!patch) return false;
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    actorId: cleanUserId(capture.actor.id) || "system",
    actorName: cleanAuditActorName(capture.actor.name, "Sistem"),
    action: undoActionLabel({ req: capture.req, actor: capture.actor, beforeState: capture.beforeState, afterState }),
    route: new URL(capture.req.url, "http://undo.local").pathname,
    patch,
    undoneAt: "",
    undoneBy: "",
    undoneByName: "",
    undoAction: ""
  };
  db.undoJournal = normalizeUndoJournal([record, ...(db.undoJournal || [])]);
  capture.recorded = true;
  return true;
}

function currentUndoRecord(db = {}) {
  return normalizeUndoJournal(db.undoJournal).find((record) => !record.undoneAt) || null;
}

function restoreUndoArrayPatch(db, key, patch) {
  if (Array.isArray(patch?.replace)) {
    db[key] = undoClone(patch.replace);
    return;
  }
  const current = Array.isArray(db[key]) ? db[key] : [];
  const items = new Map(current.map((item) => [undoItemId(key, item), item]).filter(([id]) => id));
  for (const change of patch?.changes || []) {
    if (change.before === null) items.delete(change.id);
    else items.set(change.id, undoClone(change.before));
  }
  const restored = [];
  const used = new Set();
  for (const id of patch?.order || []) {
    const item = items.get(id);
    if (item) {
      restored.push(item);
      used.add(id);
    }
  }
  for (const item of current) {
    const id = undoItemId(key, item);
    if (id && !used.has(id) && items.has(id)) {
      restored.push(items.get(id));
      used.add(id);
    }
  }
  for (const [id, item] of items) {
    if (!used.has(id)) restored.push(item);
  }
  db[key] = restored;
}

function restoreUndoPatch(db, patch) {
  const normalized = normalizeUndoPatch(patch);
  if (!normalized) throw new Error("Zgodovina za to dejanje ni več veljavna.");
  for (const key of UNDO_ARRAY_SNAPSHOT_KEYS) {
    if (normalized.arrays?.[key]) restoreUndoArrayPatch(db, key, normalized.arrays[key]);
  }
  if (normalized.attachments) {
    const attachments = { ...(db.attachments || {}) };
    for (const change of normalized.attachments.changes || []) {
      if (change.before === null) delete attachments[change.id];
      else attachments[change.id] = { ...(attachments[change.id] || {}), ...undoAttachmentMetadata(change.before), id: change.id };
    }
    db.attachments = attachments;
  }
  for (const key of UNDO_VALUE_SNAPSHOT_KEYS) {
    if (normalized.values && Object.hasOwn(normalized.values, key)) db[key] = undoClone(normalized.values[key]);
  }
}

function visibleUndoJournal(db, user) {
  const current = currentUndoRecord(db);
  return normalizeUndoJournal(db.undoJournal).map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    actorId: record.actorId,
    actorName: record.actorName,
    action: record.action,
    undoneAt: record.undoneAt,
    undoneBy: record.undoneBy,
    undoneByName: record.undoneByName,
    undoAction: record.undoAction,
    canUndo: !record.undoneAt && record.id === current?.id
      && (user?.role === "boss" || String(record.actorId) === String(user?.id))
  }));
}


function pruneUnusedTodoAttachments(db) {
  const pending = new Set(Object.keys(pendingAttachmentMap(db)));
  const used = new Set([
    ...(db.todos || []).flatMap((todo) => (todo.photos || []).map((photo) => photo.attachmentId)),
    ...(db.debts || []).flatMap((debt) => (debt.photos || []).map((photo) => photo.attachmentId)),
    ...undoProtectedAttachmentIds(db)
  ].filter(validTodoAttachmentId));
  let changed = false;
  for (const attachmentId of Object.keys(db.attachments || {})) {
    if (used.has(attachmentId) || pending.has(attachmentId)) continue;
    delete db.attachments[attachmentId];
    changed = true;
  }
  return changed;
}
const CLIENT_REFERENCE_MIGRATIONS = Object.freeze([
  Object.freeze({
    from: "GOSTINSTVO IN TURIZEM ANA KEPIC S.P.",
    to: "tina petrnel sp"
  })
]);

function clientIdentityTexts(client = {}) {
  return [client.clientId, client.id, client.name, client.search, client.taxId, client.registryNumber]
    .map(normalizedText)
    .filter(Boolean);
}

function clientMatchesReference(item, client) {
  if (!item || !client?.clientId) return false;
  const referenceId = String(item.clientId || "").trim();
  // Older rows can still contain a tax number, alias, or imported name in
  // `clientId`. Treat all recorded identities as a match so a client merge
  // cannot delete its source record while leaving legacy references orphaned.
  if (referenceId) return clientIdentityTexts(client).includes(normalizedText(referenceId));
  const referenceText = normalizedText(item.client || item.clientName || "");
  return Boolean(referenceText && clientIdentityTexts(client).includes(referenceText));
}

function migrationClientText(value) {
  // The business name may be stored as `s.p.`, `sp`, or with extra spacing.
  // This normalization is used only by the explicit migration list above.
  return normalizedText(value).replace(/[\s._,\-/]+/g, "");
}

function clientByMigrationText(clients, value) {
  const wanted = migrationClientText(value);
  if (!wanted) return null;
  return (clients || []).find((client) => clientIdentityTexts(client).some((text) => migrationClientText(text) === wanted)) || null;
}

function cleanTodoClientContactIds(value) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source
    .map((id) => String(id || "").trim())
    .filter(isStableClientId))]
    .slice(0, 12);
}

function cleanTodoClientContactSnapshots(value) {
  return (Array.isArray(value) ? value : [])
    .map((contact) => ({
      name: String(contact?.name || contact?.contact || "").trim().replace(/\s+/g, " ").slice(0, 160),
      phone: String(contact?.phone || contact?.number || "").trim().replace(/\s+/g, " ").slice(0, 80)
    }))
    .filter((contact) => contact.phone)
    .slice(0, 12);
}

function contactPhoneKey(value) {
  return String(value || "").replace(/[^0-9+]/g, "");
}

function todoClientContactSelection(client, contactIds, legacyContacts = []) {
  const selectedIds = cleanTodoClientContactIds(contactIds);
  const available = normalizeClientContacts(client?.contacts, client?.phone);
  const byId = new Map(available.map((contact) => [contact.id, contact]));
  const invalidContactIds = selectedIds.filter((id) => !byId.has(id));
  let resolvedIds = selectedIds.filter((id) => byId.has(id));
  let invalidLegacyContacts = 0;
  if (!resolvedIds.length && !selectedIds.length && legacyContacts.length) {
    for (const requested of cleanTodoClientContactSnapshots(legacyContacts)) {
      const phone = contactPhoneKey(requested.phone);
      const match = available.find((contact) => contactPhoneKey(contact.phone) === phone
        && (!requested.name || normalizedText(contact.name) === normalizedText(requested.name)));
      if (!match) {
        invalidLegacyContacts += 1;
        continue;
      }
      if (!resolvedIds.includes(match.id)) resolvedIds.push(match.id);
    }
  }
  return {
    clientContactIds: resolvedIds,
    clientContacts: resolvedIds.map((id) => byId.get(id)).filter(Boolean).map((contact) => ({ id: contact.id, name: contact.name, phone: contact.phone })),
    invalidContactIds,
    invalidLegacyContacts
  };
}

function applyTodoClientContactSelection(db, todo, { strict = false } = {}) {
  const requestedIds = cleanTodoClientContactIds(todo.clientContactIds);
  const legacyContacts = cleanTodoClientContactSnapshots(todo.clientContacts);
  const hasSelection = requestedIds.length || legacyContacts.length;
  const client = (db.clients || []).find((item) => String(item.clientId || item.id || "") === String(todo.clientId || "")) || null;
  if (!client) {
    if (strict && hasSelection) return { error: "Kontakt se lahko izbere samo pri izbrani stranki." };
    return { todo: { ...todo, clientContactIds: [], clientContacts: [] }, error: "" };
  }
  const selection = todoClientContactSelection(client, requestedIds, legacyContacts);
  if (strict && (selection.invalidContactIds.length || selection.invalidLegacyContacts)) {
    return { error: "Izbrani kontakt ne pripada izbrani stranki." };
  }
  return {
    todo: {
      ...todo,
      clientContactIds: selection.clientContactIds,
      clientContacts: selection.clientContacts
    },
    error: ""
  };
}

function clientContactMatchKey(contact = {}) {
  return `${normalizedText(contact.name || contact.contact || "")}\u0000${contactPhoneKey(contact.phone || contact.number || "")}`;
}

function mergeMigratedClientContacts(sourceClient, targetClient) {
  const sourceContacts = normalizeClientContacts(sourceClient?.contacts, sourceClient?.phone);
  const mergedContacts = normalizeClientContacts(targetClient?.contacts, targetClient?.phone).map((contact) => ({ ...contact }));
  const contactIdMap = new Map();
  for (const sourceContact of sourceContacts) {
    const sourcePhone = contactPhoneKey(sourceContact.phone);
    const matching = mergedContacts.find((contact) => contact.id === sourceContact.id)
      || mergedContacts.find((contact) => clientContactMatchKey(contact) === clientContactMatchKey(sourceContact))
      || (sourcePhone ? mergedContacts.find((contact) => contactPhoneKey(contact.phone) === sourcePhone) : null);
    if (matching) {
      contactIdMap.set(sourceContact.id, matching.id);
      continue;
    }
    const id = mergedContacts.some((contact) => contact.id === sourceContact.id) ? crypto.randomUUID() : sourceContact.id;
    mergedContacts.push({ ...sourceContact, id });
    contactIdMap.set(sourceContact.id, id);
  }
  const contacts = normalizeClientContacts(mergedContacts);
  const before = JSON.stringify({ contacts: targetClient.contacts || [], phone: targetClient.phone || "" });
  targetClient.contacts = contacts;
  targetClient.phone = contacts[0]?.phone || "";
  return { contactIdMap, changed: before !== JSON.stringify({ contacts: targetClient.contacts, phone: targetClient.phone }) };
}

function rerouteClientReference(item, fromClient, toClient, contactIdMap = new Map()) {
  if (!clientMatchesReference(item, fromClient)) return false;
  item.clientId = toClient.clientId;
  if (Object.hasOwn(item, "client") || item.client) item.client = toClient.name;
  if (Object.hasOwn(item, "clientName") || item.clientName) item.clientName = toClient.name;
  if (Array.isArray(item.clientContactIds)) {
    item.clientContactIds = cleanTodoClientContactIds(item.clientContactIds.map((id) => contactIdMap.get(String(id)) || id));
  }
  if (Array.isArray(item.clientContacts)) {
    item.clientContacts = item.clientContacts.map((contact) => ({
      ...contact,
      id: contactIdMap.get(String(contact?.id || "")) || contact?.id || ""
    }));
  }
  return true;
}

// Explicit, one-off client merges. They are deliberately idempotent: no record
// is changed until both exact client identities exist, and after the source is
// removed a later boot is a no-op. This lets a release safely repair a restored
// database too, without relying on an SSH-only manual SQL command.
function applyClientReferenceMigrations(db) {
  let changed = false;
  const applied = [];
  for (const migration of CLIENT_REFERENCE_MIGRATIONS) {
    const source = clientByMigrationText(db.clients, migration.from);
    const target = clientByMigrationText(db.clients, migration.to);
    if (!source || !target || source.clientId === target.clientId) continue;
    // Preserve selected people on historical tasks before deleting the source
    // client: contacts either keep their UUID or are mapped to the equivalent
    // target contact by name/phone.
    const contactMerge = mergeMigratedClientContacts(source, target);
    let references = 0;
    for (const item of db.todos || []) if (rerouteClientReference(item, source, target, contactMerge.contactIdMap)) references += 1;
    for (const item of db.entries || []) if (rerouteClientReference(item, source, target, contactMerge.contactIdMap)) references += 1;
    for (const bill of db.clientBills || []) if (rerouteClientReference(bill, source, target, contactMerge.contactIdMap)) references += 1;
    for (const payroll of db.payrolls || []) {
      for (const line of payroll?.lines || []) {
        if (!clientMatchesReference(line, source)) continue;
        line.clientId = target.clientId;
        line.client = target.name;
        references += 1;
      }
    }
    db.clients = (db.clients || []).filter((client) => client.clientId !== source.clientId);
    changed = true;
    applied.push({ fromClientId: source.clientId, toClientId: target.clientId, references, contactsMerged: contactMerge.changed });
  }
  return { changed, applied };
}

function activeClientTodoReferences(db, client) {
  return (db.todos || []).filter((todo) => !todo.archivedAt && clientMatchesReference(todo, client));
}

function activeClientEntryReferences(db, client) {
  // `entries` are legacy calendar records. They have no archive marker, so an
  // open or unbilled record is still a live reference that must not be orphaned.
  return (db.entries || []).filter((entry) => !entry.archivedAt && entry.status !== "billed" && clientMatchesReference(entry, client));
}

function clientDeletionBlocker(db, clientId) {
  const id = String(clientId || "").trim();
  const client = (db.clients || []).find((item) => String(item.clientId || item.id || "") === id) || null;
  if (!client) return { client: null, error: "Stranka ne obstaja.", status: 404, activeTodoIds: [], activeEntryIds: [] };
  const activeTodos = activeClientTodoReferences(db, client);
  const activeEntries = activeClientEntryReferences(db, client);
  if (activeTodos.length || activeEntries.length) {
    return {
      client,
      error: `Stranke ni mogo\u010de izbrisati, dokler ima ${activeTodos.length + activeEntries.length} aktivnih dogodkov.`,
      status: 409,
      activeTodoIds: activeTodos.map((item) => String(item.id || "")).filter(Boolean),
      activeEntryIds: activeEntries.map((item) => String(item.id || "")).filter(Boolean)
    };
  }
  return { client, error: "", status: 200, activeTodoIds: [], activeEntryIds: [] };
}

function deleteClientIfSafe(db, clientId) {
  const blocker = clientDeletionBlocker(db, clientId);
  if (blocker.error) return { ...blocker, deleted: false };
  db.clients = (db.clients || []).filter((client) => client.clientId !== blocker.client.clientId);
  return { ...blocker, deleted: true };
}

function canDeleteClient(user) {
  return user?.role === "boss";
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
    avatar: "",
    active: true,
    employmentType: "contractor",
    timeEntryForIds: ["bojan"]
  },
  ibro: {
    id: "ibro",
    email: "ibrahim.etemaj04@gmail.com",
    name: "Ibro",
    role: "worker",
    passwordHash: hashPassword(initialIbroPassword),
    avatar: "",
    active: true,
    employmentType: "contractor",
    timeEntryForIds: ["ibro"]
  }
};

const pendingGoogleLogins = new Map();
const pendingGoogleConnections = new Map();
const ENTRY_EDIT_LOCK_TTL_MS = 90_000;
const TODO_COMPLETION_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const entryEditLocks = new Map();
const TODO_EDIT_LOCK_TTL_MS = 90_000;
const todoEditLocks = new Map();

function allowedGoogleUsers(db) {
  return Object.values(db.users || {}).filter((user) => user.email && user.active !== false);
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

function localTestRequestAllowed(req) {
  const remoteAddress = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || (TEST_LOCAL_NETWORK === "192.168.50." && remoteAddress.startsWith(TEST_LOCAL_NETWORK));
}

function requestComesFromLoopbackProxy(req) {
  const remoteAddress = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1";
}

function forwardedLanAddress(req) {
  return String(req.headers["x-real-ip"] || "").split(",")[0].trim().replace(/^::ffff:/, "");
}

function lanSupportRequestAllowed(req) {
  const address = forwardedLanAddress(req);
  return requestComesFromLoopbackProxy(req)
    && TEST_LOCAL_NETWORK === "192.168.50."
    && address.startsWith(TEST_LOCAL_NETWORK);
}

function lanSupportLoginEnabled(req) {
  return LAN_SUPPORT_LOGIN_ENABLED
    && LAN_SUPPORT_LOGIN_PASSWORD.length >= 24
    && lanSupportRequestAllowed(req);
}

function localTestLoginEnabled(req) {
  return (LOCAL_TEST_MODE && TEST_LOCAL_LOGIN_PASSWORD.length >= 16 && localTestRequestAllowed(req))
    || lanSupportLoginEnabled(req);
}

function localTestLoginKey(req) {
  return String(req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function localTestLoginRateAllowed(req, now = Date.now()) {
  const key = localTestLoginKey(req);
  const attempts = (testLoginFailures.get(key) || []).filter((at) => now - at < 10 * 60_000);
  testLoginFailures.set(key, attempts);
  return attempts.length < 6;
}

function recordLocalTestLoginFailure(req, now = Date.now()) {
  const key = localTestLoginKey(req);
  const attempts = (testLoginFailures.get(key) || []).filter((at) => now - at < 10 * 60_000);
  attempts.push(now);
  testLoginFailures.set(key, attempts);
}

function clearLocalTestLoginFailures(req) {
  testLoginFailures.delete(localTestLoginKey(req));
}

function validLocalTestPassword(value) {
  const received = Buffer.from(String(value || ""));
  const expected = Buffer.from(TEST_LOCAL_LOGIN_PASSWORD);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function validLanSupportPassword(value) {
  const received = Buffer.from(String(value || ""));
  const expected = Buffer.from(LAN_SUPPORT_LOGIN_PASSWORD);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function validLocalLoginPassword(req, value) {
  return lanSupportLoginEnabled(req) ? validLanSupportPassword(value) : validLocalTestPassword(value);
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
const AUDIT_LOG_PRIVATE_KEY = /(?:password|passwd|token|secret|cookie|authorization|credential|csrf|email|e-mail|dataurl|base64|^bytes$|^content$|^body$|^raw$|^binary$)/i;

function cleanAuditLogText(value, max = 180) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function auditLogTextLooksSensitive(value) {
  const text = String(value || "");
  return /@|^data:[^,]+;base64,|(?:bearer\s+|eyJ[a-zA-Z0-9_-]{8,}\.)|\b(?:password|passwd|token|secret|cookie|authorization|credential|csrf)\b/i.test(text);
}

function cleanAuditActorName(value, fallback = "system") {
  const text = cleanAuditLogText(value, 120);
  return text && !auditLogTextLooksSensitive(text) ? text : fallback;
}

function cleanAuditTargetId(value) {
  const text = cleanAuditLogText(value, 160);
  return auditLogTextLooksSensitive(text) ? "[redacted]" : text;
}

function auditLogKeyIsPrivate(key) {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (AUDIT_LOG_PRIVATE_KEY.test(normalized)) return true;
  if (/(attachment|photo|file|image|video).*(data|content|bytes|base64|binary|body)/.test(normalized)) return true;
  return /^(access|refresh|id)?token$/.test(normalized);
}

function sanitizeAuditLogValue(value, key = "", depth = 0) {
  if (auditLogKeyIsPrivate(key)) return "[redacted]";
  if (depth > 3) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = cleanAuditLogText(value, 360);
    if (auditLogTextLooksSensitive(text)) return "[redacted]";
    return text;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditLogValue(item, key, depth + 1));
  if (typeof value === "object") {
    const safe = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 30)) {
      safe[cleanAuditLogText(childKey, 80) || "field"] = sanitizeAuditLogValue(childValue, childKey, depth + 1);
    }
    return safe;
  }
  return cleanAuditLogText(value, 180);
}

function auditLogTimestamp(value, fallback = 0) {
  const direct = value instanceof Date ? value.getTime() : (typeof value === "number" ? value : NaN);
  if (Number.isFinite(direct)) return direct;
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function auditLogSeverity(value) {
  const severity = String(value || "info").toLowerCase();
  if (["info", "warning", "error", "security"].includes(severity)) return severity;
  return severity === "critical" ? "error" : "info";
}

function normalizedAuditLogEvent(raw, users = {}, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const timestamp = auditLogTimestamp(raw.createdAt || raw.occurredAt || raw.at, 0);
  if (!timestamp || timestamp < now - AUDIT_LOG_RETENTION_MS || timestamp > now + 5 * 60_000) return null;
  const actor = raw.actor && typeof raw.actor === "object" ? raw.actor : {};
  const actorId = cleanAuditLogText(raw.actorId || actor.id || raw.by || "system", 120) || "system";
  const actorName = cleanAuditActorName(raw.actorName || actor.name || raw.byName || users?.[actorId]?.name || actorId, actorId);
  const action = cleanAuditLogText(raw.action || raw.title || "unknown", 160) || "unknown";
  const targetType = cleanAuditLogText(raw.targetType || raw.context?.targetType || "", 80);
  const targetId = cleanAuditTargetId(raw.targetId || raw.context?.targetId || "");
  const sourceContext = raw.context !== undefined ? raw.context : (raw.details !== undefined ? raw.details : {});
  const context = sanitizeAuditLogValue(sourceContext, "context") || {};
  return {
    id: /^[a-zA-Z0-9_-]{8,128}$/.test(String(raw.id || "")) ? String(raw.id) : crypto.randomUUID(),
    createdAt: new Date(timestamp).toISOString(),
    occurredAt: new Date(timestamp).toISOString(),
    actorId,
    actorName,
    actor: { id: actorId, name: actorName },
    action,
    targetType,
    targetId,
    severity: auditLogSeverity(raw.severity),
    context: typeof context === "object" && !Array.isArray(context) ? context : { value: context }
  };
}

function purgeExpiredAuditLog(db, now = Date.now()) {
  if (!db || typeof db !== "object" || !Array.isArray(db.auditLog)) return 0;
  const current = Number(now instanceof Date ? now.getTime() : now);
  const cutoff = (Number.isFinite(current) ? current : Date.now()) - AUDIT_LOG_RETENTION_MS;
  const before = db.auditLog.length;
  db.auditLog = db.auditLog.filter((event) => auditLogTimestamp(event?.createdAt || event?.occurredAt || event?.at, 0) >= cutoff);
  return before - db.auditLog.length;
}

function normalizeAuditLog(raw, users = {}, now = Date.now()) {
  const values = Array.isArray(raw) ? raw : [];
  const normalized = values
    .map((event) => normalizedAuditLogEvent(event, users, now))
    .filter(Boolean)
    .sort((left, right) => auditLogTimestamp(right.createdAt) - auditLogTimestamp(left.createdAt))
    .slice(0, AUDIT_LOG_MAX_EVENTS);
  return normalized;
}

function buildAuditLogEvent({ actor = null, action = "", targetType = "", targetId = "", details, context, severity = "info", occurredAt } = {}, users = {}) {
  const actorId = cleanAuditLogText(actor?.id || actor?.actorId || "system", 120) || "system";
  const actorName = cleanAuditActorName(actor?.name || actor?.actorName || users?.[actorId]?.name || actorId, actorId);
  const createdAt = new Date(auditLogTimestamp(occurredAt, Date.now())).toISOString();
  return normalizedAuditLogEvent({
    id: crypto.randomUUID(),
    createdAt,
    actorId,
    actorName,
    action,
    targetType,
    targetId,
    severity,
    context: context !== undefined ? context : details
  }, users, Date.now());
}

function recordAuditLog(db, input = {}) {
  if (!db || typeof db !== "object") return null;
  if (!Array.isArray(db.auditLog)) db.auditLog = [];
  purgeExpiredAuditLog(db);
  const event = buildAuditLogEvent(input, db.users || {});
  if (!event) return null;
  db.auditLog.unshift(event);
  if (db.auditLog.length > AUDIT_LOG_MAX_EVENTS) db.auditLog.length = AUDIT_LOG_MAX_EVENTS;
  return JSON.parse(JSON.stringify(event));
}

function auditLogRelatedUserIds(event) {
  const related = new Set([String(event?.actorId || "")]);
  const context = event?.context && typeof event.context === "object" ? event.context : {};
  for (const key of ["userId", "workerId", "assigneeId", "createdBy", "updatedBy", "person"]) {
    if (context[key]) related.add(String(context[key]));
  }
  for (const key of ["assigneeIds", "userIds", "workerIds"]) {
    for (const id of Array.isArray(context[key]) ? context[key] : []) related.add(String(id));
  }
  return related;
}

function visibleAuditLogForUser(db, user) {
  if (!user) return [];
  const events = Array.isArray(db?.auditLog) ? db.auditLog : [];
  const actorId = String(user.id || "");
  return events
    .filter((event) => user.role === "boss" || auditLogRelatedUserIds(event).has(actorId))
    .sort((left, right) => auditLogTimestamp(right.createdAt) - auditLogTimestamp(left.createdAt))
    .map((event) => JSON.parse(JSON.stringify(event)));
}

function auditRequestSource(req) {
  const peer = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  const isLoopback = peer === "127.0.0.1" || peer === "::1";
  // Trust a proxy-supplied address only from the local Nginx hop. X-Real-IP is
  // a single value, unlike a user-controlled forwarding chain.
  const proxySource = isLoopback ? String(req?.headers?.["x-real-ip"] || "").trim().replace(/^::ffff:/, "") : "";
  const source = cleanAuditLogText(proxySource || peer || "unknown", 80) || "unknown";
  if (source === "unknown") return source;
  // HMAC keeps the same source correlatable for incident response while making
  // the database value unusable as a raw IP address or a reversible hash.
  return `source-${crypto.createHmac("sha256", AUDIT_LOG_HMAC_KEY).update(source).digest("hex").slice(0, 16)}`;
}

function auditRoute(pathname) {
  return String(pathname || "")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id")
    .replace(/\/[a-f0-9]{32,}/gi, "/:id")
    .replace(/\/(?:[A-Za-z0-9_-]{36,})/g, "/:id")
    .slice(0, 180);
}

function auditTargetFromPath(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  const resources = {
    todos: "todo",
    entries: "entry",
    clients: "client",
    payrolls: "payroll",
    "client-bills": "client_bill",
    attachments: "attachment"
  };
  const index = parts.findIndex((part) => Object.hasOwn(resources, part));
  if (index < 0) return { targetType: "", targetId: "" };
  return {
    targetType: resources[parts[index]],
    targetId: cleanAuditTargetId(parts[index + 1] || "")
  };
}

function shouldAuditApiRequest(req, url, statusCode) {
  const pathname = String(url?.pathname || "");
  const status = Number(statusCode || 0);
  if (pathname === "/api/health" || pathname === "/api/test-mode") return false;
  if (pathname === "/api/audit-log" && status < 400) return false;
  if ([401, 403, 429].includes(status) || status >= 500) return true;
  if (!isUnsafeRequest(req)) return false;
  return !/^\/api\/(?:sync|sync-state|todos\/[^/]+\/lock|entries\/[^/]+\/lock)$/.test(pathname);
}

function scheduleAuditLog(input, { dedupeMs = 0 } = {}) {
  const event = { ...input };
  const fingerprint = `${event.action || ""}|${event.severity || ""}|${event.context?.source || ""}|${event.context?.route || ""}`;
  if (dedupeMs > 0) {
    const last = Number(auditLogCooldowns.get(fingerprint) || 0);
    if (Date.now() - last < dedupeMs) return;
    auditLogCooldowns.set(fingerprint, Date.now());
  }
  if (DATABASE_URL) {
    appendAuditLogToPostgres(event).catch((error) => console.error(`Revizijskega zapisa ni bilo mogoče shraniti: ${error.message || error}`));
    return;
  }
  runSerializedWork(async () => {
    const db = await readDbAsync();
    recordAuditLog(db, event);
    await writeDbAsync(db);
  }).catch((error) => console.error(`Revizijskega zapisa ni bilo mogoče shraniti: ${error.message || error}`));
}

function attachApiAuditTrail(req, res, url) {
  if (req.indusAuditTrailAttached) return;
  req.indusAuditTrailAttached = true;
  res.once("finish", () => {
    const status = Number(res.statusCode || 0);
    if (!shouldAuditApiRequest(req, url, status)) return;
    const target = auditTargetFromPath(url.pathname);
    const denied = [401, 403, 429].includes(status);
    const failed = status >= 500;
    scheduleAuditLog({
      actor: req.indusSessionUser || { id: denied ? "anonymous" : "system", name: denied ? "Neznan uporabnik" : "Sistem" },
      action: denied || failed ? `security.request.${status}` : `api.${String(req.method || "GET").toLowerCase()}`,
      targetType: target.targetType,
      targetId: target.targetId,
      severity: failed ? "error" : (denied ? "security" : "info"),
      context: {
        route: auditRoute(url.pathname),
        method: String(req.method || "GET").toUpperCase(),
        status,
        source: auditRequestSource(req)
      }
    }, { dedupeMs: denied || failed ? 2 * 60_000 : 0 });
  });
}

function workerDigestRunKey(workerId, date) {
  const userId = cleanUserId(workerId);
  const reportDate = isDateKey(date) ? String(date) : "";
  return userId && reportDate ? `${userId}:${reportDate}` : "";
}

function normalizeWorkerDigestRuns(input, now = Date.now()) {
  const oldest = now - WORKER_DIGEST_RUN_RETENTION_MS;
  const seen = new Set();
  return (Array.isArray(input) ? input : [])
    .map((item) => {
      const workerId = cleanUserId(item?.workerId);
      const date = isDateKey(item?.date) ? String(item.date) : "";
      const key = workerDigestRunKey(workerId, date);
      const sentAt = String(item?.sentAt || "");
      const sentAtMs = Date.parse(sentAt);
      const recipientEmail = String(item?.recipientEmail || "").trim().toLowerCase();
      if (!key || !Number.isFinite(sentAtMs) || sentAtMs < oldest || !validEmailAddress(recipientEmail) || seen.has(key)) return null;
      seen.add(key);
      return {
        key,
        workerId,
        date,
        recipientEmail,
        messageId: String(item?.messageId || "").trim().slice(0, 300),
        lineCount: Math.max(0, Math.min(10_000, Math.round(Number(item?.lineCount || 0)))),
        warningCount: Math.max(0, Math.min(10_000, Math.round(Number(item?.warningCount || 0)))),
        sentAt
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(right.sentAt).localeCompare(String(left.sentAt)) || left.key.localeCompare(right.key));
}

function workerDigestRunFor(db, workerId, date) {
  const key = workerDigestRunKey(workerId, date);
  if (!key) return null;
  return (db?.workerDigestRuns || []).find((item) => item?.key === key) || null;
}

function recordWorkerDigestRun(db, report, details = {}) {
  const workerId = cleanUserId(report?.workerId);
  const date = isDateKey(report?.date) ? String(report.date) : "";
  const key = workerDigestRunKey(workerId, date);
  const recipientEmail = String(details.recipientEmail || "").trim().toLowerCase();
  if (!key || !validEmailAddress(recipientEmail)) return null;
  const record = {
    key,
    workerId,
    date,
    recipientEmail,
    messageId: String(details.messageId || "").trim().slice(0, 300),
    lineCount: Math.max(0, Math.round(Number(report?.lines?.length || 0))),
    warningCount: Math.max(0, Math.round(Number(report?.warnings?.length || 0))),
    sentAt: String(details.sentAt || new Date().toISOString())
  };
  db.workerDigestRuns = normalizeWorkerDigestRuns([
    ...(Array.isArray(db.workerDigestRuns) ? db.workerDigestRuns : []).filter((item) => item?.key !== key),
    record
  ]);
  return workerDigestRunFor(db, workerId, date);
}

function cleanLateTimeEntryReportText(value, max = 1_600) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function lateTimeEntryReportAttachments(todo) {
  return [...(Array.isArray(todo?.photos) ? todo.photos : []), ...(Array.isArray(todo?.driveFiles) ? todo.driveFiles : [])]
    .map((item) => cleanLateTimeEntryReportText(item?.name || item?.comment || "priloga", 160))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeLateTimeEntryReportSnapshot(input, users = {}) {
  if (!input || typeof input !== "object") return null;
  const status = String(input.status || "");
  const date = isDateKey(input.date) ? String(input.date) : "";
  if (!TIME_ENTRY_TODO_STATUSES.has(status) || !date) return null;
  const workerId = cleanUserId(input.workerId || input.syncUser);
  const workerName = cleanLateTimeEntryReportText(input.workerName || users?.[workerId]?.name || workerId, 120);
  const attachments = [...new Set((Array.isArray(input.attachments) ? input.attachments : [])
    .map((item) => cleanLateTimeEntryReportText(item, 160))
    .filter(Boolean))].slice(0, 20);
  return {
    todoId: cleanLateTimeEntryReportText(input.todoId || input.id, 120),
    assignmentGroupId: cleanLateTimeEntryReportText(input.assignmentGroupId, 120),
    workerId,
    workerName,
    status,
    statusLabel: cleanLateTimeEntryReportText(input.statusLabel || TODO_STATUS_DEFINITIONS[status]?.label || status, 80),
    title: cleanLateTimeEntryReportText(input.title || "Brez naslova", 300),
    client: cleanLateTimeEntryReportText(input.client || "", 300),
    date,
    endDate: isDateKey(input.endDate) && String(input.endDate) >= date ? String(input.endDate) : date,
    start: /^\d{2}:\d{2}$/.test(String(input.start || "")) ? String(input.start) : "",
    end: /^\d{2}:\d{2}$/.test(String(input.end || "")) ? String(input.end) : "",
    billingHourlyRate: nonnegativeNumber(input.billingHourlyRate, null, 10_000),
    clientBillableMinutes: normalizedClientBillableMinutes(input.clientBillableMinutes),
    billingKm: nonnegativeNumber(input.billingKm, 0, 1_000_000),
    clientKm: nonnegativeNumber(input.clientKm, 0, 1_000_000),
    clientVehicle: todoVehicle(input.clientVehicle),
    workFromHome: Boolean(input.workFromHome),
    warranty: Boolean(input.warranty),
    notes: cleanLateTimeEntryReportText(input.notes, 1_600),
    material: cleanLateTimeEntryReportText(input.material, 1_600),
    attachments
  };
}

function lateTimeEntryReportSnapshot(todo, users = {}) {
  if (!todo || !TIME_ENTRY_TODO_STATUSES.has(String(todo.status || ""))) return null;
  const workerId = cleanUserId(todo.syncUser || todo.createdBy);
  return normalizeLateTimeEntryReportSnapshot({
    id: todo.id,
    assignmentGroupId: todo.assignmentGroupId,
    workerId,
    workerName: todo.syncUserName || users?.[workerId]?.name || todo.createdByName || workerId,
    status: todo.status,
    statusLabel: TODO_STATUS_DEFINITIONS[todo.status]?.label || todo.status,
    title: todo.title,
    client: todo.client,
    date: todo.date,
    endDate: todo.endDate,
    start: todo.start,
    end: todo.end,
    billingHourlyRate: todo.billingHourlyRate,
    clientBillableMinutes: todo.clientBillableMinutes,
    billingKm: todo.billingKm,
    clientKm: todo.clientKm,
    clientVehicle: todo.clientVehicle,
    workFromHome: todo.workFromHome,
    warranty: todo.warranty,
    notes: todo.notes,
    material: todo.material,
    attachments: lateTimeEntryReportAttachments(todo)
  }, users);
}

function normalizeLateTimeEntryReports(input, users = {}, now = Date.now()) {
  const oldest = now - LATE_TIME_ENTRY_REPORT_RETENTION_MS;
  const seen = new Set();
  return (Array.isArray(input) ? input : [])
    .map((item) => {
      const id = String(item?.id || "").trim();
      const createdAt = String(item?.createdAt || "");
      const createdAtMs = Date.parse(createdAt);
      const before = normalizeLateTimeEntryReportSnapshot(item?.before, users);
      const after = normalizeLateTimeEntryReportSnapshot(item?.after, users);
      if (!id || seen.has(id) || !Number.isFinite(createdAtMs) || createdAtMs < oldest || (!before && !after)) return null;
      seen.add(id);
      const status = ["queued", "sending", "sent"].includes(String(item?.status || "")) ? String(item.status) : "queued";
      const sendingAt = String(item?.sendingAt || "");
      const sendingAtMs = Date.parse(sendingAt);
      const staleSending = status === "sending" && (!Number.isFinite(sendingAtMs) || sendingAtMs < now - LATE_TIME_ENTRY_REPORT_SENDING_TIMEOUT_MS);
      const sentAt = String(item?.sentAt || "");
      const normalizedStatus = status === "sent" && Number.isFinite(Date.parse(sentAt)) ? "sent" : (staleSending ? "queued" : status);
      return {
        id,
        status: normalizedStatus,
        kind: cleanLateTimeEntryReportText(item?.kind || "spremenjeno", 80),
        actorId: cleanUserId(item?.actorId),
        actorName: cleanLateTimeEntryReportText(item?.actorName || users?.[cleanUserId(item?.actorId)]?.name || "Neznan uporabnik", 120),
        createdAt,
        sendingAt: normalizedStatus === "sending" ? sendingAt : "",
        sentAt: normalizedStatus === "sent" ? sentAt : "",
        messageId: cleanLateTimeEntryReportText(item?.messageId, 300),
        attempts: Math.max(0, Math.min(100, Math.round(Number(item?.attempts || 0)))),
        lastError: staleSending ? "Pošiljanje je bilo prekinjeno; čaka na ponovni poskus." : cleanLateTimeEntryReportText(item?.lastError, 600),
        before,
        after
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || left.id.localeCompare(right.id))
    .slice(0, MAX_LATE_TIME_ENTRY_REPORTS);
}

function lateTimeEntryMinutes(todo) {
  const parse = (value) => {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const start = parse(todo?.start);
  const end = parse(todo?.end);
  return start === null || end === null || end <= start ? 0 : end - start;
}

function isWorkerEditingContext(user, editorWorkContext) {
  const context = String(editorWorkContext || "").trim();
  if (!/^worker:[a-z0-9_-]+$/i.test(context)) return false;
  // A worker only has their own worker view. The boss may intentionally use
  // any worker view, which is the explicit exception requested for this mail.
  return String(user?.role || "") === "boss" || context === `worker:${cleanUserId(user?.id)}`;
}

// Late-entry e-mails are a safety net for a manager, not an audit stream for
// ordinary edits. A report is meaningful only when a worker increases a past
// time entry; rate, text, mileage, shortening and boss-side corrections stay
// safely recorded in history without generating mail.
function shouldQueueLateTimeEntryReport({ before, after, user, editorWorkContext, now = new Date() } = {}) {
  const actorEmail = String(user?.email || "").trim().toLowerCase();
  // Do not send Bojan a notification about a correction he made himself.
  if (actorEmail && actorEmail === GOOGLE_DRIVE_OWNER_EMAIL) return false;
  if (!before || !after || !isWorkerEditingContext(user, editorWorkContext)) return false;
  const beforeSnapshot = lateTimeEntryReportSnapshot(before);
  const afterSnapshot = lateTimeEntryReportSnapshot(after);
  if (!beforeSnapshot || !afterSnapshot || !isDateKey(afterSnapshot.date)) return false;
  const referenceNow = now instanceof Date ? now : new Date(now);
  if (afterSnapshot.date >= serverDateKey(referenceNow)) return false;
  return lateTimeEntryMinutes(after) > lateTimeEntryMinutes(before);
}

function queueLateTimeEntryReport(db, { before, after, user, kind = "spremenjeno", editorWorkContext = "", now = new Date() } = {}) {
  const beforeSnapshot = lateTimeEntryReportSnapshot(before, db?.users);
  const afterSnapshot = lateTimeEntryReportSnapshot(after, db?.users);
  const relevant = afterSnapshot || beforeSnapshot;
  const referenceNow = now instanceof Date ? now : new Date(now);
  if (!relevant || !shouldQueueLateTimeEntryReport({ before, after, user, editorWorkContext, now: referenceNow })) return null;
  if (JSON.stringify(beforeSnapshot) === JSON.stringify(afterSnapshot)) return null;
  const report = {
    id: crypto.randomUUID(),
    status: "queued",
    kind: cleanLateTimeEntryReportText(kind, 80),
    actorId: cleanUserId(user?.id),
    actorName: cleanLateTimeEntryReportText(user?.name || user?.id || "Neznan uporabnik", 120),
    createdAt: referenceNow.toISOString(),
    sendingAt: "",
    sentAt: "",
    messageId: "",
    attempts: 0,
    lastError: "",
    before: beforeSnapshot,
    after: afterSnapshot
  };
  db.lateTimeEntryReports = normalizeLateTimeEntryReports([
    ...(Array.isArray(db?.lateTimeEntryReports) ? db.lateTimeEntryReports : []),
    report
  ], db?.users, referenceNow.getTime());
  return db.lateTimeEntryReports.find((item) => item.id === report.id) || null;
}

function lateTimeEntryReportSnapshotLines(snapshot) {
  if (!snapshot) return ["Vpis ne obstaja."];
  const dateRange = snapshot.endDate && snapshot.endDate !== snapshot.date
    ? `${reportPdfDate(snapshot.date)} – ${reportPdfDate(snapshot.endDate)}`
    : reportPdfDate(snapshot.date);
  const time = snapshot.start && snapshot.end ? `${snapshot.start}–${snapshot.end}` : "brez ure";
  const vehicle = snapshot.clientVehicle === "van" ? "kombi" : "osebni avto";
  const lines = [
    `Izvajalec: ${snapshot.workerName || snapshot.workerId || "-"}`,
    `Datum in ura: ${dateRange}, ${time}`,
    `Status: ${snapshot.statusLabel}`,
    `Opravilo: ${snapshot.title || "Brez naslova"}`,
    snapshot.client ? `Stranka: ${snapshot.client}` : "",
    `Urna postavka: ${snapshot.billingHourlyRate === null ? "-" : `${snapshot.billingHourlyRate} EUR/h`}`,
    `Kilometrina delavca: ${snapshot.billingKm} km`,
    `Stroški prevoza stranki: ${snapshot.clientKm} km (${vehicle})`,
    snapshot.workFromHome ? "Delo od doma: da" : "",
    snapshot.warranty ? "Garancija: da" : "",
    snapshot.notes ? `Opis del: ${snapshot.notes}` : "",
    snapshot.material ? `Material: ${snapshot.material}` : "",
    snapshot.attachments?.length ? `Priloge: ${snapshot.attachments.join(", ")}` : ""
  ];
  return lines.filter(Boolean);
}

function lateTimeEntryReportText(report) {
  const after = report?.after || report?.before || null;
  return [
    "Pozna sprememba vpisa ur",
    "",
    `Spremenil: ${report?.actorName || report?.actorId || "Neznan uporabnik"}`,
    `Vrsta spremembe: ${report?.kind || "spremenjeno"}`,
    `Zabeleženo: ${new Date(report?.createdAt || Date.now()).toLocaleString("sl-SI", { timeZone: "Europe/Ljubljana" })}`,
    after?.workerName ? `Izvajalec: ${after.workerName}` : "",
    "",
    "PREJ",
    ...lateTimeEntryReportSnapshotLines(report?.before).map((line) => `- ${line}`),
    "",
    "POTEM",
    ...lateTimeEntryReportSnapshotLines(report?.after).map((line) => `- ${line}`)
  ].filter((line, index, lines) => line || index === 0 || lines[index - 1] !== "").join("\n");
}

function gmailLateTimeEntryReportRaw({ to, report }) {
  const recipient = String(to || "").trim().toLowerCase();
  if (!validEmailAddress(recipient)) throw new Error("Poročila o pozni spremembi ni mogoče poslati brez veljavnega Bojanovega e-naslova.");
  const snapshot = report?.after || report?.before || {};
  const subject = `Pozna sprememba vpisa ur - ${snapshot.workerName || "delavec"} - ${reportPdfDate(snapshot.date)}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const messageId = String(report?.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 100);
  const parts = [
    `To: ${recipient}`,
    `Subject: ${encodedSubject}`,
    `Message-ID: <indus-ure-late-${messageId}@ure.indus.si>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(lateTimeEntryReportText(report))
  ];
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

async function deliverQueuedLateTimeEntryReports({ limit = 40 } = {}) {
  const db = await readDbAsync();
  const queued = (db.lateTimeEntryReports || []).filter((report) => report.status === "queued").slice(0, Math.max(1, limit));
  if (!queued.length) return { sent: [], pending: 0 };
  const owner = googleDriveOwner(db);
  const recipient = String(owner?.email || GOOGLE_DRIVE_OWNER_EMAIL || "").trim().toLowerCase();
  if (!validEmailAddress(recipient) || !googleReady() || !googleWorkspaceTokenAvailable(owner)) {
    await recordOperationalAlert({
      code: "late-time-entry-report-google-unavailable",
      severity: "warning",
      title: "Poročila o poznih vpisih ur čakajo",
      message: "Google Dokumenti, preglednice in Gmail niso povezani. Poročila bodo poslana samodejno po ponovni povezavi."
    });
    return { sent: [], pending: queued.length, unavailable: true };
  }
  const { google } = require("googleapis");
  const gmail = google.gmail({ version: "v1", auth: googleClient({ headers: {}, socket: {} }, owner.google.tokens) });
  const sent = [];
  for (const queuedReport of queued) {
    const report = (db.lateTimeEntryReports || []).find((item) => item.id === queuedReport.id);
    if (!report || report.status !== "queued") continue;
    report.status = "sending";
    report.sendingAt = new Date().toISOString();
    report.attempts = Math.max(0, Number(report.attempts || 0)) + 1;
    report.lastError = "";
    await writeDbAsync(db);
    try {
      const message = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: gmailLateTimeEntryReportRaw({ to: recipient, report }) }
      });
      report.status = "sent";
      report.sentAt = new Date().toISOString();
      report.sendingAt = "";
      report.messageId = String(message.data?.id || "").slice(0, 300);
      await writeDbAsync(db);
      sent.push(report.id);
      scheduleAuditLog({
        actor: { id: "system", name: "Sistem" },
        action: "system.late_time_entry_report.sent",
        targetType: "late_time_entry_report",
        targetId: report.id,
        severity: "info",
        context: { workerId: report.after?.workerId || report.before?.workerId || "", date: report.after?.date || report.before?.date || "" }
      });
    } catch (error) {
      report.status = "queued";
      report.sendingAt = "";
      report.lastError = cleanLateTimeEntryReportText(error?.message || error, 600);
      await writeDbAsync(db);
      await recordOperationalAlert({
        code: "late-time-entry-report-failed",
        severity: "warning",
        title: "Poročilo o pozni spremembi ni bilo poslano",
        message: "Sprememba je varno shranjena in bo samodejno znova poslana. " + report.lastError
      });
      break;
    }
  }
  return { sent, pending: (db.lateTimeEntryReports || []).filter((report) => report.status === "queued").length };
}

function scheduleLateTimeEntryReportDelivery() {
  if (lateTimeEntryReportDeliveryScheduled) return;
  lateTimeEntryReportDeliveryScheduled = true;
  runSerializedWork(async () => {
    try {
      await deliverQueuedLateTimeEntryReports();
    } finally {
      lateTimeEntryReportDeliveryScheduled = false;
    }
  }).catch((error) => {
    lateTimeEntryReportDeliveryScheduled = false;
    console.error(`Poročil o poznih spremembah ni bilo mogoče poslati: ${error.message || error}`);
  });
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
    if (normalizeWorkerProfile(id, db.users[id], db.users)) changed = true;
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
    if (normalizeWorkerProfile(id, user, db.users)) changed = true;
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

  const normalizedAuditLog = normalizeAuditLog(db.auditLog, db.users);
  if (!Array.isArray(db.auditLog) || JSON.stringify(db.auditLog) !== JSON.stringify(normalizedAuditLog)) {
    db.auditLog = normalizedAuditLog;
    changed = true;
  }
  const normalizedUndoJournal = normalizeUndoJournal(db.undoJournal);
  if (!Array.isArray(db.undoJournal) || JSON.stringify(db.undoJournal) !== JSON.stringify(normalizedUndoJournal)) {
    db.undoJournal = normalizedUndoJournal;
    changed = true;
  }
  const hasTodoCreateReceipts = db.todoCreateReceipts && typeof db.todoCreateReceipts === "object" && !Array.isArray(db.todoCreateReceipts);
  const normalizedTodoCreateReceipts = normalizeTodoCreateReceipts(db.todoCreateReceipts, db.users);
  if (!hasTodoCreateReceipts || JSON.stringify(db.todoCreateReceipts) !== JSON.stringify(normalizedTodoCreateReceipts)) {
    db.todoCreateReceipts = normalizedTodoCreateReceipts;
    changed = true;
  }
  const hasWorkerDigestRuns = Array.isArray(db.workerDigestRuns);
  const normalizedWorkerDigestRuns = normalizeWorkerDigestRuns(db.workerDigestRuns);
  if (!hasWorkerDigestRuns || JSON.stringify(db.workerDigestRuns) !== JSON.stringify(normalizedWorkerDigestRuns)) {
    db.workerDigestRuns = normalizedWorkerDigestRuns;
    changed = true;
  }
  const hasLateTimeEntryReports = Array.isArray(db.lateTimeEntryReports);
  const normalizedLateTimeEntryReports = normalizeLateTimeEntryReports(db.lateTimeEntryReports, db.users);
  if (!hasLateTimeEntryReports || JSON.stringify(db.lateTimeEntryReports) !== JSON.stringify(normalizedLateTimeEntryReports)) {
    db.lateTimeEntryReports = normalizedLateTimeEntryReports;
    changed = true;
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
  // Immutable corrections preserve confirmed accounts and record only a delta.
  if (!Array.isArray(db.settlementCorrections)) {
    db.settlementCorrections = [];
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
    const commuteKmOneWay = nonnegativeNumber(user.billing?.commuteKmOneWay, 0, 1_000_000);
    if (!user.billing || currentRate === null || user.billing.exportTitle !== exportTitle || user.billing.commuteKmOneWay !== commuteKmOneWay) {
      user.billing = {
        ...(user.billing || {}),
        hourlyRate: currentRate ?? db.settings.billing.hourlyRate,
        exportTitle,
        commuteKmOneWay
      };
      changed = true;
    } else {
      user.billing.hourlyRate = currentRate;
    }
    const dailyReport = workerDailyReportSettings(db, user);
    if (JSON.stringify(user.dailyReport || {}) !== JSON.stringify(dailyReport)) {
      user.dailyReport = dailyReport;
      changed = true;
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
  if (applyClientReferenceMigrations(db).changed) changed = true;

  const clientByText = new Map();
  for (const client of db.clients) {
    [client.clientId, client.name, client.search, client.taxId, client.registryNumber].filter(Boolean).forEach((value) => {
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
    const revisionHistory = normalizeTodoRevisionHistory(next.revisionHistory);
    if (JSON.stringify(next.revisionHistory || []) !== JSON.stringify(revisionHistory)) {
      next.revisionHistory = revisionHistory;
      changed = true;
    }
    const assignmentGroupId = String(next.assignmentGroupId || next.id || crypto.randomUUID()).trim();
    if (next.assignmentGroupId !== assignmentGroupId) {
      next.assignmentGroupId = assignmentGroupId;
      changed = true;
    }
    if (next.status === "ordered") {
      next.status = "order";
      next.ordered = true;
      changed = true;
    } else if (next.status === "billing") {
      next.status = "execution";
      changed = true;
    } else if (!TODO_STATUSES.has(next.status)) {
      next.status = "open";
      changed = true;
    }
    const normalizedDate = isDateKey(next.date) ? String(next.date) : "";
    if (next.date !== normalizedDate) {
      next.date = normalizedDate;
      changed = true;
    }
    const normalizedEndDate = normalizedDate
      ? (isDateKey(next.endDate) && String(next.endDate) >= normalizedDate ? String(next.endDate) : normalizedDate)
      : "";
    if (next.endDate !== normalizedEndDate) {
      next.endDate = normalizedEndDate;
      changed = true;
    }
    const calendarOnly = Boolean(!TIME_ENTRY_TODO_STATUSES.has(next.status) && next.calendarOnly && normalizedDate);
    if (next.calendarOnly !== calendarOnly) {
      next.calendarOnly = calendarOnly;
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
    const completionRequests = cleanTodoCompletionRequests(next.completionRequests);
    if (JSON.stringify(next.completionRequests || []) !== JSON.stringify(completionRequests)) {
      next.completionRequests = completionRequests;
      changed = true;
    }
    const changeNotices = cleanTodoChangeNotices(next.changeNotices, db.users);
    if (JSON.stringify(next.changeNotices || {}) !== JSON.stringify(changeNotices)) {
      next.changeNotices = changeNotices;
      changed = true;
    }
    if (typeof next.urgent !== "boolean") {
      next.urgent = false;
      changed = true;
    }
    const imported = !TIME_ENTRY_TODO_STATUSES.has(next.status) && Boolean(next.imported);
    if (next.imported !== imported) {
      next.imported = imported;
      changed = true;
    }
    // Material is a completed client-billing record without worker hours.
    // It must remain material after any normalisation/read-save cycle.
    if (next.done && !["execution", "material", "note"].includes(next.status)) {
      next.status = "execution";
      changed = true;
    }
    const completed = ["execution", "material", "note"].includes(next.status);
    const hoursNeedsReview = TIME_ENTRY_TODO_STATUSES.has(next.status) && Boolean(next.hoursNeedsReview);
    if (next.hoursNeedsReview !== hoursNeedsReview) {
      next.hoursNeedsReview = hoursNeedsReview;
      changed = true;
    }
    const workFromHome = TIME_ENTRY_TODO_STATUSES.has(next.status) && Boolean(next.workFromHome);
    if (next.workFromHome !== workFromHome) {
      next.workFromHome = workFromHome;
      changed = true;
    }
    const commuteEligible = TIME_ENTRY_TODO_STATUSES.has(next.status) && Boolean(next.commuteEligible);
    if (next.commuteEligible !== commuteEligible) {
      next.commuteEligible = commuteEligible;
      changed = true;
    }
    if (completed && next.urgent) {
      next.urgent = false;
      changed = true;
    }
    if (next.done !== completed) {
      next.done = completed;
      changed = true;
    }
    if (TIME_ENTRY_TODO_STATUSES.has(next.status) && next.calendarOnly) {
      next.calendarOnly = false;
      changed = true;
    }
    const ordered = ORDER_TODO_STATUSES.has(next.status) && Boolean(next.ordered);
    if (next.ordered !== ordered) {
      next.ordered = ordered;
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
    const sourceProjectTodoId = next.status === "execution"
      ? String(next.sourceProjectTodoId || "").trim().slice(0, 100)
      : "";
    if (next.sourceProjectTodoId !== sourceProjectTodoId) {
      next.sourceProjectTodoId = sourceProjectTodoId;
      changed = true;
    }
    const sourceProjectTitle = sourceProjectTodoId
      ? String(next.sourceProjectTitle || "").trim().slice(0, 300)
      : "";
    if (next.sourceProjectTitle !== sourceProjectTitle) {
      next.sourceProjectTitle = sourceProjectTitle;
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
    const clientContactsBefore = JSON.stringify({ ids: next.clientContactIds || [], contacts: next.clientContacts || [] });
    const resolvedContactSelection = applyTodoClientContactSelection(db, next);
    next.clientContactIds = resolvedContactSelection.todo.clientContactIds;
    next.clientContacts = resolvedContactSelection.todo.clientContacts;
    if (JSON.stringify({ ids: next.clientContactIds, contacts: next.clientContacts }) !== clientContactsBefore) changed = true;
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
    const trashedAt = Date.parse(String(next.trashedAt || ""));
    if (!Number.isFinite(trashedAt)) {
      for (const field of ["trashedAt", "trashedBy", "trashedByName"]) {
        if (Object.hasOwn(next, field)) {
          delete next[field];
          changed = true;
        }
      }
    } else {
      next.trashedAt = new Date(trashedAt).toISOString();
      next.trashedBy = cleanUserId(next.trashedBy) || "system";
      next.trashedByName = String(next.trashedByName || db.users?.[next.trashedBy]?.name || next.trashedBy).slice(0, 120);
    }
    const billingHourlyRate = nonnegativeNumber(next.billingHourlyRate, null, 10_000);
    if (next.billingHourlyRate !== billingHourlyRate) {
      next.billingHourlyRate = billingHourlyRate;
      changed = true;
    }
    const clientBillableMinutes = next.status === "execution" ? normalizedClientBillableMinutes(next.clientBillableMinutes) : null;
    if (next.clientBillableMinutes !== clientBillableMinutes) {
      next.clientBillableMinutes = clientBillableMinutes;
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

  // Manual priority used to be stored separately for every user.  Keep those
  // legacy values for rollback, but establish one authoritative rank and
  // bucket per logical task so the boss and all assigned workers see the same
  // relative priority.
  const bossOrderUserId = Object.values(db.users || {}).find((user) => user?.role === "boss")?.id || "";
  const todoGroupsForSharedOrder = new Map();
  for (const todo of db.todos) {
    const groupId = String(todo.assignmentGroupId || todo.id || "");
    if (!groupId) continue;
    const group = todoGroupsForSharedOrder.get(groupId) || [];
    group.push(todo);
    todoGroupsForSharedOrder.set(groupId, group);
  }
  for (const group of todoGroupsForSharedOrder.values()) {
    group.sort((left, right) => String(left.id || "").localeCompare(String(right.id || "")));
    const finite = (values) => values.map(Number).filter(Number.isFinite);
    const existingSharedOrders = finite(group.map((todo) => todo.sharedManualOrder));
    const bossLegacyOrders = bossOrderUserId
      ? finite(group.map((todo) => todo.userOrders?.[bossOrderUserId]))
      : [];
    const fallbackOrders = finite(group.map((todo) => todo.order));
    const sharedOrder = existingSharedOrders.length
      ? Math.min(...existingSharedOrders)
      : bossLegacyOrders.length
        ? Math.min(...bossLegacyOrders)
        : fallbackOrders.length
          ? Math.min(...fallbackOrders)
          : 0;
    const explicitBucket = group.map((todo) => todo.sharedManualBucket).find((bucket) => ["sorted", "unsorted"].includes(bucket));
    const bossLegacyBucket = bossOrderUserId
      ? group.map((todo) => todo.userOrderBuckets?.[bossOrderUserId]).find((bucket) => ["sorted", "unsorted"].includes(bucket))
      : "";
    const anyLegacyUnsorted = group.some((todo) => Object.values(todo.userOrderBuckets || {}).includes("unsorted"));
    const groupDomain = todoManualOrderDomain(group[0]);
    const sharedBucket = groupDomain === "active"
      ? (explicitBucket || bossLegacyBucket || (anyLegacyUnsorted ? "unsorted" : "sorted"))
      : "sorted";
    for (const todo of group) {
      if (todo.sharedManualOrder !== sharedOrder) {
        todo.sharedManualOrder = sharedOrder;
        changed = true;
      }
      if (todo.sharedManualBucket !== sharedBucket) {
        todo.sharedManualBucket = sharedBucket;
        changed = true;
      }
    }
  }
  if (pruneUnusedTodoAttachments(db)) changed = true;

  db.debts = db.debts.map((debt) => {
    const type = ["advance", "personal_purchase", "client_receipt"].includes(debt.type) ? debt.type : "debt";
    const person = cleanUserId(debt.person) || (["advance", "personal_purchase", "client_receipt"].includes(type) ? "" : (["ibro", "bojan"].includes(debt.person) ? debt.person : "ibro"));
    const next = {
      id: debt.id || crypto.randomUUID(),
      type,
      month: /^\d{4}-\d{2}$/.test(String(debt.month || "")) ? String(debt.month) : new Date().toISOString().slice(0, 7),
      date: isDateKey(debt.date) ? String(debt.date) : "",
      // sourceDate retains when the worker collected the money, while date is
      // the period where it is financially credited. For old confirmed
      // payrolls those dates can intentionally differ.
      sourceDate: isDateKey(debt.sourceDate) ? String(debt.sourceDate) : "",
      person,
      amount: Number(debt.amount || 0),
      reason: String(debt.reason || "").trim(),
      projectTodoId: String(debt.projectTodoId || ""),
      clientBillId: String(debt.clientBillId || ""),
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
    fs.writeFileSync(dbFile, JSON.stringify({ users: defaultUsers, sessions: {}, entries: [], todos: [], attachments: {}, debts: [], clients: [], clientBills: [], auditLog: [], undoJournal: [] }, null, 2), "utf8");
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
  // A small VM cannot keep ten full-state PostgreSQL requests in memory.
  // Mutations are already serialized, so three connections cover reads without
  // amplifying memory pressure or row-lock contention.
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: Math.max(1, Math.min(3, Number(process.env.INDUS_URE_PG_POOL_MAX || 3))),
    idleTimeoutMillis: 10_000
  });
  return pgPool;
}

function getPgStore() {
  if (!pgStore) pgStore = new PostgresStore(getPgPool(), MEDIA_DIR);
  return pgStore;
}

async function ensureAuditLogStore() {
  if (!DATABASE_URL) return;
  if (auditLogStoreReady) return auditLogStoreReady;
  auditLogStoreReady = (async () => {
    await getPgPool().query(`
      create table if not exists indus_audit_log (
        id text primary key,
        actor_id text not null default '',
        actor_name text not null default '',
        action text not null default '',
        target_type text not null default '',
        target_id text not null default '',
        severity text not null default 'info',
        context jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists indus_audit_log_created_idx on indus_audit_log (created_at desc);
      create index if not exists indus_audit_log_actor_idx on indus_audit_log (actor_id, created_at desc);
    `);
  })();
  try {
    await auditLogStoreReady;
  } catch (error) {
    auditLogStoreReady = null;
    throw error;
  }
}

async function ensureWorkerDigestRunStore() {
  if (!DATABASE_URL) return;
  if (workerDigestStoreReady) return workerDigestStoreReady;
  workerDigestStoreReady = (async () => {
    await getPgPool().query(`
      create table if not exists indus_worker_digest_runs (
        worker_id text not null,
        report_date date not null,
        status text not null default 'sending',
        recipient_email text not null default '',
        message_id text not null default '',
        data jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        sent_at timestamptz,
        primary key (worker_id, report_date)
      );
      create index if not exists indus_worker_digest_runs_sent_idx on indus_worker_digest_runs (sent_at desc);
    `);
  })();
  try {
    await workerDigestStoreReady;
  } catch (error) {
    workerDigestStoreReady = null;
    throw error;
  }
}

function workerDigestRunData(report, recipientEmail) {
  return {
    lineCount: Math.max(0, Math.round(Number(report?.lines?.length || 0))),
    warningCount: Math.max(0, Math.round(Number(report?.warnings?.length || 0))),
    recipientEmail: String(recipientEmail || "").trim().toLowerCase(),
    portalUrl: String(report?.portalUrl || "").slice(0, 2_000)
  };
}

async function workerDigestDeliveryStatus(db, workerId, date) {
  if (!DATABASE_URL) return workerDigestRunFor(db, workerId, date);
  await ensureWorkerDigestRunStore();
  const result = await getPgPool().query(
    `select worker_id, report_date, status, recipient_email, message_id, sent_at, data
       from indus_worker_digest_runs where worker_id = $1 and report_date = $2::date`,
    [cleanUserId(workerId), String(date || "")]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    key: workerDigestRunKey(row.worker_id, String(row.report_date || "").slice(0, 10)),
    workerId: String(row.worker_id || ""),
    date: String(row.report_date || "").slice(0, 10),
    status: String(row.status || ""),
    recipientEmail: String(row.recipient_email || ""),
    messageId: String(row.message_id || ""),
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : "",
    ...((row.data && typeof row.data === "object") ? row.data : {})
  };
}

async function reserveWorkerDigestDelivery(db, report, recipientEmail) {
  const workerId = cleanUserId(report?.workerId);
  const date = isDateKey(report?.date) ? String(report.date) : "";
  if (!workerDigestRunKey(workerId, date)) throw new Error("Dnevni povzetek nima veljavnega delavca ali datuma.");
  if (!DATABASE_URL) return { reserved: !workerDigestRunFor(db, workerId, date), run: workerDigestRunFor(db, workerId, date) };
  await ensureWorkerDigestRunStore();
  const result = await getPgPool().query(
    `insert into indus_worker_digest_runs
       (worker_id, report_date, status, recipient_email, data, created_at)
     values ($1, $2::date, 'sending', $3, $4::jsonb, now())
     on conflict (worker_id, report_date) do update
       set status = 'sending', recipient_email = excluded.recipient_email, message_id = '', data = excluded.data, created_at = now(), sent_at = null
       where indus_worker_digest_runs.status <> 'sent'
         and indus_worker_digest_runs.created_at < now() - interval '2 hours'
     returning worker_id, report_date`,
    [workerId, date, String(recipientEmail || "").trim().toLowerCase(), JSON.stringify(workerDigestRunData(report, recipientEmail))]
  );
  return { reserved: Boolean(result.rowCount), run: result.rowCount ? null : await workerDigestDeliveryStatus(db, workerId, date) };
}

async function completeWorkerDigestDelivery(db, report, recipientEmail, messageId) {
  const workerId = cleanUserId(report?.workerId);
  const date = isDateKey(report?.date) ? String(report.date) : "";
  if (!DATABASE_URL) return recordWorkerDigestRun(db, report, { recipientEmail, messageId });
  await ensureWorkerDigestRunStore();
  const result = await getPgPool().query(
    `update indus_worker_digest_runs
        set status = 'sent', recipient_email = $3, message_id = $4, data = $5::jsonb, sent_at = now()
      where worker_id = $1 and report_date = $2::date and status = 'sending'
      returning worker_id, report_date, recipient_email, message_id, sent_at`,
    [workerId, date, String(recipientEmail || "").trim().toLowerCase(), String(messageId || "").slice(0, 300), JSON.stringify(workerDigestRunData(report, recipientEmail))]
  );
  if (!result.rowCount) throw new Error("Dnevnega povzetka po po\u0161iljanju ni bilo mogo\u010de evidentirati.");
  return workerDigestDeliveryStatus(db, workerId, date);
}

async function releaseWorkerDigestDelivery(report) {
  if (!DATABASE_URL) return;
  const workerId = cleanUserId(report?.workerId);
  const date = isDateKey(report?.date) ? String(report.date) : "";
  if (!workerDigestRunKey(workerId, date)) return;
  await ensureWorkerDigestRunStore();
  await getPgPool().query(
    "delete from indus_worker_digest_runs where worker_id = $1 and report_date = $2::date and status = 'sending'",
    [workerId, date]
  );
}

async function purgeExpiredWorkerDigestRuns(db) {
  if (!DATABASE_URL) return Array.isArray(db?.workerDigestRuns) ? db.workerDigestRuns.length : 0;
  await ensureWorkerDigestRunStore();
  const result = await getPgPool().query("delete from indus_worker_digest_runs where coalesce(sent_at, created_at) < now() - interval '400 days'");
  return result.rowCount || 0;
}
async function purgeExpiredPersistedAuditLog({ force = false } = {}) {
  if (!DATABASE_URL) return 0;
  if (!force && Date.now() - auditLogStoreCleanupAt < 60 * 60_000) return 0;
  await ensureAuditLogStore();
  const result = await getPgPool().query("delete from indus_audit_log where created_at < now() - interval '30 days'");
  auditLogStoreCleanupAt = Date.now();
  return result.rowCount || 0;
}
async function appendAuditLogToPostgres(input) {
  if (!DATABASE_URL) return null;
  const event = buildAuditLogEvent(input);
  if (!event) return null;
  await ensureAuditLogStore();
  await getPgPool().query(
    `insert into indus_audit_log
      (id, actor_id, actor_name, action, target_type, target_id, severity, context, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)`,
    [event.id, event.actorId, event.actorName, event.action, event.targetType, event.targetId, event.severity, JSON.stringify(event.context), event.createdAt]
  );
  await purgeExpiredPersistedAuditLog();
  return event;
}

async function persistedAuditLogForUser(user, limit = 500) {
  if (!DATABASE_URL || !user) return [];
  await ensureAuditLogStore();
  const safeLimit = Math.max(1, Math.min(AUDIT_LOG_MAX_EVENTS, Number(limit) || 500));
  const result = await getPgPool().query(
    `select id, actor_id, actor_name, action, target_type, target_id, severity, context, created_at
       from indus_audit_log
      where created_at >= now() - interval '30 days'
      order by created_at desc, id desc
      limit $1`,
    [safeLimit]
  );
  const db = {
    auditLog: normalizeAuditLog(result.rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      severity: row.severity,
      context: row.context,
      createdAt: row.created_at
    })))
  };
  return visibleAuditLogForUser(db, user);
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
    settlementCorrections: [],
    todoCreateReceipts: {},
    workerDigestRuns: [],
    lateTimeEntryReports: [],
    auditLog: [],
    undoJournal: [],
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
    await ensureAuditLogStore();
    await ensureWorkerDigestRunStore();
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
  appendUndoJournalForMutation(db);
  db.syncRevision = Math.max(0, Number(db.syncRevision || 0)) + 1;
  if (!DATABASE_URL) {
    writeDb(db);
    return;
  }
  await ensurePostgresDb();
  await getPgStore().save(db, { protectedAttachmentIds: [...undoProtectedAttachmentIds(db)] });
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

function validEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function safeAppReturnTo(value) {
  const path = String(value || "").trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  return path.slice(0, 2_000);
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
    avatar: user.avatar || "",
    employmentType: user.employmentType || "contractor",
    timeEntryForIds: [...new Set([user.id, ...(Array.isArray(user.timeEntryForIds) ? user.timeEntryForIds : [])].map(cleanUserId).filter(Boolean))]
  };
}
function publicDirectoryUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    employmentType: user.employmentType || "contractor",
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

// A change marker belongs to the recipient, not to the task globally.  This
// keeps a co-worker's unread change visible even after another user reorders
// the task or opens their own assignment copy.
const TODO_CHANGE_NOTICE_FIELDS = new Set([
  "created", "manual", "client", "assignment", "title", "notes", "material",
  "status", "schedule", "attachments", "worker-billing", "client-billing"
]);

function cleanTodoChangeNotice(input, users = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const by = cleanUserId(input.by);
  const at = String(input.at || "");
  if (!by || !users?.[by] || !Number.isFinite(Date.parse(at))) return null;
  const fields = [...new Set((Array.isArray(input.fields) ? input.fields : [])
    .map((field) => String(field || "").trim())
    .filter((field) => TODO_CHANGE_NOTICE_FIELDS.has(field)))].slice(0, 16);
  if (!fields.length) return null;
  return {
    at: new Date(at).toISOString(),
    by,
    byName: String(input.byName || users[by]?.name || by).trim().slice(0, 120),
    kind: ["created", "manual", "updated"].includes(input.kind) ? input.kind : "updated",
    fields
  };
}

function cleanTodoChangeNotices(input, users = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const notices = {};
  for (const [userId, raw] of Object.entries(input)) {
    const id = cleanUserId(userId);
    if (!id || !users?.[id] || users[id].active === false) continue;
    const notice = cleanTodoChangeNotice(raw, users);
    if (notice) notices[id] = notice;
  }
  return notices;
}

function todoChangeNoticeForUser(todo, user) {
  if (!todo || !user) return null;
  return cleanTodoChangeNotice(todo.changeNotices?.[user.id], { [user.id]: user, [todo.changeNotices?.[user.id]?.by]: { name: todo.changeNotices?.[user.id]?.byName || "" } });
}

function todoChangeNoticeFields(previous = {}, next = {}, { created = false, manual = false, assignmentsChanged = false } = {}) {
  if (created) return ["created"];
  if (manual) return ["manual"];
  const equal = (fields) => JSON.stringify(fields.map((field) => previous?.[field] ?? null))
    === JSON.stringify(fields.map((field) => next?.[field] ?? null));
  const fields = [];
  if (!equal(["clientId", "client", "clientContactIds", "clientContacts"])) fields.push("client");
  if (!equal(["title"])) fields.push("title");
  if (!equal(["notes"])) fields.push("notes");
  if (!equal(["material", "materialAmount", "externalDelivery"])) fields.push("material");
  if (!equal(["status", "urgent", "ordered", "warranty", "imported", "calendarOnly", "workFromHome", "commuteEligible"])) fields.push("status");
  if (!equal(["date", "endDate", "start", "end"])) fields.push("schedule");
  if (!equal(["photos", "driveFiles"])) fields.push("attachments");
  if (!equal(["billingHourlyRate", "billingKm"])) fields.push("worker-billing");
  if (!equal(["clientBillableMinutes", "clientKm", "clientVehicle"])) fields.push("client-billing");
  if (assignmentsChanged) fields.push("assignment");
  return fields;
}

function todoChangeNoticeRecipientIds(db, todos, actor) {
  const recipients = new Set();
  for (const todo of todos || []) {
    const id = cleanUserId(todo?.syncUser || todo?.createdBy);
    if (id && db.users?.[id]?.active !== false) recipients.add(id);
  }
  for (const user of Object.values(db.users || {})) {
    if (user?.role === "boss" && user.active !== false) recipients.add(user.id);
  }
  recipients.delete(cleanUserId(actor?.id));
  return [...recipients];
}

function recordTodoChangeNotices(db, todos, actor, fields, kind = "updated", at = new Date().toISOString()) {
  const normalizedFields = [...new Set((Array.isArray(fields) ? fields : [])
    .map((field) => String(field || "").trim())
    .filter((field) => TODO_CHANGE_NOTICE_FIELDS.has(field)))];
  if (!normalizedFields.length) return [];
  const recipients = todoChangeNoticeRecipientIds(db, todos, actor);
  if (!recipients.length) return [];
  const notice = {
    at: new Date(at).toISOString(),
    by: cleanUserId(actor?.id) || "system",
    byName: String(actor?.name || actor?.id || "Sistem").slice(0, 120),
    kind: ["created", "manual"].includes(kind) ? kind : "updated",
    fields: normalizedFields
  };
  for (const todo of todos || []) {
    todo.changeNotices = cleanTodoChangeNotices(todo.changeNotices, db.users);
    for (const recipientId of recipients) todo.changeNotices[recipientId] = { ...notice, fields: [...notice.fields] };
  }
  return recipients;
}

function clearTodoChangeNoticesForUser(db, todo, user) {
  let changed = false;
  for (const assignmentTodo of todoAssignmentItems(db, todo)) {
    const notices = cleanTodoChangeNotices(assignmentTodo.changeNotices, db.users);
    if (notices[user.id]) {
      delete notices[user.id];
      changed = true;
    }
    assignmentTodo.changeNotices = notices;
  }
  return changed;
}

function todoSharedManualOrder(todo) {
  const value = Number(todo?.sharedManualOrder);
  return Number.isFinite(value) ? value : Number(todo?.order || 0);
}

function todoSharedManualBucket(todo) {
  return todo?.sharedManualBucket === "unsorted" ? "unsorted" : "sorted";
}

function todoManualOrderDomain(todo) {
  if (!todo || todo.done || TIME_ENTRY_TODO_STATUSES.has(todo.status)) return "";
  if (todo.urgent) return "urgent";
  if (ORDER_TODO_STATUSES.has(todo.status) || todo.status === "add_to_car") return "ordering";
  return "active";
}

function sharedManualTodoGroups(db, { domain = "" } = {}) {
  const groups = new Map();
  for (const todo of db.todos || []) {
    if (isTrashedTodo(todo)) continue;
    const groupId = String(todo.assignmentGroupId || todo.id || "");
    if (!groupId) continue;
    const current = groups.get(groupId) || { id: groupId, todos: [] };
    current.todos.push(todo);
    groups.set(groupId, current);
  }
  const records = [...groups.values()].map((group) => {
    group.todos.sort((left, right) => String(left.id || "").localeCompare(String(right.id || "")));
    group.todo = group.todos[0];
    group.domain = todoManualOrderDomain(group.todo);
    group.bucket = todoSharedManualBucket(group.todo);
    group.order = todoSharedManualOrder(group.todo);
    return group;
  }).filter((group) => !domain || group.domain === domain);
  records.sort((left, right) => {
    const bucket = Number(left.bucket === "sorted") - Number(right.bucket === "sorted");
    if (bucket) return bucket;
    const order = left.order - right.order;
    return order || left.id.localeCompare(right.id);
  });
  return records;
}

function userCanReorderSharedTodoGroup(user, group) {
  return user?.role === "boss" || group?.todos?.some((todo) => cleanUserId(todo.syncUser || todo.createdBy) === user?.id);
}

function sharedManualOrderBefore(db, { domain = "active", bucket = "unsorted" } = {}) {
  const values = sharedManualTodoGroups(db, { domain })
    .filter((group) => group.bucket === bucket)
    .map((group) => group.order)
    .filter(Number.isFinite);
  return (values.length ? Math.min(...values) : 0) - 1;
}

function applySharedManualTodoOrder(db, user, input = {}) {
  const sourceId = String(input.sourceId || "").trim();
  const targetId = String(input.targetId || "").trim();
  const placement = input.placement === "after" ? "after" : "before";
  const requestedBucket = input.targetBucket === "unsorted" ? "unsorted" : input.targetBucket === "sorted" ? "sorted" : "";
  const locks = input.editLockTokens && typeof input.editLockTokens === "object" ? input.editLockTokens : {};
  const allGroups = sharedManualTodoGroups(db);
  const byTodoId = new Map((db.todos || []).map((todo) => [String(todo.id || ""), todo]));
  const groupsById = new Map(allGroups.map((group) => [group.id, group]));
  const sourceTodo = byTodoId.get(sourceId);
  const source = sourceTodo ? groupsById.get(String(sourceTodo.assignmentGroupId || sourceTodo.id || "")) : null;
  if (!source || !source.domain) return { error: "Izbranega opravila ni mogoče ročno razvrščati." };
  if (!userCanReorderSharedTodoGroup(user, source)) return { status: 403, error: "Tega vrstnega reda ne smeš spreminjati." };
  for (const todo of source.todos) {
    const lock = todoAssignmentEditLockConflict(db, todo, user, String(locks[todo.id] || ""));
    if (lock) return { status: 409, error: `Opravilo trenutno ureja ${lock.lockedByName || lock.lockedById}.`, lock };
  }

  const targetTodo = targetId ? byTodoId.get(targetId) : null;
  const target = targetTodo ? groupsById.get(String(targetTodo.assignmentGroupId || targetTodo.id || "")) : null;
  if (targetId && (!target || target.id === source.id || target.domain !== source.domain)) {
    return { status: 400, error: "Opravili nista v isti skupini ročnega vrstnega reda." };
  }
  if (target && !userCanReorderSharedTodoGroup(user, target)) return { status: 403, error: "Tega vrstnega reda ne smeš spreminjati." };
  if (target) {
    for (const todo of target.todos) {
      const lock = todoAssignmentEditLockConflict(db, todo, user, String(locks[todo.id] || ""));
      if (lock) return { status: 409, error: `Opravilo trenutno ureja ${lock.lockedByName || lock.lockedById}.`, lock };
    }
  }

  const domainGroups = allGroups.filter((group) => group.domain === source.domain);
  const sourceBucket = source.bucket;
  const destinationBucket = source.domain === "active"
    ? (target ? target.bucket : (requestedBucket || sourceBucket))
    : "sorted";
  const buckets = source.domain === "active" ? ["unsorted", "sorted"] : ["sorted"];
  const groupsByBucket = new Map(buckets.map((bucket) => [bucket, domainGroups.filter((group) => group.bucket === bucket)]));
  const canSee = (group) => userCanReorderSharedTodoGroup(user, group);
  const resultByBucket = new Map();

  if (sourceBucket === destinationBucket) {
    const base = [...(groupsByBucket.get(sourceBucket) || [])];
    const visible = base.filter(canSee);
    const sourceIndex = visible.findIndex((group) => group.id === source.id);
    if (sourceIndex < 0) return { status: 403, error: "Tega vrstnega reda ne smeš spreminjati." };
    const desired = visible.slice();
    desired.splice(sourceIndex, 1);
    let insertAt = target ? desired.findIndex((group) => group.id === target.id) : (placement === "after" ? desired.length : 0);
    if (insertAt < 0) return { status: 400, error: "Ciljno opravilo ni v tvojem pogledu." };
    if (target && placement === "after") insertAt += 1;
    desired.splice(insertAt, 0, source);
    let visibleIndex = 0;
    resultByBucket.set(sourceBucket, base.map((group) => canSee(group) ? desired[visibleIndex++] : group));
  } else {
    const sourceBase = [...(groupsByBucket.get(sourceBucket) || [])].filter((group) => group.id !== source.id);
    resultByBucket.set(sourceBucket, sourceBase);
    const destinationBase = [...(groupsByBucket.get(destinationBucket) || [])];
    const visible = destinationBase.filter(canSee);
    let insertAt = target ? visible.findIndex((group) => group.id === target.id) : (placement === "after" ? visible.length : 0);
    if (insertAt < 0) return { status: 400, error: "Ciljno opravilo ni v tvojem pogledu." };
    if (target && placement === "after") insertAt += 1;
    const desired = visible.slice();
    desired.splice(insertAt, 0, source);
    const desiredExisting = desired.filter((group) => group.id !== source.id);
    let visibleIndex = 0;
    const merged = destinationBase.map((group) => canSee(group) ? desiredExisting[visibleIndex++] : group);
    const before = desired[insertAt + 1];
    const after = desired[insertAt - 1];
    const baseIndex = before
      ? merged.findIndex((group) => group.id === before.id)
      : after
        ? merged.findIndex((group) => group.id === after.id) + 1
        : (placement === "after" ? merged.length : 0);
    merged.splice(Math.max(0, baseIndex), 0, source);
    resultByBucket.set(destinationBucket, merged);
  }
  for (const bucket of buckets) if (!resultByBucket.has(bucket)) resultByBucket.set(bucket, groupsByBucket.get(bucket) || []);

  const now = new Date().toISOString();
  for (const bucket of buckets) {
    const records = resultByBucket.get(bucket) || [];
    records.forEach((group, index) => {
      for (const todo of group.todos) {
        todo.sharedManualBucket = bucket;
        todo.sharedManualOrder = index + 1;
      }
    });
  }
  const sourceHistory = [...(source.todo.history || []), audit(user, "spremenjen skupni vrstni red")];
  for (const todo of source.todos) {
    todo.sharedManualOrderUpdatedAt = now;
    todo.sharedManualOrderUpdatedBy = user.id;
    todo.sharedManualOrderUpdatedByName = user.name;
    todo.history = sourceHistory;
  }
  return { changed: true, sourceGroupId: source.id };
}
function isTrashedTodo(todo) {
  return Boolean(String(todo?.trashedAt || "").trim());
}

function trashedTodoExpiresAt(todo) {
  const deletedAt = Date.parse(String(todo?.trashedAt || ""));
  return Number.isFinite(deletedAt) ? new Date(deletedAt + DELETED_TODO_RETENTION_MS).toISOString() : "";
}

function trashTodoGroup(db, todo, actor, now = new Date().toISOString()) {
  const assignmentItems = todoAssignmentItems(db, todo);
  const ids = new Set(assignmentItems.map((item) => String(item.id || "")).filter(Boolean));
  const name = String(actor?.name || actor?.id || "Sistem");
  db.todos = (db.todos || []).map((item) => !ids.has(String(item.id || "")) ? item : {
    ...item,
    trashedAt: now,
    trashedBy: String(actor?.id || "system"),
    trashedByName: name,
    updatedAt: now,
    updatedBy: String(actor?.id || "system"),
    updatedByName: name,
    history: [...(item.history || []), audit(actor || { id: "system", name }, "premaknjeno v Izbrisano")]
  });
  return (db.todos || []).filter((item) => ids.has(String(item.id || "")));
}

function restoreTrashedTodoGroup(db, todo, actor, now = new Date().toISOString()) {
  const assignmentItems = todoAssignmentItems(db, todo);
  const ids = new Set(assignmentItems.map((item) => String(item.id || "")).filter(Boolean));
  const name = String(actor?.name || actor?.id || "Sistem");
  db.todos = (db.todos || []).map((item) => !ids.has(String(item.id || "")) ? item : (() => {
    const restored = {
      ...item,
      updatedAt: now,
      updatedBy: String(actor?.id || "system"),
      updatedByName: name,
      history: [...(item.history || []), audit(actor || { id: "system", name }, "obnovljeno iz Izbrisano")]
    };
    delete restored.trashedAt;
    delete restored.trashedBy;
    delete restored.trashedByName;
    return restored;
  })());
  return (db.todos || []).filter((item) => ids.has(String(item.id || "")));
}

function managedDriveFilesForTodos(todos) {
  return [...new Map((todos || []).flatMap((todo) => todo.driveFiles || [])
    .filter((file) => Boolean(file?.managed)
      && String(file.ownerEmail || "").trim().toLowerCase() === GOOGLE_DRIVE_OWNER_EMAIL
      && validGoogleDriveId(file.fileId))
    .map((file) => [String(file.fileId), file])).values()];
}

function trashedTodoRetentionCandidates(db, now = Date.now()) {
  const currentMs = Number(now instanceof Date ? now.getTime() : now);
  const cutoff = (Number.isFinite(currentMs) ? currentMs : Date.now()) - DELETED_TODO_RETENTION_MS;
  const allByGroup = new Map();
  for (const todo of db.todos || []) {
    const groupId = String(todo.assignmentGroupId || todo.id || "");
    if (!groupId) continue;
    const group = allByGroup.get(groupId) || [];
    group.push(todo);
    allByGroup.set(groupId, group);
  }
  const groups = [];
  for (const [id, todos] of allByGroup) {
    const fullyTrashedAndExpired = todos.length > 0 && todos.every((todo) => {
      const deletedAt = Date.parse(String(todo.trashedAt || ""));
      return isTrashedTodo(todo) && Number.isFinite(deletedAt) && deletedAt <= cutoff;
    });
    if (!fullyTrashedAndExpired) continue;
    groups.push({ id, todos, managedDriveFiles: managedDriveFilesForTodos(todos) });
  }
  return { cutoffAt: new Date(cutoff).toISOString(), groups };
}

function purgeExpiredTrashedTodoGroups(db, now = Date.now(), approvedGroups = null) {
  const candidates = trashedTodoRetentionCandidates(db, now).groups;
  // Without caller-approved groups, preserve app-managed Drive files. The
  // scheduler deletes only files it owns and then explicitly approves a group.
  const requestedIds = Array.isArray(approvedGroups)
    ? new Set(approvedGroups.map((group) => String(group?.id || "")).filter(Boolean))
    : new Set(candidates.filter((group) => !group.managedDriveFiles.length).map((group) => group.id));
  const expiredIds = new Set(candidates.map((group) => group.id).filter((id) => requestedIds.has(id)));
  if (!expiredIds.size) return { groups: 0, todos: 0, attachments: 0, adHocClients: 0 };
  const beforeTodos = (db.todos || []).length;
  const beforeAttachments = Object.keys(db.attachments || {}).length;
  const beforeClients = (db.clients || []).length;
  db.todos = (db.todos || []).filter((todo) => !expiredIds.has(String(todo.assignmentGroupId || todo.id || "")));
  pruneUnusedTodoAttachments(db);
  pruneUnusedAdHocClients(db);
  return {
    groups: expiredIds.size,
    todos: beforeTodos - db.todos.length,
    attachments: beforeAttachments - Object.keys(db.attachments || {}).length,
    adHocClients: beforeClients - (db.clients || []).length
  };
}

function visibleTrashedTodosForUser(db, user) {
  const visible = (db.todos || []).filter((todo) => isTrashedTodo(todo)
    && (user.role === "boss" || todo.syncUser === user.id || todo.createdBy === user.id));
  const events = new Map();
  for (const todo of visible) {
    const key = String(todo.assignmentGroupId || todo.id || "");
    const current = events.get(key);
    if (!current || String(todo.trashedAt || "") > String(current.trashedAt || "")) events.set(key, todo);
  }
  return [...events.values()]
    .sort((left, right) => String(right.trashedAt || "").localeCompare(String(left.trashedAt || "")))
    .map((todo) => {
      const hydrated = hydrateTodoAttachments(db, { ...todo, assigneeIds: todoAssignmentAssigneeIds(db, todo) });
      const { completionRequests, changeNotices, ...publicTodo } = hydrated;
      return { ...publicTodo, restoreUntil: trashedTodoExpiresAt(todo) };
    });
}

function visibleTodosForUser(db, user) {
  const todos = (db.todos || []).filter((todo) => !isTrashedTodo(todo));
  const visible = user.role === "boss"
    ? todos
    : todos.filter((todo) => todo.syncUser === user.id || todo.createdBy === user.id);
  return visible.map((todo) => {
    const hydrated = hydrateTodoAttachments(db, {
      ...todo,
      assigneeIds: todoAssignmentAssigneeIds(db, todo)
    });
    const { completionRequests, history, revisionHistory, changeNotices, ...publicTodo } = hydrated;
    const corrections = pendingCorrectionsForTodo(db, todo);
    return {
      ...publicTodo,
      changeNotice: todoChangeNoticeForUser(todo, user),
      // A boss can switch into an individual worker's view.  Preserve the
      // worker's private marker for that *view* as well, otherwise a task
      // marked for Ibro looked unmarked while Bojan was looking at Ibro's
      // manual list.  The client never receives this map for a worker.
      ...(user.role === "boss" ? { changeNoticesByUser: cleanTodoChangeNotices(todo.changeNotices, db.users) } : {}),
      ...(user.role === "boss" ? { history, revisionHistory } : {}),
      clientSettlement: clientSettlementForTodo(db, todo),
      settlement: corrections.length ? {
        pending: true,
        worker: corrections.filter((item) => item.type === "worker").map((item) => ({ id: item.id, delta: item.delta, effectiveDate: item.effectiveDate })),
        client: corrections.filter((item) => item.type === "client").map((item) => ({ id: item.id, delta: item.delta, effectiveDate: item.effectiveDate }))
      } : { pending: false, worker: [], client: [] }
    };
  });
}

// The normal list endpoint intentionally prepares every visible task.  Links
// in e-mail, however, open exactly one task.  Keeping that lookup focused
// avoids hydrating every attachment and assignment before the editor appears.
function visibleTodoForUser(db, user, id) {
  const todoId = String(id || "");
  const todo = (db.todos || []).find((item) => String(item?.id || "") === todoId);
  if (!todo || isTrashedTodo(todo) || !canManageTodo(user, todo)) return null;
  const hydrated = hydrateTodoAttachments(db, {
    ...todo,
    assigneeIds: todoAssignmentAssigneeIds(db, todo)
  });
  const { completionRequests, history, revisionHistory, changeNotices, ...publicTodo } = hydrated;
  const corrections = pendingCorrectionsForTodo(db, todo);
  return {
    ...publicTodo,
    changeNotice: todoChangeNoticeForUser(todo, user),
    ...(user.role === "boss" ? { changeNoticesByUser: cleanTodoChangeNotices(todo.changeNotices, db.users) } : {}),
    ...(user.role === "boss" ? { history, revisionHistory } : {}),
    clientSettlement: clientSettlementForTodo(db, todo),
    settlement: corrections.length ? { pending: true, worker: corrections.filter((item) => item.type === "worker").map((item) => ({ id: item.id, delta: item.delta, effectiveDate: item.effectiveDate })), client: corrections.filter((item) => item.type === "client").map((item) => ({ id: item.id, delta: item.delta, effectiveDate: item.effectiveDate })) } : { pending: false, worker: [], client: [] }
  };
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

// A worker can occasionally receive a payment from the client while doing the
// work. This is not an advance and it is not payment for hours: it is a
// separate, auditable credit on that worker's settlement.
function visibleClientReceiptsForUser(db, user) {
  return visibleDebtsForUser(db, user).filter((debt) => debt.type === "client_receipt");
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

function acquireTodoEditLockGroup(todoId, assignmentIds, user, lockToken = "", now = Date.now()) {
  const ids = [...new Set((assignmentIds || []).map((id) => String(id || "")).filter(Boolean))];
  const targetId = String(todoId || "");
  if (targetId && !ids.includes(targetId)) ids.push(targetId);
  for (const id of ids) {
    const conflict = todoEditLockConflict(id, user, lockToken, now);
    if (conflict) return { ok: false, lock: conflict };
  }
  const existing = ids.map((id) => activeTodoEditLock(id, now)).find(Boolean);
  const token = existing?.token || crypto.randomBytes(18).toString("hex");
  for (const id of ids) {
    todoEditLocks.set(id, {
      todoId: id,
      userId: user.id,
      userName: user.name || user.id,
      token,
      expiresAt: now + TODO_EDIT_LOCK_TTL_MS
    });
  }
  const lock = activeTodoEditLock(targetId, now);
  return { ok: true, token, lock: publicTodoEditLock(lock) };
}

function releaseTodoEditLockGroup(todoId, assignmentIds, user, lockToken = "", now = Date.now()) {
  const ids = [...new Set((assignmentIds || []).map((id) => String(id || "")).filter(Boolean))];
  const targetId = String(todoId || "");
  if (targetId && !ids.includes(targetId)) ids.push(targetId);
  return ids.map((id) => releaseTodoEditLock(id, user, lockToken, now)).every(Boolean);
}

function acquireTodoAssignmentEditLock(db, todo, user, lockToken = "", now = Date.now()) {
  const items = todoAssignmentItems(db, todo);
  const conflict = todoAssignmentEditLockConflict(db, todo, user, lockToken, now);
  if (conflict) return { ok: false, lock: conflict };
  return acquireTodoEditLockGroup(todo.id, items.map((item) => item.id), user, lockToken, now);
}

function releaseTodoAssignmentEditLock(db, todo, user, lockToken = "", now = Date.now()) {
  return releaseTodoEditLockGroup(todo.id, todoAssignmentItems(db, todo).map((item) => item.id), user, lockToken, now);
}

function canManageTodo(user, todo) {
  if (!todo) return false;
  if (user.role === "boss") return true;
  return todo.syncUser === user.id || todo.createdBy === user.id;
}

// A source project is not user-entered decoration: it is the durable link
// between a completed hour entry and the task from which it was created.
// New links are accepted only from a task the user can actually open. Later
// edits retain the stored snapshot, even if that original task was deleted.
function preserveTimeEntrySourceProject(db, user, todo, previous = null) {
  if (todo.status !== "execution") {
    return { todo: { ...todo, sourceProjectTodoId: "", sourceProjectTitle: "" }, error: "" };
  }
  const priorId = previous?.status === "execution" ? String(previous.sourceProjectTodoId || "").trim() : "";
  if (previous) {
    if (!priorId && todo.sourceProjectTodoId) {
      return { todo, error: "Izvornega opravila za obstoječ vpis ur ni mogoče naknadno nastaviti." };
    }
    const source = priorId ? (db.todos || []).find((item) => item.id === priorId) : null;
    return {
      todo: {
        ...todo,
        sourceProjectTodoId: priorId,
        sourceProjectTitle: priorId ? String(previous.sourceProjectTitle || source?.title || "").trim().slice(0, 300) : ""
      },
      error: ""
    };
  }
  const sourceId = String(todo.sourceProjectTodoId || "").trim();
  if (!sourceId) return { todo, error: "" };
  const source = (db.todos || []).find((item) => item.id === sourceId);
  if (!source || isTrashedTodo(source) || !canManageTodo(user, source)
      || TIME_ENTRY_TODO_STATUSES.has(source.status) || !["open", "in_progress"].includes(source.status)) {
    return { todo, error: "Izvorno opravilo ni na voljo za vpis ur." };
  }
  return {
    todo: { ...todo, sourceProjectTodoId: source.id, sourceProjectTitle: String(source.title || "").trim().slice(0, 300) },
    error: ""
  };
}
function sourceTodoForNewEntry(db, user, entry) {
  const sourceTodoId = String(entry.sourceTodoId || "");
  const todo = (db.todos || []).find((item) => item.id === sourceTodoId);
  if (!todo || isTrashedTodo(todo) || !canManageTodo(user, todo)) return null;
  if (!todo.date || todo.date !== entry.date) return null;
  if ((db.entries || []).some((item) => item.sourceTodoId === sourceTodoId)) return null;
  return todo;
}

function cleanUserId(value) {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ? id : "";
}

const EMPLOYMENT_TYPES = new Set(["contractor", "employee"]);

function timeEntryTargetIds(db, user) {
  if (!user || typeof user !== "object") return [];
  const users = db?.users && typeof db.users === "object" ? db.users : {};
  const requested = Array.isArray(user.timeEntryForIds) ? user.timeEntryForIds : [];
  const ids = [...new Set([user.id, ...requested].map(cleanUserId).filter(Boolean))];
  return ids.filter((id) => !Object.keys(users).length || (users[id] && users[id].active !== false));
}

function canRecordHoursFor(db, user, workerId) {
  const targetId = cleanUserId(workerId);
  if (!user || !targetId || !db?.users?.[targetId] || db.users[targetId].active === false) return false;
  if (user.role === "boss") return true;
  return timeEntryTargetIds(db, user).includes(targetId);
}

function normalizeWorkerProfile(id, user, users = {}) {
  if (!user || typeof user !== "object") return false;
  let changed = false;
  const active = user.role === "boss" ? true : user.active !== false;
  if (user.active !== active) {
    user.active = active;
    changed = true;
  }
  const employmentType = EMPLOYMENT_TYPES.has(String(user.employmentType || ""))
    ? String(user.employmentType)
    : "contractor";
  if (user.employmentType !== employmentType) {
    user.employmentType = employmentType;
    changed = true;
  }
  const ids = [...new Set([id, ...(Array.isArray(user.timeEntryForIds) ? user.timeEntryForIds : [])]
    .map(cleanUserId)
    .filter((targetId) => Boolean(users[targetId]) && users[targetId].active !== false))];
  if (JSON.stringify(user.timeEntryForIds || []) !== JSON.stringify(ids)) {
    user.timeEntryForIds = ids;
    changed = true;
  }
  return changed;
}

function auditLogCsvCell(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return '"' + String(text).replaceAll('"', '""') + '"';
}

function auditLogCsv(events = []) {
  const header = ["Čas", "Uporabnik", "Dejanje", "Vrsta", "ID", "Stopnja", "Kontekst"];
  const rows = events.map((event) => [
    event.createdAt || "",
    event.actorName || event.actorId || "",
    event.action || "",
    event.targetType || "",
    event.targetId || "",
    event.severity || "info",
    event.context || {}
  ]);
  return "\uFEFF" + [header, ...rows].map((row) => row.map(auditLogCsvCell).join(",")).join("\r\n") + "\r\n";
}

function xlsxXml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;"
  })[character]);
}

function xlsxColumnName(index) {
  let value = "";
  for (let number = index; number > 0; number = Math.floor((number - 1) / 26)) value = String.fromCharCode(65 + ((number - 1) % 26)) + value;
  return value;
}

function xlsxDateSerial(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  return Math.round((Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - Date.UTC(1899, 11, 30)) / 86400000);
}

function xlsxTimeSerial(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  return (Number(match[1]) * 60 + Number(match[2])) / 1440;
}

function xlsxCell(reference, value, style = 0, formula = "") {
  const styleAttribute = style ? ` s="${style}"` : "";
  if (formula) return `<c r="${reference}"${styleAttribute}><f>${xlsxXml(formula)}</f></c>`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"${styleAttribute}><v>${value}</v></c>`;
  if (value === null || value === undefined || value === "") return `<c r="${reference}"${styleAttribute}/>`;
  return `<c r="${reference}" t="inlineStr"${styleAttribute}><is><t${/^\s|\s$/.test(String(value)) ? " xml:space=\"preserve\"" : ""}>${xlsxXml(value)}</t></is></c>`;
}

function xlsxSheetXml(rows = [], columns = []) {
  const dimension = `A1:${xlsxColumnName(Math.max(1, columns.length))}${Math.max(1, rows.length)}`;
  const columnXml = columns.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const rowXml = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => xlsxCell(`${xlsxColumnName(columnIndex + 1)}${rowIndex + 1}`, cell.value, cell.style, cell.formula)).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columnXml}</cols><sheetData>${rowXml}</sheetData><autoFilter ref="A5:${xlsxColumnName(Math.max(1, columns.length))}${Math.max(5, rows.length)}"/></worksheet>`;
}

function workerPayrollXlsxReport(db, workerId, rangeInput) {
  const range = payrollRange(rangeInput);
  if (!range || !db.users?.[workerId]) return null;
  const stored = (db.payrolls || []).find((payroll) => payroll.workerId === workerId && payroll.from === range.from && payroll.to === range.to);
  const payroll = stored && ["archiving", "confirmed", "paid"].includes(stored.status)
    ? normalizePayroll(stored, db)
    : buildPayrollSnapshot(db, workerId, range);
  if (!payroll) return null;
  const byId = (items = []) => new Map(items.map((item) => [String(item.id || ""), item]));
  const debts = byId(db.debts || []);
  const advances = (payroll.advanceIds || []).map((id) => debts.get(String(id))).filter(Boolean);
  const receipts = (payroll.clientReceiptIds || []).map((id) => debts.get(String(id))).filter(Boolean);
  const purchases = (payroll.personalPurchaseIds || []).map((id) => debts.get(String(id))).filter(Boolean);
  return { payroll, worker: db.users[workerId], range, advances, receipts, purchases };
}

function workerPayrollXlsxEntries(report) {
  const detailRows = (report.payroll.lines || []).map((line) => ({
    date: xlsxDateSerial(line.date), start: xlsxTimeSerial(line.start), end: xlsxTimeSerial(line.end),
    hourlyRate: Number(line.hourlyRate || 0), workerKm: Number(line.workerKm || 0), kmRate: Number(line.kmRate || 0), commuteKm: Number(line.commuteKm || 0),
    client: line.client || "", title: line.title || "", status: line.status || ""
  }));
  const financialRows = [
    ...report.advances.map((item) => ({ date: item.date, type: "Založeno", reason: item.reason || "", amount: Number(item.amount || 0), impact: Number(item.amount || 0) })),
    ...report.receipts.map((item) => ({ date: item.date, type: "Prejeta sredstva", reason: item.reason || "", amount: Number(item.amount || 0), impact: Number(item.amount || 0) })),
    ...report.purchases.map((item) => ({ date: item.date, type: "Osebni nakup", reason: item.reason || "", amount: Number(item.amount || 0), impact: -Number(item.amount || 0) })),
    ...(report.payroll.payments || []).map((item) => ({ date: String(item.createdAt || "").slice(0, 10), type: "Že izplačano", reason: item.note || "", amount: Number(item.amount || 0), impact: -Number(item.amount || 0) }))
  ].sort((left, right) => String(left.date).localeCompare(String(right.date)) || left.type.localeCompare(right.type, "sl"));
  const entryLastRow = Math.max(2, detailRows.length + 1);
  const financialLastRow = Math.max(2, financialRows.length + 1);
  const summary = [
    [{ value: "OBRAČUN DELAVCA", style: 1 }, { value: "", style: 1 }, { value: "", style: 1 }],
    [{ value: "Delavec", style: 2 }, { value: report.worker.billing?.exportTitle || report.worker.name || report.worker.id, style: 3 }],
    [{ value: "Obdobje", style: 2 }, { value: `${report.range.from} – ${report.range.to}`, style: 3 }],
    [{ value: "Stanje", style: 2 }, { value: report.payroll.status === "paid" ? "Plačano" : report.payroll.status === "confirmed" ? "Potrjeno" : "V pripravi", style: 3 }],
    [{ value: "Ure", style: 4 }, { value: "", style: 6, formula: `SUM('Vnosi'!D2:D${entryLastRow})` }, { value: "Delo", style: 4 }, { value: "", style: 7, formula: `SUM('Vnosi'!F2:F${entryLastRow})` }],
    [{ value: "Kilometrina", style: 4 }, { value: "", style: 6, formula: `SUM('Vnosi'!G2:G${entryLastRow})+SUM('Vnosi'!J2:J${entryLastRow})` }, { value: "Kilometrina", style: 4 }, { value: "", style: 7, formula: `SUM('Vnosi'!K2:K${entryLastRow})` }],
    [{ value: "Znesek skupaj", style: 8 }, { value: "", style: 9, formula: "D5+D6" }],
    [{ value: "Založeno", style: 4 }, { value: "", style: 7, formula: `SUMIF('Finančni vnosi'!B2:B${financialLastRow},"Založeno",'Finančni vnosi'!D2:D${financialLastRow})` }],
    [{ value: "Prejeta sredstva", style: 4 }, { value: "", style: 7, formula: `SUMIF('Finančni vnosi'!B2:B${financialLastRow},"Prejeta sredstva",'Finančni vnosi'!D2:D${financialLastRow})` }],
    [{ value: "Osebni nakupi", style: 4 }, { value: "", style: 7, formula: `SUMIF('Finančni vnosi'!B2:B${financialLastRow},"Osebni nakup",'Finančni vnosi'!D2:D${financialLastRow})` }],
    [{ value: "Že izplačano", style: 4 }, { value: "", style: 7, formula: `SUMIF('Finančni vnosi'!B2:B${financialLastRow},"Že izplačano",'Finančni vnosi'!D2:D${financialLastRow})` }],
    [{ value: "Razlika", style: 8 }, { value: "", style: 9, formula: "B8+B9-B10-B11" }],
    [{ value: "Za izplačilo", style: 10 }, { value: "", style: 11, formula: "B7+B12" }]
  ];
  const details = [["Datum", "Od", "Do", "Ure", "EUR/h", "Delo", "Km delavca", "EUR/km", "Vožnja", "Pot v službo", "Kilometrina", "Skupaj", "Stranka", "Ime opravila", "Status"]]
    .concat(detailRows.map((line, index) => {
      const row = index + 2;
      return [line.date, line.start, line.end, { formula: `IF(OR(B${row}=\"\",C${row}=\"\"),0,(C${row}-B${row})*24)` }, line.hourlyRate, { formula: `D${row}*E${row}` }, line.workerKm, line.kmRate, { formula: `G${row}*H${row}` }, line.commuteKm, { formula: `(G${row}+J${row})*H${row}` }, { formula: `F${row}+K${row}` }, line.client, line.title, line.status];
    }));
  const finances = [["Datum", "Vrsta", "Opis", "Znesek", "Vpliv na izplačilo"]]
    .concat(financialRows.map((line) => [xlsxDateSerial(line.date), line.type, line.reason, line.amount, line.impact]));
  return { summary, details, finances };
}

async function sendWorkerPayrollXlsx(res, report) {
  const sheets = workerPayrollXlsxEntries(report);
  const rows = (matrix) => matrix.map((row) => row.map((value) => typeof value === "object" && value ? { value: value.value ?? "", formula: value.formula || "" } : { value }));
  const detailSheetRows = rows(sheets.details).map((row, rowIndex) => row.map((cell, columnIndex) => {
    const style = rowIndex === 0 ? 1
      : columnIndex === 0 ? 12
        : [1, 2].includes(columnIndex) ? 13
          : [3, 4, 6, 7, 9].includes(columnIndex) ? 14
            : [5, 8, 10, 11].includes(columnIndex) ? 15 : 3;
    return { ...cell, style };
  }));
  const financialSheetRows = rows(sheets.finances).map((row, rowIndex) => row.map((cell, columnIndex) => ({
    ...cell,
    style: rowIndex === 0 ? 1 : columnIndex === 0 ? 12 : [3, 4].includes(columnIndex) ? 15 : 3
  })));
  const xml = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><sheets><sheet name="Povzetek" sheetId="1" r:id="rId1"/><sheet name="Vnosi" sheetId="2" r:id="rId2"/><sheet name="Finančni vnosi" sheetId="3" r:id="rId3"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/><numFmt numFmtId="165" formatCode="hh:mm"/><numFmt numFmtId="166" formatCode="0.00"/><numFmt numFmtId="167" formatCode="# ##0.00 &quot;EUR&quot;"/></numFmts><fonts count="3"><font><sz val="10"/><name val="Aptos"/></font><font><b/><sz val="10"/><name val="Aptos Display"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos Display"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E6172"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6F2EF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173F4C"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD7E0DD"/></left><right style="thin"><color rgb="FFD7E0DD"/></right><top style="thin"><color rgb="FFD7E0DD"/></top><bottom style="thin"><color rgb="FFD7E0DD"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="16"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="1" applyFont="1" applyBorder="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="166" fontId="1" fillId="3" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="167" fontId="1" fillId="3" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="167" fontId="1" fillId="3" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="167" fontId="2" fillId="4" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": xlsxSheetXml(rows(sheets.summary), [28, 26, 20, 22]),
    "xl/worksheets/sheet2.xml": xlsxSheetXml(detailSheetRows, [13, 9, 9, 10, 11, 14, 14, 11, 14, 14, 15, 15, 28, 45, 16]),
    "xl/worksheets/sheet3.xml": xlsxSheetXml(financialSheetRows, [13, 20, 50, 16, 22]),
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>INDUS URE</dc:creator><dc:title>Obračun delavca</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>INDUS URE</Application><TitlesOfParts><vt:vector size="3" baseType="lpstr"><vt:lpstr>Povzetek</vt:lpstr><vt:lpstr>Vnosi</vt:lpstr><vt:lpstr>Finančni vnosi</vt:lpstr></vt:vector></TitlesOfParts></Properties>`
  };
  const safeWorker = String(report.worker.name || report.worker.id || "delavec").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "delavec";
  res.writeHead(200, securityHeaders({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": attachmentContentDisposition(`indus-ure-obracun-${safeWorker}-${report.range.from}-${report.range.to}.xlsx`),
    "Cache-Control": "no-store"
  }));
  await new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", reject);
    res.on("finish", resolve);
    archive.pipe(res);
    for (const [filename, content] of Object.entries(xml)) archive.append(content, { name: filename });
    archive.finalize().catch(reject);
  });
}

function dailyReportBossEmail(db) {
  const boss = Object.values(db?.users || {}).find((user) => user?.role === "boss" && user.active !== false);
  return String(boss?.email || GOOGLE_DRIVE_OWNER_EMAIL || "").trim().toLowerCase();
}

function workerDailyReportSettings(db, worker) {
  const settings = worker?.dailyReport && typeof worker.dailyReport === "object" ? worker.dailyReport : {};
  const requestedRecipient = String(settings.recipientEmail || "").trim().toLowerCase();
  const fallbackRecipient = dailyReportBossEmail(db);
  return {
    // Keep the established daily-report behaviour for existing workers, while
    // allowing the boss to turn it off per worker.
    emailEnabled: settings.emailEnabled !== false,
    recipientEmail: validEmailAddress(requestedRecipient) ? requestedRecipient : fallbackRecipient,
    includeZeroHours: settings.includeZeroHours === true
  };
}

function shouldSendWorkerDailyReport(report, settings) {
  if (!settings?.emailEnabled || !validEmailAddress(settings.recipientEmail)) return false;
  return Boolean(settings.includeZeroHours)
    || Number(report?.totals?.hours || 0) > 0
    // A warning has operational value even when the calculated total is zero.
    || (report?.warnings || []).length > 0;
}

function workerHasBusinessData(db, userId) {
  const targetId = cleanUserId(userId);
  if (!targetId) return false;
  const refersToUser = (value) => {
    if (!value || typeof value !== "object") return false;
    for (const [key, candidate] of Object.entries(value)) {
      if (["syncUser", "createdBy", "updatedBy", "trashedBy", "workerId", "person", "creditedWorkerId", "archivedBy", "userId", "assigneeId"].includes(key) && String(candidate || "") === targetId) return true;
      if (["assigneeIds", "recipientUserIds", "userIds", "workerIds"].includes(key) && Array.isArray(candidate) && candidate.map(String).includes(targetId)) return true;
      if (candidate && typeof candidate === "object" && refersToUser(candidate)) return true;
    }
    return false;
  };
  return [db.entries, db.todos, db.debts, db.advances, db.personalPurchases, db.payrolls, db.clientBills, db.billingLocks, db.auditLog]
    .some((collection) => Array.isArray(collection) && collection.some(refersToUser));
}

function publicWorkerManagementUser(db, user) {
  return {
    id: user.id,
    name: user.name || user.id,
    email: user.email || "",
    role: user.role || "worker",
    active: user.active !== false,
    employmentType: user.employmentType || "contractor",
    timeEntryForIds: timeEntryTargetIds(db, user),
    dailyReport: workerDailyReportSettings(db, user)
  };
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

// A worker's payroll periods form an inclusive, contiguous timeline. Each
// calendar day therefore belongs to exactly one payroll: the next period must
// begin on the day after the previous one ends.
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
    const nextDay = payrollNextDate(previous.to);
    if (current.from <= previous.to) return "Obra\u010dunski obdobji se prekrivata.";
    if (current.from > nextDay) return "Za\u010detek obra\u010duna mora biti " + nextDay + ".";
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
    return range.to <= today;
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
function scheduledPayrollMinutesForTodo(todo) {
  if (!todo || !/^\d{4}-\d{2}-\d{2}$/.test(String(todo.date || ""))) return null;
  const start = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(todo.start || ""));
  const end = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(todo.end || ""));
  if (!start || !end) return null;
  const minutes = (Number(end[1]) * 60 + Number(end[2])) - (Number(start[1]) * 60 + Number(start[2]));
  return minutes > 0 ? minutes : null;
}

function payrollMinutesForTodo(db, todo) {
  if (!todo || !PAYROLL_PAID_TODO_STATUSES.has(todo.status)) return null;
  const minutes = scheduledPayrollMinutesForTodo(todo);
  if (!minutes) return null;
  if (todo.status === "meal") {
    const mealPaidMinutes = Math.round(nonnegativeNumber(db?.settings?.billing?.mealPaidMinutes, 45, 240));
    return Math.min(minutes, mealPaidMinutes) || null;
  }
  return minutes;
}

function payrollLineForTodo(db, todo, workerId = "") {
  const minutes = payrollMinutesForTodo(db, todo);
  if (!minutes) return null;
  const scheduledMinutes = scheduledPayrollMinutesForTodo(todo) || minutes;
  const unpaidMealMinutes = todo.status === "meal" ? Math.max(0, scheduledMinutes - minutes) : 0;
  const hourlyRate = nonnegativeNumber(todo.billingHourlyRate, defaultHourlyRateForUser(db, todo.syncUser || todo.createdBy), 10_000);
  const workerKm = nonnegativeNumber(todo.billingKm, 0, 1_000_000);
  // Kilometrina delavca je povračilo za njegovo lastno vozilo.
  // Ne sme se mešati s tarifo, ki se zaračuna stranki za kombi ali osebni avto.
  const kmRate = nonnegativeNumber(
    db.settings?.billing?.workerOwnVehicleKmRate,
    nonnegativeNumber(db.settings?.billing?.kmRate, 0, 1_000),
    1_000
  );
  const hours = minutes / 60;
  const workAmount = Number((hours * hourlyRate).toFixed(2));
  const kmAmount = Number((workerKm * kmRate).toFixed(2));
  return {
    todoId: String(todo.id || ""),
    assignmentGroupId: String(todo.assignmentGroupId || todo.id || ""),
    workerId: String(workerId || todo.syncUser || todo.createdBy || ""),
    date: String(todo.date || ""),
    start: String(todo.start || ""),
    end: String(todo.end || ""),
    title: String(todo.title || "").slice(0, 300),
    client: String(todo.client || "").slice(0, 240),
    status: String(todo.status || ""),
    minutes,
    unpaidMealMinutes,
    hours,
    hourlyRate,
    workerKm,
    workFromHome: Boolean(todo.workFromHome),
    commuteEligible: Boolean(todo.commuteEligible),
    commuteKm: 0,
    km: workerKm,
    kmRate,
    workAmount,
    kmAmount,
    totalAmount: Number((workAmount + kmAmount).toFixed(2))
  };
}

function commuteKmOneWayForUser(db, userId) {
  return nonnegativeNumber(db.users?.[userId]?.billing?.commuteKmOneWay, 0, 1_000_000);
}

// Each worker gets the commute reimbursement once for a worked day, never once
// per task. It is attached to the first chronological line so the immutable
// payroll snapshot remains compatible with the existing task-based archive.
function withDailyCommuteInPayroll(db, workerId, lines = []) {
  const commuteKm = Number((commuteKmOneWayForUser(db, workerId) * 2).toFixed(2));
  if (!commuteKm) return lines;
  const appliedDates = new Set();
  return lines.map((line) => {
    const workerKm = nonnegativeNumber(line.workerKm, nonnegativeNumber(line.km, 0, 1_000_000), 1_000_000);
    // A remote entry is paid normally, but it cannot trigger the daily commute.
    // Do not mark its date as used so the first later on-site entry still gets
    // the one return journey reimbursement.
    // A meal is paid time but never represents a journey to work.  It must
    // neither receive the daily commute nor consume that day's commute slot.
    const addCommute = line.status !== "meal" && Boolean(line.commuteEligible) && !Boolean(line.workFromHome) && !appliedDates.has(line.date);
    if (addCommute) appliedDates.add(line.date);
    const lineCommuteKm = addCommute ? commuteKm : 0;
    const km = Number((workerKm + lineCommuteKm).toFixed(2));
    const kmAmount = Number((km * Number(line.kmRate || 0)).toFixed(2));
    return {
      ...line,
      workerKm,
      workFromHome: Boolean(line.workFromHome),
      commuteKm: lineCommuteKm,
      km,
      kmAmount,
      totalAmount: Number((Number(line.workAmount || 0) + kmAmount).toFixed(2))
    };
  });
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

function payrollClientReceipts(db, workerId, range) {
  return (db.debts || []).filter((item) => item.type === "client_receipt" && item.person === workerId && item.date >= range.from && item.date <= range.to);
}

function payrollWorkerForTodo(todo) {
  return String(todo?.syncUser || todo?.createdBy || "").trim();
}

function normalizePayroll(input, db) {
  const workerId = cleanUserId(input?.workerId);
  const range = payrollRange(input);
  if (!workerId || !db.users?.[workerId] || !range) return null;
  const lines = (Array.isArray(input?.lines) ? input.lines : []).map((line) => {
    const correction = Boolean(line?.correction || line?.correctionId);
    const minutes = Math.round(Number(line?.minutes || 0));
    const hourlyRate = nonnegativeNumber(line?.hourlyRate, null, 10_000);
    const commuteKm = correction ? signedNumber(line?.commuteKm) : nonnegativeNumber(line?.commuteKm, 0, 1_000_000);
    const workerKm = correction ? signedNumber(line?.workerKm) : nonnegativeNumber(line?.workerKm, Math.max(0, nonnegativeNumber(line?.km, 0, 1_000_000) - commuteKm), 1_000_000);
    const km = correction ? signedNumber(line?.km, workerKm + commuteKm) : Number((workerKm + commuteKm).toFixed(2));
    const kmRate = nonnegativeNumber(line?.kmRate, 0, 1_000);
    if (!String(line?.todoId || "") || (!correction && minutes <= 0) || (correction && !Number.isFinite(minutes)) || hourlyRate === null) return null;
    const scheduledMinutes = correction ? null : scheduledPayrollMinutesForTodo(line);
    const unpaidMealMinutes = !correction && String(line?.status || "") === "meal"
      ? Math.max(0, Number.isFinite(scheduledMinutes) ? scheduledMinutes - minutes : Math.round(Number(line?.unpaidMealMinutes || 0)))
      : 0;
    const hours = correction ? signedNumber(line?.hours, minutes / 60) : minutes / 60;
    const workAmount = correction ? signedNumber(line?.workAmount, hours * hourlyRate) : Number((hours * hourlyRate).toFixed(2));
    const kmAmount = correction ? signedNumber(line?.kmAmount, km * kmRate) : Number((km * kmRate).toFixed(2));
    return {
      todoId: String(line.todoId),
      sourceTodoId: correction ? String(line?.sourceTodoId || "") : "",
      correctionId: correction ? String(line?.correctionId || "") : "",
      correction,
      assignmentGroupId: String(line.assignmentGroupId || line.todoId),
      workerId,
      date: String(line.date || ""),
      start: String(line.start || ""),
      end: String(line.end || ""),
      title: String(line.title || "").slice(0, 300),
      client: String(line.client || "").slice(0, 240),
      status: String(line.status || ""),
      minutes,
      unpaidMealMinutes,
      hours,
      hourlyRate,
      workerKm,
      workFromHome: Boolean(line?.workFromHome),
      commuteKm,
      km,
      kmRate,
      workAmount: Number(workAmount.toFixed(2)),
      kmAmount: Number(kmAmount.toFixed(2)),
      totalAmount: Number((correction ? signedNumber(line?.totalAmount, workAmount + kmAmount) : workAmount + kmAmount).toFixed(2))
    };
  }).filter(Boolean);
  const totals = payrollTotals(lines);
  const advanceIds = [...new Set((Array.isArray(input?.advanceIds) ? input.advanceIds : []).map(String).filter(Boolean))];
  const advanceAmount = Number((Number(input?.advanceAmount || 0)).toFixed(2));
  const clientReceiptIds = [...new Set((Array.isArray(input?.clientReceiptIds) ? input.clientReceiptIds : []).map(String).filter(Boolean))];
  const clientReceiptAmount = Number((Number(input?.clientReceiptAmount || 0)).toFixed(2));
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
    clientReceiptIds,
    clientReceiptAmount,
    personalPurchaseIds,
    personalPurchaseAmount,
    payoutAmount: Number((totals.totalAmount + advanceAmount + clientReceiptAmount - personalPurchaseAmount).toFixed(2)),
    payments,
    paidAmount: Number((status === "paid" && payments.length === 0 ? Math.max(0, totals.totalAmount + advanceAmount + clientReceiptAmount - personalPurchaseAmount) : payments.reduce((sum, payment) => sum + payment.amount, 0)).toFixed(2)),
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
  payroll.payoutAmount = Number(Number(payroll.payoutAmount || 0).toFixed(2));
  if (payroll.payoutAmount <= 0) {
    payroll.paidAmount = 0;
    payroll.remainingAmount = payroll.payoutAmount;
    return payroll;
  }
  payroll.paidAmount = Math.min(payroll.payoutAmount, Math.max(0, Number(payroll.paidAmount || 0)));
  payroll.remainingAmount = Number((payroll.payoutAmount - payroll.paidAmount).toFixed(2));
  return payroll;
}
function lockedPayrollLineTodoIds(db, excludeId = "", workerId = "") {
  return new Set((db.payrolls || [])
    .filter((payroll) => payroll.id !== excludeId
      && ["archiving", "confirmed", "paid"].includes(payroll.status)
      && (!workerId || String(payroll.workerId || "") === String(workerId)))
    .flatMap((payroll) => payroll.lines || [])
    .map((line) => String(line.todoId || ""))
    .filter(Boolean));
}

function lockedPayrollFinancialIds(db, field, excludeId = "") {
  return new Set((db.payrolls || [])
    .filter((payroll) => payroll.id !== excludeId && ["archiving", "confirmed", "paid"].includes(payroll.status))
    .flatMap((payroll) => Array.isArray(payroll[field]) ? payroll[field] : [])
    .map((id) => String(id || ""))
    .filter(Boolean));
}
function buildPayrollSnapshot(db, workerId, rangeInput, previous = {}, note = undefined) {
  const range = payrollRange(rangeInput);
  if (!range) return null;
  // A task transferred after a confirmed account remains available to its new
  // worker. The former worker is balanced by a separate correction row.
  const lockedElsewhere = lockedPayrollLineTodoIds(db, previous.id, workerId);
  const lockedAdvanceIds = lockedPayrollFinancialIds(db, "advanceIds", previous.id);
  const lockedClientReceiptIds = lockedPayrollFinancialIds(db, "clientReceiptIds", previous.id);
  const lockedPersonalPurchaseIds = lockedPayrollFinancialIds(db, "personalPurchaseIds", previous.id);
  const taskLines = withDailyCommuteInPayroll(db, workerId, (db.todos || [])
    .filter((todo) => !todo.imported && !isTrashedTodo(todo) && (todo.syncUser || todo.createdBy) === workerId && !todo.archivedAt && String(todo.date || "") >= range.from && String(todo.date || "") <= range.to)
    .filter((todo) => !lockedElsewhere.has(String(todo.id || "")))
    .map((todo) => payrollLineForTodo(db, todo, workerId))
    .filter(Boolean));
  const correctionLines = (db.settlementCorrections || [])
    .filter((correction) => correction.type === "worker" && correction.status === "pending" && String(correction.workerId || "") === workerId)
    .filter((correction) => String(correction.effectiveDate || "") >= range.from && String(correction.effectiveDate || "") <= range.to)
    .map(correctionPayrollLine)
    .filter((line) => !lockedElsewhere.has(String(line.todoId || "")));
  const lines = [...taskLines, ...correctionLines]
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  const advances = payrollAdvances(db, workerId, range)
    .filter((item) => !lockedAdvanceIds.has(String(item.id || "")));
  const clientReceipts = payrollClientReceipts(db, workerId, range)
    .filter((item) => !lockedClientReceiptIds.has(String(item.id || "")));
  const personalPurchases = payrollPersonalPurchases(db, workerId, range)
    .filter((item) => !lockedPersonalPurchaseIds.has(String(item.id || "")));
  return normalizePayroll({ ...previous, workerId, ...range, lines, advanceIds: advances.map((item) => item.id), advanceAmount: advances.reduce((total, item) => total + Number(item.amount || 0), 0), clientReceiptIds: clientReceipts.map((item) => item.id), clientReceiptAmount: clientReceipts.reduce((total, item) => total + Number(item.amount || 0), 0), personalPurchaseIds: personalPurchases.map((item) => item.id), personalPurchaseAmount: personalPurchases.reduce((total, item) => total + Number(item.amount || 0), 0), note: note === undefined ? previous.note : note }, db);
}

function payrollForUser(db, user) {
  const payrolls = db.payrolls || [];
  return user.role === "boss" ? payrolls : payrolls.filter((payroll) => payroll.workerId === user.id);
}

function payrollLockForTodos(db, todos = []) {
  const todoWorkerById = new Map(todos
    .filter(Boolean)
    .map((todo) => [String(todo.id || ""), payrollWorkerForTodo(todo)])
    .filter(([id, workerId]) => id && workerId));
  if (!todoWorkerById.size) return null;
  return (db.payrolls || []).find((payroll) => ["archiving", "confirmed", "paid"].includes(payroll.status)
    && (payroll.lines || []).some((line) => String(payroll.workerId || "") === todoWorkerById.get(String(line.todoId || "")))) || null;
}

// Confirmed payrolls/client bills are immutable.  A later edit produces a
// correction row; the following account contains just that difference.
function signedNumber(value, fallback = 0, maximum = 1_000_000) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= maximum ? number : fallback;
}
function correctionDateKey(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Ljubljana", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return parts.year + "-" + parts.month + "-" + parts.day;
}
function confirmedPayrollLineForTodo(db, todoId) {
  const matches = [];
  for (const payroll of db.payrolls || []) {
    if (!["confirmed", "paid"].includes(String(payroll?.status || ""))) continue;
    for (const line of payroll.lines || []) if (String(line?.todoId || "") === String(todoId || "")) matches.push({ payroll, line });
  }
  return matches.sort((left, right) => String(right.payroll.confirmedAt || "").localeCompare(String(left.payroll.confirmedAt || "")))[0] || null;
}
function latestCorrection(db, predicate) {
  return (db.settlementCorrections || []).filter(predicate).sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))[0] || null;
}
function workerCorrectionSnapshot(db, todo, fallback = {}) {
  const raw = payrollLineForTodo(db, todo, todo?.syncUser || todo?.createdBy || "");
  const hourlyRate = nonnegativeNumber(todo?.billingHourlyRate, nonnegativeNumber(fallback.hourlyRate, 0, 10_000), 10_000);
  const kmRate = nonnegativeNumber(fallback.kmRate, nonnegativeNumber(db.settings?.billing?.workerOwnVehicleKmRate, 0, 1_000), 1_000);
  const minutes = Number(raw?.minutes || 0);
  const workerKm = nonnegativeNumber(todo?.billingKm, 0, 1_000_000);
  const commuteKm = nonnegativeNumber(fallback.commuteKm, 0, 1_000_000);
  const km = Number((workerKm + commuteKm).toFixed(2));
  const workAmount = Number((minutes / 60 * hourlyRate).toFixed(2));
  const kmAmount = Number((km * kmRate).toFixed(2));
  return { todoId: String(todo?.id || fallback.todoId || ""), assignmentGroupId: String(todo?.assignmentGroupId || fallback.assignmentGroupId || ""), workerId: String(todo?.syncUser || todo?.createdBy || fallback.workerId || ""), date: isDateKey(todo?.date) ? String(todo.date) : String(fallback.date || ""), start: String(todo?.start || ""), end: String(todo?.end || ""), title: String(todo?.title || fallback.title || "").slice(0, 300), client: String(todo?.client || fallback.client || "").slice(0, 240), status: String(todo?.status || fallback.status || ""), minutes, hours: Number((minutes / 60).toFixed(4)), hourlyRate, workerKm, workFromHome: Boolean(todo?.workFromHome), commuteKm, km, kmRate, workAmount, kmAmount, totalAmount: Number((workAmount + kmAmount).toFixed(2)) };
}
function workerCorrectionDelta(before = {}, after = {}) {
  const result = {};
  for (const key of ["minutes", "hours", "workerKm", "commuteKm", "km", "workAmount", "kmAmount", "totalAmount"]) result[key] = Number((signedNumber(after[key]) - signedNumber(before[key])).toFixed(key === "minutes" ? 0 : 2));
  return result;
}

function zeroWorkerCorrectionSnapshot(baseline = {}) {
  return {
    ...baseline,
    date: "",
    start: "",
    end: "",
    status: "corrected",
    minutes: 0,
    hours: 0,
    workerKm: 0,
    commuteKm: 0,
    km: 0,
    workAmount: 0,
    kmAmount: 0,
    totalAmount: 0
  };
}
function clientCorrectionSnapshot(todos = []) {
  const list = (todos || []).filter(Boolean).slice().sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")) || String(left.start || "").localeCompare(String(right.start || "")));
  const first = list[0] || {};
  const warranty = Boolean(first.warranty);
  const isMaterial = first.status === "material";
  const isClientOnly = isMaterial || first.status === "note";
  return { eventId: todoBillingEventId(first), clientId: String(first.clientId || ""), client: String(first.client || ""), date: String(first.date || ""), start: String(first.start || ""), end: String(first.end || ""), title: String(first.title || "").slice(0, 300), notes: String(first.notes || "").slice(0, 10_000), material: String(first.material || "").slice(0, 10_000), status: String(first.status || ""), externalDelivery: Boolean(first.externalDelivery), materialAmount: isMaterial ? nonnegativeNumber(first.materialAmount, 0, 1_000_000) : 0, warranty, clientKm: warranty || isClientOnly ? 0 : nonnegativeNumber(first.clientKm, 0, 1_000_000), clientVehicle: todoVehicle(first.clientVehicle), hours: warranty || isClientOnly ? 0 : clientBillableHoursForTodos(list), todoIds: list.map((todo) => String(todo.id || "")).filter(Boolean) };
}
function sameValue(left, right) { return JSON.stringify(left || {}) === JSON.stringify(right || {}); }
function pendingCorrectionsForTodo(db, todo) {
  const todoId = String(todo?.id || ""), eventId = todoBillingEventId(todo);
  return (db.settlementCorrections || []).filter((item) => item?.status === "pending" && ((item.type === "worker" && String(item.todoId || "") === todoId) || (item.type === "client" && String(item.eventId || "") === eventId)));
}
function upsertSettlementCorrections(db, beforeTodos, afterTodos, actor, now = new Date().toISOString()) {
  const preliminaryBeforeClient = clientCorrectionSnapshot(beforeTodos);
  const preliminaryAfterClient = clientCorrectionSnapshot(afterTodos);
  const preliminaryEventId = String(preliminaryBeforeClient.eventId || preliminaryAfterClient.eventId || "");
  if (confirmedClientBillByEvent(db).get(preliminaryEventId)
    && preliminaryBeforeClient.clientId && preliminaryAfterClient.clientId
    && preliminaryBeforeClient.clientId !== preliminaryAfterClient.clientId) {
    return { corrections: [], error: "Pri ?e obra?unani storitvi stranke ni mogo?e zamenjati neposredno. Najprej naredi lo?en dobropis." };
  }
  const beforeById = new Map((beforeTodos || []).map((todo) => [String(todo.id || ""), todo]));
  const afterById = new Map((afterTodos || []).map((todo) => [String(todo.id || ""), todo]));
  const result = [];
  for (const [todoId, before] of beforeById) {
    const prior = confirmedPayrollLineForTodo(db, todoId);
    const current = workerCorrectionSnapshot(db, afterById.get(todoId) || { ...before, date: "", start: "", end: "", status: "deleted", billingKm: 0 }, prior?.line || {});
    const priorWorkerId = String(prior?.line?.workerId || "");
    const reassigned = Boolean(priorWorkerId && current.workerId && priorWorkerId !== current.workerId);
    const correctionWorkerId = reassigned ? priorWorkerId : String(current.workerId || priorWorkerId || "");
    const pending = latestCorrection(db, (item) => item?.type === "worker" && item?.status === "pending"
      && String(item.todoId || "") === todoId && String(item.workerId || "") === correctionWorkerId);
    const settled = latestCorrection(db, (item) => item?.type === "worker" && item?.status === "settled"
      && String(item.todoId || "") === todoId && String(item.workerId || "") === correctionWorkerId);
    if (!prior && !pending && !settled) continue;
    const baseline = pending?.before || settled?.after || prior?.line;
    const after = reassigned ? zeroWorkerCorrectionSnapshot(baseline) : current;
    if (sameValue(baseline, after)) {
      if (pending) db.settlementCorrections = db.settlementCorrections.filter((item) => item.id !== pending.id);
      continue;
    }
    // A reassignment after a confirmed payroll is two separate facts: the
    // former worker gets a negative delta in the next account, while the new
    // worker receives the normal live entry in their still-open account.
    const correction = { id: pending?.id || crypto.randomUUID(), type: "worker", status: "pending", todoId, eventId: todoBillingEventId(before), workerId: correctionWorkerId, sourcePayrollId: String(prior?.payroll?.id || pending?.sourcePayrollId || settled?.sourcePayrollId || ""), before: baseline, after, delta: workerCorrectionDelta(baseline, after), effectiveDate: correctionDateKey(new Date(now)), createdAt: pending?.createdAt || now, createdBy: pending?.createdBy || actor?.id || "system", createdByName: pending?.createdByName || actor?.name || "", updatedAt: now, updatedBy: actor?.id || "system", updatedByName: actor?.name || "" };
    if (pending) Object.assign(pending, correction); else db.settlementCorrections.push(correction);
    result.push(correction);
  }
  const beforeClient = clientCorrectionSnapshot(beforeTodos), afterClient = clientCorrectionSnapshot(afterTodos);
  const eventId = String(beforeClient.eventId || afterClient.eventId || "");
  const clientBill = confirmedClientBillByEvent(db).get(eventId);
  const pendingClient = latestCorrection(db, (item) => item?.type === "client" && item?.status === "pending" && String(item.eventId || "") === eventId);
  const settledClient = latestCorrection(db, (item) => item?.type === "client" && item?.status === "settled" && String(item.eventId || "") === eventId);
  if (clientBill || pendingClient || settledClient) {
    const baseline = pendingClient?.before || settledClient?.after || beforeClient;
    if (baseline.clientId && afterClient.clientId && baseline.clientId !== afterClient.clientId) return { corrections: result, error: "Pri ?e obra?unani storitvi stranke ni mogo?e zamenjati neposredno. Najprej naredi lo?en dobropis." };
    if (sameValue(baseline, afterClient)) {
      if (pendingClient) db.settlementCorrections = db.settlementCorrections.filter((item) => item.id !== pendingClient.id);
    } else {
      const delta = { hours: Number((signedNumber(afterClient.hours) - signedNumber(baseline.hours)).toFixed(2)), clientKm: Number((signedNumber(afterClient.clientKm) - signedNumber(baseline.clientKm)).toFixed(2)), materialAmount: Number((signedNumber(afterClient.materialAmount) - signedNumber(baseline.materialAmount)).toFixed(2)) };
      const correction = { id: pendingClient?.id || crypto.randomUUID(), type: "client", status: "pending", eventId, clientId: String(afterClient.clientId || baseline.clientId || ""), clientName: String(afterClient.client || baseline.client || ""), sourceClientBillId: String(clientBill?.id || pendingClient?.sourceClientBillId || settledClient?.sourceClientBillId || ""), before: baseline, after: afterClient, delta, effectiveDate: correctionDateKey(), createdAt: pendingClient?.createdAt || now, createdBy: pendingClient?.createdBy || actor?.id || "system", createdByName: pendingClient?.createdByName || actor?.name || "", updatedAt: now, updatedBy: actor?.id || "system", updatedByName: actor?.name || "" };
      if (pendingClient) Object.assign(pendingClient, correction); else db.settlementCorrections.push(correction);
      result.push(correction);
    }
  }
  return { corrections: result, error: "" };
}
function correctionPayrollLine(correction) {
  const after = correction.after || {}, delta = correction.delta || {};
  return { todoId: "correction:" + correction.id, sourceTodoId: String(correction.todoId || ""), correctionId: String(correction.id || ""), correction: true, assignmentGroupId: String(after.assignmentGroupId || correction.eventId || correction.todoId || ""), workerId: String(correction.workerId || after.workerId || ""), date: String(correction.effectiveDate || correctionDateKey()), start: "", end: "", title: "Popravek: " + String(after.title || "vpis ur").slice(0, 270), client: String(after.client || ""), status: "correction", minutes: Math.round(signedNumber(delta.minutes)), unpaidMealMinutes: 0, hours: signedNumber(delta.hours), hourlyRate: nonnegativeNumber(after.hourlyRate, 0, 10_000), workerKm: signedNumber(delta.workerKm), workFromHome: Boolean(after.workFromHome), commuteKm: signedNumber(delta.commuteKm), km: signedNumber(delta.km), kmRate: nonnegativeNumber(after.kmRate, 0, 1_000), workAmount: Number(signedNumber(delta.workAmount).toFixed(2)), kmAmount: Number(signedNumber(delta.kmAmount).toFixed(2)), totalAmount: Number(signedNumber(delta.totalAmount).toFixed(2)) };
}
function settleCorrectionsForPayroll(db, payroll, actor) {
  const ids = new Set((payroll.lines || []).map((line) => String(line.correctionId || "")).filter(Boolean));
  let changed = 0;
  for (const correction of db.settlementCorrections || []) if (correction.type === "worker" && correction.status === "pending" && ids.has(correction.id)) { correction.status = "settled"; correction.workerPayrollId = payroll.id; correction.settledAt = new Date().toISOString(); correction.settledBy = actor?.id || "system"; changed += 1; }
  return changed;
}
function settleCorrectionsForClientBill(db, bill, actor) {
  const ids = new Set((bill.correctionIds || []).map(String).filter(Boolean));
  let changed = 0;
  for (const correction of db.settlementCorrections || []) if (correction.type === "client" && correction.status === "pending" && ids.has(correction.id)) { correction.status = "settled"; correction.clientBillId = bill.id; correction.settledAt = new Date().toISOString(); correction.settledBy = actor?.id || "system"; changed += 1; }
  return changed;
}

function todoBillingEventId(todo) {
  return String(todo?.assignmentGroupId || todo?.id || "").trim();
}

function todoRequiresClientBilling(todo) {
  return Boolean(todo && !todo.imported && ["execution", "material", "note"].includes(String(todo.status || "")) && String(todo.clientId || todo.client || "").trim());
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
  return (db.clients || []).find((client) => [client.clientId, client.id, client.name, client.search, client.taxId, client.registryNumber]
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
      clientBillableMinutes: normalizedClientBillableMinutes(line?.clientBillableMinutes),
      warranty: Boolean(line?.warranty),
      status: String(line?.status || "").slice(0, 40),
      materialAmount: nonnegativeNumber(line?.materialAmount, 0, 1_000_000),
      externalDelivery: Boolean(line?.externalDelivery),
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
    // A direct settlement records the actual amount paid by the client. The
    // normal client report intentionally does not calculate a client price.
    directSettlement: Boolean(input?.directSettlement),
    receivedAmount: nonnegativeNumber(input?.receivedAmount, 0, 1_000_000),
    creditedWorkerId: cleanUserId(input?.creditedWorkerId),
    creditedWorkerName: String(input?.creditedWorkerName || "").trim().slice(0, 120),
    clientReceiptId: String(input?.clientReceiptId || "").trim().slice(0, 100),
    note: String(input?.note || "").trim().slice(0, 2_000)
  };
}

function cancelClientBill(db, billId, actor = null) {
  const bill = (db.clientBills || []).find((item) => String(item?.id || "") === String(billId || ""));
  if (!bill || !clientBillIsConfirmed(bill)) return null;
  const linkedReceiptId = String(bill.clientReceiptId || "");
  if (linkedReceiptId) {
    const referencedPayroll = (db.payrolls || []).find((payroll) => (payroll.clientReceiptIds || []).map(String).includes(linkedReceiptId));
    if (referencedPayroll) {
      return { error: "Neposrednega poračuna ni mogoče preklicati, ker je plačilo že vključeno v obračun delavca. Najprej odpri ali popravi ta obračun." };
    }
    db.debts = (db.debts || []).filter((item) => String(item?.id || "") !== linkedReceiptId);
  }
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
      const current = byEvent.get(eventId);
      if (!current || String(current.confirmedAt || "") <= String(bill.confirmedAt || "")) byEvent.set(eventId, bill);
    }
  }
  return byEvent;
}

function clientBillLockForTodos(db, todos = []) {
  const bills = confirmedClientBillByEvent(db);
  return todos.map((todo) => bills.get(todoBillingEventId(todo))).find(Boolean) || null;
}

function clientBillEditLockMessage(bill) {
  const clientName = String(bill?.clientName || bill?.client || "stranko").trim() || "stranko";
  return `Dogodek je že v potrjenem obračunu stranki ${clientName} in je zaklenjen. Za dodatno delo ali popravek ustvari nov dogodek.`;
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
    if (isTrashedTodo(todo) || !todoRequiresClientBilling(todo)) continue;
    if (String(todo.clientId || "") !== String(client.clientId || "") && String(todo.client || "").trim().toLowerCase() !== String(client.name || "").trim().toLowerCase()) continue;
    if ((from && String(todo.date || "") < from) || (to && String(todo.date || "") > to)) continue;
    const eventId = todoBillingEventId(todo);
    // A confirmed customer bill is immutable.  Older data can still contain
    // pending correction markers from the former workflow, but those markers
    // must never make the original event billable a second time.
    if (!eventId || billed.has(eventId)) continue;
    if (requestedEventIds && !requestedEventIds.has(eventId)) continue;
    if (!groups.has(eventId)) groups.set(eventId, []);
    groups.get(eventId).push(todo);
  }
  return { client, groups: [...groups.entries()].map(([eventId, todos]) => ({ eventId, todos })), requestedEventIds };
}

function optionalReportHours(todo = {}) {
  const raw = todo?.reportHours;
  if (raw === null || raw === "" || typeof raw === "undefined") return null;
  const hours = Number(raw);
  return Number.isFinite(hours) ? hours : null;
}
function todoDurationHours(todo = {}) {
  const reportHours = optionalReportHours(todo);
  if (reportHours !== null) return reportHours;
  const start = /^(\d{2}):(\d{2})$/.exec(String(todo.start || ""));
  const end = /^(\d{2}):(\d{2})$/.exec(String(todo.end || ""));
  if (!start || !end) return 0;
  const startMinutes = Number(start[1]) * 60 + Number(start[2]);
  const endMinutes = Number(end[1]) * 60 + Number(end[2]);
  return endMinutes > startMinutes ? (endMinutes - startMinutes) / 60 : 0;
}

// Customer-billable time is deliberately independent from the worker's
// attendance. null means automatic mode: it follows the actual worker
// duration. A number is a boss-approved manual amount, rounded to the same
// quarter-hour precision as the time picker. We keep the value in minutes so
// zero remains an intentional, unambiguous customer charge.
function normalizedClientBillableMinutes(value) {
  const minutes = nonnegativeNumber(value, null, 1_000_000);
  return minutes === null ? null : Math.round(minutes / 15) * 15;
}

function todoClientBillableMinutes(todo = {}) {
  const reportHours = optionalReportHours(todo);
  if (reportHours !== null) return Math.round(reportHours * 60);
  const manual = normalizedClientBillableMinutes(todo.clientBillableMinutes);
  return manual === null ? Math.round(todoDurationHours(todo) * 60) : manual;
}

function clientBillableMinutesForTodos(todos = []) {
  const list = (todos || []).filter(Boolean);
  // An assignment group is one customer event. When its boss has set one
  // shared manual amount, take it once instead of adding the same value for
  // every assigned worker.
  const manual = list.map((todo) => normalizedClientBillableMinutes(todo.clientBillableMinutes))
    .find((minutes) => minutes !== null);
  return manual === undefined ? list.reduce((sum, todo) => sum + todoClientBillableMinutes(todo), 0) : manual;
}

function clientBillableHoursForTodos(todos = []) {
  return Number((clientBillableMinutesForTodos(todos) / 60).toFixed(2));
}

function clientBillableHoursWarning(beforeTodos = [], afterTodos = []) {
  const beforeManual = (beforeTodos || []).map((todo) => normalizedClientBillableMinutes(todo?.clientBillableMinutes))
    .find((minutes) => minutes !== null);
  if (beforeManual === undefined) return null;
  const beforeWorkerMinutes = Math.round((beforeTodos || []).reduce((sum, todo) => sum + todoDurationHours(todo) * 60, 0));
  const afterWorkerMinutes = Math.round((afterTodos || []).reduce((sum, todo) => sum + todoDurationHours(todo) * 60, 0));
  if (beforeWorkerMinutes === afterWorkerMinutes) return null;
  return {
    clientBillableHours: Number((beforeManual / 60).toFixed(2)),
    beforeWorkerHours: Number((beforeWorkerMinutes / 60).toFixed(2)),
    afterWorkerHours: Number((afterWorkerMinutes / 60).toFixed(2))
  };
}
function clientReportSelection(db, input = {}) {
  const selection = clientBillCandidates(db, input);
  if (!selection.client || !selection.groups.length) return null;
  if (selection.requestedEventIds && selection.groups.length !== selection.requestedEventIds.size) return null;
  const groups = selection.groups.map((group) => {
    const todos = [...group.todos].sort((left, right) => String(left.date || "").localeCompare(String(right.date || ""))
      || String(left.start || "").localeCompare(String(right.start || ""))
      || String(left.id || "").localeCompare(String(right.id || "")));
    const correction = latestCorrection(db, (item) => item?.type === "client" && item?.status === "pending" && String(item.eventId || "") === String(group.eventId));
    if (!correction || !todos.length) return { eventId: group.eventId, todos };
    const representative = todos[0];
    return { eventId: group.eventId, todos: [{ ...representative, title: "Popravek obračuna: " + String(correction.after?.title || representative.title || "storitev"), start: "", end: "", reportHours: signedNumber(correction.delta?.hours), clientKm: signedNumber(correction.delta?.clientKm), materialAmount: signedNumber(correction.delta?.materialAmount), externalDelivery: Boolean(correction.after?.externalDelivery), status: correction.after?.status || representative.status, clientVehicle: correction.after?.clientVehicle || representative.clientVehicle, notes: "Popravek že potrjene storitve. Poročilo vsebuje samo razliko glede na prvotni obračun.", material: correction.after?.material || "" }] };
  }).sort((left, right) => {
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

function clientReportRequestIsValid(input) {
  return Boolean(input && typeof input === "object" && !Array.isArray(input))
    && (input.eventIds === undefined || Array.isArray(input.eventIds));
}

function clientReportDownloadPayload(input = {}) {
  const cleanList = (value, max = 1_000) => Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim().slice(0, 240)).filter(Boolean))].slice(0, max)
    : undefined;
  return {
    clientId: String(input.clientId || "").trim().slice(0, 160),
    clientName: String(input.clientName || "").trim().slice(0, 240),
    from: isDateKey(input.from) ? String(input.from) : "",
    to: isDateKey(input.to) ? String(input.to) : "",
    eventIds: cleanList(input.eventIds),
    attachmentIds: cleanList(input.attachmentIds),
    exportOptions: clientReportExportOptions(input.exportOptions)
  };
}

function pruneClientReportDownloadTickets(now = Date.now()) {
  for (const [token, ticket] of clientReportDownloadTickets) {
    if (Number(ticket?.expiresAt || 0) <= now) clientReportDownloadTickets.delete(token);
  }
  while (clientReportDownloadTickets.size > MAX_CLIENT_REPORT_DOWNLOAD_TICKETS) {
    const oldest = clientReportDownloadTickets.keys().next().value;
    if (!oldest) break;
    clientReportDownloadTickets.delete(oldest);
  }
}

function createClientReportDownloadTicket(req, user, payload) {
  pruneClientReportDownloadTickets();
  const token = crypto.randomBytes(32).toString("base64url");
  clientReportDownloadTickets.set(token, {
    userId: String(user?.id || ""),
    sessionHash: sessionTokenHash(sessionTokenFromRequest(req)),
    payload: clientReportDownloadPayload(payload),
    expiresAt: Date.now() + CLIENT_REPORT_DOWNLOAD_TICKET_TTL_MS
  });
  return token;
}

function clientReportDownloadTicketForRequest(req, user, token) {
  pruneClientReportDownloadTickets();
  const ticket = clientReportDownloadTickets.get(String(token || ""));
  if (!ticket) return null;
  const sameUser = ticket.userId && ticket.userId === String(user?.id || "");
  const sameSession = ticket.sessionHash && ticket.sessionHash === sessionTokenHash(sessionTokenFromRequest(req));
  return sameUser && sameSession ? ticket : null;
}

function pruneTodoSharePdfDownloadTickets(now = Date.now()) {
  for (const [token, ticket] of todoSharePdfDownloadTickets) {
    if (Number(ticket?.expiresAt || 0) <= now) todoSharePdfDownloadTickets.delete(token);
  }
  while (todoSharePdfDownloadTickets.size > MAX_CLIENT_REPORT_DOWNLOAD_TICKETS) {
    const oldest = todoSharePdfDownloadTickets.keys().next().value;
    if (!oldest) break;
    todoSharePdfDownloadTickets.delete(oldest);
  }
}

function createTodoSharePdfDownloadTicket(req, user, todoId) {
  pruneTodoSharePdfDownloadTickets();
  const token = crypto.randomBytes(32).toString("base64url");
  todoSharePdfDownloadTickets.set(token, {
    userId: String(user?.id || ""),
    sessionHash: sessionTokenHash(sessionTokenFromRequest(req)),
    todoId: String(todoId || ""),
    expiresAt: Date.now() + CLIENT_REPORT_DOWNLOAD_TICKET_TTL_MS
  });
  return token;
}

function todoSharePdfDownloadTicketForRequest(req, user, token) {
  pruneTodoSharePdfDownloadTickets();
  const ticket = todoSharePdfDownloadTickets.get(String(token || ""));
  if (!ticket) return null;
  const sameUser = ticket.userId && ticket.userId === String(user?.id || "");
  const sameSession = ticket.sessionHash && ticket.sessionHash === sessionTokenHash(sessionTokenFromRequest(req));
  return sameUser && sameSession ? ticket : null;
}

function safeReportFileName(value, fallback = "priloga") {
  const cleaned = String(value || "").trim()
    .replace(/[\/:*?"<>|\u0000-\u001f]+/g, "-")
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
  const hoursMode = ["client_billable", "worker_total", "worker_time"].includes(String(input?.hoursMode || ""))
    ? String(input.hoursMode)
    : "client_billable";
  const heading = String(input?.heading || "").trim().slice(0, 120);
  return { hoursMode, heading };
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

function reportPdfEnsureSpace(doc, height = 0) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) doc.addPage();
}

function reportPdfAttachmentPreviews(doc, attachments = []) {
  const images = attachments.filter((attachment) => /^image\/(jpeg|png)$/i.test(String(attachment?.mimeType || '')));
  for (const [index, attachment] of images.entries()) {
    reportPdfEnsureSpace(doc, 218);
    const label = reportPdfAttachmentTitle(attachment, index + 1);
    doc.font(reportPdfFontPath('bold')).fontSize(10).fillColor('#1e3430').text(label);
    const x = doc.page.margins.left;
    const y = doc.y + 5;
    try {
      // Half of the printable A4 width keeps reports readable while retaining
      // enough detail for photos from the field.
      doc.image(attachment.bytes, x, y, { fit: [250, 180], align: 'left', valign: 'top' });
      if (String(attachment.driveUrl || '').trim()) doc.link(x, y, 250, 180, attachment.driveUrl);
      doc.y = y + 188;
    } catch {
      reportPdfLine(doc, 'Priloga', 'Slike ni bilo mogo\u010de vgraditi; v PDF je prilo\u017een izvirnik.');
    }
  }
}

function buildClientReportPdf(db, report, attachments = [], exportOptions = {}) {
  const options = clientReportExportOptions(exportOptions);
  const heading = options.heading || 'Obra\u010dun opravljenih storitev';
  const title = `${heading} - ${safeReportFileName(report.client?.name || 'stranka')}`;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 46,
      info: { Title: title, Author: 'INDUS URE', Subject: heading }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.font(reportPdfFontPath('bold')).fontSize(21).fillColor('#0d536b').text(heading);
      doc.moveDown(0.3);
      doc.font(reportPdfFontPath()).fontSize(11).fillColor('#263634');
      reportPdfLine(doc, 'Stranka', report.client?.name || '');
      if (report.client?.email) reportPdfLine(doc, 'E-po\u0161ta', report.client.email);
      if (report.from || report.to) reportPdfLine(doc, 'Obdobje', `${report.from ? reportPdfDate(report.from) : '-'} - ${report.to ? reportPdfDate(report.to) : '-'}`);
      doc.moveDown(0.8);

      for (const group of report.groups || []) {
        const todo = group.todos?.[0] || {};
        const warranty = Boolean(todo.warranty);
        const materialEntry = todo.status === "material";
        const noteEntry = todo.status === "note";
        const clientBillableHours = warranty || materialEntry || noteEntry ? 0 : clientBillableHoursForTodos(group.todos);
        const workerHours = warranty || materialEntry || noteEntry ? 0 : Number((group.todos || []).reduce((sum, item) => sum + todoDurationHours(item), 0).toFixed(2));
        const hours = options.hoursMode === "client_billable" ? clientBillableHours : workerHours;
        const clientKm = warranty || materialEntry || noteEntry ? 0 : Math.max(0, Number(todo.clientKm || 0));
        doc.font(reportPdfFontPath('bold')).fontSize(13).fillColor('#143b34').text(reportPdfDate(todo.date));
        doc.font(reportPdfFontPath('bold')).fontSize(12).fillColor('#161f20').text(String(todo.title || 'Brez naziva'));
        doc.font(reportPdfFontPath()).fontSize(10).fillColor('#263634');
        if (!materialEntry && !noteEntry) reportPdfLine(doc, 'Izvajalec', reportPdfAssignees(db, group.todos));
        if (options.hoursMode === "worker_time" && !materialEntry && !noteEntry) {
          const workerTimes = (group.todos || []).filter((item) => item.start && item.end)
            .map((item) => reportPdfAssigneeTitle(db, item) + ': ' + item.start + '-' + item.end).join(', ');
          if (workerTimes) reportPdfLine(doc, '\u010cas izvajalcev', workerTimes);
        }
        if (materialEntry) reportPdfLine(doc, todo.externalDelivery ? 'Dostava' : 'Vrsta vpisa', todo.externalDelivery ? 'Material je neposredno dostavil zunanji dobavitelj.' : 'Material brez izvajalca.');
        if (noteEntry) reportPdfLine(doc, 'Vrsta vpisa', 'Zapisek brez obračuna ur in kilometrine.');
        if (warranty) reportPdfLine(doc, 'Garancija', 'Storitev se ne obra\u010dunava stranki.');
        if (hours) reportPdfLine(doc, options.hoursMode === "client_billable" ? 'Za obra\u010dun' : 'Ure izvajalcev', hours.toLocaleString('sl-SI', { maximumFractionDigits: 2 }) + ' h');
        if (clientKm) reportPdfLine(doc, 'Stro\u0161ki prevoza (obe smeri)', `${reportPdfVehicleLabel(todo.clientVehicle)} - ${clientKm.toLocaleString('sl-SI', { maximumFractionDigits: 1 })} km`);
        if (todo.notes) reportPdfLine(doc, 'Opis del', todo.notes);
        if (todo.material) reportPdfLine(doc, 'Material', todo.material);
        const driveFiles = [...new Map(group.todos.flatMap((item) => item.driveFiles || []).filter((file) => file?.url).map((file) => [file.url, file])).values()];
        for (const file of driveFiles) reportPdfDriveFileLink(doc, file);
        const groupAttachments = attachments.filter((attachment) => attachment.eventId === group.eventId);
        if (groupAttachments.length) reportPdfAttachmentLinks(doc, groupAttachments);
        reportPdfAttachmentPreviews(doc, groupAttachments);
        doc.moveDown(0.75);
        reportPdfEnsureSpace(doc, 20);
        doc.strokeColor('#a9c5bd').lineWidth(1.4).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
        doc.moveDown(0.75);
      }

      const workerHoursByWorker = new Map();
      const travel = { personal: 0, van: 0 };
      const totalHours = (report.groups || []).reduce((sum, group) => {
        const representative = group.todos?.[0] || {};
        if (['material', 'note'].includes(representative.status)) return sum;
        if (representative.warranty) return sum;
        const vehicle = representative.clientVehicle === 'van' ? 'van' : 'personal';
        travel[vehicle] += Math.max(0, Number(representative.clientKm || 0));
        const clientBillableHours = clientBillableHoursForTodos(group.todos || []);
        const workerHours = (group.todos || []).reduce((hours, item) => hours + todoDurationHours(item), 0);
        if (options.hoursMode !== "client_billable") {
          for (const item of group.todos || []) {
            const workerHoursForItem = todoDurationHours(item);
            if (!workerHoursForItem) continue;
            const label = reportPdfAssigneeTitle(db, item);
            workerHoursByWorker.set(label, (workerHoursByWorker.get(label) || 0) + workerHoursForItem);
          }
        }
        return sum + (options.hoursMode === "client_billable" ? clientBillableHours : workerHours);
      }, 0);
      reportPdfEnsureSpace(doc, 105);
      doc.moveDown(0.4);
      doc.font(reportPdfFontPath('bold')).fontSize(13).fillColor('#0d536b').text(options.hoursMode === "client_billable" ? 'Ure za obra\u010dun' : 'Ure izvajalcev');
      if (options.hoursMode !== "client_billable" && workerHoursByWorker.size) {
        [...workerHoursByWorker.entries()].sort(([left], [right]) => left.localeCompare(right, 'sl')).forEach(([label, hours]) => {
          reportPdfLine(doc, label, hours.toLocaleString('sl-SI', { maximumFractionDigits: 2 }) + ' h');
        });
      }
      reportPdfLine(doc, 'Skupaj', totalHours.toLocaleString('sl-SI', { maximumFractionDigits: 2 }) + ' h');
      if (travel.personal || travel.van) {
        doc.moveDown(0.35);
        doc.font(reportPdfFontPath('bold')).fontSize(13).fillColor('#0d536b').text('Skupaj prevoza');
        if (travel.personal) reportPdfLine(doc, 'Osebni avto', `${travel.personal.toLocaleString('sl-SI', { maximumFractionDigits: 1 })} km`);
        if (travel.van) reportPdfLine(doc, 'Kombi', `${travel.van.toLocaleString('sl-SI', { maximumFractionDigits: 1 })} km`);
        reportPdfLine(doc, 'Skupaj', `${(travel.personal + travel.van).toLocaleString('sl-SI', { maximumFractionDigits: 1 })} km`);
      }

      for (const attachment of attachments) {
        doc.file(attachment.bytes, {
          name: attachment.filename,
          type: attachment.mimeType,
          description: `Priloga: ${attachment.name}`,
          relationship: 'Supplement'
        });
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function sendClientReportPdf(res, db, body) {
  const report = clientReportSelection(db, body);
  if (!report) {
    sendJson(res, 409, { error: "Izbrani vpisi niso več na voljo za poročilo. Osveži pogled in preveri izbor." });
    return false;
  }
  let attachments;
  try {
    const requestedAttachments = clientReportAttachmentSelection(report, body.attachmentIds);
    attachments = await loadClientReportAttachments(db, requestedAttachments, { destination: "PDF" });
  } catch (error) {
    console.error("Prilog za PDF poročilo ni bilo mogoče pripraviti:", error?.message || error);
    sendJson(res, 400, { error: "Izbrane priloge za PDF poročilo niso na voljo. Osveži pogled in poskusi znova." });
    return false;
  }
  let pdf;
  try {
    pdf = await buildClientReportPdf(db, report, attachments, body.exportOptions);
  } catch (error) {
    console.error("PDF poročila ni bilo mogoče ustvariti:", error?.message || error);
    sendJson(res, 500, { error: "PDF poročila ni bilo mogoče pripraviti. Poskusi znova." });
    return false;
  }
  const filename = clientReportFilename(report.client);
  res.writeHead(200, securityHeaders({
    "Content-Type": "application/pdf",
    "Content-Length": pdf.length,
    "Content-Disposition": attachmentContentDisposition(filename),
    "Cache-Control": "no-store"
  }));
  res.end(pdf);
  return true;
}

function todoShareReport(db, todo) {
  const todos = todoAssignmentItems(db, todo).filter((item) => !isTrashedTodo(item));
  if (!todos.length) return null;
  const first = todos[0];
  const client = clientForBilling(db, { clientId: first.clientId, clientName: first.client }) || {
    clientId: String(first.clientId || ""),
    name: String(first.client || "Brez stranke"),
    email: ""
  };
  return {
    client,
    from: String(first.date || ""),
    to: String(first.endDate || first.date || ""),
    groups: [{ eventId: todoBillingEventId(first), todos }]
  };
}

function todoSharePdfFilename(todo) {
  const date = isDateKey(todo?.date) ? String(todo.date) : "brez-datuma";
  const title = safeReportFileName(todo?.title || "dogodek").replace(/\s+/g, "-");
  return `dogodek-${date}-${title || "brez-naslova"}.pdf`;
}

async function sendTodoSharePdf(res, db, todo) {
  const report = todoShareReport(db, todo);
  if (!report) {
    sendJson(res, 404, { error: "Dogodek ni več na voljo." });
    return false;
  }
  try {
    const attachments = await loadClientReportAttachments(db, clientReportAttachmentSelection(report), { destination: "PDF" });
    const pdf = await buildClientReportPdf(db, report, attachments, { hoursMode: "worker_time", heading: "Dogodek" });
    res.writeHead(200, securityHeaders({
      "Content-Type": "application/pdf",
      "Content-Length": pdf.length,
      "Content-Disposition": attachmentContentDisposition(todoSharePdfFilename(todo)),
      "Cache-Control": "no-store"
    }));
    res.end(pdf);
    return true;
  } catch (error) {
    console.error("PDF dogodka ni bilo mogoče ustvariti:", error?.message || error);
    sendJson(res, 500, { error: "PDF dogodka ni bilo mogoče pripraviti. Poskusi znova." });
    return false;
  }
}

function workerDigestBaseUrl() {
  return PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
}

function workerDigestTodoUrl(todoId) {
  return `${workerDigestBaseUrl()}/?todo=${encodeURIComponent(String(todoId || ""))}`;
}

function workerDigestPortalUrl(workerId, date) {
  const id = cleanUserId(workerId);
  const reportDate = isDateKey(date) ? String(date) : "";
  if (!id || !reportDate) return `${workerDigestBaseUrl()}/`;
  return `${workerDigestBaseUrl()}/?worker-digest-worker=${encodeURIComponent(id)}&worker-digest-date=${encodeURIComponent(reportDate)}`;
}

function workerDigestMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function workerDigestGapLabel(value) {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function workerDailyDigestSnapshot(db, workerId, date) {
  const worker = db.users?.[workerId] || null;
  if (!worker || !isDateKey(date)) return null;
  // This is a historical daily journal, not a live payroll draft: archived or
  // already confirmed entries must stay visible in the morning digest.
  const lines = withDailyCommuteInPayroll(db, workerId, (db.todos || [])
    .filter((todo) => !todo.imported && !isTrashedTodo(todo) && (todo.syncUser || todo.createdBy) === workerId && todo.date === date)
    .map((todo) => payrollLineForTodo(db, todo, workerId))
    .filter(Boolean)
    .sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")) || String(left.start || "").localeCompare(String(right.start || "")) || String(left.title || "").localeCompare(String(right.title || ""), "sl")));
  const totals = payrollTotals(lines);
  const warnings = (db.todos || [])
    .filter((todo) => !todo.imported && !isTrashedTodo(todo) && (todo.syncUser || todo.createdBy) === workerId && todo.date === date && PAYROLL_PAID_TODO_STATUSES.has(todo.status))
    .filter((todo) => Boolean(todo.hoursNeedsReview) || !payrollMinutesForTodo(db, todo))
    .sort((left, right) => String(left.start || "").localeCompare(String(right.start || "")) || String(left.title || "").localeCompare(String(right.title || "")))
    .map((todo) => ({ id: String(todo.id || ""), title: String(todo.title || "Brez naziva"), start: String(todo.start || ""), end: String(todo.end || "") }));
  return {
    workerId,
    workerName: String(worker.name || workerId),
    email: String(worker.email || "").trim().toLowerCase(),
    date,
    portalUrl: workerDigestPortalUrl(workerId, date),
    lines,
    warnings,
    totals
  };
}

function canReadWorkerDailyReport(user, workerId) {
  const id = cleanUserId(workerId);
  return Boolean(user && id && (user.role === "boss" || cleanUserId(user.id) === id));
}

function workerDailyReportFilename(report) {
  const worker = safeReportFileName(report?.workerName || "delavec").replace(/\s+/g, "-");
  return `dnevni-povzetek-${worker || "delavec"}-${report?.date || "dan"}.pdf`;
}

function workerDigestHtmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

function workerDigestAmount(value, digits = 2) {
  return Number(value || 0).toLocaleString("sl-SI", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function workerDailyReportText(report = {}) {
  const readableDate = reportPdfDate(report.date);
  const lines = [...(report.lines || [])].sort((left, right) => String(left.start || "").localeCompare(String(right.start || "")) || String(left.end || "").localeCompare(String(right.end || "")) || String(left.title || "").localeCompare(String(right.title || "")));
  const text = [
    "Dnevni povzetek ur",
    `Delavec: ${report.workerName || ""}`,
    `Datum: ${readableDate}`,
    ""
  ];
  if (lines.length) {
    text.push("Vpisane ure:");
    for (const line of lines) {
      const time = line.start && line.end ? `${line.start}-${line.end}` : "Brez ure";
      const client = line.client ? ` | ${line.client}` : "";
      text.push(`- ${time} | ${line.title || "Brez naziva"}${client} | ${workerDigestAmount(line.hours || 0)} h | ${workerDigestAmount(line.hourlyRate || 0)} EUR/h`);
    }
  } else {
    text.push("Za ta dan ni vpisanih obra\u010dunskih ur.");
  }
  if ((report.warnings || []).length) {
    text.push("", "Potrebno je preveriti ure:");
    for (const warning of report.warnings) text.push(`- ${warning.title || "Brez naziva"}`);
  }
  const totals = report.totals || payrollTotals(lines);
  text.push("", `Skupaj: ${workerDigestAmount(totals.hours || 0)} h | ${workerDigestAmount(totals.totalAmount || 0)} EUR`);
  if (report.portalUrl) text.push("", `Odpri dnevni povzetek v INDUS URE: ${report.portalUrl}`);
  return text.join("\n");
}

function workerDailyReportHtml(report = {}) {
  const readableDate = reportPdfDate(report.date);
  const lines = [...(report.lines || [])].sort((left, right) => String(left.start || "").localeCompare(String(right.start || "")) || String(left.end || "").localeCompare(String(right.end || "")) || String(left.title || "").localeCompare(String(right.title || "")));
  const rows = lines.map((line) => {
    const time = line.start && line.end ? `${line.start}&ndash;${line.end}` : "Brez ure";
    const title = workerDigestHtmlEscape(line.title || "Brez naziva");
    const client = workerDigestHtmlEscape(line.client || "");
    const href = workerDigestTodoUrl(line.todoId);
    return `<tr><td style="padding:10px 8px;border-bottom:1px solid #d7e4df;white-space:nowrap">${time}</td><td style="padding:10px 8px;border-bottom:1px solid #d7e4df"><a href="${href}" style="color:#0d536b;font-weight:700;text-decoration:none">${title}</a>${client ? `<br><span style="color:#60706c">${client}</span>` : ""}</td><td style="padding:10px 8px;border-bottom:1px solid #d7e4df;text-align:right;white-space:nowrap">${workerDigestAmount(line.hours || 0)} h</td></tr>`;
  }).join("") || '<tr><td colspan="3" style="padding:12px 8px;color:#60706c">Za ta dan ni vpisanih obra\u010dunskih ur.</td></tr>';
  const warnings = (report.warnings || []).map((warning) => `<li style="margin:4px 0"><a href="${workerDigestTodoUrl(warning.id)}" style="color:#a12b22">${workerDigestHtmlEscape(warning.title || "Brez naziva")}</a></li>`).join("");
  const totals = report.totals || payrollTotals(lines);
  const portalUrl = String(report.portalUrl || workerDigestPortalUrl(report.workerId, report.date));
  return `<!doctype html><html lang="sl"><body style="margin:0;background:#f3f7f5;color:#1e3430;font:15px Arial,sans-serif"><main style="max-width:680px;margin:0 auto;padding:24px"><section style="background:#fff;border:1px solid #d7e4df;border-radius:14px;overflow:hidden"><header style="padding:22px 24px;background:#0d536b;color:#fff"><h1 style="margin:0;font-size:22px">Dnevni povzetek ur</h1><p style="margin:7px 0 0">${workerDigestHtmlEscape(report.workerName || "Delavec")} &middot; ${workerDigestHtmlEscape(readableDate)}</p></header><div style="padding:18px 24px"><table role="presentation" style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table>${warnings ? `<section style="margin-top:18px;padding:12px 14px;background:#fff5f3;border-left:4px solid #b3261e"><strong>Potrebno je preveriti ure</strong><ul style="margin:8px 0 0;padding-left:20px">${warnings}</ul></section>` : ""}<section style="margin-top:18px;padding:14px;background:#eaf4f1;border-radius:9px"><strong>Skupaj: ${workerDigestAmount(totals.hours || 0)} h</strong><span style="float:right">${workerDigestAmount(totals.totalAmount || 0)} EUR</span></section><p style="margin:22px 0 4px"><a href="${workerDigestHtmlEscape(portalUrl)}" style="display:inline-block;padding:11px 16px;border-radius:8px;background:#0d536b;color:#fff;font-weight:700;text-decoration:none">Odpri dnevni povzetek</a></p></div></section></main></body></html>`;
}

function buildWorkerDailyReportPdf(db, report) {
  const snapshot = report || {};
  const title = `Dnevni povzetek ur - ${safeReportFileName(snapshot.workerName || "delavec")}`;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 46,
      info: { Title: title, Author: "INDUS URE", Subject: "Dnevni povzetek ur" }
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    try {
      doc.font(reportPdfFontPath("bold")).fontSize(21).fillColor("#0d536b").text("Dnevni povzetek ur");
      doc.moveDown(0.3);
      doc.font(reportPdfFontPath()).fontSize(11).fillColor("#263634");
      reportPdfLine(doc, "Delavec", snapshot.workerName || "");
      reportPdfLine(doc, "Datum", reportPdfDate(snapshot.date));
      doc.moveDown(0.75);

      const lines = [...(snapshot.lines || [])].sort((left, right) => String(left.start || "").localeCompare(String(right.start || "")) || String(left.end || "").localeCompare(String(right.end || "")) || String(left.title || "").localeCompare(String(right.title || "")));
      let previous = null;
      for (const line of lines) {
        const startMinutes = workerDigestMinutes(line.start);
        const previousEnd = workerDigestMinutes(previous?.end);
        if (previous && startMinutes !== null && previousEnd !== null && startMinutes > previousEnd) {
          reportPdfEnsureSpace(doc, 28);
          doc.font(reportPdfFontPath("bold")).fontSize(10).fillColor("#0d536b").text(`\u2195 Razmak med vnosi: ${workerDigestGapLabel(startMinutes - previousEnd)}`);
          doc.moveDown(0.25);
        }
        reportPdfEnsureSpace(doc, 88);
        const url = workerDigestTodoUrl(line.todoId);
        doc.font(reportPdfFontPath("bold")).fontSize(13).fillColor("#143b34").text(`${line.start}-${line.end}`, { continued: true });
        doc.font(reportPdfFontPath("bold")).fontSize(12).fillColor("#161f20").text(`  ${line.title || "Brez naziva"}`, { link: url, underline: true });
        doc.font(reportPdfFontPath()).fontSize(10).fillColor("#263634");
        if (line.client) reportPdfLine(doc, "Stranka", line.client);
        reportPdfLine(doc, "Vpisane ure", `${Number(line.hours || 0).toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h`);
        reportPdfLine(doc, "Urna postavka", `${Number(line.hourlyRate || 0).toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR/h`);
        if (Number(line.km || 0)) reportPdfLine(doc, "Kilometrina", `${Number(line.km || 0).toLocaleString("sl-SI", { maximumFractionDigits: 1 })} km`);
        doc.moveDown(0.4);
        doc.strokeColor("#a9c5bd").lineWidth(1.2).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
        doc.moveDown(0.5);
        previous = line;
      }

      for (const warning of snapshot.warnings || []) {
        reportPdfEnsureSpace(doc, 45);
        const url = workerDigestTodoUrl(warning.id);
        doc.font(reportPdfFontPath("bold")).fontSize(11).fillColor("#b3261e").text(`\u26a0 Popravi delovne ure: ${warning.title}`, { link: url, underline: true });
        doc.font(reportPdfFontPath()).fontSize(10).fillColor("#263634").text("Za ta vpis manjka ali je ozna\u010dena kot potrebna preveritev ura prihoda oziroma odhoda.");
        doc.moveDown(0.35);
      }

      const totals = payrollTotals(lines);
      reportPdfEnsureSpace(doc, 90);
      doc.moveDown(0.35);
      doc.font(reportPdfFontPath("bold")).fontSize(13).fillColor("#0d536b").text("Povzetek dneva");
      reportPdfLine(doc, "Ure", `${Number(totals.hours || 0).toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h`);
      reportPdfLine(doc, "Delo", `${Number(totals.workAmount || 0).toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`);
      reportPdfLine(doc, "Kilometrina", `${Number(totals.km || 0).toLocaleString("sl-SI", { maximumFractionDigits: 1 })} km - ${Number(totals.kmAmount || 0).toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`);
      reportPdfLine(doc, "Skupaj", `${Number(totals.totalAmount || 0).toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
function mimeBase64(value) {
  return Buffer.from(value).toString("base64").replace(/.{1,76}/g, "$&\r\n");
}

function gmailPdfDraftRaw({ to, subject, text, pdf, pdfFilename, attachments = [] }) {
  const boundary = `indus-ure-${crypto.randomBytes(18).toString("hex")}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(String(subject || ""), "utf8").toString("base64")}?=`;
  const parts = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(String(text || "")),
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

function gmailDraftRaw({ to, pdf, pdfFilename, attachments = [] }) {
  return gmailPdfDraftRaw({
    to,
    pdf,
    pdfFilename,
    attachments,
    subject: "Obra\u010dun",
    text: "Pozdravljeni, v prilogi vam po\u0161iljam obra\u010dun opravljenih storitev in porabljenega materiala.\n\nZa pojasnila sem seveda na voljo."
  });
}

function gmailWorkerDigestDraftRaw({ to, workerName, date, pdf, pdfFilename }) {
  const readableDate = reportPdfDate(date);
  return gmailPdfDraftRaw({
    to,
    pdf,
    pdfFilename,
    subject: `Dnevni povzetek ur - ${workerName} - ${readableDate}`,
    text: `Pozdravljeni,\n\nv prilogi je dnevni povzetek vpisanih ur za ${readableDate}. Povezave v PDF-ju odprejo isto opravilo v INDUS URE.\n\nLep pozdrav.`
  });
}

function gmailWorkerDigestMessageRaw({ to, workerName, date, html, text }) {
  const recipient = String(to || "").trim().toLowerCase();
  if (!validEmailAddress(recipient)) throw new Error("Dnevnega povzetka ni mogo\u010de poslati brez veljavnega Bojanovega e-naslova.");
  const boundary = `indus-ure-digest-${crypto.randomBytes(18).toString("hex")}`;
  const subject = `Dnevni povzetek ur - ${String(workerName || "delavec")} - ${reportPdfDate(date)}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const parts = [
    `To: ${recipient}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(String(text || "")),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(String(html || "")),
    `--${boundary}--`,
    ""
  ];
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

function gmailCompletionRequestRaw({ to, subject, text }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(String(subject || ""), "utf8").toString("base64")}?=`;
  const parts = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(String(text || ""))
  ];
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

function clientReportFilename(client) {
  const suffix = safeReportFileName(client?.name || "stranka").replace(/\s+/g, "-");
  return `obračun-${suffix || "stranka"}.pdf`;
}
function attachmentContentDisposition(filename) {
  const original = safeReportFileName(filename, "priloga");
  const asciiFallback = original.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, 120) || "priloga";
  const utf8Filename = encodeURIComponent(original).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Filename}`;
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
    correctionIds: selection.groups.flatMap((group) => (db.settlementCorrections || [])
      .filter((correction) => correction.type === "client" && correction.status === "pending" && String(correction.eventId || "") === String(group.eventId))
      .map((correction) => correction.id)),
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
        clientBillableMinutes: clientBillableMinutesForTodos(group.todos),
        warranty: Boolean(representative.warranty),
        status: String(representative.status || ""),
        materialAmount: nonnegativeNumber(representative.materialAmount, 0, 1_000_000),
        externalDelivery: Boolean(representative.externalDelivery),
        clientKmRate: 0
      };
    }),
    createdBy: actor?.id || "system",
    createdByName: actor?.name || "",
    createdAt,
    confirmedAt: createdAt,
    confirmedBy: actor?.id || "system",
    confirmedByName: actor?.name || "",
    directSettlement: Boolean(input?.directSettlement),
    receivedAmount: nonnegativeNumber(input?.receivedAmount, 0, 1_000_000),
    creditedWorkerId: cleanUserId(input?.creditedWorkerId),
    creditedWorkerName: String(input?.creditedWorkerName || "").trim().slice(0, 120),
    clientReceiptId: String(input?.clientReceiptId || "").trim().slice(0, 100)
  }, db);
}

function directClientSettlementRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.confirmed) return null;
  return {
    amount: nonnegativeNumber(value.amount, null, 1_000_000),
    creditWorker: Boolean(value.creditWorker)
  };
}

function directClientSettlementForTodo(db, todo, input, actor) {
  const request = directClientSettlementRequest(input);
  if (!request) return { clientBill: null, clientReceipt: null };
  if (request.amount === null || request.amount < 0) {
    return { error: "Za poraÄŤunano storitev vpiĹˇi prejeti znesek." };
  }
  if (!todoRequiresClientBilling(todo)) {
    return { error: "S stranko lahko neposredno poraÄŤunaĹˇ samo zakljuÄŤen vpis ur z izbrano stranko." };
  }
  const eventId = todoBillingEventId(todo);
  const current = confirmedClientBillByEvent(db).get(eventId);
  if (current) {
    if (current.directSettlement) return { clientBill: current, clientReceipt: current.clientReceiptId ? (db.debts || []).find((item) => item.id === current.clientReceiptId) || null : null };
    return { error: "Ta dogodek je Ĺľe v potrjenem obraÄŤunu stranki." };
  }
  const workerId = payrollWorkerForTodo(todo);
  const creditWorker = request.creditWorker && request.amount > 0;
  if (creditWorker && !db.users?.[workerId]) {
    return { error: "Delavca za plaÄŤilo v dobro ni bilo mogoÄŤe prepoznati." };
  }
  const clientReceiptId = creditWorker ? crypto.randomUUID() : "";
  const clientBill = buildClientBillSnapshot(db, {
    clientId: todo.clientId,
    clientName: todo.client,
    eventIds: [eventId],
    directSettlement: true,
    receivedAmount: request.amount,
    creditedWorkerId: creditWorker ? workerId : "",
    creditedWorkerName: creditWorker ? (db.users[workerId]?.name || workerId) : "",
    clientReceiptId
  }, actor);
  if (!clientBill) return { error: "Dogodka ni bilo mogoÄŤe pripraviti za obraÄŤun stranki." };
  db.clientBills.push(clientBill);
  let clientReceipt = null;
  if (creditWorker) {
    // We never rewrite a confirmed payroll. A late client payment becomes a
    // new credit in today's open settlement, while sourceDate still points to
    // the original work entry.
    const sourcePayroll = confirmedPayrollLineForTodo(db, todo.id);
    const accountingDate = sourcePayroll ? serverDateKey() : String(todo.date || serverDateKey());
    const now = new Date().toISOString();
    clientReceipt = {
      id: clientReceiptId,
      type: "client_receipt",
      person: workerId,
      month: accountingDate.slice(0, 7),
      date: accountingDate,
      sourceDate: String(todo.date || ""),
      amount: Number(request.amount.toFixed(2)),
      reason: `PlaÄŤilo stranke ${todo.client}: ${todo.title || "storitev"}`.slice(0, 2_000),
      projectTodoId: String(todo.id || ""),
      clientBillId: clientBill.id,
      photos: [],
      createdBy: actor?.id || "system",
      createdByName: actor?.name || "",
      createdAt: now,
      updatedBy: actor?.id || "system",
      updatedByName: actor?.name || "",
      updatedAt: now
    };
    db.debts.push(clientReceipt);
  }
  for (const item of db.todos || []) {
    if (todoBillingEventId(item) !== eventId) continue;
    item.history = [...(item.history || []), audit(actor || { id: "system", name: "Sistem" }, creditWorker
      ? `neposredno poraÄŤunano s stranko; ${request.amount.toFixed(2)} EUR v dobro delavca`
      : `neposredno poraÄŤunano s stranko; ${request.amount.toFixed(2)} EUR`)];
  }
  const settledCorrections = settleCorrectionsForClientBill(db, clientBill, actor);
  const archive = reconcileTodoArchives(db, actor);
  return { clientBill, clientReceipt, settledCorrections, archive };
}

function clientSettlementFromBill(bill) {
  if (!bill) return { confirmed: false };
  return {
    confirmed: true,
    direct: Boolean(bill.directSettlement),
    amount: nonnegativeNumber(bill.receivedAmount, 0, 1_000_000),
    creditedWorkerId: String(bill.creditedWorkerId || ""),
    creditedWorkerName: String(bill.creditedWorkerName || ""),
    confirmedAt: String(bill.confirmedAt || ""),
    clientBillId: String(bill.id || "")
  };
}

function clientSettlementForTodo(db, todo) {
  return clientSettlementFromBill(confirmedClientBillByEvent(db).get(todoBillingEventId(todo)));
}

function confirmedPayrollByTodo(db) {
  const byTodo = new Map();
  const todosById = new Map((db.todos || []).map((todo) => [String(todo.id || ""), todo]));
  for (const payroll of db.payrolls || []) {
    if (!["confirmed", "paid"].includes(payroll.status)) continue;
    for (const line of payroll.lines || []) {
      const todoId = String(line?.todoId || "");
      const todo = todosById.get(todoId);
      // A historic line belonging to a former worker is not a settlement for
      // the current worker, nor may it cause the live task to be archived.
      if (todoId && todo && payrollWorkerForTodo(todo) === String(payroll.workerId || "") && !byTodo.has(todoId)) {
        byTodo.set(todoId, payroll);
      }
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
    if (isTrashedTodo(todo)) continue;
    const payroll = payrolls.get(String(todo.id || ""));
    const hasPendingCorrection = pendingCorrectionsForTodo(db, todo).length > 0;
    const needsClientBill = todoRequiresClientBilling(todo);
    const bill = needsClientBill ? bills.get(todoBillingEventId(todo)) : null;
    const desiredClientBillId = bill?.id || "";
    const clientOnly = ["material", "note"].includes(todo.status);
    const readyForArchive = Boolean(!hasPendingCorrection && (clientOnly ? bill : (payroll && (!needsClientBill || bill))));
    if (todo.clientBillId !== desiredClientBillId || todo.clientBilledAt !== (bill?.confirmedAt || "")) {
      todo.clientBillId = desiredClientBillId;
      todo.clientBilledAt = bill?.confirmedAt || "";
      todo.updatedAt = now;
      todo.updatedBy = auditActor.id;
      todo.updatedByName = auditActor.name || "";
      changed = true;
    }
    if (readyForArchive) {
      if (!todo.archivedAt || todo.archivedPayrollId !== (clientOnly ? "" : payroll.id) || todo.archivedClientBillId !== desiredClientBillId) {
        todo.archivedAt = todo.archivedAt || now;
        todo.archivedPayrollId = clientOnly ? "" : payroll.id;
        todo.archivedClientBillId = desiredClientBillId;
        todo.updatedAt = now;
        todo.updatedBy = auditActor.id;
        todo.updatedByName = auditActor.name || "";
        todo.history = [...(todo.history || []), audit(auditActor, clientOnly
          ? todo.status === "material"
            ? `arhivirano po potrjenem obračunu materiala za stranko ${bill.clientName}`
            : `arhivirano po potrjenem obračunu zapiska za stranko ${bill.clientName}`
          : needsClientBill
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
      todo.history = [...(todo.history || []), audit(auditActor, clientOnly
        ? todo.status === "material"
          ? "vrnjeno iz arhiva: manjka potrjeni obračun materiala za stranko"
          : "vrnjeno iz arhiva: manjka potrjeni obračun zapiska za stranko"
        : needsClientBill
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
    if (isTrashedTodo(todo)) continue;
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
    const managedDriveFiles = managedDriveFilesForTodos(todos);
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

function quickCreateBootstrapFromDb(db, user) {
  const activeUsers = Object.values(db.users || {}).filter((worker) => worker.active !== false);
  return {
    clients: db.clients || [],
    users: activeUsers.map(publicDirectoryUser),
    workers: activeUsers
      .filter((worker) => user.role === "boss" || worker.id === user.id)
      .map((worker) => ({
        id: worker.id,
        name: worker.name,
        role: worker.role,
        hourlyRate: defaultHourlyRateForUser(db, worker.id),
        exportTitle: String(worker.billing?.exportTitle || ""),
        commuteKmOneWay: commuteKmOneWayForUser(db, worker.id)
      })),
    settings: db.settings || {}
  };
}

function todoEditableSnapshot(todo) {
  const status = String(todo?.status || "");
  const isTimeEntry = TIME_ENTRY_TODO_STATUSES.has(status);
  const isCompleted = status === "execution";
  const isMaterial = status === "material";
  const isNote = status === "note";
  const files = (items) => (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id || ""),
    attachmentId: String(item?.attachmentId || ""),
    fileId: String(item?.fileId || ""),
    url: String(item?.url || ""),
    name: String(item?.name || ""),
    comment: String(item?.comment || ""),
    data: String(item?.data || ""),
    thumbnailData: String(item?.thumbnailData || "")
  }));
  return JSON.stringify({
    title: String(todo?.title || ""), date: String(todo?.date || ""), endDate: String(todo?.endDate || todo?.date || ""), calendarOnly: Boolean(!isTimeEntry && todo?.calendarOnly && todo?.date), start: String(todo?.start || ""), end: String(todo?.end || ""),
    client: String(todo?.client || ""), clientId: String(todo?.clientId || ""), clientContactIds: cleanTodoClientContactIds(todo?.clientContactIds), clientContacts: cleanTodoClientContactSnapshots(todo?.clientContacts), notes: String(todo?.notes || ""), material: String(todo?.material || ""), materialAmount: isMaterial ? nonnegativeNumber(todo?.materialAmount, 0, 1_000_000) : 0, externalDelivery: isMaterial && Boolean(todo?.externalDelivery),
    status, urgent: Boolean(todo?.urgent), ordered: Boolean(todo?.ordered), warranty: status !== "meal" && !isMaterial && !isNote && Boolean(todo?.warranty),
    sourceProjectTodoId: String(todo?.sourceProjectTodoId || ""), sourceProjectTitle: String(todo?.sourceProjectTitle || ""), billingHourlyRate: isTimeEntry ? nonnegativeNumber(todo?.billingHourlyRate, null, 10_000) : null,
    clientBillableMinutes: isCompleted ? normalizedClientBillableMinutes(todo?.clientBillableMinutes) : null,
    billingKm: isTimeEntry ? nonnegativeNumber(todo?.billingKm, null, 1_000_000) : null, workFromHome: isTimeEntry && Boolean(todo?.workFromHome), clientKm: isCompleted ? nonnegativeNumber(todo?.clientKm, null, 1_000_000) : null,
    clientVehicle: isCompleted ? todoVehicle(todo?.clientVehicle) : "", driveFiles: files(todo?.driveFiles), photos: files(todo?.photos)
  });
}

function importedTodoWasEdited(previous, next, { assignmentsChanged = false } = {}) {
  return Boolean(previous?.imported) && (assignmentsChanged || todoEditableSnapshot(previous) !== todoEditableSnapshot(next));
}
function todoForUserRole(user, db, previous, todo) {
  const previousRate = nonnegativeNumber(previous?.billingHourlyRate, null, 10_000);
  const previousKm = nonnegativeNumber(previous?.billingKm, 0, 1_000_000);
  const previousClientKm = nonnegativeNumber(previous?.clientKm, 0, 1_000_000);
  const previousClientBillableMinutes = normalizedClientBillableMinutes(previous?.clientBillableMinutes);
  const requestedClientBillableMinutes = normalizedClientBillableMinutes(todo?.clientBillableMinutes);
  const previousClientVehicle = todoVehicle(previous?.clientVehicle);
  const requestedClientVehicle = todoVehicle(todo.clientVehicle);
  const isCompleted = todo.status === "execution";
  const isMeal = todo.status === "meal";
  const isMaterial = todo.status === "material";
  const isNote = todo.status === "note";
  const isClientOnly = isMaterial || isNote;
  const isPaidTime = TIME_ENTRY_TODO_STATUSES.has(todo.status);
  const canSetClientMileage = isCompleted;
  const defaultRate = defaultHourlyRateForUser(db, todo.syncUser || previous?.syncUser || user.id);
  const preserveImported = Boolean(previous?.imported) && !Boolean(todo.promoteImported);
  if (user.role !== "boss") {
    return {
      ...todo,
      billingHourlyRate: isClientOnly ? null : (isPaidTime ? previousRate ?? defaultRate : previousRate),
      billingKm: isMeal || isClientOnly ? 0 : isPaidTime ? nonnegativeNumber(todo.billingKm, previousKm, 1_000_000) : previousKm,
      workFromHome: isPaidTime && !isClientOnly && Boolean(todo.workFromHome),
      commuteEligible: isPaidTime && Boolean(previous?.commuteEligible ?? todo.commuteEligible),
      warranty: isMeal || isClientOnly ? false : Boolean(todo.warranty),
      imported: preserveImported,
      clientBillableMinutes: isCompleted ? previousClientBillableMinutes : null,
      clientKm: isMeal || isClientOnly ? 0 : canSetClientMileage ? nonnegativeNumber(todo.clientKm, previousClientKm, 1_000_000) : previousClientKm,
      clientVehicle: isMeal || isClientOnly ? "personal" : canSetClientMileage ? requestedClientVehicle : previousClientVehicle,
      clientKmRate: 0
    };
  }
  return {
    ...todo,
    billingHourlyRate: isClientOnly ? null : (isPaidTime ? nonnegativeNumber(todo.billingHourlyRate, previousRate ?? defaultRate, 10_000) : previousRate),
    billingKm: isMeal || isClientOnly ? 0 : isPaidTime ? nonnegativeNumber(todo.billingKm, previousKm, 1_000_000) : previousKm,
    workFromHome: isPaidTime && !isClientOnly && Boolean(todo.workFromHome),
    commuteEligible: isPaidTime && Boolean(previous?.commuteEligible ?? todo.commuteEligible),
    warranty: isMeal || isClientOnly ? false : Boolean(todo.warranty),
    imported: !isPaidTime && preserveImported,
    clientBillableMinutes: isCompleted ? requestedClientBillableMinutes : null,
    clientKm: isMeal || isClientOnly ? 0 : canSetClientMileage ? nonnegativeNumber(todo.clientKm, previousClientKm, 1_000_000) : previousClientKm,
    clientVehicle: isMeal || isClientOnly ? "personal" : requestedClientVehicle,
    clientKmRate: 0
  };
}
function syncUserForRequest(user, requested, fallback = "", users = defaultUsers) {
  const allowed = new Set(Object.entries(users || {}).filter(([, candidate]) => candidate?.active !== false).map(([id]) => id));
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
  const allowed = new Set(Object.entries(users || {}).filter(([, candidate]) => candidate?.active !== false).map(([id]) => id));
  const wanted = cleanUserId(requested);
  const previous = cleanUserId(fallback);
  if (allowed.has(wanted)) return wanted;
  if (allowed.has(previous)) return previous;
  return allowed.has(user.id) ? user.id : "";
}

function todoAssigneesForRequest(user, requested, users = defaultUsers) {
  const allowed = new Set(Object.entries(users || {}).filter(([, candidate]) => candidate?.active !== false).map(([id]) => id));
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
  req.indusSessionUser = session && db.users[session.userId]?.active !== false ? (db.users[session.userId] || null) : null;
  if (activeUndoCapture?.req === req && req.indusSessionUser) {
    activeUndoCapture.actor = { id: req.indusSessionUser.id, name: req.indusSessionUser.name || req.indusSessionUser.id };
  }
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

// Identity/bootstrap endpoints and focused e-mail links must not load the
// complete PostgreSQL state. The normal requireUser path intentionally still
// does that for mutations which need an authoritative full-state snapshot.
async function requireUserForLightweightSession(req, res) {
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
  req.indusSessionToken = token;
  req.indusSessionUser = record.user;
  if (!validCsrf(req, record.session)) {
    sendJson(res, 403, { error: "Varnostna potrditev seje manjka. Osvezi stran in poskusi znova." });
    return null;
  }
  return record.user;
}

// Kept as named wrappers so the route intent stays obvious at call sites.
async function requireUserForSyncState(req, res) {
  return requireUserForLightweightSession(req, res);
}

async function requireUserForFocusedTodo(req, res) {
  return requireUserForLightweightSession(req, res);
}

function audit(user, action) {
  return {
    action,
    by: user.id,
    byName: user.name,
    at: new Date().toISOString()
  };
}

function todoRevisionSnapshot(todo = {}) {
  const text = (value, limit = TODO_REVISION_TEXT_LIMIT) => String(value || "").slice(0, limit);
  return {
    client: text(todo.client, 300),
    clientId: text(todo.clientId, 160),
    status: text(todo.status, 80),
    title: text(todo.title, 500),
    notes: text(todo.notes),
    material: text(todo.material),
    date: text(todo.date, 16),
    endDate: text(todo.endDate, 16),
    start: text(todo.start, 12),
    end: text(todo.end, 12),
    urgent: Boolean(todo.urgent),
    warranty: Boolean(todo.warranty),
    clientBillableMinutes: Number.isFinite(Number(todo.clientBillableMinutes)) ? Number(todo.clientBillableMinutes) : null,
    billingKm: Number(todo.billingKm || 0),
    clientKm: Number(todo.clientKm || 0),
    clientVehicle: text(todo.clientVehicle, 24),
    photos: (Array.isArray(todo.photos) ? todo.photos : []).map((photo) => ({
      id: text(photo?.id || photo?.attachmentId, 160),
      name: text(photo?.name || photo?.displayName, 500),
      comment: text(photo?.comment, 1_000),
      mimeType: text(photo?.mimeType, 160)
    })),
    driveFiles: (Array.isArray(todo.driveFiles) ? todo.driveFiles : []).map((file) => ({
      fileId: text(file?.fileId, 160),
      name: text(file?.name, 500),
      kind: text(file?.kind, 80)
    }))
  };
}

function normalizeTodoRevisionHistory(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((record) => record && typeof record === "object" && record.snapshot && typeof record.snapshot === "object")
    .map((record) => ({
      id: /^[a-f0-9-]{16,80}$/i.test(String(record.id || "")) ? String(record.id) : crypto.randomUUID(),
      at: Number.isFinite(Date.parse(record.at)) ? String(record.at) : new Date().toISOString(),
      by: cleanUserId(record.by) || "system",
      byName: cleanAuditActorName(record.byName, "Sistem"),
      action: cleanAuditLogText(record.action || "spremenjeno opravilo", 220),
      snapshot: todoRevisionSnapshot(record.snapshot)
    }))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .slice(-TODO_REVISION_HISTORY_LIMIT);
}

function appendTodoRevision(previousTodo, nextTodo, user, action, at = new Date().toISOString()) {
  const before = todoRevisionSnapshot(previousTodo);
  const after = todoRevisionSnapshot(nextTodo);
  const existing = normalizeTodoRevisionHistory(previousTodo?.revisionHistory);
  if (JSON.stringify(before) === JSON.stringify(after)) return existing;
  return normalizeTodoRevisionHistory([...existing, {
    id: crypto.randomUUID(),
    at,
    by: user?.id,
    byName: user?.name,
    action,
    snapshot: before
  }]);
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

function cleanTodoCompletionRequests(input, now = Date.now()) {
  const seen = new Set();
  return (Array.isArray(input) ? input : [])
    .map((request) => {
      const recipientUserIds = [...new Set((Array.isArray(request?.recipientUserIds) ? request.recipientUserIds : [request?.recipientUserId])
        .map(cleanUserId).filter(Boolean))].slice(0, 20);
      const recipientEmails = [...new Set((Array.isArray(request?.recipientEmails) ? request.recipientEmails : [request?.recipientEmail])
        .map((email) => String(email || "").trim().toLowerCase()).filter(Boolean))].slice(0, 20);
      return {
        id: String(request?.id || "").trim(),
        tokenHash: String(request?.tokenHash || "").trim().toLowerCase(),
        recipientUserIds,
        recipientEmails,
        // Ohranimo tudi stari obliki polj, da stare povezave ostanejo veljavne.
        recipientUserId: recipientUserIds[0] || "",
        recipientEmail: recipientEmails[0] || "",
        requestedBy: cleanUserId(request?.requestedBy),
        requestedByName: String(request?.requestedByName || "").trim().slice(0, 120),
        comment: String(request?.comment || "").trim().slice(0, 2_000),
        createdAt: String(request?.createdAt || ""),
        expiresAt: Number(request?.expiresAt || 0)
      };
    })
    .filter((request) => request.id
      && /^[a-f0-9]{64}$/.test(request.tokenHash)
      && request.recipientUserIds.length
      && request.recipientEmails.length
      && request.recipientEmails.every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      && request.requestedBy
      && request.expiresAt > now
      && !seen.has(request.id)
      && (seen.add(request.id) || true));
}

// Zahteve za dopolnitev pripadajo logi?nemu (skupno dodeljenemu) opravilu,
// ne posamezni kopiji za delavca. Kopije obdr?imo na vseh pripadajo?ih
// dogodkih, da stare povezave ostanejo uporabne tudi po spremembi dodelitve.
function todoCompletionRequestsForAssignment(db, todo, now = Date.now()) {
  const requestsByToken = new Map();
  for (const assignmentTodo of todoAssignmentItems(db, todo)) {
    for (const request of cleanTodoCompletionRequests(assignmentTodo.completionRequests, now)) {
      if (!requestsByToken.has(request.tokenHash)) requestsByToken.set(request.tokenHash, request);
    }
  }
  return [...requestsByToken.values()];
}

function findActiveTodoCompletionRequest(db, requestedTodoId, tokenHash, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(String(tokenHash || ""))) return null;
  const requestedId = String(requestedTodoId || "");
  const todos = Array.isArray(db?.todos) ? db.todos : [];
  const candidates = [];
  const requestedTodo = todos.find((item) => item.id === requestedId);
  if (requestedTodo && !isTrashedTodo(requestedTodo)) candidates.push(requestedTodo);
  for (const todo of todos) {
    if (todo === requestedTodo || isTrashedTodo(todo)) continue;
    candidates.push(todo);
  }
  for (const todo of candidates) {
    const request = cleanTodoCompletionRequests(todo.completionRequests, now)
      .find((item) => item.tokenHash === tokenHash);
    if (request) return { todo, request };
  }
  return null;
}

function cleanClientMutationId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : "";
}

function stableJsonForHash(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonForHash).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonForHash(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function todoCreateRequestHash(input = {}) {
  const request = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  delete request.clientMutationId;
  delete request.baseUpdatedAt;
  return crypto.createHash("sha256").update(stableJsonForHash(request)).digest("hex");
}

function todoCreateReceiptKey(userId, mutationId) {
  return `${cleanUserId(userId)}:${cleanClientMutationId(mutationId)}`;
}

function normalizeTodoCreateReceipts(input, users, now = Date.now()) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const oldest = now - TODO_CREATE_RECEIPT_TTL_MS;
  const receipts = [];
  for (const receipt of Object.values(source)) {
    const userId = cleanUserId(receipt?.userId);
    const mutationId = cleanClientMutationId(receipt?.mutationId);
    const requestHash = String(receipt?.requestHash || "").toLowerCase();
    const createdAt = String(receipt?.createdAt || "");
    const createdAtMs = Date.parse(createdAt);
    const assignmentGroupId = String(receipt?.assignmentGroupId || "").trim().slice(0, 100);
    const todoIds = [...new Set((Array.isArray(receipt?.todoIds) ? receipt.todoIds : []).map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 20);
    const assigneeIds = [...new Set((Array.isArray(receipt?.assigneeIds) ? receipt.assigneeIds : []).map(cleanUserId).filter((id) => Boolean(users?.[id])))].slice(0, 20);
    if (!userId || !users?.[userId] || !mutationId || receipt?.kind !== "todo-create" || !/^[a-f0-9]{64}$/.test(requestHash) || !Number.isFinite(createdAtMs) || createdAtMs < oldest || createdAtMs > now + 60_000 || !assignmentGroupId || !todoIds.length || !assigneeIds.length) continue;
    receipts.push({ userId, mutationId, kind: "todo-create", requestHash, assignmentGroupId, todoIds, assigneeIds, createdAt });
  }
  receipts.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return Object.fromEntries(receipts.slice(0, MAX_TODO_CREATE_RECEIPTS).map((receipt) => [todoCreateReceiptKey(receipt.userId, receipt.mutationId), receipt]));
}

function capitalizeTodoText(value) {
  const text = String(value || "").trim();
  return text.replace(/^(\s*)(\p{L})/u, (_, leading, letter) => `${leading}${letter.toLocaleUpperCase("sl-SI")}`);
}

function cleanTodo(input) {
  const status = input.status === "billing" ? "execution" : TODO_STATUSES.has(input.status) ? input.status : "open";
  const isMeal = status === "meal";
  const isMaterial = status === "material";
  const isNote = status === "note";
  const isClientOnly = isMaterial || isNote;
  const isTimeEntry = TIME_ENTRY_TODO_STATUSES.has(status);
  const sourceProjectTodoId = status === "execution" ? String(input.sourceProjectTodoId || "").trim().slice(0, 100) : "";
  const sourceProjectTitle = sourceProjectTodoId ? String(input.sourceProjectTitle || "").trim().slice(0, 300) : "";
  const photos = Array.isArray(input.photos) ? input.photos : [];
  return {
    title: isMeal ? "Malica" : capitalizeTodoText(input.title),
    date: String(input.date || ""),
    endDate: String(input.endDate || input.date || ""),
    calendarOnly: Boolean(!isTimeEntry && !isClientOnly && input.calendarOnly && input.date),
    start: roundTimeToQuarterHour(input.start),
    end: roundTimeToQuarterHour(input.end),
    client: isMeal ? "" : String(input.client || "").trim(),
    clientId: isMeal ? "" : String(input.clientId || "").trim(),
    clientContactIds: isMeal ? [] : cleanTodoClientContactIds(input.clientContactIds),
    // These are only a display snapshot; the API re-derives them from the
    // selected contact IDs and the resolved client before persistence.
    clientContacts: isMeal ? [] : cleanTodoClientContactSnapshots(input.clientContacts),
    notes: isMeal ? "" : capitalizeTodoText(input.notes),
    material: isMeal ? "" : capitalizeTodoText(input.material),
    status,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    // Older tasks without this field are intentionally shown as sorted.
    userOrderBuckets: cleanTodoUserOrderBuckets(input.userOrderBuckets),
    completionRequests: cleanTodoCompletionRequests(input.completionRequests),
    urgent: isMeal || isTimeEntry || isClientOnly || input.status === "billing" ? false : Boolean(input.urgent),
    imported: !isTimeEntry && Boolean(input.imported),
    ordered: ORDER_TODO_STATUSES.has(status) && Boolean(input.ordered),
    warranty: !isMeal && !isClientOnly && Boolean(input.warranty),
    syncUser: cleanUserId(input.syncUser),
    sourceProjectTodoId,
    sourceProjectTitle,
    done: status === "execution" || isClientOnly,
    hoursNeedsReview: isTimeEntry && Boolean(input.hoursNeedsReview),
    workFromHome: isTimeEntry && Boolean(input.workFromHome),
    commuteEligible: isTimeEntry && Boolean(input.commuteEligible),
    billingHourlyRate: isClientOnly ? null : nonnegativeNumber(input.billingHourlyRate, null, 10_000),
    clientBillableMinutes: status === "execution" ? normalizedClientBillableMinutes(input.clientBillableMinutes) : null,
    billingKm: isMeal || isClientOnly ? 0 : nonnegativeNumber(input.billingKm, null, 1_000_000),
    clientKm: isMeal || isClientOnly ? 0 : nonnegativeNumber(input.clientKm, null, 1_000_000),
    clientVehicle: isMeal || isClientOnly ? "personal" : todoVehicle(input.clientVehicle),
    materialAmount: isMaterial ? nonnegativeNumber(input.materialAmount, 0, 1_000_000) : 0,
    externalDelivery: isMaterial && Boolean(input.externalDelivery),
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
      .slice(0, MAX_TODO_ATTACHMENTS))
  };
}
function reconcileClientContacts(inputContacts, existingContacts = []) {
  const rawContacts = Array.isArray(inputContacts) ? inputContacts : [];
  const incoming = normalizeClientContacts(rawContacts);
  const existing = normalizeClientContacts(existingContacts);
  const usedExistingIds = new Set();
  const rawForContact = (contact) => rawContacts.find((item) => clientContactMatchKey(item) === clientContactMatchKey(contact)) || {};
  return normalizeClientContacts(incoming.map((contact) => {
    const raw = rawForContact(contact);
    const requestedId = isStableClientId(raw?.id) ? String(raw.id).trim() : "";
    const sameId = requestedId ? existing.find((item) => item.id === requestedId && !usedExistingIds.has(item.id)) : null;
    const samePerson = existing.find((item) => !usedExistingIds.has(item.id) && clientContactMatchKey(item) === clientContactMatchKey(contact));
    const phone = contactPhoneKey(contact.phone);
    const samePhone = phone ? existing.filter((item) => !usedExistingIds.has(item.id) && contactPhoneKey(item.phone) === phone) : [];
    const match = sameId || samePerson || (samePhone.length === 1 ? samePhone[0] : null);
    if (match) {
      usedExistingIds.add(match.id);
      return { ...contact, id: match.id };
    }
    // A client update must not accept an arbitrary new UUID as a way to
    // replace another person's identity. Newly added contacts get a server ID.
    return requestedId ? { ...contact, id: crypto.randomUUID() } : contact;
  }));
}

function cleanClient(input = {}, { existingClient = null } = {}) {
  const taxId = normalizeTaxId(input.taxId || input.clientId || input.id);
  const registryNumber = normalizeRegistryNumber(input.registryNumber || existingClient?.registryNumber);
  const requestedId = String(input.clientId || input.id || "").trim();
  const hasContacts = Array.isArray(input.contacts);
  const hasLegacyPhone = Object.hasOwn(input, "phone");
  const existingContacts = normalizeClientContacts(existingClient?.contacts, existingClient?.phone);
  let contacts;
  if (hasContacts) {
    contacts = reconcileClientContacts(input.contacts, existingContacts);
  } else if (hasLegacyPhone) {
    const primaryPhone = String(input.phone || "").trim();
    if (!primaryPhone) {
      contacts = [];
    } else if (existingContacts.length) {
      contacts = [{ ...existingContacts[0], phone: primaryPhone }, ...existingContacts.slice(1)];
    } else {
      contacts = normalizeClientContacts([{ name: "", phone: primaryPhone }]);
    }
  } else {
    contacts = existingContacts;
  }
  return normalizeStoredClient({
    id: requestedId,
    clientId: requestedId,
    name: String(input.name || "").trim(),
    search: String(input.search || input.name || "").trim(),
    email: String(input.email || "").trim(),
    phone: contacts[0]?.phone || "",
    contacts,
    address: String(input.address || "").trim(),
    city: String(input.city || "").trim(),
    postal: String(input.postal || "").trim(),
    country: String(input.country || "").trim(),
    taxId,
    registryNumber,
    vatPayer: Boolean(input.vatPayer),
    source: input.source || existingClient?.source || (registryNumber ? "ajpes" : (taxId ? "local" : "ad-hoc")),
    needsReview: input.needsReview === undefined ? (existingClient?.needsReview ?? !taxId) : Boolean(input.needsReview),
    createdBy: input.createdBy || existingClient?.createdBy || "system",
    createdAt: input.createdAt || existingClient?.createdAt,
    updatedAt: input.updatedAt || existingClient?.updatedAt
  });
}

function ajpesRecordValue(record, field) {
  return String(record?.[field] || "").trim().replace(/\s+/g, " ");
}

function ajpesRecordToClientDraft(record = {}) {
  const registryNumber = normalizeRegistryNumber(ajpesRecordValue(record, "Mati\u010dna \u0161tevilka"));
  const houseNumber = [
    ajpesRecordValue(record, "Hi\u0161na \u0161t"),
    ajpesRecordValue(record, "Hi\u0161na \u0161t  dodatek")
  ].filter(Boolean).join(" ");
  const address = [ajpesRecordValue(record, "Ulica"), houseNumber].filter(Boolean).join(" ");
  const rawCountry = ajpesRecordValue(record, "Dr\u017eava");
  const country = normalizedText(rawCountry) === "slovenija" ? "Slovenija" : rawCountry;
  return {
    registryNumber,
    name: ajpesRecordValue(record, "Popolno ime"),
    search: ajpesRecordValue(record, "Popolno ime"),
    address,
    postal: ajpesRecordValue(record, "Po\u0161tna \u0161t"),
    city: ajpesRecordValue(record, "Po\u0161ta") || ajpesRecordValue(record, "Naselje"),
    country,
    legalForm: ajpesRecordValue(record, "Pravnoorganizacijska oblika"),
    registryOffice: ajpesRecordValue(record, "Registrski organ")
  };
}

function ajpesLookupError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  return error;
}

async function searchAjpesPublicRegister(value, { fetchImpl = globalThis.fetch } = {}) {
  const query = String(value || "").trim().replace(/\s+/g, " ");
  if (query.length < 2) throw ajpesLookupError("Vpi\u0161i vsaj dva znaka za iskanje po AJPES-u.", 400);
  if (query.length > 120) throw ajpesLookupError("Iskalni niz AJPES je predolg.", 400);
  if (typeof fetchImpl !== "function") throw ajpesLookupError("AJPES iskalnik na stre\u017eniku trenutno ni na voljo.");

  const requestUrl = new URL(OPSI_PRS_SEARCH_URL);
  requestUrl.searchParams.set("resource_id", OPSI_PRS_RESOURCE_ID);
  requestUrl.searchParams.set("q", query);
  requestUrl.searchParams.set("limit", "8");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AJPES_LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(requestUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response?.ok) throw ajpesLookupError("AJPES iskalnik trenutno ni dosegljiv. Poskusi znova.");
    const payload = await response.json();
    if (!payload?.success || !Array.isArray(payload?.result?.records)) {
      throw ajpesLookupError("AJPES je vrnil neveljaven odgovor. Poskusi znova.");
    }
    return payload.result.records
      .map(ajpesRecordToClientDraft)
      .filter((client) => client.registryNumber && client.name);
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "AbortError") throw ajpesLookupError("AJPES iskanje je trajalo predolgo. Poskusi znova.", 504);
    throw ajpesLookupError("AJPES iskalnik trenutno ni dosegljiv. Poskusi znova.");
  } finally {
    clearTimeout(timeout);
  }
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
  if (client.taxId && !isUsableTaxId(client.taxId)) return "Dav\u010dna \u0161tevilka ni veljavna.";
  const contacts = normalizeClientContacts(client.contacts, client.phone);
  if (contacts.length > 1 && contacts.some((contact) => !contact.name)) {
    return "Ob ve\u010d telefonskih \u0161tevilkah vpi\u0161i ime kontakta pri vsaki.";
  }
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
  if (["material", "note"].includes(todo.status) && !todo.clientId) return todo.status === "note" ? "Za zapisek izberi stranko." : "Za vpis materiala izberi stranko.";
  if (todo.date && !/^\d{4}-\d{2}-\d{2}$/.test(todo.date)) return "Datum opravila ni pravilen.";
  if (todo.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(todo.endDate)) return "Datum do opravila ni pravilen.";
  if (todo.endDate && !todo.date) return "Za datum do vnesi tudi datum od.";
  if (todo.date && todo.endDate && todo.endDate < todo.date) return "Datum do ne more biti pred datumom od.";
  if (Boolean(todo.start) !== Boolean(todo.end)) return "Vnesi obe uri: od in do.";
  if ((todo.start || todo.end) && !todo.date) return "Za opravilo z uro vnesi tudi datum.";
  if (todo.start && (!/^\d{2}:\d{2}$/.test(todo.start) || !/^\d{2}:\d{2}$/.test(todo.end))) return "Čas opravila ni pravilen.";
  if (todo.status === "material" && !todo.date) return "Za vpis materiala vnesi datum.";
  if (TIME_ENTRY_TODO_STATUSES.has(todo.status) && (!todo.date || !todo.start || !todo.end)) {
    const label = todo.status === "meal" ? "malico" : todo.status === "drive" ? "vo\u017enjo" : todo.status === "purchase" ? "nabavo" : "zaklju\u010deno opravilo";
    return `Za ${label} vnesi datum ter uro od in do.`;
  }
  if (todo.start && todo.end && todo.endDate && todo.endDate !== todo.date) return "Opravilo z uro je lahko samo za en dan. Za večdnevno opravilo pusti uri prazni.";
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

function timeOfDayMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59 ? hours * 60 + minutes : null;
}

function timeEntryConflictForWorker(db, candidate, workerId, { ignoreIds = [] } = {}) {
  if (!TIME_ENTRY_TODO_STATUSES.has(String(candidate?.status || ""))) return null;
  const date = String(candidate?.date || "");
  const start = timeOfDayMinutes(candidate?.start);
  const end = timeOfDayMinutes(candidate?.end);
  const userId = cleanUserId(workerId || candidate?.syncUser || candidate?.createdBy);
  if (!date || start === null || end === null || end <= start || !userId) return null;
  const ignored = new Set((Array.isArray(ignoreIds) ? ignoreIds : []).map(String));
  return (db?.todos || []).find((todo) => {
    if (!todo || ignored.has(String(todo.id || "")) || isTrashedTodo(todo)) return false;
    if (!TIME_ENTRY_TODO_STATUSES.has(String(todo.status || ""))) return false;
    if (String(todo.syncUser || todo.createdBy || "") !== userId || String(todo.date || "") !== date) return false;
    const otherStart = timeOfDayMinutes(todo.start);
    const otherEnd = timeOfDayMinutes(todo.end);
    return otherStart !== null && otherEnd !== null && start < otherEnd && otherStart < end;
  }) || null;
}

function timeEntryConflictMessage(db, candidate, workerId, options = {}) {
  const conflict = timeEntryConflictForWorker(db, candidate, workerId, options);
  if (!conflict) return "";
  const cleanWorkerId = cleanUserId(workerId);
  const workerName = db?.users?.[cleanWorkerId]?.name || cleanWorkerId || "delavec";
  const title = String(conflict.title || "drug vpis ur").slice(0, 120);
  return `Za ${workerName} se ura prekriva z vpisom »${title}« (${conflict.start}–${conflict.end}).`;
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

function todoEndDate(todo) {
  const date = String(todo?.date || "");
  const endDate = String(todo?.endDate || "");
  return date && isDateKey(endDate) && endDate >= date ? endDate : date;
}

function shiftDateKey(date, days) {
  if (!isDateKey(date)) return "";
  const parsed = new Date(`${date}T00:00:00`);
  parsed.setDate(parsed.getDate() + Number(days || 0));
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0")
  ].join("-");
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
  const assignedTodos = (db.todos || []).filter((todo) => !todo.imported && !isTrashedTodo(todo) && (combined || !userId || (todo.syncUser || todo.createdBy) === userId));
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
    const endDate = todoEndDate(todo);
    if (todo.start && todo.end) {
      lines.push(`DTSTART;TZID=Europe/Ljubljana:${icsDateTime(todo.date, todo.start)}`, `DTEND;TZID=Europe/Ljubljana:${icsDateTime(endDate, todo.end)}`);
    } else {
      // RFC 5545 uses an exclusive end date for all-day events.
      lines.push(`DTSTART;VALUE=DATE:${icsDate(todo.date)}`, `DTEND;VALUE=DATE:${addDays(endDate, 1)}`);
    }
    lines.push(`SUMMARY:${icsEscape(`${todo.urgent ? "NUJNO: " : ""}TODO: ${todo.title}`)}`, `DESCRIPTION:${icsEscape(description)}`, "END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function googleRedirectUri(req) {
  if (GOOGLE_REDIRECT_URI) return GOOGLE_REDIRECT_URI;
  if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL}/api/google/callback`;
  if (req?.headers) return `${absoluteBaseUrl(req)}/api/google/callback`;
  return `http://127.0.0.1:${PORT}/api/google/callback`;
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

function workerDigestPreviousDate(now = new Date()) {
  const value = new Date(`${serverDateKey(now)}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

async function runDailyWorkerDigest({ date = "", dryRun = false } = {}) {
  const reportDate = isDateKey(date) ? String(date) : workerDigestPreviousDate();
  const db = await readDbAsync();
  const workers = Object.values(db.users || {})
    .filter((user) => ["boss", "worker"].includes(user?.role) && user.active !== false)
    .sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id), "sl"));
  const reports = workers.map((worker) => workerDailyDigestSnapshot(db, worker.id, reportDate)).filter(Boolean);
  const reportsWithDelivery = reports.map((report) => {
    const settings = workerDailyReportSettings(db, db.users?.[report.workerId]);
    return { report, settings, eligible: shouldSendWorkerDailyReport(report, settings) };
  });
  if (dryRun) {
    const reportStatuses = await Promise.all(reportsWithDelivery.map(async ({ report, settings, eligible }) => ({
      workerId: report.workerId,
      workerName: report.workerName,
      lines: report.lines.length,
      warnings: report.warnings.length,
      emailEnabled: settings.emailEnabled,
      recipientEmail: settings.recipientEmail,
      includeZeroHours: settings.includeZeroHours,
      eligible,
      sent: String((await workerDigestDeliveryStatus(db, report.workerId, reportDate))?.status || "") === "sent"
    })));
    return { date: reportDate, dryRun: true, reports: reportStatuses, skipped: workers.length - reports.length };
  }

  await purgeExpiredWorkerDigestRuns(db);

  const reportsToSend = reportsWithDelivery.filter(({ eligible }) => eligible);
  if (!reportsToSend.length) {
    const result = { date: reportDate, sent: [], alreadySent: [], skipped: workers.length };
    scheduleAuditLog({
      actor: { id: "system", name: "Sistem" },
      action: "system.worker_digest.completed",
      targetType: "worker_digest",
      severity: "info",
      context: { reportDate, sentCount: 0, alreadySentCount: 0, skippedWorkers: result.skipped }
    });
    return result;
  }

  const owner = googleDriveOwner(db);
  const ownerEmail = String(owner?.email || GOOGLE_DRIVE_OWNER_EMAIL || "").trim().toLowerCase();
  if (!validEmailAddress(ownerEmail) || !googleReady() || !googleWorkspaceTokenAvailable(owner)) {
    const error = "Bojan mora v Nastavitvah ponovno povezati Google Dokumente, preglednice in Gmail.";
    await recordOperationalAlert({ code: "worker-digest-google-unavailable", severity: "warning", title: "No\u010dni povzetki ur niso pripravljeni", message: error });
    throw new Error(error);
  }
  const { google } = require("googleapis");
  const gmail = google.gmail({ version: "v1", auth: googleClient({ headers: {}, socket: {} }, owner.google.tokens) });
  const sent = [];
  const alreadySent = [];
  const errors = [];
  for (const { report, settings } of reportsToSend) {
    const recipientEmail = settings.recipientEmail;
    let reserved = false;
    let gmailSent = false;
    try {
      const reservation = await reserveWorkerDigestDelivery(db, report, recipientEmail);
      reserved = Boolean(reservation.reserved);
      if (!reserved) {
        if (String(reservation.run?.status || "") === "sending") {
          throw new Error("Dnevni povzetek se \u017ee po\u0161ilja; ponovni poskus bo samodejen.");
        }
        alreadySent.push({
          workerId: report.workerId,
          workerName: report.workerName,
          sentAt: String(reservation.run?.sentAt || ""),
          lines: report.lines.length,
          warnings: report.warnings.length
        });
        continue;
      }
      const html = workerDailyReportHtml(report);
      const text = workerDailyReportText(report);
      const message = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: gmailWorkerDigestMessageRaw({ to: recipientEmail, workerName: report.workerName, date: report.date, html, text })
        }
      });
      gmailSent = true;
      const messageId = String(message.data?.id || "");
      await completeWorkerDigestDelivery(db, report, recipientEmail, messageId);
      // JSON installs have no separate digest table, so persist the delivered
      // marker only after Gmail accepted the message.
      if (!DATABASE_URL) await writeDbAsync(db);
      sent.push({ workerId: report.workerId, workerName: report.workerName, recipientEmail, messageId, lines: report.lines.length, warnings: report.warnings.length });
    } catch (error) {
      if (reserved && !gmailSent) {
        try {
          await releaseWorkerDigestDelivery(report);
        } catch (releaseError) {
          console.error(`Dnevnega povzetka ni bilo mogo\u010de sprostiti za ponovni poskus: ${releaseError.message || releaseError}`);
        }
      }
      errors.push(`${report.workerName}: ${error.message || error}`);
    }
  }
  if (errors.length) {
    const message = errors.join("; ").slice(0, 1_500);
    await recordOperationalAlert({ code: `worker-digest-failed-${reportDate}`, severity: "warning", title: "No\u010dni povzetek ur ni v celoti pripravljen", message });
    throw new Error(message);
  }
  const result = { date: reportDate, sent, alreadySent, skipped: workers.length - reportsToSend.length };
  scheduleAuditLog({
    actor: { id: "system", name: "Sistem" },
    action: "system.worker_digest.completed",
    targetType: "worker_digest",
    severity: "info",
    context: {
      reportDate,
      sentCount: sent.length,
      alreadySentCount: alreadySent.length,
      skippedWorkers: result.skipped
    }
  });
  return result;
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
    .replace(/[\u0000-\u001f<>:"\/|?*]+/g, " ")
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

function imageMimeType(value, filename = "") {
  const requested = String(value || "").split(";", 1)[0].trim().toLowerCase();
  const extension = path.extname(String(filename || "")).toLowerCase();
  const knownByExtension = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".avif": "image/avif",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".bmp": "image/bmp",
    ".jxl": "image/jxl"
  };
  if (knownByExtension[extension]) return knownByExtension[extension];
  // Do not pass arbitrary `image/*` formats (notably SVG) to a native image
  // decoder. We accept the ordinary camera/gallery raster formats only.
  return Object.values(knownByExtension).includes(requested) ? requested : "";
}

function imageProcessorError(error) {
  if (error?.code === "ENOENT") return new Error("Strežniška obdelava slik ni pripravljena. Obvesti skrbnika sistema.");
  const detail = String(error?.stderr || error?.message || "").replace(/\s+/g, " ").trim();
  if (/timeout|timed out/i.test(detail)) return new Error("Obdelava slike je trajala predolgo. Izberi manjšo sliko.");
  return new Error(`Slike ni bilo mogoče obdelati${detail ? `: ${detail.slice(0, 180)}` : "."}`);
}

async function createTodoJpegDerivative(inputPath, outputPath, maxSide, quality) {
  try {
    await execFileAsync(
      IMAGE_PROCESSOR,
      ["thumbnail", inputPath, `${outputPath}[Q=${quality},strip]`, String(maxSide)],
      { timeout: TODO_IMAGE_PROCESS_TIMEOUT_MS, maxBuffer: 1_000_000, windowsHide: true }
    );
  } catch (error) {
    throw imageProcessorError(error);
  }
  const result = await fsp.readFile(outputPath);
  if (!IMAGE_SIGNATURES.jpeg(result)) throw new Error("Strežnik ni ustvaril veljavne JPEG slike.");
  return result;
}

async function moveAttachmentFile(tempPath, targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  try {
    await fsp.rename(tempPath, targetPath);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    await fsp.rm(tempPath, { force: true });
    return false;
  }
}

async function receiveLocalTodoImage(input = {}) {
  const mimeType = imageMimeType(input.mimeType, input.name);
  if (!mimeType) throw new Error("Izberi veljavno slikovno datoteko.");
  const declaredBytes = Number(input.contentLength);
  if (Number.isSafeInteger(declaredBytes) && declaredBytes <= 0) throw new Error("Prazne slike ni mogoče dodati.");
  if (Number.isSafeInteger(declaredBytes) && declaredBytes > MAX_TODO_IMAGE_BYTES) throw new Error(`Slika je prevelika. Največja dovoljena velikost je ${Math.round(MAX_TODO_IMAGE_BYTES / 1024 / 1024)} MB.`);

  const uploadDirectory = path.join(MEDIA_DIR, ".uploads");
  await fsp.mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
  const uploadId = crypto.randomUUID();
  const sourcePath = path.join(uploadDirectory, `${uploadId}.source`);
  const displayTempPath = path.join(uploadDirectory, `${uploadId}.display.jpg`);
  const thumbnailTempPath = path.join(uploadDirectory, `${uploadId}.thumb.jpg`);
  let byteSize = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > MAX_TODO_IMAGE_BYTES) {
        callback(new Error(`Slika je prevelika. Največja dovoljena velikost je ${Math.round(MAX_TODO_IMAGE_BYTES / 1024 / 1024)} MB.`));
        return;
      }
      callback(null, chunk);
    }
  });
  input.stream.once("aborted", () => counter.destroy(new Error("Nalaganje slike je bilo prekinjeno.")));
  let displayTargetPath = "";
  let thumbnailTargetPath = "";
  let displayCreated = false;
  let thumbnailCreated = false;
  try {
    await pipeline(input.stream, counter, fs.createWriteStream(sourcePath, { mode: 0o600 }));
    if (!byteSize) throw new Error("Prazne slike ni mogoče dodati.");
    const display = await createTodoJpegDerivative(sourcePath, displayTempPath, TODO_IMAGE_DISPLAY_MAX_SIDE, 85);
    await createTodoJpegDerivative(sourcePath, thumbnailTempPath, TODO_IMAGE_THUMBNAIL_MAX_SIDE, 72);
    const attachmentId = crypto.createHash("sha256").update(display).digest("hex");
    const storageKey = path.posix.join("objects", `${attachmentId}.jpg`);
    const thumbnailKey = path.posix.join("thumbnails", `${attachmentId}.jpg`);
    displayTargetPath = path.join(MEDIA_DIR, ...storageKey.split("/"));
    thumbnailTargetPath = path.join(MEDIA_DIR, ...thumbnailKey.split("/"));
    displayCreated = await moveAttachmentFile(displayTempPath, displayTargetPath);
    thumbnailCreated = await moveAttachmentFile(thumbnailTempPath, thumbnailTargetPath);
    return {
      attachmentId,
      mimeType: "image/jpeg",
      byteSize: display.length,
      storageKey,
      thumbnailKey,
      displayTargetPath,
      thumbnailTargetPath,
      createdFiles: { display: displayCreated, thumbnail: thumbnailCreated }
    };
  } catch (error) {
    if (displayCreated && displayTargetPath) await fsp.rm(displayTargetPath, { force: true }).catch(() => {});
    if (thumbnailCreated && thumbnailTargetPath) await fsp.rm(thumbnailTargetPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await Promise.all([sourcePath, displayTempPath, thumbnailTempPath].map((file) => fsp.rm(file, { force: true }).catch(() => {})));
  }
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

async function approveRetentionGroupsForPurge(db, groups, label) {
  const approvedGroups = [];
  const drive = { deleted: 0, skipped: 0 };
  let blocked = 0;
  for (const group of groups || []) {
    try {
      const result = await deleteRetentionManagedDriveFiles(db, group.managedDriveFiles || []);
      drive.deleted += result.deleted;
      drive.skipped += result.skipped;
      approvedGroups.push(group);
    } catch (error) {
      blocked += 1;
      console.error(`${label} za ${group.id} niso bile očiščene: ${error.message || error}`);
    }
  }
  return { approvedGroups, drive, blocked };
}

async function runArchiveRetentionCleanup() {
  const db = await readDbAsync();
  // Permanent deletion is deliberately conservative: an app-managed Drive file
  // must be removed (or safely identified as already gone) before its event is
  // removed locally. External Docs/Sheets are never part of these candidates.
  const trashCandidates = trashedTodoRetentionCandidates(db);
  const trashApproval = await approveRetentionGroupsForPurge(db, trashCandidates.groups, "Priloge iz koša");
  const trashed = purgeExpiredTrashedTodoGroups(db, Date.now(), trashApproval.approvedGroups);
  const candidates = archiveRetentionCandidates(db);
  const archiveApproval = await approveRetentionGroupsForPurge(db, candidates.groups, "Arhivske priloge");
  const purged = purgeArchivedTodoGroups(db, archiveApproval.approvedGroups);
  const drive = {
    deleted: trashApproval.drive.deleted + archiveApproval.drive.deleted,
    skipped: trashApproval.drive.skipped + archiveApproval.drive.skipped
  };
  const blocked = trashApproval.blocked + archiveApproval.blocked;
  const cleanupChanged = Boolean(purged.todos || trashed.todos || blocked);
  const cleanupAudit = cleanupChanged ? {
    actor: { id: "system", name: "Sistem" },
    action: blocked ? "system.retention_cleanup.blocked" : "system.retention_cleanup.completed",
    targetType: "retention_cleanup",
    severity: blocked ? "warning" : "info",
    context: {
      archiveEventsRemoved: Number(purged.todos || 0),
      trashEventsRemoved: Number(trashed.todos || 0),
      attachmentsRemoved: Number(purged.attachments || 0) + Number(trashed.attachments || 0),
      adHocClientsRemoved: Number(purged.adHocClients || 0) + Number(trashed.adHocClients || 0),
      driveFilesRemoved: Number(drive.deleted || 0),
      driveFilesSkipped: Number(drive.skipped || 0),
      blockedGroups: Number(blocked || 0)
    }
  } : null;
  if (!DATABASE_URL && cleanupAudit) recordAuditLog(db, cleanupAudit);
  if (purged.todos || trashed.todos || (!DATABASE_URL && cleanupAudit)) await writeDbAsync(db);
  if (DATABASE_URL && cleanupAudit) scheduleAuditLog(cleanupAudit);
  if (blocked) {
    await recordOperationalAlert({
      code: "archive-retention-drive-cleanup-failed",
      severity: "warning",
      title: "Čiščenje arhiva ali koša čaka na Google Drive",
      message: `${blocked} dogodkov ni bilo očiščenih, ker njihovih aplikacijskih Drive prilog ni bilo mogoče varno odstraniti. Poveži Google Drive in sistem bo poskusil znova.`
    });
  }
  return { ...candidates, purged, trashed, trashCandidates, drive, blocked };
}
function scheduleArchiveRetentionCleanup(force = false) {
  if (archiveRetentionCleanupPromise) return archiveRetentionCleanupPromise;
  if (!force && archiveRetentionCleanupLastAt && Date.now() - archiveRetentionCleanupLastAt < ARCHIVE_RETENTION_CLEANUP_INTERVAL_MS) return Promise.resolve(null);
  archiveRetentionCleanupPromise = mutationQueue.then(async () => {
    const result = await runArchiveRetentionCleanup();
    archiveRetentionCleanupLastAt = Date.now();
    if (result.purged.todos) console.info(`Čiščenje arhiva: ${result.purged.todos} dogodkov, ${result.purged.attachments} prilog, ${result.purged.adHocClients} ad-hoc strank.`);
    if (result.trashed?.todos) console.info(`Čiščenje koša: ${result.trashed.todos} dogodkov, ${result.trashed.attachments} prilog, ${result.trashed.adHocClients} ad-hoc strank.`);
    return result;
  });
  mutationQueue = archiveRetentionCleanupPromise.catch((error) => {
    console.error(`Čiščenje arhiva ni uspelo: ${error.message || error}`);
    scheduleAuditLog({
      actor: { id: "system", name: "Sistem" },
      action: "system.retention_cleanup.failed",
      targetType: "retention_cleanup",
      severity: "error",
      context: { errorClass: cleanAuditLogText(error?.name || "Error", 80) }
    }, { dedupeMs: 10 * 60_000 });
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
  return (db.todos || []).filter((todo) => todoIds.has(String(todo.id || ""))
    && payrollWorkerForTodo(todo) === String(payroll.workerId || ""));
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
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    pathname = decodeURIComponent(requestUrl.pathname);
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
      const quickMode = String(requestUrl.searchParams.get("quick") || "");
      const quickManifest = ["task", "hours", "material"].includes(quickMode)
        ? `/manifest.webmanifest?quick=${encodeURIComponent(quickMode)}`
        : "/manifest.webmanifest";
      responseData = Buffer.from(data.toString("utf8")
        .replace('href="/manifest.webmanifest"', `href="${quickManifest}"`)
        .replace("<style>", `<style nonce="${nonce}">`)
        .replace("<script>", `<script nonce="${nonce}">`), "utf8");
    } else if (pathname === "/manifest.webmanifest") {
      const quickMode = String(requestUrl.searchParams.get("quick") || "");
      if (["task", "hours", "material"].includes(quickMode)) {
        const quickNames = {
          task: "Nov dogodek",
          hours: "Vpis ur",
          material: "Vpis materiala"
        };
        const manifest = JSON.parse(data.toString("utf8"));
        manifest.id = `/?quick=${quickMode}`;
        manifest.name = `${quickNames[quickMode]} · INDUS URE`;
        manifest.short_name = quickNames[quickMode];
        manifest.start_url = `/?quick=${quickMode}`;
        responseData = Buffer.from(JSON.stringify(manifest), "utf8");
      }
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
  for (const [state, pending] of pendingGoogleLogins) {
    const startedAt = typeof pending === "number" ? pending : Number(pending?.startedAt || 0);
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
  // A freshly uploaded attachment is deliberately not attached to a task until
  // the form is saved. It must nevertheless be visible to its uploader so the
  // form can render a video/photo preview and the user can verify it before
  // saving. The pending map also drops expired records here.
  const pendingVisible = pendingAttachmentMap(db)[attachmentId]?.userId === user.id;
  const todoVisible = (db.todos || []).some((todo) => canManageTodo(user, todo)
    && (todo.photos || []).some((photo) => photo.attachmentId === attachmentId));
  const advanceVisible = (db.debts || []).some((debt) => (user.role === "boss" || debt.person === user.id)
    && (debt.photos || []).some((photo) => photo.attachmentId === attachmentId));
  return pendingVisible || todoVisible || advanceVisible;
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
    todoCreateReceipts: {},
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

async function serverRuntimeStatus() {
  let disk = { available: false, totalBytes: 0, freeBytes: 0, usedPercent: 0 };
  try {
    const stats = await fsp.statfs('/');
    const blockSize = Number(stats.bsize || stats.frsize || 1);
    const totalBlocks = Number(stats.blocks || 0);
    const freeBlocks = Number(stats.bavail || stats.bfree || 0);
    const totalBytes = totalBlocks * blockSize;
    const freeBytes = freeBlocks * blockSize;
    disk = { available: Boolean(totalBytes), totalBytes, freeBytes, usedPercent: totalBytes ? Math.max(0, Math.min(100, (1 - freeBytes / totalBytes) * 100)) : 0 };
  } catch {}
  let lastBackup = null;
  let attachments = { count: 0, totalBytes: 0 };
  if (DATABASE_URL) {
    try {
      const result = await getPgPool().query("select data, finished_at from indus_backup_runs where status = 'success' order by finished_at desc limit 1");
      const row = result.rows[0];
      if (row) lastBackup = { finishedAt: row.finished_at, archiveBytes: Math.max(0, Number(row.data?.bytes || 0)), recoveryFile: String(row.data?.recoveryFile || '') };
    } catch {}
  }
  if (DATABASE_URL) {
    try {
      const result = await getPgPool().query("select count(*)::int as count, coalesce(sum(byte_size), 0)::bigint as total_bytes from indus_attachments");
      const row = result.rows[0] || {};
      attachments = { count: Math.max(0, Number(row.count || 0)), totalBytes: Math.max(0, Number(row.total_bytes || 0)) };
    } catch {}
  }
  const totalRamBytes = Number(os.totalmem() || 0);
  const freeRamBytes = Number(os.freemem() || 0);
  const cores = Math.max(1, Number(os.cpus()?.length || 1));
  const load1 = Number(os.loadavg?.()[0] || 0);
  return {
    cpu: { cores, load1, loadPercent: Math.max(0, Math.min(100, load1 / cores * 100)) },
    ram: { totalBytes: totalRamBytes, usedBytes: Math.max(0, totalRamBytes - freeRamBytes), usedPercent: totalRamBytes ? Math.max(0, Math.min(100, (1 - freeRamBytes / totalRamBytes) * 100)) : 0 },
    disk,
    attachments,
    uptimeSeconds: Math.max(0, Number(os.uptime() || 0)),
    appUptimeSeconds: Math.max(0, Number(process.uptime() || 0)),
    lastBackup
  };
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

function deniedGoogleLoginCode(email) {
  return `denied-google-login-${crypto.createHash("sha256").update(String(email || "").toLowerCase()).digest("hex").slice(0, 20)}`;
}

async function recordDeniedGoogleLogin(email, req = null) {
  const normalizedEmail = String(email || "").trim().toLowerCase().slice(0, 254);
  if (!normalizedEmail) return;
  scheduleAuditLog({
    actor: { id: "anonymous", name: "Neznan Google račun" },
    action: "auth.google.denied",
    targetType: "login",
    targetId: crypto.createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 16),
    severity: "security",
    context: {
      provider: "google",
      accountFingerprint: crypto.createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 16),
      source: req ? auditRequestSource(req) : "unknown"
    }
  }, { dedupeMs: 2 * 60_000 });
  if (DATABASE_URL) {
    try {
      await getPgPool().query(
        "insert into indus_access_attempts (id, email, outcome) values ($1, $2, $3)",
        [crypto.randomUUID(), normalizedEmail, "denied"]
      );
      await getPgPool().query("delete from indus_access_attempts where created_at < now() - interval '180 days'");
    } catch (error) {
      console.error(`Zavrnjene Google prijave ni bilo mogoče zapisati: ${error.message || error}`);
    }
  }
  await recordOperationalAlert({
    code: deniedGoogleLoginCode(normalizedEmail),
    severity: "warning",
    title: "Dostop zavrnjen",
    message: `Zavrnjen je bil poskus prijave z Google računom ${normalizedEmail}.`
  });
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
  scheduleAuditLog({
    actor: { id: "system", name: "Sistem" },
    action: "system.operational_alert",
    targetType: "operational_alert",
    targetId: cleanAuditLogText(code, 120),
    severity: auditLogSeverity(severity),
    context: { code: cleanAuditLogText(code, 120) }
  }, { dedupeMs: 6 * 60 * 60 * 1000 });
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
    const stats = await fsp.statfs('/');
    const free = Number(stats.bavail || stats.bfree || 0);
    const total = Number(stats.blocks || 0);
    const usedPercent = total ? (1 - free / total) * 100 : 0;
    if (total && usedPercent >= MONITOR_DISK_WARNING_PERCENT) {
      issues.push({ code: 'storage-low', severity: 'warning', title: 'Disk stre\u017enika je skoraj poln', message: `Disk stre\u017enika je ${Math.round(usedPercent)} % zaseden (opozorilo pri ${MONITOR_DISK_WARNING_PERCENT} %).` });
    }
  } catch {
    issues.push({ code: 'storage-unavailable', severity: 'critical', title: 'Diska stre\u017enika ni mogo\u010de preveriti', message: 'Stre\u017enik ne more preveriti prostora na sistemskem disku.' });
  }
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  if (rssMb > MONITOR_MAX_RSS_MB) {
    issues.push({ code: "memory-high", severity: "warning", title: "Poraba pomnilnika je visoka", message: `Proces INDUS URE porabi ${Math.round(rssMb)} MB RAM.` });
  }
  for (const issue of issues) await recordOperationalAlert(issue);
  if (DATABASE_URL) {
    try {
      await purgeExpiredPersistedAuditLog();
    } catch (error) {
      console.error(`Revizijskega dnevnika ni bilo mogoče počistiti: ${error.message || error}`);
    }
  }
  // A transient Gmail/Google outage must not make a late time-entry report
  // disappear.  The monitor retries the durable queue independently of user
  // traffic, while avoiding parallel deliveries.
  scheduleLateTimeEntryReportDelivery();
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
  attachApiAuditTrail(req, res, url);

  try {
    if (undoSystemLock && url.pathname !== "/api/health" && !url.pathname.startsWith("/api/undo-journal")) {
      sendJson(res, 423, {
        code: "undo_in_progress",
        error: "Sistem varno razveljavlja spremembo. Počakaj trenutek in poskusi znova."
      });
      return;
    }
    if (url.pathname === "/api/test-mode" && req.method === "GET") {
      const supportLogin = lanSupportLoginEnabled(req);
      sendJson(res, 200, {
        enabled: LOCAL_TEST_MODE || supportLogin,
        localNetwork: (LOCAL_TEST_MODE || supportLogin) ? "192.168.50.0/24" : "",
        ...(supportLogin ? { supportLogin: true } : {})
      });
      return;
    }

    if (url.pathname === "/api/test-login" && req.method === "POST") {
      // This endpoint is intentionally unavailable in production and from any
      // network except the current local subnet/loopback.
      if (!localTestLoginEnabled(req)) {
        sendJson(res, 404, { error: "Ni na voljo." });
        return;
      }
      if (!localTestLoginRateAllowed(req)) {
        sendJson(res, 429, { error: "Preveč neuspelih poskusov. Počakaj deset minut." });
        return;
      }
      const body = await readBody(req);
      const userId = String(body.userId || "").trim();
      if (!Object.hasOwn(defaultUsers, userId) || !validLocalLoginPassword(req, body.password)) {
        recordLocalTestLoginFailure(req);
        sendJson(res, 401, { error: "Testno uporabniško ime ali geslo ni pravilno." });
        return;
      }
      const db = await readDbAsync();
      const user = db.users?.[userId];
      if (!user) {
        sendJson(res, 403, { error: "Testni uporabnik ni na voljo." });
        return;
      }
      clearLocalTestLoginFailures(req);
      const sessionToken = createSession(db, user.id);
      await writeDbAsync(db);
      setSessionCookie(req, res, sessionToken);
      sendJson(res, 200, { ok: true, user: publicUser(user), csrfToken: db.sessions[sessionTokenHash(sessionToken)]?.csrfToken || "" });
      return;
    }
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
      const storageKey = attachmentMatch[2] ? source?.thumbnailKey : source?.storageKey;
      const relativeStorageKey = safeRestoreRelativePath(storageKey);
      const localFile = relativeStorageKey
        ? path.resolve(MEDIA_DIR, relativeStorageKey)
        : "";
      if (localFile && localFile.startsWith(`${MEDIA_DIR}${path.sep}`) && fs.existsSync(localFile)) {
        await sendAttachmentFile(res, { filePath: localFile, mimeType: attachmentMatch[2] ? source?.thumbnailMimeType || "image/jpeg" : source?.mimeType });
        return;
      }
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

    if (url.pathname === '/api/server-status' && req.method === 'GET') {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== 'boss') {
        sendJson(res, 403, { error: 'Status stre\u017enika vidi samo \u0161ef.' });
        return;
      }
      sendJson(res, 200, { status: await serverRuntimeStatus() });
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

    if (url.pathname === "/api/audit-log.csv" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Revizijski dnevnik vidi samo šef." });
        return;
      }
      const scope = url.searchParams.get("scope") === "all" ? "all" : "recent";
      const limit = scope === "all" ? AUDIT_LOG_MAX_EVENTS : 500;
      const events = DATABASE_URL
        ? await persistedAuditLogForUser(user, limit)
        : visibleAuditLogForUser(await readDbAsync(), user).slice(0, limit);
      const filename = scope === "all" ? "indus-ure-dnevnik-celoten.csv" : "indus-ure-dnevnik-zadnjih-500.csv";
      const csv = auditLogCsv(events);
      res.writeHead(200, securityHeaders({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": attachmentContentDisposition(filename),
        "Cache-Control": "no-store"
      }));
      res.end(csv);
      return;
    }

    if (url.pathname === "/api/audit-log" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Revizijski dnevnik vidi samo šef." });
        return;
      }
      const maxEvents = 500;
      const availableEvents = DATABASE_URL
        ? await persistedAuditLogForUser(user, maxEvents + 1)
        : visibleAuditLogForUser(await readDbAsync(), user);
      sendJson(res, 200, {
        events: availableEvents.slice(0, maxEvents),
        retentionDays: AUDIT_LOG_RETENTION_DAYS,
        maxEvents,
        truncated: availableEvents.length > maxEvents
      });
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

    if (url.pathname === "/api/undo-journal" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, {
        actions: visibleUndoJournal(db, user),
        locked: Boolean(undoSystemLock),
        maxActions: UNDO_JOURNAL_LIMIT
      });
      return;
    }
    const undoMatch = url.pathname.match(/^\/api\/undo-journal\/([a-f0-9-]{16,80})$/);
    if (undoMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: "Za razveljavitev je potrebna izrecna potrditev." });
        return;
      }
      const db = await readDbAsync();
      const current = currentUndoRecord(db);
      const requestedId = undoMatch[1];
      if (!current || current.id !== requestedId) {
        sendJson(res, 409, { error: "To dejanje ni več zadnje. Najprej razveljavi novejše dejanje." });
        return;
      }
      if (user.role !== "boss" && String(current.actorId) !== String(user.id)) {
        sendJson(res, 403, { error: "Razveljaviš lahko samo svoje zadnje dejanje." });
        return;
      }
      undoSystemLock = {
        actionId: current.id,
        startedAt: new Date().toISOString(),
        actorId: user.id,
        actorName: user.name || user.id
      };
      try {
        restoreUndoPatch(db, current.patch);
        // Billing and archive flags are derived from confirmed payrolls and
        // client bills.  Recalculate them after every undo so an entry whose
        // client bill was restored/deleted immediately returns to the list of
        // open client-billing items.
        reconcileTodoArchives(db, user);
        const undoneAt = new Date().toISOString();
        db.undoJournal = normalizeUndoJournal(db.undoJournal).map((record) => record.id === current.id
          ? {
            ...record,
            undoneAt,
            undoneBy: user.id,
            undoneByName: user.name || user.id,
            undoAction: (user.name || user.id) + " je razveljavil: " + record.action
          }
          : record);
        await writeDbAsync(db);
        scheduleAuditLog({
          actor: user,
          action: "undo.applied",
          targetType: "undo",
          targetId: current.id,
          context: { action: current.action }
        });
        sendJson(res, 200, {
          ok: true,
          undoneAction: current.action,
          actions: visibleUndoJournal(db, user),
          syncRevision: db.syncRevision
        });
      } finally {
        undoSystemLock = null;
      }
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
      pendingGoogleLogins.set(state, {
        startedAt: Date.now(),
        returnTo: safeAppReturnTo(url.searchParams.get("return_to"))
      });
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
        const pendingLogin = pendingGoogleLogins.get(token);
        pendingGoogleLogins.delete(token);
        const startedAt = typeof pendingLogin === "number" ? pendingLogin : Number(pendingLogin?.startedAt || 0);
        if (!startedAt || Date.now() - startedAt > 10 * 60 * 1000) {
          // Mobile browsers can restore or replay a consumed OAuth callback
          // from their navigation history.  Do not strand an already signed-in
          // user on a plain 401 page; a fresh app load will retain a valid
          // session cookie and otherwise show the normal login screen.
          const destination = new URL("/", absoluteBaseUrl(req));
          destination.searchParams.set("login", "expired");
          res.writeHead(303, securityHeaders({ Location: destination.toString(), "Cache-Control": "no-store" }));
          res.end();
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
          await recordDeniedGoogleLogin(email, req);
          sendText(res, 403, "Dostop je zavrnjen.", "text/plain");
          return;
        }
        const sessionToken = createSession(db, user.id);
        await writeDbAsync(db);
        scheduleAuditLog({
          actor: user,
          action: "auth.google.login",
          targetType: "session",
          severity: "info",
          context: { provider: "google", source: auditRequestSource(req) }
        });
        setSessionCookie(req, res, sessionToken);
        const destination = new URL(safeAppReturnTo(pendingLogin?.returnTo), absoluteBaseUrl(req));
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
      scheduleAuditLog({
        actor: user,
        action: "auth.google_workspace.connected",
        targetType: "google_workspace",
        severity: "security",
        context: { provider: "google", scopes: "drive_file,gmail_compose", source: auditRequestSource(req) }
      });
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
      // This is the first authenticated request on every page load. In
      // PostgreSQL keep it narrow so an e-mail todo link can open immediately.
      const user = await requireUserForLightweightSession(req, res);
      if (!user) return;
      sendJson(res, 200, {
        user: publicUser(user),
        csrfToken: req.indusSession?.csrfToken || "",
        sessionExpiresAt: req.indusSession?.expiresAt || 0,
        syncRevision: Number(req.indusDb?.syncRevision || 0)
      });
      return;
    }

    // The initial application snapshot deliberately avoids financial history
    // and unrelated attachment rows. A normal background bootstrap restores
    // the complete state immediately after the task board is usable.
    if (url.pathname === "/api/bootstrap" && req.method === "GET") {
      const user = await requireUserForLightweightSession(req, res);
      if (!user) return;
      const initialOnly = url.searchParams.get("initial") === "1";
      const db = DATABASE_URL && initialOnly
        ? await getPgStore().initialBootstrapSeed(user)
        : await readDbAsync();
      req.indusDb = db;
      const activeUsers = Object.values(db.users || {}).filter((worker) => worker.active !== false);
      const workers = activeUsers
        .filter((worker) => user.role === "boss" || worker.id === user.id)
        .map((worker) => ({
          id: worker.id,
          name: worker.name,
          role: worker.role,
          hourlyRate: defaultHourlyRateForUser(db, worker.id),
          exportTitle: String(worker.billing?.exportTitle || ""),
          commuteKmOneWay: commuteKmOneWayForUser(db, worker.id)
        }));
      const snapshot = {
        user: publicUser(user),
        csrfToken: req.indusSession?.csrfToken || "",
        sessionExpiresAt: req.indusSession?.expiresAt || 0,
        syncRevision: Number(db.syncRevision || 0),
        users: activeUsers.map(publicDirectoryUser),
        todos: visibleTodosForUser(db, user),
        clients: db.clients || [],
        settings: db.settings || {},
        workers
      };
      // The default screen only needs tasks, clients and workers. Financial
      // collections are hydrated immediately afterwards, without keeping the
      // first usable list behind their JSON serialization and download.
      if (!initialOnly) {
        snapshot.entries = visibleEntriesForUser(db, user);
        snapshot.debts = visibleDebtsForUser(db, user);
        snapshot.advances = visibleAdvancesForUser(db, user);
        snapshot.purchases = visiblePersonalPurchasesForUser(db, user);
        snapshot.billingLocks = db.billingLocks || [];
        snapshot.payrolls = payrollForUser(db, user);
        snapshot.clientBills = user.role === "boss" ? (db.clientBills || []) : [];
      }
      sendJson(res, 200, snapshot);
      return;
    }

    // Home-screen quick actions deliberately bypass the complete bootstrap.
    // A new task, time entry or material delivery needs a client lookup and
    // a small public directory, not the whole calendar history.
    if (url.pathname === "/api/quick-create" && req.method === "GET") {
      const user = await requireUserForLightweightSession(req, res);
      if (!user) return;
      const mode = String(url.searchParams.get("mode") || "");
      if (!["task", "hours", "material"].includes(mode)) {
        sendJson(res, 400, { error: "Neveljavna hitra bližnjica." });
        return;
      }
      const quick = DATABASE_URL
        ? await getPgStore().quickCreateSeed(user)
        : quickCreateBootstrapFromDb(await readDbAsync(), user);
      sendJson(res, 200, {
        user: publicUser(user),
        csrfToken: req.indusSession?.csrfToken || "",
        sessionExpiresAt: req.indusSession?.expiresAt || 0,
        syncRevision: Number(req.indusDb?.syncRevision || 0),
        ...quick
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
      const user = await requireUserForLightweightSession(req, res);
      if (!user) return;
      const users = DATABASE_URL
        ? await getPgStore().publicUserDirectory()
        : Object.values((req.indusDb || await readDbAsync()).users || {}).filter((entry) => entry.active !== false).map(publicDirectoryUser);
      sendJson(res, 200, { users });
      return;
    }

    if (url.pathname === "/api/workers" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Delavce lahko upravlja samo šef." });
        return;
      }
      const db = await readDbAsync();
      const workers = Object.values(db.users || {})
        .map((worker) => publicWorkerManagementUser(db, worker))
        .sort((left, right) => Number(right.active) - Number(left.active)
          || String(left.name || left.id).localeCompare(String(right.name || right.id), "sl"));
      sendJson(res, 200, { workers });
      return;
    }

    if (url.pathname === "/api/workers" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Delavce lahko upravlja samo šef." });
        return;
      }
      const body = await readBody(req);
      const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 120);
      const email = String(body.email || "").trim().toLowerCase();
      if (!name) {
        sendJson(res, 400, { error: "Vpiši ime delavca." });
        return;
      }
      if (email && !validEmailAddress(email)) {
        sendJson(res, 400, { error: "Google e-pošta ni pravilna." });
        return;
      }
      const db = await readDbAsync();
      if (email && Object.values(db.users || {}).some((worker) => String(worker.email || "").toLowerCase() === email)) {
        sendJson(res, 409, { error: "Ta Google e-pošta je že dodeljena drugemu delavcu." });
        return;
      }
      const id = crypto.randomUUID();
      db.users[id] = {
        id,
        name,
        email,
        role: "worker",
        avatar: "",
        active: true,
        employmentType: "contractor",
        timeEntryForIds: [id],
        billing: {}
      };
      db.users[id].dailyReport = workerDailyReportSettings(db, db.users[id]);
      recordAuditLog(db, {
        actor: user,
        action: "dodan delavec",
        targetType: "worker",
        targetId: id,
        context: { userId: id, name, hasGoogleLogin: Boolean(email), employmentType: "contractor" }
      });
      await writeDbAsync(db);
      sendJson(res, 201, {
        worker: publicWorkerManagementUser(db, db.users[id]),
        workers: Object.values(db.users).map((worker) => publicWorkerManagementUser(db, worker))
      });
      return;
    }

    const workerMatch = url.pathname === "/api/workers/billing" ? null : /^\/api\/workers\/([^/]+)$/.exec(url.pathname);
    if (workerMatch && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Delavce lahko upravlja samo šef." });
        return;
      }
      const id = cleanUserId(decodeURIComponent(workerMatch[1]));
      const body = await readBody(req);
      const db = await readDbAsync();
      const worker = db.users?.[id];
      if (!worker) {
        sendJson(res, 404, { error: "Delavec ne obstaja." });
        return;
      }
      const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 120);
      const email = String(body.email || "").trim().toLowerCase();
      if (!name) {
        sendJson(res, 400, { error: "Vpiši ime delavca." });
        return;
      }
      if (email && !validEmailAddress(email)) {
        sendJson(res, 400, { error: "Google e-pošta ni pravilna." });
        return;
      }
      if (email && Object.values(db.users || {}).some((candidate) => candidate.id !== id && String(candidate.email || "").toLowerCase() === email)) {
        sendJson(res, 409, { error: "Ta Google e-pošta je že dodeljena drugemu delavcu." });
        return;
      }
      const active = worker.role === "boss" ? true : body.active !== false;
      const requestedTargets = Array.isArray(body.timeEntryForIds) ? body.timeEntryForIds : [];
      const timeEntryForIds = [...new Set([id, ...requestedTargets]
        .map(cleanUserId)
        .filter((targetId) => Boolean(db.users?.[targetId]) && db.users[targetId].active !== false))];
      const currentDailyReport = workerDailyReportSettings(db, worker);
      const requestedDailyReport = body.dailyReport && typeof body.dailyReport === "object" ? body.dailyReport : currentDailyReport;
      const reportEmailEnabled = requestedDailyReport.emailEnabled !== false;
      const requestedReportRecipient = String(requestedDailyReport.recipientEmail || "").trim().toLowerCase();
      const reportRecipientEmail = requestedReportRecipient || dailyReportBossEmail(db);
      if (reportEmailEnabled && !validEmailAddress(reportRecipientEmail)) {
        sendJson(res, 400, { error: "Vpiši veljaven e-poštni naslov za dnevna poročila." });
        return;
      }
      if (requestedReportRecipient && !validEmailAddress(requestedReportRecipient)) {
        sendJson(res, 400, { error: "E-poštni naslov za dnevna poročila ni pravilen." });
        return;
      }
      worker.name = name;
      worker.email = email;
      worker.active = active;
      worker.employmentType = "contractor";
      worker.timeEntryForIds = active ? timeEntryForIds : [];
      worker.dailyReport = {
        emailEnabled: reportEmailEnabled,
        recipientEmail: reportRecipientEmail,
        includeZeroHours: requestedDailyReport.includeZeroHours === true
      };
      for (const candidate of Object.values(db.users || {})) {
        if (!candidate || candidate.id === id) continue;
        if (Array.isArray(candidate.timeEntryForIds)) candidate.timeEntryForIds = candidate.timeEntryForIds.filter((targetId) => targetId !== id);
      }
      normalizeWorkerProfile(id, worker, db.users);
      recordAuditLog(db, {
        actor: user,
        action: "spremenjen delavec",
        targetType: "worker",
        targetId: id,
        context: { userId: id, name, hasGoogleLogin: Boolean(email), active: worker.active, employmentType: worker.employmentType, timeEntryForIds: worker.timeEntryForIds, dailyReport: worker.dailyReport }
      });
      await writeDbAsync(db);
      sendJson(res, 200, {
        worker: publicWorkerManagementUser(db, worker),
        workers: Object.values(db.users).map((candidate) => publicWorkerManagementUser(db, candidate))
      });
      return;
    }

    if (workerMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Delavce lahko upravlja samo šef." });
        return;
      }
      const id = cleanUserId(decodeURIComponent(workerMatch[1]));
      await readBody(req);
      const db = await readDbAsync();
      const worker = db.users?.[id];
      if (!worker) {
        sendJson(res, 404, { error: "Delavec ne obstaja." });
        return;
      }
      if (worker.role === "boss") {
        sendJson(res, 400, { error: "Šefa ni mogoče odstraniti med delavci." });
        return;
      }
      const hasHistory = workerHasBusinessData(db, id);
      if (hasHistory) {
        worker.active = false;
        worker.timeEntryForIds = [];
        for (const candidate of Object.values(db.users || {})) {
          if (Array.isArray(candidate?.timeEntryForIds)) candidate.timeEntryForIds = candidate.timeEntryForIds.filter((targetId) => targetId !== id);
        }
      } else {
        delete db.users[id];
      }
      for (const [tokenHash, session] of Object.entries(db.sessions || {})) {
        if (session?.userId === id) delete db.sessions[tokenHash];
      }
      recordAuditLog(db, {
        actor: user,
        action: hasHistory ? "deaktiviran delavec" : "odstranjen delavec",
        targetType: "worker",
        targetId: id,
        context: { userId: id, name: worker.name || id, preservedHistory: hasHistory }
      });
      await writeDbAsync(db);
      sendJson(res, 200, {
        action: hasHistory ? "deactivated" : "deleted",
        workers: Object.values(db.users || {}).map((candidate) => publicWorkerManagementUser(db, candidate))
      });
      return;
    }

    if (url.pathname === "/api/worker-daily-report" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const requestedWorkerId = url.searchParams.get("workerId");
      const workerId = requestedWorkerId === null || requestedWorkerId === ""
        ? cleanUserId(user.id)
        : cleanUserId(requestedWorkerId);
      const date = String(url.searchParams.get("date") || "");
      if (!workerId || !isDateKey(date)) {
        sendJson(res, 400, { error: "Izberi veljavnega delavca in datum dnevnega povzetka." });
        return;
      }
      if (!canReadWorkerDailyReport(user, workerId)) {
        sendJson(res, 403, { error: "Dnevni povzetek drugega delavca vidi samo \u0161ef." });
        return;
      }
      const db = await readDbAsync();
      if (!db.users?.[workerId]) {
        sendJson(res, 404, { error: "Delavec ne obstaja." });
        return;
      }
      const report = workerDailyDigestSnapshot(db, workerId, date);
      if (!report) {
        sendJson(res, 404, { error: "Dnevni povzetek ni na voljo." });
        return;
      }
      sendJson(res, 200, { report });
      return;
    }
    if (url.pathname === "/api/payroll-export.xlsx" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const requestedWorkerId = cleanUserId(url.searchParams.get("workerId") || user.id);
      const workerId = user.role === "boss" ? requestedWorkerId : user.id;
      if (!workerId || (user.role !== "boss" && requestedWorkerId !== user.id)) {
        sendJson(res, 403, { error: "Izvoz obračuna drugega delavca lahko pripravi samo šef." });
        return;
      }
      const range = payrollRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
      if (!range) {
        sendJson(res, 400, { error: "Za izvoz izberi veljavno obračunsko obdobje." });
        return;
      }
      const db = await readDbAsync();
      const report = workerPayrollXlsxReport(db, workerId, range);
      if (!report) {
        sendJson(res, 404, { error: "Obračun za izbranega delavca ni na voljo." });
        return;
      }
      try {
        await sendWorkerPayrollXlsx(res, report);
      } catch (error) {
        console.error("Worker payroll XLSX export failed", error);
        if (!res.headersSent) sendJson(res, 500, { error: "Izvoz XLSX ni uspel." });
        else res.destroy(error);
      }
      return;
    }

    if (url.pathname === "/api/payrolls" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { payrolls: payrollForUser(db, user) });
      return;
    }

    const todoSharePdfTicketMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/share-pdf-ticket$/);
    if (todoSharePdfTicketMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoSharePdfTicketMatch[1]);
      const db = await readDbAsync();
      const todo = (db.todos || []).find((item) => item.id === id);
      if (!todo || isTrashedTodo(todo) || !canManageTodo(user, todo) || !todoShareReport(db, todo)) {
        sendJson(res, 404, { error: "Dogodek ni več na voljo." });
        return;
      }
      const token = createTodoSharePdfDownloadTicket(req, user, id);
      sendJson(res, 201, { downloadUrl: `/api/todos/share-pdf-download?ticket=${encodeURIComponent(token)}` });
      return;
    }

    if (url.pathname === "/api/todos/share-pdf-download" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const ticket = todoSharePdfDownloadTicketForRequest(req, user, url.searchParams.get("ticket"));
      if (!ticket) {
        sendJson(res, 410, { error: "Povezava za prenos PDF-ja je potekla. Ponovno odpri deljenje dogodka." });
        return;
      }
      const db = await readDbAsync();
      const todo = (db.todos || []).find((item) => item.id === ticket.todoId);
      if (!todo || isTrashedTodo(todo) || !canManageTodo(user, todo)) {
        sendJson(res, 404, { error: "Dogodek ni več na voljo." });
        return;
      }
      await sendTodoSharePdf(res, db, todo);
      return;
    }

    if (url.pathname === "/api/client-report/pdf-ticket" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "PDF poročilo za stranko lahko pripravi samo šef." });
        return;
      }
      const body = await readBody(req);
      if (!clientReportRequestIsValid(body)) {
        sendJson(res, 400, { error: "Izbrani vpisi za poročilo niso pravilni." });
        return;
      }
      const db = await readDbAsync();
      const report = clientReportSelection(db, body);
      if (!report) {
        sendJson(res, 409, { error: "Izbrani vpisi niso več na voljo za poročilo. Osveži pogled in preveri izbor." });
        return;
      }
      try {
        clientReportAttachmentSelection(report, body.attachmentIds);
      } catch {
        sendJson(res, 400, { error: "Izbrane priloge za PDF poročilo niso pravilne." });
        return;
      }
      const token = createClientReportDownloadTicket(req, user, body);
      sendJson(res, 201, { downloadUrl: `/api/client-report/pdf-download?ticket=${encodeURIComponent(token)}` });
      return;
    }

    if (url.pathname === "/api/client-report/pdf-download" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "PDF poročilo za stranko lahko pripravi samo šef." });
        return;
      }
      const ticket = clientReportDownloadTicketForRequest(req, user, url.searchParams.get("ticket"));
      if (!ticket) {
        sendJson(res, 410, { error: "Povezava za prenos PDF-ja je potekla. Ponovno klikni Prenesi PDF." });
        return;
      }
      const db = await readDbAsync();
      await sendClientReportPdf(res, db, ticket.payload);
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
        "Content-Disposition": attachmentContentDisposition(filename),
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
      const settledCorrections = settleCorrectionsForClientBill(db, clientBill, user);
      const archive = reconcileTodoArchives(db, user);
      await writeDbAsync(db);
      sendJson(res, 201, { clientBill, clientBills: db.clientBills, archive, settledCorrections, todos: visibleTodosForUser(db, user) });
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
      if (result.error) {
        sendJson(res, 409, { error: result.error });
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
        sendJson(res, 409, { error: "Obračun lahko potrdiš največ do današnjega dne." });
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
      const settledCorrections = settleCorrectionsForPayroll(db, payroll, user);
      const archive = await archivePayrollTodos(db, payroll, user);
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user), payroll, archive, settledCorrections });
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
        sendJson(res, 409, { error: "Obračun lahko potrdiš največ do današnjega dne." });
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
      const settledCorrections = action === "confirm" ? settleCorrectionsForPayroll(db, payroll, user) : 0;
      const archive = ["confirm", "reopen"].includes(action) ? await archivePayrollTodos(db, payroll, user) : null;
      await writeDbAsync(db);
      sendJson(res, 200, { payrolls: payrollForUser(db, user), payroll, archive, settledCorrections });
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
      const db = await readDbAsync();
      const activeUsers = Object.values(db.users || {}).filter((worker) => worker.active !== false);
      const workers = activeUsers
        .filter((worker) => user.role === "boss" || worker.id === user.id)
        .map((worker) => ({
        id: worker.id,
        name: worker.name,
        role: worker.role,
        hourlyRate: defaultHourlyRateForUser(db, worker.id),
        exportTitle: String(worker.billing?.exportTitle || ""),
        commuteKmOneWay: commuteKmOneWayForUser(db, worker.id)
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
      const commuteKmOneWay = nonnegativeNumber(body.commuteKmOneWay, nonnegativeNumber(db.users?.[workerId]?.billing?.commuteKmOneWay, 0, 1_000_000), 1_000_000);
      if (!db.users?.[workerId] || hourlyRate === null) {
        sendJson(res, 400, { error: "Delavec ali urna postavka ni pravilna." });
        return;
      }
      db.users[workerId].billing = { ...(db.users[workerId].billing || {}), hourlyRate, exportTitle, commuteKmOneWay };
      await writeDbAsync(db);
      const workers = Object.values(db.users).map((worker) => ({
        id: worker.id,
        name: worker.name,
        role: worker.role,
        hourlyRate: defaultHourlyRateForUser(db, worker.id),
        exportTitle: String(worker.billing?.exportTitle || ""),
        commuteKmOneWay: commuteKmOneWayForUser(db, worker.id)
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

    if (url.pathname === "/api/todos/trash" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { todos: visibleTrashedTodosForUser(db, user), retentionDays: DELETED_TODO_RETENTION_DAYS });
      return;
    }
    if (url.pathname === "/api/todos/reorder" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      if (!String(body.sourceId || "").trim()) {
        sendJson(res, 409, { error: "Ročni vrstni red se je posodobil. Osveži stran in ponovi premik." });
        return;
      }
      const db = await readDbAsync();
      const result = applySharedManualTodoOrder(db, user, body);
      if (result.error) {
        sendJson(res, result.status || 400, { error: result.error, ...(result.lock ? { lock: result.lock } : {}) });
        return;
      }
      await writeDbAsync(db);
      sendJson(res, 200, { todos: visibleTodosForUser(db, user) });
      return;
    }

    if (url.pathname === "/api/todos/bulk-client" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "Stranko pri obračunskih vpisih lahko paketno spremeni samo šef." });
        return;
      }
      const body = await readBody(req);
      const eventIds = [...new Set((Array.isArray(body.eventIds) ? body.eventIds : [])
        .map((id) => String(id || "").trim()).filter(Boolean))];
      if (!eventIds.length || eventIds.length > 2_000) {
        sendJson(res, 400, { error: "Označi od 1 do 2000 še neobračunanih vpisov." });
        return;
      }
      const db = await readDbAsync();
      const client = clientForBilling(db, body);
      if (!client) {
        sendJson(res, 400, { error: "Izberi obstoječo stranko iz baze." });
        return;
      }
      const selected = new Set(eventIds);
      const billed = confirmedClientBillByEvent(db);
      const groups = new Map();
      for (const todo of db.todos || []) {
        const eventId = todoBillingEventId(todo);
        if (!selected.has(eventId) || isTrashedTodo(todo) || !todoRequiresClientBilling(todo)) continue;
        if (!groups.has(eventId)) groups.set(eventId, []);
        groups.get(eventId).push(todo);
      }
      if (groups.size !== selected.size) {
        sendJson(res, 409, { error: "Eden ali več označenih vpisov ni več na voljo. Osveži poročilo in preveri izbor." });
        return;
      }
      const lockedEventId = eventIds.find((eventId) => billed.has(eventId));
      if (lockedEventId) {
        sendJson(res, 409, { error: "Potrjenega obračuna stranki ni mogoče paketno spreminjati. Najprej prekliči pripadajoči obračun." });
        return;
      }
      for (const todos of groups.values()) {
        const lock = todoAssignmentEditLockConflict(db, todos[0], user);
        if (lock) {
          sendJson(res, 409, { error: `Opravilo trenutno ureja ${lock.lockedByName || lock.lockedById}.`, lock });
          return;
        }
      }
      const selectedTodoIds = new Set([...groups.values()].flat().map((todo) => String(todo.id || "")).filter(Boolean));
      const now = new Date().toISOString();
      db.todos = (db.todos || []).map((todo) => !selectedTodoIds.has(String(todo.id || "")) ? todo : {
        ...todo,
        clientId: String(client.clientId || ""),
        client: String(client.name || ""),
        clientContactIds: [],
        clientContacts: [],
        updatedAt: now,
        updatedBy: user.id,
        updatedByName: user.name,
        history: [...(todo.history || []), audit(user, `stranka zamenjana na ${client.name}`)]
      });
      pruneUnusedAdHocClients(db);
      await writeDbAsync(db);
      sendJson(res, 200, {
        client: { clientId: String(client.clientId || ""), name: String(client.name || "") },
        affectedEventCount: eventIds.length,
        todos: visibleTodosForUser(db, user)
      });
      return;
    }
    if (url.pathname === "/api/ajpes/search" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      try {
        const results = await searchAjpesPublicRegister(url.searchParams.get("q") || "");
        sendJson(res, 200, { results });
      } catch (error) {
        sendJson(res, Number(error?.status) || 502, { error: error?.publicMessage || "AJPES iskalnik trenutno ni dosegljiv. Poskusi znova." });
      }
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
        if (!project || isTrashedTodo(project) || !["execution", "open", "in_progress", "internal"].includes(project.status)) {
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
        if (!project || isTrashedTodo(project) || !["execution", "open", "in_progress", "internal"].includes(project.status)) { sendJson(res, 400, { error: "Povezano opravilo ni več odprto." }); return; }
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
      const body = await readBody(req);
      const requested = cleanClient(body);
      const db = await readDbAsync();
      const clientText = [requested.name, requested.search].map((value) => String(value || "").trim().toLowerCase());
      const existingIndex = db.clients.findIndex((row) => row.clientId === requested.clientId
        || (requested.registryNumber && row.registryNumber === requested.registryNumber)
        || (requested.taxId && row.taxId === requested.taxId)
        || [row.name, row.search].some((value) => clientText.includes(String(value || "").trim().toLowerCase())));
      const existingClient = existingIndex >= 0 ? db.clients[existingIndex] : null;
      let client = cleanClient(body, { existingClient });
      const validation = validateClient(client);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const now = new Date().toISOString();
      if (existingClient) {
        client = normalizeStoredClient({
          ...existingClient,
          ...client,
          id: existingClient.clientId,
          clientId: existingClient.clientId,
          updatedAt: now
        });
        db.clients[existingIndex] = client;
      } else {
        client = normalizeStoredClient({
          ...client,
          createdBy: user.id,
          createdAt: now,
          updatedAt: now
        });
        db.clients.push(client);
      }
      await writeDbAsync(db);
      sendJson(res, 200, { clients: db.clients, client });
      return;
    }

    const clientMatch = url.pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (clientMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!canDeleteClient(user)) {
        sendJson(res, 403, { error: "Samo \u0161ef lahko izbri\u0161e stranko." });
        return;
      }
      const db = await readDbAsync();
      const result = deleteClientIfSafe(db, decodeURIComponent(clientMatch[1]));
      if (!result.deleted) {
        sendJson(res, result.status || 409, {
          error: result.error || "Stranke ni mogo\u010de izbrisati.",
          activeTodoIds: result.activeTodoIds || [],
          activeEntryIds: result.activeEntryIds || []
        });
        return;
      }
      await writeDbAsync(db);
      sendJson(res, 200, { clients: db.clients, deletedClientId: result.client.clientId });
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
      const clientMutationId = cleanClientMutationId(body.clientMutationId);
      const requestHash = clientMutationId ? todoCreateRequestHash(body) : "";
      const db = await readDbAsync();
      const receiptKey = clientMutationId ? todoCreateReceiptKey(user.id, clientMutationId) : "";
      const receipt = receiptKey ? db.todoCreateReceipts?.[receiptKey] : null;
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          sendJson(res, 409, { code: "mutation_id_reused", error: "Isti identifikator ustvarjanja je bil \u017ee uporabljen za drugo opravilo." });
          return;
        }
        sendJson(res, 200, {
          todos: visibleTodosForUser(db, user),
          assignedTo: receipt.assigneeIds.map((id) => publicDirectoryUser(db.users[id])).filter(Boolean),
          idempotent: true
        });
        return;
      }
      let todo = cleanTodo(body);
      const validation = validateTodo(todo);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const sourceProject = preserveTimeEntrySourceProject(db, user, todo);
      if (sourceProject.error) {
        sendJson(res, 400, { error: sourceProject.error });
        return;
      }
      todo = sourceProject.todo;
      const now = new Date().toISOString();
      todo = attachResolvedClient(db, todo, { createAdHoc: true, user });
      const contactSelection = applyTodoClientContactSelection(db, todo, { strict: true });
      if (contactSelection.error) {
        sendJson(res, 400, { error: contactSelection.error });
        return;
      }
      todo = contactSelection.todo;
      const resolvedValidation = validateTodo(todo, { requireClientId: true });
      if (resolvedValidation) {
        sendJson(res, 400, { error: resolvedValidation });
        return;
      }
      todo = storeTodoAttachments(db, todo, user);
      const minOrder = db.todos.reduce((min, item) => Math.min(min, Number(item.order || 0)), 0);
      const newOrder = todo.order || minOrder - 1;
      const sharedManualDomain = todoManualOrderDomain(todo);
      const sharedManualBucket = sharedManualDomain === "active" ? "unsorted" : "sorted";
      const sharedManualOrder = sharedManualOrderBefore(db, {
        domain: sharedManualDomain || "active",
        bucket: sharedManualBucket
      });
      const hasExplicitAssignees = Array.isArray(body.assigneeIds);
      const requestedAssigneeIds = hasExplicitAssignees
        ? [...new Set(body.assigneeIds
          .map(cleanUserId)
          .filter((assigneeId) => Boolean(db.users?.[assigneeId]) && db.users[assigneeId].active !== false))]
        : [];
      if (user.role !== "boss" && TIME_ENTRY_TODO_STATUSES.has(todo.status) && requestedAssigneeIds.some((assigneeId) => !canRecordHoursFor(db, user, assigneeId))) {
        sendJson(res, 403, { error: "Delavec lahko ure vpiše samo sebi ali za delavce, ki jih je določil šef." });
        return;
      }
      if (hasExplicitAssignees && !requestedAssigneeIds.length && !["meal", "material", "note"].includes(todo.status)) {
        sendJson(res, 400, { error: "Izberi vsaj enega izvajalca." });
        return;
      }
      let assigneeIds = requestedAssigneeIds.length
        ? requestedAssigneeIds
        : todoAssigneesForRequest(user, todo.syncUser, db.users);
      if (["meal", "material", "note"].includes(todo.status)) assigneeIds = [syncUserForRequest(user, todo.syncUser || assigneeIds[0] || user.id, "", db.users)];
      if (TIME_ENTRY_TODO_STATUSES.has(todo.status) && assigneeIds.length !== 1) {
        sendJson(res, 400, { error: "Vnos ur se vpisuje posebej za enega delavca." });
        return;
      }
      if (TIME_ENTRY_TODO_STATUSES.has(todo.status)) {
        // Dnevna pot se začne obračunavati šele za vpise, ustvarjene po
        // uvedbi tega pravila; stari zgodovinski vnosi ostanejo nedotaknjeni.
        todo = { ...todo, commuteEligible: true };
        const conflictMessage = timeEntryConflictMessage(db, { ...todo, syncUser: assigneeIds[0] }, assigneeIds[0]);
        if (conflictMessage) {
          sendJson(res, 409, { error: conflictMessage, code: "time_entry_overlap" });
          return;
        }
      }
      const assignmentGroupId = crypto.randomUUID();
      const createdTodoIds = [];
      assigneeIds.forEach((assigneeId, index) => {
        const assignee = db.users[assigneeId];
        const assignedTodo = todoForUserRole(user, db, null, { ...todo, syncUser: assigneeId });
        const assignedTodoId = crypto.randomUUID();
        db.todos.push({
          id: assignedTodoId,
          ...assignedTodo,
          assignmentGroupId,
          photos: stampTodoPhotos(todo, user),
          driveFiles: stampTodoDriveFiles(todo, user),
          syncUser: assigneeId,
          userOrderBuckets: { ...(todo.userOrderBuckets || {}), [assigneeId]: "unsorted" },
          sharedManualBucket,
          sharedManualOrder,
          order: newOrder + index,
          createdBy: user.id,
          createdByName: user.name,
          createdAt: now,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          history: [audit(user, `dodano opravilo za ${assignee?.name || assigneeId}`)]
        });
        createdTodoIds.push(assignedTodoId);
      });
      recordTodoChangeNotices(
        db,
        db.todos.filter((item) => createdTodoIds.includes(item.id)),
        user,
        todoChangeNoticeFields({}, {}, { created: true }),
        "created",
        now
      );
      if (receiptKey) {
        db.todoCreateReceipts[receiptKey] = {
          userId: user.id,
          mutationId: clientMutationId,
          kind: "todo-create",
          requestHash,
          assignmentGroupId,
          todoIds: createdTodoIds,
          assigneeIds,
          createdAt: now
        };
      }
      const lateTimeEntryReports = createdTodoIds
        .map((todoId) => queueLateTimeEntryReport(db, {
          before: null,
          after: db.todos.find((item) => item.id === todoId),
          user,
          kind: "dodan pozni vpis ur"
        }))
        .filter(Boolean);
      await writeDbAsync(db);
      if (lateTimeEntryReports.length) scheduleLateTimeEntryReportDelivery();
      sendJson(res, 200, {
        todos: visibleTodosForUser(db, user),
        assignedTo: assigneeIds.map((id) => publicDirectoryUser(db.users[id])),
        lateTimeEntryReportsQueued: lateTimeEntryReports.length
      });
      return;
    }

    if (url.pathname === "/api/todos/drive-files" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      sendJson(res, 410, { error: "Dokumente in preglednice pripni kot zunanjo povezavo. Drive je rezerviran za varnostne kopije." });
      return;
    }

    if (url.pathname === "/api/todos/image" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      let name = String(req.headers["x-indus-file-name"] || "fotografija");
      try { name = decodeURIComponent(name); } catch { /* keep encoded value */ }
      const received = await receiveLocalTodoImage({
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
            thumbnailKey: received.thumbnailKey,
            thumbnailMimeType: "image/jpeg",
            createdBy: user.id,
            createdByName: user.name,
            createdAt: new Date().toISOString()
          };
          pending[received.attachmentId] = { userId: user.id, expiresAt: Date.now() + PENDING_ATTACHMENT_TTL_MS };
          await writeDbAsync(db);
          return {
            id: crypto.randomUUID(),
            attachmentId: received.attachmentId,
            name: name.slice(0, 120) || "Fotografija",
            comment: "",
            createdBy: user.id,
            createdByName: user.name,
            createdAt: new Date().toISOString(),
            mimeType: received.mimeType,
            url: attachmentApiUrl(received.attachmentId),
            thumbnailUrl: attachmentApiUrl(received.attachmentId, true)
          };
        });
        sendJson(res, 201, { photo });
      } catch (error) {
        if (received.createdFiles?.display) await fsp.rm(received.displayTargetPath, { force: true }).catch(() => {});
        if (received.createdFiles?.thumbnail) await fsp.rm(received.thumbnailTargetPath, { force: true }).catch(() => {});
        throw error;
      }
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
      const id = decodeURIComponent(todoLockMatch[1]);
      const user = await requireUserForFocusedTodo(req, res);
      if (!user) return;
      const body = await readBody(req);
      if (DATABASE_URL) {
        const focused = await getPgStore().focusedTodoForLock(id);
        const todo = focused?.todo;
        if (!todo) {
          sendJson(res, 404, { code: "todo_not_found", error: "Opravilo ne obstaja več." });
          return;
        }
        if (!canManageTodo(user, todo)) {
          sendJson(res, 403, { code: "todo_not_editable", error: "Tega opravila ne moreš urejati." });
          return;
        }
        if (isTrashedTodo(todo)) {
          sendJson(res, 409, { error: "Opravilo je v Izbrisano. Najprej ga obnovi." });
          return;
        }
        const result = acquireTodoEditLockGroup(id, focused.assignmentIds, user, body.lockToken);
        if (!result.ok) {
          sendJson(res, 409, { error: `Opravilo trenutno ureja ${result.lock.lockedByName || result.lock.lockedById}.`, lock: result.lock });
          return;
        }
        sendJson(res, 200, { lockToken: result.token, lock: result.lock });
        return;
      }
      const db = req.indusDb || await readDbAsync();
      const todo = db.todos.find((item) => item.id === id);
      if (!todo) {
        sendJson(res, 404, { code: "todo_not_found", error: "Opravilo ne obstaja več." });
        return;
      }
      if (!canManageTodo(user, todo)) {
        sendJson(res, 403, { code: "todo_not_editable", error: "Tega opravila ne moreš urejati." });
        return;
      }
      if (isTrashedTodo(todo)) {
        sendJson(res, 409, { error: "Opravilo je v Izbrisano. Najprej ga obnovi." });
        return;
      }      const result = acquireTodoAssignmentEditLock(db, todo, user, body.lockToken);
      if (!result.ok) {
        sendJson(res, 409, { error: `Opravilo trenutno ureja ${result.lock.lockedByName || result.lock.lockedById}.`, lock: result.lock });
        return;
      }
      sendJson(res, 200, { lockToken: result.token, lock: result.lock });
      return;
    }

    if (todoLockMatch && req.method === "DELETE") {
      const user = DATABASE_URL
        ? await requireUserForFocusedTodo(req, res)
        : await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoLockMatch[1]);
      const body = await readBody(req);
      if (DATABASE_URL) {
        const focused = await getPgStore().focusedTodoForLock(id);
        if (focused?.todo && canManageTodo(user, focused.todo)) {
          releaseTodoEditLockGroup(id, focused.assignmentIds, user, body.lockToken);
        } else {
          releaseTodoEditLock(id, user, body.lockToken);
        }
      } else {
        const db = await readDbAsync();
        const todo = db.todos.find((item) => item.id === id);
        if (todo) {
          releaseTodoAssignmentEditLock(db, todo, user, body.lockToken);
        } else {
          releaseTodoEditLock(id, user, body.lockToken);
        }
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    const todoCompletionRequestMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/completion-request$/);
    if (todoCompletionRequestMatch) {
      const id = decodeURIComponent(todoCompletionRequestMatch[1]);
      // E-mail links must not hydrate every task, attachment and payroll row
      // before opening one editor.  The token lookup is deliberately scoped to
      // its logical assignment group and also survives a later assignment copy.
      if (req.method === "GET" && DATABASE_URL) {
        const user = await requireUserForFocusedTodo(req, res);
        if (!user) return;
        const tokenHash = sessionTokenHash(String(url.searchParams.get("token") || ""));
        const requestGroup = await getPgStore().completionRequestGroup(id, tokenHash);
        const request = cleanTodoCompletionRequests(requestGroup?.completionRequests)
          .find((item) => item.tokenHash === tokenHash);
        if (!request) {
          sendJson(res, 403, { error: "Povezava za dopolnitev ni veljavna ali je potekla." });
          return;
        }
        if (!request.recipientUserIds.includes(user.id)) {
          sendJson(res, 403, { error: "Ta povezava je namenjena drugemu uporabniku." });
          return;
        }
        const recipientAssignment = (requestGroup?.assignments || []).find((assignment) => {
          const candidate = assignment?.data || {};
          return user.role === "boss"
            || String(candidate.syncUser || "") === user.id
            || String(candidate.createdBy || "") === user.id
            || String(assignment.workerId || "") === user.id;
        });
        if (!recipientAssignment) {
          sendJson(res, 403, { error: "Za to opravilo nimas dostopa." });
          return;
        }
        const focused = await getPgStore().focusedTodo(recipientAssignment.id);
        const source = focused?.todo;
        if (!source || isTrashedTodo(source) || !canManageTodo(user, source)) {
          sendJson(res, 403, { error: "Za to opravilo nimas dostopa." });
          return;
        }
        const hydrated = hydrateTodoAttachments({ attachments: focused.attachments }, {
          ...source,
          assigneeIds: focused.assigneeIds
        });
        const { completionRequests, ...todo } = hydrated;
        sendJson(res, 200, {
          todo,
          request: {
            requestedByName: request.requestedByName || request.requestedBy,
            comment: request.comment,
            expiresAt: request.expiresAt
          }
        });
        return;
      }
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      let todo = (db.todos || []).find((item) => item.id === id);
      if (req.method === "GET") {
        const token = String(url.searchParams.get("token") || "");
        const tokenHash = sessionTokenHash(token);
        const match = findActiveTodoCompletionRequest(db, id, tokenHash);
        if (!match) {
          sendJson(res, 403, { error: "Povezava za dopolnitev ni veljavna ali je potekla." });
          return;
        }
        todo = match.todo;
        const request = match.request;
        if (!request.recipientUserIds.includes(user.id)) {
          sendJson(res, 403, { error: "Ta povezava je namenjena drugemu uporabniku." });
          return;
        }
        const recipientTodo = todoAssignmentItems(db, todo).find((item) => canManageTodo(user, item));
        if (!recipientTodo) {
          sendJson(res, 403, { error: "Za to opravilo nimas dostopa." });
          return;
        }
        const visible = visibleTodosForUser({ ...db, todos: [recipientTodo] }, user)[0];
        sendJson(res, 200, {
          todo: visible,
          request: {
            requestedByName: request.requestedByName || request.requestedBy,
            comment: request.comment,
            expiresAt: request.expiresAt
          }
        });
        return;
      }

      if (!todo) {
        sendJson(res, 404, { error: "Opravilo ne obstaja." });
        return;
      }
      if (isTrashedTodo(todo)) {
        sendJson(res, 404, { error: "Opravilo je v Izbrisano." });
        return;
      }

      if (req.method === "POST") {
        if (user.role !== "boss" || String(user.email || "").toLowerCase() !== GOOGLE_DRIVE_OWNER_EMAIL) {
          sendJson(res, 403, { error: "Zahtevek za dopolnitev lahko po\u0161lje samo Bojan." });
          return;
        }
        const body = await readBody(req);
        const assignmentRecipientIds = new Set([
          ...todoAssignmentAssigneeIds(db, todo),
          cleanUserId(todo.createdBy),
          cleanUserId(todo.syncUser)
        ].filter(Boolean));
        const requestedRecipientIds = Array.isArray(body.recipientUserIds)
          ? body.recipientUserIds
          : [body.recipientUserId || todo.createdBy || todo.syncUser];
        const recipientUserIds = [...new Set(requestedRecipientIds.map(cleanUserId).filter(Boolean))].slice(0, 20);
        if (!recipientUserIds.length) {
          sendJson(res, 400, { error: "Izberi vsaj enega prejemnika." });
          return;
        }
        if (recipientUserIds.some((recipientUserId) => !assignmentRecipientIds.has(recipientUserId))) {
          sendJson(res, 403, { error: "Prejemnik mora biti izvajalec tega opravila." });
          return;
        }
        const recipients = recipientUserIds.map((recipientUserId) => db.users?.[recipientUserId]);
        if (recipients.some((recipient) => !recipient || !validEmailAddress(recipient.email))) {
          sendJson(res, 409, { error: "Izbrani prejemnik nima veljavnega e-po\u0161tnega naslova." });
          return;
        }
        const owner = googleDriveOwner(db);
        if (!googleReady() || !googleWorkspaceTokenAvailable(owner)) {
          sendJson(res, 409, { error: "V Nastavitvah kot Bojan najprej ponovno pove\u017ei Google Dokumente, preglednice in Gmail." });
          return;
        }
        const comment = String(body.comment || "").trim().slice(0, 2_000);
        const rawToken = crypto.randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + TODO_COMPLETION_REQUEST_TTL_MS;
        const link = new URL("/", absoluteBaseUrl(req));
        link.searchParams.set("todo", todo.id);
        link.searchParams.set("completion", rawToken);
        const due = new Date(expiresAt).toLocaleString("sl-SI");
        const text = [
          (user.name || "Bojan") + " prosi za dopolnitev opravila.",
          "",
          "Opravilo: " + (todo.title || "Brez naslova"),
          todo.client ? "Stranka: " + todo.client : "",
          comment ? "Vprašanje / komentar:\n" + comment : "",
          "",
          "Odpri opravilo in ga dopolni:",
          link.toString(),
          "",
          "Povezava velja do " + due + ". Za odpiranje se prijavi s svojim Google računom INDUS URE."
        ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n");
        try {
          const { google } = require("googleapis");
          const gmail = google.gmail({ version: "v1", auth: googleClient(req, owner.google.tokens) });
          await gmail.users.messages.send({
            userId: "me",
            requestBody: {
              raw: gmailCompletionRequestRaw({
                to: recipients.map((recipient) => recipient.email).join(", "),
                subject: "Dopolnitev opravila: " + (todo.title || "INDUS URE"),
                text
              })
            }
          });
        } catch (error) {
          console.error("Zahtevka za dopolnitev ni bilo mogo\u010de poslati:", error.message || error);
          sendJson(res, 502, { error: "E-po\u0161te ni bilo mogo\u010de poslati. V Nastavitvah ponovno pove\u017ei Google ra\u010dun in poskusi znova." });
          return;
        }
        const completionRequests = [
          ...todoCompletionRequestsForAssignment(db, todo),
          {
            id: crypto.randomUUID(),
            tokenHash: sessionTokenHash(rawToken),
            recipientUserIds: recipients.map((recipient) => recipient.id),
            recipientEmails: recipients.map((recipient) => String(recipient.email).toLowerCase()),
            recipientUserId: recipients[0].id,
            recipientEmail: String(recipients[0].email).toLowerCase(),
            requestedBy: user.id,
            requestedByName: user.name || user.id,
            comment,
            createdAt: new Date().toISOString(),
            expiresAt
          }
        ];
        for (const assignmentTodo of todoAssignmentItems(db, todo)) {
          assignmentTodo.completionRequests = completionRequests.map((request) => ({
            ...request,
            recipientUserIds: [...request.recipientUserIds],
            recipientEmails: [...request.recipientEmails]
          }));
        }
        todo.history = [...(todo.history || []), audit(user, "poslan zahtevek za dopolnitev: " + recipients.map((recipient) => recipient.name || recipient.id).join(", "))];
        await writeDbAsync(db);
        sendJson(res, 201, {
          ok: true,
          recipients: recipients.map((recipient) => ({ id: recipient.id, name: recipient.name || recipient.id, email: recipient.email })),
          expiresAt
        });
        return;
      }

      sendJson(res, 405, { error: "Ta metoda ni podprta." });
      return;
    }

    if (url.pathname === "/api/todos/time-batch" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const editorWorkContext = String(body.editorWorkContext || "");
      const requestedItems = Array.isArray(body.items) ? body.items : [];
      const requestedLockTokens = body.editLockTokens && typeof body.editLockTokens === "object" && !Array.isArray(body.editLockTokens)
        ? body.editLockTokens
        : {};
      if (!requestedItems.length || requestedItems.length > 100) {
        sendJson(res, 400, { error: "Za shranjevanje časovnice izberi od 1 do 100 dogodkov." });
        return;
      }
      const seenIds = new Set();
      if (requestedItems.some((item) => {
        const id = String(item?.id || "").trim();
        if (!id || seenIds.has(id)) return true;
        seenIds.add(id);
        return false;
      })) {
        sendJson(res, 400, { error: "Dnevni pogled vsebuje podvojen ali neveljaven dogodek." });
        return;
      }
      const db = await readDbAsync();
      const operations = [];
      const operationByAssignmentId = new Map();
      for (const requested of requestedItems) {
        const previousTodo = (db.todos || []).find((item) => item.id === String(requested.id || ""));
        if (!previousTodo || isTrashedTodo(previousTodo) || !canManageTodo(user, previousTodo)) {
          sendJson(res, 403, { error: "Eno od opravil v dnevnem pogledu ne obstaja več ali ga ne smeš spreminjati." });
          return;
        }
        const assignmentItems = todoAssignmentItems(db, previousTodo);
        const lockTokens = [...new Set(assignmentItems
          .map((item) => String(requestedLockTokens[String(item.id || "")] || "").trim())
          .filter(Boolean))];
        if (lockTokens.length > 1) {
          sendJson(res, 400, { error: "Za skupno opravilo je poslanih več različnih zaklepov." });
          return;
        }
        const editLockToken = lockTokens[0] || "";
        const editLock = todoAssignmentEditLockConflict(db, previousTodo, user, editLockToken);
        if (editLock) {
          sendJson(res, 409, { error: `Opravilo trenutno ureja ${editLock.lockedByName || editLock.lockedById}.`, lock: editLock });
          return;
        }
        const baseUpdatedAt = String(requested.baseUpdatedAt || "");
        if (!baseUpdatedAt || baseUpdatedAt !== String(previousTodo.updatedAt || "")) {
          sendJson(res, 409, { error: "Opravilo je bilo medtem spremenjeno na drugi napravi." });
          return;
        }
        const start = roundTimeToQuarterHour(requested.start);
        const end = roundTimeToQuarterHour(requested.end);
        const date = isDateKey(requested.date) ? String(requested.date) : previousTodo.date;
        const previousDate = String(previousTodo.date || "");
        const dayShift = previousDate && date ? Math.round((new Date(`${date}T00:00:00`) - new Date(`${previousDate}T00:00:00`)) / 86400000) : 0;
        const endDate = shiftDateKey(todoEndDate(previousTodo), dayShift) || date;
        const validation = validateTodo({ ...previousTodo, date, endDate, start, end });
        if (validation) {
          sendJson(res, 400, { error: validation });
          return;
        }
        const payrollLock = payrollLockForTodos(db, assignmentItems);
        if (payrollLock) {
          sendJson(res, 403, { error: `Opravilo je del potrjenega obračuna za ${db.users?.[payrollLock.workerId]?.name || payrollLock.workerId} (${payrollLock.month}). Šef ga mora najprej ponovno odpreti.` });
          return;
        }
        const clientBillLock = clientBillLockForTodos(db, assignmentItems);
        if (clientBillLock) {
          sendJson(res, 403, { error: clientBillEditLockMessage(clientBillLock) });
          return;
        }
        const assignmentIds = assignmentItems.map((item) => String(item.id || "")).filter(Boolean);
        const overlapping = assignmentIds.map((id) => operationByAssignmentId.get(id)).find(Boolean);
        if (overlapping && (overlapping.start !== start || overlapping.end !== end || overlapping.date !== date)) {
          sendJson(res, 400, { error: "Isto skupno opravilo je v dnevnem pogledu spremenjeno na dva različna načina." });
          return;
        }
        if (!overlapping) {
          const operation = { previousTodo, beforeTodos: assignmentItems.map((item) => ({ ...item })), assignmentIds, start, end, date, endDate };
          operations.push(operation);
          assignmentIds.forEach((id) => operationByAssignmentId.set(id, operation));
        }
      }
      const now = new Date().toISOString();
      db.todos = db.todos.map((item) => {
        const operation = operationByAssignmentId.get(String(item.id || ""));
        if (!operation) return item;
        const action = operation.date === item.date ? "prestavljen v časovnici" : `prestavljen na ${operation.date} v časovnici`;
        const updatedTodo = {
          ...item,
          start: operation.start,
          end: operation.end,
          date: operation.date,
          endDate: operation.endDate,
          hoursNeedsReview: false,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          history: [...(item.history || []), audit(user, action)]
        };
        updatedTodo.revisionHistory = appendTodoRevision(item, updatedTodo, user, action, now);
        return updatedTodo;
      });
      const settlementChanges = operations.map((operation) => upsertSettlementCorrections(
        db,
        todoAssignmentItems(db, operation.previousTodo).map((item) => ({ ...item, start: operation.previousTodo.start, end: operation.previousTodo.end, date: operation.previousTodo.date, endDate: operation.previousTodo.endDate })),
        todoAssignmentItems(db, operation.previousTodo),
        user,
        now
      ));
      const clientBillableHoursWarnings = operations
        .map((operation) => clientBillableHoursWarning(operation.beforeTodos, todoAssignmentItems(db, operation.previousTodo)))
        .filter(Boolean);
      const lateTimeEntryReports = operations
        .map((operation) => queueLateTimeEntryReport(db, {
          before: operation.previousTodo,
          after: db.todos.find((item) => item.id === operation.previousTodo.id),
          user,
          editorWorkContext,
          kind: operation.previousTodo.date === operation.date ? "spremenjen pozni vpis ur" : "prestavljen pozni vpis ur"
        }))
        .filter(Boolean);
      await writeDbAsync(db);
      if (lateTimeEntryReports.length) scheduleLateTimeEntryReportDelivery();
      sendJson(res, 200, {
        todos: visibleTodosForUser(db, user),
        lateTimeEntryReportsQueued: lateTimeEntryReports.length,
        clientBillableHoursWarnings
      });
      return;
    }

    const todoTimeMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/time$/);
    if (todoTimeMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoTimeMatch[1]);
      const body = await readBody(req);
      const editorWorkContext = String(body.editorWorkContext || "");
      const editLockToken = String(body.editLockToken || "");
      const db = await readDbAsync();
      const previousTodo = db.todos.find((item) => item.id === id);
      if (!canManageTodo(user, previousTodo) || isTrashedTodo(previousTodo)) {
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
      const previousDate = String(previousTodo.date || "");
      const dayShift = previousDate && date ? Math.round((new Date(`${date}T00:00:00`) - new Date(`${previousDate}T00:00:00`)) / 86400000) : 0;
      const endDate = shiftDateKey(todoEndDate(previousTodo), dayShift) || date;
      const validation = validateTodo({ ...previousTodo, date, endDate, start, end });
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const assignmentItems = todoAssignmentItems(db, previousTodo);
      const clientBillLock = clientBillLockForTodos(db, assignmentItems);
      if (clientBillLock) {
        sendJson(res, 403, { error: clientBillEditLockMessage(clientBillLock) });
        return;
      }
      const now = new Date().toISOString();
      const assignmentIds = new Set(assignmentItems.map((item) => item.id));
      db.todos = db.todos.map((item) => {
        if (!assignmentIds.has(item.id)) return item;
        const action = date === previousTodo.date ? "prestavljen v časovnici" : `prestavljen na ${date} v časovnici`;
        const updatedTodo = {
          ...item,
          start,
          end,
          date,
          endDate,
          hoursNeedsReview: false,
          updatedBy: user.id,
          updatedByName: user.name,
          updatedAt: now,
          history: [...(item.history || []), audit(user, action)]
        };
        updatedTodo.revisionHistory = appendTodoRevision(item, updatedTodo, user, action, now);
        return updatedTodo;
      });
      const settlementChange = upsertSettlementCorrections(
        db,
        assignmentItems.map((item) => ({ ...item })),
        todoAssignmentItems(db, previousTodo),
        user,
        now
      );
      const clientBillableHoursWarningForMove = clientBillableHoursWarning(assignmentItems, todoAssignmentItems(db, previousTodo));
      const lateTimeEntryReport = queueLateTimeEntryReport(db, {
        before: previousTodo,
        after: db.todos.find((item) => item.id === previousTodo.id),
        user,
        editorWorkContext,
        kind: previousTodo.date === date ? "spremenjen pozni vpis ur" : "prestavljen pozni vpis ur"
      });
      await writeDbAsync(db);
      releaseTodoAssignmentEditLock(db, previousTodo, user, editLockToken);
      if (lateTimeEntryReport) scheduleLateTimeEntryReportDelivery();
      sendJson(res, 200, {
        todos: visibleTodosForUser(db, user),
        lateTimeEntryReportsQueued: lateTimeEntryReport ? 1 : 0,
        clientBillableHoursWarning: clientBillableHoursWarningForMove
      });
      return;
    }
    const todoRestoreMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/restore$/);
    if (todoRestoreMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoRestoreMatch[1]);
      const db = await readDbAsync();
      const todo = (db.todos || []).find((item) => item.id === id);
      if (!todo || !isTrashedTodo(todo)) {
        sendJson(res, 404, { error: "Opravila v Izbrisano ni ve\u010d ali pa je bilo \u017ee obnovljeno." });
        return;
      }
      if (!canManageTodo(user, todo)) {
        sendJson(res, 403, { error: "Tega opravila ne mores obnoviti." });
        return;
      }
      restoreTrashedTodoGroup(db, todo, user);
      const lateTimeEntryReport = queueLateTimeEntryReport(db, {
        before: null,
        after: (db.todos || []).find((item) => item.id === todo.id),
        user,
        kind: "obnovljen pozni vpis ur"
      });
      await writeDbAsync(db);
      if (lateTimeEntryReport) scheduleLateTimeEntryReportDelivery();
      sendJson(res, 200, { todos: visibleTodosForUser(db, user), deletedTodos: visibleTrashedTodosForUser(db, user), lateTimeEntryReportsQueued: lateTimeEntryReport ? 1 : 0 });
      return;
    }
    const todoChangeNoticeMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/change-notice(\/seen)?$/);
    if (todoChangeNoticeMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoChangeNoticeMatch[1]);
      const markingSeen = Boolean(todoChangeNoticeMatch[2]);
      const body = markingSeen ? {} : await readBody(req);
      const db = await readDbAsync();
      const todo = (db.todos || []).find((item) => item.id === id);
      if (!todo || isTrashedTodo(todo) || !canManageTodo(user, todo)) {
        sendJson(res, 404, { error: "Opravilo ne obstaja ali ni na voljo." });
        return;
      }
      const assignmentItems = todoAssignmentItems(db, todo);
      let changed = false;
      if (markingSeen) {
        const requestedRecipientId = cleanUserId(url.searchParams.get("recipient") || user.id);
        const recipient = db.users?.[requestedRecipientId];
        if (!recipient || recipient.active === false || (requestedRecipientId !== user.id && user.role !== "boss")) {
          sendJson(res, 403, { error: "Oznako lahko kot prebrano potrdi prejemnik ali šef v njegovem pogledu." });
          return;
        }
        changed = clearTodoChangeNoticesForUser(db, todo, recipient);
      } else {
        const lock = todoAssignmentEditLockConflict(db, todo, user, String(body.editLockToken || ""));
        if (lock) {
          sendJson(res, 409, { error: `Opravilo trenutno ureja ${lock.lockedByName || lock.lockedById}.`, lock });
          return;
        }
        for (const assignmentTodo of assignmentItems) {
          assignmentTodo.history = [...(assignmentTodo.history || []), audit(user, "označeno za pregled drugim udeležencem")];
        }
        changed = recordTodoChangeNotices(db, assignmentItems, user, ["manual"], "manual").length > 0;
      }
      if (changed) await writeDbAsync(db);
      sendJson(res, 200, { changed, todos: visibleTodosForUser(db, user) });
      return;
    }
    const todoMatch = url.pathname.match(/^\/api\/todos\/([^/]+)$/);
    if (todoMatch && req.method === "GET") {
      const id = decodeURIComponent(todoMatch[1]);
      const user = await requireUserForFocusedTodo(req, res);
      if (!user) return;
      if (DATABASE_URL) {
        const focused = await getPgStore().focusedTodo(id);
        const source = focused?.todo;
        if (!source || isTrashedTodo(source) || !canManageTodo(user, source)) {
          sendJson(res, 404, { error: "Opravilo ne obstaja ali ni na voljo." });
          return;
        }
        const clientBill = await getPgStore().confirmedClientBillForEvent(todoBillingEventId(source));
        const hydrated = hydrateTodoAttachments({ attachments: focused.attachments }, {
          ...source,
          assigneeIds: focused.assigneeIds
        });
        const { completionRequests, history, revisionHistory, changeNotices, ...publicTodo } = hydrated;
        const todo = {
          ...publicTodo,
          changeNotice: todoChangeNoticeForUser(source, user),
          clientSettlement: clientSettlementFromBill(clientBill),
          ...(user.role === "boss" ? { history, revisionHistory } : {})
        };
        sendJson(res, 200, { todo });
        return;
      }
      const db = req.indusDb || await readDbAsync();
      const todo = visibleTodoForUser(db, user, id);
      if (!todo) {
        sendJson(res, 404, { error: "Opravilo ne obstaja ali ni na voljo." });
        return;
      }
      sendJson(res, 200, { todo });
      return;
    }
    if (todoMatch && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoMatch[1]);
      const body = await readBody(req);
      const notifyOthers = body.notifyOthers === true;
      const editorWorkContext = String(body.editorWorkContext || "");
      const editLockToken = String(body.editLockToken || "");
      let todo = cleanTodo(body);
      const validation = validateTodo(todo);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const db = await readDbAsync();
      const directClientSettlement = directClientSettlementRequest(body.directClientSettlement);
      const index = db.todos.findIndex((item) => item.id === id);
      if (index < 0) {
        sendJson(res, 404, { error: "Opravilo ne obstaja." });
        return;
      }
      const previousTodo = db.todos[index];
      if (directClientSettlement && confirmedClientBillByEvent(db).has(todoBillingEventId(previousTodo))) {
        sendJson(res, 409, { error: "Ta dogodek je Ĺľe poraÄŤunan s stranko in ga je treba najprej kontrolirano preklicati v obraÄŤunu strank." });
        return;
      }
      if (isTrashedTodo(previousTodo)) {
        sendJson(res, 409, { error: "Opravilo je v Izbrisano. Najprej ga obnovi." });
        return;
      }
      if (!canManageTodo(user, previousTodo)) {
        sendJson(res, 403, { error: "Tega opravila ne moreš spreminjati." });
        return;
      }
      const clientBillLock = clientBillLockForTodos(db, todoAssignmentItems(db, previousTodo));
      if (clientBillLock) {
        sendJson(res, 403, { error: clientBillEditLockMessage(clientBillLock) });
        return;
      }
      const sourceProject = preserveTimeEntrySourceProject(db, user, todo, previousTodo);
      if (sourceProject.error) {
        sendJson(res, 400, { error: sourceProject.error });
        return;
      }
      todo = sourceProject.todo;
      todo = attachResolvedClient(db, todo, { createAdHoc: true, user });
      const contactSelection = applyTodoClientContactSelection(db, todo, { strict: true });
      if (contactSelection.error) {
        sendJson(res, 400, { error: contactSelection.error });
        return;
      }
      todo = contactSelection.todo;
      const resolvedValidation = validateTodo(todo, { requireClientId: true });
      if (resolvedValidation) {
        sendJson(res, 400, { error: resolvedValidation });
        return;
      }
      todo = storeTodoAttachments(db, todo, user);
      const previousManualDomain = todoManualOrderDomain(previousTodo);
      const nextManualDomain = todoManualOrderDomain(todo);
      const manualDomainChanged = Boolean(nextManualDomain && previousManualDomain && nextManualDomain !== previousManualDomain);
      const sharedManualBucket = manualDomainChanged
        ? (nextManualDomain === "active" ? "unsorted" : "sorted")
        : todoSharedManualBucket(previousTodo);
      todo = {
        ...todo,
        sharedManualBucket,
        sharedManualOrder: manualDomainChanged
          ? sharedManualOrderBefore(db, { domain: nextManualDomain, bucket: sharedManualBucket })
          : todoSharedManualOrder(previousTodo)
      };
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
      // Javni obrazec teh internih tokenov nikoli ne dobi. Ob navadnem
      // shranjevanju jih zato obnovimo iz celotne skupine in jih spodaj
      // prenesemo na morebitne na novo ustvarjene kopije za delavce.
      todo = {
        ...todo,
        completionRequests: todoCompletionRequestsForAssignment(db, previousTodo)
      };
      const currentAssigneeIds = todoAssignmentAssigneeIds(db, previousTodo);
      let assigneeIds;
      if (Array.isArray(body.assigneeIds)) {
        assigneeIds = [...new Set(body.assigneeIds
          .map(cleanUserId)
          .filter((assigneeId) => Boolean(db.users?.[assigneeId]) && db.users[assigneeId].active !== false))];
        if (!assigneeIds.length && !["material", "note"].includes(todo.status)) {
          sendJson(res, 400, { error: "Izberi vsaj enega delavca." });
          return;
        }
      } else {
        const nextAssignee = todoAssigneeForUpdate(user, todo.syncUser, previousTodo.syncUser, db.users);
        assigneeIds = currentAssigneeIds.filter((assigneeId) => assigneeId !== previousTodo.syncUser);
        if (!assigneeIds.includes(nextAssignee)) assigneeIds.push(nextAssignee);
      }

      if (TIME_ENTRY_TODO_STATUSES.has(todo.status) && assigneeIds.some((assigneeId) => !canRecordHoursFor(db, user, assigneeId))) {
        sendJson(res, 403, { error: "Delavec lahko ure vpiše samo sebi ali za delavce, ki jih je določil šef." });
        return;
      }
      if (["meal", "material", "note"].includes(todo.status)) assigneeIds = [syncUserForRequest(user, todo.syncUser || assigneeIds[0] || previousTodo.syncUser || user.id, previousTodo.syncUser, db.users)];
      if (TIME_ENTRY_TODO_STATUSES.has(todo.status) && assigneeIds.length !== 1) {
        sendJson(res, 400, { error: "Vnos ur se vpisuje posebej za enega delavca." });
        return;
      }
      const assignmentsChanged = [...currentAssigneeIds].sort().join(",") !== [...assigneeIds].sort().join(",");
      const promoteImported = importedTodoWasEdited(previousTodo, todo, { assignmentsChanged });
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
      const assigneeNames = assigneeIds.map((assigneeId) => db.users[assigneeId]?.name || assigneeId).join(", ");
      const updatedGroup = [];

      for (const assigneeId of assigneeIds) {
        const existing = existingByAssignee.get(assigneeId);
        if (existing) {
          const isOpenedTodo = existing.id === previousTodo.id;
          const adjusted = todoForUserRole(user, db, existing, {
            ...todo,
            promoteImported,
            syncUser: assigneeId,
            billingHourlyRate: isOpenedTodo ? todo.billingHourlyRate : existing.billingHourlyRate,
            billingKm: isOpenedTodo ? todo.billingKm : existing.billingKm
          });
          const action = assignmentsChanged
            ? `dodelitev spremenjena: ${assigneeNames}`
            : todo.done ? "označeno opravljeno" : "spremenjeno opravilo";
          const updatedTodo = {
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
            history: [...(existing.history || []), audit(user, action)]
          };
          updatedTodo.revisionHistory = appendTodoRevision(existing, updatedTodo, user, action, now);
          updatedGroup.push(updatedTodo);
          continue;
        }

        const assignedTodo = todoForUserRole(user, db, null, {
          ...todo,
          promoteImported,
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
      const updatedOpenedTodo = updatedGroup.find((item) => item.id === previousTodo.id)
        || updatedGroup.find((item) => item.syncUser === previousTodo.syncUser)
        || updatedGroup[0]
        || null;
      // A normal save stays quiet. When the author explicitly selects the
      // checkbox, send the real fields that changed; an unchanged save is a
      // deliberate "please review" signal and remains a manual marker.
      const notificationFields = todoChangeNoticeFields(previousTodo, updatedOpenedTodo || todo, { assignmentsChanged });
      const notifiedRecipients = notifyOthers
        ? recordTodoChangeNotices(
          db,
          updatedGroup,
          user,
          notificationFields.length ? notificationFields : ["manual"],
          notificationFields.length ? "updated" : "manual",
          now
        )
        : [];
      if (notifiedRecipients.length) {
        for (const assignmentTodo of updatedGroup) {
          assignmentTodo.history = [...(assignmentTodo.history || []), audit(user, "označeno za pregled drugim udeležencem")];
        }
      }
      // A personal change marker is an inbox item, not a warning about the
      // data itself. Saving by the same recipient also consumes it. A boss
      // merely viewing another worker's context must not clear that worker's
      // private marker.
      if (updatedOpenedTodo) clearTodoChangeNoticesForUser(db, updatedOpenedTodo, user);
      const clientBillableHoursWarningForUpdate = clientBillableHoursWarning(assignmentItems, updatedGroup);
      const settlementChange = upsertSettlementCorrections(db, assignmentItems, updatedGroup, user, now);
      if (settlementChange.error) {
        sendJson(res, 409, { error: settlementChange.error });
        return;
      }
      const directSettlement = directClientSettlement
        ? directClientSettlementForTodo(db, updatedOpenedTodo, body.directClientSettlement, user)
        : null;
      if (directSettlement?.error) {
        sendJson(res, 400, { error: directSettlement.error });
        return;
      }
      const lateTimeEntryReport = queueLateTimeEntryReport(db, {
        before: previousTodo,
        after: updatedOpenedTodo,
        user,
        editorWorkContext,
        kind: "spremenjen pozni vpis ur"
      });
      pruneUnusedTodoAttachments(db);
      pruneUnusedAdHocClients(db);
      await writeDbAsync(db);
      releaseTodoAssignmentEditLock(db, previousTodo, user, editLockToken);
      if (lateTimeEntryReport) scheduleLateTimeEntryReportDelivery();
      sendJson(res, 200, {
        todos: visibleTodosForUser(db, user),
        debts: visibleDebtsForUser(db, user),
        lateTimeEntryReportsQueued: lateTimeEntryReport ? 1 : 0,
        clientBillableHoursWarning: clientBillableHoursWarningForUpdate
      });
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
      if (isTrashedTodo(todo)) {
        sendJson(res, 200, { todos: visibleTodosForUser(db, user), deletedTodos: visibleTrashedTodosForUser(db, user) });
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
      const clientBillLock = clientBillLockForTodos(db, assignmentItems);
      if (clientBillLock) {
        sendJson(res, 403, { error: clientBillEditLockMessage(clientBillLock) });
        return;
      }
      releaseTodoAssignmentEditLock(db, todo, user, editLockToken);
      const lateTimeEntryReport = queueLateTimeEntryReport(db, {
        before: todo,
        after: null,
        user,
        kind: "izbrisan pozni vpis ur"
      });
      trashTodoGroup(db, todo, user);
      await writeDbAsync(db);
      releaseTodoAssignmentEditLock(db, todo, user, editLockToken);
      if (lateTimeEntryReport) scheduleLateTimeEntryReportDelivery();
      sendJson(res, 200, { todos: visibleTodosForUser(db, user), deletedTodos: visibleTrashedTodosForUser(db, user), lateTimeEntryReportsQueued: lateTimeEntryReport ? 1 : 0 });
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
  const execution = mutationQueue.then(async () => {
    if (!undoEligibleRequest(req)) return handleApi(req, res);
    // Capture the normalized state before the route reads or mutates it. All
    // mutation routes use this one queue, so the snapshot has a precise,
    // serial position in history.
    const db = await readDbAsync();
    activeUndoCapture = {
      req,
      beforeState: undoBusinessSnapshot(db),
      actor: null,
      recorded: false
    };
    try {
      return await handleApi(req, res);
    } finally {
      activeUndoCapture = null;
    }
  });
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
      // Media uploads only stage a protected attachment; they do not alter an
      // event until its form is saved. Do not hold the global mutation queue
      // while a large body is streaming or while an image is being converted.
      const streamedMediaUpload = req.method === "POST" && (/^\/api\/todos\/(?:video|image)(?:[/?]|$)/).test(req.url);
      // An edit lock changes only the short-lived in-memory lock map.  It is
      // not an undoable business change and must never wait behind a slow
      // save, image processing, backup or another serialized mutation.
      const todoEditLockRequest = /^\/api\/todos\/[^/?]+\/lock(?:[/?]|$)/.test(req.url);
      // This endpoint only creates a short-lived session-bound download ticket;
      // it does not mutate the database and must not wait behind an unrelated
      // long-running save before the user can share an event.
      const todoSharePdfTicketRequest = /^\/api\/todos\/[^/?]+\/share-pdf-ticket(?:[/?]|$)/.test(req.url);
      if (streamedMediaUpload || todoEditLockRequest || todoSharePdfTicketRequest) {
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
  if (OPERATIONAL_MONITOR_ENABLED) startOperationalMonitor();

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
  DELETED_TODO_RETENTION_DAYS,
  AUDIT_LOG_RETENTION_DAYS,
  recordAuditLog,
  visibleAuditLogForUser,
  purgeExpiredAuditLog,
  GOOGLE_DRIVE_SCOPE_VERSION,
  INDUS_GOOGLE_APP_ID,
  TODO_STATUS_DEFINITIONS,
  undoArrayPatch,
  SESSION_TTL_MS,
  canRecordHoursFor,
  timeEntryTargetIds,
  normalizeWorkerProfile,
  workerDailyReportSettings,
  shouldSendWorkerDailyReport,
  workerHasBusinessData,
  acquireEntryEditLock,
  acquireTodoEditLock,
  acquireTodoAssignmentEditLock,
  activeEntryEditLock,
  activeTodoEditLock,
  todoAssignmentAssigneeIds,
  cleanTodoChangeNotices,
  todoChangeNoticeForUser,
  todoChangeNoticeFields,
  todoChangeNoticeRecipientIds,
  recordTodoChangeNotices,
  clearTodoChangeNoticesForUser,
  todoAssignmentEditLockConflict,
  ownsTodoAssignmentEditLock,
  todoAssignmentItems,
  isTrashedTodo,
  trashTodoGroup,
  restoreTrashedTodoGroup,
  purgeExpiredTrashedTodoGroups,
  releaseTodoAssignmentEditLock,
  entryEditLockConflict,
  buildCalendarIcs,
  buildPayrollSnapshot,
  upsertSettlementCorrections,
  correctionPayrollLine,
  settleCorrectionsForPayroll,
  settleCorrectionsForClientBill,
  pendingCorrectionsForTodo,
  buildClientBillSnapshot,
  todoClientBillableMinutes,
  clientBillableMinutesForTodos,
  clientBillableHoursForTodos,
  clientBillableHoursWarning,
  clientReportSelection,
  clientReportAttachmentSelection,
  attachmentContentDisposition,
  serverRuntimeStatus,
  buildClientReportPdf,
  buildWorkerDailyReportPdf,
  workerDailyDigestSnapshot,
  workerDigestPortalUrl,
  workerDailyReportHtml,
  workerDailyReportText,
  workerDailyReportFilename,
  canReadWorkerDailyReport,
  runDailyWorkerDigest,
  gmailDraftRaw,
  gmailWorkerDigestDraftRaw,
  gmailWorkerDigestMessageRaw,
  gmailLateTimeEntryReportRaw,
  lateTimeEntryReportText,
  lateTimeEntryReportSnapshot,
  shouldQueueLateTimeEntryReport,
  normalizeLateTimeEntryReports,
  queueLateTimeEntryReport,
  workerDigestRunKey,
  workerDigestRunFor,
  recordWorkerDigestRun,
  normalizeWorkerDigestRuns,
  gmailCompletionRequestRaw,
  cleanTodoCompletionRequests,
  todoCompletionRequestsForAssignment,
  findActiveTodoCompletionRequest,
  cleanTodo,
  archivePayrollTodos,
  cancelClientBill,
  directClientSettlementForTodo,
  clientSettlementForTodo,
  clientBillLockForTodos,
  reconcileTodoArchives,
  archiveRetentionMonthsForDb,
  archiveRetentionCandidates,
  purgeArchivedTodoGroups,
  canManageEntry,
  canManageFinancialEntry,
  canManageTodo,
  todoSharedManualOrder,
  todoSharedManualBucket,
  todoManualOrderDomain,
  sharedManualTodoGroups,
  userCanReorderSharedTodoGroup,
  sharedManualOrderBefore,
  applySharedManualTodoOrder,
  preserveTimeEntrySourceProject,
  sourceTodoForNewEntry,
  defaultHourlyRateForUser,
  importedTodoWasEdited,
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
  cleanClient,
  ajpesRecordToClientDraft,
  searchAjpesPublicRegister,
  validateClient,
  activeClientTodoReferences,
  activeClientEntryReferences,
  clientDeletionBlocker,
  deleteClientIfSafe,
  canDeleteClient,
  applyTodoClientContactSelection,
  todoClientContactSelection,
  applyClientReferenceMigrations,
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
  timeEntryConflictForWorker,
  timeEntryConflictMessage,
  auditLogCsv,
  workerPayrollXlsxEntries,
  workerPayrollXlsxReport,
  sendWorkerPayrollXlsx,
  visibleDebtsForUser,
  visibleEntriesForUser,
  visibleTodosForUser,
  visibleTodoForUser,
  visibleTrashedTodosForUser,
};
