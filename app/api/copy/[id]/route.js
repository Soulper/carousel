import { db } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";
import { claude, parseJson, costReport, resetUsage } from "@/lib/anthropic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/* POST /api/copy/:storyId   { overwrite?: boolean }
   Writes the words for every slide: the cover headline and each body slide's
   title + body. Reads the photo captions the sourcer stored, so the copy is
   written about the picture that's actually there.

   Claude never invents facts. It's told to stick to what the captions and the
   source article support, and to keep claims checkable. */
export async function POST(req, { params }) {
  return run(async () => {
    if (!process.env.ANTHROPIC_API_KEY) return fail("Set ANTHROPIC_API_KEY to write copy", 503);
    const { overwrite = false } = await req.json().catch(() => ({}));
    const { data: story } = await db().from("stories").select("*").eq("id", params.id).single();
    if (!story) return fail("Story not found", 404);
    resetUsage();
    const slides = Array.isArray(story.slides) ? story.slides : [];
    if (!slides.length) return fail("This story has no slides");

    // Which slides still need words?
    const todo = slides
      .map((s, i) => ({ slide: s, i }))
      .filter(({ slide }) => {
        if (overwrite) return true;
        if (slide.layout === "cover") return !(slide.headline || "").trim();
        return !(slide.title || "").trim() || !(slide.body || "").trim();
      });
    if (!todo.length) return ok({ message: "Every slide already has text. Pass overwrite: true to rewrite." });

    const cap = (slot) => (slot?.caption || "").trim();
    const brief = [
      story.title ? `Series title: ${story.title}` : null,
      story.source_url ? `Source article: ${story.source_url}` : null,
      "Slides, in order, with the photo each one will show:",
      ...todo.map(({ slide, i }) => {
        const photo = cap(slide.bg) || (slide.layout === "cover" ? cap(slide.inset) : "");
        const label = slide.layout === "cover" ? "COVER" : "BODY";
        return `${i + 1}. [${label}]${photo ? ` photo: ${photo}` : " (no photo description available)"}` +
          (slide.layout !== "cover" && (slide.title || slide.body) ? `\n   existing text, for tone only: ${(slide.title || "")} ${(slide.body || "").replace(/\[\[|\]\]/g, "")}` : "");
      }),
    ].filter(Boolean).join("\n");

    const written = parseJson(await claude({
      system:
        "You write the words for an Instagram photo carousel. Write for someone scrolling fast on a phone.\n\n" +
        "Rules:\n" +
        "- Ground every claim in the photo captions and the source article. Do not invent facts, numbers, names, dates or quotes. If the captions don't support a specific claim, write around it.\n" +
        "- Match each line to its own photo. The caption tells you what is actually in frame.\n" +
        "- Body slide titles: 2 to 5 words, punchy, sentence case.\n" +
        "- Body slide body: one or two sentences, plain and concrete. Read it out loud; cut anything that sounds written.\n" +
        "- Cover headline: 3 to 8 words. It must work as a big display headline, so keep it short enough not to shrink into tiny type.\n" +
        "- Wrap the single most interesting 2 to 4 words in [[double brackets]] on each body slide. Never bracket more than one phrase per slide, and never the title.\n" +
        "- No emoji, no hashtags, no call to follow, no rhetorical questions that the slide doesn't answer.\n" +
        "- Keep the tone consistent across the series.\n\n" +
        'Reply with only JSON: {"slides":[{"index":0,"headline":"...","title":"...","body":"... with [[brackets]] ..."}]}. ' +
        "Use headline for the cover and title/body for the rest. Match every index from the brief.",
      messages: [{ role: "user", content: brief }],
      maxTokens: 3000,
      label: `copy ${params.id.slice(0, 8)}`,
    }));

    const byIndex = new Map((written.slides || []).map((s) => [Number(s.index), s]));
    const next = structuredClone(slides);
    const applied = [];
    for (const { i } of todo) {
      const w = byIndex.get(i);
      if (!w) continue;
      const slide = next[i];
      if (slide.layout === "cover") {
        if (typeof w.headline === "string" && w.headline.trim()) {
          slide.headline = w.headline.trim().slice(0, 200);
          applied.push({ slide: i, headline: slide.headline });
        }
        continue;
      }
      if (typeof w.title === "string" && w.title.trim()) slide.title = w.title.trim().slice(0, 90);
      if (typeof w.body === "string" && w.body.trim()) slide.body = w.body.trim().slice(0, 600);
      if (slide.title || slide.body) applied.push({ slide: i, title: slide.title });
    }
    if (!applied.length) return fail("Claude didn't return usable text. Try again.", 502);

    await db().from("stories").update({ slides: next }).eq("id", story.id);
    return ok({ written: applied.length, applied, cost: costReport() });
  });
}