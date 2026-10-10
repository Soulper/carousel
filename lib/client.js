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
let sb;
const supabase = () =>
  (sb ||= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  }));

export async function upload(file, folder) {
  const slot = await api("/api/upload", { method: "POST", body: { name: file.name, folder } });
  const { error } = await supabase().storage.from("studio").uploadToSignedUrl(slot.path, slot.token, file, {
    contentType: file.type || "application/octet-stream",
  });
  if (error) throw new Error(error.message || "Upload failed");
  return slot.url;
}
