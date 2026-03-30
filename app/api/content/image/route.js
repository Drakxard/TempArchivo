import { readStoredContent } from "../../../../lib/content-store";
import { isR2StorageKey, readR2Object } from "../../../../lib/r2";

function responseWithNoStore(body, init) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");

  return new Response(body, {
    ...init,
    headers,
  });
}

export async function GET() {
  try {
    const content = await readStoredContent();

    if (!content) {
      return responseWithNoStore("No hay contenido guardado.", { status: 404 });
    }

    if (content.type !== "image") {
      return responseWithNoStore("El contenido actual no es una imagen.", {
        status: 415,
      });
    }

    if (content.storage === "r2" || isR2StorageKey(content.value)) {
      const object = await readR2Object(content.value);

      return responseWithNoStore(object.body, {
        status: 200,
        headers: {
          "Content-Type": object.contentType,
        },
      });
    }

    const upstreamResponse = await fetch(content.value, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
      },
    });

    if (!upstreamResponse.ok) {
      throw new Error("Could not read legacy image.");
    }

    return responseWithNoStore(await upstreamResponse.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type":
          upstreamResponse.headers.get("content-type") ||
          "application/octet-stream",
      },
    });
  } catch {
    return responseWithNoStore("No se pudo leer la imagen actual.", {
      status: 500,
    });
  }
}
