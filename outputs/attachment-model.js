"use strict";
const crypto = require("node:crypto");

const IMAGE_SIGNATURES = {
  png: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  webp: (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP"
};

// Attachment validation, metadata, staging ownership and hydration.
// Network authentication and streaming routes are in attachment-transfer.js.
function createAttachmentModel({ MAX_TODO_IMAGE_DATA_LENGTH, MAX_TODO_PDF_DATA_LENGTH, MAX_TODO_ATTACHMENTS_DATA_LENGTH, MAX_TODO_THUMBNAIL_DATA_LENGTH, MAX_TODO_ATTACHMENTS }) {
// BEGIN preserved attachment model
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
// END preserved attachment model
  return { validImageDataUrl, validPdfDataUrl, validTodoAttachmentDataUrl, validTodoThumbnailDataUrl, limitTodoAttachmentsData, validTodoAttachmentId, validGoogleDriveId, googleDriveFileInfo, googleWorkspaceFileInfo, googleDriveDefaultName, cleanTodoDriveFiles, stampTodoDriveFiles, todoAttachmentContentId, pendingAttachmentMap, storeTodoAttachments, attachmentApiUrl, hydrateTodoAttachments };
}

module.exports = { createAttachmentModel, IMAGE_SIGNATURES };
