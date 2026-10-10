import sharp from "sharp";
import { db, BUCKET, publicUrl } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";
import { claude, parseJson, costReport, resetUsage } from "@/lib/anthropic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIN_SHORT = Number(process.env.MIN_IMAGE_SHORT_SIDE || 1000); // px on the short side
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/* POST /api/source/:storyId  { overwrite?: boolean }
   1. Claude (web search + fetch) finds coverage of the story and lists photo URLs
   2. We download them, measure them, drop small ones and near-duplicates
   3. Claude looks at the survivors and assigns the best one to each slot, with a focal point
   4. Winners + runners-up are re-hosted in storage and written into the slides */
export async function POST(req, { params }) {
  return run(async () => {
    if (!process.env.ANTHROPIC_API_KEY) return fail("Set ANTHROPIC_API_KEY to use image sourcing", 503);
    const { overwrite = false } = await req.json().catch(() => ({}));
    const { data: story } = await db().from("stories").select("*").eq("id", params.id).single();
    if (!story) return fail("Story not found", 404);
    resetUsage();

    const slots = listSlots(story.slides, overwrite);
    if (!slots.length) return ok({ message: "Every slot already has an image. Pass overwrite: true to re-source." });

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
          const raw = await claude(opts);
          return typeof raw === "string" ? parseJson(raw) : raw;
        } catch (e) {
          last = e;
          if (i < tries - 1) console.warn(`source: Claude reply ${i + 1} unusable (${e.message}), retrying`);
        }
      }
      throw last;
    };

    const found = await ask({
      system:
        "You source editorial photos for news carousel posts. Use web search and web fetch to find 2-5 reputable articles " +
        "covering this exact story (fetch the source article first if one is given). From the fetched pages, collect direct " +
        "image file URLs that appear in the page content: the main/og image, in-article photos, and the largest variant offered " +
        "in any srcset. Only list URLs that literally appear in fetched content; never invent or edit a URL. Skip logos, icons, " +
        "avatars, ads, maps, charts, and screenshots of social posts. Prefer photos of the subject itself, varied shots and angles. " +
        "Give one image per article you read, even when the articles overlap, and take the largest version offered in any srcset. " +
        'Reply with only JSON: {"candidates":[{"url":"...","page":"article url","caption":"what it shows","credit":"photographer/agency if stated"}]} — at most 16.',
      messages: [{ role: "user", content: brief }],
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 8 },
        { type: "web_fetch_20250910", name: "web_fetch", max_uses: 8 },
      ],
      maxTokens: 8000,
      label: `source:find ${params.id.slice(0, 8)}`,
    });

    // ---- 2. download, measure, filter
    const seen = new Set();
    const raw = (found.candidates || []).filter((c) => c?.url && !seen.has(c.url) && seen.add(c.url)).slice(0, 16);
    const fetched = await downloadAll(raw);
    let pool = dedupe(fetched).sort((a, b) => b.short - a.short);

    // Prefer photos that clear the size bar, but top up from the smaller ones so
    // each slot can get its own picture. Nine repeats of one sharp photo is a
    // worse post than nine distinct photos a little soft, so a shortfall in
    // resolution is worth trading for variety.
    const big = pool.filter((c) => c.short >= MIN_SHORT);
    const rest = pool.filter((c) => c.short < MIN_SHORT);
    const want = Math.min(slots.length, 12);
    const chosen = [...big, ...rest].slice(0, want);
    const lowRes = big.length < Math.min(2, slots.length) || chosen.some((c) => c.short < MIN_SHORT);
    pool = chosen;
    if (!pool.length) return fail("Couldn't find usable photos for this story. Add a source_url or upload images by hand.", 422);
    const shortfall = Math.max(0, slots.length - pool.length);

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
        "Pick the best image for each slot. Rules: the subject must be clearly visible and large; reject images with baked-in text, " +
        "watermarks, collages or heavy logos; the cover main photo should leave room for a headline over its lower part; body slides " +
        "should match their text. " +
        "IMPORTANT: use a different photo number for each main slot. Spread them out — never put the same number twice. " +
        "focal is the subject's centre as [x%, y%] of that image. " +
        'Reply with only JSON: {"assign":[{"slot":"...","image":0,"focal":[50,40],"why":"short reason"}]}. ' +
        "One entry per slot listed above, no more and no fewer.",
    });
    const picked = await ask({ messages: [{ role: "user", content }], maxTokens: 2000, label: `source:assign ${params.id.slice(0, 8)}` });

    // Claude sometimes returns fewer entries than asked, or misses slots. Fill
    // any gap from the photos it didn't use, in slide order, so every slot gets
    // its own image rather than the leftover ones silently keeping the old photo.
    const unanswered = slots.filter((s) => !(picked.assign || []).some((a) => a.slot === s.key));
    if (unanswered.length) {
      const usedByClaude = new Set((picked.assign || []).map((a) => Number(a.image)).filter((n) => !Number.isNaN(n)));
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
      unfilled,                 // slots left with their previous photo
      lowRes,
      candidates: fetched.length,
      kept: pool.length,
      distinct,                 // visually different photos used
      slots: slots.length,
      shortfall,                // photos fewer than slots, before assignment
      reused,                   // slots that had to double up
    };
    // Leave `status` alone. Resetting it to draft used to drop a story that had
    // already been approved back into the review queue without saying so; the
    // photos changed, which the reviewer can see, but the status is their call.
    await db().from("stories").update({ slides, sourced_at: new Date().toISOString(), source_meta: meta }).eq("id", story.id);
    return ok({ ...meta, cost: costReport() });
  });
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
   Candidates are full-size press photos held until the end of the request, so
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
