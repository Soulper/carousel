// Relative imports on purpose: the tick loop and background functions bundle
// this file outside Next, which doesn't know the @/ alias (see jobs.js).
import { db } from "./supabase";
import { ai, aiConfigured, costReport, resetUsage } from "./ai";
import { parseJson } from "./anthropic";
import { JobError } from "./jobs";

/* writeCopy(storyId, { overwrite })
   Writes the words for every slide — the cover headline and each body slide's
   title + body — and the Instagram caption. Reads the photo captions the
   sourcer stored, so the copy is written about the picture that's actually
   there. Claude never invents facts: it's told to stick to what the captions
   and the source article support, and to keep claims checkable.

   Returns { written, applied, caption, cost }. Throws JobError when the reply
   isn't usable, so the tick loop records the same message a user would see. */
export async function writeCopy(id, { overwrite = false, hashtags = "" } = {}) {
  if (!aiConfigured()) throw new JobError("Set ANTHROPIC_API_KEY or GEMINI_API_KEY to write copy", 503);
  const { data: story } = await db().from("stories").select("*").eq("id", id).single();
  if (!story) throw new JobError("Story not found", 404);
  resetUsage();

  const slides = Array.isArray(story.slides) ? story.slides : [];
  if (!slides.length) throw new JobError("This story has no slides");

  // Which slides still need words?
  const todo = slides
    .map((slide, i) => ({ slide, i }))
    .filter(({ slide }) => {
      if (overwrite) return true;
      if (slide.layout === "cover") return !(slide.headline || "").trim();
      return !(slide.title || "").trim() || !(slide.body || "").trim();
    });
  const needCaption = overwrite || !(story.caption || "").trim();
  if (!todo.length && !needCaption) {
    return { message: "Every slide already has text and a caption." };
  }

  const cap = (slot) => (slot?.caption || "").trim();
  const brief = [
    story.title ? `Series title: ${story.title}` : null,
    story.source_url ? `Source article: ${story.source_url}` : null,
    "Slides, in order, with the photo each one will show:",
    ...slides.map((slide, i) => {
      const photo = cap(slide.bg) || (slide.layout === "cover" ? cap(slide.inset) : "");
      const label = slide.layout === "cover" ? "COVER" : "BODY";
      return `${i + 1}. [${label}]${photo ? ` photo: ${photo}` : " (no photo description available)"}` +
        (slide.layout !== "cover" && (slide.title || slide.body) ? `\n   existing text, for tone only: ${(slide.title || "")} ${(slide.body || "").replace(/\[\[|\]\]/g, "")}` : "");
    }),
  ].filter(Boolean).join("\n");

  const written = parseJson(await ai({
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
      "- Keep the tone consistent across the series.\n" +
      "- Also write one Instagram caption for the whole post: 1-3 short paragraphs, plain text, ending with a line crediting every photographer in the format '📸 Photographer name'. " +
      (hashtags ? `End the caption with exactly this hashtag line: ${hashtags}\n` : "") +
      "- The whole caption, hashtags included, must stay under 2100 characters.\n\n" +
      'Reply with only JSON: {"slides":[{"index":0,"headline":"...","title":"...","body":"... with [[brackets]] ..."}],"caption":"..."}. ' +
      "Use headline for the cover and title/body for the rest. Match every index from the brief.",
    messages: [{ role: "user", content: brief }],
    maxTokens: 3000,
    label: `copy ${id.slice(0, 8)}`,
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

  const caption = typeof written.caption === "string" ? written.caption.trim().slice(0, 2200) : "";
  if (!applied.length && !caption) {
    throw new JobError("Claude didn't return usable text. Try again.", 502);
  }

  const patch = {};
  if (applied.length) patch.slides = next;
  if (caption) patch.caption = caption;
  await db().from("stories").update(patch).eq("id", id);
  return { written: applied.length, applied, caption, cost: costReport() };
}
