// Relative imports so the Netlify background function can bundle this file
// (see the note in jobs.js).
import { browser, appUrl, login } from "./browser";
import { db, BUCKET, publicUrl } from "./supabase";
import { HERO_VARIANTS } from "./carousel/constants";
import { JobError } from "./jobs";

/* Screenshots every slide of a story at 1080×1350 and uploads the JPGs to
   storage, one renders row per cover style.

   One page load covers every variant. Body slides are identical across
   variants, so they're screenshotted and uploaded once and shared by each
   variant's file list. */
export async function renderStory(id, requested) {
  const { data: story, error } = await db().from("stories").select("id, hero_variant").eq("id", id).single();
  if (error || !story) throw new JobError("Story not found", 404);
  const variants = [...new Set(requested?.length ? requested : [story.hero_variant])].filter((v) => HERO_VARIANTS.includes(v));
  if (!variants.length) throw new JobError("No valid cover styles requested");

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