// Relative imports on purpose (see jobs.js): bundled outside Next.
//
// The publish adapter. The factory (topic → copy → source → render) is already
// fully automatic; this is the last mile, kept behind one door so the way a
// carousel goes out can be swapped without touching the tick loop.
//
// Right now there's one strategy — the Instagram Graph API — and a no-op
// fallback: with no account connected the story is simply marked "ready to
// post" and left for a human or another strategy. Nothing in the pipeline
// breaks on a missing account.
import { igConfigured, publishCarousel } from "./instagram";

export const canPublish = igConfigured;

/* publish({ files, caption })
   Returns { mode: "instagram", id } when it went out through the Graph API,
   or { mode: "manual" } when no strategy is connected. */
export async function publish({ files, caption }) {
  if (igConfigured()) {
    return { mode: "instagram", id: await publishCarousel({ files, caption }) };
  }
  return { mode: "manual" };
}
