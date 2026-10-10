// Minimal Claude Messages API client (no SDK needed)
const URL_ = "https://api.anthropic.com/v1/messages";

/* Token accounting. Costs are easy to run up without noticing when a single
   button makes several calls, so every call reports what it used and the routes
   log a running total. RATES is per million tokens for Sonnet 5/5.5. */
const RATES = { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function costReport() {
  const usd =
    (usage.input / 1e6) * RATES.in +
    (usage.output / 1e6) * RATES.out +
    (usage.cacheRead / 1e6) * RATES.cacheRead +
    (usage.cacheWrite / 1e6) * RATES.cacheWrite;
  return {
    ...usage,
    usd: Number(usd.toFixed(6)),
    cents: Number((usd * 100).toFixed(3)),
  };
}

export function resetUsage() {
  usage.calls = 0; usage.input = 0; usage.output = 0; usage.cacheRead = 0; usage.cacheWrite = 0;
}

export async function claude({ system, messages, tools, maxTokens = 4000, label = "claude" }) {
  const headers = {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  if (process.env.ANTHROPIC_BETA) headers["anthropic-beta"] = process.env.ANTHROPIC_BETA;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

  let convo = [...messages];
  let content = [];
  const started = Date.now();
  // Server tools (web search / fetch) can pause a long turn; continue it a few times
  for (let i = 0; i < 5; i++) {
    const res = await fetch(URL_, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: convo, tools }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Claude API: ${data?.error?.message || res.status}`);
    content = data.content;

    const u = data.usage || {};
    usage.calls++;
    usage.input += u.input_tokens || 0;
    usage.output += u.output_tokens || 0;
    usage.cacheRead += u.cache_read_input_tokens || 0;
    usage.cacheWrite += u.cache_creation_input_tokens || 0;

    if (data.stop_reason !== "pause_turn") break;
    convo = [...convo, { role: "assistant", content: data.content }];
  }
  const r = costReport();
  console.log(
    `[claude] ${label}: ${r.calls} call(s) in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
    `${usage.input} in / ${usage.output} out → $${r.usd.toFixed(4)} (${r.cents.toFixed(2)}c) running total`
  );
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Pull the JSON object out of a reply (tolerates prose or ``` fences around it)
export function parseJson(text) {
  const clean = text.replace(/```json|```/g, "");
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("Claude didn't return JSON");
  const body = clean.slice(a, b + 1);
  try {
    return JSON.parse(body);
  } catch (e) {
    // A long reply can hit max_tokens and stop mid-object. Salvage the complete
    // array items rather than losing the whole response: a partial list of 12
    // candidates is worth far more than an exception.
    const salvaged = salvage(body);
    if (salvaged) {
      console.warn(`anthropic: reply truncated, salvaged ${salvaged.count} item(s)`);
      return salvaged.value;
    }
    throw e;
  }
}

/* Trim a truncated JSON object down to its complete top-level array items.
   Walks the text tracking brace/bracket depth and string state, keeping only
   elements that closed properly. Returns null when there's nothing intact. */
function salvage(body) {
  const key = body.match(/"(\w+)"\s*:\s*\[/);
  if (!key) return null;
  const listKey = key[1];
  const start = body.indexOf("[", key.index);
  let depth = 0, inStr = false, esc = false, itemStart = -1;
  const items = [];
  for (let i = start + 1; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") {
      if (depth === 0) itemStart = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && itemStart >= 0) {
        try {
          items.push(JSON.parse(body.slice(itemStart, i + 1)));
        } catch {
          // half-written element, skip it
        }
        itemStart = -1;
      }
    }
  }
  if (!items.length) return null;
  return { count: items.length, value: { [listKey]: items } };
}
