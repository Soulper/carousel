import { ok, run } from "@/lib/http";

export const dynamic = "force-dynamic";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/* TEMPORARY deploy probe v2: per-backend search diagnosis. DELETE after. */
export async function GET() {
  return run(async () => {
    const q = "college football playoff week 10";
    const tryFetch = async (label, url, headers = {}) => {
      try {
        const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(15000) });
        const text = await res.text();
        return { label, status: res.status, len: text.length, hasLink: /<link>?\s*https?:/.test(text) || /https?:\/\//.test(text) };
      } catch (e) {
        return { label, error: String(e.message || e.cause || e).split("\n")[0].slice(0, 80) };
      }
    };
    const results = await Promise.all([
      tryFetch("bing-news-rss", "https://www.bing.com/news/search?q=" + encodeURIComponent(q) + "&format=RSS"),
      tryFetch("google-news-rss", "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en"),
      tryFetch("ddg-html", "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q)),
      tryFetch("ddg-lite", "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q)),
      tryFetch("reader-bing", "https://r.jina.ai/https://www.bing.com/search?q=" + encodeURIComponent(q)),
      tryFetch("gnews-redirect-resolve", "https://news.google.com/rss/articles/CBMii?oc=5"),
    ]);
    return ok({ results });
  });
}
