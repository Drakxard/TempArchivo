import {
  deleteStoredObjectIfNeeded,
  readResolvedContent,
  readStoredContent,
  writeStoredContent,
} from "../../../lib/content-store";
import {
  createImageKey,
  deleteR2Object,
  headR2Object,
  isUploadStorageKey,
  MAX_FILE_BYTES,
  resolveContentForClient,
  uploadR2Object,
} from "../../../lib/r2";

function json(body, init) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");

  return Response.json(body, {
    ...init,
    headers,
  });
}

async function writeVerifiedContent(content) {
  await writeStoredContent(content);
  const confirmed = await readStoredContent();
  if (!confirmed || confirmed.updatedAt !== content.updatedAt) {
    throw new Error("Published state could not be verified.");
  }
}

export async function GET() {
  try {
    const content = await readResolvedContent();
    return json({ content });
  } catch (error) {
    return json(
      { error: "No se pudo leer el contenido guardado." },
      { status: 500 },
    );
  }
}

export async function PUT(request) {
  let pendingKeys = [];
  let published = false;

  try {
    const previousContent = await readStoredContent();
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await request.json();
      if (body?.type === "text") {
        const value = typeof body?.value === "string" ? body.value.trim() : "";

        if (!value) {
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

        await writeVerifiedContent(nextContent);
        await deleteStoredObjectIfNeeded(previousContent, nextContent);

        return json({ content: nextContent });
      }

      if (
        (body?.type === "image" || body?.type === "file") &&
        isUploadStorageKey(body?.key)
      ) {
        pendingKeys = [body.key];
        const filename = String(body?.filename || "archivo")
          .replace(/[\r\n]/g, "")
          .trim()
          .slice(0, 255) || "archivo";
        const declaredContentType =
          typeof body?.contentType === "string" &&
          /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(body.contentType.trim())
            ? body.contentType.trim().toLowerCase()
            : "application/octet-stream";
        const declaredSize = Number(body?.size);

        if (
          !Number.isInteger(declaredSize) ||
          declaredSize < 0 ||
          declaredSize > MAX_FILE_BYTES
        ) {
          if (previousContent?.value !== pendingKeys[0]) {
            await deleteR2Object(pendingKeys[0]).catch(() => {});
          }
          pendingKeys = [];
          return json({ error: "El tamaño del archivo no es válido." }, { status: 400 });
        }

        if (body.type === "image" && !declaredContentType.startsWith("image/")) {
          if (previousContent?.value !== pendingKeys[0]) {
            await deleteR2Object(pendingKeys[0]).catch(() => {});
          }
          pendingKeys = [];
          return json(
            { error: "El tipo declarado no corresponde a una imagen." },
            { status: 400 },
          );
        }

        const object = await headR2Object(pendingKeys[0]);
        if (
          object.contentLength !== declaredSize ||
          object.contentLength > MAX_FILE_BYTES ||
          object.contentType.toLowerCase() !== declaredContentType
        ) {
          if (previousContent?.value !== pendingKeys[0]) {
            await deleteR2Object(pendingKeys[0]).catch(() => {});
          }
          pendingKeys = [];
          return json(
            { error: "El archivo subido no coincide con sus metadatos." },
            { status: 400 },
          );
        }

        const nextContent = {
          type: body.type,
          value: pendingKeys[0],
          storage: "r2",
          filename,
          contentType: declaredContentType,
          size: declaredSize,
          updatedAt: new Date().toISOString(),
        };

        await writeVerifiedContent(nextContent);
        published = true;
        await deleteStoredObjectIfNeeded(previousContent, nextContent);

        return json({ content: await resolveContentForClient(nextContent) });
      }

      if (body?.type === "images" && Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 10) {
        pendingKeys = body.items.map((item) => item?.key);
        if (!pendingKeys.every(isUploadStorageKey) || new Set(pendingKeys).size !== pendingKeys.length) {
          return json({ error: "El lote de imágenes no es válido." }, { status: 400 });
        }

        const items = await Promise.all(body.items.map(async (item, index) => {
          const filename = String(item?.filename || `imagen-${index + 1}`)
            .replace(/[\r\n]/g, "").trim().slice(0, 255) || `imagen-${index + 1}`;
          const contentType = typeof item?.contentType === "string" ? item.contentType.trim().toLowerCase() : "";
          const size = Number(item?.size);
          if (!contentType.startsWith("image/") || !Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
            throw new Error("Invalid image metadata.");
          }
          const object = await headR2Object(item.key);
          if (object.contentLength !== size || object.contentType.toLowerCase() !== contentType) {
            throw new Error("Uploaded image metadata mismatch.");
          }
          return { key: item.key, filename, contentType, size };
        }));
        const nextContent = { type: "images", storage: "r2", items, updatedAt: new Date().toISOString() };
        await writeVerifiedContent(nextContent);
        published = true;
        await deleteStoredObjectIfNeeded(previousContent, nextContent);
        return json({ content: await resolveContentForClient(nextContent) });
      }

      return json(
        { error: "El body JSON no tiene un tipo soportado." },
        { status: 400 },
      );
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

      if (file.size > MAX_FILE_BYTES) {
        return json({ error: "El archivo supera el límite de 200 MB." }, { status: 413 });
      }

      const key = createImageKey(file.type);
      pendingKeys = [key];
      const nextContent = {
        type: "image",
        value: key,
        storage: "r2",
        updatedAt: new Date().toISOString(),
      };

      await uploadR2Object(key, Buffer.from(await file.arrayBuffer()), file.type);
      await writeVerifiedContent(nextContent);
      published = true;
      await deleteStoredObjectIfNeeded(previousContent, nextContent);

      return json({ content: await resolveContentForClient(nextContent) });
    }

    return json(
      { error: "Content-Type no soportado." },
      { status: 415 },
    );
  } catch (error) {
    if (pendingKeys.length && !published) {
      try {
        const currentContent = await readStoredContent();
        const activeKeys = new Set(currentContent?.type === "images" ? currentContent.items.map((item) => item.key) : [currentContent?.value]);
        await Promise.all(pendingKeys.filter((key) => key && !activeKeys.has(key)).map((key) => deleteR2Object(key)));
      } catch {
        // Best effort cleanup; never hide the original upload error.
      }
    }

    return json(
      { error: "No se pudo reemplazar el contenido actual." },
      { status: 500 },
    );
  }
}
