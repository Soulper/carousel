import { ok, run } from "@/lib/http";
import { webSearch } from "@/lib/search";
import { articleText } from "@/lib/copy";

export const dynamic = "force-dynamic";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const path = (u) => { try { return new URL(u).pathname.replace(/\.html?$/i, "").replace(/\/+$/, ""); } catch { return ""; } };
const isListing = (u) => /\/(category|categories|tag|tags|topics|section|sections|author|authors|search|archive|archives)(\/|$)/i.test(path(u));
async function urlOk(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/html/i.test(type)) return false;
    if (isListing(res.url)) return false;
    if (path(res.url).split("/").filter(Boolean).length < 2) return false;
    const want = path(url), got = path(res.url);
    return !want || !got || want === got;
  } catch { return false; }
}

/* TEMPORARY deploy probe v3. DELETE after verification. */
export async function GET() {
  return run(async () => {
    const out = {};
    try {
      const hits = await webSearch("college football playoff week 10", 6);
      out.searchCount = hits.length;
      out.searchHits = hits.slice(0, 4);
      const fake = "https://www.espn.com/college-football/story/_/id/42456789/week-10-playoff-picture";
      out.fakePassesReadable = (await urlOk(fake)) && (await articleText(fake)).length > 400;
      const junkHit = /wikipedia\.org|youtube\.com|facebook\.com|twitter\.com|\/\/x\.com|instagram\.com|reddit\.com/i;
      let confirmed = "";
      for (const u of hits.filter((x) => !junkHit.test(x))) {
        if ((await urlOk(u)) && (await articleText(u)).length > 400) { confirmed = u; break; }
      }
      out.firstReadableHit = confirmed;
    } catch (e) { out.searchError = String(e.message).split("\n")[0]; }
    return ok(out);
  });
}
