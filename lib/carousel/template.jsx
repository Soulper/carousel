"use client";
import { useLayoutEffect, useRef, useState, useEffect } from "react";

/* ------------------------------------------------------------------
   CAROUSEL TEMPLATE — story slides + page brand in, 1080×1350 slides out.
   Text markup: [[words]] → highlight colour.
   Async layout (cutout placement) renders a hidden [data-pending] marker
   until it settles, so the renderer knows when to screenshot.
------------------------------------------------------------------- */

export const W = 1080;
export const H = 1350;

import { HERO_VARIANTS } from "./constants";
export { HERO_VARIANTS };

/* ------------------------------------------------------------------
   BRAND CONFIG — everything visual a page controls. Pass a partial
   object; it's deep-merged over these defaults (see resolveBrand).
------------------------------------------------------------------- */
export const defaultBrand = {
  name: "Your Page",
  mark: "P", // text fallback when there's no logo file
  logo: {
    src: null,             // transparent PNG / SVG / WebP. null → text mark
    style: "badge",        // "badge" = logo on an accent tile · "plain" = logo as-is
    position: "top-right", // top-left | top-center | top-right | bottom-left | bottom-center | bottom-right
    size: 74,              // max box in px — logo is fitted inside size×size, never larger
    margin: 36,            // distance from the frame edge
    rotate: -6,
    opacity: 1,
    avoid: true,           // move to the next free corner if this layout has text/images there
    onCover: true,
    onBody: true,
  },
  colors: {
    accent: "#FFE14D",     // highlights, arrows, band, badge tile, divider
    onAccent: "#111111",   // text/logo on accent surfaces
    text: "#FFFFFF",       // headlines and body over photos
    shade: "#000000",      // gradient / scrim colour behind text
    shadeStrength: 0.92,
    highlight: null,       // [[keyword]] colour — defaults to accent
  },
  fonts: {
    display: { family: "Anton", fallback: "Impact, sans-serif", weight: 400, uppercase: true, lineHeight: 0.98, tracking: 0 },
    body: { family: "Inter Tight", fallback: "system-ui, sans-serif", weight: 400, highlightWeight: 800, lineHeight: 1.3 },
  },
  type: {                  // px at 1080 wide. Text shrinks from max toward min to fit; never exceeds max.
    hero: { max: 160, min: 96 },
    title: { max: 120, min: 78 }, // body-slide titles stay on one line down to min
    body: { max: 46, min: 36 },
  },
  safe: 54,                // side margin for text blocks
  divider: true,           // rule + mark above the cover headline
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
  return out;
}
export const resolveBrand = (b) => merge(defaultBrand, b || {});

export const fam = (f) => `'${f.family}', ${f.fallback}`;
const rgba = (hex, a) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// ---------- Text helpers ----------
// Keeps the last two words together, and a short first word with the next one,
// so no line is left holding a single word
const tieLast = (t) => (typeof t === "string"
  ? t.replace(/\s+(\S+)\s*$/, "\u00A0$1").replace(/^(\S{1,4})\s+/, "$1\u00A0")
  : t);

function Rich({ text, brand }) {
  const c = brand.colors.highlight || brand.colors.accent;
  return tieLast(text).split(/(\[\[.+?\]\])/g).map((p, i) =>
    p.startsWith("[[") ? (
      <span key={i} style={{ color: c, fontWeight: brand.fonts.body.highlightWeight }}>{p.slice(2, -2)}</span>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

// Bumps whenever any web font finishes loading, so measurements re-run
function useFontsReady() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((x) => x + 1);
    document.fonts?.ready.then(bump);
    document.fonts?.addEventListener?.("loadingdone", bump);
    return () => document.fonts?.removeEventListener?.("loadingdone", bump);
  }, []);
  return n;
}

/* Deps for the measuring effect, as text rather than as the children node:
   JSX children are new objects on every parent render, so depending on them
   would re-measure the whole slide whenever anything above it re-renders. */
function textDep(children) {
  if (children == null || children === false) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textDep).join("");
  if (children.props) return children.props.text ?? textDep(children.props.children);
  return "";
}

