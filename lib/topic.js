// Relative imports on purpose (see jobs.js): bundled outside Next.
import { db } from "./supabase";
import { ai, provider, aiConfigured, groundedHosts } from "./ai";
import { webSearch } from "./search";
import { parseJson } from "./anthropic";
import { articleText } from "./copy";
import { JobError } from "./jobs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const path = (u) => { try { return new URL(u).pathname.replace(/\.html?$/i, "").replace(/\/+$/, ""); } catch { return ""; } };
// A section, tag, author or home page — not an article.
// Deliberately NOT "news" or "latest": plenty of real articles live under
// /news/, and flagging those rejects good sources.
const isListing = (u) => /\/(category|categories|tag|tags|topics|section|sections|author|authors|search|archive|archives)(\/|$)/i.test(path(u));

/* Does this URL resolve to a real ARTICLE? Free providers have no search
   grounding, so their source_url can be invented — and a dead article often
   redirects to the site's category page while still answering 200. Writing
   from that produces copy about the sidebar, so a redirect to a listing (or
   any path that isn't the one asked for) counts as a miss. */
async function urlOk(url) {
  if (!/^https?:/i.test(url || "")) return false;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/html/i.test(type)) return false;
    if (isListing(res.url)) return false;
    // A home page or a bare section has one path segment; a real article has
    // its slug in there too.
    if (path(res.url).split("/").filter(Boolean).length < 2) return false;
    const want = path(url), got = path(res.url);
    return !want || !got || want === got;
  } catch {
    return false;
  }
}

// Does the article text actually talk about the subject? ESPN answers ANY
// invented story ID with a 200 page full of OTHER stories' headlines, so
// readable-but-wrong text exists and the sidebar-echo bug comes back without
// this check. Fraction of the subject's words appearing in the body.
const subjectHits = (text, subject) => {
  const words = [...new Set((subject || "").toLowerCase().match(/[a-z0-9]{4,}/g) || [])];
  if (!words.length) return 0;
  const body = (text || "").toLowerCase();
  return words.filter((w) => body.includes(w)).length;
};

const readable = async (url, subject = "") => {
  if (!(await urlOk(url))) return false;
  const text = await articleText(url).catch(() => "");
  if (text.length <= 400) return false;
  if (subject) {
    /* Two matches minimum — ESPN's echo pages rarely share even one of the
       title's specific words (team, city, player), while a real article on
       the subject usually shares several. */
    const words = (subject.match(/[a-z0-9]{4,}/g) || []).length;
    const need = Math.max(2, Math.min(4, Math.ceil(words * 0.3)));
    if (subjectHits(text, subject) < need) return false;
  }
  return true;
};

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

/* Pick one story and insert it. `brief` is the user's own instruction from
   the Create carousel box — optional; empty means "you pick, editor".
   Returns the new row. Throws JobError with a message a human could act on
   when nothing worth posting turns up. */
