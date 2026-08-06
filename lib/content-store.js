import { del, head } from "@vercel/blob";
import {
  R2_STATE_KEY,
  deleteR2Object,
  isR2StorageKey,
  isUploadStorageKey,
  readR2Object,
  resolveContentForClient,
  uploadR2Object,
} from "./r2.js";

const LEGACY_STATE_PATH = "clipboard/state.json";

function getBlobToken() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN.");
  return token;
}

function isFileMetadata(value) {
  return (
    value &&
    typeof value.filename === "string" &&
    typeof value.contentType === "string" &&
    Number.isFinite(value.size) &&
    value.size >= 0
  );
}

export function isValidContent(content) {
  if (!content || typeof content.updatedAt !== "string") return false;
  if (content.type === "text" || content.type === "image") {
    return typeof content.value === "string";
  }
  if (content.type === "file") {
    return typeof content.value === "string" && isFileMetadata(content);
  }
  return (
    content.type === "images" &&
    Array.isArray(content.items) &&
    content.items.length > 0 &&
    content.items.length <= 10 &&
    content.items.every(
      (item) =>
        isUploadStorageKey(item?.key) &&
        isFileMetadata(item) &&
        item.contentType.startsWith("image/"),
    )
  );
}

async function readLegacyStoredContent() {
  try {
    const metadata = await head(LEGACY_STATE_PATH, { token: getBlobToken() });
    const stateUrl = new URL(metadata.url);
    stateUrl.searchParams.set("v", metadata.uploadedAt);
    const response = await fetch(stateUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not read legacy stored content.");
    const data = await response.json();
    return isValidContent(data?.content) ? data.content : null;
  } catch (error) {
    if (error?.name === "BlobNotFoundError" || String(error?.message || "").includes("not exist")) return null;
    throw error;
  }
}

async function readR2StoredContent() {
  try {
    const object = await readR2Object(R2_STATE_KEY);
    const data = JSON.parse(new TextDecoder().decode(object.body));
    return isValidContent(data?.content) ? data.content : null;
  } catch (error) {
    const message = String(error?.name || "") + String(error?.message || "");
    if (/NoSuchKey|NotFound|not exist|404/i.test(message)) return undefined;
    throw error;
  }
}

export async function readStoredContent() {
  const stored = await readR2StoredContent();
  if (stored !== undefined) return stored;

  const legacy = await readLegacyStoredContent();
  if (legacy) await writeStoredContent(legacy);
  return legacy;
}

export async function writeStoredContent(content) {
  await uploadR2Object(
    R2_STATE_KEY,
    Buffer.from(JSON.stringify({ content })),
    "application/json; charset=utf-8",
  );
}

export function getContentStorageKeys(content) {
  if (content?.type === "images") return content.items.map((item) => item.key);
  return ["image", "file"].includes(content?.type) && isR2StorageKey(content.value)
    ? [content.value]
    : [];
}

export async function deleteStoredObjectIfNeeded(previousContent, nextContent) {
  const nextKeys = new Set(getContentStorageKeys(nextContent));
  await Promise.all(
    getContentStorageKeys(previousContent)
      .filter((key) => !nextKeys.has(key))
      .map((key) => deleteR2Object(key).catch(() => {})),
  );

  const previousValue = previousContent?.value;
  const isLegacyBlobUrl =
    typeof previousValue === "string" && /^https?:\/\/.*blob\.vercel-storage\.com\//i.test(previousValue);
  if (isLegacyBlobUrl && previousValue !== nextContent?.value) {
    await del(previousValue, { token: getBlobToken() }).catch(() => {});
  }
}

export async function readResolvedContent() {
  return resolveContentForClient(await readStoredContent());
}
