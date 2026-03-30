import HomeClient from "./home-client";
import { readStoredContent } from "../lib/content-store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let initialContent = null;

  try {
    initialContent = await readStoredContent();
  } catch {
    initialContent = null;
  }

  return <HomeClient initialContent={initialContent} />;
}
