import { db } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req) {
  return run(async () => {
    const pageId = new URL(req.url).searchParams.get("page_id");
    let q = db().from("stories").select("id,title,status,hero_variant,page_id,updated_at,pages(name)").order("updated_at", { ascending: false }).limit(100);
    if (pageId) q = q.eq("page_id", pageId);
    const { data, error } = await q;
    if (error) throw error;
    return ok(data);
  });
}

/* Your pipeline posts finished stories here:
   POST /api/stories   header x-api-key: PIPELINE_API_KEY
   { page_id, title, slides: [...], hero_variant?, source_url?, status? } */
export async function POST(req) {
  return run(async () => {
    const { page_id, title, slides = [], hero_variant = "depth", source_url, status = "draft" } = await req.json();
    if (!page_id) return fail("page_id is required");
    if (!Array.isArray(slides)) return fail("slides must be an array");
    const { data, error } = await db()
      .from("stories")
      .insert({ page_id, title: title || slides[0]?.headline || "Untitled story", slides, hero_variant, source_url, status })
      .select()
      .single();
    if (error) throw error;
    return ok(data, 201);
  });
}
