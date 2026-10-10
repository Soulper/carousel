import { browser, appUrl } from "@/lib/browser";
import { db, BUCKET, publicUrl } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";
import { HERO_VARIANTS } from "@/lib/carousel/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* POST /api/render/:storyId   { variants?: ["depth", "band", ...] }
   Renders each requested cover style plus the rest of the slides, uploads JPGs
   to storage, records a row in `renders` per variant.

   One page load covers every variant. Body slides are identical across
   variants, so they're screenshotted and uploaded once and shared by each
   variant's file list. */
export async function POST(req, { params }) {
  return run(async () => {
    const body = await req.json().catch(() => ({}));
    const { data: story, error } = await db().from("stories").select("id, hero_variant").eq("id", params.id).single();
    if (error || !story) return fail("Story not found", 404);
    const variants = [...new Set(body.variants?.length ? body.variants : [story.hero_variant])].filter((v) => HERO_VARIANTS.includes(v));
    if (!variants.length) return fail("No valid cover styles requested");

    const b = await browser();
    const page = await b.newPage();
    try {
      await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
      if (process.env.STUDIO_USER) {
        await page.authenticate({ username: process.env.STUDIO_USER, password: process.env.STUDIO_PASSWORD });
      }
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
      if (!results.length) return fail("That story has no cover slide to render");

      await db().from("stories").update({ status: "rendered" }).eq("id", story.id);
      return ok({ renders: results });
    } finally {
      await page.close();
    }
  });
}
