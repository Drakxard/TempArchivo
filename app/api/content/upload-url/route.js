import { readStoredContent } from "../../../../lib/content-store";
import {
  createFileKey,
  createSignedReadUrl,
  createSignedUploadUrl,
  deleteR2Object,
  isUploadStorageKey,
  MAX_FILE_BYTES,
} from "../../../../lib/r2";

function json(body, init) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");

  return Response.json(body, {
    ...init,
    headers,
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const filename =
      typeof body?.filename === "string" && body.filename.trim()
        ? body.filename.trim().slice(0, 255)
        : "archivo";
    const contentType =
      typeof body?.contentType === "string" &&
      /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(body.contentType.trim())
        ? body.contentType.trim().toLowerCase()
        : "application/octet-stream";
    const size = Number(body?.size);

    if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      return json(
        { error: "El archivo supera el límite permitido de 200 MB." },
        { status: size > MAX_FILE_BYTES ? 413 : 400 },
      );
    }

    const key = createFileKey(filename, contentType);
    const uploadUrl = await createSignedUploadUrl(key, contentType);
    const readUrl = await createSignedReadUrl(key);

    return json({ key, uploadUrl, readUrl });
  } catch {
    return json(
      { error: "No se pudo preparar la subida a R2." },
      { status: 500 },
    );
  }
}

export async function DELETE(request) {
  try {
    const body = await request.json();
    const key = body?.key;

    if (!isUploadStorageKey(key)) {
      return json({ error: "Clave de subida inválida." }, { status: 400 });
    }

    const currentContent = await readStoredContent();
    if (currentContent?.value === key) {
      return json({ error: "El archivo ya está publicado." }, { status: 409 });
    }

    await deleteR2Object(key);
    return json({ ok: true });
  } catch {
    return json(
      { error: "No se pudo limpiar la subida incompleta." },
      { status: 500 },
    );
  }
}
