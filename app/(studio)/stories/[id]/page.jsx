import { notFound } from "next/navigation";
import { db, isConfigured } from "@/lib/supabase";
import StoryEditor from "./StoryEditor";
import { samplePage, sampleStoryRow } from "@/lib/preview";

export const dynamic = "force-dynamic";

export default async function StoryPage({ params }) {
  if (!isConfigured()) return <StoryEditor story={sampleStoryRow()} pages={[samplePage()]} preview />;
  const [{ data: story }, { data: pages = [] }] = await Promise.all([
    db().from("stories").select("*, renders(id,variant,files,created_at)").eq("id", params.id).single(),
    db().from("pages").select("id,name,brand").order("name"),
  ]);
  if (!story) notFound();
  story.renders?.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return <StoryEditor story={story} pages={pages} />;
}
