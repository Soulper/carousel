// Relative imports only (see jobs.js): bundled outside Next by tick callers.
//
// The AI provider switch. The pipeline needs three things from a model:
// web search (topics, photo hunting), plain writing (copy), and vision
// (judging candidate photos). Anthropic covers all three on pay-as-you-go;
// Google's Gemini free tier covers all three for nothing:
//   - gemini-2.0-flash: vision + JSON + Google Search grounding
//   - free tier quotas reset daily; set GEMINI_MODEL to pick another model
//
// AI_PROVIDER=gemini | anthropic | free | groq | github | mistral | cerebras |
// openrouter | (unset = auto: Anthropic if its key is set, else a free
// provider if one is configured, else Gemini). Every call returns
// { text, sources } — sources are the URLs the search grounding actually
// surfaced, used to verify the model didn't invent an article.
//
// The "free" providers all speak the OpenAI Chat Completions shape, so one
// adapter covers them. Set the matching key (see FREE_PRESETS) and it's picked
// up automatically — no paid account needed:
//   groq        GROQ_API_KEY       fast, vision, JSON (default free choice)
//   github      GITHUB_TOKEN       GitHub Models, free with any GitHub account
//   mistral     MISTRAL_API_KEY    free experimental tier, vision (Pixtral)
//   cerebras    CEREBRAS_API_KEY   free tier, vision (Llama 4)
//   openrouter  OPENROUTER_API_KEY free ":free" models (set FREE_MODEL too)
import { claude, costReport as anthropicCost, resetUsage as anthropicReset } from "./anthropic";

