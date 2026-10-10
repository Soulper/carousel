import { ok, run } from "@/lib/http";
import { enqueue } from "@/lib/jobs";
import { renderStory } from "@/lib/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* POST /api/render/:storyId   { variants?: ["depth", "band", ...] }
   Renders each requested cover style plus the rest of the slides, uploads JPGs
   to storage, records a row in `renders` per variant.

   On Netlify the request can't stay open long enough for the work, so it goes
   to a background function and this answers 202; the browser waits on the
   story row instead (lib/client.js runJob). */
export async function POST(req, { params }) {
  return run(async () => {
    const body = await req.json().catch(() => ({}));
    if (await enqueue("render", params.id, { variants: body.variants })) return ok({ queued: true, job: "render" }, 202);
    return ok(await renderStory(params.id, body.variants));
  });
}