export async function generateStory(page, brief) {
  brief = (brief || "").trim();
  const cfg = pageConfig(page);
  if (!aiConfigured()) throw new JobError("Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or a free provider key (GROQ_API_KEY / GITHUB_TOKEN / MISTRAL_API_KEY / CEREBRAS_API_KEY / OPENROUTER_API_KEY) to generate topics", 503);

  // What has this page already covered? Skip anything similar.
  const { data: recent } = await db()
    .from("stories")
    .select("title,source_url,created_at")
    .eq("page_id", page.id)
    .order("created_at", { ascending: false })
    .limit(120);

  // Grounded providers actually search; free text providers must NOT be told
  // to search — Groq's gpt-oss owns an internal browser tool and will try to
  // call one it was never given ("Tool choice is none…"), failing the call.
  const grounded = provider() === "gemini";

  const aiResult = await ai({
    system:
      "You are the editor of an Instagram photo-carousel account. Pick ONE story worth turning into today's carousel.\n\n" +
      "The account is called \"" + (page.name || "unnamed") + "\"" +
      (page.handle ? " (" + page.handle + ")" : "") + " — its name is the strongest signal of what its followers expect.\n" +
      "Its beats: " + (cfg.topics.join(", ") || "whatever stories best fit the account's name and vibe — visually striking, strong photography") + ".\n" +
      (cfg.sources.length ? "Prefer stories from these sources, but anything on-beat from a reputable outlet wins: " + cfg.sources.join(", ") + "\n" : "") +
      (cfg.tone ? `Tone: ${cfg.tone}\n` : "") +
      (cfg.banned.length ? "Never pick: " + cfg.banned.join("; ") + "\n" : "") +
      (brief
        ? `\nThe user has requested this story: "${brief}"\n` +
          "Build today's carousel on that subject: name the best current, photo-rich article matching it. " +
          "Everything else still applies — the story must be REAL, current and photo-rich; never invent an article to satisfy the request. " +
          "If nothing real and current exists close to it, pick the nearest on-beat story to this subject rather than something unrelated.\n"
        : "") +
      "\nRules:\n" +
      "- The story MUST have, or very likely have, 4-8 strong photographs. A carousel lives or dies on the pictures.\n" +
      (grounded
        ? "- Search the web, then confirm the article you pick is real, current (last 5 days) and photo-rich. Never invent an article or a URL: the source_url MUST be one of the pages surfaced by your search.\n"
        // Ungrounded providers get wording with zero search verbs — the
        // pipeline verifies whatever they name and finds a better article for
        // the subject itself if the URL doesn't check out.
        : "- You have no browsing tool. Pick a story you are confident ran in the last few days on-beat, from a real reputable outlet, and give its article URL exactly as that site would form it. The pipeline verifies the URL and can substitute a real article on your chosen subject — so the TITLE and SLIDE QUERIES must describe the story you mean, not the URL's wording.\n" +
          "- Never mention tools, utilities or external lookups in your reply; reply with only the JSON.\n") +
      "- Do not repeat or rehash these recent stories: " +
        (recent || []).map((s) => s.title).filter(Boolean).slice(0, 40).join(" | ") + "\n" +
      "- Avoid opinion, tragedy and anything you couldn't caption factually.\n" +
      "- A carousel needs 5-7 genuinely DIFFERENT pictures: distinct scenes, subjects and moments. If a story's imagery " +
      "is one famous painting, engraving, map or logo shown in different crops and scans, it is a BAD topic — skip it, " +
      "no matter how good the story reads. When unsure, check the article's images before committing.\n\n" +
      'Reply with only JSON: {"title":"...","source_url":"https://...","summary":"2-3 sentences of what the article says","slides":[{"query":"..."}],"why":"one line on why this will perform"}',
    messages: [{
      role: "user",
      content: brief
        ? `The user wants today's carousel to be about: "${brief}". Name a real, current, photo-rich article on that subject. Today is ${new Date().toISOString().slice(0, 10)}.`
        : "Pick today's story. Today is " + new Date().toISOString().slice(0, 10) + ".",
    }],
    tools: "search",
    maxTokens: 4000,
    label: `topic ${page.id.slice(0, 8)}`,
  });
  const picked = parseJson(aiResult.text);

  if (!picked?.title || !picked?.source_url) {
    throw new JobError("No usable story found this round. Check the page's topics/sources, or try again.", 422);
  }
  // On the grounded provider the URL must trace back to a real search result,
  // otherwise the model invented the article.
  if (provider() === "gemini" && aiResult.sources.length) {
    const hosts = await groundedHosts(aiResult.sources);
    const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };
    if (hosts.size && !hosts.has(host(picked.source_url))) {
      throw new JobError("The topic picker returned an article that search couldn't confirm. Trying again.", 502);
    }
  }
  /* Grounding or not, the article has to actually load and be READABLE. A
     model-named URL with no search behind it (a free provider, or Gemini
     without sources) is often invented, and a 200 shell page or a category
     redirect would still pass a pure "loads" check. */
  const subject = `${brief ? brief.replace(/\s+/g, " ") + " " : ""}${picked.title}`;
  if (!(await readable(picked.source_url, subject))) {
    /* The model's pick couldn't be confirmed. Recover here instead of failing
       the button: search the web for a real article on the subject, the
       user's own wording first. Model titles are written for punch ("…In
       5-Game Thriller!"), which search badly, so a plain-trimmed version of
       it is tried too. Every hit is held to the readable-article standard. */
    const junkHit = /wikipedia\.org|youtube\.com|facebook\.com|twitter\.com|\/\/x\.com|instagram\.com|reddit\.com/i;
    const known = new Set([picked.source_url]);
    const plain = picked.title.replace(/\s*[-–—:].*$/, "").replace(/[!?.]+\s*$/, "").trim();
    const queries = [...new Set([brief, picked.title, plain])].filter(Boolean).slice(0, 3);
    let usable = "";
    for (const q of queries) {
      if (usable) break;
      const hits = (await webSearch(q, 6).catch(() => []))
        .filter((u) => !junkHit.test(u) && !known.has(u));
      const checks = await Promise.all(hits.map(async (u) => [u, await readable(u, subject)]));
      usable = (checks.find(([, ok]) => ok) || [])[0] || "";
    }
    if (!usable) throw new JobError("No readable article on that subject right now — the search found nothing confirmable. Try again in a minute, or word the subject closer to a news story (e.g. \"Brewers World Series celebration\" not just \"baseball\").", 502);
    picked.source_url = usable;
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

  // Batch tag so anybody looking at a slide knows which day and which run of
  // that day produced it. Counts every story created today for the page —
  // rejected ones included, since they were still attempts.
  const dayISO = new Date().toISOString().slice(0, 10);
  const { count: made } = await db()
    .from("stories")
    .select("id", { count: "exact", head: true })
    .eq("page_id", page.id)
    .gte("created_at", `${dayISO}T00:00:00Z`);
  const batch = `${dayISO} #${String((made || 0) + 1).padStart(2, "0")}`;

  const { data: row, error } = await db()
    .from("stories")
    .insert({ page_id: page.id, title: picked.title, source_url: picked.source_url, slides, status: "draft", scheduled_at, batch })
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
