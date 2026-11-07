import { db } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";
import { generateStory } from "@/lib/topic";

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

/* Two ways in:
   - { generate: true, page_id, details? }  — the studio's one-click
     "Create carousel". The topic finder (the same code the autopilot uses)
     picks a fresh story worth posting — steered by `details` when given —
     with photo queries per slide; the editor's auto-run then writes the
     words, sources the photos and renders the images.
   - { page_id, title, slides, ... } — your pipeline posting a finished story.
     Header x-api-key: PIPELINE_API_KEY */
export async function POST(req) {
  return run(async () => {
    const body = await req.json().catch(() => ({}));
    if (body.generate) {
      if (!body.page_id) return fail("page_id is required");
      const { data: page } = await db()
        .from("pages")
        .select("id,name,handle,config")
        .eq("id", body.page_id)
        .single();
      if (!page) return fail("Page not found", 404);
      const row = await generateStory(page, body.details || "");
      return ok(row, 201);
    }
    const { page_id, title, slides = [], caption, hero_variant = "depth", source_url, status = "draft" } = body;
    if (!page_id) return fail("page_id is required");
    if (!Array.isArray(slides)) return fail("slides must be an array");
    const { data, error } = await db()
      .from("stories")
      .insert({ page_id, title: title || slides[0]?.headline || "Untitled story", slides, caption, hero_variant, source_url, status })
      .select()
      .single();
    if (error) throw error;
    return ok(data, 201);
  });
}
