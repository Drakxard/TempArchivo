import {
  deleteImageIfNeeded,
  readResolvedContent,
  readStoredContent,
  writeStoredContent,
} from "../../../lib/content-store";
import {
  createImageKey,
  resolveContentForClient,
  uploadR2Object,
} from "../../../lib/r2";

function getBlobToken() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!token) {
    throw new Error("Missing BLOB_READ_WRITE_TOKEN.");
  }

  return token;
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

        await writeStoredContent(nextContent);
        await deleteImageIfNeeded(previousContent, nextContent);

        return json({ content: nextContent });
      }

      if (body?.type === "image" && typeof body?.key === "string" && body.key) {
        const nextContent = {
          type: "image",
          value: body.key,
          storage: "r2",
          updatedAt: new Date().toISOString(),
        };

        await writeStoredContent(nextContent);
        await deleteImageIfNeeded(previousContent, nextContent);

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

      const key = createImageKey(file.type);
      const nextContent = {
        type: "image",
        value: key,
        storage: "r2",
        updatedAt: new Date().toISOString(),
      };

      await uploadR2Object(key, Buffer.from(await file.arrayBuffer()), file.type);
      await writeStoredContent(nextContent);
      await deleteImageIfNeeded(previousContent, nextContent);

      return json({ content: await resolveContentForClient(nextContent) });
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
