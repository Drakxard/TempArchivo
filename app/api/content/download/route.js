import { readStoredContent } from "../../../../lib/content-store";
import { createSignedDownloadUrl, isR2StorageKey } from "../../../../lib/r2";

export async function GET() {
  try {
    const content = await readStoredContent();

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
