// Relative imports so the Netlify background function can bundle this file
// (see the note in jobs.js).
import sharp from "sharp";
import { db, BUCKET, publicUrl } from "./supabase";
import { claude, parseJson } from "./anthropic";
import { ai, provider, aiConfigured, groundedHosts, groundedPages, costReport, resetUsage } from "./ai";
import { webSearch, gdeltSearch } from "./search";
import { stockCandidates, keywordQueries } from "./stock";
import { JobError } from "./jobs";

const MIN_SHORT = Number(process.env.MIN_IMAGE_SHORT_SIDE || 1000); // px on the short side
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/* Gemini path of the find step: the model searches and names articles, then
   we fetch those pages and scrape the image URLs ourselves — Gemini's search
   grounding surfaces pages but can't open them. Article URLs are checked
   against the grounding sources so an invented URL never gets fetched. */
async function findCandidatesGemini(story, deeper, { avoid = [], angles = [] } = {}) {
  // Avoid entries that are grounding redirects are resolved to their real
  // article URLs; without this the same article resurfaces under a fresh
  // redirect token every pass and "skip these" never matches.
  // The story's own source article is never "already used": it's the one page
  // that's guaranteed on-topic, and re-scraping it is free — the fingerprint
  // check drops any photo that's already on the deck.
  const ownSource = (() => { try { const x = new URL(story.source_url || ""); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, ""); } catch { return ""; } })();
  const avoidKeys = new Set();
  await Promise.all((avoid || []).slice(0, 24).map(async (u) => {
    let real = u;
    if (/vertexaisearch\.cloud\.google\.com/.test(u)) {
      try {
        const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) });
        const loc = res.headers.get("location");
        if (loc) real = loc;
      } catch { /* keep the opaque url; best effort */ }
    }
    try {
      const x = new URL(real);
      const key = x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "");
      if (key !== ownSource) avoidKeys.add(key);
    } catch { /* malformed: ignore */ }
  }));
  let r = { text: "", sources: [] };
  if (provider() !== "gemini") {
    // Free text providers have no search grounding, so there's nothing for the
    // "search" call to do — skip it and go straight to the keyless web search.
    console.log("source: no grounded search on this provider — using the built-in keyless search");
  } else
  try {
  r = await ai({
    system:
      "You are a research agent with a google_search tool. You MUST call google_search at least once before answering. " +
      "An answer written from memory is a failure. Reply with only JSON.",
    messages: [{
      role: "user",
      content:
        (avoid.length
          ? // A previous pass already drained the main coverage. Lead with the
            // per-slide photo angles and demand different outlets.
            `A first pass already used every usable photo from the obvious coverage of this story. Your job is FRESH photos from OTHER outlets.\n\n` +
            `Story: ${story.title}\n` +
            (story.source_url ? `Known source article (already used, skip it): ${story.source_url}\n` : "") +
            `Do NOT surface articles at these addresses — every photo from them is already used or unusable: ${avoid.slice(0, 24).join(", ")}\n\n` +
            `Instead, run several google_search calls around these photo angles (one per carousel slide; add the word photos or gallery where it helps):\n` +
            angles.map((a) => `- ${a}`).join("\n") +
            `\nThen pick up to ${deeper ? 8 : 5} DIFFERENT reputable articles (different domains preferred) whose pages would contain real photographs for these angles — wire photos, game galleries, recap stories with images. Avoid editorial slideshows with no photos.\n\n`
          : // Fresh story: normal coverage search.
            `Call google_search now with a query for recent coverage of: "${story.title}". ` +
            `Then find up to ${deeper ? 8 : 5} reputable articles that cover this exact story and would contain several photographs.\n` +
            `Story: ${story.title}\n` +
            (story.source_url ? `Known source article: ${story.source_url}\n` : "") +
            (angles.length
              ? `If recent coverage is thin, each slide of this carousel has its own photo angle — search a couple of these too: ${angles.join("; ")}\n`
              : "")) +
        `About: ${story.slides.map((s) => s.headline || s.title || "").filter(Boolean).join("; ")}\n\n` +
        'Reply with only JSON: {"articles":[{"url":"https://...","why":"one line"}]}.',
    }],
    tools: "search",
    maxTokens: 2000,
    label: `source:find-gemini ${story.id.slice(0, 8)}${deeper ? " deeper" : ""}`,
  });
  } catch (e) {
    // Quota gone or provider down. The known source article is still worth
    // scraping on its own, so fall through with no searched pages rather than
    // failing the whole pass for want of a search call.
    console.warn(`source: search unavailable (${String(e.message).split("\n")[0]}) — scraping the source article only`);
  }

  let listed = [];
  try { listed = parseJson(r.text).articles || []; } catch { listed = []; }
  // Grounding redirects resolve to REAL articles search surfaced — scrape
  // those directly. Model-named URLs come along too, but they're verified by
  // the fetch itself: a hallucinated link just fails and is skipped.
  const grounded = await groundedPages(r.sources || [], deeper ? 8 : 6);
  const urls = [story.source_url, ...grounded, ...listed.map((a) => a?.url)]
    .filter((u) => u && /^https?:/i.test(u));
  const pages = [...new Set(urls)].slice(0, deeper ? 12 : 8);
  /* Grounding often comes back empty — the free providers have no search tool
     and Gemini's free tier returns nothing when it can't ground. The keyless
     web search fills the gap, so there are always pages to scrape. The slide
     photo angles are searched too — a re-source needs DIFFERENT pages, and
     the story title alone keeps re-finding the same coverage. GDELT runs once
     and gives both article pages and the outlets' own news photos. */
  const gdeltCandidates = [];
  {
    const key = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, ""); } catch { return ""; } };
    const have = new Set(pages.map(key));
    /* Whole storylines return ZERO items through every keyless backend (a
       measured prod failure: "Buccaneers Waive Rising Rookie After Surprise
       Addition news" → 0 from all of Bing, Google News and GDELT). The proven
       ladder is short keyword lines with " news" appended, so keywordize the
       title (and the slide angles) before they go into the search loop. */
    const queries = [...new Set([
      story.title,
      ...angles.filter(Boolean),
      ...keywordQueries([story.title, ...angles]).map((k) => `${k} news`),
    ])].filter(Boolean).slice(0, 8);
    for (const q of queries) {
      const docs = await gdeltSearch(q, deeper ? 8 : 5).catch(() => []);
      for (const d of docs) {
        const k = key(d.url);
        if (k && !have.has(k) && !avoidKeys.has(k) && !/\.(jpe?g|png)(\?|$)/i.test(d.image)) { pages.push(d.url); have.add(k); }
        // The outlet's own photo for that article is on-topic by construction
        // and arrives already resolved — no page fetch needed.
        if (d.image && /\.(jpe?g|png|webp)(\?|$)/i.test(d.image)) gdeltCandidates.push({ url: d.image, page: d.url, caption: d.title, credit: d.domain || "" });
      }
      if (!docs.length) for (const u of await webSearch(q, deeper ? 8 : 5)) {
        const k = key(u);
        if (k && !have.has(k) && !avoidKeys.has(k)) { pages.push(u); have.add(k); }
      }
    }
  }
  // Resolve any grounding redirects among the model's pages, then drop ones the
  // avoid list has already spent — the search agent re-offers spent articles so
  // reliably (the redirect token changes every pass) that trusting it isn't enough.
  const resolved = await Promise.all(pages.map(async (p) => {
    if (!/vertexaisearch\.cloud\.google\.com/.test(p)) return p;
    try {
      const res = await fetch(p, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      const loc = res.headers.get("location");
      if (loc) return loc;
    } catch { /* keep opaque */ }
    return p;
  }));
  const scrape = resolved.filter((p) => {
    try {
      const x = new URL(p);
      return !avoidKeys.has(x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, ""));
    } catch { return true; }
  });
  if (!scrape.length) {
    throw new JobError("The search only turned up articles this story has already used, and the web has no fresh photo coverage right now. Try again later, or upload a photo by hand.", 422);
  }
  if (!pages.length) {
    throw new JobError("Search found no articles matching this story. Try again, or add a source_url by hand.", 422);
  }
  console.log(`source: fetching ${scrape.length} page(s) to scrape images`);

  const candidates = [];
  // GDELT's article photos join the pool before any page is fetched; scrape
  // results are appended after.
  candidates.push(...gdeltCandidates);
  const limit = deeper ? 20 : 14;
  const done = new Set();
  /* Pages are fetched in parallel. A Vercel function gets ~60s (Hobby), and a
     sequential walk of six slow pages — each of which may wait on a reader
     fallback — can eat that on its own. Same pool, a fraction of the time.
     `queue` grows as related links are discovered, so one thin gallery page
     still doesn't cap the pool. */
  const queue = [...scrape];
  const worker = async () => {
    while (queue.length && done.size < limit) {
      const page = queue.shift();
      if (!page || done.has(page)) continue;
      done.add(page);
      try {
        const html = await fetchPage(page);
        if (!html) continue;
        const imgs = scrapeImages(html, page);
        candidates.push(...imgs);
        // Judge breadth by DISTINCT image paths, not raw count: one gallery
        // page often yields 200+ URL variants of a single photo. If the page
        // holds few genuinely different pictures, follow related articles.
        const distinctHere = new Set(imgs.map((c) => { try { const x = new URL(c.url); return x.origin + x.pathname; } catch { return c.url; } })).size;
        if (distinctHere < story.slides.length + 2) for (const link of relatedLinks(html, page, deeper ? 6 : 4)) if (!done.has(link)) queue.push(link);
      } catch { /* dead page or not HTML: skip it */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length || 1) }, worker));
  const distinctUrls = new Set(candidates.map((c) => { try { const x = new URL(c.url); return x.origin + x.pathname; } catch { return c.url; } })).size;
  console.log(`source: scraped ${done.size} page(s), ${candidates.length} candidate image(s) in ${distinctUrls} distinct path(s)`);
  const seen = new Set();
  return { candidates: candidates.filter((c) => !seen.has(c.url) && seen.add(c.url)).slice(0, deeper ? 30 : 20), pages: [...done] };
}

