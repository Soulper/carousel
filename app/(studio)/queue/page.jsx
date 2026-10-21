import { db, isConfigured } from "@/lib/supabase";
import sample from "@/samples/story_comedy_wildlife_2026.json";
import Queue from "./Queue";

export const dynamic = "force-dynamic";

// The board: work in progress, plus recently posted and failed stories so
// the tabs are honest about what the autopilot did and what it dropped.
const PENDING = ["draft", "ready", "rendered", "approved"];
const LIMIT = 60;

// Plain words for the statuses the DB stores, so the UI doesn't say "draft".
const LABEL = {
  draft: "New",
  ready: "Photos ready",
  rendered: "Images made",
  approved: "Approved",
  posted: "Posted",
  rejected: "Rejected",
};

export default async function QueuePage() {
  if (!isConfigured()) {
    const demo = {
      ...sample, id: "sample", page_id: "sample", status: "draft", updated_at: new Date().toISOString(),
      sourced_at: new Date().toISOString(), source_meta: { lowRes: false, kept: 7, candidates: 9 },
      pages: { id: "sample", name: "Sample page", brand: {} }, renders: [],
    };
    return <Queue initial={[demo]} labels={LABEL} preview />;
  }
  const select = "id,title,status,hero_variant,slides,caption,source_url,sourced_at,source_meta,scheduled_at,posted_at,job,updated_at,pages(id,name,brand)";
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [{ data: pending, error }, { data: done, error: doneErr }] = await Promise.all([
    db().from("stories").select(select).in("status", PENDING).order("updated_at", { ascending: false }).limit(LIMIT),
    db().from("stories").select(select).in("status", ["posted", "rejected"]).gte("updated_at", since).order("updated_at", { ascending: false }).limit(20),
  ]);
  if (error || doneErr) throw error || doneErr;
  const rows = [...(pending || []), ...(done || [])];

  // Only the newest render per story is ever shown, and each one carries a
  // file list, so embedding every render of every story bloats the payload.
  // One windowed query over just this page's stories instead.
  const ids = rows.map((s) => s.id);
  const byStory = new Map(rows.map((s) => [s.id, { ...s, renders: [] }]));
  if (ids.length) {
    const { data: renders } = await db()
      .from("renders")
      .select("id,story_id,variant,files,created_at")
      .in("story_id", ids)
      .order("created_at", { ascending: false });
    for (const r of renders || []) {
      const s = byStory.get(r.story_id);
      if (s && !s.renders.length) s.renders.push({ id: r.id, variant: r.variant, files: r.files, created_at: r.created_at });
    }
  }
  return <Queue initial={[...byStory.values()]} labels={LABEL} />;
}
