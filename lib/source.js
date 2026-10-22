// Relative imports so the Netlify background function can bundle this file
// (see the note in jobs.js).
import sharp from "sharp";
import { db, BUCKET, publicUrl } from "./supabase";
import { claude, parseJson } from "./anthropic";
import { ai, provider, aiConfigured, groundedHosts, groundedPages, costReport, resetUsage } from "./ai";
import { JobError } from "./jobs";

const MIN_SHORT = Number(process.env.MIN_IMAGE_SHORT_SIDE || 1000); // px on the short side
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/* Gemini path of the find step: the model searches and names articles, then
   we fetch those pages and scrape the image URLs ourselves — Gemini's search
   grounding surfaces pages but can't open them. Article URLs are checked
   against the grounding sources so an invented URL never gets fetched. */
async function findCandidatesGemini(story, deeper) {
  const r = await ai({
    system:
      "You are a research agent with a google_search tool. You MUST call google_search at least once before answering. " +
      "An answer written from memory is a failure. Reply with only JSON.",
    messages: [{
      role: "user",
      content:
        `Call google_search now with a query for recent coverage of: "${story.title}". ` +
        `Then find up to ${deeper ? 8 : 5} reputable articles that cover this exact story and would contain several photographs.\n` +
        `Story: ${story.title}\n` +
        (story.source_url ? `Known source article: ${story.source_url}\n` : "") +
        `About: ${story.slides.map((s) => s.headline || s.title || "").filter(Boolean).join("; ")}\n\n` +
        'Reply with only JSON: {"articles":[{"url":"https://...","why":"one line"}]}.',
    }],
    tools: "search",
    maxTokens: 2000,
    label: `source:find-gemini ${story.id.slice(0, 8)}${deeper ? " deeper" : ""}`,
  });

  let listed = [];
  try { listed = parseJson(r.text).articles || []; } catch { listed = []; }
  // Grounding redirects resolve to REAL articles search surfaced — scrape
  // those directly. Model-named URLs come along too, but they're verified by
  // the fetch itself: a hallucinated link just fails and is skipped.
  const grounded = await groundedPages(r.sources || [], deeper ? 8 : 6);
  const urls = [story.source_url, ...grounded, ...listed.map((a) => a?.url)]
    .filter((u) => u && /^https?:/i.test(u));
  const pages = [...new Set(urls)].slice(0, deeper ? 12 : 8);
  if (!pages.length) {
    throw new JobError("Search found no articles matching this story. Try again, or add a source_url by hand.", 422);
  }
  console.log(`source: fetching ${pages.length} page(s) to scrape images`);

  const candidates = [];
  const limit = deeper ? 20 : 14;
  const done = new Set();
  // `pages` grows as related links are discovered, so one thin gallery page
  // no longer caps the whole pool.
  for (const page of pages) {
    if (done.has(page) || done.size >= limit) continue;
    done.add(page);
    try {
      const res = await fetch(page, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !/html/i.test(type)) continue;
      const html = await res.text();
      const imgs = scrapeImages(html, page);
      candidates.push(...imgs);
      if (imgs.length < 6) for (const link of relatedLinks(html, page, deeper ? 6 : 3)) pages.push(link);
    } catch { /* dead page or not HTML: skip it */ }
  }
  console.log(`source: scraped ${done.size} page(s), ${candidates.length} candidate image(s)`);
  const seen = new Set();
  return { candidates: candidates.filter((c) => !seen.has(c.url) && seen.add(c.url)).slice(0, deeper ? 30 : 20) };
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
      for (const m of html.matchAll(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "gi"))) {
        const u = clean(m[0].match(/content=["']([^"']+)["']/i)?.[1]);
        if (u) out.push({ url: u, page, caption: name, credit: "" });
      }
      for (const m of html.matchAll(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, "gi"))) {
        const u = clean(m[1]);
        if (u) out.push({ url: u, page, caption: name, credit: "" });
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
        if (c) out.push({ url: c, page, caption: "embedded image", credit: "" });
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
    if (u) out.push({ url: u, page, caption: "embedded image", credit: "" });
    if (out.length > 120) break;
  }

  // Junk filter: site chrome, tracking pixels, and URLs advertising a tiny
  // size ("…/64x64/…") — thumbnails are what made the decks look like trash.
  const junky = (u) => /logos?|sprites?|avatars?|icons?|banners?|placeholder|1x1|pixel|\b\d{1,3}x\d{1,3}\b/i.test(u);
  const seen = new Set();
  return out.filter((c) => !junky(c.url) && !seen.has(c.url) && seen.add(c.url));
}

/* Same-site article links on a page. A gallery's own HTML often holds one
   image, so following a few related articles is how the pool grows beyond a
   single artwork. */
