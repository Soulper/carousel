import { createClient } from "@supabase/supabase-js";

// Tiny fetch helpers for client components
export async function api(path, { method = "GET", body } = {}) {
  // Resolve against location.origin rather than passing the path bare. If the
  // page was opened as http://user:pass@host/, a relative path would inherit
  // those credentials and Chrome refuses to build the request ("Request cannot
  // be constructed from a URL that includes credentials"), which takes down
  // every call in the app. location.origin never carries them.
  const url = /^https?:/i.test(path) ? path : new URL(path, window.location.origin).toString();
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Browser-side Supabase client, used only to upload into a signed slot.
// The anon key is public by design; the database itself denies it (RLS, no policies).
// NEXT_PUBLIC_* values are inlined into the bundle at BUILD time — a deploy
// built without them still runs fine server-side, and only uploads break here.
let sb;
const supabase = () => {
  if (sb) return sb;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Uploads aren't configured in this build: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY were missing when the app was built. Set both (Netlify → Site configuration → Environment variables, or .env.local) and redeploy/restart — adding them alone isn't enough, the bundle must be rebuilt."
    );
  }
  sb = createClient(url, key, { auth: { persistSession: false } });
  return sb;
};

/* Kick off a long job — render, source — and wait for it.
   On a host that can hold a request open the result comes straight back. On
   Netlify the route hands the work to a background function and answers 202,
   so the wait moves here: poll the story row until the job records a result or
   an error. Background functions get fifteen minutes, hence the wait. */
export async function runJob(path, id, body = {}) {
  const started = await api(path, { method: "POST", body });
  if (!started.queued) return started;

  const deadline = Date.now() + 16 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const story = await api(`/api/stories/${id}`);
    if (story.job?.error) throw new Error(story.job.error);
    if (story.job?.result) return { ...story.job.result, story };
    if (Date.now() > deadline) {
      throw new Error("Still running in the background. It will finish on its own — reload this page in a minute to see it.");
    }
  }
}

export async function upload(file, folder) {
  const slot = await api("/api/upload", { method: "POST", body: { name: file.name, folder } });
  const { error } = await supabase().storage.from("studio").uploadToSignedUrl(slot.path, slot.token, file, {
    contentType: file.type || "application/octet-stream",
  });
  if (error) throw new Error(error.message || "Upload failed");
  return slot.url;
}
