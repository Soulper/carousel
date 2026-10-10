import { db } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";
import { HERO_VARIANTS } from "@/lib/carousel/constants";

export const dynamic = "force-dynamic";

export async function GET(_req, { params }) {
  return run(async () => {
    const { data, error } = await db().from("stories").select("*, pages(*), renders(id,variant,files,created_at)").eq("id", params.id).single();
    if (error) return fail("Story not found", 404);
    data.renders?.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return ok(data);
  });
}

export async function PUT(req, { params }) {
  return run(async () => {
    const body = await req.json();
    // The render route filters unknown variants out and would fail with
    // "No valid cover styles requested", so reject them here where the message
    // points at the field.
    if (body.hero_variant !== undefined && !HERO_VARIANTS.includes(body.hero_variant)) {
      return fail(`hero_variant must be one of: ${HERO_VARIANTS.join(", ")}`);
    }
    const allowed = ["title", "status", "hero_variant", "slides", "page_id", "source_url"];
    const patch = Object.fromEntries(allowed.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    const { data, error } = await db().from("stories").update(patch).eq("id", params.id).select().single();
    if (error) throw error;
    return ok(data);
  });
}
