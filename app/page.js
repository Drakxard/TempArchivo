import HomeClient from "./home-client";
import { readResolvedContent } from "../lib/content-store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let initialContent = null;

  try {
    initialContent = await readResolvedContent();
  } catch {
    initialContent = null;
  }

  return <HomeClient initialContent={initialContent} />;
}
