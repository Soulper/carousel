// Relative imports on purpose: the tick loop and background functions bundle
// this file outside Next, which doesn't know the @/ alias (see jobs.js).
import { db } from "./supabase";
import { ai, aiConfigured, costReport, resetUsage } from "./ai";
import { parseJson } from "./anthropic";
import { JobError } from "./jobs";
import { isBlankText } from "./carousel/blank";

/* Best-effort plain-text read of the source article. Returns "" when it can't
   be fetched — the writer then falls back to captions and the query lines,
   which is still better than inventing. */
async function articleText(url, max = 6000) {
  const AMP = String.fromCharCode(38);
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
  const flatten = (raw) => raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .split(AMP + "amp;").join(AMP).split(AMP + "#39;").join("'")
    .replace(/\s+/g, " ")
    .trim();
  // A reader service returns markdown; strip its header lines, image markdown,
  // link targets and footnote markers so only prose survives.
  const tidyReader = (raw) => raw
    .replace(/^(Title|URL Source|Published Time|Markdown Content|Warning):.*$/gim, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\d+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const direct = async () => {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/html/i.test(type)) return "";
    return flatten(await res.text());
  };
  /* Outlets answer a server fetch with 403/406 (bot shielding) while still
     serving readable text to a reader proxy. This is the difference between a
     deck written from the article and one written from its headline — the
     vague-copy bug's actual root cause. */
  const viaReader = async () => {
    const res = await fetch("https://r.jina.ai/" + url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return "";
    return tidyReader(await res.text());
  };

  for (const attempt of [direct, viaReader]) {
    try {
      const t = await attempt();
      if (!t) continue;
      // Pages open with a wall of navigation. Truncating first hands the model
      // (and the extractive fallback) pure chrome with no sentence breaks, so
      // pull the sentence-shaped text out first, then cap its length.
      const sentences = (t.match(/[^.!?]+[.!?]+/g) || [])
        .map((s) => s.trim())
        .filter((s) => s.length >= 40 && s.length <= 400 && !BORING.test(s) &&
          !/(site:\s*media|pageType|section:|slug:|route:|article_single|home-arena|\|\s*arena|- CBS Sports|Markdown Content)/i.test(s));
      const text = sentences.length >= 3 ? sentences.join(" ") : t;
      if (text.length > 400) return text.slice(0, max);
    } catch { /* try the next reader */ }
  }
  return "";
}

/* ---- Copy quality floor -------------------------------------------------
   Weak fallback models (the ones the free tier drops to when the good model's
   quota runs out) answer with horoscope filler — "the landscape has shifted",
   "chaos reigns" — that reads fine and says nothing. Nothing like that ships:
   measure the copy against the article's own vocabulary, and when a slide
   says nothing, rebuild it from the article's real sentences instead. */

const STOP = new Set(
  ("the a an and or but of to in for on with at by from is are was were be been being will would can could should shall may might must " +
    "this that these those it its as if than then so about into over after before while when where who whom which what how not no more most " +
    "other some such only own same too very just don now also we you they he she his her their our your my there here have has had do does did")
    .split(/\s+/),
);

function vocabOf(text) {
  const set = new Set();
  for (const w of (text || "").toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) if (!STOP.has(w)) set.add(w);
  return set;
}

// A concrete fact: a rank/score/record, or a verb that reports something that
// happened. "Week 10" doesn't count — the digits have to belong to a fact.
const FACT_NUMBER = /\bNo\.?\s?\d+|\btop\s?-?\d+\b|\b\d+\s?[–—-]\s?\d+\b|\b\d{1,2}-\d{1,2}\b/i;
const FACT_VERB = /\b(beat|beats|lost|lose|loses|win|wins|won|ranked|ranks|sits|sit|needs?|fell|falls|fall|stands?|leads?|defeated|upsets?|surges?|climbs?|drops?|slips?|eliminat\w*|undefeated|record|scored|threw|passed|rushed|clinched|hosts?|travels?|visits?|meets?|opens?)\b/i;
// The filler that made decks read like horoscopes. Two of these and a slide is
// talking about the story instead of telling it.
const FILLER = /\b(key|important|significant|impact|expected|one of the|slate|matchup|contest|clash|shake\s?up|landscape|chaos|reigns|conversation|storyline|scenario|narrative)\b/gi;

/* True when a line carries no concrete content: no rank/score/record, no
   reporting verb, and little of the article's own vocabulary. A slide with a
   real fact ("lost by 16", "No. 9 BYU", "beat Notre Dame") always passes. */
function isVague(text, vocab) {
  const clean = (text || "").replace(/\[\[|\]\]/g, "").trim();
  if (!clean) return true;
  if ((clean.match(FILLER) || []).length >= 2) return true;
  const hits = (clean.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []).filter((w) => vocab.has(w)).length;
  return !(FACT_NUMBER.test(clean) || FACT_VERB.test(clean)) && hits < 3;
}

// Boilerplate that lives on every article page but is not the story.
const BORING = /\b(sign up|subscribe|copyright|all rights reserved|read more|terms of|privacy policy|follow (us|along)|advertisement|watch (live|now)|stream(ing)? (on|the|live)|use code|bet(t?ing)? (odds|lines)|powered by|share this|comments?)\b/i;

/* Reader text glues headings and bylines onto the paragraph that follows
   ("Position-by-position breakdown David Cobb No 22 Arizona, BYU sits…"). Trim
   everything before the sentence actually starts. */
function stripLead(s) {
  const m = s.match(/^.{0,90}?(?=\b\d{1,2}\s[A-Z]|\bThe\s[A-Z][a-z]+\s(?:are|is|was|were|has|have|will|sits|sitting|fell|lost|beat|beats|wins?|won|needs?|plays?|leads?)\b)/);
  return m ? s.slice(m[0].length) : s;
}

function sentencesOf(text) {
  // "No. 11 Notre Dame" must not split after "No." — abbreviations would leave
  // sentences starting mid-phrase ("14 LSU are the most overranked…").
  return (text || "")
    .replace(/\b(No|Mr|Ms|Mrs|Dr|St|vs|etc|Jr|Sr|U\.S)\.\s+/gi, "$1 ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => stripLead(s.replace(/\[\[|\]\]/g, "").replace(/\s+/g, " ").trim()))
    .filter((s) => s.length >= 50 && s.length <= 320 && !BORING.test(s));
}

function rankSentence(s, vocab) {
  let score = 0;
  if (/\d/.test(s)) score += 2;                                        // scores, ranks, records
  score += Math.min(3, (s.match(/\b[A-Z][a-z]{2,}\b/g) || []).length); // named people/places
  if (/\b(no\.|beat|loss|lost|win|won|ranked|rankings|playoff|defeat|upset|standings|undefeated)\b/i.test(s)) score += 2;
  const hits = (s.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []).filter((w) => vocab.has(w)).length;
  return score + Math.min(2, hits / 8);
}

// Wrap the most concrete 2-4 word phrase so the template's highlight has a target.
function bracketize(s) {
  const m = s.match(/\bNo\.\s*\d+\b|\b\d+[–-]\d+\b|\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/);
  if (!m || m[0].length < 4 || s.includes("[[")) return s;
  return s.replace(m[0], `[[${m[0]}]]`);
}

function titleize(s) {
  const skip = /^(The|This|That|These|Those|And|But|With|However|Despite|In|On|For|As|If|It|Its|Their|His|Her|A|An|Not|After|Before|When|Where|While|Now|Then|Week)$/;
  // The single longest proper-noun run reads best as a title ("Crimson Tide",
  // "Notre Dame", "Ohio State") — a pile of every name in the sentence doesn't.
  const runs = (s.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [])
    .map((r) => r.trim())
    .filter((r) => r.length > 3 && r.split(/\s+/).every((w) => !skip.test(w)))
    .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
  if (runs.length) return runs[0].split(/\s+/).slice(0, 3).join(" ").slice(0, 50);
  const words = s.split(/\s+/).map((w) => w.replace(/[^A-Za-z'-]/g, "")).filter((w) => w.length > 3 && !STOP.has(w.toLowerCase()));
  return (words.slice(0, 4).join(" ") || "The story").replace(/[.,:;!?]+$/, "").slice(0, 60);
}

/* Rebuild the given body slides from the article's own sentences, best first,
   never reusing a sentence. This is what keeps the deck factual when the AI
   quota is gone — the words come from the reporting, not from a model. */
function extractiveCopy(article, story, indices) {
  const vocab = vocabOf(`${article} ${story.title || ""}`);
  const ranked = sentencesOf(article)
    .map((s) => ({ s, score: rankSentence(s, vocab) }))
    .sort((a, b) => b.score - a.score);
  const used = new Set();
  const usedWords = [];
  const out = new Map();
  for (const i of indices) {
    // Prefer a sentence that doesn't just restate one already on the deck.
    const words = (s) => new Set((s.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []).filter((w) => vocab.has(w)));
    const pick = ranked.find((p) => !used.has(p.s) && !usedWords.some((w) => {
      const pw = words(p.s);
      return [...pw].filter((x) => w.has(x)).length >= 4;
    })) || ranked.find((p) => !used.has(p.s));
    if (!pick) break;
    used.add(pick.s);
    usedWords.push(words(pick.s));
    out.set(i, { title: titleize(pick.s), body: bracketize(pick.s) });
  }
  return out;
}

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

  // Which slides still need words? Blank-slide placeholders count as unwritten.
  const todo = slides
    .map((slide, i) => ({ slide, i }))
    .filter(({ slide }) => {
      if (overwrite) return true;
      if (slide.layout === "cover") return isBlankText(slide.headline);
      return isBlankText(slide.title) || isBlankText(slide.body);
    });
  const needCaption = overwrite || !(story.caption || "").trim();
  if (!todo.length && !needCaption) {
    return { message: "Every slide already has text and a caption." };
  }

  // A story with no source article and no photos gives the writer nothing
  // factual to stand on — models respond by putting their refusal on the
  // slides. Say what's missing before spending the call.
  const hasMaterial = !!(story.source_url || "").trim() ||
    slides.some((sl) => (sl.bg?.caption || sl.bg?.query || sl.bg?.src || "").trim());
  if (!hasMaterial) {
    throw new JobError(
      "There's nothing to write from yet — add a source article link (More → Source article) or photos first, then press Write words again.",
      422,
    );
  }

  const cap = (slot) => (slot?.caption || "").trim();
  // Every photo's credit travels in the brief so the caption can attribute the
  // real credit (photographer, or the outlet when that's all we know) instead
  // of inventing a name.
  const credits = [];
  const creditOf = (slot) => { const c = (slot?.credit || "").trim(); return c; };
  // A link is not grounding — the model can't open it. Fetch the article and
  // pass its text, so the words stand on the story's actual facts instead of
  // drifting into vague filler when no photo captions exist yet.
  const article = story.source_url ? await articleText(story.source_url) : "";
  console.log(`copy: grounding on ${article.length} char(s) of article text`);
  const brief = [
    story.title ? `Series title: ${story.title}` : null,
    story.source_url ? `Source article: ${story.source_url}` : null,
    article ? `Article text (${article.length < 6000 ? "full" : "start of"}):\n${article}` : "",
    "Slides, in order, with the photo each one will show:",
    ...slides.map((slide, i) => {
      // Before photos land, the topic finder's per-slide query is the best
      // description of what the slide will show.
      const photo = cap(slide.bg) || (slide.bg?.query || "").trim() ||
        (slide.layout === "cover" ? cap(slide.inset) || (slide.inset?.query || "").trim() : "");
      const label = slide.layout === "cover" ? "COVER" : "BODY";
      const credit = creditOf(slide.bg) || (slide.layout === "cover" ? creditOf(slide.inset) : "");
      if (credit) credits.push(credit);
      return `${i + 1}. [${label}]${photo ? ` photo: ${photo}` : " (no photo description available)"}` +
        (credit ? `\n   photo credit: ${credit}` : "") +
        (slide.layout !== "cover" && !isBlankText(slide.title) ? `\n   existing text, for tone only: ${(slide.title || "")} ${(slide.body || "").replace(/\[\[|\]\]/g, "")}` : "");
    }),
  ].filter(Boolean).join("\n");
  const uniqueCredits = [...new Set(credits)];

  // Never let a dead provider (quota exhausted, outage) leave a story with no
  // words: the article alone can write a factual deck, so fall through to that
  // path rather than throwing. `written` stays empty and the rebuild below
  // fills every slide from the article's own sentences.
  let written;
  try {
    written = await writeWithModel();
  } catch (e) {
    if (!article) throw e;
    console.warn(`copy: AI unavailable (${String(e.message).split("\n")[0]}) — writing from the source article directly`);
    written = { slides: [], caption: "" };
  }
  async function writeWithModel() {
  const reply = await ai({
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
      "- Also write one Instagram caption for the whole post: 1-3 short paragraphs, plain text, " +
      (uniqueCredits.length
        ? `ending with a credit line that uses ONLY these credits, written exactly as given, joined with ' / ': ${uniqueCredits.join(" | ")}. ` +
          "A bare domain is the outlet's name — use it as-is. NEVER invent or guess a photographer's name. "
        : "ending with a credit line naming the source article's outlet. NEVER invent a photographer's name. ") +
      "Start that line with '📸 '. " +
      (hashtags ? `End the caption with exactly this hashtag line: ${hashtags}\n` : "") +
      "- The whole caption, hashtags included, must stay under 2100 characters.\n\n" +
      'Reply with only JSON: {"slides":[{"index":0,"headline":"...","title":"...","body":"... with [[brackets]] ..."}],"caption":"..."}. ' +
      "Use headline for the cover and title/body for the rest. Match every index from the brief.",
    messages: [{ role: "user", content: brief }],
    json: true,
    maxTokens: 3000,
    label: `copy ${id.slice(0, 8)}`,
  });

  // Models that can't ground the copy sometimes answer INSIDE the JSON —
  // their "please provide more info" becomes slide text. Catch the meta-talk
  // before any of it lands on a slide (first-person instructional phrasing
  // only, so a quoted "I can't believe we won" never trips it).
  if (/\b(my instructions|please provide|once i (have|receive)|i can generate|as an ai|i (don't|do not) have (access|enough|the ability)|i'?m? unable to (provide|generate|write|help|comply)|need more (information|context|details)|inventing details|against my (guidelines|programming))\b/i.test(reply.text || "")) {
    throw new JobError(
      "The AI wouldn't write this story from what it has — it needs a source article or photos to ground the words in. Add one and try again.",
      422,
    );
  }

  return parseJson(reply.text);
  }

  const byIndex = new Map((written.slides || []).map((s) => [Number(s.index), s]));
  const next = structuredClone(slides);
  const applied = [];
  const vocab = vocabOf(`${article} ${story.title || ""}`);

  // Body slides whose AI copy says nothing concrete (no number, no shared
  // vocabulary with the article) get rebuilt from the article's own sentences.
  const needExtract = [];
  for (const { i } of todo) {
    const slide = slides[i];
    if (slide.layout === "cover") continue;
    const w = byIndex.get(i);
    const bodyText = w && typeof w.body === "string" ? w.body : slide.body || "";
    if (isVague(bodyText, vocab)) needExtract.push(i);
  }
  const rebuilt = article && needExtract.length ? extractiveCopy(article, story, needExtract) : new Map();
  if (rebuilt.size) {
    console.warn(`copy: ${rebuilt.size} slide(s) came back without concrete facts — rebuilt from the source article`);
  }

  for (const { i } of todo) {
    const w = byIndex.get(i);
    const slide = next[i];
    if (slide.layout === "cover") {
      const h = w && typeof w.headline === "string" ? w.headline.trim() : "";
      if (h) {
        slide.headline = h.slice(0, 200);
        applied.push({ slide: i, headline: slide.headline });
      } else if (!(slide.headline || "").trim()) {
        // No usable headline: the series title is a real, checkable stand-in.
        slide.headline = (story.title || "").split(/\s+/).slice(0, 8).join(" ").slice(0, 60);
        if (slide.headline) applied.push({ slide: i, headline: slide.headline });
      }
      continue;
    }
    // A factual rewrite from the article beats the model's filler.
    const use = rebuilt.get(i);
    if (use) {
      slide.title = use.title;
      slide.body = use.body;
      applied.push({ slide: i, title: slide.title, rebuilt: true });
      continue;
    }
    if (w && typeof w.title === "string" && w.title.trim()) slide.title = w.title.trim().slice(0, 90);
    if (w && typeof w.body === "string" && w.body.trim()) slide.body = w.body.trim().slice(0, 600);
    if (slide.title || slide.body) applied.push({ slide: i, title: slide.title });
  }

  let caption = typeof written.caption === "string" ? written.caption.trim().slice(0, 2200) : "";
  // Same floor for the caption: if it says nothing and the article is readable,
  // lead with the article's own most concrete sentences.
  if (article && isVague(caption, vocab)) {
    const top = sentencesOf(article)
      .map((s) => ({ s, score: rankSentence(s, vocab) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.s);
    if (top.length) caption = top.join(" ") + (uniqueCredits.length ? `\n\n📸 ${uniqueCredits.join(" / ")}` : "");
  }
  if (!applied.length && !caption) {
    throw new JobError("Claude didn't return usable text. Try again.", 502);
  }

  const patch = {};
  if (applied.length) patch.slides = next;
  if (caption) patch.caption = caption;
  await db().from("stories").update(patch).eq("id", id);
  return { written: applied.length, applied, caption, cost: costReport() };
}
