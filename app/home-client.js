"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import katex from "katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  appendTextHistoryEntry,
  clearStoredDirectoryHandle,
  createTextFingerprint,
  getDirectoryPermission,
  getStoredDirectoryHandle,
  isDesktopHistorySupported,
  pickDirectoryHandle,
  readTextHistoryEntries,
  requestDirectoryPermission,
  saveDirectoryHandle,
  searchHistoryEntries,
} from "../lib/local-history";

const EMPTY_STATUS = { kind: "idle", message: "" };
const MAX_UPLOAD_EDGE = 2000;
const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const HOVER_COPY_COOLDOWN_MS = 2000;
const TEXT_CARD_WIDTH_KEY = "temp-archivo-text-card-width";
const FORMULA_SCALE_KEY = "temp-archivo-formula-scale";
const DEFAULT_TEXT_CARD_WIDTH = 920;
const MIN_TEXT_CARD_WIDTH = 720;
const MAX_TEXT_CARD_WIDTH = 1240;
const DEFAULT_FORMULA_SCALE = 1;
const MIN_FORMULA_SCALE = 0.75;
const MAX_FORMULA_SCALE = 2;
const FORMULA_SCALE_STEP = 0.15;

function getTextCardMaxWidth(viewportWidth) {
  if (!Number.isFinite(viewportWidth)) {
    return DEFAULT_TEXT_CARD_WIDTH;
  }

  return Math.max(
    MIN_TEXT_CARD_WIDTH,
    Math.min(MAX_TEXT_CARD_WIDTH, viewportWidth - 96),
  );
}

function clampTextCardWidth(value, viewportWidth) {
  return Math.min(
    getTextCardMaxWidth(viewportWidth),
    Math.max(MIN_TEXT_CARD_WIDTH, value),
  );
}

function renderMathMarkup(latex, displayMode) {
  return katex.renderToString(latex, {
    displayMode,
    throwOnError: false,
    strict: "ignore",
  });
}