/* Largest font size in [lo, hi] that fits. Text only ever gets wider and taller
   as the size grows, so "fits" is monotone and a binary search finds the answer
   in ~7 measurements instead of stepping down 2px from a 160px max (~32). */
function largestFitting(lo, hi, fits) {
  if (fits(hi)) return hi;
  let best = null;
  let a = lo, z = hi - 1;
  while (a <= z) {
    const mid = (a + z) >> 1;
    if (fits(mid)) { best = mid; a = mid + 1; } else z = mid - 1;
  }
  return best ?? lo; // even the minimum overflows; use it and let it clip
}

function FitText({ children, max, min, maxHeight, singleLine = false, lineMin, wrap = "balance", style }) {
  const ref = useRef(null);
  const fonts = useFontsReady();
  const text = textDep(children);
  const fontKey = style?.fontFamily;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (s, nowrap) => { el.style.fontSize = s + "px"; el.style.whiteSpace = nowrap ? "nowrap" : "normal"; };
    if (singleLine) {
      const oneLine = (s) => { set(s, true); return el.scrollWidth <= el.clientWidth; };
      const s = largestFitting(lineMin ?? min, max, oneLine);
      set(s, true);
      if (oneLine(s)) return;
    }
    const wrapped = (s) => {
      set(s, false);
      return el.scrollHeight <= maxHeight && el.scrollWidth <= el.clientWidth;
    };
    const s = largestFitting(min, max, wrapped);
    set(s, false);
  }, [text, max, min, maxHeight, singleLine, lineMin, fonts, fontKey]);
  return <div ref={ref} style={{ textWrap: wrap, ...style, fontSize: max }}>{children}</div>;
}

function EdgeText({ brand, edge = "bottom", fade = 380, padding, onHeight, children }) {
  const ref = useRef(null);
  const [h, setH] = useState(400);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => { setH(el.offsetHeight); onHeight?.(el.offsetHeight); };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, []);
  const dir = edge === "bottom" ? "to top" : "to bottom";
  const k = brand.colors.shadeStrength;
  const a = (x) => rgba(brand.colors.shade, (k * x).toFixed(3));
  return (
    <>
      <div style={{
        position: "absolute", left: 0, right: 0, [edge]: 0, height: h + fade, pointerEvents: "none",
        background: `linear-gradient(${dir}, ${a(1)} 0px, ${a(1)} ${h * 0.55}px, ${a(0.8)} ${h}px, ${a(0.45)} ${h + fade * 0.45}px, ${a(0.15)} ${h + fade * 0.8}px, ${a(0)} ${h + fade}px)`,
      }} />
      <div ref={ref} style={{ position: "absolute", left: 0, right: 0, [edge]: 0, padding: padding ?? `0 ${brand.safe}px 56px` }}>{children}</div>
    </>
  );
}

// ---------- Images ----------
function Img({ slot, label, style }) {
  const [failed, setFailed] = useState(false);
  const pos = slot?.focal ? `${slot.focal[0]}% ${slot.focal[1]}%` : "50% 50%";
  if (slot?.src && !failed) {
    return (
      <img src={slot.src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: pos, display: "block", ...style }} />
    );
  }
  return (
    <div style={{
      width: "100%", height: "100%", ...style,
      background: "repeating-linear-gradient(135deg,#3a4250 0 40px,#333a46 40px 80px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "rgba(255,255,255,.55)", font: "500 26px system-ui", textAlign: "center", padding: 60, boxSizing: "border-box",
    }}>{slot?.query ? `${label}: “${slot.query}”` : `No ${label} image yet`}</div>
  );
}

// ---------- Subject cutouts ----------
function Subject({ slot, style }) {
  if (!slot?.cutout) return null;
  const pos = slot.focal ? `${slot.focal[0]}% ${slot.focal[1]}%` : "50% 50%";
  return (
    <img src={slot.cutout} alt="" crossOrigin="anonymous" style={{
      position: "absolute", inset: 0, width: "100%", height: "100%",
      objectFit: "cover", objectPosition: pos, pointerEvents: "none", ...style,
    }} />
  );
}

const imgCache = {};
function loadImg(src) {
  if (!imgCache[src]) {
    imgCache[src] = new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }
  return imgCache[src];
}

