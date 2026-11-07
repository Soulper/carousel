// Relative imports only (see jobs.js): bundled outside Next by tick callers.
//
// Keyless web search. Gemini's grounding is lovely but it's the one thing a
// free OpenAI-compatible provider can't give us, and the free tier runs out
// anyway. DuckDuckGo's HTML endpoints need no key and no account, so the
// pipeline can always find candidate articles to scrape — with any provider,
// or none at all.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

// DuckDuckGo wraps results in a redirect: //duckduckgo.com/l/?uddg=<encoded>.
function unwrap(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const real = u.searchParams.get("uddg");
    if (real) return decodeURIComponent(real);
    return u.href;
  } catch {
    return null;
  }
}

const AD_HOST = /duckduckgo\.com|google\.com\/search|bing\.com|yahoo\.com|ad_domain|doubleclick/i;

/* Search the web for a query and return real result URLs (search-engine and ad
   links filtered out). Best-effort: returns [] on any failure. */
export async function webSearch(query, limit = 8) {
  const out = [];
  const add = (u) => {
    if (!u || !/^https?:/i.test(u) || AD_HOST.test(u)) return;
    out.push(u.split("#")[0]);
  };
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
  ];
  for (const url of endpoints) {
    if (out.length >= limit) break;
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const html = await res.text();
      for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
        const href = m[1];
        if (/uddg=/.test(href)) add(unwrap(href));
        else if (/^https?:\/\//i.test(href) && /result__a|result-link|result__url/i.test(m[0])) add(href);
      }
    } catch { /* try the next endpoint */ }
  }
  return [...new Set(out)].slice(0, limit);
}
