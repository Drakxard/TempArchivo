import { del, head, put } from "@vercel/blob";
import { deleteR2Object, resolveContentForClient } from "./r2";

const STATE_PATH = "clipboard/state.json";

function getBlobToken() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!token) {
    throw new Error("Missing BLOB_READ_WRITE_TOKEN.");
  }

  return token;
}

function isValidContent(content) {
  return (
    content &&
    (content.type === "text" || content.type === "image") &&
    typeof content.value === "string" &&
    typeof content.updatedAt === "string"
  );
}

export async function readStoredContent() {
  const token = getBlobToken();

  try {
    const metadata = await head(STATE_PATH, { token });
    const stateUrl = new URL(metadata.url);
    stateUrl.searchParams.set("v", metadata.uploadedAt);

    const response = await fetch(stateUrl, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
      },
    });

    if (!response.ok) {
      throw new Error("Could not read stored content.");
    }

    const data = await response.json();
    const content = data?.content ?? null;

    return isValidContent(content) ? content : null;
  } catch (error) {
    if (
      error?.name === "BlobNotFoundError" ||
      String(error?.message || "").includes("not exist")
    ) {
      return null;
    }

    throw error;
  }
}

export async function writeStoredContent(content) {
  const token = getBlobToken();

  await put(STATE_PATH, JSON.stringify({ content }, null, 2), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    contentType: "application/json; charset=utf-8",
    token,
  });
}

export async function deleteImageIfNeeded(previousContent, nextContent) {
  if (
    previousContent?.type !== "image" ||
    previousContent.value === nextContent.value
  ) {
    return;
  }

  if (previousContent.storage === "r2") {
    try {
      await deleteR2Object(previousContent.value);
    } catch {
      // Cleanup failure should not block content replacement.
    }

    return;
  }

  try {
    await del(previousContent.value, { token: getBlobToken() });
  } catch {
    // Cleanup failure should not block content replacement.
  }
}

export async function readResolvedContent() {
  const content = await readStoredContent();
  return resolveContentForClient(content);
}
