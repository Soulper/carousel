// Relative imports on purpose (see jobs.js): bundled outside Next.
import { db } from "./supabase";
import { claude, parseJson } from "./anthropic";
import { JobError } from "./jobs";

/* The autopilot's topic finder. Reads the page's config, asks Claude to pick
   ONE fresh story from the configured niches/sources (fetching the article to
   check it's real), and returns a story skeleton: title, source_url and slides
   with cover + body placeholders carrying photo *queries* — no images yet.
   The sourcer fills those in; the copywriter writes the words. */

export const DEFAULT_CONFIG = {
  autopilot: true,
  posts_per_day: 12,
  // Posting slots in UTC ("HH:MM"). Empty → spread evenly 08:00–22:00.
  slots: [],
  topics: [],
  sources: [],
  banned: [],
  hashtags: "",
  tone: "",
};

export function pageConfig(page) {
  return { ...DEFAULT_CONFIG, ...(page?.config || {}) };
}

/* Today's remaining slots, as Date objects. Explicit `slots` win; otherwise
   posts_per_day times spread evenly across 08:00–22:00 UTC. Slots already in
   the past today are dropped — we never schedule a post retroactively. */
export function todaysSlots(config, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const times = (config.slots?.length
    ? config.slots
    : Array.from({ length: config.posts_per_day || 12 }, (_, i) => {
        const mins = Math.round(8 * 60 + ((14 * 60) / (config.posts_per_day || 12)) * i);
        return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      })
  ).map((t) => new Date(`${day}T${t}:00Z`));
  return times.filter((t) => t > now).sort((a, b) => a - b);
}

/* Pick one story and insert it. Returns the new row. Throws JobError with a
   message a human could act on when nothing worth posting turns up. */
export async function generateStory(page) {
  const cfg = pageConfig(page);
  if (!process.env.ANTHROPIC_API_KEY) throw new JobError("Set ANTHROPIC_API_KEY to generate topics", 503);

  // What has this page already covered? Skip anything similar.
  const { data: recent } = await db()
    .from("stories")
    .select("title,source_url,created_at")
    .eq("page_id", page.id)
    .order("created_at", { ascending: false })
    .limit(120);

  const picked = parseJson(await claude({
    system:
      "You are the editor of an Instagram photo-carousel account. Pick ONE story worth turning into today's carousel.\n\n" +
      "The account's beats: " + (cfg.topics.join(", ") || "visually striking news stories with strong photography") + ".\n" +
      (cfg.sources.length ? "Prefer stories from these sources, but anything on-beat from a reputable outlet wins: " + cfg.sources.join(", ") + "\n" : "") +
      (cfg.tone ? `Tone: ${cfg.tone}\n` : "") +
      (cfg.banned.length ? "Never pick: " + cfg.banned.join("; ") + "\n" : "") +
      "\nRules:\n" +
      "- The story MUST have, or very likely have, 4-8 strong photographs. A carousel lives or dies on the pictures.\n" +
      "- Search the web, then FETCH the article you pick and confirm it is real, current (last 5 days) and photo-rich. Never invent an article or a URL.\n" +
      "- Do not repeat or rehash these recent stories: " +
        (recent || []).map((s) => s.title).filter(Boolean).slice(0, 40).join(" | ") + "\n" +
      "- Avoid opinion, tragedy and anything you couldn't caption factually.\n\n" +
      "From the article, list 5-7 photo moments the carousel's slides would show, in order, starting with the single most " +
      "scroll-stopping image. For each, write a 'query' — a concrete description of the photo to hunt for, including the " +
      "photographer's name if the article credits one.\n\n" +
      'Reply with only JSON: {"title":"...","source_url":"https://...","summary":"2-3 sentences of what the article says","slides":[{"query":"..."}],"why":"one line on why this will perform"}',
    messages: [{
      role: "user",
      content:
        "Pick today's story. Today is " + new Date().toISOString().slice(0, 10) + ".",
    }],
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: 6 },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: 6 },
    ],
    maxTokens: 4000,
    label: `topic ${page.id.slice(0, 8)}`,
  }));

  if (!picked?.title || !picked?.source_url) {
    throw new JobError("No usable story found this round. Check the page's topics/sources, or try again.", 422);
  }
  if ((recent || []).some((s) => s.source_url && s.source_url === picked.source_url)) {
    throw new JobError("Picked a story this page already covered. Try again.", 409);
  }
  const moments = (picked.slides || []).filter((s) => (s.query || "").trim());
  if (moments.length < 3) {
    throw new JobError(`"${picked.title}" doesn't have enough photo moments for a carousel.`, 422);
  }

  // Skeleton: a cover slot plus one body slot per photo moment. The sourcer
  // fills bg.src; the copywriter fills headline/title/body from the queries.
  const slides = [
    { layout: "cover", headline: "", bg: { query: moments[0].query, caption: picked.summary } },
    ...moments.slice(1).map((m) => ({ layout: "body", title: "", body: "", bg: { query: m.query, caption: picked.summary } })),
  ];

  // Claim the next open slot today, else a slot tomorrow.
  const scheduled_at = await nextFreeSlot(page, cfg);

  const { data: row, error } = await db()
    .from("stories")
    .insert({ page_id: page.id, title: picked.title, source_url: picked.source_url, slides, status: "draft", scheduled_at })
    .select()
    .single();
  if (error) throw error;
  return row;
}

/* Earliest slot today that no other story holds; the first free one tomorrow
   if today is fully booked. Called inside generateStory after a pick succeeds. */
async function nextFreeSlot(page, cfg) {
  const taken = new Set();
  const from = new Date(Date.now() - 48 * 3600e3).toISOString();
  const { data: busy } = await db()
    .from("stories")
    .select("scheduled_at")
    .eq("page_id", page.id)
    .gte("scheduled_at", from);
  (busy || []).forEach((s) => s.scheduled_at && taken.add(s.scheduled_at));

  const candidates = todaysSlots(cfg).map((d) => d.toISOString());
  const free = candidates.find((t) => !taken.has(t));
  if (free) return free;
  // Today is booked: spread the overflow across tomorrow's slots.
  const tomorrow = new Date(Date.now() + 24 * 3600e3);
  const tmr = todaysSlots(cfg, tomorrow).map((d) => d.toISOString());
  return tmr.find((t) => !taken.has(t)) || tmr[0] || new Date(Date.now() + 2 * 3600e3).toISOString();
}

/* How many more stories does this page need today to hit its quota? */
export async function quotaRemaining(page) {
  const cfg = pageConfig(page);
  if (cfg.autopilot === false) return 0;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db()
    .from("stories")
    .select("id", { count: "exact", head: true })
    .eq("page_id", page.id)
    .gte("created_at", dayStart.toISOString());
  if (error) throw error;
  return Math.max(0, (cfg.posts_per_day || 12) - (count || 0));
}
