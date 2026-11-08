// Relative imports only (see jobs.js): bundled outside Next by tick callers.
//
// Keyless web search. Gemini's grounding is lovely but it's the one thing a
// free OpenAI-compatible provider can't give us, and the free tier runs out
// anyway. These backends need no key and no account, so the pipeline can always
// find candidate articles to scrape — with any provider, or none at all.
//
// Order matters: news RSS feeds answer datacenter IPs (Vercel, Lambda) happily,
// where DuckDuckGo's HTML endpoint often blocks them.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

// Search engines, aggregators and social sites are not the article.
const NOT_ARTICLE = /(wikipedia\.org|youtube\.com|facebook\.com|twitter\.com|\/\/x\.com|instagram\.com|reddit\.com|tiktok\.com|pinterest\.|news\.google\.com|google\.com|bing\.com|duckduckgo\.com|msn\.com|yahoo\.com\/news)/i;

const clean = (u) => (u || "").split("#")[0];

async function fetchText(url, ms = 12000) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/rss+xml,text/xml,text/html,*/*" }, signal: AbortSignal.timeout(ms) });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

// A Google News RSS link points at news.google.com and 302s to the publisher.
async function resolve(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
    return res.url && !/news\.google\.com/.test(res.url) ? clean(res.url) : "";
  } catch {
    return "";
  }
}

async function fromRss(feedUrl, limit, mode) {
  const xml = await fetchText(feedUrl);
  if (!xml) return [];
  const links = [...xml.matchAll(/<link>\s*(https?:\/\/[^<\s]+)<\/link>/gi)].map((m) => clean(m[1].trim()));
  const out = [];
  for (const l of links.slice(0, limit + 6)) {
    let real = l;
    /* RSS is XML: "&" is escaped to "&amp;". Unescape BEFORE looking at the
       URL, or an apiclick renderurl becomes param "amp;url" and every entry
       decodes to nothing. */
    const unescaped = real.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").trim();
    real = unescaped;
    /* Bing News RSS wraps the publisher URL in its own apiclick redirector.
       Those links are the whole feed — decode the inner `url` parameter or
       every entry gets filtered out and the backend reports zero results. */
    if (/bing\.com\/news\/apiclick/i.test(real)) {
      try {
        const target = new URL(real).searchParams.get("url") || "";
        if (/^https?:/i.test(target)) real = target;
      } catch { /* keep opaque */ }
    } else if (mode === "resolve") {
      real = await resolve(unescaped);
    }
    if (real && !NOT_ARTICLE.test(real)) out.push(clean(real));
    if (out.length >= limit) break;
  }
  return out;
}

/* DuckDuckGo's HTML endpoints. Fine from a laptop, often 403 from a cloud IP,
   so they're tried after the RSS feeds (and again through a reader proxy). */
async function fromDuckDuckGo(query, limit) {
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
  ];
  const out = [];
  for (const url of endpoints) {
    if (out.length >= limit) break;
    const html = await fetchText(url, 12000);
    if (!html) continue;
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
      const href = m[1];
      let real = "";
      if (/uddg=/.test(href)) {
        try { real = decodeURIComponent(new URL(href, "https://duckduckgo.com").searchParams.get("uddg") || ""); } catch { real = ""; }
      } else if (/^https?:\/\//i.test(href) && /result__a|result-link|result__url/i.test(m[0])) {
        real = href;
      }
      if (real && !NOT_ARTICLE.test(real)) out.push(clean(real));
    }
  }
  return [...new Set(out)].slice(0, limit);
}

// Last resort: ask the reader proxy to fetch a search page for us, so the
// request comes from its IPs rather than ours.
async function fromReaderSearch(query, limit) {
  for (const engine of ["bing", "duckduckgo"]) {
    const engineUrl = engine === "bing"
      ? `https://www.bing.com/search?q=${encodeURIComponent(query)}`
      : `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const text = await fetchText("https://r.jina.ai/" + engineUrl, 20000);
    if (!text) continue;
    const out = [];
    for (const m of text.matchAll(/https?:\/\/[^\s)"'\]<>]+/gi)) {
      const u = clean(m[0]);
      if (!NOT_ARTICLE.test(u) && /\.(com|org|net|co\.uk|com\.au|ca)\//.test(u)) out.push(u);
      if (out.length >= limit) break;
    }
    if (out.length) return [...new Set(out)].slice(0, limit);
  }
  return [];
}

/* GDELT's DOC API is the one search backend that hands out DIRECT publisher
   URLs — no redirectors, no key, and it happily answers datacenter IPs where
   Bing's RSS serves interstitials and DuckDuckGo 403s. Kept current by a
   short timespan so the topics stay fresh. */
async function fromGdelt(query, limit) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}%20sourcelang:eng&mode=artlist&maxrecords=60&format=json&timespan=7d&sort=hybridrel`;
  const text = await fetchText(url, 15000);
  if (!text) return [];
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const out = [];
  for (const a of (data.articles || [])) {
    const u = clean(a.url || "");
    if (u && !NOT_ARTICLE.test(u)) out.push(u);
    if (out.length >= limit) break;
  }
  return [...new Set(out)].slice(0, limit);
}

/* Search the web for a query and return real article URLs. Best-effort: tries
   each backend in turn and returns the first that yields anything. */
export async function webSearch(query, limit = 8) {
  const q = (query || "").trim();
  if (!q) return [];
  // Note: an empty array is truthy, so `a || b` would stop at the first empty
  // backend — check the length instead.
  const backends = [
    () => fromGdelt(q, limit),
    () => fromRss(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS`, limit, "decode"),
    () => fromRss(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, limit, "resolve"),
    () => fromDuckDuckGo(q, limit),
    () => fromReaderSearch(q, limit),
  ];
  let found = [];
  for (const backend of backends) {
    try {
      found = await backend();
    } catch {
      found = [];
    }
    if (found.length) break;
  }
  return [...new Set(found)].slice(0, limit);
}
