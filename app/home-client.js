"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

const EMPTY_STATUS = { kind: "idle", message: "" };

export default function HomeClient({ initialContent }) {
  const fileInputRef = useRef(null);
  const pendingImageUrlRef = useRef(null);
  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [isBusy, setIsBusy] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [isReplacingImage, setIsReplacingImage] = useState(false);
  const [pendingImageUrl, setPendingImageUrl] = useState(null);

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
    pendingImageUrlRef.current = previewUrl;
    setPendingImageUrl(previewUrl);
    setStatus({ kind: "idle", message: "" });

    try {
      const formData = new FormData();
      formData.append("file", file);

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

      const response = await fetch(content.value, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("No se pudo leer la imagen.");
      }

      const blob = await response.blob();

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
        if (!isTouchDevice) {
          throw new Error("Clipboard image write not supported.");
        }

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
        capture="environment"
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
          <button
            type="button"
            className={`content-card content-${displayedContent.type} ${
              displayedContent.isPending ? "is-uploading" : ""
            }`}
            onClick={copyCurrentContent}
            disabled={isBusy}
            aria-label={
              displayedContent.type === "image"
                ? "Copiar imagen al portapapeles"
                : "Copiar texto al portapapeles"
            }
          >
            {displayedContent.type === "image" ? (
              <div className="image-frame">
                <img
                  src={displayedContent.value}
                  alt="Contenido actual"
                  className="image-content"
                />
                {displayedContent.isPending ? (
                  <span className="image-overlay">Subiendo imagen...</span>
                ) : null}
              </div>
            ) : (
              <p className="text-content">{displayedContent.value}</p>
            )}
          </button>
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
