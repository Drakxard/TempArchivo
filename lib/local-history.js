"use client";

const DB_NAME = "temp-archivo-local-history";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const HANDLE_KEY = "directory-handle";
const HISTORY_DIRECTORY_NAME = "temp-archivo-text-history";
const ENTRY_PREFIX = "entry-";
const ENTRY_EXTENSION = ".json";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(request.error || new Error("No se pudo abrir IndexedDB."));
    };

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

async function withStore(mode, callback) {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);

    transaction.oncomplete = () => {
      database.close();
    };

    transaction.onerror = () => {
      reject(transaction.error || new Error("IndexedDB transaction failed."));
    };

    Promise.resolve(callback(store)).then(resolve, reject);
  });
}

function isDirectoryHandle(value) {
  return (
    value &&
    typeof value === "object" &&
    value.kind === "directory" &&
    typeof value.queryPermission === "function"
  );
}

export function isDesktopHistorySupported() {
  if (typeof window === "undefined") {
    return false;
  }

  return (
    typeof window.showDirectoryPicker === "function" &&
    typeof window.indexedDB !== "undefined"
  );
}

export async function saveDirectoryHandle(handle) {
  await withStore("readwrite", (store) => store.put(handle, HANDLE_KEY));
}

export async function getStoredDirectoryHandle() {
  const handle = await withStore(
    "readonly",
    (store) =>
      new Promise((resolve, reject) => {
        const request = store.get(HANDLE_KEY);
        request.onerror = () => {
          reject(request.error || new Error("No se pudo leer el handle."));
        };
        request.onsuccess = () => {
          resolve(request.result ?? null);
        };
      }),
  );

  return isDirectoryHandle(handle) ? handle : null;
}

export async function clearStoredDirectoryHandle() {
  await withStore("readwrite", (store) => store.delete(HANDLE_KEY));
}

export async function getDirectoryPermission(handle) {
  if (!isDirectoryHandle(handle)) {
    return "denied";
  }

  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

export async function requestDirectoryPermission(handle) {
  if (!isDirectoryHandle(handle)) {
    return "denied";
  }

  try {
    return await handle.requestPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

export async function pickDirectoryHandle() {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  return handle;
}

async function getHistoryDirectoryHandle(directoryHandle) {
  return directoryHandle.getDirectoryHandle(HISTORY_DIRECTORY_NAME, {
    create: true,
  });
}

function createEntryFileName(date = new Date()) {
  const iso = date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `${ENTRY_PREFIX}${iso}-${crypto.randomUUID()}${ENTRY_EXTENSION}`;
}

function formatEntryLabel(date) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function normalizeEntry(raw) {
  if (
    !raw ||
    typeof raw.id !== "string" ||
    typeof raw.text !== "string" ||
    typeof raw.createdAt !== "string"
  ) {
    return null;
  }

  const createdAt = new Date(raw.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return {
    id: raw.id,
    text: raw.text,
    createdAt: raw.createdAt,
    label: formatEntryLabel(createdAt),
    timestamp: createdAt.getTime(),
  };
}

export async function appendTextHistoryEntry(directoryHandle, text) {
  const historyDirectory = await getHistoryDirectoryHandle(directoryHandle);
  const now = new Date();
  const id = createEntryFileName(now).replace(ENTRY_EXTENSION, "");
  const fileHandle = await historyDirectory.getFileHandle(`${id}${ENTRY_EXTENSION}`, {
    create: true,
  });
  const writable = await fileHandle.createWritable();

  await writable.write(
    JSON.stringify(
      {
        id,
        text,
        createdAt: now.toISOString(),
      },
      null,
      2,
    ),
  );
  await writable.close();

  return normalizeEntry({
    id,
    text,
    createdAt: now.toISOString(),
  });
}

export async function readTextHistoryEntries(directoryHandle) {
  const historyDirectory = await getHistoryDirectoryHandle(directoryHandle);
  const entries = [];

  // Files outside the app naming convention are ignored on purpose.
  for await (const [name, handle] of historyDirectory.entries()) {
    if (
      handle.kind !== "file" ||
      !name.startsWith(ENTRY_PREFIX) ||
      !name.endsWith(ENTRY_EXTENSION)
    ) {
      continue;
    }

    try {
      const file = await handle.getFile();
      const parsed = JSON.parse(await file.text());
      const normalized = normalizeEntry(parsed);

      if (normalized) {
        entries.push(normalized);
      }
    } catch {
      // Invalid history files are skipped silently.
    }
  }

  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

function findParagraphMatches(text, normalizedQuery) {
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const results = [];

  for (const paragraph of paragraphs) {
    const lowerParagraph = paragraph.toLowerCase();
    const index = lowerParagraph.indexOf(normalizedQuery);

    if (index === -1) {
      continue;
    }

    const previewStart = Math.max(0, index - 50);
    const previewEnd = Math.min(paragraph.length, index + normalizedQuery.length + 70);
    const preview = paragraph.slice(previewStart, previewEnd).trim();

    results.push({
      paragraph,
      preview:
        previewStart > 0 || previewEnd < paragraph.length ? `...${preview}...` : preview,
    });
  }

  return results;
}

export function searchHistoryEntries(entries, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  return entries
    .map((entry) => {
      const matches = findParagraphMatches(entry.text, normalizedQuery);

      if (matches.length === 0) {
        return null;
      }

      return {
        entryId: entry.id,
        label: entry.label,
        createdAt: entry.createdAt,
        preview: matches[0].preview,
        matches,
      };
    })
    .filter(Boolean);
}
