// editor/media-preview: explicit dependencies; factory creation has no I/O or UI effects.
function createMediaPreview({
  $,
  state,
  canvasAsLimitedJpegDataUrl,
  escapeHtml,
  openTodoDialog,
  renderTodoFormPhotos,
  showNotice,
  todoAttachmentsDataLength,
  moduleValues
}) {
function attachmentSource(photo) {
      return String(photo?.data || photo?.url || "");
    }

function attachmentThumbnailSource(photo) {
      const thumbnail = String(photo?.thumbnailData || photo?.thumbnailUrl || "");
      if (thumbnail) return thumbnail;
      const source = attachmentSource(photo);
      // Legacy photographs may not have a generated thumbnail. Use their
      // protected original URL as a lazy-loaded fallback in the report.
      return /^data:image\//i.test(source) || /^\/api\/attachments\//.test(source) ? source : "";
    }

function isPdfAttachment(photo) {
      return String(photo?.mimeType || "").toLowerCase() === "application/pdf"
        || attachmentSource(photo).startsWith("data:application/pdf;base64,")
        || /\.pdf$/i.test(String(photo?.name || ""));
    }

function isVideoAttachment(photo) {
      return String(photo?.mimeType || "").toLowerCase().startsWith("video/")
        || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(String(photo?.name || ""));
    }

function attachmentLabel(photo) {
      if (isVideoAttachment(photo)) return "Video";
      if (isPdfAttachment(photo)) return "PDF dokument";
      return "Fotografija";
    }

function attachmentDisplayName(photo) {
      return String(photo?.name || "").trim() || attachmentLabel(photo);
    }

function attachmentSymbolMarkup(photo) {
      const type = isVideoAttachment(photo) ? "video" : isPdfAttachment(photo) ? "pdf" : "photo";
      const label = type === "video" ? "VIDEO" : type === "pdf" ? "PDF" : "FOTO";
      return `<span class="todo-attachment-file-icon is-${type}" aria-hidden="true">${label}</span>`;
    }

function pdfThumbnailMarkup(photo, showBadge = false) {
      const thumbnail = attachmentThumbnailSource(photo);
      if (!thumbnail) return "PDF";
      return `<img src="${escapeHtml(thumbnail)}" alt="Predogled prve strani PDF">${showBadge ? `<span class="pdf-thumbnail-badge">PDF</span>` : ""}`;
    }

function pointerGestureMetrics(pointers, predicate = null) {
      const source = [...pointers.values()];
      const points = (predicate ? source.filter(predicate) : source).slice(0, 2);
      if (points.length < 2) return null;
      const [first, second] = points;
      return {
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
      };
    }

function scrollerViewportCenter(scroller) {
      const rect = scroller.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

function setZoomedElementWidth(scroller, element, width, anchor = null) {
      const before = element.getBoundingClientRect();
      const ratioX = anchor && before.width ? (anchor.x - before.left) / before.width : 0.5;
      const ratioY = anchor && before.height ? (anchor.y - before.top) / before.height : 0.5;
      element.style.width = `${Math.max(1, Math.round(width))}px`;
      if (!anchor || !before.width || !before.height) return;
      const after = element.getBoundingClientRect();
      scroller.scrollLeft += after.left + ratioX * after.width - anchor.x;
      scroller.scrollTop += after.top + ratioY * after.height - anchor.y;
    }

function setAttachmentPreviewZoom(value, anchor = null) {
      const preview = state.attachmentPreview;
      const image = $("attachmentPreviewImage");
      const body = image.closest(".attachment-preview-body");
      const zoom = Math.max(10, Math.min(500, Number(value) || 100));
      if (preview) preview.zoom = zoom;
      $("attachmentPreviewZoomValue").textContent = `${Math.round(zoom)} %`;
      if (image.naturalWidth && body) setZoomedElementWidth(body, image, image.naturalWidth * zoom / 100, anchor);
    }

function fitAttachmentPreview() {
      const image = $("attachmentPreviewImage");
      const body = image.closest(".attachment-preview-body");
      if (!image.naturalWidth || !image.naturalHeight || !body) return;
      const widthRatio = Math.max(0.1, (body.clientWidth - 20) / image.naturalWidth);
      const heightRatio = Math.max(0.1, (window.innerHeight - 190) / image.naturalHeight);
      const zoom = Math.min(100, Math.floor(Math.min(widthRatio, heightRatio) * 100));
      setAttachmentPreviewZoom(Math.max(10, zoom));
      body.scrollLeft = 0;
      body.scrollTop = 0;
    }

function flushAttachmentPreviewGesture(preview = state.attachmentPreview) {
      if (!preview || state.attachmentPreview !== preview) return;
      preview.gestureFrame = 0;
      const pending = preview.pendingGesture;
      preview.pendingGesture = null;
      if (!pending) return;
      const body = $("attachmentPreviewImage").closest(".attachment-preview-body");
      const gesture = preview.gesture;
      if (!body || !gesture) return;
      if (pending.type === "pinch") {
        if (preview.pointers.size < 2 || gesture.type !== "pinch") return;
        const rawRatio = pending.metrics.distance / Math.max(1, gesture.lastDistance);
        const ratio = Math.max(0.8, Math.min(1.25, rawRatio));
        // Scale around the previous finger centre, then move the image by the
        // centre delta.  These are complementary operations, not competing
        // anchor points.
        if (Math.abs(rawRatio - 1) >= 0.004) setAttachmentPreviewZoom(preview.zoom * ratio, gesture.lastCenter);
        body.scrollLeft -= pending.metrics.center.x - gesture.lastCenter.x;
        body.scrollTop -= pending.metrics.center.y - gesture.lastCenter.y;
        preview.gesture = { type: "pinch", lastDistance: pending.metrics.distance, lastCenter: pending.metrics.center };
        return;
      }
      if (pending.type !== "pan" || gesture.type !== "pan" || gesture.pointerId !== pending.pointerId) return;
      body.scrollLeft -= pending.x - gesture.lastX;
      body.scrollTop -= pending.y - gesture.lastY;
      preview.gesture = { type: "pan", pointerId: pending.pointerId, lastX: pending.x, lastY: pending.y };
    }

function queueAttachmentPreviewGesture(preview, next) {
      if (!preview || state.attachmentPreview !== preview) return;
      preview.pendingGesture = next;
      if (preview.gestureFrame) return;
      preview.gestureFrame = requestAnimationFrame(() => flushAttachmentPreviewGesture(preview));
    }

function previewableAttachmentPhotos(photos) {
      return (photos || []).filter((item) => !isPdfAttachment(item) && !isVideoAttachment(item) && Boolean(attachmentSource(item)));
    }

function updateAttachmentPreviewNavigation() {
      const preview = state.attachmentPreview;
      const navigation = $("attachmentPreviewNavigation");
      const count = preview?.photos?.length || 0;
      navigation.hidden = count < 2;
      $("attachmentPreviewPrevious").disabled = !preview || preview.index <= 0;
      $("attachmentPreviewNext").disabled = !preview || preview.index >= count - 1;
      $("attachmentPreviewPosition").textContent = count > 1 ? `${preview.index + 1}/${count}` : "";
    }

function showAttachmentPreviewPhoto(photo) {
      const preview = state.attachmentPreview;
      if (!preview || !photo) return;
      preview.photo = photo;
      $("attachmentPreviewTitle").textContent = "Fotografija";
      const image = $("attachmentPreviewImage");
      image.alt = "Predogled fotografije";
      image.onload = () => requestAnimationFrame(fitAttachmentPreview);
      image.src = attachmentSource(photo);
      if (image.complete) requestAnimationFrame(fitAttachmentPreview);
      updateAttachmentPreviewNavigation();
    }

function moveAttachmentPreview(offset) {
      const preview = state.attachmentPreview;
      if (!preview?.photos?.length) return;
      const index = Math.max(0, Math.min(preview.photos.length - 1, preview.index + offset));
      if (index === preview.index) return;
      preview.index = index;
      showAttachmentPreviewPhoto(preview.photos[index]);
    }

function openAttachmentPreview(photo, context = {}) {
      if (isPdfAttachment(photo) || isVideoAttachment(photo)) {
        const link = document.createElement("a");
        link.href = attachmentSource(photo);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
      }
      const photos = previewableAttachmentPhotos(context.photos || [photo]);
      const index = Math.max(0, photos.findIndex((item) => item.id === photo.id));
      state.attachmentPreview = {
        photo: photos[index] || photo,
        todoId: context.todoId || "",
        photos: photos.length ? photos : [photo],
        index,
        zoom: 100,
        pointers: new Map(),
        gesture: null,
        gestureFrame: 0,
        pendingGesture: null
      };
      const image = $("attachmentPreviewImage");
      image.draggable = false;
      const dialog = $("attachmentPreviewDialog");
      if (!dialog.open) dialog.showModal();
      showAttachmentPreviewPhoto(state.attachmentPreview.photo);
    }

function drawPhotoEditorStroke(context, stroke) {
      const points = stroke?.points || [];
      if (!points.length) return;
      context.save();
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.size;
      context.lineCap = "round";
      context.lineJoin = "round";
      if (points.length === 1) {
        context.beginPath();
        context.arc(points[0].x, points[0].y, Math.max(1, stroke.size / 2), 0, Math.PI * 2);
        context.fill();
        context.restore();
        return;
      }
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      context.stroke();
      context.restore();
    }

function photoEditorTextSnapshot(text) {
      return text ? { id: text.id, text: text.text, x: text.x, y: text.y, size: text.size, color: text.color, rotation: text.rotation } : null;
    }

function selectedPhotoEditorText() {
      const editor = state.photoEditor;
      return editor?.texts.find((text) => text.id === editor.selectedTextId) || null;
    }

function photoEditorTextMetrics(context, text) {
      context.save();
      context.font = `800 ${text.size}px system-ui, -apple-system, sans-serif`;
      const lines = String(text.text || " ").split("\n");
      const width = Math.max(text.size * 0.8, ...lines.map((line) => context.measureText(line || " ").width));
      context.restore();
      return { width, height: text.size * 1.25 * lines.length, lines };
    }

function drawPhotoEditorText(context, text, selected = false) {
      const { width, height, lines } = photoEditorTextMetrics(context, text);
      const rotation = Number(text.rotation || 0) * Math.PI / 180;
      context.save();
      context.translate(text.x, text.y);
      context.rotate(rotation);
      context.font = `800 ${text.size}px system-ui, -apple-system, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.lineJoin = "round";
      context.lineWidth = Math.max(2, text.size * 0.09);
      context.strokeStyle = "rgba(0, 0, 0, .66)";
      context.fillStyle = text.color;
      lines.forEach((line, index) => {
        const y = (index - (lines.length - 1) / 2) * text.size * 1.25;
        context.strokeText(line, 0, y);
        context.fillText(line, 0, y);
      });
      if (selected) {
        const pad = Math.max(9, text.size * 0.22);
        const handleY = -height / 2 - pad * 2.3;
        context.strokeStyle = "#087c99";
        context.fillStyle = "#e9fbff";
        context.lineWidth = Math.max(2, text.size * 0.035);
        context.setLineDash([Math.max(4, text.size * 0.12), Math.max(4, text.size * 0.09)]);
        context.strokeRect(-width / 2 - pad, -height / 2 - pad, width + pad * 2, height + pad * 2);
        context.setLineDash([]);
        context.beginPath();
        context.moveTo(0, -height / 2 - pad);
        context.lineTo(0, handleY);
        context.stroke();
        context.beginPath();
        context.arc(0, handleY, Math.max(9, text.size * 0.18), 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.fillStyle = "#087c99";
        context.font = `800 ${Math.max(13, text.size * 0.28)}px system-ui, sans-serif`;
        context.fillText(String.fromCodePoint(0x21BB), 0, handleY + 1);
      }
      context.restore();
    }

function photoEditorTextHitTest(point) {
      const editor = state.photoEditor;
      if (!editor) return null;
      const canvas = $("photoEditorCanvas");
      const context = canvas.getContext("2d");
      for (const text of [...editor.texts].reverse()) {
        const { width, height } = photoEditorTextMetrics(context, text);
        const angle = Number(text.rotation || 0) * Math.PI / 180;
        const deltaX = point.x - text.x;
        const deltaY = point.y - text.y;
        const localX = Math.cos(angle) * deltaX + Math.sin(angle) * deltaY;
        const localY = -Math.sin(angle) * deltaX + Math.cos(angle) * deltaY;
        const scale = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
        const pad = Math.max(moduleValues.appConfig.editor.photoTouchPixels * scale, text.size * 0.24);
        const handleY = -height / 2 - Math.max(9, text.size * 0.22) * 2.3;
        if (Math.abs(localX) <= width / 2 + 6 * scale && Math.abs(localY) <= height / 2 + 6 * scale) return { text, action: "move" };
        if (text.id === editor.selectedTextId && Math.hypot(localX, localY - handleY) <= Math.max(moduleValues.appConfig.editor.photoTouchPixels * scale, text.size * 0.3)) return { text, action: "rotate" };
        if (Math.abs(localX) <= width / 2 + pad && Math.abs(localY) <= height / 2 + pad) return { text, action: "move" };
      }
      return null;
    }

function photoEditorCropMinimum() {
      const canvas = $("photoEditorCanvas");
      return Math.max(24, Math.min(96, Math.round(Math.min(canvas.width, canvas.height) * 0.06)));
    }

function normalizePhotoEditorCropRect(rect) {
      const canvas = $("photoEditorCanvas");
      const minimum = photoEditorCropMinimum();
      const width = Math.max(minimum, Math.min(canvas.width, Number(rect?.width) || minimum));
      const height = Math.max(minimum, Math.min(canvas.height, Number(rect?.height) || minimum));
      return {
        x: Math.max(0, Math.min(canvas.width - width, Number(rect?.x) || 0)),
        y: Math.max(0, Math.min(canvas.height - height, Number(rect?.y) || 0)),
        width,
        height
      };
    }

function defaultPhotoEditorCropRect() {
      const canvas = $("photoEditorCanvas");
      const inset = Math.max(0, Math.round(Math.min(canvas.width, canvas.height) * 0.075));
      return normalizePhotoEditorCropRect({ x: inset, y: inset, width: canvas.width - inset * 2, height: canvas.height - inset * 2 });
    }

function drawPhotoEditorCropOverlay(context, crop) {
      if (!crop) return;
      const canvas = $("photoEditorCanvas");
      context.save();
      context.fillStyle = "rgba(6, 18, 22, .52)";
      context.beginPath();
      context.rect(0, 0, canvas.width, canvas.height);
      context.rect(crop.x, crop.y, crop.width, crop.height);
      context.fill("evenodd");
      context.strokeStyle = "#e7ffff";
      context.lineWidth = Math.max(2, Math.min(canvas.width, canvas.height) * 0.004);
      context.setLineDash([Math.max(6, context.lineWidth * 3), Math.max(5, context.lineWidth * 2)]);
      context.strokeRect(crop.x, crop.y, crop.width, crop.height);
      context.setLineDash([]);
      const handle = Math.max(10, Math.min(26, Math.min(crop.width, crop.height) * 0.12));
      context.fillStyle = "#e7ffff";
      context.strokeStyle = "#087c99";
      context.lineWidth = Math.max(1.5, context.lineWidth * .8);
      [
        [crop.x, crop.y], [crop.x + crop.width, crop.y],
        [crop.x, crop.y + crop.height], [crop.x + crop.width, crop.y + crop.height]
      ].forEach(([x, y]) => {
        context.beginPath();
        context.rect(x - handle / 2, y - handle / 2, handle, handle);
        context.fill();
        context.stroke();
      });
      context.restore();
    }

function photoEditorCropHitTest(point) {
      const editor = state.photoEditor;
      const crop = editor?.cropRect;
      if (!crop) return { action: "new" };
      const handle = Math.max(18, Math.min(48, Math.min(crop.width, crop.height) * 0.16));
      const near = (x, y) => Math.abs(point.x - x) <= handle && Math.abs(point.y - y) <= handle;
      if (near(crop.x, crop.y)) return { action: "nw" };
      if (near(crop.x + crop.width, crop.y)) return { action: "ne" };
      if (near(crop.x, crop.y + crop.height)) return { action: "sw" };
      if (near(crop.x + crop.width, crop.y + crop.height)) return { action: "se" };
      if (point.x >= crop.x && point.x <= crop.x + crop.width && point.y >= crop.y && point.y <= crop.y + crop.height) return { action: "move" };
      return { action: "new" };
    }

function updatePhotoEditorCropInteraction(point) {
      const editor = state.photoEditor;
      const interaction = editor?.cropInteraction;
      if (!interaction) return;
      const canvas = $("photoEditorCanvas");
      const minimum = photoEditorCropMinimum();
      const dx = point.x - interaction.start.x;
      const dy = point.y - interaction.start.y;
      const before = interaction.before;
      let next = { ...before };
      if (interaction.action === "move") {
        next.x = before.x + dx;
        next.y = before.y + dy;
      } else if (interaction.action === "new") {
        next = { x: Math.min(interaction.start.x, point.x), y: Math.min(interaction.start.y, point.y), width: Math.abs(dx), height: Math.abs(dy) };
      } else {
        if (interaction.action.includes("w")) { next.x = before.x + dx; next.width = before.width - dx; }
        if (interaction.action.includes("e")) next.width = before.width + dx;
        if (interaction.action.includes("n")) { next.y = before.y + dy; next.height = before.height - dy; }
        if (interaction.action.includes("s")) next.height = before.height + dy;
        if (next.width < minimum) {
          if (interaction.action.includes("w")) next.x = before.x + before.width - minimum;
          next.width = minimum;
        }
        if (next.height < minimum) {
          if (interaction.action.includes("n")) next.y = before.y + before.height - minimum;
          next.height = minimum;
        }
      }
      next.width = Math.max(minimum, Math.min(canvas.width, next.width));
      next.height = Math.max(minimum, Math.min(canvas.height, next.height));
      editor.cropRect = normalizePhotoEditorCropRect(next);
    }

function photoEditorHasPendingOperation(editor = state.photoEditor) {
      return Boolean(editor && (editor.mode === "crop" || editor.textDraftActive));
    }

function photoEditorReturnMode(editor = state.photoEditor) {
      return editor?.toolReturnMode === "pan" ? "pan" : "draw";
    }

function syncPhotoEditorToolUi() {
      const editor = state.photoEditor;
      if (!editor) return;
      const pending = photoEditorHasPendingOperation(editor);
      const text = selectedPhotoEditorText();
      const shell = $("photoEditorCanvas").closest(".photo-editor-canvas-shell");
      $("photoEditorNormalTools").hidden = pending;
      $("photoEditorHeaderActions").hidden = pending;
      $("photoEditorFooterActions").hidden = pending;
      $("photoEditorPendingActions").hidden = !pending;
      if (pending) {
        const crop = editor.mode === "crop";
        $("photoEditorPendingLabel").textContent = crop ? "Potrdi ali povrni izrez" : "Dodaj ali povrni napis";
        $("photoEditorConfirmPending").textContent = crop ? "Potrdi izrez" : "Dodaj napis";
        $("photoEditorCancelPending").textContent = crop ? "Povrni izrez" : "Povrni napis";
      }
      shell.classList.toggle("is-text-editing", Boolean(text) && editor.mode === "text" && !pending);
      shell.classList.toggle("is-pan-mode", editor.mode === "pan");
      shell.classList.toggle("is-crop-mode", editor.mode === "crop");
      $("photoEditorDraw").classList.toggle("is-active", editor.mode === "draw");
      $("photoEditorPan").classList.toggle("is-active", editor.mode === "pan");
      $("photoEditorCrop").classList.toggle("is-active", editor.mode === "crop");
    }

function setPhotoEditorTextSelection(textId = "") {
      const editor = state.photoEditor;
      if (!editor) return;
      editor.selectedTextId = textId;
      const text = selectedPhotoEditorText();
      if (text) editor.textDraftActive = false;
      $("photoEditorDialog").classList.toggle("is-text-active", Boolean(text));
      const pending = photoEditorHasPendingOperation(editor);
      $("photoEditorTextEditor").hidden = !text && !editor.textDraftActive;
      $("photoEditorTextTools").hidden = !text || pending;
      if (text) {
        $("photoEditorText").value = text.text;
        $("photoEditorTextSize").value = Math.round(Math.max(12, Math.min(512, text.size)));
        $("photoEditorTextRotation").value = Math.round(Number(text.rotation || 0));
        $("photoEditorColor").value = text.color;
      } else if (!editor.textDraftActive) {
        $("photoEditorText").value = "";
      }
      syncPhotoEditorToolUi();
    }

function photoEditorHistoryPush(action) {
      const editor = state.photoEditor;
      if (!editor) return;
      editor.history.push(action);
      if (editor.history.length > 80) editor.history.shift();
    }

function rememberPhotoEditorTextChange(text, before) {
      const after = photoEditorTextSnapshot(text);
      if (!before || JSON.stringify(before) === JSON.stringify(after)) return;
      photoEditorHistoryPush({ type: "text-update", id: text.id, before });
    }

function redrawPhotoEditor({ includeSelection = true } = {}) {
      const editor = state.photoEditor;
      if (!editor?.image) return;
      const canvas = $("photoEditorCanvas");
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(editor.image, 0, 0, canvas.width, canvas.height);
      editor.strokes.forEach((stroke) => drawPhotoEditorStroke(context, stroke));
      if (editor.activeStroke) drawPhotoEditorStroke(context, editor.activeStroke);
      editor.texts.forEach((text) => drawPhotoEditorText(context, text, includeSelection && text.id === editor.selectedTextId));
      if (editor.cropRect) drawPhotoEditorCropOverlay(context, editor.cropRect);
    }

function photoEditorPoint(event) {
      const canvas = $("photoEditorCanvas");
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * canvas.width / Math.max(1, rect.width),
        y: (event.clientY - rect.top) * canvas.height / Math.max(1, rect.height)
      };
    }

function photoEditorVisiblePoint() {
      const canvas = $("photoEditorCanvas");
      const shell = canvas.closest(".photo-editor-canvas-shell");
      const canvasRect = canvas.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      return photoEditorPoint({
        clientX: Math.max(canvasRect.left, Math.min(canvasRect.right, shellRect.left + shell.clientWidth / 2)),
        clientY: Math.max(canvasRect.top, Math.min(canvasRect.bottom, shellRect.top + shell.clientHeight / 2))
      });
    }

function setPhotoEditorZoom(value, anchor = null) {
      const editor = state.photoEditor;
      const canvas = $("photoEditorCanvas");
      const shell = canvas.closest(".photo-editor-canvas-shell");
      const zoom = Math.max(10, Math.min(500, Number(value) || 100));
      if (editor) editor.zoom = zoom;
      $("photoEditorZoomValue").textContent = `${Math.round(zoom)} %`;
      if (canvas.width && shell) setZoomedElementWidth(shell, canvas, canvas.width * zoom / 100, anchor);
    }

function photoEditorTouchPinchMetrics(editor = state.photoEditor) {
      if (!editor) return null;
      return pointerGestureMetrics(editor.pointers, (point) => point.pointerType === "touch");
    }

function beginPhotoEditorPinch(editor, shell) {
      const metrics = photoEditorTouchPinchMetrics(editor);
      if (!metrics) return false;
      if (editor.panFrame) cancelAnimationFrame(editor.panFrame);
      editor.panFrame = 0;
      flushPhotoEditorPan(editor);
      const textInteraction = editor.textInteraction;
      if (textInteraction) {
        const text = selectedPhotoEditorText();
        if (text) Object.assign(text, textInteraction.before);
      }
      const cropInteraction = editor.cropInteraction;
      if (cropInteraction?.before) editor.cropRect = { ...cropInteraction.before };
      editor.activeStroke = null;
      editor.textInteraction = null;
      editor.cropInteraction = null;
      editor.pan = null;
      editor.gestureUsed = true;
      editor.pinch = { lastDistance: metrics.distance, lastCenter: metrics.center };
      shell.classList.remove("is-panning");
      redrawPhotoEditor();
      return true;
    }

function flushPhotoEditorPan(editor = state.photoEditor) {
      if (!editor || state.photoEditor !== editor) return;
      editor.panFrame = 0;
      const pending = editor.pendingPan;
      editor.pendingPan = null;
      const pan = editor.pan;
      if (!pending || !pan || pan.pointerId !== pending.pointerId) return;
      const shell = $("photoEditorCanvas").closest(".photo-editor-canvas-shell");
      if (!shell) return;
      shell.scrollLeft -= pending.x - pan.lastX;
      shell.scrollTop -= pending.y - pan.lastY;
      pan.lastX = pending.x;
      pan.lastY = pending.y;
    }

function queuePhotoEditorPan(editor, next) {
      if (!editor || state.photoEditor !== editor) return;
      editor.pendingPan = next;
      if (editor.panFrame) return;
      editor.panFrame = requestAnimationFrame(() => flushPhotoEditorPan(editor));
    }

function queuePhotoEditorPinch(metrics) {
      const editor = state.photoEditor;
      if (!editor || !metrics || !editor.pinch) return;
      editor.pendingPinch = metrics;
      if (editor.pinchFrame) return;
      editor.pinchFrame = requestAnimationFrame(() => {
        if (state.photoEditor !== editor) return;
        editor.pinchFrame = 0;
        const next = editor.pendingPinch;
        editor.pendingPinch = null;
        if (!next || !editor.pinch || !photoEditorTouchPinchMetrics(editor)) return;
        const previous = editor.pinch;
        const rawRatio = next.distance / Math.max(1, previous.lastDistance);
        const ratio = Math.max(0.8, Math.min(1.25, rawRatio));
        const shell = $("photoEditorCanvas").closest(".photo-editor-canvas-shell");
        if (!shell) return;
        // Keep one anchor for the scale and apply the two-finger translation
        // separately. Using the new centre for both made zoom and pan fight.
        if (Math.abs(rawRatio - 1) >= 0.004) setPhotoEditorZoom(editor.zoom * ratio, previous.lastCenter);
        shell.scrollLeft -= next.center.x - previous.lastCenter.x;
        shell.scrollTop -= next.center.y - previous.lastCenter.y;
        editor.pinch = { lastDistance: next.distance, lastCenter: next.center };
      });
    }

function fitPhotoEditorZoom() {
      const canvas = $("photoEditorCanvas");
      const shell = canvas.closest(".photo-editor-canvas-shell");
      if (!canvas.width || !canvas.height || !shell) return;
      const widthRatio = Math.max(0.1, (shell.clientWidth - 20) / canvas.width);
      const heightRatio = Math.max(0.1, (shell.clientHeight - 20) / canvas.height);
      const zoom = Math.min(100, Math.floor(Math.min(widthRatio, heightRatio) * 100));
      setPhotoEditorZoom(Math.max(10, zoom));
      shell.scrollLeft = 0;
      shell.scrollTop = 0;
    }

function openPhotoEditor(photo) {
      if (!photo || isPdfAttachment(photo)) return;
      const image = new Image();
      image.onload = () => {
        const canvas = $("photoEditorCanvas");
        canvas.width = Math.max(1, image.naturalWidth);
        canvas.height = Math.max(1, image.naturalHeight);
        state.photoEditor = {
          photoId: photo.id,
          image,
          strokes: [],
          texts: [],
          history: [],
          selectedTextId: "",
          textInteraction: null,
          textControlBefore: null,
          textDraftActive: false,
          toolReturnMode: "draw",
          cropRect: null,
          cropInteraction: null,
          mode: "draw",
          activeStroke: null,
          zoom: 100,
          pointers: new Map(),
          pinch: null,
          pinchFrame: 0,
          pendingPinch: null,
          pan: null,
          panFrame: 0,
          pendingPan: null,
          gestureUsed: false
        };
        $("photoEditorText").value = "";
        $("photoEditorSize").value = "2";
        $("photoEditorTextSize").value = "32";
        $("photoEditorTextRotation").value = "0";
        $("photoEditorTitle").textContent = "Uredi fotografijo";
        setPhotoEditorTextSelection();
        redrawPhotoEditor();
        $("photoEditorDialog").showModal();
        requestAnimationFrame(fitPhotoEditorZoom);
      };
      image.onerror = () => showNotice("Slike ni bilo mogoče odpreti v urejevalniku.");
      image.src = attachmentSource(photo);
    }

function finishPhotoEditorStroke() {
      const editor = state.photoEditor;
      if (!editor?.activeStroke) return;
      const stroke = editor.activeStroke;
      editor.strokes.push(stroke);
      photoEditorHistoryPush({ type: "stroke", stroke });
      editor.activeStroke = null;
    }

function addPhotoEditorText() {
      const editor = state.photoEditor;
      const value = $("photoEditorText").value.trim();
      if (!editor || !value) {
        showNotice("Najprej vpi\u0161i besedilo, ki ga \u017eeli\u0161 dodati na sliko.");
        return;
      }
      const point = photoEditorVisiblePoint();
      $("photoEditorText").blur();
      const text = {
        id: "photo-text-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        text: value,
        x: point.x,
        y: point.y,
        size: Number($("photoEditorTextSize").value) || 32,
        color: $("photoEditorColor").value,
        rotation: 0
      };
      editor.texts.push(text);
      photoEditorHistoryPush({ type: "text-add", id: text.id });
      editor.mode = "text";
      editor.textDraftActive = false;
      editor.toolReturnMode = "draw";
      setPhotoEditorTextSelection(text.id);
      redrawPhotoEditor();
    }

function cancelPhotoEditorTextEntry() {
      const editor = state.photoEditor;
      if (!editor) return;
      editor.selectedTextId = "";
      editor.textDraftActive = false;
      editor.mode = photoEditorReturnMode(editor);
      editor.toolReturnMode = "draw";
      $("photoEditorText").value = "";
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
    }

function openPhotoEditorTextEntry() {
      const editor = state.photoEditor;
      if (!editor || photoEditorHasPendingOperation(editor)) return;
      finishPhotoEditorStroke();
      editor.toolReturnMode = editor.mode === "pan" ? "pan" : "draw";
      editor.mode = "text";
      editor.cropRect = null;
      editor.cropInteraction = null;
      editor.selectedTextId = "";
      editor.textDraftActive = true;
      const canvas = $("photoEditorCanvas");
      const scale = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
      $("photoEditorTextSize").value = Math.round(Math.max(16, Math.min(512, moduleValues.appConfig.editor.photoTextPixels * scale)));
      $("photoEditorText").value = "";
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
      requestAnimationFrame(() => $("photoEditorText").focus({ preventScroll: true }));
    }

function confirmPhotoEditorPendingOperation() {
      const editor = state.photoEditor;
      if (!editor) return;
      if (editor.mode === "crop") {
        applyPhotoEditorCrop();
        return;
      }
      if (editor.textDraftActive) addPhotoEditorText();
    }

function cancelPhotoEditorPendingOperation() {
      const editor = state.photoEditor;
      if (!editor) return;
      if (editor.mode === "crop") {
        cancelPhotoEditorCrop();
        return;
      }
      if (editor.textDraftActive) cancelPhotoEditorTextEntry();
    }

function enterPhotoEditorCropMode() {
      const editor = state.photoEditor;
      if (!editor || photoEditorHasPendingOperation(editor)) return;
      finishPhotoEditorStroke();
      editor.toolReturnMode = editor.mode === "pan" ? "pan" : "draw";
      editor.mode = "crop";
      editor.textDraftActive = false;
      editor.cropInteraction = null;
      editor.cropRect = editor.cropRect || defaultPhotoEditorCropRect();
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
    }

function cancelPhotoEditorCrop() {
      const editor = state.photoEditor;
      if (!editor) return;
      editor.cropRect = null;
      editor.cropInteraction = null;
      editor.mode = photoEditorReturnMode(editor);
      editor.toolReturnMode = "draw";
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
    }

function copyPhotoEditorCanvas(canvas) {
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext("2d").drawImage(canvas, 0, 0);
      return copy;
    }

function applyPhotoEditorCrop() {
      const editor = state.photoEditor;
      const canvas = $("photoEditorCanvas");
      if (!editor?.cropRect) return;
      const returnMode = photoEditorReturnMode(editor);
      finishPhotoEditorStroke();
      const crop = normalizePhotoEditorCropRect(editor.cropRect);
      editor.cropRect = null;
      redrawPhotoEditor({ includeSelection: false });
      const beforeImage = copyPhotoEditorCanvas(canvas);
      const output = document.createElement("canvas");
      output.width = Math.max(1, Math.round(crop.width));
      output.height = Math.max(1, Math.round(crop.height));
      output.getContext("2d").drawImage(beforeImage, crop.x, crop.y, crop.width, crop.height, 0, 0, output.width, output.height);
      photoEditorHistoryPush({ type: "crop", beforeImage });
      canvas.width = output.width;
      canvas.height = output.height;
      editor.image = output;
      editor.strokes = [];
      editor.texts = [];
      editor.selectedTextId = "";
      editor.textDraftActive = false;
      editor.cropInteraction = null;
      editor.mode = returnMode;
      editor.toolReturnMode = "draw";
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
      requestAnimationFrame(fitPhotoEditorZoom);
    }

function rotatePhotoEditor(direction) {
      const editor = state.photoEditor;
      const canvas = $("photoEditorCanvas");
      if (!editor) return;
      if (photoEditorHasPendingOperation(editor)) {
        showNotice("Najprej potrdi ali povrni trenutno spremembo slike.");
        return;
      }
      // Rotation is deliberately a raster operation: the original image,
      // annotations and captions turn together, so what the user sees is
      // exactly what is subsequently saved as the attachment.
      const turn = Number(direction) < 0 ? -1 : 1;
      const returnMode = editor.mode === "pan" ? "pan" : "draw";
      finishPhotoEditorStroke();
      redrawPhotoEditor({ includeSelection: false });
      const beforeImage = copyPhotoEditorCanvas(canvas);
      const output = document.createElement("canvas");
      output.width = beforeImage.height;
      output.height = beforeImage.width;
      const context = output.getContext("2d");
      if (turn > 0) {
        context.translate(output.width, 0);
        context.rotate(Math.PI / 2);
      } else {
        context.translate(0, output.height);
        context.rotate(-Math.PI / 2);
      }
      context.drawImage(beforeImage, 0, 0);
      photoEditorHistoryPush({ type: "rotate", beforeImage });
      canvas.width = output.width;
      canvas.height = output.height;
      editor.image = output;
      editor.strokes = [];
      editor.texts = [];
      editor.selectedTextId = "";
      editor.textDraftActive = false;
      editor.cropRect = null;
      editor.cropInteraction = null;
      editor.mode = returnMode;
      editor.toolReturnMode = "draw";
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
      showNotice(`Slika je zasukana ${turn < 0 ? "levo" : "desno"}. Za shranitev klikni ✓.`);
      requestAnimationFrame(fitPhotoEditorZoom);
    }

function undoPhotoEditorAction() {
      const editor = state.photoEditor;
      if (!editor) return;
      finishPhotoEditorStroke();
      const action = editor.history.pop();
      if (!action) return;
      if (action.type === "stroke") {
        const lastStroke = editor.strokes[editor.strokes.length - 1];
        if (lastStroke === action.stroke) editor.strokes.pop();
        else editor.strokes = editor.strokes.filter((stroke) => stroke !== action.stroke);
      }
      if (action.type === "text-add") {
        editor.texts = editor.texts.filter((text) => text.id !== action.id);
        if (editor.selectedTextId === action.id) setPhotoEditorTextSelection();
      }
      if (action.type === "text-update") {
        const text = editor.texts.find((entry) => entry.id === action.id);
        if (text) Object.assign(text, action.before);
        setPhotoEditorTextSelection(action.id);
      }
      if (action.type === "text-remove") {
        editor.texts.push(action.text);
        setPhotoEditorTextSelection(action.text.id);
      }
      if (action.type === "clear") {
        editor.strokes = action.strokes;
        editor.texts = action.texts;
        setPhotoEditorTextSelection(action.selectedTextId);
      }
      if (action.type === "crop" || action.type === "rotate") {
        const canvas = $("photoEditorCanvas");
        canvas.width = action.beforeImage.width;
        canvas.height = action.beforeImage.height;
        editor.image = action.beforeImage;
        editor.strokes = [];
        editor.texts = [];
        editor.cropRect = null;
        editor.cropInteraction = null;
        editor.mode = "draw";
        editor.textDraftActive = false;
        setPhotoEditorTextSelection();
        requestAnimationFrame(fitPhotoEditorZoom);
      }
      redrawPhotoEditor();
    }

function savePhotoEditor() {
      const editor = state.photoEditor;
      if (!editor) return;
      if (photoEditorHasPendingOperation(editor)) {
        showNotice("Najprej potrdi ali povrni trenutno spremembo slike.");
        return;
      }
      finishPhotoEditorStroke();
      redrawPhotoEditor({ includeSelection: false });
      const data = canvasAsLimitedJpegDataUrl($("photoEditorCanvas"));
      const nextPhotos = state.todoDialogPhotos.map((photo) => photo.id === editor.photoId
        // The old server thumbnail still points at the unedited attachment.
        // Clear it while the form holds the new local JPEG, otherwise the
        // photo list can appear unchanged even though the editor saved the
        // rotated pixels correctly.
        ? { ...photo, data, thumbnailData: "", thumbnailUrl: "" }
        : photo);
      if (todoAttachmentsDataLength(nextPhotos) > 4_800_000) {
        redrawPhotoEditor();
        showNotice("Priloge so skupaj prevelike. Odstrani katero od njih.");
        return;
      }
      state.todoDialogPhotos = nextPhotos;
      renderTodoFormPhotos();
      $("photoEditorDialog").close();
    }

function renderTodoPhotoHtml(todo) {
      if (!(todo.photos || []).length) return "";
      return `<div class="todo-photos-inline">${todo.photos.map((photo) => {
        const label = attachmentLabel(photo);
        const name = attachmentDisplayName(photo);
        const thumbnail = !isPdfAttachment(photo) && !isVideoAttachment(photo) ? attachmentThumbnailSource(photo) : "";
        const media = `<button class="todo-image-preview" type="button" data-photo-id="${escapeHtml(photo.id)}" aria-label="Odpri prilogo ${escapeHtml(name)}">${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="">` : attachmentSymbolMarkup(photo)}</button>`;
        return `<article class="photo-card">
          ${media}
          <div>
            <strong>${escapeHtml(name)}</strong>
            <span class="todo-meta">${escapeHtml(label)}</span>
            ${photo.comment ? `<span class="todo-meta">${escapeHtml(photo.comment)}</span>` : ""}
          </div>
        </article>`;
      }).join("")}</div>`;
    }

function beginPhotoEditorTextControlChange() {
      const editor = state.photoEditor;
      const text = selectedPhotoEditorText();
      if (editor && text) editor.textControlBefore = photoEditorTextSnapshot(text);
    }

function commitPhotoEditorTextControlChange() {
      const editor = state.photoEditor;
      const text = selectedPhotoEditorText();
      if (!editor || !text) return;
      rememberPhotoEditorTextChange(text, editor.textControlBefore);
      editor.textControlBefore = null;
      setPhotoEditorTextSelection(text.id);
      redrawPhotoEditor();
    }

function updateSelectedPhotoEditorTextFromControls() {
      const text = selectedPhotoEditorText();
      if (!text) return;
      text.text = $("photoEditorText").value.slice(0, 500);
      text.size = Number($("photoEditorTextSize").value) || 32;
      text.rotation = Number($("photoEditorTextRotation").value) || 0;
      text.color = $("photoEditorColor").value;
      redrawPhotoEditor();
    }

function changePhotoEditorTextSize(delta) {
      const text = selectedPhotoEditorText();
      if (!text) return;
      const before = photoEditorTextSnapshot(text);
      text.size = Math.max(12, Math.min(512, text.size + delta));
      $("photoEditorTextSize").value = Math.round(text.size);
      rememberPhotoEditorTextChange(text, before);
      redrawPhotoEditor();
    }

function finishPhotoEditorPointer(event, cancelled = false) {
      const editor = state.photoEditor;
      if (!editor) return;
      const shell = $("photoEditorCanvas").closest(".photo-editor-canvas-shell");
      if (editor.pan?.pointerId === event.pointerId) {
        if (editor.panFrame) cancelAnimationFrame(editor.panFrame);
        editor.panFrame = 0;
        flushPhotoEditorPan(editor);
        editor.pan = null;
        shell.classList.remove("is-panning");
      }
      const cropInteraction = editor.cropInteraction;
      if (cropInteraction?.pointerId === event.pointerId) {
        if (cancelled && cropInteraction.before) editor.cropRect = { ...cropInteraction.before };
        editor.cropInteraction = null;
        redrawPhotoEditor();
      }
      const interaction = editor.textInteraction;
      if (interaction?.pointerId === event.pointerId) {
        const text = selectedPhotoEditorText();
        if (text && cancelled) Object.assign(text, interaction.before);
        if (text && !cancelled && interaction.moved) rememberPhotoEditorTextChange(text, interaction.before);
        editor.textInteraction = null;
        setPhotoEditorTextSelection(text?.id || "");
        redrawPhotoEditor();
      }
      if (!cancelled && !editor.gestureUsed && editor.activeStroke?.pointerId === event.pointerId) finishPhotoEditorStroke();
      if (cancelled && editor.activeStroke?.pointerId === event.pointerId) {
        editor.activeStroke = null;
        redrawPhotoEditor();
      }
      editor.pointers.delete(event.pointerId);
      if (editor.pointers.size < 2) {
        if (editor.pinchFrame) cancelAnimationFrame(editor.pinchFrame);
        editor.pinchFrame = 0;
        editor.pendingPinch = null;
        editor.pinch = null;
      }
      if (!editor.pan) {
        if (editor.panFrame) cancelAnimationFrame(editor.panFrame);
        editor.panFrame = 0;
        editor.pendingPan = null;
      }
      if (!editor.pointers.size) {
        editor.gestureUsed = false;
        shell.classList.remove("is-panning");
      }
    }

function requestPhotoEditorClose() {
      const editor = state.photoEditor;
      if (photoEditorHasPendingOperation(editor)) {
        cancelPhotoEditorPendingOperation();
        return;
      }
      $("photoEditorDialog").close();
    }

function finishAttachmentPreviewPointer(event) {
      const preview = state.attachmentPreview;
      if (!preview) return;
      if (preview.gestureFrame) cancelAnimationFrame(preview.gestureFrame);
      preview.gestureFrame = 0;
      flushAttachmentPreviewGesture(preview);
      preview.pointers.delete(event.pointerId);
      preview.pendingGesture = null;
      const remaining = [...preview.pointers.entries()][0];
      if (remaining) {
        preview.gesture = { type: "pan", pointerId: remaining[0], lastX: remaining[1].x, lastY: remaining[1].y };
      } else {
        preview.gesture = null;
        moduleValues.attachmentPreviewBody.classList.remove("is-panning");
      }
    }

function installMediaPreviewBindings1() {
    $("photoEditorCanvas").addEventListener("pointerdown", (event) => {
      const editor = state.photoEditor;
      if (!editor) return;
      event.preventDefault();
      const canvas = event.currentTarget;
      const shell = canvas.closest(".photo-editor-canvas-shell");
      canvas.setPointerCapture(event.pointerId);
      editor.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pointerType: event.pointerType });
      if (photoEditorTouchPinchMetrics(editor)) {
        if (!editor.pinch) beginPhotoEditorPinch(editor, shell);
        return;
      }
      if (editor.gestureUsed) return;
      if (editor.mode === "pan") {
        editor.pan = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
        shell.classList.add("is-panning");
        return;
      }
      const point = photoEditorPoint(event);
      if (editor.mode === "crop") {
        const hit = photoEditorCropHitTest(point);
        const currentCrop = editor.cropRect || defaultPhotoEditorCropRect();
        if (hit.action === "new") editor.cropRect = normalizePhotoEditorCropRect({ x: point.x, y: point.y, width: photoEditorCropMinimum(), height: photoEditorCropMinimum() });
        editor.cropInteraction = {
          pointerId: event.pointerId,
          action: hit.action,
          start: point,
          before: { ...(editor.cropRect || currentCrop) }
        };
        redrawPhotoEditor();
        return;
      }
      const hit = photoEditorTextHitTest(point);
      if (hit) {
        editor.mode = "text";
        setPhotoEditorTextSelection(hit.text.id);
        editor.textInteraction = {
          pointerId: event.pointerId,
          type: hit.action,
          before: photoEditorTextSnapshot(hit.text),
          offsetX: point.x - hit.text.x,
          offsetY: point.y - hit.text.y,
          moved: false
        };
        redrawPhotoEditor();
        return;
      }
      if (editor.mode === "text") {
        setPhotoEditorTextSelection();
        redrawPhotoEditor();
        return;
      }
      setPhotoEditorTextSelection();
      editor.activeStroke = {
        pointerId: event.pointerId,
        color: $("photoEditorColor").value,
        // The control describes visible pixels, not invisible fractions of
        // a pixel when a full-resolution photo is fitted on a phone.
        size: Math.max(moduleValues.appConfig.editor.photoBrushPixels, Number($("photoEditorSize").value)) * canvas.width / Math.max(1, canvas.getBoundingClientRect().width),
        points: [point]
      };
      drawPhotoEditorStroke(canvas.getContext("2d"), editor.activeStroke);
    });
    $("photoEditorCanvas").addEventListener("pointermove", (event) => {
      const editor = state.photoEditor;
      if (!editor?.pointers.has(event.pointerId)) return;
      event.preventDefault();
      editor.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pointerType: event.pointerType });
      const pinchMetrics = photoEditorTouchPinchMetrics(editor);
      if (editor.pinch && pinchMetrics) {
        queuePhotoEditorPinch(pinchMetrics);
        return;
      }
      const cropInteraction = editor.cropInteraction;
      if (cropInteraction?.pointerId === event.pointerId) {
        updatePhotoEditorCropInteraction(photoEditorPoint(event));
        redrawPhotoEditor();
        return;
      }
      const pan = editor.pan;
      if (pan?.pointerId === event.pointerId) {
        queuePhotoEditorPan(editor, { pointerId: event.pointerId, x: event.clientX, y: event.clientY });
        return;
      }
      const interaction = editor.textInteraction;
      if (interaction?.pointerId === event.pointerId && !editor.gestureUsed) {
        const text = selectedPhotoEditorText();
        if (!text) return;
        const point = photoEditorPoint(event);
        if (interaction.type === "move") {
          text.x = Math.max(0, Math.min($("photoEditorCanvas").width, point.x - interaction.offsetX));
          text.y = Math.max(0, Math.min($("photoEditorCanvas").height, point.y - interaction.offsetY));
        } else {
          const angle = Math.atan2(point.y - text.y, point.x - text.x) * 180 / Math.PI + 90;
          text.rotation = ((angle + 180) % 360 + 360) % 360 - 180;
          $("photoEditorTextRotation").value = Math.round(text.rotation);
        }
        interaction.moved = true;
        redrawPhotoEditor();
        return;
      }
      const stroke = editor.activeStroke;
      if (!stroke || stroke.pointerId !== event.pointerId || editor.gestureUsed) return;
      stroke.points.push(photoEditorPoint(event));
      drawPhotoEditorStroke(event.currentTarget.getContext("2d"), { ...stroke, points: stroke.points.slice(-2) });
    });
    $("photoEditorCanvas").addEventListener("pointerup", (event) => {
      event.preventDefault();
      finishPhotoEditorPointer(event);
    });
    $("photoEditorCanvas").addEventListener("pointercancel", (event) => finishPhotoEditorPointer(event, true));
    $("photoEditorCanvas").addEventListener("lostpointercapture", (event) => finishPhotoEditorPointer(event, true));
    $("photoEditorCanvas").closest(".photo-editor-canvas-shell").addEventListener("wheel", (event) => {
      const editor = state.photoEditor;
      if (!editor || !event.ctrlKey) return;
      event.preventDefault();
      setPhotoEditorZoom(editor.zoom * Math.exp(-event.deltaY * 0.002), { x: event.clientX, y: event.clientY });
    }, { passive: false });
    $("photoEditorDraw").addEventListener("click", () => {
      if (!state.photoEditor) return;
      state.photoEditor.mode = "draw";
      state.photoEditor.cropRect = null;
      state.photoEditor.cropInteraction = null;
      state.photoEditor.textDraftActive = false;
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
    });
    $("photoEditorPan").addEventListener("click", () => {
      if (!state.photoEditor) return;
      state.photoEditor.mode = "pan";
      state.photoEditor.cropRect = null;
      state.photoEditor.cropInteraction = null;
      state.photoEditor.textDraftActive = false;
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
    });
    $("photoEditorCrop").addEventListener("click", enterPhotoEditorCropMode);
    $("photoEditorRotateLeft").addEventListener("click", () => rotatePhotoEditor(-1));
    $("photoEditorRotateRight").addEventListener("click", () => rotatePhotoEditor(1));
    $("photoEditorAddText").addEventListener("click", openPhotoEditorTextEntry);
    $("photoEditorConfirmPending").addEventListener("click", confirmPhotoEditorPendingOperation);
    $("photoEditorCancelPending").addEventListener("click", cancelPhotoEditorPendingOperation);
    $("photoEditorText").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing || !state.photoEditor?.textDraftActive) return;
      event.preventDefault();
      confirmPhotoEditorPendingOperation();
    });
    $("photoEditorTextSmaller").addEventListener("click", () => changePhotoEditorTextSize(-Math.max(2, Math.round((selectedPhotoEditorText()?.size || 32) * .1))));
    $("photoEditorTextLarger").addEventListener("click", () => changePhotoEditorTextSize(Math.max(2, Math.round((selectedPhotoEditorText()?.size || 32) * .1))));
    $("photoEditorFinishText").addEventListener("click", () => {
      commitPhotoEditorTextControlChange();
      $("photoEditorText").blur();
      if (state.photoEditor) { state.photoEditor.mode = "text"; setPhotoEditorTextSelection(); redrawPhotoEditor(); }
    });
    $("photoEditorDeleteText").addEventListener("click", () => {
      const editor = state.photoEditor;
      const text = selectedPhotoEditorText();
      if (!editor || !text) return;
      photoEditorHistoryPush({ type: "text-remove", text: photoEditorTextSnapshot(text) });
      editor.texts = editor.texts.filter((entry) => entry.id !== text.id);
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
    });
    ["photoEditorText", "photoEditorTextSize", "photoEditorTextRotation", "photoEditorColor"].forEach((id) => {
      $(id).addEventListener("focus", beginPhotoEditorTextControlChange);
      $(id).addEventListener("pointerdown", beginPhotoEditorTextControlChange);
    });
    ["photoEditorText", "photoEditorTextSize", "photoEditorTextRotation", "photoEditorColor"].forEach((id) => {
      $(id).addEventListener("input", updateSelectedPhotoEditorTextFromControls);
      $(id).addEventListener("change", commitPhotoEditorTextControlChange);
    });
    $("photoEditorUndo").addEventListener("click", () => {
      undoPhotoEditorAction();
    });
    $("photoEditorZoomOut").addEventListener("click", () => {
      const shell = $("photoEditorCanvas").closest(".photo-editor-canvas-shell");
      setPhotoEditorZoom((state.photoEditor?.zoom || 100) / 1.25, scrollerViewportCenter(shell));
    });
    $("photoEditorZoomIn").addEventListener("click", () => {
      const shell = $("photoEditorCanvas").closest(".photo-editor-canvas-shell");
      setPhotoEditorZoom((state.photoEditor?.zoom || 100) * 1.25, scrollerViewportCenter(shell));
    });
    $("photoEditorFit").addEventListener("click", fitPhotoEditorZoom);
    $("photoEditorClear").addEventListener("click", () => {
      const editor = state.photoEditor;
      if (!editor || (!(editor.strokes || []).length && !(editor.texts || []).length)) return;
      finishPhotoEditorStroke();
      photoEditorHistoryPush({
        type: "clear",
        strokes: editor.strokes.slice(),
        texts: editor.texts.map(photoEditorTextSnapshot),
        selectedTextId: editor.selectedTextId
      });
      editor.strokes = [];
      editor.texts = [];
      editor.mode = "draw";
      setPhotoEditorTextSelection();
      redrawPhotoEditor();
    });
    $("photoEditorSave").addEventListener("click", () => {
      try {
        savePhotoEditor();
      } catch (error) {
        showNotice(error.message);
      }
    });
    $("photoEditorDialog").addEventListener("close", () => {
      const editor = state.photoEditor;
      if (editor?.pinchFrame) cancelAnimationFrame(editor.pinchFrame);
      if (editor?.panFrame) cancelAnimationFrame(editor.panFrame);
      state.photoEditor = null;
      const canvas = $("photoEditorCanvas");
      canvas.width = 1;
      canvas.height = 1;
      canvas.style.width = "";
      const shell = canvas.closest(".photo-editor-canvas-shell");
      shell.scrollLeft = 0;
      shell.scrollTop = 0;
      $("photoEditorZoomValue").textContent = "100 %";
      $("photoEditorTextTools").hidden = true;
      $("photoEditorTextEditor").hidden = true;
      $("photoEditorPendingActions").hidden = true;
      shell.classList.remove("is-text-editing", "is-pan-mode", "is-crop-mode", "is-panning");
    });
    $("photoEditorClose").addEventListener("click", requestPhotoEditorClose);
    $("photoEditorDialog").addEventListener("cancel", (event) => {
      if (!photoEditorHasPendingOperation()) return;
      event.preventDefault();
      cancelPhotoEditorPendingOperation();
    });
    $("photoEditorDialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) requestPhotoEditorClose();
    });
    $("attachmentPreviewZoomOut").addEventListener("click", () => {
      const body = $("attachmentPreviewImage").closest(".attachment-preview-body");
      setAttachmentPreviewZoom((state.attachmentPreview?.zoom || 100) / 1.25, scrollerViewportCenter(body));
    });
    $("attachmentPreviewZoomIn").addEventListener("click", () => {
      const body = $("attachmentPreviewImage").closest(".attachment-preview-body");
      setAttachmentPreviewZoom((state.attachmentPreview?.zoom || 100) * 1.25, scrollerViewportCenter(body));
    });
    $("attachmentPreviewFit").addEventListener("click", fitAttachmentPreview);
    $("attachmentPreviewPrevious").addEventListener("click", () => moveAttachmentPreview(-1));
    $("attachmentPreviewNext").addEventListener("click", () => moveAttachmentPreview(1));
}

