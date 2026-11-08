import { ok, run } from "@/lib/http";
import { articleText } from "@/lib/copy";

export const dynamic = "force-dynamic";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/* TEMPORARY deploy probe v4: raw GDELT + Bing responses from prod. DELETE after. */
export async function GET() {
  return run(async () => {
    const q = "college football playoff week 10";
    const out = {};
    try {
      const res = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}%20sourcelang:eng&mode=artlist&maxrecords=60&format=json&timespan=7d&sort=hybridrel`, {
        headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      out.gdeltStatus = res.status;
      out.gdeltLen = text.length;
      out.gdeltHead = text.slice(0, 300);
      try {
        const data = JSON.parse(text);
        out.gdeltArticles = (data.articles || []).length;
        out.gdeltFirstUrls = (data.articles || []).slice(0, 3).map((a) => a.url).filter(Boolean);
      } catch { out.gdeltParseError = true; }
    } catch (e) { out.gdeltError = String(e.message).split("\n")[0]; }

    try {
      const res = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
      const text = await res.text();
      out.bingStatus = res.status;
      out.bingLen = text.length;
      out.bingHead = text.slice(0, 300);
    } catch (e) { out.bingError = String(e.message).split("\n")[0]; }
    return ok(out);
  });
}
