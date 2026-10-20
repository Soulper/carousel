// Relative imports on purpose (see jobs.js): bundled outside Next.
import { JobError } from "./jobs";

/* Instagram Graph API carousel publisher. Requires an IG Business/Creator
   account linked to a Facebook Page, and an access token with
   instagram_content_publish. Env: IG_USER_ID, IG_ACCESS_TOKEN.

   publishCarousel({ files, caption })
     files: [{ slide, url }] — publicly fetchable image URLs (the studio
     bucket is public), in slide order. Returns the published media id.
   igConfigured() tells the tick loop and UI whether posting is possible. */

const API = "https://graph.facebook.com/v21.0";
const MAX_CAPTION = 2200;

export function igConfigured() {
  return !!(process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN);
}

async function ig(method, path, params) {
  const url = new URL(`${API}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  let res;
  if (method === "GET") {
    url.search = body.toString();
    res = await fetch(url);
  } else {
    res = await fetch(url, { method, body });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Graph errors carry a human message and often a subcode worth surfacing.
    const e = data?.error?.message || `Instagram API ${res.status}`;
    throw new JobError(`Instagram: ${e}`, res.status === 429 ? 429 : 502);
  }
  return data;
}

/* Image containers are usually ready instantly, but publishing before the
   status is FINISHED fails, so poll briefly. */
async function waitReady(id, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const { status_code } = await ig("GET", id, { fields: "status_code" });
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR") throw new JobError("Instagram rejected one of the images.", 502);
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new JobError("Instagram took too long to process the images.", 504);
}

export async function publishCarousel({ files, caption }) {
  if (!igConfigured()) throw new JobError("Set IG_USER_ID and IG_ACCESS_TOKEN to post to Instagram", 503);
  const images = (files || []).filter((f) => f?.url).sort((a, b) => (a.slide || 0) - (b.slide || 0));
  if (images.length < 2) throw new JobError("A carousel needs at least two images.", 400);
  if (images.length > 10) images.length = 10; // Graph API hard limit

  const text = (caption || "").slice(0, MAX_CAPTION);

  // 1. one child container per image
  const children = [];
  for (const f of images) {
    const { id } = await ig("POST", `${process.env.IG_USER_ID}/media`, {
      image_url: f.url,
      is_carousel_item: "true",
    });
    await waitReady(id);
    children.push(id);
  }

  // 2. the carousel container, 3. publish it
  const { id: container } = await ig("POST", `${process.env.IG_USER_ID}/media`, {
    media_type: "CAROUSEL",
    children: children.join(","),
    caption: text,
  });
  await waitReady(container);
  const { id: mediaId } = await ig("POST", `${process.env.IG_USER_ID}/media_publish`, {
    creation_id: container,
  });
  return mediaId;
}

/* Long-lived page tokens still expire after ~60 days. Exchanging a valid
   long-lived token for a fresh one extends it; the scheduler calls this
   monthly so it never lapses. */
export async function refreshAccessToken() {
  const url = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
  url.search = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: process.env.FB_APP_ID || "",
    client_secret: process.env.FB_APP_SECRET || "",
    fb_exchange_token: process.env.IG_ACCESS_TOKEN || "",
  }).toString();
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new JobError(`Instagram token refresh failed: ${data?.error?.message || res.status}`, 502);
  }
  return { expires_in: data.expires_in, access_token: data.access_token };
}
