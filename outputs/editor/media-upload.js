// editor/media-upload: explicit dependencies; factory creation has no I/O or UI effects.
function createMediaUpload({
  $,
  state,
  api,
  attachmentDisplayName,
  attachmentLabel,
  attachmentSource,
  attachmentSymbolMarkup,
  attachmentThumbnailSource,
  createLocalUuid,
  createPdfThumbnailSafely,
  escapeHtml,
  findTodoClient,
  isPdfAttachment,
  isSupportedImageFile,
  isVideoAttachment,
  normalizeClientName,
  openAttachmentPreview,
  openPhotoEditor,
  refreshSessionSecurityContext,
  scheduleTodoCreationDraftSave,
  shareTodoAttachment,
  showNotice,
  todoAttachmentFromFile,
  todoAttachmentsDataLength,
  moduleValues
}) {
function todoWorkspaceFileInfo(value) {
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

function todoDriveFileLabel(file) {
      if (file?.kind === "spreadsheet") return "Preglednica";
      if (file?.kind === "video") return "Video";
      return "Dokument";
    }

function renderTodoDriveFilesHtml(files, { removable = false } = {}) {
      return (files || []).map((file) => `
        <div class="todo-drive-file-row">
          <a class="todo-drive-file-link" href="${escapeHtml(file.url)}" target="_blank" rel="noopener noreferrer">
            <span class="todo-drive-kind">${todoDriveFileLabel(file)}</span>
            <span>${escapeHtml(file.name || `Google ${todoDriveFileLabel(file)}`)}</span>
          </a>
          ${removable ? `<button class="danger remove-todo-drive-file" type="button" data-drive-file-id="${escapeHtml(file.id)}">Odstrani</button>` : ""}
        </div>
      `).join("");
    }

function renderTodoFormDriveFiles() {
      $("todoFormDriveFileList").innerHTML = renderTodoDriveFilesHtml(state.todoDialogDriveFiles, { removable: true });
      if ($("todoDialog").open) scheduleTodoCreationDraftSave();
    }

function installTodoPhotoErrorHandlers(list) {
      list.querySelectorAll('.todo-form-attachment-thumb img').forEach((img) => {
        img.addEventListener('error', () => {
          const photo = state.todoDialogPhotos.find((item) => item.id === img.closest('[data-photo-id]')?.dataset.photoId);
          const original = attachmentSource(photo);
          if (original && img.getAttribute('src') !== original) { img.src = original; return; }
          const warning = document.createElement('span');
          warning.textContent = 'Datoteka ni dosegljiva';
          warning.setAttribute('role', 'status');
          img.replaceWith(warning);
        });
      });
    }

async function createTodoGoogleDriveFile(kind) {
      const title = $("todoFormTask").value.trim();
      if (!title) {
        $("todoFormTask").focus();
        showNotice("Najprej vpiši ime opravila.");
        return;
      }
      const client = findTodoClient($("todoFormClient").value);
      const buttons = [...document.querySelectorAll("[data-create-drive]")];
      buttons.forEach((button) => { button.disabled = true; });
      try {
        const data = await api("/api/todos/drive-files", {
          method: "POST",
          body: JSON.stringify({
            kind,
            title,
            client: client?.name || normalizeClientName($("todoFormClient").value)
          })
        });
        if (!data?.driveFile) throw new Error("Google datoteke ni bilo mogoče ustvariti.");
        if (!state.todoDialogDriveFiles.some((file) => file.fileId === data.driveFile.fileId)) {
          state.todoDialogDriveFiles.push(data.driveFile);
          renderTodoFormDriveFiles();
        }
      } finally {
        buttons.forEach((button) => { button.disabled = false; });
      }
    }

function todoVideoMimeType(file) {
      const nativeType = String(file?.type || "").split(";", 1)[0].trim().toLowerCase();
      if (nativeType.startsWith("video/")) return nativeType;
      const name = String(file?.name || "").toLowerCase();
      const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
      return ({
        ".mp4": "video/mp4",
        ".m4v": "video/x-m4v",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".3gp": "video/3gpp"
      })[extension] || "application/octet-stream";
    }

function isTodoVideoFile(file) {
      return todoVideoMimeType(file).startsWith("video/");
    }

function setTodoVideoUploadStatus(message, stateName = "", percent = null) {
      const status = $("todoFormVideoStatus");
      const progress = $("todoFormVideoProgress");
      const label = status.querySelector("span");
      label.textContent = String(message || "");
      status.hidden = !message;
      status.classList.toggle("hidden", !message);
      progress.hidden = percent === null;
      progress.value = Math.max(0, Math.min(100, Number(percent) || 0));
      if (stateName) status.dataset.state = stateName;
      else delete status.dataset.state;
    }

function updateTodoVideoUploadDraft(draft, percent) {
      const value = Math.max(0, Math.min(100, Number(percent) || 0));
      draft.uploadPercent = value;
      const row = document.querySelector(`[data-todo-video-upload-id="${draft.id}"]`);
      if (!row) return;
      const progress = row.querySelector("progress");
      const label = row.querySelector(".todo-form-video-progress-label");
      if (progress) progress.value = value;
      if (label) label.textContent = `Nalagam video: ${value} %`;
    }

function uploadTodoVideoFile(file, onProgress = null, csrfRetried = false, pdf = false) {
      return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", pdf ? "/api/todos/pdf" : "/api/todos/video", true);
        request.timeout = moduleValues.appConfig.network.uploadTimeoutSeconds * 1000;
        request.responseType = "json";
        request.withCredentials = true;
        request.setRequestHeader("Content-Type", pdf ? "application/pdf" : todoVideoMimeType(file));
        request.setRequestHeader("X-Indus-File-Name", encodeURIComponent(file.name));
        if (state.csrfToken) request.setRequestHeader("X-CSRF-Token", state.csrfToken);
        request.upload.addEventListener("progress", (event) => {
          if (!event.lengthComputable) return;
          const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
          if (typeof onProgress === "function") onProgress(percent, event);
        });
        request.addEventListener("load", async () => {
          let data = request.response;
          if (!data || typeof data === "string") {
            try { data = request.responseText ? JSON.parse(request.responseText) : null; } catch { data = null; }
          }
          const csrfFailure = request.status === 403 && /varnostna potrditev seje manjka/i.test(String(data?.error || ""));
          if (csrfFailure && !csrfRetried && navigator.onLine) {
            try {
              await refreshSessionSecurityContext();
              resolve(await uploadTodoVideoFile(file, onProgress, true, pdf));
              return;
            } catch (error) {
              reject(error);
              return;
            }
          }
          if (request.status < 200 || request.status >= 300 || !data?.photo) {
            const tooLarge = request.status === 413;
            const error = new Error(data?.error || (tooLarge
              ? `Datoteka je prevelika. Omejitev: ${pdf ? moduleValues.appConfig.uploads.pdfMaxMb : moduleValues.appConfig.uploads.videoMaxMb} MB.`
              : request.status ? "Datoteka ni bila naložena (HTTP " + request.status + ")." : "Prenos priloge ni uspel."));
            error.status = request.status;
            reject(error);
            return;
          }
          resolve(data);
        });
        request.addEventListener("error", () => reject(new Error("Povezava med nalaganjem priloge je bila prekinjena.")));
        request.addEventListener("abort", () => reject(new Error("Nalaganje priloge je bilo prekinjeno.")));
        request.addEventListener("timeout", () => reject(new Error("Nalaganje je trajalo predolgo. Preveri povezavo in poskusi znova.")));
        request.send(file);
      });
    }

