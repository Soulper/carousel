"use client";
import { Slide, BrandFonts } from "@/lib/carousel/template";

/* What Puppeteer screenshots. Covers are emitted once per requested variant
   (tagged data-cover); body slides are emitted in a single shared sheet
   (tagged data-body) because they don't depend on the cover style, so the
   renderer shoots them once and reuses them for every variant's file list. */
export default function RenderSlides({ slides, brand, variants = ["depth"] }) {
  const [cover, ...rest] = slides;
  return (
    <div style={{ width: 1080, background: "#000" }}>
      <BrandFonts brand={brand} />
      {cover && cover.layout === "cover" &&
        variants.map((v) => (
          <div key={v} data-cover={v}><Slide slide={{ ...cover, variant: v }} brand={brand} index={1} /></div>
        ))}
      {!!rest.length && (
        <div data-body>
          {rest.map((s, i) => <Slide key={i} slide={s} brand={brand} index={i + 2} />)}
        </div>
      )}
    </div>
  );
}
