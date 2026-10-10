import { setJob } from "../../lib/jobs";
import { isConfigured } from "../../lib/supabase";
import { renderStory } from "../../lib/render";

/* Rendering takes minutes: Chromium has to start, the whole deck loads, every
   slide is screenshotted and uploaded. Netlify cuts an ordinary request off
   long before that, so this runs as a background function — fifteen minutes,
   and the caller gets its 202 straight away.

   The API route (/api/render/:id) hands work here and the browser waits on the
   story row, so everything this function returns is discarded. What matters is
   what it leaves behind: renders rows, and `story.job` recording how it went. */
export const config = { background: true };

export default async (req: Request) => {
  // Not behind middleware.js: function URLs are routed to the function, not
  // through Next, so the studio login is checked here instead. The only caller
  // is our own API route, which signs with the pipeline key.
  if (!process.env.PIPELINE_API_KEY || req.headers.get("x-api-key") !== process.env.PIPELINE_API_KEY) {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }

  const { id, variants } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ error: "No story id" }, { status: 400 });

  const started_at = new Date().toISOString();
  if (!isConfigured()) return Response.json({ error: "Supabase is not configured" }, { status: 503 });

  try {
    const result = await renderStory(id, variants);
    await setJob(id, { kind: "render", started_at, finished_at: new Date().toISOString(), result });
    return Response.json(result);
  } catch (e) {
    console.error("render job failed", e);
    await setJob(id, { kind: "render", started_at, finished_at: new Date().toISOString(), error: message(e) });
    // Answered, not thrown: a thrown error makes Netlify retry the function,
    // and a retry would render the deck a second time and bill it twice.
    return Response.json({ error: message(e) }, { status: 200 });
  }
};

function message(e) {
  return e?.message || "The render failed";
}