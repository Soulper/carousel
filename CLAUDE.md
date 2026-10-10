# Carousel Studio: handoff for Claude Code

Goal: deploy this Next.js 14 app to Netlify with Supabase. Get one story rendering end to end.

## What this is
- `lib/carousel/template.jsx` is the slide template: 1080×1350, six cover styles, body slides, a brand config. Treat it as the source of truth for how slides look; don't restyle it.
- `app/(studio)/*`: the dashboard, the page (brand) editor, the story editor, and `/queue` (review queue: stories not yet approved or rejected, grouped by what they still need). `/queue` already handles preview mode via `isConfigured()` in lib/supabase.js; reuse that helper for the other pages.
- `app/render/[id]`: the bare page that Puppeteer screenshots.
- `app/api/*`:
  - `pages` and `stories`: CRUD.
  - `upload`: hands out signed upload slots. The browser then uploads straight to Supabase, because hosts limit request body size.
  - `render/[id]` and `source/[id]`: thin wrappers. The work lives in `lib/render.js` and `lib/source.js` so Netlify can run it from a background function. See "Long jobs" below.
- `netlify/functions/render.mts` and `source.mts`: the background functions. They import the same lib files and check `x-api-key` themselves, because function URLs don't pass through `middleware.js`.
- `lib/jobs.js`: decides whether a job runs inline or is handed to a background function, and records `stories.job` while it runs.
- `workers/`: Python cutout worker using rembg. It does NOT run on Netlify. Host it separately later; the app works without it, minus subject cutouts.
- `supabase/schema.sql`: the tables plus a public `studio` bucket.

## Deploy steps
1. Create a Supabase project. Run `supabase/schema.sql` in the SQL editor. It's safe to re-run; it also adds the `sourced_at`, `source_meta` and `job` columns used by the review queue and the background jobs.
2. Push this folder to GitHub and import it in Netlify. Framework: Next.js (detected automatically). Build command and publish directory come from `netlify.toml`; Node is pinned to 22 there and in `.nvmrc` (required by @sparticuz/chromium).
3. Set the env vars from `.env.example` in Netlify → Site configuration → Environment variables.
   - APP_URL = the production domain, e.g. https://carousel.netlify.app. Set it explicitly; the fallback to Netlify's own URL variables is a convenience, not a promise.
   - Leave CHROME_EXECUTABLE_PATH unset on Netlify.
4. Netlify → Site configuration → Visitor access control: make sure the production domain isn't behind Netlify's password. Puppeteer loads /render/:id from it, and the app already has its own login (middleware.js basic auth).
5. Deploy, then run the smoke test below.

## Long jobs
Rendering takes 10–30 s and sourcing 1–2 minutes. Netlify's ordinary functions are cut off well before that, so on Netlify:
- `POST /api/render/:id` and `POST /api/source/:id` call `enqueue()`, which POSTs to the matching background function and answers 202 `{ queued: true }`.
- The background function records `{ kind, started_at, result }` or `{ ..., error }` on the story row when it finishes.
- `runJob()` in `lib/client.js` sees `queued` and polls `/api/stories/:id` every 3 s until the result or the error lands, then returns the same shape the inline path returns. Callers don't branch on it.
- Anywhere else (`npm run dev`, Vercel, a VPS) `enqueue()` returns false and the route does the work inline, unchanged.

Keep `lib/render.js` and `lib/source.js` free of Next imports, and use relative imports inside them: the background functions are bundled by esbuild, which doesn't know the `@/` alias.

## Memory
Free-plan Netlify functions are capped at 1 GB. Chromium is tight in that. If rendering dies with an out-of-memory error, that cap is why; a paid plan lifts it. The alternative is running the renderer on a small always-on host and calling it from Netlify.

## Smoke test (do these in order)
1. Open the site, log in with STUDIO_USER/PASSWORD, and add a page.
2. Page editor: upload a logo PNG and a .woff2 font. Save, reload, and confirm both persist. This tests signed uploads.
3. Create a story. Paste any public image URL into the cover's main image. Click Render. Expect JPGs under "Renders" and in storage at `studio/renders/...`. The button stays busy for the whole run — that's the browser polling.
4. With ANTHROPIC_API_KEY set: click "Find missing images" on a story that has a `source_url`. If the Claude API rejects the web_fetch tool, set ANTHROPIC_BETA=web-fetch-2025-09-10 and retry.
5. Pipeline ingest: `curl -X POST $APP_URL/api/stories -H "x-api-key: $PIPELINE_API_KEY" -H "Content-Type: application/json" -d @story.json`. A sample is in `samples/story_comedy_wildlife_2026.json`; set its page_id first.

If a job fails, the message appears in the UI and the same text is on the story row (`job.error`) and in the function's logs — there is no client to answer, so nothing else would report it.

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
- The background functions on a real Netlify deploy.
- The Python worker against real Supabase.

Fix anything those surface. Keep the API shapes stable, because the pipeline depends on them.

## Version pins (keep in sync)
puppeteer-core 25.11.0 targets Chrome 153 and must match @sparticuz/chromium 153.x. If you bump one, bump the other to the matching major.

## Function durations
`/api/render/[id]` and `/api/source/[id]` export `maxDuration = 300`. That's the Vercel knob and Netlify ignores it — the background functions get 15 minutes regardless. What matters on Netlify is that nothing long runs in an ordinary function: `/api/copy/:id` still runs inline and takes about half a minute, which fits, but keep an eye on it.