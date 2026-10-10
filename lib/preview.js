import sampleStory from "@/samples/story_comedy_wildlife_2026.json";

/* Preview mode: on while isConfigured() in lib/supabase.js is false, so the
   studio can be deployed and browsed before the database exists. Pages load
   sample data, and anything that writes (save, upload, render, sourcing) is
   blocked with a message instead of touching the database.
   No imports from lib/supabase here: the editors pull BLOCKED into the browser. */
const ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "ANTHROPIC_API_KEY"];

// Server only. Names, never values.
export const missingEnv = () => ENV.filter((k) => !process.env[k]);

export const PREVIEW_MESSAGE = "Preview mode: this needs Supabase connected (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).";
export const BLOCKED = {
  save: "Preview mode: saving needs Supabase connected.",
  upload: "Preview mode: uploads need Supabase connected.",
  render: "Preview mode: rendering needs Supabase connected.",
  source: "Preview mode: finding images needs Supabase and the Anthropic API connected.",
  copy: "Preview mode: writing text needs Supabase and the Anthropic API connected.",
};

export const SAMPLE_ID = "sample";

export const samplePage = () => ({ id: SAMPLE_ID, name: "Sample page", handle: "@sample", brand: {} });

export const sampleStoryRow = () => ({
  ...structuredClone(sampleStory),
  id: SAMPLE_ID,
  page_id: SAMPLE_ID,
  status: sampleStory.status || "draft",
  updated_at: new Date().toISOString(),
  renders: [],
});
