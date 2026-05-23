"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import katex from "katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  appendTextHistoryEntry,
  clearStoredDirectoryHandle,
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
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
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
  const pendingImageUrlRef = useRef(null);
  const cachedImageBlobRef = useRef(null);
  const cachedImageVersionRef = useRef(null);
  const imagePrefetchPromiseRef = useRef(null);
  const lastHoverCopyAtRef = useRef(0);
  const isSavingTextRef = useRef(false);
  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [isBusy, setIsBusy] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [isReplacingImage, setIsReplacingImage] = useState(false);
  const [isResizingTextCard, setIsResizingTextCard] = useState(false);
  const [pendingImageUrl, setPendingImageUrl] = useState(null);
  const [mobilePasteValue, setMobilePasteValue] = useState("");
  const [textCardWidth, setTextCardWidth] = useState(DEFAULT_TEXT_CARD_WIDTH);
  const [activeFormula, setActiveFormula] = useState(null);
  const [formulaScale, setFormulaScale] = useState(DEFAULT_FORMULA_SCALE);
  const [isDesktopHistoryCapable, setIsDesktopHistoryCapable] = useState(false);
  const [directoryHandle, setDirectoryHandle] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [activeHistoryEntryId, setActiveHistoryEntryId] = useState(null);
  const [shouldShowFolderPrompt, setShouldShowFolderPrompt] = useState(false);
  const [isFolderRequestPending, setIsFolderRequestPending] = useState(false);
  const [searchBarOpen, setSearchBarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [hasSearchRun, setHasSearchRun] = useState(false);

  const hint = useMemo(() => {
    if (isTouchDevice) {
      return "Tocar para elegir imagen";
    }

    return "Ctrl+V o click para imagen";
  }, [isTouchDevice]);

  const isDesktopTextHistoryEnabled =
    isDesktopHistoryCapable && !isTouchDevice && !!directoryHandle;

  const activeHistoryEntry = useMemo(
    () => historyEntries.find((entry) => entry.id === activeHistoryEntryId) ?? null,
    [activeHistoryEntryId, historyEntries],
  );
  const isTextViewVisible = !!activeHistoryEntry || content?.type === "text";

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
      setIsDesktopHistoryCapable(isDesktopHistorySupported());
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
    setActiveHistoryEntryId(null);
    setSearchBarOpen(false);
    setSearchResults([]);
    setHasSearchRun(false);
    setSearchQuery("");
    setShouldShowFolderPrompt(isDesktopHistoryCapable && !isTouchDevice);

    try {
      await clearStoredDirectoryHandle();
    } catch {
      // Best effort cleanup; UI is already degraded to remote-only mode.
    }
  }, [isDesktopHistoryCapable, isTouchDevice]);

  const loadLocalHistory = useCallback(async (handle, options = {}) => {
    const { selectedEntryId = null, preserveActiveEntry = false } = options;
    const entries = await readTextHistoryEntries(handle);

    setHistoryEntries(entries);

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
      return undefined;
    }

    let ignore = false;

    const restoreDirectoryAccess = async () => {
      try {
        const storedHandle = await getStoredDirectoryHandle();

        if (!storedHandle) {
          if (!ignore) {
            setShouldShowFolderPrompt(true);
          }
          return;
        }

        const permission = await getDirectoryPermission(storedHandle);
        if (permission !== "granted") {
          await clearStoredDirectoryHandle();

          if (!ignore) {
            setShouldShowFolderPrompt(true);
          }
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
        event.key.toLowerCase() === "f" &&
        isDesktopTextHistoryEnabled &&
        !activeFormula
      ) {
        event.preventDefault();
        setSearchBarOpen(true);
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
    isTextViewVisible,
    isDesktopTextHistoryEnabled,
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

  async function saveText(value, options = {}) {
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
      let savedLocalEntry = null;

      if (isDesktopTextHistoryEnabled) {
        try {
          savedLocalEntry = await appendTextHistoryEntry(directoryHandle, text);
          setHistoryEntries((currentEntries) =>
            [...currentEntries, savedLocalEntry].sort(
              (left, right) => left.timestamp - right.timestamp,
            ),
          );
          setActiveHistoryEntryId(savedLocalEntry.id);
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

  async function uploadImage(file) {
    const previewUrl = URL.createObjectURL(file);

    setIsBusy(true);
    setIsReplacingImage(true);
    setActiveHistoryEntryId(null);
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

  const displayedContent =
    pendingImageUrl && isReplacingImage
      ? { type: "image", value: pendingImageUrl, isPending: true }
      : activeHistoryEntry
        ? {
            type: "text",
            value: activeHistoryEntry.text,
            sourceLabel: activeHistoryEntry.label,
            isHistoryEntry: true,
          }
        : content;

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
                  {displayedContent.sourceLabel ? (
                    <span className="text-card-history-label">
                      {displayedContent.sourceLabel}
                    </span>
                  ) : null}
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

        <div className="actions-row">
          <button
            type="button"
            className="ghost-action"
            onClick={openFilePicker}
            disabled={isBusy}
          >
            {displayedContent ? "Reemplazar con imagen" : "Elegir imagen"}
          </button>
          {isDesktopHistoryCapable && !isTouchDevice && !directoryHandle ? (
            <button
              type="button"
              className="ghost-action"
              onClick={() => {
                setShouldShowFolderPrompt(true);
              }}
              disabled={isBusy || isFolderRequestPending}
            >
              Activar historial local
            </button>
          ) : null}
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
