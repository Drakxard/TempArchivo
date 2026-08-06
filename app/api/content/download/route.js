import { readStoredContent } from "../../../../lib/content-store";
import { createSignedDownloadUrl, isR2StorageKey } from "../../../../lib/r2";

export async function GET(request) {
  try {
    const content = await readStoredContent();

    const index = Number(new URL(request.url).searchParams.get("index"));
    if (content?.type === "images") {
      if (!Number.isInteger(index) || index < 0 || index >= content.items.length) {
        return new Response("La imagen solicitada no existe.", { status: 404 });
      }
      const item = content.items[index];
      const downloadUrl = await createSignedDownloadUrl(item.key, item.filename, item.contentType);
      return new Response(null, {
        status: 307,
        headers: { Location: downloadUrl, "Cache-Control": "private, no-store, max-age=0" },
      });
    }

    if (
      content?.type !== "file" ||
      !isR2StorageKey(content.value) ||
      typeof content.filename !== "string"
    ) {
      return new Response("No hay un archivo descargable.", { status: 404 });
    }

    const downloadUrl = await createSignedDownloadUrl(
      content.value,
      content.filename,
      content.contentType,
    );

    return new Response(null, {
      status: 307,
      headers: {
        Location: downloadUrl,
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch {
    return new Response("No se pudo preparar la descarga.", { status: 500 });
  }
}
