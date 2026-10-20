import { db, isConfigured } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";
import { setJob } from "@/lib/jobs";
import { generateStory, quotaRemaining } from "@/lib/topic";
import { writeCopy } from "@/lib/copy";
import { sourceStory } from "@/lib/source";
import { renderStory } from "@/lib/render";
import { publishCarousel, igConfigured } from "@/lib/instagram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* POST /api/cron/tick   header x-api-key: PIPELINE_API_KEY
   { story_id?: string }  — force one specific story

   The autopilot heartbeat. The scheduler (GitHub Actions cron, every 15
   minutes) calls this around the clock; each call does exactly ONE unit of
   work, because a story's steps together take longer than one invocation may
   run. Each step also fits inside maxDuration, so no background machinery is
   needed on Vercel.

   The pipeline, oldest due first:
     1. post      a rendered story whose scheduled_at has passed
     2. copy      a story whose slides have no words yet
     3. source    a story whose photo slots are empty
     4. render    a sourced story with no rendered images
     5. generate  when the page is under quota and nothing is waiting

   Every outcome lands on stories.job the same way the browser-driven jobs do,
   so /queue is the failure board. Steps that finish leave job null; failures
   leave { kind, error } and the story shows up in the failure board. */
export async function POST(req) {
  return run(async () => {
    if (!isConfigured()) return fail("Connect Supabase first", 503);
    const { story_id } = await req.json().catch(() => ({}));

    // The in-flight lock: a story whose job started under 15 minutes ago and
    // has no result or error yet is being worked by another tick. Overlapping
    // steps would double-render and double-post.
    const LOCK_MS = 15 * 60 * 1000;
    const locked = (s) =>
      s.job?.started_at && !s.job.result && !s.job.error &&
      Date.now() - new Date(s.job.started_at).getTime() < LOCK_MS;

    // ---- 1. due posts first, so slot times are honoured
    if (igConfigured()) {
      const due = await candidates(["rendered"]);
      for (const s of due) {
        if (locked(s) || !dueNow(s)) continue;
        return await withJob(s, "post", () => post(s));
      }
    }

    // ---- 2-4. the factory: one step on the oldest story that needs it
    const pending = await candidates(["draft", "ready"]);
    for (const s of pending) {
      if (locked(s)) continue;
      if (story_id && s.id !== story_id) continue;
      const step = nextStep(s);
      if (!step) continue;
      return await withJob(s, step, () => runStep(step, s));
    }

    // ---- 5. generation, when under quota and nothing else to do
    if (!story_id) {
      const pages = await activePages();
      for (const p of pages) {
        const remaining = await quotaRemaining(p);
        if (remaining <= 0) continue;
        const scheduled = pending.filter((s) => s.page_id === p.id).length;
        if (scheduled >= remaining) continue;
        const row = await withJob({ id: p.id, job: null }, "generate", () => generateStory(p), p.id);
        return ok({ step: "generate", story: row }, 201);
      }
    }

    return ok({ idle: true });
  });
}

/* GET /api/cron/tick — readiness summary for the cockpit: which parts of the
   autopilot can run, and whether a scheduler is plausibly calling in. */
export async function GET() {
  return run(async () => {
    if (!isConfigured()) return fail("Connect Supabase first", 503);
    const pages = await activePages();
    const pending = await candidates(["draft", "ready"]);
    const rendered = await candidates(["rendered"]);
    return ok({
      autopilot_pages: pages.length,
      configured: {
        supabase: true,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        instagram: igConfigured(),
      },
      pending: pending.length,
      awaiting_post: rendered.filter(dueNow).length,
    });
  });
}

/* Stories that could use a step, oldest scheduled first. Pending ones join
   their page so the topic finder and step pickers can see the config. */
async function candidates(statuses) {
  const { data, error } = await db()
    .from("stories")
    .select("id,page_id,title,status,hero_variant,slides,caption,scheduled_at,sourced_at,job,created_at,pages(config)")
    .in("status", statuses)
    .order("scheduled_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(60);
  if (error) throw error;
  return data || [];
}

async function activePages() {
  const { data, error } = await db().from("pages").select("id,name,handle,config");
  if (error) throw error;
  return (data || []).filter((p) => p.config?.autopilot !== false);
}

/* What does this story still need? Copy comes before sourcing because the
   sourcer matches photos against the slide text. */
function nextStep(s) {
  const slides = Array.isArray(s.slides) ? s.slides : [];
  if (!slides.length) return null;
  const lacksWords = slides.some((sl) =>
    sl.layout === "cover" ? !(sl.headline || "").trim() : !(sl.title || "").trim() || !(sl.body || "").trim());
  if (lacksWords) return "copy";
  if (!s.sourced_at) return "source";
  return "render";
}

async function runStep(step, s) {
  if (step === "copy") {
    const r = await writeCopy(s.id, { hashtags: s.pages?.config?.hashtags || "" });
    return { step, written: r.written ?? 0, caption: !!r.caption };
  }
  if (step === "source") {
    const r = await sourceStory(s.id);
    return { step, message: r.message || "sourced" };
  }
  if (step === "render") {
    const r = await renderStory(s.id, [s.hero_variant]);
    return { step, renders: r.renders.length };
  }
  throw new Error(`Unknown step ${step}`);
}

async function post(s) {
  const { data: latest } = await db()
    .from("renders")
    .select("id,variant,files,created_at")
    .eq("story_id", s.id)
    .order("created_at", { ascending: false })
    .limit(1);
  const files = latest?.[0]?.files || [];
  if (files.length < 2) {
    await db().from("stories").update({ status: "rejected" }).eq("id", s.id);
    throw new Error("Rendered with fewer than two images; not posting.");
  }
  const caption = (s.caption || s.slides?.[0]?.headline || s.title || "").trim();
  if (!caption) {
    await db().from("stories").update({ status: "rejected" }).eq("id", s.id);
    throw new Error("No caption written; not posting.");
  }
  const mediaId = await publishCarousel({ files, caption });
  await db().from("stories").update({ status: "posted", posted_at: new Date().toISOString(), ig_media_id: mediaId, job: null }).eq("id", s.id);
  return { step: "post", media_id: mediaId };
}

const dueNow = (s) => s.scheduled_at && new Date(s.scheduled_at) <= new Date();

/* Wrap a step: record the job started, clear it on success, leave the error on
   failure (the same shape the browser polling and /queue already read). */
async function withJob(story, kind, fn, pageId = null) {
  const started = { kind, started_at: new Date().toISOString() };
  if (pageId) {
    // Generation has no story row yet; failures only surface in the tick's
    // own response and the function logs.
    try {
      const result = await fn();
      return result;
    } catch (e) {
      console.error(`tick: ${kind} failed for page ${pageId}:`, e.message);
      throw e;
    }
  }
  await setJob(story.id, started);
  try {
    const result = await fn();
    await setJob(story.id, null);
    return ok({ step: kind, story_id: story.id, result });
  } catch (e) {
    await setJob(story.id, { ...started, error: e.message });
    throw e;
  }
}
