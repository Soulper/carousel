"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, runJob } from "@/lib/client";
import { Thumb, BrandFonts, W, H } from "@/lib/carousel/template";

/* Review queue: stories that have been sourced (or are being worked on) but not
   yet approved or rejected. Each card says what's still missing, so you can
   tell at a glance whether it needs images, a render, or just a yes/no. */

function checks(story) {
  const slots = [];
  story.slides.forEach((s) => {
    slots.push(s.bg);
    if (s.layout === "cover" && s.inset) slots.push(s.inset);
  });
  const withImg = slots.filter((x) => x?.src).length;
  const cover = story.slides[0];
  const needsCutout = story.hero_variant === "depth" || story.hero_variant === "sticker";
  const cutoutReady = story.hero_variant === "sticker" ? !!cover?.sticker?.src : !!cover?.bg?.cutout;
  const latest = story.renders?.[0];
  return {
    images: `${withImg}/${slots.length}`,
    slots: slots.length,
    allImages: withImg === slots.length && slots.length > 0,
    cutout: needsCutout ? (cutoutReady ? "ready" : "pending") : "not needed",
    lowRes: !!story.source_meta?.lowRes,
    latest,
    stage: !withImg || withImg < slots.length ? "images" : story.status === "rendered" && latest ? "approval" : "render",
  };
}

const TABS = [
  ["all", "Everything"],
  ["images", "Needs photos"],
  ["render", "Ready to make"],
  ["approval", "Waiting on you"],
];

const ago = (iso) => {
  if (!iso) return null;
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };

/* Each Thumb mounts a real Slide: fonts, text fitting, and for depth covers a
   canvas pass over the cutout. Mounting every card's worth of them at once is
   the expensive part of this page, so hold the full-size slide back until its
   box is near the viewport. */
function LazyThumb({ slide, brand, index, scale, caption }) {
  const box = useRef(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setNear(true),
      { rootMargin: "600px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return (
    <figure className="thumb" ref={box}>
      {near
        ? <Thumb slide={slide} brand={brand} index={index} scale={scale} />
        : <div style={{ width: W * scale, height: H * scale, borderRadius: 4, background: "var(--raised)" }} />}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function Card({ story, preview, onChange, labels = {} }) {
  const c = checks(story);
  const say = (s) => labels[s] || s;
  /* Exactly one primary action per card, and it changes with the stage: render
     when the photos are in and nothing has been made yet, approve once there
     are finished images. The two conditions can't both hold. */
  const canRender = c.allImages && !c.latest;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const brand = story.pages?.brand || {};
  const cover = { ...story.slides[0], variant: story.hero_variant };

  const act = async (label, fn) => {
    if (preview) { setErr("Connect Supabase to approve, reject or render."); return; }
    setBusy(label); setErr("");
    try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const setStatus = (status) => act(status === "approved" ? "Approving…" : "Rejecting…", async () => {
    await api(`/api/stories/${story.id}`, { method: "PUT", body: { status } });
    onChange(story.id, null); // leaves the queue
  });
  const render = () => act("Making the images…", async () => {
    const r = await runJob(`/api/render/${story.id}`, story.id, { variants: [story.hero_variant] });
    onChange(story.id, { ...story, status: "rendered", renders: [...r.renders, ...(story.renders || [])] });
  });

  return (
    <article className="qcard">
      <div className="qcover">
        {c.latest
          ? <img src={c.latest.files.find((f) => f.slide === 1)?.url || c.latest.files[0]?.url} alt="Rendered cover" />
          : <LazyThumb slide={cover} brand={brand} index={`q-${story.id}`} scale={0.2} />}
      </div>
      <div className="qbody">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">{story.pages?.name}</span>
          <span className={`pill ${story.status}`}>{say(story.status)}</span>
        </div>
        <h2 className="qtitle">
          <Link href={`/stories/${story.id}`}>{story.slides[0]?.headline || story.title}</Link>
        </h2>
        <ul className="qmeta">
          <li className={c.allImages ? "ok" : "todo"}>
            {c.allImages ? `All ${c.slots} photos added` : `Photos ${c.images} of ${c.slots}`}
            {c.lowRes ? " · some below full resolution" : ""}
            {story.sourced_at ? ` · found ${ago(story.sourced_at)}` : ""}
            {domain(story.source_url) && <> from <a href={story.source_url} target="_blank" rel="noreferrer">{domain(story.source_url)}</a></>}
          </li>
          {/* Only relevant for the two cover styles that use a cutout — a
              permanent "not needed" row was noise on most cards. */}
          {c.cutout !== "not needed" && (
            <li className={c.cutout === "pending" ? "todo" : "ok"}>Backgrounds removed: {c.cutout}</li>
          )}
          <li className={c.latest ? "ok" : "todo"}>{c.latest ? `Images made ${ago(c.latest.created_at)}` : "Images not made yet"}</li>
        </ul>
        <div className="qactions">
          {canRender ? (
            <button className="btn primary" onClick={render} disabled={!!busy}>Make the images</button>
          ) : c.latest ? (
            <button className="btn primary" onClick={() => setStatus("approved")} disabled={!!busy}>Approve</button>
          ) : (
            /* No photos yet. A disabled "Make the images" here was a dead end,
               so the primary is the action that actually unblocks the card. */
            <Link className="btn primary" href={`/stories/${story.id}`}>Add the photos</Link>
          )}
          <button className="btn danger" onClick={() => setStatus("rejected")} disabled={!!busy}>Reject</button>
          <button className="btn ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Hide slides" : "See all slides"}</button>
        </div>
        {busy && <p className="note">{busy}</p>}
        {err && <p className="err">{err}</p>}
      </div>
      {open && (
        <div className="qslides">
          {c.latest
            ? c.latest.files.map((f) => <a key={f.url} href={f.url} target="_blank" rel="noreferrer"><img src={f.url} alt={`Slide ${f.slide}`} /></a>)
            : story.slides.map((s, i) => (
                <LazyThumb key={i} slide={i === 0 ? cover : s} brand={brand} index={`q-${story.id}-${i}`} scale={0.14} />
              ))}
        </div>
      )}
    </article>
  );
}

export default function Queue({ initial, preview = false, labels = {} }) {
  const [stories, setStories] = useState(initial);
  const [tab, setTab] = useState("all");
  const counts = useMemo(() => {
    const n = { all: stories.length, images: 0, render: 0, approval: 0 };
    stories.forEach((s) => n[checks(s).stage]++);
    return n;
  }, [stories]);
  const shown = tab === "all" ? stories : stories.filter((s) => checks(s).stage === tab);
  const onChange = (id, next) => setStories((list) => (next ? list.map((s) => (s.id === id ? next : s)) : list.filter((s) => s.id !== id)));
  const brands = [...new Map(stories.map((s) => [s.pages?.id, s.pages?.brand || {}])).values()];

  return (
    <div className="wrap" style={{ maxWidth: 1400 }}>
      {brands.map((b, i) => <BrandFonts key={i} brand={b} />)}
      <h1>Review queue</h1>
      {preview && <p className="note">Preview mode: showing the sample story. Connect Supabase to see real stories.</p>}
      <div className="tabs" role="tablist" style={{ marginBottom: 18 }}>
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label} <span className="count">{counts[k]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="note">Nothing here. New stories from the pipeline land in this queue once they're created.</p>}
      <div className="qgrid">
        {shown.map((s) => <Card key={s.id} story={s} preview={preview} onChange={onChange} labels={labels} />)}
      </div>
    </div>
  );
}
