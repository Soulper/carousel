import { ok, run } from "@/lib/http";
import { enqueue } from "@/lib/jobs";
import { sourceStory } from "@/lib/source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* POST /api/source/:storyId  { overwrite?: boolean }
   Fills the story's empty image slots from coverage of the story. Takes a
   couple of minutes, so on Netlify it runs as a background function and this
   answers 202; the browser waits on the story row (lib/client.js runJob). */
export async function POST(req, { params }) {
  return run(async () => {
    const body = await req.json().catch(() => ({}));
    if (await enqueue("source", params.id, { overwrite: !!body.overwrite })) return ok({ queued: true, job: "source" }, 202);
    return ok(await sourceStory(params.id, { overwrite: !!body.overwrite }));
  });
}