async function uploadTodoPdfFile(file) {
      const maximum = moduleValues.appConfig.uploads.pdfMaxMb;
      if (!file.size || file.size > maximum * 1048576) throw new Error("PDF mora biti neprazen in velik največ " + maximum + " MB.");
      setTodoVideoUploadStatus("Nalagam PDF: 0 %", "uploading", 0);
      try {
        const data = await uploadTodoVideoFile(file, percent => setTodoVideoUploadStatus("Nalagam PDF: " + percent + " %", "uploading", percent), false, true);
        setTodoVideoUploadStatus("PDF je naložen. Shrani obrazec, da ga pripneš dogodku.", "success", 100);
        return { ...data.photo, temporaryUpload: true };
      } catch (error) { setTodoVideoUploadStatus(error.message, "error"); throw error; }
    }

async function uploadTodoVideoFiles(files) {
      const selectedFiles = [...(files || [])];
      if (!selectedFiles.length) return;
      const maxBytes = moduleValues.appConfig.uploads.videoMaxMb * 1048576;
      try {
        for (const [index, file] of selectedFiles.entries()) {
          if (state.todoDialogPhotos.length >= moduleValues.maxTodoAttachments) throw new Error(`Največ je ${moduleValues.maxTodoAttachments} prilog na opravilo.`);
          if (!file.size) throw new Error("Praznega videa ni mogoče dodati.");
          if (file.size > maxBytes) throw new Error(`Video je prevelik. Največja dovoljena velikost je ${moduleValues.appConfig.uploads.videoMaxMb} MB.`);
          const draft = {
            id: createLocalUuid(),
            name: "Video",
            comment: "",
            mimeType: todoVideoMimeType(file),
            uploading: true,
            uploadPercent: 0,
            createdByName: state.user?.name || ""
          };
          state.todoDialogPhotos.push(draft);
          renderTodoFormPhotos();
          setTodoVideoUploadStatus(`Nalagam video ${index + 1}/${selectedFiles.length}: 0 %`, "uploading", 0);
          try {
            const data = await uploadTodoVideoFile(file, (percent) => {
              updateTodoVideoUploadDraft(draft, percent);
              setTodoVideoUploadStatus(`Nalagam video ${index + 1}/${selectedFiles.length}: ${percent} %`, "uploading", percent);
            });
            const draftIndex = state.todoDialogPhotos.findIndex((item) => item.id === draft.id);
            if (draftIndex >= 0 && !state.todoDialogPhotos.some((item, itemIndex) => itemIndex !== draftIndex && item.attachmentId === data.photo.attachmentId)) {
              // The server keeps a fresh video in a short-lived pending area
              // until the whole form is saved.  This client-only marker is
              // deliberately not copied to a saved task, so reopening an
              // existing task never tries to delete its real video.
              state.todoDialogPhotos.splice(draftIndex, 1, { ...data.photo, temporaryUpload: true });
            }
            renderTodoFormPhotos();
          } catch (error) {
            draft.uploading = false;
            draft.uploadError = String(error?.message || "Neznana napaka.");
            renderTodoFormPhotos();
            throw error;
          }
        }
        setTodoVideoUploadStatus("Video je dodan kot priloga. Pred shranjevanjem lahko dopišeš komentar.", "success", 100);
      } catch (error) {
        setTodoVideoUploadStatus("Video ni bil dodan: " + String(error?.message || "Neznana napaka."), "error");
        throw error;
      }
    }

