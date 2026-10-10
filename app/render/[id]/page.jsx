import { notFound } from "next/navigation";
import { db, isConfigured } from "@/lib/supabase";
import RenderSlides from "./RenderSlides";
import { sampleStoryRow } from "@/lib/preview";
import { HERO_VARIANTS } from "@/lib/carousel/constants";

export const dynamic = "force-dynamic";

/* Bare page Puppeteer screenshots: slides at 1080×1350, no app chrome.
   Takes `?variants=depth,band` (or `?variant=depth`) so one page load can
   cover every requested cover style. Body slides don't change with the cover
   style, so they're emitted once in a shared sheet and screenshotted once. */
export default async function RenderPage({ params, searchParams }) {
  const sample = isConfigured() ? null : sampleStoryRow();
  const story = sample ?? (await db().from("stories").select("slides, hero_variant, pages(brand)").eq("id", params.id).single()).data;
  if (!story) notFound();

  const asked = String(searchParams.variants || searchParams.variant || "")
    .split(",").map((v) => v.trim()).filter((v) => HERO_VARIANTS.includes(v));
  const variants = asked.length ? [...new Set(asked)] : [story.hero_variant || "depth"];

  return (
    <RenderSlides
      slides={story.slides || []}
      brand={sample ? {} : story.pages?.brand || {}}
      variants={variants}
    />
  );
}