function coverageAt(img, p, rect) {
  const k = 0.25;
  const cw = Math.max(1, Math.round(rect.w * k)), ch = Math.max(1, Math.round(rect.h * k));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const g = c.getContext("2d");
  g.drawImage(img, (p.x - rect.x) * k, (p.y - rect.y) * k, p.w * k, p.h * k);
  const d = g.getImageData(0, 0, cw, ch).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
  return n / (cw * ch);
}

async function coverage(slot, rect, frameW = W, frameH = H) {
  const img = await loadImg(slot.cutout);
  const s = Math.max(frameW / img.width, frameH / img.height);
  const [fx, fy] = slot.focal || [50, 50];
  return coverageAt(img, {
    x: ((frameW - img.width * s) * fx) / 100, y: ((frameH - img.height * s) * fy) / 100,
    w: img.width * s, h: img.height * s,
  }, rect);
}

function slideRect(el) {
  const root = el.closest("[data-slide]");
  const r = root.getBoundingClientRect(), e = el.getBoundingClientRect();
  const k = r.width / W;
  return { x: (e.left - r.left) / k, y: (e.top - r.top) / k, w: e.width / k, h: e.height / k };
}

// ---------- Overlay primitives ----------
function Arrow({ from, to, bend = 0, color }) {
  const [x1, y1] = [(from[0] / 100) * W, (from[1] / 100) * H];
  const [x2, y2] = [(to[0] / 100) * W, (to[1] / 100) * H];
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const cx = (x1 + x2) / 2 + (-dy / len) * (bend / 100) * H;
  const cy = (y1 + y2) / 2 + (dx / len) * (bend / 100) * H;
  const ang = Math.atan2(y2 - cy, x2 - cx);
  const hd = 46, sp = 0.5;
  const h1 = [x2 - hd * Math.cos(ang - sp), y2 - hd * Math.sin(ang - sp)];
  const h2 = [x2 - hd * Math.cos(ang + sp), y2 - hd * Math.sin(ang + sp)];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", filter: "drop-shadow(0 4px 8px rgba(0,0,0,.35))" }}>
      <g fill="none" stroke={color} strokeWidth="13" strokeLinecap="round" strokeLinejoin="round">
        <path d={`M${x1},${y1} Q${cx},${cy} ${x2},${y2}`} />
        <path d={`M${h1[0]},${h1[1]} L${x2},${y2} L${h2[0]},${h2[1]}`} />
      </g>
    </svg>
  );
}

function StackItem({ src, item, px }) {
  const [failed, setFailed] = useState(false);
  return src && !failed
    ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} style={{ width: px, height: px, objectFit: "contain", display: "block" }} />
    : <div style={{ fontSize: px * 0.9, lineHeight: 1.05 }}>{item}</div>;
}

function Stack({ item, src, count, x, y, size }) {
  const px = (size / 100) * W;
  return (
    <div style={{
      position: "absolute", left: `${x}%`, top: `${y}%`, transform: "translateX(-50%)",
      display: "flex", flexDirection: "column", alignItems: "center", gap: px * 0.02,
      filter: "drop-shadow(0 10px 18px rgba(0,0,0,.35))",
    }}>
      {Array.from({ length: count }).map((_, i) => <StackItem key={i} src={src} item={item} px={px} />)}
    </div>
  );
}

function Cutout({ src, x, y, size, rotate = 0 }) {
  return (
    <img src={src} alt="" referrerPolicy="no-referrer" style={{
      position: "absolute", left: `${x}%`, top: `${y}%`, width: `${size}%`,
      transform: `translate(-50%,-50%) rotate(${rotate}deg)`, filter: "drop-shadow(0 12px 22px rgba(0,0,0,.4))",
    }} />
  );
}

function Overlays({ items = [], brand }) {
  return items.map((o, i) => {
    if (o.type === "arrow") return <Arrow key={i} {...o} color={o.color || brand.colors.accent} />;
    if (o.type === "stack") return <Stack key={i} {...o} />;
    if (o.type === "cutout" && o.src) return <Cutout key={i} {...o} />;
    return null;
  });
}