function todoImageMimeType(file) {
      const nativeType = String(file?.type || "").split(";", 1)[0].trim().toLowerCase();
      const name = String(file?.name || "").toLowerCase();
      const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
      return ({
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
        ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif", ".avif": "image/avif",
        ".tif": "image/tiff", ".tiff": "image/tiff", ".bmp": "image/bmp", ".jxl": "image/jxl"
      })[extension] || (nativeType.startsWith("image/") ? nativeType : "application/octet-stream");
    }

function isTodoImageFile(file) {
      return todoImageMimeType(file).startsWith("image/");
    }

function canFallbackToBrowserImageProcessing(file) {
      const type = todoImageMimeType(file);
      return isSupportedImageFile(file) && type !== "image/heic" && type !== "image/heif";
    }

function uploadTodoImageFile(file, onProgress = null, csrfRetried = false) {
      return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/todos/image", true);
        request.timeout = moduleValues.appConfig.network.uploadTimeoutSeconds * 1000;
        request.responseType = "json";
        request.withCredentials = true;
        request.setRequestHeader("Content-Type", todoImageMimeType(file));
        request.setRequestHeader("X-Indus-File-Name", encodeURIComponent(file.name));
        if (state.csrfToken) request.setRequestHeader("X-CSRF-Token", state.csrfToken);
        request.upload.addEventListener("progress", (event) => {
          if (!event.lengthComputable) return;
          const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
          if (typeof onProgress === "function") onProgress(percent, event);
        });
        request.addEventListener("load", async () => {
          let data = request.response;
          if (!data || typeof data === "string") {
            try { data = request.responseText ? JSON.parse(request.responseText) : null; } catch { data = null; }
          }
          const csrfFailure = request.status === 403 && /varnostna potrditev seje manjka/i.test(String(data?.error || ""));
          if (csrfFailure && !csrfRetried && navigator.onLine) {
            try {
              await refreshSessionSecurityContext();
              resolve(await uploadTodoImageFile(file, onProgress, true));
              return;
            } catch (error) {
              reject(error);
              return;
            }
          }
          if (request.status < 200 || request.status >= 300 || !data?.photo) {
            const error = new Error(data?.error || (request.status === 413
              ? `Slika je prevelika. Največja dovoljena velikost je ${moduleValues.appConfig.uploads.imageMaxMb} MB.`
              : request.status ? "Slike ni bilo mogoče naložiti (HTTP " + request.status + ")." : "Prenos slike ni uspel."));
            error.status = request.status;
            reject(error);
            return;
          }
          resolve(data);
        });
        request.addEventListener("error", () => reject(new Error("Povezava med nalaganjem slike je bila prekinjena.")));
        request.addEventListener("abort", () => reject(new Error("Nalaganje slike je bilo prekinjeno.")));
        request.addEventListener("timeout", () => reject(new Error("Nalaganje slike je trajalo predolgo.")));
        request.send(file);
      });
    }

