import { createImageKey, createSignedUploadUrl } from "../../../../lib/r2";

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
    const contentType =
      typeof body?.contentType === "string" && body.contentType.startsWith("image/")
        ? body.contentType
        : null;

    if (!contentType) {
      return json(
        { error: "Debe enviarse un contentType de imagen valido." },
        { status: 400 },
      );
    }

    const key = createImageKey(contentType);
    const uploadUrl = await createSignedUploadUrl(key, contentType);

    return json({ key, uploadUrl });
  } catch {
    return json(
      { error: "No se pudo preparar la subida a R2." },
      { status: 500 },
    );
  }
}
