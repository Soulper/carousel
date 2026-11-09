// Relative imports on purpose (see jobs.js): bundled outside Next.
import { db } from "./supabase";
import { ai, provider, aiConfigured, groundedHosts } from "./ai";
import { webSearch, webSearchDetailed } from "./search";
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
export async function urlOk(url) {
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
/* Abstract description words — the kind that fill a user's brief sentence or
   model-punched headline — are weak evidence of subject fit: "unexpected",
   "winning" and "streak" occur in stories from ANY sport. Concrete identifiers
   (rookie, qb, nfl, Broncos…) are the real hook, so they get full weight and
   these get half — otherwise a basketball streak article out-scores the actual
   rookie story the user asked for. */
const ABSTRACT = new Set("winning,streak,shocks,shocking,unexpected,unusual,rising,leading,struggling,difficult,dominant,dominance,surprising,surprises,surprise,ignites,sparks,moment,moments,momentum,fans,atmosphere,league,team,team's,season,game,games,stage,giant,struggles,story,stories".split(","));

export const subjectHits = (text, subject) => {
  const words = [...new Set((subject || "").toLowerCase().match(/[a-z0-9]{4,}/g) || [])];
  if (!words.length) return 0;
  const body = (text || "").toLowerCase();
  return words.reduce((sum, w) => (body.includes(w) ? sum + (ABSTRACT.has(w) ? 0.5 : 1) : sum), 0);
};

/* Readability + on-subject check, returning the overlap count so callers can
   RANK candidates rather than settle for the first one over the threshold —
   "nearest readable coverage" is a fallback, not the goal: a brief about an
   NFL rookie deserves an NFL article, not a basketball piece that merely
   shares the phrase "winning streak". */
export const readableScored = async (url, subject = "", title = "") => {
  if (!(await urlOk(url))) return { ok: false, hits: 0 };
  const text = await articleText(url).catch(() => "");
  if (text.length <= 400) return { ok: false, hits: 0 };
  /* A subject word in the headline is worth double: headline words carry the
     article's identity (rookie, team name, event), body echoes are cheap. */
  const hits = subjectHits(text, subject) + 2 * subjectHits(title, subject);
  if (subject) {
    /* Two matches minimum — ESPN's echo pages rarely share even one of the
       title's specific words (team, city, player), while a real article on
       the subject usually shares several. */
    const words = (subject.match(/[a-z0-9]{4,}/g) || []).length;
    const need = Math.max(2, Math.min(3, Math.ceil(words * 0.3)));
    if (hits < need) return { ok: false, hits };
  }
  return { ok: true, hits };
};

export const readable = async (url, subject = "") =>
  (await readableScored(url, subject).catch(() => ({ ok: false, hits: -1 }))).ok;

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

  /* For a user brief on an ungrounded provider, search BEFORE the model speaks.
     The keyless news search is reliable and the model is not: a roll with an
     invented title/URL used to burn the whole confirm-recover dance. Search the
     subject's keywords, confirm the first hits are readable articles, and then
     ask the model only what it is good at — framing THAT real article as a
     carousel. If the search yields nothing usable, fall through to the classic
     pick-with-verification path below. */
  let preconfirmed = null;
  if (brief && provider() === "free") {
    const STOPQ = new Set("a,an,the,and,or,but,of,for,with,about,after,again,before,between,into,over,under,there,these,those,this,that,what,when,where,which,while,than,then,from,have,has,had,will,would,could,should,might,must,still,also,very,much,been,being,were,was,are,does,did,doing,more,most,other,some,such,only,even,just,his,her,its,their,own,near,today,yesterday".split(","));
    const kw = [...new Set(((brief.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => !STOPQ.has(w))))];
    const junkHit = /wikipedia\.org|youtube\.com|facebook\.com|twitter\.com|\/\/x\.com|instagram\.com|reddit\.com/i;
    /* Prod-proven ladder: short (2-3 keyword) lines — with "news" appended —
       is the only formulation that reliably returns items from the keyless
       news backends. Whole-word-soup lines (kw.join) and full sentences
       return zero. Every variant fires at once and every hit is probed at
       once: prod search is intermittent (GDELT mostly 429s from Vercel IPs),
       so one weak query mustn't cost a round-trip of waiting. */
    const queries = [...new Set([
      kw.slice(0, 3).join(" ") + " news",
      kw.slice(-3).join(" ") + " news",
      kw.slice(0, 3).join(" "),
      kw.slice(0, 2).join(" "),
      kw.slice(-2).join(" "),
      kw.slice(0, 5).join(" ") + " news",
      kw.slice(0, 5).join(" "),
      kw.join(" ") + " news",
      brief,
    ])].filter((q) => q.trim());
    const allHits = (await Promise.all(queries.map((q) => webSearchDetailed(q, 6).catch(() => []))))
      .flat()
      .filter((h) => !junkHit.test(h.url));
    const seenU = new Set();
    const candidates = allHits.filter((h) => !seenU.has(h.url) && seenU.add(h.url)).slice(0, 30);
    const checks = await Promise.all(candidates.map(async (h) => {
      const scored = await readableScored(h.url, brief, h.title).catch(() => ({ ok: false, hits: -1 }));
      return [h, scored.ok ? scored.hits : -1];
    }));
    /* Highest overlap wins — first-readable order settled for any article
       that merely shared the phrase "winning streak" with the brief. */
    preconfirmed = checks.reduce((best, c) => (c[1] > (best?.[1] ?? -1) ? c : best), null)?.[0] || null;
    if (preconfirmed) console.log(`topic: pre-confirmed a real article (${preconfirmed.title || preconfirmed.url})`);
  }

  const aiResult = preconfirmed ? await ai({
    system:
      "You are the editor of an Instagram photo-carousel account.\n" +
      "The account is called \"" + (page.name || "unnamed") + "\"" +
      (page.handle ? " (" + page.handle + ")" : "") + " — its name is the strongest signal of what its followers expect.\n" +
      "Its beats: " + (cfg.topics.join(", ") || "whatever stories best fit the account's name and vibe") + ".\n" +
      (cfg.tone ? `Tone: ${cfg.tone}\n` : "") +
      "\nA verified, current article has already been chosen for today's carousel — you only frame it.\n" +
      "- The story MUST have, or very likely have, 4-8 strong photographs. A carousel lives or dies on the pictures.\n" +
      "- A carousel needs 5-7 genuinely DIFFERENT pictures: distinct scenes, subjects and moments around this story.\n" +
      "- Do not repeat or rehash these recent stories: " +
        (recent || []).map((s) => s.title).filter(Boolean).slice(0, 40).join(" | ") + "\n" +
      "- Avoid opinion and anything you couldn't caption factually.\n" +
      "- Never mention tools, utilities or external lookups; reply with only the JSON.\n\n" +
      'Return the article as given: "title" = its exact headline, "source_url" = its URL. Then add "summary" (2-3 sentences of what it says), "slides" (5-7 entries, one per DIFFERENT photo moment: {"query":"..."}), and "why" (one line on why this will perform).',
    messages: [{
      role: "user",
      content:
        `Today's carousel is this article:\nTITLE: ${preconfirmed.title || "(untitled)"}\nURL: ${preconfirmed.url}\n` +
        (preconfirmed.title ? `Use that headline as "title"; today is ${new Date().toISOString().slice(0, 10)}.` : `Today is ${new Date().toISOString().slice(0, 10)}.`),
    }],
    maxTokens: 4000,
    label: `topic(pre) ${page.id.slice(0, 8)}`,
  }) : await ai({
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
  let picked = parseJson(aiResult.text);
  if (preconfirmed) {
    // The article is real and already chosen — the model's reply only frames
    // it. If its reply came back malformed, the story still ships with plain
    // slide queries cut from the headline.
    const t = preconfirmed.title || "";
    const fallbackQueries = [
      t,
      (t.match(/[A-Za-z0-9]{4,}/g) || []).slice(0, 4).join(" "),
      (t.match(/[A-Za-z0-9]{4,}/g) || []).slice(4, 8).join(" ") || t,
      "the subject in action",
      "fans and atmosphere",
    ];
    picked = {
      title: t || "Today's carousel",
      source_url: preconfirmed.url,
      summary: typeof picked?.summary === "string" ? picked.summary : "",
      slides: (Array.isArray(picked?.slides) ? picked.slides : [])
        .filter((s) => (s?.query || "").trim()).length
        ? picked.slides.filter((s) => (s?.query || "").trim())
        : fallbackQueries.filter(Boolean).map((query) => ({ query })),
      why: typeof picked?.why === "string" ? picked.why : "",
    };
  }
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
    /* Whole sentences return ZERO news results (Bing News RSS: a 16-word
       phrase gives 0 items, a 4-word keyword line gives several), so the
       first searches run on keyword strings built from the user's wording and
       the model's title; raw phrasing is the last resort. Every hit is held
       to the readable-article standard. */
    const junkHit = /wikipedia\.org|youtube\.com|facebook\.com|twitter\.com|\/\/x\.com|instagram\.com|reddit\.com/i;
    const known = new Set([picked.source_url]);
    const STOPQ = new Set("a,an,the,and,or,but,of,for,with,about,after,again,before,between,into,over,under,there,these,those,this,that,what,when,where,which,while,than,then,from,have,has,had,will,would,could,should,might,must,still,also,very,much,been,being,were,was,are,does,did,doing,more,most,other,some,such,only,even,just,his,her,its,their,own,near,today,yesterday".split(","));
    const kw = (s) => [...new Set((((s || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => !STOPQ.has(w))))].slice(0, 9);
    const keywords = [...new Set([...kw(brief), ...kw(picked.title)])];
    const plain = picked.title.replace(/\s*[-–—:].*$/, "").replace(/[!?.]+\s*$/, "").trim();
    /* Same prod-proven ladder the pre-search uses: short keyword lines, with
       "news" appended, beat word soup and sentences. */
    const queries = [
      keywords.slice(0, 3).join(" ") + " news",
      keywords.slice(-3).join(" ") + " news",
      keywords.slice(0, 3).join(" "),
      keywords.slice(0, 2).join(" "),
      keywords.slice(-2).join(" "),
      keywords.slice(0, 5).join(" ") + " news",
      keywords.slice(0, 5).join(" "),
      keywords.join(" ") + " news",
      plain,
      brief && brief.replace(/\s+/g, " "),
    ].filter((q) => q && q.trim()).map((q) => q.trim())
      .filter((q, i, a) => a.indexOf(q) === i);
    let usable = "";
    // Rank-and-pick fallback. A strict gate here is what kept failing the
    // button: the model rolls titles whose exact words ("shocks", "unexpected")
    // may never appear in a related article's body, so a correct-but-different-
    // worded hit got rejected too. Instead: judge every hit for readability,
    // record how many subject words its body shares, and land on the most
    // on-topic readable one. Only zero overlap at all (nobody's writing about
    // this subject today) still refuses.
    let bestOverlap = -1;
    const allHits = (await Promise.all(queries.map((q) => webSearchDetailed(q, 6).catch(() => []))))
      .flat()
      .filter((h) => !junkHit.test(h.url) && !known.has(h.url));
    const seenU = new Set();
    const candidates = allHits.filter((h) => !seenU.has(h.url) && seenU.add(h.url)).slice(0, 30);
    const checks = await Promise.all(candidates.map(async (h) => {
      const scored = await readableScored(h.url, subject, h.title).catch(() => ({ ok: false, hits: -1 }));
      return [h.url, scored.ok ? scored.hits : -1];
    }));
    for (const [u, overlap] of checks) {
      if (overlap > bestOverlap) { bestOverlap = overlap; usable = u; }
    }
    if (bestOverlap < 1) usable = "";
    if (!usable) throw new JobError("Nothing readable on the web touches that subject right now. Try again in a minute, or word the subject closer to a news story (e.g. \"Brewers World Series celebration\" not just \"baseball\").", 502);
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
