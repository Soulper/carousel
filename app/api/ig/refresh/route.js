import { ok, fail, run } from "@/lib/http";
import { refreshAccessToken } from "@/lib/instagram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/* GET /api/ig/refresh   header x-api-key: PIPELINE_API_KEY
   Exchanges the current IG access token for a fresh long-lived one. Env vars
   can't be rewritten at runtime, so the new token comes back in the response
   and the run log — paste it into IG_ACCESS_TOKEN on Vercel. Needs
   FB_APP_ID + FB_APP_SECRET set alongside IG_ACCESS_TOKEN. */
export async function GET() {
  return run(async () => {
    if (!process.env.IG_ACCESS_TOKEN) return fail("Set IG_ACCESS_TOKEN first", 503);
    if (!process.env.FB_APP_ID || !process.env.FB_APP_SECRET) {
      return fail("Set FB_APP_ID and FB_APP_SECRET so the token can be exchanged", 503);
    }
    const { access_token, expires_in } = await refreshAccessToken();
    console.log(`ig/refresh: NEW TOKEN (valid ~${Math.round((expires_in || 0) / 86400)} days):\n${access_token}`);
    return ok({ refreshed: true, expires_in, token_preview: access_token.slice(0, 8) + "…" });
  });
}
