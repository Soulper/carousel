# Carousel Studio

Next.js + Supabase app around the carousel template:

- **Pages**: one per Instagram page. Logo, colours, fonts, max sizes, all stored as one `brand` JSON.
- **Stories**: slides JSON (copy, images, cutouts, overlays). Your pipeline creates them, or you make them by hand.
- **Render**: Puppeteer screenshots each slide at 1080Ã—1350 and uploads the JPGs to Supabase Storage.
- **Image sourcing**: `POST /api/source/:id`. Claude searches and reads coverage of the story, the server downloads and filters the photos, then Claude assigns the best one to each slot.
- **Cutout worker**: Python background removal that fills in subject cutouts and stickers.

## Setup

1. Create a Supabase project. Run `supabase/schema.sql` in the SQL editor. It creates the three tables and a public `studio` storage bucket.
2. Copy `.env.example` to `.env.local` and fill it in.
3. `npm install`, then `npm run dev`, then open http://localhost:3000. The browser asks for STUDIO_USER / STUDIO_PASSWORD.
4. Add a page, set its brand, and save. Then create a story or send one in from the pipeline.

## Flow

```
pipeline â”€â”€POST /api/storiesâ”€â”€â–¶ stories (draft)
                                   â”‚
     POST /api/source/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜ fills empty image slots + runners-up
                                   â”‚
                    cutout worker â”€â”˜ adds cutouts â†’ status 'ready'
                                   â”‚
           you, in /stories/:id â”€â”€â”€â”˜ tweak copy/images, pick cover style
                                   â”‚
          Render â†’ /api/render/:id â”˜ Puppeteer â†’ JPGs in storage â†’ `renders` row, status 'rendered'
```

### Sending a story from your pipeline

```bash
curl -X POST $APP_URL/api/stories \
  -H "x-api-key: $PIPELINE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "page_id": "<page uuid>",
    "title": "Comando the Chihuahua",
    "hero_variant": "depth",
    "slides": [
      { "layout": "cover", "headline": "This Chihuahua just joined Mexico'\''s National Guard",
        "bg": { "src": "https://â€¦/main.jpg", "focal": [50, 30] },
        "inset": { "src": "https://â€¦/second.jpg" } },
      { "layout": "body", "title": "Meet Comando",
        "body": "Comando is the [[smallest canine member]] of the National Guard.",
        "bg": { "src": "https://â€¦/helmet.jpg" } }
    ]
  }'
```

Rendering can also be triggered from code: `POST /api/render/:id` with `{ "variants": ["depth","band"] }` and the same `x-api-key` header.

## Image sourcing

`POST /api/source/:id` with `{ "overwrite": false }`. In the story editor, use **Find missing images** or **Re-source all**.

1. **Find.** The article search runs each slide's photo angle, plus a **keyless web search** (DuckDuckGo — no API key) fills the gaps, so candidate pages are found whether or not the AI provider has search grounding. The story's `source_url` is always scraped, and bot-shielded pages are read through a reader proxy.
2. **Filter.** Every candidate is downloaded and measured with Sharp. It drops anything under `MIN_IMAGE_SHORT_SIDE` (1000px), collapses copies of the same photo, and rejects **flat graphics** — icons, app-store badges and stock-photo disclaimer cards — by colour count and by how much of the frame one colour owns. Their alt text is checked too ("Available on the App Store", "Stock images … may be sourced from").
3. **Floor.** If the article scrape is still thin, freely licensed photos are pulled from **Openverse** and **Wikimedia Commons** (also keyless), with real creator/licence credits.
4. **Assign.** A vision model picks one photo per slot (cover main, cover second, each body slide) with a focal point. No vision model? The photos are placed in slide order instead — a real deck beats a failed pass.
5. **Save.** Winners are re-hosted in storage. A failed re-source never leaves junk behind: any logo/app card already on the deck is evicted before the run gives up.
6. **Dedupe.** No photo can appear twice: candidates identical to a photo already on the deck (fingerprint check) are dropped, and junk on the deck never blocks its own replacement.

Works with any provider — Anthropic, Gemini, or a free one. Only Anthropic uses paid search/fetch; everyone else uses the keyless search.

## AI providers

Topic picking, copy writing and photo judging all go through one switch:

| `AI_PROVIDER` | what it needs | cost |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | paid, does its own web search + fetch |
| `gemini` | `GEMINI_API_KEY` | free tier (search grounding, vision), daily quota |
| `free` / `groq` / `github` / `mistral` / `cerebras` / `openrouter` | the matching key (see `.env.example`) | free |

Auto order is Anthropic → a free provider → Gemini. The free providers speak OpenAI's Chat Completions API, so one adapter covers them and any OpenAI-compatible endpoint works (set `FREE_BASE_URL` + `FREE_MODEL`). Vision-capable ones are listed in `.env.example`; when the chosen provider has no vision, only the photo-judging call is routed to Gemini if its key is present, otherwise sourcing assigns in order.

## Slide JSON

| field | used on | notes |
|---|---|---|
| `layout` | all | `cover` or `body` |
| `headline` | cover | auto-sized, balanced lines |
| `title`, `body` | body | `[[words]]` get the highlight colour |
| `bg` | all | `{ src, focal:[x%,y%], cutout?, cutoutBox? }` |
| `inset` | cover | second image `{ src, cutout?, focal }` |
| `sticker` | cover | `{ src, x, y, width, rotate }` as % of the frame |
| `overlays` | any | `stack`, `arrow`, `cutout` primitives |
| `maxOcclusion` | cover | how much of the headline the subject may cover (depth style) |

## Brand JSON (pages.brand)

Partial objects are fine. Anything missing falls back to `defaultBrand` in `lib/carousel/template.jsx`.
- **Fonts:** set a Google font by `family`. For your own font, upload a file in the brand editor; that saves its `url`.
- **Logo:** `logo.src` is a URL in storage.

## Deploying

See `CLAUDE.md` for the full Netlify checklist. In short:
- **Studio + API on Netlify.** Node 22 (`netlify.toml` and `.nvmrc`). Rendering uses `puppeteer-core` + `@sparticuz/chromium`. Locally, point `CHROME_EXECUTABLE_PATH` at your installed Chrome.
- **Long jobs.** Rendering and image sourcing take minutes, well past what an ordinary Netlify request is allowed, so they run as background functions in `netlify/functions/`. The API route answers 202 and the browser polls the story row (`runJob` in `lib/client.js`) until the job records its result or its error. Anywhere else — `npm run dev`, Vercel, a VPS — the same routes just do the work inline and return the result directly.
- **Memory.** Free-plan functions are capped at 1 GB, which is tight for Chromium. If rendering dies with an out-of-memory error, that cap is the reason; a paid plan lifts it.
- **Uploads.** Files go from the browser straight to Supabase Storage via signed upload slots, so large photos aren't blocked by a request size limit.
- **APP_URL.** Set it to the production domain, and keep that domain free of Netlify's password protection. Puppeteer loads `/render/:id` from it, and the app has its own login.
- **Cutout worker.** `workers/cutout_worker.py` runs as a separate always-on Python process (Railway, Fly, a VPS). Without it, the app still works but the depth cover and stickers need cutouts added by hand.
- **Image rights.** Sourced photos are re-hosted in your storage with their credit. Check each source's press terms before posting.