// ---------- Logo ----------
/* Each layout declares what it occupies ("bottom", "top", or a corner like "top-left").
   The logo keeps its configured spot unless that spot is busy, then tries the
   mirrored corner, the flipped edge, then the opposite corner. */
const flipH = (p) => (p.endsWith("left") ? p.replace("left", "right") : p.endsWith("right") ? p.replace("right", "left") : p);
const flipV = (p) => (p.startsWith("top") ? p.replace("top", "bottom") : p.replace("bottom", "top"));
function pickPosition(pref, busy = [], avoid = true) {
  if (!avoid) return pref;
  const blocked = (p) => busy.some((z) => z === p || z === p.split("-")[0]);
  return [pref, flipH(pref), flipV(pref), flipV(flipH(pref))].find((p) => !blocked(p)) || pref;
}

// Logo or text mark at a given height (used in dividers, polaroid caption)
function Mark({ brand, height, color }) {
  if (brand.logo.src) return <img src={brand.logo.src} alt="" style={{ height, width: "auto", display: "block" }} />;
  return <div style={{ fontFamily: fam(brand.fonts.display), fontWeight: brand.fonts.display.weight, fontSize: height, lineHeight: 1, color }}>{brand.mark}</div>;
}

function Logo({ brand, busy, where = "cover" }) {
  const L = brand.logo;
  if ((where === "cover" && !L.onCover) || (where === "body" && !L.onBody)) return null;
  const pos = pickPosition(L.position, busy, L.avoid);
  const [v, hz] = pos.split("-");
  const box = {
    position: "absolute", [v]: L.margin, opacity: L.opacity, zIndex: 5,
    ...(hz === "center" ? { left: "50%" } : { [hz]: L.margin }),
    transform: `${hz === "center" ? "translateX(-50%) " : ""}rotate(${L.rotate}deg)`,
  };
  if (L.style === "badge") {
    return (
      <div style={{
        ...box, width: L.size, height: L.size, borderRadius: L.size * 0.19, background: brand.colors.accent,
        display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px rgba(0,0,0,.3)",
      }}>
        {L.src
          ? <img src={L.src} alt="" style={{ maxWidth: "72%", maxHeight: "72%", objectFit: "contain" }} />
          : <div style={{ fontFamily: fam(brand.fonts.display), fontSize: L.size * (brand.mark.length > 1 ? 0.42 : 0.6), color: brand.colors.onAccent, lineHeight: 1 }}>{brand.mark}</div>}
      </div>
    );
  }
  return (
    <div style={{ ...box, width: L.size, height: L.size, display: "flex", alignItems: "center", justifyContent: hz === "right" ? "flex-end" : hz === "left" ? "flex-start" : "center" }}>
      {L.src
        ? <img src={L.src} alt="" style={{ maxWidth: L.size, maxHeight: L.size, objectFit: "contain", filter: "drop-shadow(0 4px 12px rgba(0,0,0,.35))" }} />
        : <div style={{ fontFamily: fam(brand.fonts.display), fontSize: L.size * 0.6, color: brand.colors.text, textShadow: "0 3px 12px rgba(0,0,0,.5)" }}>{brand.mark}</div>}
    </div>
  );
}

function Divider({ brand }) {
  if (!brand.divider) return null;
  const line = { flex: 1, height: 2, background: brand.colors.text, opacity: 0.55 };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22, margin: "0 120px 26px" }}>
      <div style={line} />
      <Mark brand={brand} height={40} color={brand.colors.text} />
      <div style={line} />
    </div>
  );
}

function Headline({ brand, text, scale = 1, maxHeight = 440, color, align = "center" }) {
  const d = brand.fonts.display;
  return (
    <FitText max={Math.round(brand.type.hero.max * scale)} min={brand.type.hero.min} maxHeight={maxHeight} style={{
      fontFamily: fam(d), fontWeight: d.weight, letterSpacing: d.tracking, lineHeight: d.lineHeight,
      textTransform: d.uppercase ? "uppercase" : "none", color: color || brand.colors.text, textAlign: align,
    }}>{tieLast(text)}</FitText>
  );
}

