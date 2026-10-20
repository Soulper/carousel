import { db } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";
import { writeCopy } from "@/lib/copy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/* POST /api/copy/:storyId   { overwrite?: boolean }
   Writes the words for every slide and the Instagram caption. The body lives
   in lib/copy.js so the tick loop and background functions can run the same
   code outside Next. */
export async function POST(req, { params }) {
  return run(async () => {
    const { overwrite = false } = await req.json().catch(() => ({}));
    const { data: story } = await db().from("stories").select("id, pages(config)").eq("id", params.id).single();
    if (!story) return fail("Story not found", 404);
    const hashtags = story.pages?.config?.hashtags || "";
    return ok(await writeCopy(params.id, { overwrite, hashtags }));
  });
}
