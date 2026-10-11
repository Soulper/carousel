import { ok, fail, run } from "@/lib/http";
import { enqueue } from "@/lib/jobs";
import { sourceStory } from "@/lib/source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* POST /api/source/:storyId   { overwrite?: boolean, slots?: ["3.bg"] }
   Fills the story's empty image slots from coverage of the story. Takes a
   couple of minutes, so on Netlify it runs as a background function and this
   answers 202; the browser waits on the story row (lib/client.js runJob).

   `slots` re-picks specific slots instead of the empty ones — one slide at a
   time, which is what the "Find a different photo" button sends. */
export async function POST(req, { params }) {
  return run(async () => {
    const body = await req.json().catch(() => ({}));
    const only = Array.isArray(body.slots) ? body.slots.filter((s) => typeof s === "string").slice(0, 4) : null;
    if (await enqueue("source", params.id, { overwrite: !!body.overwrite, only })) {
      return ok({ queued: true, job: "source" }, 202);
    }
    return ok(await sourceStory(params.id, { overwrite: !!body.overwrite, only }));
  });
}