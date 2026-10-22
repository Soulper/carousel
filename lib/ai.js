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
   special tools value "search" turns on Google Search grounding.
   Free-tier transient errors ("high demand", 429/503) get two backed-off
   retries — a full minute apart is fine here, the tick loop paces itself. */
async function gemini(opts) {
  try {
    return await geminiWithRetries(opts, opts.model);
  } catch (e) {
    // Free-tier daily quota is per model, and a lighter model usually still
    // has room. Fall back once rather than failing the whole pipeline.
    const quota = /exceeded your current quota|billing/i.test(e.message || "");
    const alt = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite";
    if (!quota || opts._fellBack) throw e;
    console.warn(`[gemini] ${opts.label || "call"}: quota exhausted, falling back to ${alt}`);
    return await geminiWithRetries({ ...opts, _fellBack: true }, alt);
  }
}

/* Transient free-tier failures ("high demand", 503, 429) get two backed-off
   retries — the tick loop paces itself, so waiting is fine. */
async function geminiWithRetries(opts, model) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await geminiOnce({ ...opts, model });
    } catch (e) {
      last = e;
      const transient = /high demand|overloaded|resource_?exhausted|(\b429\b)|(\b503\b)/i.test(e.message || "");
      if (!transient || attempt === 2) throw e;
      console.warn(`[gemini] ${opts.label || "call"} transient error (${(e.message || "").slice(0, 80)}), retry ${attempt + 1}/2`);
      await new Promise((r) => setTimeout(r, attempt === 0 ? 5000 : 20000));
    }
  }
  throw last;
}

async function geminiOnce({ system, messages, tools, maxTokens = 4000, label = "gemini", json = false, model }) {
  const model_ = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const parts = [];
  for (const m of messages || []) {
    if (typeof m.content === "string") { parts.push({ text: m.content }); continue; }
    for (const b of m.content || []) {
      if (b.type === "text") parts.push({ text: b.text });
      else if (b.type === "image") parts.push({ inline_data: { mime_type: b.source.media_type, data: b.source.data } });
    }
  }
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      // Forced JSON for plain calls; not usable alongside search grounding.
      ...(json && tools !== "search" ? { responseMimeType: "application/json" } : {}),
    },
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  if (tools === "search") body.tools = [{ google_search: {} }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model_}:generateContent`,
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
  console.log(`[gemini] ${label}: model=${model_} ${usage.inTokens}+${usage.outTokens} tok, ${sources.length} search source(s)`);

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

/* Gemini's grounding URLs are opaque redirects on vertexaisearch.cloud.google.com.
   Resolve a handful (best-effort, in parallel) to the real article hostnames,
   so callers can verify that a model-supplied URL traces back to an actual
   search result instead of an invention. */
export async function groundedHosts(sources, limit = 8) {
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };
  const out = new Set();
  await Promise.all((sources || []).slice(0, limit).map(async (u) => {
    if (host(u) !== "vertexaisearch.cloud.google.com") { out.add(host(u)); return; }
    try {
      const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      out.add(host(res.headers.get("location")));
    } catch {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(6000) });
        out.add(host(res.url));
      } catch { /* unresolvable source: skip it */ }
    }
  }));
  return new Set([...out].filter(Boolean));
}

/* Resolve Gemini's grounding redirects to the REAL article URLs and return
   them. These are the pages search actually surfaced — the best candidates
   for photo scraping, since a model-named URL can be a hallucination. */
export async function groundedPages(sources, limit = 6) {
  const urls = (sources || []).slice(0, limit);
  const out = [];
  await Promise.all(urls.map(async (u) => {
    if (!/vertexaisearch\.cloud\.google\.com/.test(u)) { out.push(u); return; }
    try {
      const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      const loc = res.headers.get("location");
      if (loc && /^https?:/i.test(loc)) out.push(loc.split("#")[0]);
    } catch {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(6000) });
        if (res.url && !/vertexaisearch/.test(res.url)) out.push(res.url);
      } catch { /* unresolvable source: skip it */ }
    }
  }));
  return [...new Set(out)];
}

export function resetUsage() {
  if (provider() === "anthropic") anthropicReset();
  usage.requests = 0; usage.inTokens = 0; usage.outTokens = 0;
}

export function costReport() {
  if (provider() === "anthropic") return anthropicCost();
  return { calls: usage.requests, input: usage.inTokens, output: usage.outTokens, usd: 0, cents: 0, free: true };
}
