import { createClient } from "@supabase/supabase-js";

// Server-side only. Every DB call in the app goes through API routes or
// server components, so the service key never reaches the browser.
let client;
export function db() {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: {
        // Next.js caches fetch GETs by default, and `dynamic = "force-dynamic"`
        // on a route does not reach a third-party client's own fetch calls. Left
        // uncached, a save followed by a refresh can hand back the previous
        // version of a row, which reads as "my changes disappeared".
        fetch: (url, opts) => fetch(url, { ...opts, cache: "no-store" }),
      },
    });
  }
  return client;
}

export const BUCKET = "studio";

export function publicUrl(path) {
  return db().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

// False until Supabase env vars are set (the app then runs in preview mode)
export const isConfigured = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