function installMediaPreviewBindings2() {
    moduleValues.attachmentPreviewBody.addEventListener("pointerdown", (event) => {
      const preview = state.attachmentPreview;
      if (!preview || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      moduleValues.attachmentPreviewBody.setPointerCapture(event.pointerId);
      if (preview.gestureFrame) cancelAnimationFrame(preview.gestureFrame);
      preview.gestureFrame = 0;
      flushAttachmentPreviewGesture(preview);
      preview.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      moduleValues.attachmentPreviewBody.classList.add("is-panning");
      if (preview.pointers.size >= 2) {
        const metrics = pointerGestureMetrics(preview.pointers);
        preview.pendingGesture = null;
        preview.gesture = metrics ? { type: "pinch", lastDistance: metrics.distance, lastCenter: metrics.center } : null;
      } else {
        preview.gesture = { type: "pan", pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
      }
    });
    moduleValues.attachmentPreviewBody.addEventListener("pointermove", (event) => {
      const preview = state.attachmentPreview;
      if (!preview?.pointers.has(event.pointerId)) return;
      event.preventDefault();
      preview.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (preview.pointers.size >= 2) {
        const metrics = pointerGestureMetrics(preview.pointers);
        if (!metrics) return;
        if (preview.gesture?.type !== "pinch") {
          preview.gesture = { type: "pinch", lastDistance: metrics.distance, lastCenter: metrics.center };
          return;
        }
        queueAttachmentPreviewGesture(preview, { type: "pinch", metrics });
        return;
      }
      const gesture = preview.gesture;
      if (gesture?.type !== "pan" || gesture.pointerId !== event.pointerId) return;
      queueAttachmentPreviewGesture(preview, { type: "pan", pointerId: event.pointerId, x: event.clientX, y: event.clientY });
    });
    moduleValues.attachmentPreviewBody.addEventListener("pointerup", finishAttachmentPreviewPointer);
    moduleValues.attachmentPreviewBody.addEventListener("pointercancel", finishAttachmentPreviewPointer);
    moduleValues.attachmentPreviewBody.addEventListener("lostpointercapture", finishAttachmentPreviewPointer);
    $("attachmentPreviewEdit").addEventListener("click", async () => {
      const preview = state.attachmentPreview;
      if (!preview?.photo) return;
      try {
        $("attachmentPreviewDialog").close();
        if (!$("todoDialog").open) {
          const todo = state.todos.find((item) => item.id === preview.todoId);
          if (!todo) return;
          await openTodoDialog(todo);
        }
        if (!$("todoDialog").open) return;
        const photo = state.todoDialogPhotos.find((item) => item.id === preview.photo.id);
        if (photo) openPhotoEditor(photo);
      } catch (error) {
        showNotice(error.message);
      }
    });
    $("attachmentPreviewDialog").addEventListener("close", () => {
      const preview = state.attachmentPreview;
      if (preview?.gestureFrame) cancelAnimationFrame(preview.gestureFrame);
      const image = $("attachmentPreviewImage");
      image.removeAttribute("src");
      image.style.width = "";
      state.attachmentPreview = null;
      const body = image.closest(".attachment-preview-body");
      body.scrollLeft = 0;
      body.scrollTop = 0;
      body.classList.remove("is-panning");
    });
    $("attachmentPreviewDialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    });
}

  return {
    attachmentSource,
    attachmentThumbnailSource,
    isPdfAttachment,
    isVideoAttachment,
    attachmentLabel,
    attachmentDisplayName,
    attachmentSymbolMarkup,
    openAttachmentPreview,
    openPhotoEditor,
    renderTodoPhotoHtml,
    installMediaPreviewBindings1,
    installMediaPreviewBindings2
  };
}
