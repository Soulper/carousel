// Relative imports so the Netlify background function can bundle this file
// (see the note in jobs.js).
import { browser, appUrl, login } from "./browser";
import { db, BUCKET, publicUrl } from "./supabase";
import { HERO_VARIANTS } from "./carousel/constants";
import { JobError } from "./jobs";
import { isFlatGraphic } from "./source";

/* Screenshots every slide of a story at 1080×1350 and uploads the JPGs to
   storage, one renders row per cover style.

   One page load covers every variant. Body slides are identical across
   variants, so they're screenshotted and uploaded once and shared by each
   variant's file list. */
export async function renderStory(id, requested) {
  const { data: story, error } = await db().from("stories").select("id, slides, hero_variant").eq("id", id).single();
  if (error || !story) throw new JobError("Story not found", 404);
  const variants = [...new Set(requested?.length ? requested : [story.hero_variant])].filter((v) => HERO_VARIANTS.includes(v));
  if (!variants.length) throw new JobError("No valid cover styles requested");

  // Rendering a slide without a photo would stamp the studio's gray
  // "No bg image yet" placeholder into a finished JPG, so stop here and say
  // what's missing instead. A story with text and no photos is still fine to
  // preview — it just can't ship yet.
  const slides = story.slides || [];
  const missing = slides.filter((s) => !s.bg?.src).length;
  if (missing > 0) {
    throw new JobError(
      missing === slides.length
        ? "No photos yet — press “Find photos” first, then “Make images”."
        : `${missing} of ${slides.length} slides don't have a photo yet — press “Find photos” first, then “Make images”.`,
      422,
    );
  }

  /* Slides sourced by older, looser passes can still hold logo/icon cards.
     Check the actual images before shipping: a flat graphic isn't a photo,
     and one bad slide is one bad post. */
  const graphic = [];
  for (let i = 0; i < slides.length; i++) {
    const src = slides[i]?.bg?.src;
    if (!src) continue;
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      if (await isFlatGraphic(Buffer.from(await res.arrayBuffer()))) graphic.push(i + 1);
    } catch { /* can't verify this one: let the render proceed */ }
  }
  if (graphic.length) {
    throw new JobError(
      `Slide ${graphic.join(", ")} has ${graphic.length === 1 ? "a logo or icon card" : "logo or icon cards"} instead of a real photo — it would look broken in the post. Press “Find photos” to swap ${graphic.length === 1 ? "it" : "them"}, or open the slide and upload a picture.`,
      422,
    );
  }

  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
    await login(page);
    const runId = Date.now();
    const base = `renders/${story.id}/${runId}`;
    await page.goto(`${appUrl()}/render/${story.id}?variants=${variants.join(",")}`, { waitUntil: "networkidle0", timeout: 60000 });
    // Ready = fonts loaded, every image decoded, no layout still measuring
    await page.waitForFunction(
      () => document.fonts.status === "loaded" &&
        [...document.images].every((i) => i.complete) &&
        !document.querySelector("[data-pending]"),
      { timeout: 30000 }
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // Fitted text re-measures itself when a web font swaps in, which can land a
    // beat AFTER fonts report loaded. Screenshot too early and a headline is
    // caught at its raw maximum — full-bleed and clipped by the frame. So hold
    // until every fitted size reads the same across a beat.
    await page.waitForFunction(
      (sel) => {
        const sizes = () => [...document.querySelectorAll(sel)].map((d) => d.style.fontSize).join("|");
        return new Promise((resolve) => {
          const first = sizes();
          setTimeout(() => resolve(first.length > 0 && first === sizes()), 350);
        });
      },
      { timeout: 30000 },
      "[data-slide] div[style*='font-size']",
    );

    const put = (path, jpg) =>
      db().storage.from(BUCKET).upload(path, jpg, { contentType: "image/jpeg" }).then(({ error }) => {
        if (error) throw error;
        return publicUrl(path);
      });

    // Body slides once, shared by every variant below
    const bodyFiles = [];
    for (const el of await page.$$("[data-body] [data-slide]")) {
      const n = Number(await el.evaluate((node) => node.getAttribute("data-slide")));
      const url = await put(`${base}/slide-${n}.jpg`, await el.screenshot({ type: "jpeg", quality: 92 }));
      bodyFiles.push({ slide: n, url });
    }

    const results = [];
    for (const sheet of await page.$$("[data-cover]")) {
      const variant = await sheet.evaluate((node) => node.getAttribute("data-cover"));
      const el = await sheet.$("[data-slide]");
      if (!el) continue;
      const url = await put(`${base}/${variant}-slide-1.jpg`, await el.screenshot({ type: "jpeg", quality: 92 }));
      const files = [{ slide: 1, url }, ...bodyFiles];
      const { data: row, error: insErr } = await db().from("renders").insert({ story_id: story.id, variant, files }).select().single();
      if (insErr) throw insErr;
      results.push(row);
    }
    if (!results.length) throw new JobError("That story has no cover slide to render");

    await db().from("stories").update({ status: "rendered" }).eq("id", story.id);
    return { renders: results };
  } finally {
    await page.close();
  }
}