async function uploadTodoImageFiles(files) {
      const selectedFiles = [...(files || [])];
      const maxBytes = moduleValues.appConfig.uploads.imageMaxMb * 1048576;
      for (const file of selectedFiles) {
        if (state.todoDialogPhotos.length >= moduleValues.maxTodoAttachments) throw new Error(`Največ je ${moduleValues.maxTodoAttachments} prilog na opravilo.`);
        if (!file.size) throw new Error("Prazne slike ni mogoče dodati.");
        if (file.size > maxBytes) throw new Error(`Slika je prevelika. Največja dovoljena velikost je ${moduleValues.appConfig.uploads.imageMaxMb} MB.`);
        const draft = {
          id: createLocalUuid(),
          name: file.name || "Fotografija",
          comment: "",
          mimeType: todoImageMimeType(file),
          uploading: true,
          uploadKind: "image",
          uploadPercent: 0,
          createdByName: state.user?.name || ""
        };
        state.todoDialogPhotos.push(draft);
        renderTodoFormPhotos();
        try {
          const data = await uploadTodoImageFile(file, (percent) => updateTodoVideoUploadDraft(draft, percent));
          const draftIndex = state.todoDialogPhotos.findIndex((item) => item.id === draft.id);
          if (draftIndex >= 0 && !state.todoDialogPhotos.some((item, itemIndex) => itemIndex !== draftIndex && item.attachmentId === data.photo.attachmentId)) {
            state.todoDialogPhotos.splice(draftIndex, 1, data.photo);
          }
          renderTodoFormPhotos();
        } catch (uploadError) {
          if (canFallbackToBrowserImageProcessing(file)) {
            try {
              const fallback = await todoAttachmentFromFile(file);
              const draftIndex = state.todoDialogPhotos.findIndex((item) => item.id === draft.id);
              if (draftIndex >= 0) state.todoDialogPhotos.splice(draftIndex, 1, fallback);
              renderTodoFormPhotos();
              continue;
            } catch (fallbackError) {
              uploadError = fallbackError;
            }
          }
          draft.uploading = false;
          draft.uploadError = String(uploadError?.message || "Neznana napaka.");
          renderTodoFormPhotos();
          throw uploadError;
        }
      }
    }

