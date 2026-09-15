// editor/media-codec: explicit dependencies; factory creation has no I/O or UI effects.
function createMediaCodec({
  state,
  createLocalUuid,
  moduleValues
}) {
function readImageAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Slike ni bilo mogoče prebrati."));
        reader.readAsDataURL(file);
      });
    }

function canvasAsLimitedJpegDataUrl(canvas, maxLength = 680_000) {
      const targets = [1280, 1024, 800, 640];
      const qualities = [0.82, 0.72, 0.62, 0.52, 0.42];
      const maxSide = Math.max(canvas.width, canvas.height);
      let lastData = "";
      for (const target of targets) {
        const scale = Math.min(1, target / maxSide);
        let output = canvas;
        if (scale < 1) {
          output = document.createElement("canvas");
          output.width = Math.max(1, Math.round(canvas.width * scale));
          output.height = Math.max(1, Math.round(canvas.height * scale));
          const context = output.getContext("2d");
          context.drawImage(canvas, 0, 0, output.width, output.height);
        }
        for (const quality of qualities) {
          lastData = output.toDataURL("image/jpeg", quality);
          if (lastData.length <= maxLength) return lastData;
        }
      }
      throw new Error("Urejena slika je prevelika.");
    }

function isSupportedImageFile(file) {
      const type = String(file?.type || "").toLowerCase();
      const name = String(file?.name || "");
      return type.startsWith("image/") || /\.(?:jpe?g|png|webp)$/i.test(name);
    }

function imageLoadError(file) {
      const type = String(file?.type || "").toLowerCase();
      const name = String(file?.name || "");
      if (type === "image/heic" || type === "image/heif" || /\.hei[cf]$/i.test(name)) {
        return new Error("Fotografija je v formatu HEIC/HEIF, ki ga ta brskalnik ne podpira. Izberi JPG, PNG ali WEBP.");
      }
      return new Error("Slike ni bilo mogoče odpreti. Poskusi znova ali izberi JPG, PNG oziroma WEBP.");
    }

function resizeImageAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        if (!isSupportedImageFile(file)) {
          reject(new Error("Izberi slikovno datoteko."));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const image = new Image();
          image.onload = () => {
            const maxSide = 1280;
            const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve({
              id: createLocalUuid(),
              name: file.name,
              data: canvasAsLimitedJpegDataUrl(canvas),
              createdBy: state.user?.id || "",
              createdByName: state.user?.name || "",
              createdAt: new Date().toISOString()
            });
          };
          image.onerror = () => reject(imageLoadError(file));
          image.src = reader.result;
        };
        reader.onerror = () => reject(new Error("Slike ni bilo mogoče prebrati."));
        reader.readAsDataURL(file);
      });
    }

function readFileAsDataUrl(file, errorMessage) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(errorMessage));
        reader.readAsDataURL(file);
      });
    }

async function loadPdfJs() {
      if (!moduleValues.pdfJsModulePromise) {
        moduleValues.pdfJsModulePromise = import("/vendor/pdfjs/build/pdf.min.mjs").then((pdfjs) => {
          pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs";
          return pdfjs;
        });
      }
      return moduleValues.pdfJsModulePromise;
    }

async function createPdfThumbnail(data) {
      const pdfjs = await loadPdfJs();
      const encoded = String(data || "").split(",", 2)[1] || "";
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const loadingTask = pdfjs.getDocument({
        data: bytes,
        isEvalSupported: false,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        wasmUrl: "/vendor/pdfjs/wasm/"
      });
      let pdfDocument = null;
      try {
        pdfDocument = await loadingTask.promise;
        const page = await pdfDocument.getPage(1);
        const original = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 320 / Math.max(1, original.width), 420 / Math.max(1, original.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const context = canvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport, background: "#ffffff" }).promise;
        return canvasAsLimitedJpegDataUrl(canvas, 95_000);
      } finally {
        if (pdfDocument) await pdfDocument.destroy();
      }
    }

async function createPdfThumbnailSafely(data) {
      try {
        return await createPdfThumbnail(data);
      } catch (error) {
        console.warn("PDF thumbnail ni bil ustvarjen:", error);
        return "";
      }
    }

async function todoAttachmentFromFile(file) {
      const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (pdf) {
        if (file.size > 1_500_000) throw new Error("PDF je prevelik. Največja dovoljena velikost je 1,5 MB.");
        let data = await readFileAsDataUrl(file, "PDF datoteke ni bilo mogoče prebrati.");
        data = data.replace(/^data:[^;]*;base64,/, "data:application/pdf;base64,");
        const thumbnailData = await createPdfThumbnailSafely(data);
        return {
          id: createLocalUuid(),
          name: file.name || "priloga.pdf",
          data,
          thumbnailData,
          createdBy: state.user?.id || "",
          createdByName: state.user?.name || "",
          createdAt: new Date().toISOString()
        };
      }
      if (isSupportedImageFile(file)) return resizeImageAsDataUrl(file);
      throw new Error("Izberi sliko ali PDF datoteko.");
    }

function todoAttachmentsDataLength(items) {
      return items.reduce((total, item) => total + String(item.data || "").length, 0);
    }

  return {
    readImageAsDataUrl,
    canvasAsLimitedJpegDataUrl,
    isSupportedImageFile,
    createPdfThumbnailSafely,
    todoAttachmentFromFile,
    todoAttachmentsDataLength
  };
}
