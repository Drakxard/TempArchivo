import { del, head, put } from "@vercel/blob";

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

async function readStoredContent() {
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

async function writeStoredContent(content) {
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

async function deleteImageIfNeeded(previousContent, nextContent) {
  if (
    previousContent?.type !== "image" ||
    previousContent.value === nextContent.value
  ) {
    return;
  }

  try {
    await del(previousContent.value, { token: getBlobToken() });
  } catch {
    // Cleanup failure should not block content replacement.
  }
}

function json(body, init) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");

  return Response.json(body, {
    ...init,
    headers,
  });
}

export async function GET() {
  try {
    const content = await readStoredContent();
    return json({ content });
  } catch (error) {
    return json(
      { error: "No se pudo leer el contenido guardado." },
      { status: 500 },
    );
  }
}

export async function PUT(request) {
  try {
    const previousContent = await readStoredContent();
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await request.json();
      const value = typeof body?.value === "string" ? body.value.trim() : "";

      if (body?.type !== "text" || !value) {
        return json(
          { error: "El body JSON debe ser texto no vacio." },
          { status: 400 },
        );
      }

      const nextContent = {
        type: "text",
        value,
        updatedAt: new Date().toISOString(),
      };

      await writeStoredContent(nextContent);
      await deleteImageIfNeeded(previousContent, nextContent);

      return json({ content: nextContent });
    }

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!(file instanceof File) || !file.type.startsWith("image/")) {
        return json(
          { error: "Debe enviarse una imagen valida." },
          { status: 400 },
        );
      }

      const extension = file.type.split("/")[1] || "png";
      const safeExtension = extension.replace(/[^a-z0-9]/gi, "").toLowerCase();
      const pathname = `clipboard/images/current-${Date.now()}.${safeExtension || "png"}`;
      const uploaded = await put(pathname, file, {
        access: "public",
        addRandomSuffix: true,
        token: getBlobToken(),
      });

      const nextContent = {
        type: "image",
        value: uploaded.url,
        updatedAt: new Date().toISOString(),
      };

      await writeStoredContent(nextContent);
      await deleteImageIfNeeded(previousContent, nextContent);

      return json({ content: nextContent });
    }

    return json(
      { error: "Content-Type no soportado." },
      { status: 415 },
    );
  } catch (error) {
    return json(
      { error: "No se pudo reemplazar el contenido actual." },
      { status: 500 },
    );
  }
}
