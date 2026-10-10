// Relative imports on purpose: the Netlify background functions in
// netlify/functions/ bundle these files directly, and esbuild doesn't know
// about the @/ alias that next.config maps.
import { db } from "./supabase";

/* Rendering and image sourcing run for minutes. Netlify's ordinary functions
   are killed well before that, so on Netlify the API route hands the work to a
   background function (netlify/functions/render.mts and source.mts), returns 202
   and lets the browser poll the story row. Everywhere else — local dev, Vercel,
   a long-lived server — the route handler just does the work inline and the
   caller gets its result straight back.

   Both paths end up in the same place: the story row carries the outcome under
   `job`, which is what the browser waits on. */

/* Netlify sets NETLIFY on every deploy, local (`netlify dev`) included. A set
   CHROME_EXECUTABLE_PATH means someone is running against their own Chrome on a
   machine that isn't Netlify, so run inline there. */
export const BACKGROUND = !!process.env.NETLIFY && !process.env.CHROME_EXECUTABLE_PATH;

const jobFunction = (kind) => `${siteUrl()}/.netlify/functions/${kind}`;

// The production site's own address. Deploy previews and branch deploys get
// DEPLOY_PRIME_URL, which is the deploy that is actually running this code.
function siteUrl() {
  const url = process.env.CONTEXT === "production" ? process.env.URL : process.env.DEPLOY_PRIME_URL;
  return (url || "").replace(/\/$/, "");
}

/* Hand the job to the background function. Returns false when this host should
   run it inline instead, which is the caller's cue to do the work itself. */
export async function enqueue(kind, id, body = {}) {
  if (!BACKGROUND) return false;
  if (!siteUrl()) return false; // nowhere to send it; better to try than to drop it
  // Mark it started before it starts: the browser is about to start polling, and
  // without this it would find the *previous* run's result and think this one
  // finished instantly.
  await setJob(id, { kind, started_at: new Date().toISOString() });
  try {
    const res = await fetch(jobFunction(kind), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.PIPELINE_API_KEY || "" },
      body: JSON.stringify({ id, ...body }),
    });
    if (!res.ok) throw new Error(`Could not start the ${kind} job (${res.status})`);
    return true;
  } catch (e) {
    await setJob(id, null);
    throw e;
  }
}

/* Where a job is up to, read by the browser while it waits:
   { kind, started_at, result } on success, { kind, started_at, error } on
   failure. Only one job per story is expected at a time — the UI runs them one
   after another — so the column is simply overwritten. */
export async function setJob(id, job) {
  const { error } = await db().from("stories").update({ job }).eq("id", id);
  if (error) console.error("jobs: could not record job state", error);
}

/* Thrown for the things a user can fix ("no photos found"), as opposed to a
   crash. `status` keeps the HTTP code the API route hands back. */
export class JobError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}