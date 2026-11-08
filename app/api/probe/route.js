import { ok, run } from "@/lib/http";
import { webSearch } from "@/lib/search";

export const dynamic = "force-dynamic";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/* TEMPORARY deploy probe v5: dump prod's Bing RSS item links to see exactly
   what the parser receives there. DELETE after verification. */
export async function GET() {
  return run(async () => {
    const q = "college football playoff week 10";
    const out = {};
    try {
      const res = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
      const xml = await res.text();
      out.items = (xml.match(/<item>/g) || []).length;
      out.linkMatches = [...xml.matchAll(/<link>\s*([^<]{1,140})/g)].slice(0, 5).map((m) => m[1]);
    } catch (e) { out.bingError = String(e.message).split("\n")[0]; }
    try {
      out.webSearch = await webSearch(q, 6);
    } catch (e) { out.wsError = String(e.message).split("\n")[0]; }
    return ok(out);
  });
}
