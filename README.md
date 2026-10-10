# Carousel Studio

Next.js + Supabase app around the carousel template:

- **Pages**: one per Instagram page. Logo, colours, fonts, max sizes, all stored as one `brand` JSON.
- **Stories**: slides JSON (copy, images, cutouts, overlays). Your pipeline creates them, or you make them by hand.
- **Render**: Puppeteer screenshots each slide at 1080×1350 and uploads the JPGs to Supabase Storage.
- **Image sourcing**: `POST /api/source/:id`. Claude searches and reads coverage of the story, the server downloads and filters the photos, then Claude assigns the best one to each slot.
- **Cutout worker**: Python background removal that fills in subject cutouts and stickers.

## Setup

1. Create a Supabase project. Run `supabase/schema.sql` in the SQL editor. It creates the three tables and a public `studio` storage bucket.
2. Copy `.env.example` to `.env.local` and fill it in.
3. `npm install`, then `npm run dev`, then open http://localhost:3000. The browser asks for STUDIO_USER / STUDIO_PASSWORD.
4. Add a page, set its brand, and save. Then create a story or send one in from the pipeline.

## Flow

```
pipeline ──POST /api/stories──▶ stories (draft)
                                   │
     POST /api/source/:id ─────────┘ fills empty image slots + runners-up
                                   │
                    cutout worker ─┘ adds cutouts → status 'ready'
                                   │
           you, in /stories/:id ───┘ tweak copy/images, pick cover style
                                   │
          Render → /api/render/:id ┘ Puppeteer → JPGs in storage → `renders` row, status 'rendered'
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
        "bg": { "src": "https://…/main.jpg", "focal": [50, 30] },
        "inset": { "src": "https://…/second.jpg" } },
      { "layout": "body", "title": "Meet Comando",
        "body": "Comando is the [[smallest canine member]] of the National Guard.",
        "bg": { "src": "https://…/helmet.jpg" } }
    ]
  }'
```

Rendering can also be triggered from code: `POST /api/render/:id` with `{ "variants": ["depth","band"] }` and the same `x-api-key` header.

## Image sourcing

`POST /api/source/:id` with `{ "overwrite": false }`. In the story editor, use **Find missing images** or **Re-source all**.

1. **Find.** Claude is called with the web search and web fetch tools. It reads the story's `source_url` plus other coverage it finds, and lists the photo URLs that appear in those pages.
2. **Filter.** The server downloads every candidate and measures it with Sharp. It drops anything under `MIN_IMAGE_SHORT_SIDE` (default 1000px) and collapses copies of the same photo at different sizes. If nothing passes the size bar, it keeps the best available and returns `lowRes: true`.
3. **Assign.** Claude looks at the surviving photos. It picks one per slot (cover main, cover second, each body slide) with a focal point, plus up to 3 runners-up.
4. **Save.** Winners and runners-up are re-hosted in storage. Any old cutout is cleared so the cutout worker regenerates it. The runners-up appear as one-click swaps in the story editor.

This needs `ANTHROPIC_API_KEY`. Each run uses two Claude calls plus up to 4 searches and 6 page fetches, so watch cost if you run it on every story.

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

See `CLAUDE.md` for the full Vercel checklist. In short:
- **Studio + API on Vercel.** Node 22. Rendering uses `puppeteer-core` + `@sparticuz/chromium`. Locally, point `CHROME_EXECUTABLE_PATH` at your installed Chrome.
- **Uploads.** Files go from the browser straight to Supabase Storage via signed upload slots, so large photos aren't blocked by Vercel's request size limit.
- **APP_URL.** Set it to the production domain, and keep that domain free of Vercel Deployment Protection. The app has its own login.
- **Cutout worker.** `workers/cutout_worker.py` runs as a separate always-on Python process (Railway, Fly, a VPS). Without it, the app still works but the depth cover and stickers need cutouts added by hand.
- **Image rights.** Sourced photos are re-hosted in your storage with their credit. Check each source's press terms before posting.