function addTodoDriveLink() {
      const input = $("todoFormDriveLink");
      const info = todoWorkspaceFileInfo(input.value);
      if (!info) {
        showNotice("Prilepi povezavo do Google Dokumenta ali Google Preglednice.");
        return;
      }
      if (state.todoDialogDriveFiles.some((file) => file.fileId === info.fileId)) {
        input.value = "";
        return;
      }
      state.todoDialogDriveFiles.push({
        id: createLocalUuid(),
        kind: info.kind,
        fileId: info.fileId,
        url: info.url,
        name: info.kind === "document" ? "Google Dokument" : "Google Preglednica",
        managed: false,
        ownerEmail: ""
      });
      input.value = "";
      $("todoFormDriveLinkPanel").classList.add("hidden");
      renderTodoFormDriveFiles();
    }

function scheduleTodoFormPhotoPreviews() {
      if (moduleValues.todoDialogPhotoPreviewTimer) clearTimeout(moduleValues.todoDialogPhotoPreviewTimer);
      // Let the dialog paint first.  A busy event can contain many images and
      // previously all thumbnail requests started before the editor appeared.
      moduleValues.todoDialogPhotoPreviewTimer = window.setTimeout(() => {
        moduleValues.todoDialogPhotoPreviewTimer = 0;
        if ($("todoDialog").open) renderTodoFormPhotos({ imagePreviews: true });
      }, 180);
    }

function renderTodoFormPhotos({ imagePreviews = true } = {}) {
      const list = $("todoFormPhotoList");
      list.innerHTML = state.todoDialogPhotos.map((photo) => {
        const video = isVideoAttachment(photo);
        const uploading = Boolean(photo.uploading);
        const uploadError = String(photo.uploadError || "");
        const uploadLabel = isPdfAttachment(photo) ? "PDF se nalaga" : photo.uploadKind === "image" ? "Slika se obdeluje" : "Video se nalaga";
        const label = uploading ? uploadLabel : attachmentLabel(photo);
        const displayName = uploading ? label : attachmentDisplayName(photo);
        const imageThumbnail = imagePreviews && !video && !isPdfAttachment(photo) && attachmentThumbnailSource(photo);
        const thumb = imageThumbnail
          ? `<span class="todo-form-attachment-thumb"><img src="${escapeHtml(imageThumbnail)}" alt="" loading="lazy" decoding="async"></span>`
          : attachmentSymbolMarkup(photo);
        const preview = uploading || uploadError
          ? `<div class="todo-form-attachment-preview" aria-live="polite">${attachmentSymbolMarkup(photo)}<span>${escapeHtml(displayName)}</span></div>`
          : `<button class="todo-form-attachment-preview" type="button" data-photo-id="${escapeHtml(photo.id)}">${thumb}<span>${escapeHtml(displayName)}</span></button>`;
        const metadata = photo.createdByName ? `<span class="todo-meta">Dodal: ${escapeHtml(photo.createdByName)}</span>` : "";
        const comment = `<input class="todo-form-photo-comment" type="text" maxlength="500" data-photo-comment-id="${escapeHtml(photo.id)}" placeholder="Komentar priloge" value="${escapeHtml(photo.comment || "")}">`;
        const detail = uploading
          ? `<div class="todo-form-video-progress" data-todo-video-upload-id="${escapeHtml(photo.id)}"><span class="todo-form-video-progress-label">${escapeHtml(uploadLabel)}: ${Math.max(0, Math.min(100, Number(photo.uploadPercent) || 0))} %</span><progress max="100" value="${Math.max(0, Math.min(100, Number(photo.uploadPercent) || 0))}"></progress><span>${photo.uploadKind === "image" ? "Predogled se prikaže takoj po strežniški obdelavi." : "Video bo dodan med priloge takoj po prenosu."}</span></div>`
          : uploadError
            ? `<div class="todo-form-video-progress todo-form-video-error"><span>${photo.uploadKind === "image" ? "Slika" : "Video"} ni bil dodan: ${escapeHtml(uploadError)}</span></div>`
            : `<div class="todo-form-attachment-detail">${video ? "<strong>Video</strong>" : ""}${comment}${metadata}</div>`;
        const actions = uploading
          ? ""
          : `<div class="todo-form-photo-actions"><button class="secondary share-todo-form-photo" type="button" data-photo-id="${escapeHtml(photo.id)}" title="Deli prilogo" aria-label="Deli prilogo">&#128228;</button>${isPdfAttachment(photo) || video ? "" : `<button class="secondary edit-todo-form-photo" type="button" data-photo-id="${escapeHtml(photo.id)}">Uredi</button>`}<button class="danger remove-todo-form-photo" type="button" data-photo-id="${escapeHtml(photo.id)}">Odstrani</button></div>`;
        return `<div class="todo-form-photo-row ${uploading ? "todo-form-video-uploading" : ""}">${preview}${detail}${actions}</div>`;
      }).join("");
      installTodoPhotoErrorHandlers(list);
      if ($("todoDialog").open) scheduleTodoCreationDraftSave();
    }

