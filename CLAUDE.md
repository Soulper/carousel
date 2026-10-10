# Carousel Studio: handoff for Claude Code

Goal: deploy this Next.js 14 app to Vercel with Supabase. Get one story rendering end to end.

## What this is
- `lib/carousel/template.jsx` is the slide template: 1080×1350, six cover styles, body slides, a brand config. Treat it as the source of truth for how slides look; don't restyle it.
- `app/(studio)/*`: the dashboard, the page (brand) editor, the story editor, and `/queue` (review queue: stories not yet approved or rejected, grouped by what they still need). `/queue` already handles preview mode via `isConfigured()` in lib/supabase.js; reuse that helper for the other pages.
- `app/render/[id]`: the bare page that Puppeteer screenshots.
- `app/api/*`:
  - `pages` and `stories`: CRUD.
  - `upload`: hands out signed upload slots. The browser then uploads straight to Supabase, because Vercel limits request body size.
  - `render/[id]`: Puppeteer → JPGs into storage.
  - `source/[id]`: Claude web search/fetch → photos into story slots.
- `workers/`: Python cutout worker using rembg. It does NOT run on Vercel. Host it separately later; the app works without it, minus subject cutouts.
- `supabase/schema.sql`: the tables plus a public `studio` bucket.

## Deploy steps
1. Create a Supabase project. Run `supabase/schema.sql` in the SQL editor. It's safe to re-run; it also adds the `sourced_at` and `source_meta` columns used by the review queue.
2. Push this folder to a new GitHub repo and import it in Vercel. Framework: Next.js. Node version: 22.x (required by @sparticuz/chromium).
3. Set the env vars from `.env.example` in Vercel → Settings → Environment Variables.
   - APP_URL = the production domain, e.g. https://carousel-studio.vercel.app.
   - Leave CHROME_EXECUTABLE_PATH unset on Vercel.
4. Vercel → Settings → Deployment Protection: make sure the production domain isn't behind Vercel Authentication. Puppeteer loads /render/:id from it, and the app already has its own login (middleware.js basic auth).
5. Deploy, then run the smoke test below.

## Smoke test (do these in order)
1. Open the site, log in with STUDIO_USER/PASSWORD, and add a page.
2. Page editor: upload a logo PNG and a .woff2 font. Save, reload, and confirm both persist. This tests signed uploads.
3. Create a story. Paste any public image URL into the cover's main image. Click Render. Expect JPGs under "Renders" and in storage at `studio/renders/...`.
4. With ANTHROPIC_API_KEY set: click "Find missing images" on a story that has a `source_url`. If the Claude API rejects the web_fetch tool, set ANTHROPIC_BETA=web-fetch-2025-09-10 and retry.
5. Pipeline ingest: `curl -X POST $APP_URL/api/stories -H "x-api-key: $PIPELINE_API_KEY" -H "Content-Type: application/json" -d @story.json`. A sample is in `samples/story_comedy_wildlife_2026.json`; set its page_id first.

## Tested vs not yet tested
Tested:
- `next build` passes.
- Both editors run in a browser.
- The template renders correctly in headless Chromium.
- @sparticuz/chromium 153 + puppeteer-core 25.11 launches and screenshots slides on Linux x64.
- Sourcing helpers (dedupe, slot listing) unit-checked.

NOT yet tested against live services:
- Supabase reads/writes and signed uploads.
- The Claude API call in /api/source.
- The Python worker against real Supabase.

Fix anything those surface. Keep the API shapes stable, because the pipeline depends on them.

## Version pins (keep in sync)
puppeteer-core 25.11.0 targets Chrome 153 and must match @sparticuz/chromium 153.x. If you bump one, bump the other to the matching major.

## Function durations
`/api/render/[id]` and `/api/source/[id]` export `maxDuration = 300`. Rendering 8 slides takes roughly 10–30 s on a warm instance, and sourcing can take 1–2 minutes. If the Vercel plan's limit is lower, Vercel caps it. Check the plan and lower maxDuration if the build warns.