/* Fetch a page for scraping. Outlets answer a server fetch with 403/406 (bot
   shielding) while still handing a reader proxy the full article, images and
   all — so a blocked page falls back to the reader instead of being skipped.
   Returns the raw body (HTML or reader markdown), or "" when both fail. */
async function fetchPage(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
    const type = res.headers.get("content-type") || "";
    if (res.ok && /html/i.test(type)) return await res.text();
  } catch { /* fall through to the reader */ }
  try {
    const res = await fetch("https://r.jina.ai/" + url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
    if (res.ok) return await res.text();
  } catch { /* give up on this page */ }
  return "";
}

/* Pull direct image URLs out of an article's HTML: og:image, twitter:image,
   JSON-LD image objects, <img>/<source> srcsets, and lazy-loaded data-src.
   The old version never decoded & — which silently killed most URLs. */
function scrapeImages(html, page) {
  const out = [];
  const abs = (u) => {
    try {
      if (!u) return null;
      const x = new URL(u, page);
      return /^https?:$/.test(x.protocol) && !/\.(svg|ico)(\?|$)/i.test(x.pathname) ? x.href : null;
    } catch { return null; }
  };
  // Decode "&-amp-;" entities without ever writing the entity literally —
  // editors keep decoding it. AMP is built from a char code for the same reason.
  const AMP = String.fromCharCode(38);
  const clean = (u) => abs((u || "").trim().split(AMP + "amp;").join(AMP));

  const metas = (names) => {
    for (const name of names) {
      // The alt text is unknown for a meta tag, so leave the caption empty
      // rather than storing the regex name ("og:image…") as if it described
      // the picture — it then leaked into the copy writer's brief.
      for (const m of html.matchAll(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "gi"))) {
        const u = clean(m[0].match(/content=["']([^"']+)["']/i)?.[1]);
        if (u) out.push({ url: u, page, caption: "", credit: "" });
      }
      for (const m of html.matchAll(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, "gi"))) {
        const u = clean(m[1]);
        if (u) out.push({ url: u, page, caption: "", credit: "" });
      }
    }
  };
  metas(["og:image(?::secure_url)?", "twitter:image(?::src)?"]);

  // JSON-LD: ImageObject entries and thumbnailUrls from the page's structured data
  for (const m of html.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const found = [];
      const walk = (o) => {
        if (!o || typeof o !== "object" || found.length > 8) return;
        if (typeof o.thumbnailUrl === "string") found.push(o.thumbnailUrl);
        if (typeof o.image === "string") found.push(o.image);
        if (Array.isArray(o.image)) o.image.forEach((i) => typeof i === "string" && found.push(i));
        if (typeof o.url === "string" && /image|photo/i.test(o["@type"] || "")) found.push(o.url);
        for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
      };
      walk(JSON.parse(m[1]));
      for (const u of found.slice(0, 8)) {
        const c = clean(u);
        if (c) out.push({ url: c, page, caption: "", credit: "" });
      }
    } catch { /* malformed JSON-LD: skip */ }
  }

  // <img> and <picture><source>: src, lazy data-src, and the largest srcset entry
  const biggestFromSet = (set) => {
    let best;
    for (const part of set.split(",")) {
      const [su, sw] = part.trim().split(/\s+/);
      const w = parseInt(sw) || 0;
      if (su && (!best || w > best.w)) best = { u: su, w };
    }
    return best?.u;
  };
  for (const tag of html.matchAll(/<(?:img|source)[^>]*>/gi)) {
    const t = tag[0];
    const alt = (t.match(/alt=["']([^"']{0,300})["']/i) || [])[1] || "";
    let u = (t.match(/\bsrc=["']([^"']+)["']/i) || [])[1] || (t.match(/data-src=["']([^"']+)["']/i) || [])[1];
    if (u && /^data:/i.test(u)) u = undefined;
    const set = (t.match(/[\s]srcset=["']([^"']+)["']/i) || [])[1] || (t.match(/data-srcset=["']([^"']+)["']/i) || [])[1];
    if (set) u = biggestFromSet(set) || u;
    u = clean(u);
    if (u && !/\.gif(\?|$)/i.test(u)) out.push({ url: u, page, caption: alt, credit: "" });
  }

  // Broad sweep: galleries and apps often keep their images in JS/JSON blobs
  // rather than <img> tags, so scan the raw HTML for image URLs too. The junk
  // filter and the vision pass clean up whatever this over-collects.
  for (const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>\\)]*)?/gi)) {
    const u = clean(m[0].replace(/\\\//g, "/"));
    if (u) out.push({ url: u, page, caption: "", credit: "" });
    if (out.length > 120) break;
  }

  // Inline CSS backgrounds (hero images, cards, galleries built from divs)
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\((['"]?)([^'")]+)\1\)/gi)) {
    const u = clean(m[2].replace(/\\\//g, "/"));
    if (u) out.push({ url: u, page, caption: "", credit: "" });
  }
  // Lazy-load attribute names older than the data-src convention
  for (const m of html.matchAll(/data-(?:original|lazy-src|image|src-large|hi-res)=["']([^"']+)["']/gi)) {
    const u = clean(m[1]);
    if (u) out.push({ url: u, page, caption: "", credit: "" });
  }

  // Reader fallback returns markdown, not HTML: parse its image syntax too,
  // or every bot-shielded page "succeeds" in fetching and yields zero photos.
  for (const m of html.matchAll(/!\[([^\]]{0,300})\]\((https?:\/\/[^)\s]+)\)/g)) {
    const u = clean(m[2]);
    if (u && !/\.(svg|gif|ico)(\?|$)/i.test(u)) out.push({ url: u, page, caption: m[1] || "", credit: "" });
  }

  // Junk filter: site chrome, tracking pixels, and URLs advertising a tiny
  // size ("…/64x64/…") — thumbnails are what made the decks look like trash.
  const junky = (u) => /logos?|sprites?|avatars?|icons?|banners?|placeholder|1x1|pixel|app-?store|google-?play|play-?store|badge|available-?on|download-?on|\b\d{1,3}x\d{1,3}\b/i.test(u);
  // Some junk has a clean URL but names itself in the alt text — app badges,
  // "available on" buttons and stock-photo disclaimer cards ("Stock images on
  // this website may be sourced from…"). Those captions are the giveaway.
  const junkCaption = (t) => /app store|google play|play store|available (on|at|in)|download (on|the|it)|mobile application|get it on|stock (images?|photos?)|may be sourced|royalty[- ]free|shutterstock|getty ?images? (logo|card)/i.test(t || "");
  const seen = new Set();
  // Unknown credit defaults to the outlet itself: the caption writer can then
  // name the source instead of inventing a photographer.
  const site = (() => { try { return new URL(page).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  return out
    .filter((c) => !junky(c.url) && !junkCaption(c.caption) && !seen.has(c.url) && seen.add(c.url))
    .map((c) => ({ ...c, credit: c.credit || site }));
}

/* Same-site article links on a page. A gallery's own HTML often holds one
   image, so following a few related articles is how the pool grows beyond a
   single artwork. */
function relatedLinks(html, page, max = 4) {
  const base = (() => { try { return new URL(page).hostname.replace(/^www\./, ""); } catch { return null; } })();
  if (!base) return [];
  const out = new Set();
  // Reader markdown shows hrefs as [text](url) instead of <a href="…">.
  const hrefs = [
    ...[...html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map((m) => m[1]),
    ...[...html.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]),
  ];
  for (const href of hrefs) {
    try {
      const u = new URL(href, page);
      if (u.hostname.replace(/^www\./, "") !== base) continue;
      if (u.href.split("#")[0] === page) continue;
      if (!/\/20\d{2}\/|\/news\/|\/article|\/story|\/gallery|\/photos?\/|\/[a-z0-9-]+-[a-z0-9-]+-\d/i.test(u.pathname)) continue;
      out.add(u.href.split("#")[0]);
      if (out.size >= max) break;
    } catch { /* malformed href */ }
  }
  return [...out];
}

/* sourceStory(id, { overwrite })
   1. Claude (web search + fetch) finds coverage of the story and lists photo URLs
   2. We download them, measure them, drop small ones and near-duplicates
   3. Claude looks at the survivors and assigns the best one to each slot, with a focal point
   4. Winners + runners-up are re-hosted in storage and written into the slides */
/* sourceStory(id, { overwrite, only })
   `only` is a list of slot keys ("3.bg", "0.inset") to re-pick, one slide at a
   time. Everything else runs exactly as it does for a full source; the point is
   to leave the other slides' photos untouched. */
export async function sourceStory(id, { overwrite = false, only = null, deeper = false } = {}) {
  if (!aiConfigured()) throw new JobError("Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or a free provider key (GROQ_API_KEY / GITHUB_TOKEN / MISTRAL_API_KEY / CEREBRAS_API_KEY / OPENROUTER_API_KEY) to use image sourcing", 503);
  const { data: story } = await db().from("stories").select("*").eq("id", id).single();
  if (!story) throw new JobError("Story not found", 404);
  resetUsage();

  const slots = only?.length
    ? listSlots(story.slides, true).filter((s) => only.includes(s.key))
    : listSlots(story.slides, overwrite);
  if (!slots.length) {
    if (only?.length) throw new JobError("That slide has no photo slot to fill.", 400);
    return { message: "Every slot already has an image. Pass overwrite: true to re-source." };
  }

  // Photos already on the deck, so the find step can be told to go looking for
  // different pictures rather than re-discovering the ones already in use.
  const inUse = new Set();
  story.slides.forEach((s) => [s.bg?.src, s.inset?.src].forEach((u) => u && inUse.add(u)));

  // ---- 1. find candidates
  const brief = [
    `Story: ${story.title}`,
    story.source_url
      ? `Source article: ${story.source_url}`
      // Without a source URL this is a blind web search, which on an obscure
      // historical subject reliably returns a handful of images and nothing
      // else. Ask for more articles to compensate.
      : "No source article was given. Search especially hard: try at least 5-6 differently-worded searches, look for museum and " +
        "archive collections as well as news coverage, and prefer open-access archive scans over single news photos. " +
        "This story needs a different photo for every slide, so breadth matters more than picking the perfect one.",
    `Slides:\n${story.slides.map((s, i) => `${i + 1}. ${s.headline || s.title || ""} ${s.body ? "— " + s.body.replace(/\[\[|\]\]/g, "") : ""}`).join("\n")}`,
    `This story has ${slots.length} slides and needs ${slots.length} different photos.`,
  ].filter(Boolean).join("\n\n");

  const ask = async (opts, tries = 2) => {
    // A long search-and-read turn can come back truncated mid-JSON. One retry
    // turns a 500 into a slightly slower success; without it a single bad
    // reply throws away the whole run.
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const raw = await ai(opts);
        return typeof raw === "string" ? parseJson(raw) : parseJson(raw.text ?? raw);
      } catch (e) {
        last = e;
        if (i < tries - 1) console.warn(`source: Claude reply ${i + 1} unusable (${e.message}), retrying`);
      }
    }
    throw last;
  };

  let found;
  if (provider() !== "anthropic") {
    // Anthropic fetches pages itself; every other provider (Gemini's grounding,
    // the free OpenAI-compatible ones) can't, so the pipeline splits the work:
    // find articles — from search grounding where available, else the built-in
    // keyless search — then fetch them and scrape image URLs.
    // Articles behind photos already on the deck are named so it looks elsewhere,
    // and every page a previous run walked is avoided too — re-scraping the same
    // pages can only return the same pictures.
    const prior = story.source_meta || {};
    const avoid = [...new Set([
      ...story.slides.flatMap((s) => [s.bg?.page, s.inset?.page]).filter(Boolean),
      ...(prior.scrapedPages || []),
    ])].slice(0, 40);
    const angles = [...new Set(story.slides.map((s) => (s.bg?.query || "").trim()).filter(Boolean))].slice(0, 8);
    found = await findCandidatesGemini(story, deeper, { avoid, angles });
  } else {
    found = await ask({
      system:
        `You source editorial photos for news carousel posts. Use web search and web fetch to find ${deeper ? "5-8" : "2-5"} reputable articles ` +
        "covering this exact story (fetch the source article first if one is given). From the fetched pages, collect direct " +
        "image file URLs that appear in the page content: the main/og image, in-article photos, and the largest variant offered " +
        "in any srcset. Only list URLs that literally appear in fetched content; never invent or edit a URL. Skip logos, icons, " +
        "avatars, ads, maps, charts, and screenshots of social posts. Prefer photos of the subject itself, varied shots and angles. " +
        "If the story's imagery is essentially one artwork or scene, list ONE representative image rather than several crops, " +
        "scans or recolorings of it — a carousel of near-identical pictures is a failed carousel. " +
        "Give 1-2 clearly different images per article you read, even when the articles overlap — never two variants of the same " +
        "artwork — and take the largest version offered in any srcset. " +
        (inUse.size
          ? "These photos are already in use elsewhere in this story. List different ones: " + [...inUse].join(", ") + "\n"
          : "") +
        `Reply with only JSON: {"candidates":[{"url":"...","page":"article url","caption":"what it shows","credit":"photographer/agency if stated"}]} — at most ${deeper ? 24 : 16}.`,
      messages: [{ role: "user", content: brief }],
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: deeper ? 12 : 8 },
        { type: "web_fetch_20250910", name: "web_fetch", max_uses: deeper ? 12 : 8 },
      ],
      maxTokens: 8000,
      label: `source:find ${id.slice(0, 8)}${deeper ? " deeper" : ""}`,
    }).then((c) => ({ ...c, pages: [] }));
  }

  // ---- 2. download, measure, filter
  // Pipeline counters land in source_meta: when a run fills nothing, these say
  // exactly which stage starved (raw scrape, downloads, pool filters).
  const stats = { rawScrape: (found.candidates || []).length };
  const seen = new Set();
  const raw = (found.candidates || []).filter((c) => c?.url && !seen.has(c.url) && seen.add(c.url)).slice(0, deeper ? 24 : 16);
  stats.raw = raw.length;

  /* Fit scoring. "Random photos" happened because all the finder saw was sizes —
     a huge photo of an unrelated campaign beat the right-but-smaller one. Every
     candidate gets a lexical overlap score against the story and its slide
     texts, and the pool is ordered by it, so the on-topic photos lead the list
     the judge sees (and any code backfill falls through them in the same order). */
  const STOP = new Set("a,an,the,and,or,but,of,for,with,about,above,after,again,against,before,between,into,over,under,their,there,these,those,this,that,what,when,where,which,while,whose,than,then,from,have,has,had,will,would,could,should,might,must,still,also,very,much,been,being,were,was,are,does,did,doing,more,most,other,some,such,only,even,just,phoo".split(","));
  const tok = (s) => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t));
  const storyTerms = new Set(tok([
    story.title,
    story.source_url,
    ...story.slides.map((s) => [s.headline || s.title, s.body, s.bg?.query].filter(Boolean).join(" ")),
  ].join(" ")));
  /* Caption evidence outweighs page evidence. A story page's sidebar carries
     thumbnails for a dozen unrelated stories, and every one of them inherits
     the page's on-topic URL — that's how LeBron James and Taylor Swift once
     landed on an Indiana football carousel. Words in the image's own caption
     (alt text, GDELT headline) count full; page words count a quarter. */
  const fitOf = (c) => {
    const cap = [...new Set(tok(c.caption))];
    const pag = [...new Set(tok([c.page, c.credit].join(" ")))];
    const matchedCap = cap.filter((t) => storyTerms.has(t));
    const matchedPage = pag.filter((t) => storyTerms.has(t));
    c.matchList = matchedCap.slice(0, 5);
    c.capMatch = matchedCap.length;
    c.pageMatch = matchedPage.length;
    const denom = Math.max(2, Math.min(storyTerms.size, 8));
    const score = matchedCap.length + matchedPage.length * 0.25;
    c.fit = storyTerms.size ? Math.min(1, score / denom) : 0;
    return c;
  };

  /* Keyless image floor. Niche subjects (comics, an old match, a local team)
     mostly live on retail and aggregator pages whose "photos" are product
     shots and app badges — or the article scrape comes back nearly empty.
     Openverse and Wikimedia return real, licensed photographs with honest
     credits, no AI and no key, so the deck still gets pictures.
     Measured prod failure: this used to query the STORY TITLE verbatim, and
     a full sentence returns ZERO candidates from both indexes — the floor
     silently did nothing. Keyword queries always hit. */
  const deckQueries = keywordQueries([
    story.title,
    ...story.slides.map((s) => (s.bg?.query || s.headline || s.title || "").trim()),
  ]);
  if (raw.length < slots.length + 2) {
    const extra = await stockCandidates(deckQueries, 12);
    const have = new Set(raw.map((c) => c.url));
    const before = raw.length;
    for (const c of extra) if (!have.has(c.url)) { raw.push(c); have.add(c.url); }
    if (raw.length > before) console.log(`source: added ${raw.length - before} candidate(s) from keyless image search`);
    stats.floor1 = raw.length - before;
  }
  const fetched = await downloadAll(raw);
  // Which URLs already made it through, so a retry pass never re-downloads them.
  const haveUrls = new Set(fetched.map((c) => c.url));
  let pool = dedupe(fetched);
  const sortByFit = (list) => {
    for (const c of list) fitOf(c);
    return list.sort((a, b) => (b.fit || 0) - (a.fit || 0) || b.short - a.short);
  };
  pool = sortByFit(pool);
  /* A thin first stream is the no-slots-filled failure mode: the main scrape
     held nothing usable and the stock floor kicked in with fewer pictures than
     the deck needs. Before giving the pool to the judge, run the search once
     more at full depth — new pages, and the slide photo angles as queries —
     and fold in whatever new photos turn up. */
  if (pool.length < slots.length + 1 && !deeper && !only) {
    try {
      console.log(`source: thin pool (${pool.length}) for ${slots.length} slot(s) — running the deeper pass`);
      const priorPages = story.source_meta?.scrapedPages || [];
      const avoid2 = [...new Set([
        ...story.slides.flatMap((s) => [s.bg?.page, s.inset?.page]).filter(Boolean),
        ...priorPages,
        ...(found.pages || []),
      ])].slice(0, 40);
      const found2 = await findCandidatesGemini(story, true, { avoid: avoid2, angles });
      stats.deeper = (found2.candidates || []).length;
      const fresh = (found2.candidates || [])
        .filter((c) => c?.url && !haveUrls.has(c.url) && haveUrls.add(c.url))
        .map(fitOf);
      /* Wikimedia photo hosts (upload.wikimedia.org / thumb.wikimedia.org)
         are far more reliable than the raw Openverse entries, and unlike news
         CDNs they don't 403 datacenter IPs. Prioritise them as the pool's
         backbone when the article scrape is thin, so downloads match pool
         size instead of collapsing (prod: 30 raw → 4 downloaded). */
      const fresh2 = [...fresh].sort((a, b) => Number(/wikimedia\.org/.test(b.url)) - Number(/wikimedia\.org/.test(a.url)) || (b.fit || 0) - (a.fit || 0));
      if (fresh2.length) {
        const got2 = await downloadAll(fresh2);
        fetched.push(...got2);
        stats.deeperDL = got2.length;
        pool = sortByFit(dedupe(fetched));
        console.log(`source: deeper pass added ${got2.length} photo(s), pool now ${pool.length}`);
      }
    } catch (e) {
      console.warn(`source: deeper pass failed (${String(e.message).split("\n")[0]})`);
    }
    /* Second stock floor after downloads. The download stage is the choke
       point the first floor can't see: news-CDN URLs scrape into the pool but
       403/timeout from Vercel, leaving 4-5 fetched photos for 8 slots while
       raw looked plentiful (so the first floor never ran). Wikimedia-hosted
       images always download, so this directly refills the collapse. */
    if (pool.length < slots.length + 1) {
      try {
        const extra2 = await stockCandidates(deckQueries, 12);
        stats.floor2 = extra2.length;
        const fresh2 = extra2.filter((c) => !haveUrls.has(c.url)).map(fitOf).sort((a, b) => (b.fit || 0) - (a.fit || 0));
        if (fresh2.length) {
          const got2 = await downloadAll(fresh2.slice(0, 16));
          fetched.push(...got2);
          stats.floor2DL = got2.length;
          pool = sortByFit(dedupe(fetched));
          console.log(`source: post-download floor added ${got2.length} photo(s), pool now ${pool.length}`);
        }
      } catch (e) {
        console.warn(`source: post-download floor failed (${String(e.message).split("\n")[0]})`);
      }
    }
  }

  // Prefer photos that clear the size bar, but top up from the smaller ones so
  // each slot can get its own picture. Nine repeats of one sharp photo is a
  // worse post than nine distinct photos a little soft, so a shortfall in
  // resolution is worth trading for variety.
  /* Flat-graphic scan runs on the POOL, not just on eviction — CBS Sports HQ
     promo cards, UEFA badges and broadcast logos shipped as "photos" whenever
     the vision judge had a weak moment. Small brand cards are flat by
     construction; measure every candidate. */
  {
    const flat = new Set();
    await Promise.all(pool.map(async (c) => { if (await isFlatGraphic(c.buf)) flat.add(c.url); }));
    if (flat.size) {
      pool = pool.filter((c) => !flat.has(c.url));
      console.warn(`source: ${flat.size} flat graphic(s) in the pool dropped (badges, promo cards, mastheads)`);
    }
  }
  const big = pool.filter((c) => c.short >= MIN_SHORT);
  /* Anything under ~640px on the short side is mush on a 1080-wide canvas —
     the threshold the top-up accepts down to. Cards (400×225 broadcast
     promos, sidebar thumbnails) used to slip past it when the pool ran dry. */
  let SMALL_FLOOR = Number(process.env.MIN_IMAGE_SMALL_FLOOR || 640);
  let rest = pool.filter((c) => c.short >= SMALL_FLOOR && c.short < MIN_SHORT);
  /* …but an empty deck is worse than a small photo: if nothing clears the
     floor, take the biggest leftovers rather than shipping nothing. */
  if (!big.length && !rest.length && pool.length) {
    SMALL_FLOOR = 0;
    rest = pool.slice().sort((a, b) => b.short - a.short).slice(0, Math.max(1, slots.length));
  }
  /* Photos already on the deck can resurface from a different article as a new
     candidate, and the model had no say in it — that's how a re-pick once ended
     up with two slides showing the SAME shot. So compare fingerprints: any
     candidate that is the same photo as one in use is dropped outright. */
  const junkUrls = new Set();
  /* Fingerprints of what's already on the deck, seeded from the grids the
     previous run persisted — pure server-side data, no network. The old
     approach fingerprinted the deck by downloading each photo from Supabase,
     and one flaky fetch silently skipped it: pass 2 then re-picked the very
     photo pass 1 had placed, and two identical shots sat on two slides. */
  const usedGrids = (story.source_meta?.grids || []).map((g) => Array.from(g));
  if (inUse.size) {
    const fetched = [];
    for (const u of inUse) {
      try {
        const res = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        // A badge or card sitting on the deck is being replaced, not defended:
        // fingerprinting it would block the very candidate meant to take its
        // slot. Photos the pass shipped before the flat-graphic guard existed
        // are exactly what a re-source needs to clear.
        if (await isFlatGraphic(buf)) { junkUrls.add(u); continue; }
        fetched.push(await ahash(buf));
      } catch { /* the persisted seed covers a photo this fetch couldn't reach */ }
    }
    usedGrids.push(...fetched);
    if (junkUrls.size) console.warn(`source: ${junkUrls.size} junk image(s) already on the deck will be ignored (and evicted if nothing replaces them)`);
    const samePhoto = (g) => usedGrids.some((ug) => nearDuplicate({ grid: g, buf: null }, { grid: ug, buf: null }));
    const before = pool.length;
    pool = pool.filter((c) => !samePhoto(c.grid));
    if (pool.length < before) console.warn(`source: dropped ${before - pool.length} candidate(s) identical to photos already on the deck`);
    if (!pool.length) {
      /* Nothing new to use — but a logo card on the deck still can't ship.
         Evict the flat graphics before giving up, so the editor shows exactly
         which slides need a photo instead of leaving app badges in the post. */
      let cleared = 0;
      if (junkUrls.size) {
        const cleaned = structuredClone(story.slides);
        for (const sl of cleaned) {
          if (sl.bg?.src && junkUrls.has(sl.bg.src)) { sl.bg = {}; cleared++; }
          if (sl.inset?.src && junkUrls.has(sl.inset.src)) { delete sl.inset.src; cleared++; }
        }
        if (cleared) await db().from("stories").update({ slides: cleaned }).eq("id", id);
      }
      /* The deck already owns what the first pages offered. One last try with
         the keyless image floor keyed to the slide angles — that asks a
         DIFFERENT question than the story title the failed pass searched. */
      try {
        const angles2 = [...new Set(story.slides.map((s) => (s.bg?.query || s.headline || s.title || "").trim()).filter(Boolean))].slice(0, 6);
        const extra = await downloadAll((await stockCandidates(angles2, 16))
          .filter((c) => !haveUrls.has(c.url)));
        pool = dedupe(extra).filter((c) => !samePhoto(c.grid));
        for (const c of pool) fitOf(c);
        if (pool.length) console.log(`source: last-ditch floor rescued ${pool.length} fresh photo(s)`);
      } catch (e) {
        console.warn(`source: last-ditch floor failed (${String(e.message).split("\n")[0]})`);
      }
      if (!pool.length) {
        const lead = cleared ? `Removed ${cleared} logo/app image${cleared === 1 ? "" : "s"} from the deck. ` : "";
        const msg = only?.length
          ? `${lead}Couldn't find a different photo for that slide — everything reachable already matches what's on the deck. Try again later or upload one to this slide by hand.`
          : `${lead}No new usable photos turned up — every reachable picture matches ones already on the deck. Press retry in a bit (new coverage lands all day), or upload a photo to any slide by hand.`;
        throw new JobError(msg, 422);
      }
    }
  }
  /* Size the pool against the number of slots it has to fill — but on a
     single-slot re-pick that is 1, which would leave nothing to choose from and
     hand the same photo straight back. Ask for the whole story's worth so there
     is something to swap in, and so a re-pick sees the same photos a full
     source would have. */
  const want = Math.min(Math.max(slots.length, only?.length ? 8 : 0), deeper ? 16 : 12);
  const chosen = [...big, ...rest].slice(0, want);
  const lowRes = big.length < Math.min(2, only?.length ? 1 : slots.length) || chosen.some((c) => c.short < MIN_SHORT);
  pool = chosen;
  if (!pool.length) throw new JobError("Couldn't find usable photos for this story. Add a source_url or upload images by hand.", 422);
  const shortfall = Math.max(0, slots.length - pool.length);
  // One photo means a re-pick can only ever return the same thing, so say so
  // rather than spending a call to discover it.
  if (only?.length && pool.length < 2) {
    throw new JobError("Only one usable photo was found for this story, so there's nothing different to swap in.", 422);
  }

  // ---- 3. assign to slots with a vision pass
  const previews = await Promise.all(pool.map((c) => sharp(c.buf).rotate().resize(768, 768, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer()));
  const content = [];
  pool.forEach((c, i) => {
    const match = c.matchList?.length ? ` About-subject match: ${c.matchList.join(", ")}.` : "";
    content.push({ type: "text", text: `Image ${i}: ${c.w}×${c.h}.${match} ${c.caption || ""}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: previews[i].toString("base64") } });
  });
  // Ask for one slot per photo, not one photo per slot. Asking a model to fill 10
  // slots from 5 photos reliably returns a short list, leaving most slides
  // untouched. Top up the leftovers in code instead, where we know exactly
  // which images are unused.
  const primary = slots.filter((s) => !s.secondary);
  const secondary = slots.filter((s) => s.secondary);
  content.push({
    type: "text",
    text:
      `Slots to fill, ${primary.length} of them:\n${primary.map((s) => `- ${s.key}: ${s.role}${s.text ? ` — slide text: "${s.text}"` : ""}`).join("\n")}\n\n` +
      "Reply with the slot EXACTLY as named above (e.g. \"3.bg\") — never a bare number or a description of the slide.\n\n" +
      (secondary.length
        ? `Also give one runner-up for each of these, from the photos you did not use as a main:\n${secondary.map((s) => `- ${s.key}: ${s.role}`).join("\n")}\n\n`
        : "") +
      `There are ${pool.length} photos available and ${slots.length} slots, so not every slot can have its own photo.\n\n` +
      "DUPLICATE GROUPS: several of these may show the SAME underlying picture — different crops, sizes, scans or " +
      "colourings of one scene. To a viewer those are one photo and reusing them looks broken. So first group the images: " +
      "EVERY index must appear in exactly one group, all indices inside a group show the same underlying picture, and a " +
      "unique photo is a group of one. Then assign slots using at most ONE image from each group (the best of that group).\n\n" +
      (only?.length
        ? "IMPORTANT: one of these photos is already on the slide being changed, and you have been asked to replace it. Do not " +
          "choose that same picture again — pick the next best thing, even if it is less perfect. If every photo shows the same " +
          "thing, choose a different crop or angle of it.\n\n"
        : "") +
      "Pick the best image for each slot. Rules: the subject must be clearly visible and large; reject images with baked-in text, " +
      "watermarks, collages, heavy logos, page screenshots, and thumbnails — a photo that looks soft or tiny at full size is trash, " +
      "not a fallback. An OUTLET'S BRAND CARD is never a photo: a dark frame holding only a masthead or wordmark (\"The Washington " +
      "Post\", \"AP\", \"wp\"), a slogan card (\"Democracy Dies in Darkness\"), or a scene drowned behind a huge logo overlay is junk " +
      "no matter what else is in frame — never assign one, list nothing for slots they would fill. " +
      "SUBJECT CHECK, the hard one: the picture must show the story's world — the sport, league, teams or people the slide words name. " +
      "A photo of a DIFFERENT sport, league or event belongs in rejects even if it is a gorgeous photo: an NBA/celebrity/marquee " +
      "picture is never the subject of a football story, courtside celebrities are never the story, and a player in the wrong " +
      "team's colours is never the story. If you cannot name the connection between what you see and the slide's words in one " +
      "short phrase, it is a reject." +
      "The cover main photo should leave room for a headline over its lower part; body slides should match their text. " +
      "NEVER assign the same picture to two slots. If the pool genuinely can't cover the slots with GOOD distinct images, " +
      "fill only the ones you can and leave the rest empty — a half-empty carousel gets resourced, but a repeating one gets posted. " +
      "IMPORTANT: use a different photo number for each main slot. Spread them out — never put the same number twice. " +
      "focal is the subject's centre as [x%, y%] of that image. " +
      'Reply with only JSON: {"assign":[{"slot":"...","image":0,"focal":[50,40],"why":"short reason"}],"groups":[[0,4,7],[1],[2,3]],"rejects":[2,5]}. ' +
      "Every assign entry MUST carry a truthful \"why\" naming exactly what is visible in THAT photo and how it matches the slide's " +
      'words ("red-jersey quarterback rolling right behind his line", not "good action shot"). If you cannot describe the actual ' +
      "contents of a photo, you cannot assign it — reject it instead. A wrong-but-beautiful assignment is the worst outcome this " +
      "pass can produce. " +
      '"rejects" lists the indices you would never use — brand/masthead cards, icons, app badges, screenshots, pure text frames, ' +
      "and any picture whose contents you cannot actually describe. " +
      "One assign entry per slot listed above, no more and no fewer.",
  });
  let picked;
  try {
    picked = await ask({ messages: [{ role: "user", content }], json: true, maxTokens: 4000, label: `source:assign ${id.slice(0, 8)}` });
  } catch (e) {
    /* The vision pass only decides WHICH photo goes on which slide — the code
       backfill below can place them deterministically. So when no vision model
       is reachable (a free text-only provider with no Gemini key, or a dead
       quota) the deck still gets built instead of the pass failing outright. */
    console.warn(`source: photo-judging pass unavailable (${String(e.message).split("\n")[0]}) — assigning photos in order`);
    picked = { assign: [], groups: [], rejects: [] };
  }

  // The vision pass groups the pool by "same underlying picture". The first
  // index of each group is the representative; every other index in it is a
  // duplicate. Duplicates never fill a slot — so a pool that's really one
  // photo in six crops collapses to one usable image, the slots go unfilled,
  // and the autopilot's guardrail rejects the story instead of shipping the
  // same picture across the deck.
  const dupes = new Set();
  for (const g of Array.isArray(picked.groups) ? picked.groups : []) {
    const idx = (Array.isArray(g) ? g : [g]).map(Number).filter((n) => !Number.isNaN(n) && pool[n]);
    idx.slice(1).forEach((n) => dupes.add(n));
  }
  // Providers/models that ignore the grouping instruction may still send the
  // older flat list; honour it too.
  for (const n of (picked.dupes || []).map(Number)) if (!Number.isNaN(n)) dupes.add(n);
  // Indices the vision pass refused outright (brand cards, icons, screenshots).
  const rejects = new Set((picked.rejects || []).map(Number).filter((n) => !Number.isNaN(n) && pool[n]));
  const groups = Array.isArray(picked.groups) ? picked.groups.length : 0;
  if (dupes.size || rejects.size) console.warn(`source: vision pass grouped the pool into ${groups || "?"} picture(s); ${dupes.size} near-duplicate + ${rejects.size} rejected image(s) excluded`);

  // Claude sometimes returns fewer entries than asked, or misses slots. Fill
  // any gap from the photos it didn't use, in slide order, so every slot gets
  // its own image rather than the leftover ones silently keeping the old photo.
  // Leftovers it REFUSED stay out — the pass left those slots empty on purpose,
  // and backfilling them is how app-store badges and masthead cards once
  // reached slides.
  const unanswered = slots.filter((s) => !(picked.assign || []).some((a) => a.slot === s.key));
  if (unanswered.length) {
    const usedByClaude = new Set([
      ...(picked.assign || []).map((a) => Number(a.image)).filter((n) => !Number.isNaN(n)),
      ...dupes,
      ...rejects,
    ]);
    /* Caption evidence only. A candidate that never says anything about the
       story in its own words (empty alt scraped off a story page's sidebar)
       is exactly the LeBron-on-a-football-story class of junk; the page URL
       can't vouch for it. Slots stay empty rather than take those. */
    const leftover = pool
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => !usedByClaude.has(i) && (c.capMatch || 0) >= 1)
      .map(({ i }) => i);
    const extra = unanswered
      .map((s, n) => (leftover[n] !== undefined ? { slot: s.key, image: leftover[n], focal: [50, 45] } : null))
      .filter(Boolean);
    if (extra.length) {
      console.warn(`source: filling ${extra.length} unanswered slot(s) in code: ${extra.map((e) => e.slot).join(", ")}`);
      picked.assign = [...(picked.assign || []), ...extra];
    }
  }

  // ---- 4. re-host and write into the slides
  const hosted = new Map();
  const host = async (i) => {
    if (!hosted.has(i)) {
      const c = pool[i];
      const path = `images/${story.id}/${Date.now()}-${i}.${c.ext}`;
      const { error } = await db().storage.from(BUCKET).upload(path, c.buf, { contentType: c.type });
      if (error) throw error;
      // caption comes from Claude's read of the source page. The copy writer
      // needs it: text written against the wrong photo is worse than none.
      hosted.set(i, { src: publicUrl(path), w: c.w, h: c.h, credit: c.credit || "", page: c.page || "", caption: c.caption || "" });
    }
    return hosted.get(i);
  };

  const slides = structuredClone(story.slides);
  const report = [];
  const skipped = [];
  const unchanged = [];   // slots that came back with the photo they already had
  // Article pages behind photos that actually got used — the only pages worth
  // avoiding on the next pass, since photo-less pages could still produce.
  const usedPages = new Set(story.source_meta?.scrapedPages || []);
  // Each photo fills one slot only, unless every photo is already spoken for.
  // Spreading them beats Claude's own choice of running the best photo across
  // half the deck, which is what happens when the pool is short.
  const claimed = new Set();
  const reused = [];
  const ordered = [...(picked.assign || [])].sort((a, b) => {
    const sa = slots.findIndex((s) => s.key === a.slot);
    const sb = slots.findIndex((s) => s.key === b.slot);
    return sa - sb;
  });
  const spare = pool.map((_, i) => i);
  // Pop the first photo nobody has taken yet. Removing it from `spare` on
  // hand-off matters: leaving it in place hands the same photo out twice and
  // reports the reuse as if nothing repeated.
  const nextSpare = () => {
    while (spare.length) {
      const i = spare.shift();
      if (!claimed.has(i)) return i;
    }
    return undefined;
  };

  /* Guard against two visually identical pictures reaching the deck.
     dedupe() should already have removed these, but Claude can pick the same
     source twice and a leftover near-duplicate would otherwise sit on two
     slides looking like a mistake. Check the real images as they're assigned
     and swap in an unused photo that actually looks different. */
  // One grid per visually different photo placed, so `looksDistinct` can compare
  // against what's already on the deck and `distinct` can report the count.
  const chosenGrids = [];
  // The deck's own photos count as "seen": without seeding, a second pass aimed
  // at still-empty slots couldn't know what pass 1 had already placed — that's
  // how a repeat once slipped through. usedGrids holds them (seeded + refetched).
  chosenGrids.push(...usedGrids);
  const gridDiff = (x, y) => {
    let t = 0;
    for (let i = 0; i < x.length; i++) t += Math.abs(x[i] - y[i]);
    return t / x.length;
  };
  const looksDistinct = (g) => chosenGrids.every((prev) => gridDiff(prev, g) > NEAR_SAME);
  /* The vision model may name slots out of spec: bare list positions ("1"),
     the key I asked for ("1.bg"), or an echo of the role line ("bg: full-bleed
     portrait 4:5 …"). A strict match turned all of those into "no such slot"
     and left five of six slides photoless WITH the photos already downloaded.
     Resolve them all instead: exact key first, then the number against the
     order the slots were listed in the prompt, then a role/text token match. */
  const resolveSlot = (name) => {
    if (name == null) return null;
    const k = String(name).trim();
    const exact = slots.find((s) => s.key === k);
    if (exact) return exact;
    const m = k.match(/\d+/);
    if (m) {
      const n = Number(m[0]);
      if (primary[n]) return primary[n];
      const s = slots[n];
      if (s) return s;
    }
    const kl = k.toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const s of slots) {
      const hay = `${s.key} ${s.role || ""} ${s.text || ""}`.toLowerCase();
      const score = kl.split(/\W+/).filter((w) => w.length > 3 && hay.includes(w)).length;
      if (score > bestScore) { best = s; bestScore = score; }
    }
    return bestScore >= 2 ? best : null;
  };
  for (const a of ordered) {
    const slot = resolveSlot(a.slot) || slots.find((s) => s.key === a.slot);
    if (!slot) { skipped.push({ slot: a.slot, why: "no such slot" }); continue; }
    if (!pool[a.image]) { skipped.push({ slot: a.slot, why: "no such image" }); continue; }
    // The vision pass judged this a repeat of an image already going on the deck.
    if (dupes.has(a.image)) { skipped.push({ slot: a.slot, why: "duplicate of an image already used" }); continue; }
    // One picture per slot, always. If the photo it picked is already spoken
    // for, swap in an unused one; if there is none, LEAVE THE SLOT EMPTY.
    // Repeating a photo across a deck reads as a mistake, so a slot with no
    // photo is strictly better — it marks the story as under-sourced so it
    // gets resourced or rejected rather than posted.
    if (claimed.has(a.image)) {
      const free = nextSpare();
      if (free !== undefined) a.image = free;
      else { skipped.push({ slot: slot.key, why: "no unused photo left — slot left empty" }); continue; }
    }
    // Even an unclaimed photo can be a visual twin of one already placed.
    // Prefer any unused photo that actually looks different.
    if (!looksDistinct(pool[a.image].grid)) {
      const alt = spare.find((i) => !claimed.has(i) && looksDistinct(pool[i].grid));
      if (alt !== undefined) {
        spare.splice(spare.indexOf(alt), 1);
        claimed.delete(a.image);
        a.image = alt;
      } else if (!claimed.has(a.image)) {
        // Nothing distinct left and this looks like a photo already placed:
        // leave the slot empty rather than repeat it.
        skipped.push({ slot: slot.key, why: "looks like a photo already on the deck — slot left empty" });
        continue;
      }
    }
    claimed.add(a.image);
    // Counted only when it really is a new picture, so `distinct` reflects
    // what a reader sees rather than how many files we wrote.
    if (looksDistinct(pool[a.image].grid)) chosenGrids.push(pool[a.image].grid);
    const main = await host(a.image);
    if (pool[a.image].page) usedPages.add(pool[a.image].page);
    const alts = [];
    for (const j of (a.alternates || []).slice(0, 3)) if (pool[j] && j !== a.image) alts.push(await host(j));
    const target = (slides[slot.index][slot.field] ||= {});
    // A re-pick that hands back the same photo it was given has changed nothing,
    // so say so rather than letting the button look broken.
    if (target.src === main.src) unchanged.push(slot.key);
    // New photo → old cutout no longer lines up; the cutout worker regenerates it
    // Landscape photos on body slides sit above the text rather than under it
    const fit = slot.index > 0 && main.w > main.h * 1.15 ? "above" : "cover";
    Object.assign(target, { src: main.src, focal: a.focal || [50, 45], fit, credit: main.credit, page: main.page, alternates: alts, caption: main.caption });
    delete target.cutout; delete target.cutoutBox;
    if (slot.field === "inset" && slides[slot.index].sticker) delete slides[slot.index].sticker.src;
    report.push({ slot: slot.key, image: main.src, size: `${main.w}×${main.h}`, why: a.why || "" });
  }

  // Count genuinely different photos on the slides. chosenGrids only ever gains
  // an entry when the photo looks different from everything already placed,
  // so its length is the number a reader would call "a different photo".
  const distinct = chosenGrids.length;
  const unfilled = slots.filter((s) => !report.some((r) => r.slot === s.key)).map((s) => s.key);
  const meta = {
    filled: report,
    skipped,
    unchanged,                // re-picks that came back identical
    unfilled,                 // slots left with their previous photo
    lowRes,
    candidates: fetched.length,
    raw: stats.rawScrape,          // before dedupe/cap: what the scrape offered
    floor: stats,                  // pool-build floor + deeper pass counts
    kept: pool.length,
    distinct,                 // visually different photos used
    dupes: [...dupes],        // indices the vision pass judged same-artwork repeats
    slots: slots.length,
    shortfall,                // photos fewer than slots, before assignment
    reused,                   // slots that had to double up
    // Pages this run used photos from — the only pages worth avoiding next
    // time, since photo-less article pages could still produce something.
    scrapedPages: [...usedPages].slice(0, 60),
    // Fingerprints of the deck as it now stands (existing photos + this run's
    // placements). The next pass seeds its duplicate check from here, so a
    // network hiccup can never rain the same picture onto two slides again.
    grids: chosenGrids.map((g) => Array.from(g)).slice(-12),
  };
  // Leave `status` alone. Resetting it to draft used to drop a story that had
  // already been approved back into the review queue without saying so; the
  // photos changed, which the reviewer can see, but the status is their call.
  await db().from("stories").update({ slides, sourced_at: new Date().toISOString(), source_meta: meta }).eq("id", story.id);
  return { ...meta, cost: costReport() };
}

/* Body slides are the ones that can share a photo without looking broken. The
   cover inset is marked secondary: it's only used by two of the six layouts, so
   a second-best photo there matters far less than a good main photo on the
   cover. */
function listSlots(slides, overwrite) {
  const out = [];
  slides.forEach((s, i) => {
    const want = (field, role, text, secondary = false) => (overwrite || !s[field]?.src) && out.push({ key: `${i}.${field}`, index: i, field, role, text, secondary });
    if (s.layout === "cover") {
      want("bg", "cover main photo, full-bleed portrait 4:5", s.headline);
      want("inset", "second cover photo of the same subject, a different shot", null, true);
    } else {
      want("bg", "full-bleed portrait 4:5 background", [s.title, s.body?.replace(/\[\[|\]\]/g, "")].filter(Boolean).join(" — "));
    }
  });
  return out;
}

/* Up to CONCURRENT downloads at a time, and never more than MAX_BYTES in flight.
   Candidates are full-size press photos held until the end of the run, so
   firing all 16 at once can pull well over a hundred MB into one function. */
const CONCURRENT = 4;
const MAX_BYTES = Number(process.env.MAX_SOURCE_BYTES || 180 * 1024 * 1024);
// One press photo is never going to be useful above this, and it keeps a single
// oversized file from eating the whole budget.
const MAX_ONE = Number(process.env.MAX_SOURCE_IMAGE_BYTES || 40 * 1024 * 1024);

async function downloadAll(candidates) {
  const out = [];
  const queue = [...candidates];
  // Bytes we're holding: in-flight downloads plus accepted buffers. Checked
  // against the budget before each read, so we stay under it rather than
  // discovering afterwards that we blew past it.
  let held = 0;
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      const got = await download(c, MAX_BYTES - held);
      if (!got) continue;
      held += got.buf.length;
      out.push(got);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENT, queue.length) }, worker));
  return out;
}

/* Icons, app-store badges, stock-photo disclaimer cards and outlet mastheads
   are flat in a way photography never is: either a handful of colours, or one
   colour covering most of the frame. Counting colours on a small thumb caught
   the simplest cases, but anti-aliased text pushed button-shaped junk over the
   colour cap — so also measure how much of the picture the dominant colour
   owns. Badges run 35-55%; real photos measured here top out under 10%. */
const MIN_FLAT_COLORS = Number(process.env.MIN_IMAGE_COLORS || 24);
const DOMINANT_SHARE = Number(process.env.MAX_IMAGE_DOMINANT_SHARE || 0.33);
export async function isFlatGraphic(buf) {
  try {
    const { data, info } = await sharp(buf).rotate()
      .resize(48, 48, { fit: "inside" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hist = new Map();
    let total = 0;
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      hist.set(k, (hist.get(k) || 0) + 1);
      total++;
    }
    const top = Math.max(...hist.values());
    return hist.size < MIN_FLAT_COLORS || top / total >= DOMINANT_SHARE;
  } catch {
    return false; // can't measure it: assume it's a photo
  }
}

async function download(c, budget = Infinity) {
  try {
    const res = await fetch(c.url, { headers: { "user-agent": UA, referer: c.page || "" }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    // Trust content-length when the server sends it, so an oversized file is
    // refused before it's read rather than after.
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && (declared > MAX_ONE || declared > budget)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ONE || buf.length > budget) return null;
    // Icons, badges, wordmarks and disclaimer cards are junk however large
    // they are — drop them before they can reach a slide.
    if (await isFlatGraphic(buf)) return null;
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return null;
    const type = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" }[meta.format];
    if (!type) return null;
    // Cheap downscaled signature for dedupe; the original bytes are kept for
    // re-hosting at full quality.
    const grid = await ahash(buf);
    return { ...c, buf, w: meta.width, h: meta.height, short: Math.min(meta.width, meta.height), type, ext: meta.format === "jpeg" ? "jpg" : meta.format, grid };
  } catch {
    return null;
  }
}

// 16×16 normalised grayscale signature, used to spot the same photo served at
// two sizes or re-encoded by a CDN.
async function ahash(buf) {
  return sharp(buf)
    .resize(16, 16, { fit: "fill", kernel: "lanczos3" })
    .grayscale()
    .normalise()
    .raw()
    .toBuffer();
}

/* Compare images as a 16×16 normalised grayscale grid rather than a bit hash.
   Bit hashes are cheap but unstable: the same photo re-encoded at a different
   width shifts an 8×8 average hash by ~3 bits, so any threshold either misses
   real duplicates or merges distinct engravings. A mean-absolute-difference
   over the small grid separates cleanly instead — measured on real photos,
   the same image at any size scores under 8, while different artworks start
   around 25. THRESHOLD sits in the empty middle of that gap. */
const NEAR_SAME = 14;

function nearDuplicate(a, b) {
  if (a.buf && b.buf && a.buf.length === b.buf.length && a.buf.equals(b.buf)) return true;
  let total = 0;
  for (let i = 0; i < a.grid.length; i++) total += Math.abs(a.grid[i] - b.grid[i]);
  return total / a.grid.length <= NEAR_SAME;
}

function dedupe(list) {
  const keep = [];
  for (const c of [...list].sort((a, b) => b.short - a.short)) {
    if (!keep.some((k) => nearDuplicate(k, c))) keep.push(c);
  }
  return keep;
}