async function attachmentDataForProcessing(photo) {
      if (photo?.data) return photo.data;
      const source = attachmentSource(photo);
      if (!source) return "";
      const response = await fetch(source, { credentials: "same-origin" });
      if (!response.ok) throw new Error("Priloge ni bilo mogoče prenesti.");
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Priloge ni bilo mogoče prebrati."));
        reader.readAsDataURL(blob);
      });
    }

async function fillMissingPdfThumbnailsForDialog(photos) {
      for (const photo of photos) {
        if (!isPdfAttachment(photo) || photo.thumbnailData || photo.thumbnailUrl) continue;
        // Legacy inline PDFs are small. Streamed PDFs can be 50 MB: never
        // download/base64-decode those automatically on opening an event.
        if (photo.attachmentId && !photo.data) continue;
        const thumbnailData = await createPdfThumbnailSafely(await attachmentDataForProcessing(photo));
        if (state.todoDialogPhotos !== photos) return;
        const current = photos.find((item) => item.id === photo.id);
        if (!current || !thumbnailData) continue;
        current.thumbnailData = thumbnailData;
        renderTodoFormPhotos();
      }
    }

function markTodoDialogAttachmentsSaved() {
      state.todoDialogPhotos.forEach((photo) => { delete photo.temporaryUpload; });
    }

async function discardTemporaryTodoAttachment(photo) {
      if (!photo?.temporaryUpload || (!isVideoAttachment(photo) && !isPdfAttachment(photo)) || !/^[a-f0-9]{64}$/.test(String(photo?.attachmentId || ""))) return;
      // Avoid a duplicate request if this same temporary video is removed and
      // the form is subsequently closed before the first cleanup completes.
      delete photo.temporaryUpload;
      try {
        await api(`/api/attachments/${encodeURIComponent(photo.attachmentId)}/pending`, { method: "DELETE", body: JSON.stringify({}) });
      } catch {
        // A saved attachment is no longer pending, so there is nothing to discard.
      }
    }

function discardTemporaryTodoAttachments(photos = state.todoDialogPhotos) {
      return Promise.all((photos || []).map((photo) => discardTemporaryTodoAttachment(photo)));
    }

async function handleTodoAttachmentsFromInput(event) {
      try {
        const selectedFiles = [...(event.target.files || [])];
        if (!selectedFiles.length) return;
        const remaining = Math.max(0, moduleValues.maxTodoAttachments - state.todoDialogPhotos.length);
        if (!remaining) {
          showNotice(`Na opravilu je že največ ${moduleValues.maxTodoAttachments} prilog.`);
          return;
        }
        const files = selectedFiles.slice(0, remaining);
        if (selectedFiles.length > remaining) {
          showNotice(`Izbranih je ${selectedFiles.length} prilog; dodanih bo prvih ${remaining}.`);
        }
        const videoFiles = files.filter(isTodoVideoFile);
        const imageFiles = files.filter((file) => !isTodoVideoFile(file) && isTodoImageFile(file));
        const standardFiles = files.filter((file) => !isTodoVideoFile(file) && !isTodoImageFile(file));
        if (imageFiles.length) await uploadTodoImageFiles(imageFiles);
        for (const file of standardFiles) {
          const draft = { id: createLocalUuid(), name: file.name, mimeType: "application/pdf", uploading: true };
          state.todoDialogPhotos.push(draft);
          renderTodoFormPhotos();
          try {
            const attachment = await todoAttachmentFromFile(file);
            const index = state.todoDialogPhotos.indexOf(draft);
            if (index >= 0) state.todoDialogPhotos.splice(index, 1, attachment);
            // If the user closed/discarded the form meanwhile, do not attach
            // the completed upload to a subsequently opened event.
            else discardTemporaryTodoAttachment(attachment);
          } catch (error) {
            const index = state.todoDialogPhotos.indexOf(draft);
            if (index >= 0) state.todoDialogPhotos.splice(index, 1);
            renderTodoFormPhotos();
            throw error;
          }
        }
        renderTodoFormPhotos();
        if (videoFiles.length) await uploadTodoVideoFiles(videoFiles);
      } catch (error) {
        showNotice(error.message);
      } finally {
        event.target.value = "";
        $("todoFormAttachmentMenu").open = false;
      }
    }

