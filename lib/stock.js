// Relative imports only (see jobs.js): bundled outside Next by tick callers.
//
// Keyless image search. When the article search turns up retail pages and
// brand cards — or the AI is out of quota — a deck can still be built from
// real, licensed photographs. Openverse (WordPress) and Wikimedia Commons both
// answer without an API key or an account, so sourcing always has a floor.

const UA = "CarouselStudio/1.0 (+https://github.com/Soulper/carousel)";

const STOP = new Set("a,an,the,and,or,but,of,for,with,about,above,after,again,against,before,between,into,over,under,their,there,these,those,this,that,what,when,where,which,while,whose,than,then,from,have,has,had,will,would,could,should,might,must,still,also,very,much,been,being,were,was,are,does,did,doing,more,most,other,some,such,only,even,just,waive,waved,surprise,addition".split(","));

/* Image indexes answer KEYWORD queries, not sentences. A full storyline like
   "Buccaneers Waive Rising Rookie After Surprise Addition" returns ZERO hits
   from both Openverse and Commons (measured), while "Buccaneers rookie"
   returns a dozen real photographs. Turn each provided query into short
   keyword ladders: the two most content-bearing words as a pair, then the
   single team/subject word, so the floor always has real questions to ask. */
// Single-word photo queries for these are categories nobody photographs —
// they only ever surface the junk class (a "head" query returns Head Start
// children's programs for a head-coach story).
const JUNK_SINGLE = new Set("week,day,month,year,today,tonight,report,update,news,live,score,scores,vs,seat,seats,hot,ice,thin,regret,passing,thriving,elsewhere,dominant,start".split(","));

// URL path prefixes that carry no subject ("heavy.com/sports/nfl/..." — the
// sport section is not the story).
const SLUG_JUNK = new Set("sports,nba,nfl,mlb,nhl,cfb,ncaaf,news,article,articles,story,stories,video,watch,page,en,us,uk,com".split(","));

export function keywordQueries(queries, limit = 5) {
  const lines = [];
  const push = (l) => {
    l = String(l).trim().toLowerCase();
    if (l && l.length >= 3 && !lines.includes(l) && !JUNK_SINGLE.has(l)) lines.push(l);
  };
  for (const q of (queries || []).filter(Boolean)) {
    if (lines.length >= limit) break;
    const isUrl = /^https?:\/\//i.test(q);
    let text = q;
    if (isUrl) {
      try { text = decodeURIComponent(new URL(q).pathname).replace(/[-_/]+/g, " "); } catch { continue; }
    }
    // 1. Acronyms: ALL-CAPS runs of 3+ letters ("NFL", "NBA") — photo indexes
    //    have whole categories for them. 2-letter ones ("FG") search nothing.
    for (const t of text.split(/[^A-Za-z0-9]+/)) {
      if (/^[A-Z]{3,}$/.test(t)) push(t.toLowerCase());
    }
    // 2. Proper-noun phrases — only in MIXED-case strings. A Title Case
    //    headline capitalises every word, so there is no signal there.
    if (!isUrl) {
      const tokens = text.replace(/[^A-Za-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
      const alpha = tokens.filter((t) => /[A-Za-z]/.test(t));
      const caps = alpha.filter((t) => /^[A-Z]/.test(t));
      const titleCase = alpha.length >= 4 && caps.length / alpha.length > 0.6;
      if (!titleCase) {
        let cur = [];
        const flush = () => {
          if (cur.length >= 2) push(cur.join(" "));
          else if (cur.length === 1) push(cur[0]);
          cur = [];
        };
        tokens.forEach((t, i) => {
          if (i > 0 && /^[A-Z][a-z]+$/.test(t) && !STOP.has(t.toLowerCase())) cur.push(t.toLowerCase());
          else flush();
        });
        flush();
      }
    }
    // 3. URL slugs are pre-cleaned SEO keywords ("tarris-reed-lakers-spurs-draft")
    //    — better search terms than any heuristic over a headline.
    if (isUrl) {
      const slug = text.toLowerCase().split(/\s+/).filter((t) => /^[a-z]{3,}$/.test(t) && !STOP.has(t) && !SLUG_JUNK.has(t));
      if (slug.length >= 2) { push(`${slug[0]} ${slug[1]}`); push(`${slug[slug.length - 2]} ${slug[slug.length - 1]}`); }
      continue;
    }
    // 4. Fallback pair/first — only reaches the list when nothing stronger
    //    exists, because bare common nouns ("head") flood the pool with
    //    whatever unrelated category shares the word (Head Start programs).
    const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t));
    if (words.length >= 2) push(`${words[0]} ${words[words.length - 1]}`);
    if (words.length >= 1) push(words[0]);
  }
  return lines.slice(0, limit);
}

/* Openverse: a CC-licensed image index. Returns real photos/art with the
   creator and licence, which the caption can attribute honestly. */
export async function openverse(query, limit = 12) {
  try {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${Math.min(limit * 2, 40)}&mature=false&license_type=all&extension=jpg`;
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || [])
      .map((r) => ({
        url: r.url,
        page: r.foreign_landing_url || r.url,
        caption: [r.title, r.creator ? `by ${r.creator}` : "", r.license ? `(${String(r.license).toUpperCase()})` : ""].filter(Boolean).join(" ").slice(0, 160),
        credit: r.creator ? `${r.creator} / ${String(r.license || "").toUpperCase()}` : (r.source || "Openverse"),
        w: r.width, h: r.height,
      }))
      .filter((c) => c.url && /\.(jpe?g|png|webp)(\?|$)/i.test(c.url))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/* Wikimedia Commons: deep coverage of people, places and events, freely
   licensed. The search generator returns imageinfo with a rendered URL. */
export async function commons(query, limit = 12) {
  try {
    const url = "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*" +
      `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${Math.min(limit * 2, 40)}` +
      "&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600";
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json();
    const pages = Object.values(data?.query?.pages || {});
    return pages
      .map((p) => {
        const info = (p.imageinfo || [])[0] || {};
        const meta = info.extmetadata || {};
        const artist = (meta.Artist?.value || "").replace(/<[^>]+>/g, "").trim();
        const lic = (meta.LicenseShortName?.value || "").trim();
        return {
          url: info.thumburl || info.url,
          page: info.descriptionurl || (p.title ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}` : ""),
          caption: [(p.title || "").replace(/^File:/, "").replace(/\.[a-z]+$/i, "").replace(/_/g, " "), artist ? `by ${artist}` : "", lic].filter(Boolean).join(" ").slice(0, 160),
          credit: artist ? `${artist} / ${lic}` : (lic || "Wikimedia Commons"),
          w: info.thumbwidth || info.width, h: info.thumbheight || info.height,
        };
      })
      .filter((c) => c.url && /\.(jpe?g|png|webp)(\?|$)/i.test(c.url))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/* Search both indexes across several queries, interleaved so no single query
   floods the pool, then de-duplicated by URL. */
export async function stockCandidates(queries, limit = 12) {
  const seen = new Set();
  const out = [];
  const lists = await Promise.all(
    (queries || []).filter(Boolean).slice(0, 6).flatMap((q) => [openverse(q, limit), commons(q, limit)]),
  );
  for (let i = 0; i < limit; i++) {
    for (const list of lists) {
      const c = list[i];
      if (c && !seen.has(c.url)) { seen.add(c.url); out.push(c); }
    }
  }
  return out;
}