function MathExpression({ latex, displayMode, onOpen }) {
  const html = renderMathMarkup(latex, displayMode);

  return (
    <button
      type="button"
      className={`math-expression ${displayMode ? "is-display" : "is-inline"}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen({ latex, displayMode });
      }}
      aria-label="Abrir formula en grande"
    >
      <span
        className="math-expression-render"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </button>
  );
}

export default function HomeClient({ initialContent }) {
  const fileInputRef = useRef(null);
  const mobilePasteRef = useRef(null);
  const textDocumentRef = useRef(null);
  const searchInputRef = useRef(null);
  const resizeSessionRef = useRef(null);
  const fileDragDepthRef = useRef(0);
  const cachedImageBlobRef = useRef(null);
  const cachedImageVersionRef = useRef(null);
  const imagePrefetchPromiseRef = useRef(null);
  const lastHoverCopyAtRef = useRef(0);
  const isSavingTextRef = useRef(false);
  const remoteSyncInFlightRef = useRef(false);
  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [isBusy, setIsBusy] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isResizingTextCard, setIsResizingTextCard] = useState(false);
  const [uploadState, setUploadState] = useState(null);
  const [readyImageUrl, setReadyImageUrl] = useState(null);
  const [imageLoadError, setImageLoadError] = useState(false);
  const [imageRetryCount, setImageRetryCount] = useState(0);
  const [mobilePasteValue, setMobilePasteValue] = useState("");
  const [textCardWidth, setTextCardWidth] = useState(DEFAULT_TEXT_CARD_WIDTH);
  const [activeFormula, setActiveFormula] = useState(null);
  const [formulaScale, setFormulaScale] = useState(DEFAULT_FORMULA_SCALE);
  const [isDesktopHistoryCapable, setIsDesktopHistoryCapable] = useState(false);
  const [directoryHandle, setDirectoryHandle] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [isHistoryReady, setIsHistoryReady] = useState(false);
  const [activeHistoryEntryId, setActiveHistoryEntryId] = useState(null);
  const [shouldShowFolderPrompt, setShouldShowFolderPrompt] = useState(false);
  const [isFolderRequestPending, setIsFolderRequestPending] = useState(false);
  const [searchBarOpen, setSearchBarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [hasSearchRun, setHasSearchRun] = useState(false);

  const hint = useMemo(() => {
    if (isTouchDevice) {
      return "Tocar para elegir archivo";
    }

    return "Ctrl+V para pegar o click para elegir archivo";
  }, [isTouchDevice]);

  const isDesktopTextHistoryEnabled =
    isDesktopHistoryCapable && !isTouchDevice && !!directoryHandle;

  const activeHistoryEntry = useMemo(
    () => historyEntries.find((entry) => entry.id === activeHistoryEntryId) ?? null,
    [activeHistoryEntryId, historyEntries],
  );
  const isTextViewVisible = !!activeHistoryEntry || content?.type === "text";
  const currentRemoteTextFingerprint =
    content?.type === "text" ? createTextFingerprint(content.value) : null;

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
      file.size <= MAX_IMAGE_UPLOAD_BYTES &&
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

  function preloadImageUrl(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();

      image.onload = async () => {
        try {
          await image.decode?.();
        } catch {
          // A completed load is enough on browsers with partial decode support.
        }
        resolve();
      };
      image.onerror = () => reject(new Error("No se pudo cargar la imagen."));
      image.src = url;
    });
  }

  async function validateLocalImage(file) {
    const objectUrl = URL.createObjectURL(file);

    try {
      await preloadImageUrl(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function uploadToSignedUrl(uploadUrl, file, onProgress) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("PUT", uploadUrl);
      request.setRequestHeader(
        "Content-Type",
        file.type || "application/octet-stream",
      );
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        }
      });
      request.addEventListener("load", () => {
        if (request.status >= 200 && request.status < 300) {
          onProgress(100);
          resolve();
          return;
        }

        reject(new Error("R2 rechazó la subida."));
      });
      request.addEventListener("error", () => {
        reject(new Error("No se pudo conectar con R2."));
      });
      request.addEventListener("abort", () => {
        reject(new Error("La subida fue cancelada."));
      });
      request.send(file);
    });
  }

  function formatFileSize(size) {
    if (!Number.isFinite(size) || size < 0) {
      return "Tamaño desconocido";
    }

    if (size < 1024) {
      return `${size} B`;
    }

    const units = ["KB", "MB", "GB"];
    let value = size / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  const handlePaste = useEffectEvent(async (event) => {
    if (isBusy) {
      return;
    }

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
        await uploadFile(file);
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
      setIsDesktopHistoryCapable(isDesktopHistorySupported());
    };

    updateDeviceMode();
    coarsePointer.addEventListener("change", updateDeviceMode);
    window.addEventListener("paste", handlePaste);

    return () => {
      coarsePointer.removeEventListener("change", updateDeviceMode);
      window.removeEventListener("paste", handlePaste);
      clearCachedImageBlob();
    };
  }, []);

  useEffect(() => {
    if (!searchBarOpen) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [searchBarOpen]);

  useEffect(() => {
    const savedWidth = window.localStorage.getItem(TEXT_CARD_WIDTH_KEY);
    const parsedWidth = Number(savedWidth);

    if (Number.isFinite(parsedWidth) && parsedWidth > 0) {
      setTextCardWidth(clampTextCardWidth(parsedWidth, window.innerWidth));
      return;
    }

    setTextCardWidth(clampTextCardWidth(DEFAULT_TEXT_CARD_WIDTH, window.innerWidth));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(TEXT_CARD_WIDTH_KEY, String(textCardWidth));
  }, [textCardWidth]);

  useEffect(() => {
    const savedScale = window.localStorage.getItem(FORMULA_SCALE_KEY);
    const parsedScale = Number(savedScale);

    if (Number.isFinite(parsedScale)) {
      setFormulaScale(
        Math.min(MAX_FORMULA_SCALE, Math.max(MIN_FORMULA_SCALE, parsedScale)),
      );
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(FORMULA_SCALE_KEY, String(formulaScale));
  }, [formulaScale]);

  useEffect(() => {
    const handleResize = () => {
      setTextCardWidth((currentWidth) =>
        clampTextCardWidth(currentWidth, window.innerWidth),
      );
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!activeFormula) {
      document.body.style.removeProperty("overflow");
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setActiveFormula(null);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.removeProperty("overflow");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeFormula]);

  const disableLocalHistoryAccess = useCallback(async () => {
    setDirectoryHandle(null);
    setHistoryEntries([]);
    setIsHistoryReady(false);
    setActiveHistoryEntryId(null);
    setSearchBarOpen(false);
    setSearchResults([]);
    setHasSearchRun(false);
    setSearchQuery("");
    setShouldShowFolderPrompt(false);

    try {
      await clearStoredDirectoryHandle();
    } catch {
      // Best effort cleanup; UI is already degraded to remote-only mode.
    }
  }, []);

  const loadLocalHistory = useCallback(async (handle, options = {}) => {
    const { selectedEntryId = null, preserveActiveEntry = false } = options;
    const entries = await readTextHistoryEntries(handle);

    setHistoryEntries(entries);
    setIsHistoryReady(true);

    setActiveHistoryEntryId((currentId) => {
      if (selectedEntryId && entries.some((entry) => entry.id === selectedEntryId)) {
        return selectedEntryId;
      }

      if (preserveActiveEntry && currentId && entries.some((entry) => entry.id === currentId)) {
        return currentId;
      }

      if (selectedEntryId === null) {
        return currentId && entries.some((entry) => entry.id === currentId) ? currentId : null;
      }

      return null;
    });
  }, []);

  useEffect(() => {
    if (!isDesktopHistoryCapable || isTouchDevice) {
      setShouldShowFolderPrompt(false);
      setIsHistoryReady(false);
      return undefined;
    }

    let ignore = false;

    const restoreDirectoryAccess = async () => {
      try {
        const storedHandle = await getStoredDirectoryHandle();

        if (!storedHandle) {
          return;
        }

        const permission = await getDirectoryPermission(storedHandle);
        if (permission !== "granted") {
          await clearStoredDirectoryHandle();

          return;
        }

        if (ignore) {
          return;
        }

        setDirectoryHandle(storedHandle);
        setShouldShowFolderPrompt(false);
        await loadLocalHistory(storedHandle, { preserveActiveEntry: true });
      } catch {
        if (!ignore) {
          void disableLocalHistoryAccess();
        }
      }
    };

    void restoreDirectoryAccess();

    return () => {
      ignore = true;
    };
  }, [
    disableLocalHistoryAccess,
    isDesktopHistoryCapable,
    isTouchDevice,
    loadLocalHistory,
  ]);

  const mergeHistoryEntry = useCallback((nextEntry) => {
    if (!nextEntry) {
      return;
    }

    setHistoryEntries((currentEntries) => {
      const withoutDuplicates = currentEntries.filter(
        (entry) =>
          entry.id !== nextEntry.id && entry.fingerprint !== nextEntry.fingerprint,
      );

      return [...withoutDuplicates, nextEntry].sort(
        (left, right) => left.timestamp - right.timestamp,
      );
    });
  }, []);

  async function openDirectoryPicker() {
    if (!isDesktopHistoryCapable || isTouchDevice || isFolderRequestPending) {
      return;
    }

    setIsFolderRequestPending(true);

    try {
      const pickedHandle = await pickDirectoryHandle();
      const permission = await requestDirectoryPermission(pickedHandle);

      if (permission !== "granted") {
        throw new Error("Folder access denied.");
      }

      await saveDirectoryHandle(pickedHandle);
      setDirectoryHandle(pickedHandle);
      setShouldShowFolderPrompt(false);
      await loadLocalHistory(pickedHandle, { selectedEntryId: null });
      setStatus({ kind: "success", message: "Historial local activado." });
    } catch (error) {
      if (error?.name !== "AbortError") {
        setStatus({
          kind: "error",
          message: "No se pudo activar el historial local.",
        });
      }

      setShouldShowFolderPrompt(false);
    } finally {
      setIsFolderRequestPending(false);
    }
  }

  function loadHistoryEntryById(entryId) {
    setActiveHistoryEntryId(entryId);
    setSearchBarOpen(false);
  }

  const navigateHistory = useEffectEvent((direction) => {
    if (!historyEntries.length) {
      return;
    }

    const activeIndex = activeHistoryEntryId
      ? historyEntries.findIndex((entry) => entry.id === activeHistoryEntryId)
      : historyEntries.length - 1;

    if (activeIndex === -1) {
      return;
    }

    const nextIndex = activeIndex + direction;

    if (nextIndex < 0 || nextIndex >= historyEntries.length) {
      return;
    }

    setActiveHistoryEntryId(historyEntries[nextIndex].id);
  });

  function runHistorySearch(query) {
    const results = searchHistoryEntries(historyEntries, query);
    setSearchResults(results);
    setHasSearchRun(true);
  }

  useEffect(() => {
    const handleGlobalKeyDown = (event) => {
      const target = event.target;
      const isTypingTarget =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "q" &&
        isDesktopHistoryCapable &&
        !isTouchDevice &&
        !activeFormula
      ) {
        event.preventDefault();
        if (isDesktopTextHistoryEnabled) {
          setSearchBarOpen(true);
        } else {
          setShouldShowFolderPrompt(true);
        }
        return;
      }

      if (event.key === "Escape" && searchBarOpen) {
        setSearchBarOpen(false);
        return;
      }

      if (
        isTypingTarget ||
        activeFormula ||
        !isDesktopTextHistoryEnabled ||
        !isTextViewVisible
      ) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateHistory(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        navigateHistory(1);
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [
    activeFormula,
    activeHistoryEntry,
    activeHistoryEntryId,
    historyEntries,
    isDesktopHistoryCapable,
    isTextViewVisible,
    isDesktopTextHistoryEnabled,
    isTouchDevice,
    searchBarOpen,
  ]);

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
    if (content?.type !== "image") {
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

  async function saveText(value, options = {}) {
    if (isBusy) {
      return false;
    }

    const { clearMobileInput = false, blurMobileInput = false } = options;
    const text = value.trim();
    if (!text) {
      setStatus({
        kind: "error",
        message: "El texto pegado estaba vacio.",
      });
      return false;
    }

    isSavingTextRef.current = true;
    setIsBusy(true);
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
      let savedLocalEntry = null;

      if (isDesktopTextHistoryEnabled) {
        try {
          const result = await appendTextHistoryEntry(directoryHandle, text, {
            source: "local",
            createdAt: data.content?.updatedAt,
          });
          savedLocalEntry = result.entry;
          mergeHistoryEntry(savedLocalEntry);
          setActiveHistoryEntryId(savedLocalEntry?.id ?? null);
        } catch {
          await disableLocalHistoryAccess();
        }
      }

      if (clearMobileInput) {
        setMobilePasteValue("");
      }

      if (blurMobileInput) {
        mobilePasteRef.current?.blur();
      }

      if (!savedLocalEntry) {
        setActiveHistoryEntryId(null);
      }

      setStatus({ kind: "success", message: "Texto cargado." });
      return true;
    } catch {
      setStatus({ kind: "error", message: "No se pudo guardar el texto." });
      return false;
    } finally {
      isSavingTextRef.current = false;
      setIsBusy(false);
    }
  }

  async function uploadFile(file) {
    if (isBusy) {
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setStatus({
        kind: "error",
        message: "El archivo supera el límite de 200 MB.",
      });
      return;
    }

    const isImage = file.type.startsWith("image/");
    let uploadedKey = null;
    setIsBusy(true);
    setActiveHistoryEntryId(null);
    clearCachedImageBlob();
    setUploadState({
      phase: isImage ? "preparing" : "uploading",
      progress: 0,
      filename: file.name || "archivo",
    });
    setStatus({ kind: "idle", message: "" });

    try {
      if (isImage) {
        await validateLocalImage(file);
      }

      const preparedFile = isImage ? await prepareUploadFile(file) : file;
      const contentType = (
        preparedFile.type || "application/octet-stream"
      ).toLowerCase();
      const uploadPreparationResponse = await fetch("/api/content/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: preparedFile.name || file.name || "archivo",
          contentType,
          size: preparedFile.size,
        }),
      });

      if (!uploadPreparationResponse.ok) {
        throw new Error("No se pudo preparar la subida.");
      }

      const uploadPreparation = await uploadPreparationResponse.json();
      uploadedKey = uploadPreparation.key;
      setUploadState((current) => ({
        ...current,
        phase: "uploading",
        progress: 0,
      }));

      await uploadToSignedUrl(
        uploadPreparation.uploadUrl,
        preparedFile,
        (progress) => {
          setUploadState((current) => ({
            ...current,
            phase: "uploading",
            progress,
          }));
        },
      );

      setUploadState((current) => ({
        ...current,
        phase: "finalizing",
        progress: 100,
      }));

      if (isImage) {
        await preloadImageUrl(uploadPreparation.readUrl);
      }

      const response = await fetch("/api/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: isImage ? "image" : "file",
          key: uploadedKey,
          filename: file.name || "archivo",
          contentType,
          size: preparedFile.size,
        }),
      });

      if (!response.ok) {
        throw new Error("No se pudo publicar el archivo.");
      }

      const data = await response.json();
      uploadedKey = null;

      if (isImage) {
        const nextContent = {
          ...data.content,
          value: uploadPreparation.readUrl,
        };
        setReadyImageUrl(nextContent.value);
        setImageLoadError(false);
        setImageRetryCount(0);
        setContent(nextContent);
      } else {
        setContent(data.content);
      }

      setStatus({
        kind: "success",
        message: isImage ? "Imagen cargada." : "Archivo cargado.",
      });
    } catch {
      if (uploadedKey) {
        try {
          await fetch("/api/content/upload-url", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: uploadedKey }),
          });
        } catch {
          // Best effort cleanup; the published content remains untouched.
        }
      }

      setStatus({
        kind: "error",
        message: isImage
          ? "No se pudo preparar o guardar la imagen."
          : "No se pudo guardar el archivo.",
      });
    } finally {
      setUploadState(null);
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

  async function copyCurrentText() {
    const textValue =
      activeHistoryEntry?.text || (content?.type === "text" ? content.value : null);

    if (!textValue) {
      return;
    }

    try {
      await navigator.clipboard.writeText(textValue);
      setStatus({ kind: "success", message: "Copiado." });
    } catch {
      setStatus({
        kind: "error",
        message: "No se pudo copiar el texto.",
      });
    }
  }

  function finishTextResize() {
    resizeSessionRef.current = null;
    setIsResizingTextCard(false);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }

  const handleTextResizeMove = useEffectEvent((event) => {
    const session = resizeSessionRef.current;

    if (!session) {
      return;
    }

    const nextWidth = clampTextCardWidth(
      Math.round(Math.abs(event.clientX - session.centerX) * 2),
      window.innerWidth,
    );

    setTextCardWidth(nextWidth);
  });

  const handleTextResizeEnd = useEffectEvent(() => {
    finishTextResize();
  });

  useEffect(() => {
    if (!isResizingTextCard) {
      return undefined;
    }

    const handlePointerMove = (event) => {
      handleTextResizeMove(event);
    };
    const handlePointerUp = () => {
      handleTextResizeEnd();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isResizingTextCard]);

  function handleTextResizeStart(event) {
    if (isBusy || isTouchDevice) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const root = textDocumentRef.current?.closest(".content-text");

    if (!root) {
      return;
    }

    const rect = root.getBoundingClientRect();
    resizeSessionRef.current = {
      centerX: rect.left + rect.width / 2,
    };
    setIsResizingTextCard(true);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  }

  function handleFormulaOpen(formula) {
    setActiveFormula(formula);
  }

  async function copyFormulaLatex() {
    if (!activeFormula) {
      return;
    }

    try {
      await navigator.clipboard.writeText(activeFormula.latex);
      setStatus({ kind: "success", message: "Formula copiada." });
    } catch {
      setStatus({ kind: "error", message: "No se pudo copiar la formula." });
    }
  }

  function increaseFormulaScale() {
    setFormulaScale((current) =>
      Math.min(MAX_FORMULA_SCALE, Number((current + FORMULA_SCALE_STEP).toFixed(2))),
    );
  }

  function decreaseFormulaScale() {
    setFormulaScale((current) =>
      Math.max(MIN_FORMULA_SCALE, Number((current - FORMULA_SCALE_STEP).toFixed(2))),
    );
  }

  async function handleImageHoverCopy() {
    if (
      isTouchDevice ||
      isBusy ||
      !content ||
      content.type !== "image" ||
      readyImageUrl !== content.value
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

  function hasDraggedFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes("Files");
  }

  function handleFileDragEnter(event) {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    fileDragDepthRef.current += 1;

    if (!isBusy) {
      setIsDraggingFile(true);
    }
  }

  function handleFileDragOver(event) {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = isBusy ? "none" : "copy";
  }

  function handleFileDragLeave(event) {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);

    if (fileDragDepthRef.current === 0) {
      setIsDraggingFile(false);
    }
  }

  async function handleFileDrop(event) {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    fileDragDepthRef.current = 0;
    setIsDraggingFile(false);

    if (isBusy) {
      return;
    }

    const file = event.dataTransfer.files?.[0];
    if (file) {
      await uploadFile(file);
    }
  }

  async function onFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    await uploadFile(file);
  }

  async function onMobilePaste(event) {
    const pastedText = event.clipboardData?.getData("text/plain") || "";
    if (!pastedText) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setMobilePasteValue(pastedText);
    await saveText(pastedText, {
      clearMobileInput: true,
      blurMobileInput: true,
    });
  }

  function onMobilePasteInputChange(event) {
    const nextValue = event.target.value;
    setMobilePasteValue(nextValue);

    if (!nextValue || isSavingTextRef.current) {
      return;
    }

    void saveText(nextValue, { clearMobileInput: true });
  }

  useEffect(() => {
    if (
      !isDesktopTextHistoryEnabled ||
      !isHistoryReady ||
      !directoryHandle ||
      !content ||
      content.type !== "text" ||
      remoteSyncInFlightRef.current
    ) {
      return;
    }

    const alreadySynced = historyEntries.some(
      (entry) => entry.fingerprint === currentRemoteTextFingerprint,
    );

    if (alreadySynced) {
      return;
    }

    let cancelled = false;

    const syncRemoteText = async () => {
      remoteSyncInFlightRef.current = true;

      try {
        const result = await appendTextHistoryEntry(directoryHandle, content.value, {
          source: "r2",
          createdAt: content.updatedAt,
        });

        if (!cancelled) {
          mergeHistoryEntry(result.entry);
        }
      } catch {
        if (!cancelled) {
          await disableLocalHistoryAccess();
        }
      } finally {
        remoteSyncInFlightRef.current = false;
      }
    };

    void syncRemoteText();

    return () => {
      cancelled = true;
    };
  }, [
    content,
    currentRemoteTextFingerprint,
    directoryHandle,
    disableLocalHistoryAccess,
    historyEntries,
    isDesktopTextHistoryEnabled,
    isHistoryReady,
    mergeHistoryEntry,
  ]);

  const displayedContent = activeHistoryEntry
    ? {
        type: "text",
        value: activeHistoryEntry.text,
        sourceLabel: activeHistoryEntry.label,
        isHistoryEntry: true,
        historySource: activeHistoryEntry.source,
      }
    : content;

  const imageSource =
    displayedContent?.type === "image" && imageRetryCount > 0
      ? `${displayedContent.value}${displayedContent.value.includes("?") ? "&" : "?"}retry=${imageRetryCount}`
      : displayedContent?.value;
  const isDisplayedImageReady =
    displayedContent?.type === "image" && readyImageUrl === displayedContent.value;
  const uploadMessage =
    uploadState?.phase === "preparing"
      ? "Preparando imagen..."
      : uploadState?.phase === "finalizing"
        ? "Finalizando..."
        : `Subiendo ${uploadState?.progress || 0} %`;
  const uploadProgressCard = uploadState ? (
    <div className="upload-progress-card" aria-live="polite">
      <span className="upload-progress-name">{uploadState.filename}</span>
      <span className="upload-progress-label">{uploadMessage}</span>
      <progress
        className="upload-progress-bar"
        max="100"
        value={uploadState.phase === "preparing" ? undefined : uploadState.progress}
        aria-label={uploadMessage}
      />
    </div>
  ) : null;

  const textCardStyle = {
    width: `min(100%, ${textCardWidth}px)`,
  };

  const markdownComponents = {
    pre({ node, children, ...props }) {
      const className = node?.children?.[0]?.properties?.className;
      const isMathBlock =
        Array.isArray(className) &&
        className.some((value) => String(value).includes("math-display"));

      if (isMathBlock) {
        return <>{children}</>;
      }

      return <pre {...props}>{children}</pre>;
    },
    code({ className, children, ...props }) {
      const classNames = Array.isArray(className)
        ? className
        : String(className || "")
            .split(" ")
            .filter(Boolean);
      const isMathCode = classNames.some((value) =>
        String(value).includes("language-math") ||
        String(value).includes("math-inline") ||
        String(value).includes("math-display"),
      );

      if (!isMathCode) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }

      const latex = String(children).replace(/\n$/, "");
      const displayMode = classNames.some((value) =>
        String(value).includes("math-display"),
      );

      return (
        <MathExpression
          latex={latex}
          displayMode={displayMode}
          onOpen={handleFormulaOpen}
        />
      );
    },
  };

  const activeFormulaMarkup = activeFormula
    ? renderMathMarkup(activeFormula.latex, true)
    : "";

  return (
    <main
      className={`page-shell ${isDraggingFile ? "is-file-dragging" : ""}`}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={(event) => {
        void handleFileDrop(event);
      }}
    >
      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        onChange={onFileChange}
      />

      <section className="stage">
        {!displayedContent ? (
          uploadProgressCard || (
            <button
              type="button"
              className="empty-state"
              onClick={openFilePicker}
              disabled={isBusy}
              aria-label="Seleccionar archivo"
            >
              <span className="plus-mark">+</span>
              <span className="hint-text">{hint}</span>
            </button>
          )
        ) : (
          displayedContent.type === "image" ? (
            <div className="content-card content-image">
              <button
                type="button"
                className="image-copy-button"
                onClick={() => {
                  if (imageLoadError) {
                    setImageLoadError(false);
                    setImageRetryCount((current) => current + 1);
                    return;
                  }

                  void copyCurrentContent();
                }}
                onPointerEnter={() => {
                  void handleImageHoverCopy();
                }}
                disabled={isBusy || (!isDisplayedImageReady && !imageLoadError)}
                aria-label={
                  imageLoadError
                    ? "Reintentar carga de imagen"
                    : "Copiar imagen al portapapeles"
                }
              >
                <img
                  src={imageSource}
                  alt="Contenido actual"
                  className={`image-content ${
                    isDisplayedImageReady ? "is-ready" : "is-waiting"
                  }`}
                  onLoad={() => {
                    setReadyImageUrl(displayedContent.value);
                    setImageLoadError(false);
                  }}
                  onError={() => {
                    setImageLoadError(true);
                  }}
                />
                {!isDisplayedImageReady ? (
                  <span className="image-overlay">
                    {imageLoadError ? "No se pudo cargar. Tocar para reintentar" : "Cargando imagen..."}
                  </span>
                ) : null}
              </button>
            </div>
          ) : displayedContent.type === "file" ? (
            <a
              className="content-card file-card"
              href={`/api/content/download?v=${encodeURIComponent(
                displayedContent.updatedAt || "actual",
              )}`}
              aria-label={`Descargar ${displayedContent.filename}`}
            >
              <span className="file-card-icon" aria-hidden="true">↓</span>
              <span className="file-card-copy">
                <strong className="file-card-name">{displayedContent.filename}</strong>
                <span className="file-card-meta">
                  {formatFileSize(displayedContent.size)} · {displayedContent.contentType}
                </span>
              </span>
              <span className="file-card-action">Descargar</span>
            </a>
          ) : (
            <article
              ref={textDocumentRef}
              className={`content-card content-text ${
                displayedContent.isPending ? "is-uploading" : ""
              } ${isResizingTextCard ? "is-resizing" : ""}`}
              style={textCardStyle}
              data-text-card-root="true"
              aria-label="Texto renderizado"
            >
              <span
                className="text-resize-handle text-resize-handle-left"
                onPointerDown={handleTextResizeStart}
                aria-hidden="true"
              />
              <span
                className="text-resize-handle text-resize-handle-right"
                onPointerDown={handleTextResizeStart}
                aria-hidden="true"
              />
              <div className="text-card-header">
                <div className="text-card-header-copy">
                  <span className="text-card-chip">
                    {displayedContent.isHistoryEntry ? "Texto local" : "Texto"}
                  </span>
                </div>
                <div className="text-card-actions">
                  {displayedContent.isHistoryEntry ? (
                    <button
                      type="button"
                      className="text-copy-button"
                      onClick={() => {
                        setActiveHistoryEntryId(null);
                      }}
                      disabled={isBusy}
                    >
                      Volver al actual
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-copy-button"
                    onClick={() => {
                      void copyCurrentText();
                    }}
                    disabled={isBusy}
                  >
                    Copiar original
                  </button>
                </div>
              </div>
              <div className="text-document">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  components={markdownComponents}
                >
                  {displayedContent.value}
                </ReactMarkdown>
              </div>
            </article>
          )
        )}

        {displayedContent && uploadProgressCard}

        <div className="actions-row">
          <button
            type="button"
            className="ghost-action"
            onClick={openFilePicker}
            disabled={isBusy}
          >
            {displayedContent ? "Reemplazar archivo" : "Elegir archivo"}
          </button>
        </div>

        {isTouchDevice ? (
          <textarea
            ref={mobilePasteRef}
            className="mobile-paste-input"
            value={mobilePasteValue}
            onChange={onMobilePasteInputChange}
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

      {isDraggingFile ? (
        <div className="file-drop-overlay" aria-hidden="true">
          <div className="file-drop-card">
            <span className="file-drop-icon">+</span>
            <span>Soltar archivo para subir</span>
            <small>Máximo 200 MB</small>
          </div>
        </div>
      ) : null}

      {activeFormula ? (
        <div
          className="formula-modal-backdrop"
          onClick={() => {
            setActiveFormula(null);
          }}
          role="presentation"
        >
          <div
            className="formula-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Formula ampliada"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="formula-modal-header">
              <p className="formula-modal-title">Formula ampliada</p>
              <div className="formula-modal-actions">
                <button
                  type="button"
                  className="formula-modal-scale-button"
                  onClick={decreaseFormulaScale}
                  disabled={formulaScale <= MIN_FORMULA_SCALE}
                  aria-label="Achicar formula"
                  title="Achicar formula"
                >
                  -
                </button>
                <button
                  type="button"
                  className="formula-modal-scale-button"
                  onClick={increaseFormulaScale}
                  disabled={formulaScale >= MAX_FORMULA_SCALE}
                  aria-label="Agrandar formula"
                  title="Agrandar formula"
                >
                  +
                </button>
                <button
                  type="button"
                  className="formula-modal-icon-button"
                  onClick={() => {
                    void copyFormulaLatex();
                  }}
                  aria-label="Copiar formula"
                  title="Copiar formula"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 9h9v11H9z" />
                    <path d="M6 5h9v2H8v9H6z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="formula-modal-close"
                  onClick={() => {
                    setActiveFormula(null);
                  }}
                  aria-label="Cerrar formula"
                >
                  Cerrar
                </button>
              </div>
            </div>
            <div className="formula-modal-body">
              <div
                className="formula-modal-math"
                style={{ "--formula-scale": formulaScale }}
                dangerouslySetInnerHTML={{ __html: activeFormulaMarkup }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {searchBarOpen ? (
        <div className="history-search-overlay" role="presentation">
          <div className="history-search-panel">
            <form
              className="history-search-form"
              onSubmit={(event) => {
                event.preventDefault();
                runHistorySearch(searchQuery);
              }}
            >
              <input
                ref={searchInputRef}
                type="text"
                className="history-search-input"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                }}
                placeholder="Buscar en pegados locales"
                aria-label="Buscar en historial local"
              />
              <button type="submit" className="history-search-submit">
                Buscar
              </button>
              <button
                type="button"
                className="history-search-close"
                onClick={() => {
                  setSearchBarOpen(false);
                }}
              >
                Cerrar
              </button>
            </form>

            {hasSearchRun ? (
              searchResults.length ? (
                <div className="history-search-results">
                  {searchResults.map((result) => (
                    <button
                      key={result.entryId}
                      type="button"
                      className="history-search-result"
                      onClick={() => {
                        loadHistoryEntryById(result.entryId);
                      }}
                    >
                      <span className="history-search-result-head">
                        <span>{result.label}</span>
                        <span>{result.matches.length} coincidencia(s)</span>
                      </span>
                      <span className="history-search-result-preview">
                        {result.preview}
                      </span>
                      <span className="history-search-result-paragraph">
                        {result.matches[0].paragraph}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="history-search-empty">
                  No se encontraron coincidencias en el historial local.
                </p>
              )
            ) : null}
          </div>
        </div>
      ) : null}

      {shouldShowFolderPrompt ? (
        <div className="folder-access-backdrop" role="presentation">
          <div
            className="folder-access-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Activar historial local"
          >
            <p className="folder-access-title">Activar historial local</p>
            <p className="folder-access-copy">
              Selecciona una carpeta para guardar y navegar los pegados de texto
              desde esta PC. Si ya das acceso una vez, la app intentara reutilizarlo
              en los siguientes inicios.
            </p>
            <div className="folder-access-actions">
              <button
                type="button"
                className="formula-modal-close"
                onClick={() => {
                  void openDirectoryPicker();
                }}
                disabled={isFolderRequestPending}
              >
                {isFolderRequestPending ? "Abriendo..." : "Seleccionar carpeta"}
              </button>
              <button
                type="button"
                className="ghost-action"
                onClick={() => {
                  setShouldShowFolderPrompt(false);
                }}
                disabled={isFolderRequestPending}
              >
                Ahora no
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
