"use strict";

const { IMAGE_SIGNATURES } = require("./attachment-model");

// attachment-transfer: explicit dependencies; factory creation has no I/O or UI effects.
function createAttachmentTransfer({
  attachmentApiUrl,
  canManageTodo,
  getFocusedPgStore,
  getPgStore,
  googleClient,
  googleDriveOwner,
  googleDriveTasksReady,
  googleDriveTokenAvailable,
  pendingAttachmentMap,
  readRequestDb,
  requireUser,
  runSerializedWork,
  safeRestoreRelativePath,
  securityHeaders,
  sendJson,
  undoProtectedAttachmentIds,
  validTodoAttachmentId,
  writeDbAsync,
  moduleValues
}) {
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
        parents: [moduleValues.GOOGLE_DRIVE_TASKS_FOLDER_ID],
        appProperties: {
          indusApp: moduleValues.INDUS_GOOGLE_APP_ID,
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
    const ownedByBojan = (created.owners || []).some((item) => String(item.emailAddress || "").toLowerCase() === moduleValues.GOOGLE_DRIVE_OWNER_EMAIL);
    const inConfiguredFolder = (created.parents || []).includes(moduleValues.GOOGLE_DRIVE_TASKS_FOLDER_ID);
    if (!created.id || !created.webViewLink || created.driveId || !ownedByBojan || !inConfiguredFolder) {
      throw new Error("Google datoteke ni bilo mogoče ustvariti kot Bojanovo datoteko v izbrani mapi.");
    }
    return {
      id: moduleValues.crypto.randomUUID(),
      kind,
      fileId: created.id,
      url: created.webViewLink,
      name: String(created.name || name).slice(0, 180),
      managed: true,
      ownerEmail: moduleValues.GOOGLE_DRIVE_OWNER_EMAIL,
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
  const extension = moduleValues.path.extname(String(filename || "")).toLowerCase();
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
  const limiter = new moduleValues.Transform({
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
  return known[String(mimeType || "").toLowerCase()] || moduleValues.path.extname(String(filename || "")).toLowerCase() || ".video";
}

function imageMimeType(value, filename = "") {
  const requested = String(value || "").split(";", 1)[0].trim().toLowerCase();
  const extension = moduleValues.path.extname(String(filename || "")).toLowerCase();
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
    await moduleValues.execFileAsync(
      moduleValues.IMAGE_PROCESSOR,
      ["thumbnail", inputPath, `${outputPath}[Q=${quality},strip]`, String(maxSide)],
      { timeout: moduleValues.TODO_IMAGE_PROCESS_TIMEOUT_MS, maxBuffer: 1_000_000, windowsHide: true }
    );
  } catch (error) {
    throw imageProcessorError(error);
  }
  const result = await moduleValues.fsp.readFile(outputPath);
  if (!IMAGE_SIGNATURES.jpeg(result)) throw new Error("Strežnik ni ustvaril veljavne JPEG slike.");
  return result;
}

async function moveAttachmentFile(tempPath, targetPath) {
  await moduleValues.fsp.mkdir(moduleValues.path.dirname(targetPath), { recursive: true, mode: 0o700 });
  try {
    // rename() overwrites an existing target on Linux. Never claim an
    // existing content-addressed object as a newly created upload.
    await moduleValues.fsp.copyFile(tempPath, targetPath, moduleValues.fs.constants.COPYFILE_EXCL);
    await moduleValues.fsp.rm(tempPath, { force: true });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    await moduleValues.fsp.rm(tempPath, { force: true });
    return false;
  }
}

async function receiveLocalTodoImage(input = {}) {
  const mimeType = imageMimeType(input.mimeType, input.name);
  if (!mimeType) throw new Error("Izberi veljavno slikovno datoteko.");
  const declaredBytes = Number(input.contentLength);
  if (Number.isSafeInteger(declaredBytes) && declaredBytes <= 0) throw new Error("Prazne slike ni mogoče dodati.");
  if (Number.isSafeInteger(declaredBytes) && declaredBytes > moduleValues.MAX_TODO_IMAGE_BYTES) throw new Error(`Slika je prevelika. Največja dovoljena velikost je ${Math.round(moduleValues.MAX_TODO_IMAGE_BYTES / 1024 / 1024)} MB.`);

  const uploadDirectory = moduleValues.path.join(moduleValues.MEDIA_DIR, ".uploads");
  await moduleValues.fsp.mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
  const uploadId = moduleValues.crypto.randomUUID();
  const sourcePath = moduleValues.path.join(uploadDirectory, `${uploadId}.source`);
  const displayTempPath = moduleValues.path.join(uploadDirectory, `${uploadId}.display.jpg`);
  const thumbnailTempPath = moduleValues.path.join(uploadDirectory, `${uploadId}.thumb.jpg`);
  let byteSize = 0;
  const counter = new moduleValues.Transform({
    transform(chunk, encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > moduleValues.MAX_TODO_IMAGE_BYTES) {
        callback(new Error(`Slika je prevelika. Največja dovoljena velikost je ${Math.round(moduleValues.MAX_TODO_IMAGE_BYTES / 1024 / 1024)} MB.`));
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
    await moduleValues.pipeline(input.stream, counter, moduleValues.fs.createWriteStream(sourcePath, { mode: 0o600 }));
    if (!byteSize) throw new Error("Prazne slike ni mogoče dodati.");
    const display = await createTodoJpegDerivative(sourcePath, displayTempPath, moduleValues.TODO_IMAGE_DISPLAY_MAX_SIDE, 85);
    await createTodoJpegDerivative(sourcePath, thumbnailTempPath, moduleValues.TODO_IMAGE_THUMBNAIL_MAX_SIDE, 72);
    const attachmentId = moduleValues.crypto.createHash("sha256").update(display).digest("hex");
    const storageKey = moduleValues.path.posix.join("objects", `${attachmentId}.jpg`);
    const thumbnailKey = moduleValues.path.posix.join("thumbnails", `${attachmentId}.jpg`);
    displayTargetPath = moduleValues.path.join(moduleValues.MEDIA_DIR, ...storageKey.split("/"));
    thumbnailTargetPath = moduleValues.path.join(moduleValues.MEDIA_DIR, ...thumbnailKey.split("/"));
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
    if (displayCreated && displayTargetPath) await moduleValues.fsp.rm(displayTargetPath, { force: true }).catch(() => {});
    if (thumbnailCreated && thumbnailTargetPath) await moduleValues.fsp.rm(thumbnailTargetPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await Promise.all([sourcePath, displayTempPath, thumbnailTempPath].map((file) => moduleValues.fsp.rm(file, { force: true }).catch(() => {})));
  }
}

async function receiveLocalTodoVideo(input = {}) {
  const mimeType = videoMimeType(input.mimeType, input.name);
  if (!mimeType) throw new Error("Izberi veljavno video datoteko.");
  const declaredBytes = Number(input.contentLength);
  if (Number.isSafeInteger(declaredBytes) && declaredBytes <= 0) throw new Error("Praznega videa ni mogoče dodati.");
  if (Number.isSafeInteger(declaredBytes) && declaredBytes > moduleValues.MAX_VIDEO_BYTES) throw new Error(`Video je prevelik. Največja dovoljena velikost je ${Math.round(moduleValues.MAX_VIDEO_BYTES / 1024 / 1024)} MB.`);

  const uploadDirectory = moduleValues.path.join(moduleValues.MEDIA_DIR, ".uploads");
  await moduleValues.fsp.mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = moduleValues.path.join(uploadDirectory, `${moduleValues.crypto.randomUUID()}.part`);
  const digest = moduleValues.crypto.createHash("sha256");
  let byteSize = 0;
  const counter = new moduleValues.Transform({
    transform(chunk, encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > moduleValues.MAX_VIDEO_BYTES) {
        callback(new Error(`Video je prevelik. Največja dovoljena velikost je ${Math.round(moduleValues.MAX_VIDEO_BYTES / 1024 / 1024)} MB.`));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  input.stream.once("aborted", () => counter.destroy(new Error("Prenos videa je bil prekinjen.")));
  try {
    await moduleValues.pipeline(input.stream, counter, moduleValues.fs.createWriteStream(temporaryPath, { mode: 0o600 }));
    if (!byteSize) throw new Error("Praznega videa ni mogoče dodati.");
    const attachmentId = digest.digest("hex");
    const storageKey = moduleValues.path.posix.join("objects", `${attachmentId}${videoStorageExtension(mimeType, input.name)}`);
    const targetPath = moduleValues.path.join(moduleValues.MEDIA_DIR, ...storageKey.split("/"));
    await moduleValues.fsp.mkdir(moduleValues.path.dirname(targetPath), { recursive: true, mode: 0o700 });
    const createdFile = await moveAttachmentFile(temporaryPath, targetPath);
    return { attachmentId, mimeType, byteSize, storageKey, targetPath, createdFile };
  } catch (error) {
    await moduleValues.fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function systemGoogleDriveClient(tokens) {
  const { google } = require("googleapis");
  const auth = new google.auth.OAuth2(moduleValues.GOOGLE_CLIENT_ID, moduleValues.GOOGLE_CLIENT_SECRET, moduleValues.GOOGLE_REDIRECT_URI || undefined);
  auth.setCredentials(tokens || {});
  return google.drive({ version: "v3", auth });
}

async function sendAttachmentFile(res, attachment) {
  const stat = await moduleValues.fsp.stat(attachment.filePath);
  res.writeHead(200, securityHeaders({
    "Content-Type": attachment.mimeType || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": "inline"
  }));
  moduleValues.fs.createReadStream(attachment.filePath).on("error", () => res.destroy()).pipe(res);
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

async function handleAttachmentDownload(req, res, url) {
    const pendingAttachmentMatch = url.pathname.match(/^\/api\/attachments\/([a-f0-9]{64})\/pending$/);
    if (pendingAttachmentMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return true;
      const attachmentId = pendingAttachmentMatch[1];
      const db = await readRequestDb(req);
      const pending = pendingAttachmentMap(db);
      if (pending[attachmentId]?.userId !== user.id) {
        sendJson(res, 404, { error: "Začasna priloga ne obstaja." });
        return true;
      }
      delete pending[attachmentId];
      // Cancel staging, not a shared attachment already used by an event.
      pruneUnusedTodoAttachments(db);
      await writeDbAsync(db);
      sendJson(res, 200, { ok: true });
      return true;
    }
    const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([a-f0-9]{64})(\/thumbnail)?$/);
    if (attachmentMatch && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return true;
      const attachmentId = attachmentMatch[1];
      const db = moduleValues.DATABASE_URL
        ? await getFocusedPgStore().attachmentAccessSeed(attachmentId)
        : await readRequestDb(req);
      if (!attachmentVisibleToUser(db, user, attachmentId)) {
        sendJson(res, 404, { error: "Priloga ne obstaja." });
        return true;
      }
      if (moduleValues.DATABASE_URL) {
        const attachment = await getPgStore().getAttachment(attachmentId, Boolean(attachmentMatch[2]));
        if (!attachment) {
          sendJson(res, 404, { error: "Priloga ne obstaja." });
          return true;
        }
        await sendAttachmentFile(res, attachment);
        return true;
      }
      const source = db.attachments?.[attachmentId];
      const storageKey = attachmentMatch[2] ? source?.thumbnailKey : source?.storageKey;
      const relativeStorageKey = safeRestoreRelativePath(storageKey);
      const localFile = relativeStorageKey
        ? moduleValues.path.resolve(moduleValues.MEDIA_DIR, relativeStorageKey)
        : "";
      if (localFile && localFile.startsWith(`${moduleValues.MEDIA_DIR}${moduleValues.path.sep}`) && moduleValues.fs.existsSync(localFile)) {
        await sendAttachmentFile(res, { filePath: localFile, mimeType: attachmentMatch[2] ? source?.thumbnailMimeType || "image/jpeg" : source?.mimeType });
        return true;
      }
      const dataUrl = attachmentMatch[2] ? source?.thumbnailData : source?.data;
      const match = String(dataUrl || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) {
        sendJson(res, 404, { error: "Priloga ne obstaja." });
        return true;
      }
      const bytes = Buffer.from(match[2], "base64");
      res.writeHead(200, securityHeaders({ "Content-Type": match[1], "Content-Length": bytes.length, "Cache-Control": "private, max-age=3600", "Content-Disposition": "inline" }));
      res.end(bytes);
      return true;
    }
    return false;
}

async function handleAttachmentUpload(req, res, url) {
    if (url.pathname === "/api/todos/image" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
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
          const db = await readRequestDb(req);
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
          pending[received.attachmentId] = { userId: user.id, expiresAt: Date.now() + moduleValues.PENDING_ATTACHMENT_TTL_MS };
          await writeDbAsync(db);
          return {
            id: moduleValues.crypto.randomUUID(),
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
        if (received.createdFiles?.display) await moduleValues.fsp.rm(received.displayTargetPath, { force: true }).catch(() => {});
        if (received.createdFiles?.thumbnail) await moduleValues.fsp.rm(received.thumbnailTargetPath, { force: true }).catch(() => {});
        throw error;
      }
      return true;
    }

    if (url.pathname === "/api/todos/video" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
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
          const db = await readRequestDb(req);
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
          pending[received.attachmentId] = { userId: user.id, expiresAt: Date.now() + moduleValues.PENDING_ATTACHMENT_TTL_MS };
          await writeDbAsync(db);
          return {
            id: moduleValues.crypto.randomUUID(),
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
        if (received.createdFile) await moduleValues.fsp.rm(received.targetPath, { force: true }).catch(() => {});
        throw error;
      }
      return true;
    }
    return false;
}

  return {
    pruneUnusedTodoAttachments,
    videoMimeType,
    moveAttachmentFile,
    systemGoogleDriveClient,
    attachmentVisibleToUser,
    handleAttachmentDownload,
    handleAttachmentUpload
  };
}

module.exports = { createAttachmentTransfer };