// ---------- Hero variants ----------
function HeroDepth({ s, brand }) {
  const textRef = useRef(null);
  const fonts = useFontsReady();
  const [mode, setMode] = useState({ kind: "pending" });
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || !s.bg?.cutout) return;
    let alive = true;
    (async () => {
      await document.fonts?.ready;
      const t = slideRect(el);
      const line = parseFloat(getComputedStyle(el.firstChild).fontSize) * brand.fonts.display.lineHeight;
      const strip = { x: t.x, y: t.y, w: t.w, h: line * 0.62 };
      const occ = await coverage(s.bg, strip);
      if (!alive) return;
      setMode(occ <= (s.maxOcclusion ?? 0.3) ? { kind: "photo", cutY: t.y + line * 0.62 } : { kind: "star" });
    })();
    return () => { alive = false; };
  }, [s, fonts, brand]);

  if (mode.kind === "star") return <HeroStar s={s} brand={brand} />;
  return (
    <>
      <Img slot={s.bg} label="bg" />
      <EdgeText brand={brand} fade={420} padding={`0 ${brand.safe - 10}px 56px`}>
        <div ref={textRef}><Headline brand={brand} text={s.headline} scale={1.25} maxHeight={640} /></div>
      </EdgeText>
      {mode.kind === "photo" && (
        <Subject slot={s.bg} style={{
          WebkitMaskImage: `linear-gradient(to bottom, #000 ${mode.cutY - 24}px, transparent ${mode.cutY + 6}px)`,
          maskImage: `linear-gradient(to bottom, #000 ${mode.cutY - 24}px, transparent ${mode.cutY + 6}px)`,
          filter: "drop-shadow(0 10px 24px rgba(0,0,0,.45))",
        }} />
      )}
      <Logo brand={brand} busy={["bottom"]} />
      {mode.kind === "pending" && s.bg?.cutout && <i data-pending hidden />}
    </>
  );
}

