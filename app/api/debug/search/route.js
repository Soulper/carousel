import { webSearchDetailed } from "@/lib/search";
import { articleText } from "@/lib/copy";
import { readable } from "@/lib/topic";
import { ok, run } from "@/lib/http";

export const dynamic = "force-dynamic";

/* TEMP diagnostics: shows exactly what the keyless search and the
   readability gate see from inside the deployment. */
export async function GET(req) {
  return run(async () => {
    const q = new URL(req.url).searchParams.get("q") || "NFL rookie quarterback winning streak";
    const hits = await webSearchDetailed(q, 8);
    const probed = await Promise.all(hits.slice(0, 6).map(async (h) => {
      const isReadable = await readable(h.url, q).catch((e) => `ERR ${String(e.message).slice(0, 80)}`);
      let len = 0;
      try { len = ((await articleText(h.url)) || "").length; } catch { len = -1; }
      return { url: h.url, title: h.title, readable: isReadable === true ? true : String(isReadable), bodyLen: len };
    }));
    return ok({ query: q, hits: probed });
  });
}
