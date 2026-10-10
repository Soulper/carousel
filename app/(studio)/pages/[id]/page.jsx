import { notFound } from "next/navigation";
import { db, isConfigured } from "@/lib/supabase";
import BrandEditor from "./BrandEditor";
import { blankSlides } from "@/lib/carousel/blank";
import { samplePage, sampleStoryRow } from "@/lib/preview";

export const dynamic = "force-dynamic";

export default async function PageEditor({ params }) {
  if (!isConfigured()) return <BrandEditor page={samplePage()} previewStoryId={null} previewSlides={sampleStoryRow().slides} preview />;
  const { data: page } = await db().from("pages").select("*").eq("id", params.id).single();
  if (!page) notFound();
  // Preview with this page's latest story so you judge the brand on real content
  const { data: latest } = await db().from("stories").select("id,slides").eq("page_id", page.id)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  return (
    <BrandEditor
      page={page}
      previewStoryId={latest?.id || null}
      previewSlides={latest?.slides?.length ? latest.slides : blankSlides()}
    />
  );
}
