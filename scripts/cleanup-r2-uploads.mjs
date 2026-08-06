import { getContentStorageKeys, readStoredContent } from "../lib/content-store.js";
import { deleteR2Object, listR2UploadKeys } from "../lib/r2.js";

const currentContent = await readStoredContent();
const protectedKeys = new Set(getContentStorageKeys(currentContent));
const uploadKeys = await listR2UploadKeys();
const orphanKeys = uploadKeys.filter((key) => !protectedKeys.has(key));

await Promise.all(orphanKeys.map((key) => deleteR2Object(key)));

console.log(`R2 cleanup complete: deleted ${orphanKeys.length} orphan upload(s), kept ${protectedKeys.size}.`);