function HeroStar({ s, brand }) {
  const textRef = useRef(null);
  const fonts = useFontsReady();
  const [place, setPlace] = useState(null);
  const box = s.bg.cutoutBox || [0, 0, 100, 100];
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    let alive = true;
    (async () => {
      await document.fonts?.ready;
      const img = await loadImg(s.bg.cutout);
      const t = slideRect(el);
      const bx = (box[0] / 100) * img.width, by = (box[1] / 100) * img.height;
      const bw = ((box[2] - box[0]) / 100) * img.width, bh = ((box[3] - box[1]) / 100) * img.height;
      const bleed = H * (s.subjectBleed ?? 0.22);
      const at = (top) => {
        const sc = (H - top + bleed) / bh;
        return { x: W / 2 - (bx + bw / 2) * sc, y: top - by * sc, w: img.width * sc, h: img.height * sc };
      };
      const line = parseFloat(getComputedStyle(el.firstChild).fontSize) * brand.fonts.display.lineHeight;
      const lastLine = { x: t.x, y: t.y + t.h - line, w: t.w, h: line };
      const budget = s.maxOcclusion ?? 0.12;
      let best = at(t.y + t.h);
      for (let dip = 6; dip <= line * 0.8; dip += 6) {
        const p = at(t.y + t.h - dip);
        if (coverageAt(img, p, lastLine) > budget) break;
        best = p;
      }
      if (alive) setPlace(best);
    })();
    return () => { alive = false; };
  }, [s, fonts, brand]);
  return (
    <>
      <div style={{ position: "absolute", inset: -80 }}>
        <Img slot={s.bg} label="bg" style={{ filter: "blur(28px) brightness(.45) saturate(1.3)" }} />
      </div>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 75%, ${rgba(brand.colors.shade, 0)} 0%, ${rgba(brand.colors.shade, 0.55)} 75%)` }} />
      <div ref={textRef} style={{ position: "absolute", top: 76, left: brand.safe - 10, right: brand.safe - 10 }}>
        <Headline brand={brand} text={s.headline} scale={1.1} maxHeight={600} />
      </div>
      {place && (
        <img src={s.bg.cutout} alt="" crossOrigin="anonymous" style={{
          position: "absolute", left: place.x, top: place.y, width: place.w, height: place.h,
          filter: "drop-shadow(0 24px 50px rgba(0,0,0,.55))",
        }} />
      )}
      <Logo brand={brand} busy={["top"]} />
      {!place && <i data-pending hidden />}
    </>
  );
}

function HeroSticker({ s, brand }) {
  const st = s.sticker;
  const corner = st ? `${st.y < 50 ? "top" : "bottom"}-${st.x + st.width / 2 < 50 ? "left" : "right"}` : null;
  return (
    <>
      <Img slot={s.bg} label="bg" />
      <EdgeText brand={brand}>
        <Divider brand={brand} />
        <Headline brand={brand} text={s.headline} scale={0.94} />
      </EdgeText>
      {st?.src && (
        <img src={st.src} alt="" style={{
          position: "absolute", left: `${st.x}%`, top: `${st.y}%`, width: `${st.width}%`,
          transform: `rotate(${st.rotate || 0}deg)`, filter: "drop-shadow(0 18px 30px rgba(0,0,0,.45))",
        }} />
      )}
      <Logo brand={brand} busy={["bottom", corner].filter(Boolean)} />
    </>
  );
}

function HeroInset({ s, brand }) {
  return (
    <>
      <Img slot={s.bg} label="bg" />
      {s.inset && (
        <div style={{
          position: "absolute", top: -30, left: -40, width: W * 0.5, height: W * 0.5, borderRadius: "50%",
          overflow: "hidden", border: `10px solid ${brand.colors.text}`, boxShadow: "0 14px 40px rgba(0,0,0,.35)",
        }}><Img slot={s.inset} label="inset" /></div>
      )}
      {s.inset?.cutout && (
        <div style={{
          position: "absolute", top: -20, left: -30, width: W * 0.5 - 20, height: W * 0.5 - 20,
          clipPath: "inset(-10% -10% 52% -10%)", filter: "drop-shadow(0 6px 10px rgba(0,0,0,.35))",
        }}><Subject slot={s.inset} /></div>
      )}
      <Overlays items={s.overlays} brand={brand} />
      <EdgeText brand={brand}>
        <Divider brand={brand} />
        <Headline brand={brand} text={s.headline} scale={0.94} />
      </EdgeText>
      <Logo brand={brand} busy={["bottom", s.inset ? "top-left" : null].filter(Boolean)} />
    </>
  );
}

function HeroBand({ s, brand }) {
  const ref = useRef(null);
  const [bandH, setBandH] = useState(420);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBandH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: H - bandH }}>
        <Img slot={s.bg} label="bg" />
      </div>
      <div ref={ref} style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: brand.colors.accent, padding: `44px ${brand.safe}px 60px` }}>
        <div style={{ fontFamily: fam(brand.fonts.body), fontSize: 30, fontWeight: 800, color: brand.colors.onAccent, marginBottom: 14, opacity: 0.75 }}>{brand.name}</div>
        <Headline brand={brand} text={s.headline} color={brand.colors.onAccent} align="left" scale={0.85} maxHeight={420} />
      </div>
      <Logo brand={brand} busy={["bottom"]} />
    </>
  );
}

function HeroDuo({ s, brand }) {
  return (
    <>
      <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <Img slot={s.inset || s.bg} label="left" />
        <Img slot={s.bg} label="right" />
      </div>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: W / 2 - 5, width: 10, background: brand.colors.accent }} />
      <EdgeText brand={brand}>
        <Headline brand={brand} text={s.headline} scale={0.94} />
      </EdgeText>
      <Logo brand={brand} busy={["bottom", "top-center"]} />
    </>
  );
}

function HeroPolaroid({ s, brand }) {
  return (
    <>
      <Img slot={s.bg} label="bg" />
      <EdgeText brand={brand} edge="top" fade={320} padding={`70px ${brand.safe + 6}px 0`}>
        <Headline brand={brand} text={s.headline} align="left" scale={0.9} maxHeight={460} />
      </EdgeText>
      {s.inset && (
        <div style={{
          position: "absolute", right: 60, bottom: 70, width: 420, background: "#fff", padding: "18px 18px 70px",
          transform: "rotate(5deg)", boxShadow: "0 20px 50px rgba(0,0,0,.45)",
        }}>
          <div style={{ width: "100%", height: 420 }}><Img slot={s.inset} label="inset" /></div>
          <div style={{ position: "absolute", bottom: 14, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
            <Mark brand={brand} height={40} color="#111" />
          </div>
        </div>
      )}
      <Overlays items={s.overlays} brand={brand} />
      <Logo brand={brand} busy={["top", s.inset ? "bottom-right" : null].filter(Boolean)} />
    </>
  );
}

const HEROES = { depth: HeroDepth, sticker: HeroSticker, inset: HeroInset, band: HeroBand, duo: HeroDuo, polaroid: HeroPolaroid };

function Cover({ s, brand }) {
  const V = HEROES[s.variant] || HeroDepth;
  return <V s={s} brand={brand} />;
}

// ---------- Body ----------
/* bg.fit: "cover" (default) fills the frame.
   "above" fits the photo into the space above the text instead, so landscape
   photos with the subject low in the frame don't end up under the copy.
   The sourcer sets "above" for landscape images. */
function Body({ s, brand }) {
  const d = brand.fonts.display, b = brand.fonts.body, t = brand.type;
  const [textH, setTextH] = useState(420);
  const above = s.bg?.fit === "above";
  return (
    <>
      {above ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: H - textH + (s.bg.overlap ?? 60) }}>
          <Img slot={s.bg} label="bg" />
        </div>
      ) : (
        <Img slot={s.bg} label="bg" />
      )}
      <Overlays items={s.overlays} brand={brand} />
      <EdgeText brand={brand} padding={`0 ${brand.safe + 16}px 70px`} onHeight={setTextH} fade={above ? 170 : 380}>
        <div style={{ textAlign: "center", color: brand.colors.text }}>
          <FitText singleLine max={t.title.max} lineMin={t.title.min} min={Math.round(t.title.min * 0.9)} maxHeight={240} style={{
            fontFamily: fam(d), fontWeight: d.weight, letterSpacing: d.tracking,
            textTransform: d.uppercase ? "uppercase" : "none", lineHeight: 1, marginBottom: 22,
          }}>{tieLast(s.title)}</FitText>
          <FitText max={t.body.max} min={t.body.min} maxHeight={220} wrap="pretty" style={{
            fontFamily: fam(b), fontWeight: b.weight, lineHeight: b.lineHeight,
          }}>
            <Rich text={s.body} brand={brand} />
          </FitText>
        </div>
      </EdgeText>
      <Logo brand={brand} busy={["bottom"]} where="body" />
    </>
  );
}

const LAYOUTS = { cover: Cover, body: Body };

// ---------- The slide (what Puppeteer screenshots) ----------
export function Slide({ slide, brand, index }) {
  const b = resolveBrand(brand);
  const L = LAYOUTS[slide.layout] || Body;
  return (
    <div data-slide={index} style={{ position: "relative", width: W, height: H, overflow: "hidden", background: b.colors.shade }}>
      <L s={slide} brand={b} />
    </div>
  );
}


// ---------- Fonts ----------
/* A font entry can be a Google font ({ family }) or a self-hosted file
   ({ family, url }) uploaded per page. This emits whatever both need. */
export function BrandFonts({ brand }) {
  const b = resolveBrand(brand);
  const list = [
    { ...b.fonts.display, weights: [b.fonts.display.weight] },
    { ...b.fonts.body, weights: [b.fonts.body.weight, b.fonts.body.highlightWeight] },
  ];
  const google = list.filter((f) => !f.url);
  const hosted = list.filter((f) => f.url);
  const href = google.length
    ? "https://fonts.googleapis.com/css2?" +
      google.map((f) => `family=${encodeURIComponent(f.family).replace(/%20/g, "+")}:wght@${[...new Set(f.weights)].sort().join(";")}`).join("&") +
      "&display=block"
    : null;
  const css = hosted.map((f) => `@font-face{font-family:'${f.family}';src:url('${f.url}');font-display:block;}`).join("");
  return (
    <>
      {href && <link rel="stylesheet" href={href} />}
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
    </>
  );
}

// ---------- Scaled preview ----------
export function Thumb({ slide, brand, index, scale = 0.25, caption }) {
  return (
    <figure className="thumb">
      <div style={{ width: W * scale, height: H * scale, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
          <Slide slide={slide} brand={brand} index={index} />
        </div>
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
