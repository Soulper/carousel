import { setJob } from "../../lib/jobs";
import { isConfigured } from "../../lib/supabase";
import { sourceStory } from "../../lib/source";

/* Image sourcing searches the web with Claude, downloads press photos, looks at
   them and rewrites the slides — a couple of minutes. Too long for a Netlify
   request, so it runs as a background function. See render.mts for the shape;
   this one differs only in what it leaves on the story row: the new slides,
   sourced_at and source_meta, plus `job.result` with the counts the editor
   reports back to you. */
export const config = { background: true };

export default async (req: Request) => {
  if (!process.env.PIPELINE_API_KEY || req.headers.get("x-api-key") !== process.env.PIPELINE_API_KEY) {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }

  const { id, overwrite, only } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ error: "No story id" }, { status: 400 });

  const started_at = new Date().toISOString();
  if (!isConfigured()) return Response.json({ error: "Supabase is not configured" }, { status: 503 });

  try {
    const result = await sourceStory(id, { overwrite: !!overwrite, only: Array.isArray(only) ? only : null });
    await setJob(id, { kind: "source", started_at, finished_at: new Date().toISOString(), result });
    return Response.json(result);
  } catch (e) {
    console.error("source job failed", e);
    await setJob(id, { kind: "source", started_at, finished_at: new Date().toISOString(), error: message(e) });
    return Response.json({ error: message(e) }, { status: 200 });
  }
};

function message(e) {
  return e?.message || "Image sourcing failed";
}