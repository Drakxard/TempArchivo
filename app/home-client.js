"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

const EMPTY_STATUS = { kind: "idle", message: "" };
const MAX_UPLOAD_EDGE = 2000;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const HOVER_COPY_COOLDOWN_MS = 2000;

export default function HomeClient({ initialContent }) {
  const fileInputRef = useRef(null);
  const mobilePasteRef = useRef(null);
  const pendingImageUrlRef = useRef(null);
  const cachedImageBlobRef = useRef(null);
  const cachedImageVersionRef = useRef(null);
  const imagePrefetchPromiseRef = useRef(null);
  const lastHoverCopyAtRef = useRef(0);
  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [isBusy, setIsBusy] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [isReplacingImage, setIsReplacingImage] = useState(false);
  const [pendingImageUrl, setPendingImageUrl] = useState(null);
  const [mobilePasteValue, setMobilePasteValue] = useState("");

  const hint = useMemo(() => {
    if (isTouchDevice) {
      return "Tocar para elegir imagen";
    }

    return "Ctrl+V o click para imagen";
  }, [isTouchDevice]);

  function clearPendingImage() {
    if (pendingImageUrlRef.current) {
      URL.revokeObjectURL(pendingImageUrlRef.current);
      pendingImageUrlRef.current = null;
    }

    setPendingImageUrl(null);
  }

  function clearCachedImageBlob() {
    cachedImageBlobRef.current = null;
    cachedImageVersionRef.current = null;
    imagePrefetchPromiseRef.current = null;
  }

  async function toClipboardPng(blob) {
    if (blob.type === "image/png") {
      return blob;
    }

    let bitmap;

    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      throw new Error("No se pudo preparar la imagen.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close?.();
      throw new Error("No canvas context.");
    }

    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    return new Promise((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
          return;
        }

        reject(new Error("No se pudo convertir la imagen."));
      }, "image/png");
    });
  }

  async function prepareUploadFile(file) {
    if (
      file.size <= MAX_UPLOAD_BYTES &&
      file.type !== "image/heic" &&
      file.type !== "image/heif"
    ) {
      return file;
    }

    let bitmap;

    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file;
    }

    const scale = Math.min(
      1,
      MAX_UPLOAD_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");

    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      bitmap.close?.();
      return file;
    }

    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const normalizedBlob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.82);
    });

    if (!normalizedBlob) {
      return file;
    }

    return new File([normalizedBlob], "upload.jpg", {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  }

  const handlePaste = useEffectEvent(async (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard) {
      return;
    }

    const imageItem = Array.from(clipboard.items).find((item) =>
      item.type.startsWith("image/"),
    );

    if (imageItem) {
      event.preventDefault();
      const file = imageItem.getAsFile();

      if (file) {
        await uploadImage(file);
      }

      return;
    }

    const pastedText = clipboard.getData("text/plain");
    if (!pastedText) {
      return;
    }

    event.preventDefault();
    await saveText(pastedText);
  });

  useEffect(() => {
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    const updateDeviceMode = () => {
      setIsTouchDevice(coarsePointer.matches || navigator.maxTouchPoints > 0);
    };

    updateDeviceMode();
    coarsePointer.addEventListener("change", updateDeviceMode);
    window.addEventListener("paste", handlePaste);

    return () => {
      coarsePointer.removeEventListener("change", updateDeviceMode);
      window.removeEventListener("paste", handlePaste);
      clearPendingImage();
      clearCachedImageBlob();
    };
  }, []);

  async function fetchCurrentImageBlob() {
    const response = await fetch("/api/content/image", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("No se pudo leer la imagen.");
    }

    return response.blob();
  }

  async function ensureCurrentImageBlob(forceRefresh = false) {
    const imageVersion =
      content?.type === "image" ? content.updatedAt || content.value : null;

    if (!imageVersion) {
      clearCachedImageBlob();
      throw new Error("No hay imagen para copiar.");
    }

    if (
      !forceRefresh &&
      cachedImageBlobRef.current &&
      cachedImageVersionRef.current === imageVersion
    ) {
      return cachedImageBlobRef.current;
    }

    if (
      !forceRefresh &&
      imagePrefetchPromiseRef.current &&
      cachedImageVersionRef.current === imageVersion
    ) {
      return imagePrefetchPromiseRef.current;
    }

    cachedImageVersionRef.current = imageVersion;
    imagePrefetchPromiseRef.current = fetchCurrentImageBlob()
      .then((blob) => {
        cachedImageBlobRef.current = blob;
        return blob;
      })
      .catch((error) => {
        if (cachedImageVersionRef.current === imageVersion) {
          clearCachedImageBlob();
        }

        throw error;
      })
      .finally(() => {
        imagePrefetchPromiseRef.current = null;
      });

    return imagePrefetchPromiseRef.current;
  }

  const prefetchImageForClipboard = useEffectEvent(async (forceRefresh = false) => {
    if (content?.type !== "image" || pendingImageUrlRef.current) {
      clearCachedImageBlob();
      return;
    }

    try {
      await ensureCurrentImageBlob(forceRefresh);
    } catch {
      // Warmup failure should not block the UI; copy flow handles errors explicitly.
    }
  });

  useEffect(() => {
    if (content?.type !== "image") {
      clearCachedImageBlob();
      return;
    }

    prefetchImageForClipboard();
  }, [content]);

  useEffect(() => {
    const warmClipboardImage = () => {
      if (document.visibilityState === "visible") {
        void prefetchImageForClipboard(true);
      }
    };

    document.addEventListener("visibilitychange", warmClipboardImage);
    window.addEventListener("focus", warmClipboardImage);

    return () => {
      document.removeEventListener("visibilitychange", warmClipboardImage);
      window.removeEventListener("focus", warmClipboardImage);
    };
  }, []);

  async function loadContent() {
    setIsBusy(true);

    try {
      const response = await fetch("/api/content", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("No se pudo cargar el contenido.");
      }

      const data = await response.json();
      setContent(data.content);
    } catch {
      setStatus({
        kind: "error",
        message: "No se pudo cargar el contenido actual.",
      });
    } finally {
      setIsBusy(false);
    }
  }

  async function saveText(value) {
    const text = value.trim();
    if (!text) {
      setStatus({
        kind: "error",
        message: "El texto pegado estaba vacio.",
      });
      return;
    }

    setIsBusy(true);
    clearPendingImage();
    clearCachedImageBlob();

    try {
      const response = await fetch("/api/content", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: "text", value: text }),
      });

      if (!response.ok) {
        throw new Error("No se pudo guardar el texto.");
      }

      const data = await response.json();
      setContent(data.content);
      setStatus({ kind: "success", message: "Texto cargado." });
    } catch {
      setStatus({ kind: "error", message: "No se pudo guardar el texto." });
    } finally {
      setIsBusy(false);
    }
  }

  async function uploadImage(file) {
    const previewUrl = URL.createObjectURL(file);

    setIsBusy(true);
    setIsReplacingImage(true);
    clearCachedImageBlob();
    pendingImageUrlRef.current = previewUrl;
    setPendingImageUrl(previewUrl);
    setStatus({ kind: "idle", message: "" });

    try {
      const uploadFile = await prepareUploadFile(file);
      const formData = new FormData();
      formData.append("file", uploadFile);

      const response = await fetch("/api/content", {
        method: "PUT",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("No se pudo guardar la imagen.");
      }

      const data = await response.json();
      setContent(data.content);
      clearPendingImage();
      setStatus({ kind: "success", message: "Imagen cargada." });
    } catch {
      clearPendingImage();
      await loadContent();
      setStatus({ kind: "error", message: "No se pudo guardar la imagen." });
    } finally {
      setIsReplacingImage(false);
      setIsBusy(false);
    }
  }

  async function copyCurrentContent() {
    if (!content) {
      return;
    }

    try {
      if (content.type === "text") {
        await navigator.clipboard.writeText(content.value);
        setStatus({ kind: "success", message: "Copiado." });
        return;
      }

      const blob = await ensureCurrentImageBlob();

      try {
        if (
          !navigator.clipboard?.write ||
          typeof window.ClipboardItem === "undefined"
        ) {
          throw new Error("Clipboard image write not supported.");
        }

        await navigator.clipboard.write([
          new window.ClipboardItem({
            [blob.type || "image/png"]: blob,
          }),
        ]);
        setStatus({ kind: "success", message: "Imagen copiada." });
        return;
      } catch {
        if (isTouchDevice) {
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");

          link.href = objectUrl;
          link.download = "temp-archivo.png";
          document.body.append(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(objectUrl);
          return;
        }

        const clipboardBlob = await toClipboardPng(blob);

        await navigator.clipboard.write([
          new window.ClipboardItem({
            "image/png": clipboardBlob,
          }),
        ]);
        setStatus({ kind: "success", message: "Imagen copiada." });
        return;
      }
    } catch {
      setStatus({
        kind: "error",
        message:
          content.type === "image"
            ? "No se pudo copiar la imagen."
            : "No se pudo copiar el texto.",
      });
    }
  }

  async function handleImageHoverCopy() {
    if (
      isTouchDevice ||
      isBusy ||
      !content ||
      content.type !== "image" ||
      pendingImageUrlRef.current
    ) {
      return;
    }

    const now = Date.now();
    if (now - lastHoverCopyAtRef.current < HOVER_COPY_COOLDOWN_MS) {
      return;
    }

    lastHoverCopyAtRef.current = now;
    await copyCurrentContent();
  }

  function openFilePicker() {
    if (isBusy) {
      return;
    }

    fileInputRef.current?.click();
  }

  async function onFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    await uploadImage(file);
  }

  async function onMobilePaste(event) {
    const pastedText = event.clipboardData?.getData("text/plain") || "";
    if (!pastedText) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setMobilePasteValue("");
    mobilePasteRef.current?.blur();
    await saveText(pastedText);
  }

  const displayedContent =
    pendingImageUrl && isReplacingImage
      ? { type: "image", value: pendingImageUrl, isPending: true }
      : content;

  return (
    <main className="page-shell">
      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="image/*"
        onChange={onFileChange}
      />

      <section className="stage">
        {!displayedContent ? (
          <button
            type="button"
            className={`empty-state ${isReplacingImage ? "is-loading" : ""}`}
            onClick={openFilePicker}
            disabled={isBusy}
            aria-label="Seleccionar imagen"
          >
            <span className="plus-mark">{isReplacingImage ? "" : "+"}</span>
            <span className="hint-text">
              {isReplacingImage ? "Subiendo imagen..." : hint}
            </span>
          </button>
        ) : (
          displayedContent.type === "image" ? (
            <div
              className={`content-card content-image ${
                displayedContent.isPending ? "is-uploading" : ""
              }`}
            >
              <button
                type="button"
                className="image-copy-button"
                onClick={copyCurrentContent}
                onPointerEnter={() => {
                  void handleImageHoverCopy();
                }}
                disabled={isBusy}
                aria-label="Copiar imagen al portapapeles"
              >
                <img
                  src={displayedContent.value}
                  alt="Contenido actual"
                  className="image-content"
                />
                {displayedContent.isPending ? (
                  <span className="image-overlay">Subiendo imagen...</span>
                ) : null}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={`content-card content-text ${
                displayedContent.isPending ? "is-uploading" : ""
              }`}
              onClick={copyCurrentContent}
              disabled={isBusy}
              aria-label="Copiar texto al portapapeles"
            >
              <p className="text-content">{displayedContent.value}</p>
            </button>
          )
        )}

        <div className="actions-row">
          <button
            type="button"
            className="ghost-action"
            onClick={openFilePicker}
            disabled={isBusy}
          >
            {displayedContent ? "Reemplazar con imagen" : "Elegir imagen"}
          </button>
        </div>

        {isTouchDevice ? (
          <textarea
            ref={mobilePasteRef}
            className="mobile-paste-input"
            value={mobilePasteValue}
            onChange={(event) => {
              setMobilePasteValue(event.target.value);
            }}
            onPaste={(event) => {
              void onMobilePaste(event);
            }}
            disabled={isBusy}
            placeholder="Pega texto aca para reemplazar el contenido"
            rows={3}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        ) : null}

        <p
          className={`status-text ${
            status.kind === "error" ? "is-error" : "is-success"
          } ${status.kind === "idle" ? "is-idle" : ""}`}
          aria-live="polite"
        >
          {status.kind === "idle" ? " " : status.message}
        </p>
      </section>
    </main>
  );
}