// `model` writes the words; `vision` (when the provider has one) judges the
// candidate photos. Set FREE_MODEL / FREE_VISION_MODEL to override either.
export const FREE_PRESETS = {
  // Groq dropped every vision model in Nov 2026 (measured: `/models` lists no
  // multimodal entries) — so the photo-judging call falls through to the
  // env-pinned vision provider instead of 404-ing here. Text stays where it is.
  groq: { base: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", vision: "", key: "GROQ_API_KEY" },
  github: { base: "https://models.inference.ai.azure.com", model: "gpt-4o-mini", vision: "gpt-4o-mini", key: "GITHUB_TOKEN" },
  // ministral-8b answered {"error":"cannot see"} on a plain red square (Nov 2026)
  // — functionally blind, the source of every hallucinated photo "why".
  // mistral-small is vision-capable on the same experimental key and describes
  // what it actually sees.
  mistral: { base: "https://api.mistral.ai/v1", model: "ministral-8b-latest", vision: "mistral-small-latest", key: "MISTRAL_API_KEY" },
  cerebras: { base: "https://api.cerebras.ai/v1", model: "llama-3.3-70b", vision: "", key: "CEREBRAS_API_KEY" },
  openrouter: { base: "https://openrouter.ai/api/v1", model: "meta-llama/llama-4-maverick:free", vision: "meta-llama/llama-4-maverick:free", key: "OPENROUTER_API_KEY" },
};

/* The chosen free preset: an explicit FREE_AI/AI_PROVIDER name wins, otherwise
   whichever free key is present. Returns null when none is configured. */
export function freeProvider() {
  const pick = (name) => {
    const p = FREE_PRESETS[name];
    return { name, ...p, model: process.env.FREE_MODEL || p.model, vision: process.env.FREE_VISION_MODEL ?? (p.vision || "") };
  };
  const want = (process.env.FREE_AI || process.env.AI_PROVIDER || "").toLowerCase();
  if (FREE_PRESETS[want] && process.env[FREE_PRESETS[want].key]) return pick(want);
  for (const name of Object.keys(FREE_PRESETS)) if (process.env[FREE_PRESETS[name].key]) return pick(name);
  return null;
}

/* Can the selected free provider look at pictures? Groq's free model writes
   text but has no vision, so a separate vision provider can be named with
   FREE_VISION_PROVIDER (e.g. mistral), and Gemini is the last resort. */
export function freeVisionModel() {
  const fp = freeProvider();
  return fp ? fp.vision || "" : "";
}

/* The provider used for photo judging when the main one has no vision model.
   Set FREE_VISION_PROVIDER=groq|github|mistral|cerebras|openrouter. */
export function visionProvider() {
  const want = (process.env.FREE_VISION_PROVIDER || "").toLowerCase();
  const p = FREE_PRESETS[want];
  if (p && process.env[p.key]) {
    const model = process.env.FREE_VISION_MODEL || p.vision || p.model;
    return { name: want, ...p, model, vision: model };
  }
  return null;
}

export function provider() {
  const want = (process.env.AI_PROVIDER || "").toLowerCase();
  if (want === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (want === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (want && FREE_PRESETS[want]) return process.env[FREE_PRESETS[want].key] ? "free" : "none";
  if (want === "free") return freeProvider() ? "free" : "none";
  if (!want || want === "auto") {
    if (process.env.ANTHROPIC_API_KEY) return "anthropic";
    // Prefer a free provider over Gemini: same price, no daily quota cliff.
    if (freeProvider()) return "free";
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

/* Any OpenAI Chat Completions endpoint (Groq, GitHub Models, Mistral,
   Cerebras, OpenRouter, a local server…). Handles the same message shapes the
   other adapters get: string content, and {type:"text"}/{type:"image"} blocks,
   with images passed as data URLs. "search" isn't a tool these providers have —
   the pipeline's own keyless web search covers that instead. */
export async function openaiCompat(opts, presetArg) {
  const preset = presetArg || freeProvider();
  if (!preset) throw new Error("No free AI provider configured (set GROQ_API_KEY, GITHUB_TOKEN, MISTRAL_API_KEY, CEREBRAS_API_KEY or OPENROUTER_API_KEY)");
  const base = (process.env.FREE_BASE_URL || preset.base).replace(/\/$/, "");
  const key = process.env[preset.key];
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  for (const m of opts.messages || []) {
    if (typeof m.content === "string") { messages.push({ role: "user", content: m.content }); continue; }
    const parts = [];
    for (const b of m.content || []) {
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
    messages.push({ role: "user", content: parts });
  }
  if (opts.tools === "search") {
    console.warn(`[${preset.name}] ${opts.label || "call"}: no web-search tool on this provider — using the built-in keyless search and page scraping instead`);
  }
  const wantsVision = (opts.messages || []).some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image"));
  const model = opts.model || (wantsVision && preset.vision ? preset.vision : preset.model);
  const body = { model, messages, max_tokens: opts.maxTokens || 4000, temperature: 0.4 };
  if (opts.json) body.response_format = { type: "json_object" };

  /* Groq (and friends) occasionally answer a long prompt with an empty
     message — a transient blank, not a real refusal. One blank reply used to
     fail the whole button; now the call is repeated a couple of times and only
     a persistent blank is reported. */
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(preset.name === "openrouter" ? { "x-title": "Carousel Studio" } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (attempt === 3) throw e;
      console.warn(`[${preset.name}] ${opts.label || "call"}: network error (${String(e.message).split("\n")[0]}), retrying`);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || String(res.status);
      /* gpt-oss on Groq sometimes tries to invoke its internal browser tool
         even though the request declared none — a 400 that's a model roll,
         not a real error. Same request once more. */
      if (/tool choice/i.test(msg) && attempt < 3) {
        console.warn(`[${preset.name}] ${opts.label || "call"}: ${msg} — retrying`);
        continue;
      }
      throw new Error(`${preset.name} API: ${msg}`);
    }
    const text = data.choices?.[0]?.message?.content || "";
    usage.requests++;
    usage.inTokens += data.usage?.prompt_tokens || 0;
    usage.outTokens += data.usage?.completion_tokens || 0;
    console.log(`[${preset.name}] ${opts.label || "call"}: model=${body.model} ${usage.inTokens}+${usage.outTokens} tok`);
    if (!text.trim()) {
      if (attempt === 3) throw new Error(`${preset.name} returned an empty reply`);
      console.warn(`[${preset.name}] ${opts.label || "call"}: empty reply, retrying (${attempt}/2)`);
      continue;
    }
    return { text, sources: [] };
  }
  throw new Error(`${preset.name} returned an empty reply`);
}

/* The one call site the pipeline uses. tools === "search" means "give the
   model web search" and is mapped per provider. */
export async function ai(opts) {
  const p = provider();
  if (p === "free") {
    // A free text model with no eyes can't judge photos. Route just that call
    // to a dedicated free vision provider (FREE_VISION_PROVIDER), else to
    // Gemini; if neither exists the caller falls back to assigning in order.
    const wantsVision = (opts.messages || []).some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image"));
    if (wantsVision && !freeVisionModel()) {
      const vp = visionProvider();
      if (vp) {
        console.warn(`[free] ${opts.label || "call"}: no vision on the main provider — using ${vp.name} for the photo pass`);
        return openaiCompat(opts, vp);
      }
      if (process.env.GEMINI_API_KEY) {
        console.warn(`[free] ${opts.label || "call"}: no vision model — using Gemini for the photo pass`);
        return gemini(opts);
      }
    }
    return openaiCompat(opts);
  }
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
