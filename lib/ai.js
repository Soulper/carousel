// Relative imports only (see jobs.js): bundled outside Next by tick callers.
//
// The AI provider switch. The pipeline needs three things from a model:
// web search (topics, photo hunting), plain writing (copy), and vision
// (judging candidate photos). Anthropic covers all three on pay-as-you-go;
// Google's Gemini free tier covers all three for nothing:
//   - gemini-2.0-flash: vision + JSON + Google Search grounding
//   - free tier quotas reset daily; set GEMINI_MODEL to pick another model
//
// AI_PROVIDER=gemini | anthropic | (unset = auto: Anthropic if its key is
// set, else Gemini). Every call returns { text, sources } — sources are the
// URLs the search grounding actually surfaced, used to verify the model
// didn't invent an article.
import { claude, costReport as anthropicCost, resetUsage as anthropicReset } from "./anthropic";

export function provider() {
  const want = (process.env.AI_PROVIDER || "").toLowerCase();
  if (want === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (want === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (!want || want === "auto") {
    if (process.env.ANTHROPIC_API_KEY) return "anthropic";
    if (process.env.GEMINI_API_KEY) return "gemini";
  }
  return "none";
}

export const aiConfigured = () => provider() !== "none";

const usage = { requests: 0, inTokens: 0, outTokens: 0 };

/* Gemini generateContent. Maps Claude-style call shapes so callers barely
   change: messages may carry {type:"text"} and {type:"image"} blocks; the
   special tools value "search" turns on Google Search grounding. */
async function gemini({ system, messages, tools, maxTokens = 4000, label = "gemini" }) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const parts = [];
  for (const m of messages || []) {
    if (typeof m.content === "string") { parts.push({ text: m.content }); continue; }
    for (const b of m.content || []) {
      if (b.type === "text") parts.push({ text: b.text });
      else if (b.type === "image") parts.push({ inline_data: { mime_type: b.source.media_type, data: b.source.data } });
    }
  }
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (tools === "search") body.tools = [{ google_search: {} }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini API: ${data?.error?.message || res.status}`);

  const cand = data.candidates?.[0] || {};
  const text = (cand.content?.parts || []).map((p) => p.text || "").join("\n");
  const sources = (cand.groundingMetadata?.groundingChunks || []).map((c) => c.web?.uri).filter(Boolean);

  usage.requests++;
  usage.inTokens += data.usageMetadata?.promptTokenCount || 0;
  usage.outTokens += data.usageMetadata?.candidatesTokenCount || 0;
  console.log(`[gemini] ${label}: model=${model} ${usage.inTokens}+${usage.outTokens} tok, ${sources.length} search source(s)`);

  if (!text.trim() && !sources.length) {
    throw new Error("Gemini returned an empty reply" + (cand.finishReason ? ` (${cand.finishReason})` : ""));
  }
  return { text, sources };
}

/* The one call site the pipeline uses. tools === "search" means "give the
   model web search" and is mapped per provider. */
export async function ai(opts) {
  const p = provider();
  if (p === "gemini") return gemini(opts);
  const o = { ...opts };
  if (o.tools === "search") {
    o.tools = [
      { type: "web_search_20250305", name: "web_search", max_uses: o.maxUses ?? 8 },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: o.maxUses ?? 8 },
    ];
  }
  const text = await claude(o);
  return { text, sources: [] };
}

export function resetUsage() {
  if (provider() === "anthropic") anthropicReset();
  usage.requests = 0; usage.inTokens = 0; usage.outTokens = 0;
}

export function costReport() {
  if (provider() === "anthropic") return anthropicCost();
  return { calls: usage.requests, input: usage.inTokens, output: usage.outTokens, usd: 0, cents: 0, free: true };
}