function installDriveAttachmentBindings1() {
    document.querySelectorAll("[data-create-drive]").forEach((button) => {
      button.addEventListener("click", () => createTodoGoogleDriveFile(button.dataset.createDrive).catch((error) => showNotice(error.message)));
    });
    $("showTodoDriveLink").addEventListener("click", () => {
      $("todoFormAttachmentMenu").open = false;
      $("todoFormDriveLinkPanel").classList.remove("hidden");
      requestAnimationFrame(() => $("todoFormDriveLink").focus());
    });
    $("addTodoDriveLink").addEventListener("click", addTodoDriveLink);
    $("todoFormDriveLink").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      addTodoDriveLink();
    });
    $("todoFormDriveFileList").addEventListener("click", (event) => {
      const button = event.target.closest(".remove-todo-drive-file");
      if (!button) return;
      state.todoDialogDriveFiles = state.todoDialogDriveFiles.filter((file) => file.id !== button.dataset.driveFileId);
      renderTodoFormDriveFiles();
    });
}

function installMediaUploadBindings1() {
    ["todoFormAttachmentInput", "todoFormCameraInput", "todoFormVideoInput"].forEach((id) => {
      $(id).addEventListener("change", handleTodoAttachmentsFromInput);
    });
    $("todoFormPhotoList").addEventListener("click", (event) => {
      const share = event.target.closest(".share-todo-form-photo");
      if (share) {
        const photo = state.todoDialogPhotos.find((item) => item.id === share.dataset.photoId);
        if (photo) shareTodoAttachment(photo).catch((error) => showNotice(error.message));
        return;
      }
      const edit = event.target.closest(".edit-todo-form-photo");
      if (edit) {
        const photo = state.todoDialogPhotos.find((item) => item.id === edit.dataset.photoId);
        if (photo) openPhotoEditor(photo);
        return;
      }
      const preview = event.target.closest(".todo-form-attachment-preview");
      if (preview) {
        const photo = state.todoDialogPhotos.find((item) => item.id === preview.dataset.photoId);
        if (photo) openAttachmentPreview(photo, { todoId: $("todoFormId").value, photos: state.todoDialogPhotos });
        return;
      }
      const button = event.target.closest(".remove-todo-form-photo");
      if (!button) return;
      const removed = state.todoDialogPhotos.find((photo) => photo.id === button.dataset.photoId);
      state.todoDialogPhotos = state.todoDialogPhotos.filter((photo) => photo.id !== button.dataset.photoId);
      discardTemporaryTodoAttachment(removed);
      renderTodoFormPhotos();
    });
    $("todoFormPhotoList").addEventListener("input", (event) => {
      const input = event.target.closest("[data-photo-comment-id]");
      if (!input) return;
      const photo = state.todoDialogPhotos.find((item) => item.id === input.dataset.photoCommentId);
      if (photo) photo.comment = input.value.slice(0, 500);
    });
}

  return {
    uploadTodoPdfFile,
    renderTodoDriveFilesHtml,
    renderTodoFormDriveFiles,
    setTodoVideoUploadStatus,
    scheduleTodoFormPhotoPreviews,
    renderTodoFormPhotos,
    markTodoDialogAttachmentsSaved,
    discardTemporaryTodoAttachments,
    installDriveAttachmentBindings1,
    installMediaUploadBindings1
  };
}