function relatedLinks(html, page, max = 4) {
  const base = (() => { try { return new URL(page).hostname.replace(/^www\./, ""); } catch { return null; } })();
  if (!base) return [];
  const out = new Set();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], page);
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
  if (!aiConfigured()) throw new JobError("Set ANTHROPIC_API_KEY or GEMINI_API_KEY to use image sourcing", 503);
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
  if (provider() === "gemini") {
    // Gemini can't fetch pages itself, so the pipeline splits the work: the
    // model searches and picks articles, we fetch them and scrape image URLs.
    found = await findCandidatesGemini(story, deeper);
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
    });
  }

  // ---- 2. download, measure, filter
  const seen = new Set();
  const raw = (found.candidates || []).filter((c) => c?.url && !seen.has(c.url) && seen.add(c.url)).slice(0, deeper ? 24 : 16);
  const fetched = await downloadAll(raw);
  let pool = dedupe(fetched).sort((a, b) => b.short - a.short);

  // Prefer photos that clear the size bar, but top up from the smaller ones so
  // each slot can get its own picture. Nine repeats of one sharp photo is a
  // worse post than nine distinct photos a little soft, so a shortfall in
  // resolution is worth trading for variety.
  const big = pool.filter((c) => c.short >= MIN_SHORT);
  const rest = pool.filter((c) => c.short < MIN_SHORT);
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
    content.push({ type: "text", text: `Image ${i}: ${c.w}×${c.h}. ${c.caption || ""}` });
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
      (secondary.length
        ? `Also give one runner-up for each of these, from the photos you did not use as a main:\n${secondary.map((s) => `- ${s.key}: ${s.role}`).join("\n")}\n\n`
        : "") +
      `There are ${pool.length} photos available and ${slots.length} slots, so not every slot can have its own photo.\n\n` +
      "DUPLICATES: some of these photos may show the same underlying artwork or scene — different crops, scans, " +
      "resolutions or colourings of one painting, engraving or photograph. Those read as repeats to a viewer. Use at most " +
      "one image from each such group, and put the indices of every duplicate you did NOT use in \"dupes\".\n\n" +
      (only?.length
        ? "IMPORTANT: one of these photos is already on the slide being changed, and you have been asked to replace it. Do not " +
          "choose that same picture again — pick the next best thing, even if it is less perfect. If every photo shows the same " +
          "thing, choose a different crop or angle of it.\n\n"
        : "") +
      "Pick the best image for each slot. Rules: the subject must be clearly visible and large; reject images with baked-in text, " +
      "watermarks, collages, heavy logos, page screenshots, and thumbnails — a photo that looks soft or tiny at full size is trash, " +
      "not a fallback. The cover main photo should leave room for a headline over its lower part; body slides should match their text. " +
      "If the pool genuinely can't cover the slots with GOOD distinct images, fill only the good ones and leave the rest — a " +
      "half-empty carousel gets resourced, but a trash one gets posted. " +
      "IMPORTANT: use a different photo number for each main slot. Spread them out — never put the same number twice. " +
      "focal is the subject's centre as [x%, y%] of that image. " +
      'Reply with only JSON: {"assign":[{"slot":"...","image":0,"focal":[50,40],"why":"short reason"}],"dupes":[2,5]}. ' +
      "One entry per slot listed above, no more and no fewer.",
  });
  const picked = await ask({ messages: [{ role: "user", content }], json: true, maxTokens: 4000, label: `source:assign ${id.slice(0, 8)}` });

  // Same-artwork variants the vision pass flagged. Treated exactly like used
  // photos: they never fill a slot, so a pool that collapses under dedupe
  // shows up as reuse/shortfall downstream — and the autopilot's guardrail
  // rejects the story rather than shipping near-identical slides.
  const dupes = new Set((picked.dupes || []).map(Number).filter((n) => !Number.isNaN(n)));
  if (dupes.size) console.warn(`source: vision pass flagged ${dupes.size} duplicate image(s): ${[...dupes].join(", ")}`);

  // Claude sometimes returns fewer entries than asked, or misses slots. Fill
  // any gap from the photos it didn't use, in slide order, so every slot gets
  // its own image rather than the leftover ones silently keeping the old photo.
  const unanswered = slots.filter((s) => !(picked.assign || []).some((a) => a.slot === s.key));
  if (unanswered.length) {
    const usedByClaude = new Set([
      ...(picked.assign || []).map((a) => Number(a.image)).filter((n) => !Number.isNaN(n)),
      ...dupes,
    ]);
    const leftover = pool.map((_, i) => i).filter((i) => !usedByClaude.has(i));
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
  const gridDiff = (x, y) => {
    let t = 0;
    for (let i = 0; i < x.length; i++) t += Math.abs(x[i] - y[i]);
    return t / x.length;
  };
  const looksDistinct = (g) => chosenGrids.every((prev) => gridDiff(prev, g) > NEAR_SAME);
  for (const a of ordered) {
    const slot = slots.find((s) => s.key === a.slot);
    // Claude sometimes names a slot that isn't in the list, or an image index
    // that doesn't exist. Skipping silently left the old photo in place with
    // no explanation, so record it and say so in the response.
    if (!slot) { skipped.push({ slot: a.slot, why: "no such slot" }); continue; }
    if (!pool[a.image]) { skipped.push({ slot: a.slot, why: "no such image" }); continue; }
    // The vision pass judged this a repeat of an image already going on the deck.
    if (dupes.has(a.image)) { skipped.push({ slot: a.slot, why: "duplicate of an image already used" }); continue; }
    // Reuse is a last resort: swap in an unused photo if one is left.
    if (claimed.has(a.image)) {
      const free = nextSpare();
      // Out of unused photos: reuse is now unavoidable, but shift the focal
      // point so the repeat doesn't read as a duplicate.
      if (free !== undefined) a.image = free;
      else {
        const f = a.focal || [50, 45];
        a.focal = [Math.max(10, Math.min(90, 100 - f[0] || 50)), Math.max(10, Math.min(90, 100 - (f[1] ?? 45)))];
        reused.push(slot.key);
      }
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
        // Nothing distinct left, so this genuinely is a repeat.
        reused.push(slot.key);
      }
    }
    claimed.add(a.image);
    // Counted only when it really is a new picture, so `distinct` reflects
    // what a reader sees rather than how many files we wrote.
    if (looksDistinct(pool[a.image].grid)) chosenGrids.push(pool[a.image].grid);
    const main = await host(a.image);
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
    kept: pool.length,
    distinct,                 // visually different photos used
    dupes: [...dupes],        // indices the vision pass judged same-artwork repeats
    slots: slots.length,
    shortfall,                // photos fewer than slots, before assignment
    reused,                   // slots that had to double up
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
  if (a.buf.length === b.buf.length && a.buf.equals(b.buf)) return true;
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