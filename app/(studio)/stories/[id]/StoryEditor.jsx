"use client";
import { useState } from "react";
import { api, upload } from "@/lib/client";
import { useAutosave } from "@/lib/useAutosave";
import { setPath } from "@/lib/carousel/setPath";
import { HERO_VARIANTS, Thumb, BrandFonts } from "@/lib/carousel/template";
import { BLOCKED } from "@/lib/preview";
import Step, { More, Field } from "../../Step";

/* Six cover layouts, described the way you'd describe them to someone else.
   "depth" is the default because it's the one that looks best once cutouts run. */
const STYLES = {
  depth: "Subject in front — the photo's main subject sits over the headline",
  sticker: "Sticker — subject with a white outline, stuck in the corner",
  inset: "Circle — one big photo plus a round one in the corner",
  band: "Colour bar — headline sits in a solid bar across the bottom",
  duo: "Side by side — two photos split down the middle",
  polaroid: "Framed photo — a tilted print with the headline above",
};

const STATUSES = ["draft", "ready", "rendered", "approved", "posted", "rejected"];

// "This photo" — one image slot: paste a link or upload a file.
function ImageInput({ label, hint, value, folder, onChange, onBlocked }) {
  const [busy, setBusy] = useState(false);
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (onBlocked) { e.target.value = ""; return onBlocked(BLOCKED.upload); }
    setBusy(true);
    try { onChange(await upload(f, folder)); } finally { setBusy(false); }
  };
  return (
    <Field label={label} hint={hint}>
      <input value={value || ""} placeholder="Paste an image link…" onChange={(e) => onChange(e.target.value)} />
      <input type="file" accept="image/*" onChange={onFile} disabled={busy} />
    </Field>
  );
}

// Backup photos the sourcer kept — click one to swap it in.
function Alternates({ slot, onPick }) {
  if (!slot?.alternates?.length) return null;
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="note">Other options:</span>
      {slot.alternates.map((a) => (
        <button key={a.src} className="alt" title={a.credit || "Swap this photo in"} onClick={() => onPick(a)}>
          <img src={a.src} alt="" />
        </button>
      ))}
    </div>
  );
}

function swapped(slot, alt) {
  const { cutout, cutoutBox, ...rest } = slot; // an old cutout won't line up with a new photo
  const others = (slot.alternates || []).filter((a) => a.src !== alt.src);
  const current = slot.src ? [{ src: slot.src, credit: slot.credit || "", page: slot.page || "" }] : [];
  return { ...rest, src: alt.src, credit: alt.credit || "", page: alt.page || "", alternates: [...current, ...others] };
}

function SlideForm({ slide, i, storyId, onChange, onBlocked }) {
  const [raw, setRaw] = useState(null);
  const set = (path, v) => onChange(setPath(slide, path, v));
  const folder = `images/${storyId}`;
  const n = i + 1;
  return (
    <div className="slidebox">
      <strong>{i === 0 ? "Cover slide" : `Slide ${n}`}</strong>
      {slide.layout === "cover" ? (
        <>
          <Field label="The big headline" hint="Keep it short — this is the largest text on the slide.">
            <textarea style={{ fontFamily: "inherit", fontSize: 15, minHeight: 70 }} value={slide.headline || ""} onChange={(e) => set("headline", e.target.value)} />
          </Field>
          <ImageInput label="Main photo" hint="The picture behind the headline." value={slide.bg?.src} folder={folder} onBlocked={onBlocked} onChange={(v) => set("bg.src", v)} />
          <Alternates slot={slide.bg} onPick={(a) => set("bg", swapped(slide.bg, a))} />
          <ImageInput label="Second photo" hint="Used by some cover layouts, like Circle and Framed photo." value={slide.inset?.src} folder={folder} onBlocked={onBlocked} onChange={(v) => set("inset.src", v)} />
          <Alternates slot={slide.inset} onPick={(a) => set("inset", swapped(slide.inset, a))} />
          <More title="Advanced: cutout and sticker">
            <ImageInput label="Cutout photo (filled in automatically)" value={slide.bg?.cutout} folder={folder} onBlocked={onBlocked} onChange={(v) => set("bg.cutout", v)} />
            <ImageInput label="Sticker image" value={slide.sticker?.src} folder={folder} onBlocked={onBlocked} onChange={(v) => set("sticker.src", v)} />
          </More>
        </>
      ) : (
        <>
          <Field label="Title" hint="Two to five words works best.">
            <input value={slide.title || ""} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="Body text" hint="Wrap a few words in [[double brackets]] to colour them in.">
            <textarea style={{ fontFamily: "inherit", fontSize: 15 }} value={slide.body || ""} onChange={(e) => set("body", e.target.value)} />
          </Field>
          <ImageInput label="Photo for this slide" value={slide.bg?.src} folder={folder} onBlocked={onBlocked} onChange={(v) => set("bg.src", v)} />
          <Alternates slot={slide.bg} onPick={(a) => set("bg", swapped(slide.bg, a))} />
        </>
      )}
      <Field label="Photo position" hint="Drag if the subject is cut off. This moves the visible part of the photo.">
        <div className="grid2">
          <input type="range" min={0} max={100} value={slide.bg?.focal?.[0] ?? 50} onChange={(e) => set("bg.focal", [+e.target.value, slide.bg?.focal?.[1] ?? 50])} />
          <input type="range" min={0} max={100} value={slide.bg?.focal?.[1] ?? 50} onChange={(e) => set("bg.focal", [slide.bg?.focal?.[0] ?? 50, +e.target.value])} />
        </div>
      </Field>
      {raw === null ? (
        <button className="btn" onClick={() => setRaw(JSON.stringify(slide, null, 2))}>Advanced: edit as JSON</button>
      ) : (
        <>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} style={{ minHeight: 220 }} />
          <div className="row">
            <button className="btn" onClick={() => { try { onChange(JSON.parse(raw)); setRaw(null); } catch { alert("That JSON doesn't parse — check commas and quotes."); } }}>Apply JSON</button>
            <button className="btn" onClick={() => setRaw(null)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

export default function StoryEditor({ story: initial, pages, preview = false }) {
  const [story, setStory] = useState(initial);
  const [renders, setRenders] = useState(initial.renders || []);
  const [allHeroes, setAllHeroes] = useState(false);
  const [state, setState] = useState({ busy: "", msg: "", err: "" });
  const page = pages.find((p) => p.id === story.page_id);
  const brand = page?.brand || {};
  const set = (k, v) => setStory((s) => ({ ...s, [k]: v }));
  const setSlide = (i, slide) => setStory((s) => ({ ...s, slides: s.slides.map((x, j) => (j === i ? slide : x)) }));

  // Preview mode: no database, so writes stop here with a message
  const blocked = preview ? (err) => setState({ busy: "", msg: "", err }) : null;

  const persist = async () => {
    const { title, status: storyStatus, hero_variant, slides, page_id } = story;
    await api(`/api/stories/${story.id}`, { method: "PUT", body: { title, status: storyStatus, hero_variant, slides, page_id } });
  };
  const { status: saved, saveNow } = useAutosave(persist, {
    title: story.title, status: story.status, hero_variant: story.hero_variant,
    slides: story.slides, page_id: story.page_id,
  }, { enabled: !preview });

  const save = async () => {
    if (blocked) return blocked(BLOCKED.save);
    setState({ busy: "Saving…", msg: "", err: "" });
    try { await saveNow(); setState({ busy: "", msg: "Saved", err: "" }); }
    catch (e) { setState({ busy: "", msg: "", err: e.message }); }
  };
  const act = async (label, fn) => {
    setState({ busy: label, msg: "", err: "" });
    try { const msg = await fn(); setState({ busy: "", msg: msg || "Done", err: "" }); }
    catch (e) { setState({ busy: "", msg: "", err: e.message }); }
  };
  const source = (overwrite) => blocked ? blocked(BLOCKED.source) : act("Finding photos… this takes about a minute", async () => {
    await saveNow();
    const r = await api(`/api/source/${story.id}`, { method: "POST", body: { overwrite } });
    if (r.message) return r.message;
    const fresh = await api(`/api/stories/${story.id}`);
    setStory((s) => ({ ...s, slides: fresh.slides, status: fresh.status }));
    const parts = [`Filled ${r.filled.length} of ${r.slots} slots from ${r.candidates} candidates (${r.kept} usable, ${r.distinct} different photo${r.distinct === 1 ? "" : "s"}).`];
    if (r.unfilled?.length) {
      parts.push(`${r.unfilled.length} slide${r.unfilled.length === 1 ? "" : "s"} couldn't be matched to a photo and kept what ${r.unfilled.length === 1 ? "it" : "they"} had.`);
    }
    if (r.shortfall) {
      parts.push(`Only ${r.kept} usable photos for ${r.slots} slides, so ${r.reused.length} slide${r.reused.length === 1 ? " repeats a" : "s repeat a"} photo. Add a source link or upload more images for a fully unique set.`);
    } else if (r.reused?.length) {
      parts.push(`${r.reused.length} slide${r.reused.length === 1 ? " repeats" : "s repeat"} a photo, cropped differently.`);
    }
    if (r.lowRes) parts.push("Some photos are below full resolution and may look soft when scaled up.");
    if (r.cost) parts.push(`Cost: ${r.cost.cents.toFixed(1)}¢.`);
    return parts.join(" ");
  });
  const writeCopy = (overwrite) => blocked ? blocked(BLOCKED.copy) : act("Writing the words… this takes about half a minute", async () => {
    await saveNow();
    const r = await api(`/api/copy/${story.id}`, { method: "POST", body: { overwrite } });
    if (r.message) return r.message;
    const fresh = await api(`/api/stories/${story.id}`);
    setStory((s) => ({ ...s, slides: fresh.slides }));
    return `Wrote text for ${r.written} slide${r.written === 1 ? "" : "s"}.` +
      (r.cost ? ` Cost: ${r.cost.cents.toFixed(1)}¢.` : "");
  });
  const render = (variants) => blocked ? blocked(BLOCKED.render) : act("Making the final images… this takes 10–30 seconds", async () => {
    await saveNow();
    const r = await api(`/api/render/${story.id}`, { method: "POST", body: { variants } });
    setRenders((old) => [...r.renders, ...old]);
    set("status", "rendered");
    return `Rendered ${r.renders.reduce((n, x) => n + x.files.length, 0)} slides`;
  });

  const addSlide = () => set("slides", [...story.slides, { layout: "body", title: "New slide", body: "", bg: { src: "", focal: [50, 40] } }]);
  const removeLast = () => story.slides.length > 1 && set("slides", story.slides.slice(0, -1));

  // Progress, so the sidebar shows where you are rather than a wall of inputs.
  const [cover, ...rest] = story.slides;
  const hasPhotos = story.slides.every((s) => s.bg?.src) && (!cover?.inset || !!cover.inset?.src);
  const hasWords = !!cover?.headline?.trim() && rest.every((s) => !!s.title?.trim());
  const hasRender = renders.length > 0;
  const steps = [
    { n: 1, title: "Give this story a name", done: !!story.title?.trim(), open: !story.title?.trim() },
    { n: 2, title: "Add the photos", done: hasPhotos, open: story.title?.trim() && !hasPhotos },
    { n: 3, title: "Write the words", done: hasWords, open: hasPhotos && !hasWords },
    { n: 4, title: "Make the final images", done: hasRender, open: hasWords && !hasRender },
  ];

  const heroes = allHeroes ? HERO_VARIANTS : [story.hero_variant];

  return (
    <div className="cols">
      <BrandFonts brand={brand} />
      <aside className="side">
        <Step {...steps[0]}>
          <Field label="Name (only you see this)" hint="Something like “Dancing Plague of 1518”.">
            <input value={story.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
        </Step>

        <Step {...steps[1]}>
          <p className="stephint">
            Easiest way: paste a link to a news article into step 4, then let it find photos. Or add your own by hand.
          </p>
          {story.slides.map((s, i) => <SlideForm key={i} slide={s} i={i} storyId={story.id} onBlocked={blocked} onChange={(x) => setSlide(i, x)} />)}
          <div className="row">
            <button className="btn" onClick={addSlide}>Add a slide</button>
            <button className="btn" onClick={removeLast} disabled={story.slides.length < 2}>Remove last slide</button>
          </div>
        </Step>

        <Step {...steps[2]}>
          <p className="stephint">Find photos first so the words get written about what's actually in them.</p>
          <div className="row">
            <button className="btn" onClick={() => source(false)} disabled={!!state.busy}>Find missing photos</button>
            <button className="btn" onClick={() => source(true)} disabled={!!state.busy}>Replace all photos</button>
          </div>
          <div className="row">
            <button className="btn" onClick={() => writeCopy(false)} disabled={!!state.busy}>Write missing words</button>
            <button className="btn" onClick={() => writeCopy(true)} disabled={!!state.busy}>Rewrite all words</button>
          </div>
          <More title="Advanced: source article and page">
            <Field label="Link to a news article" hint="Given one, it finds photos from that story instead of guessing.">
              <input value={story.source_url || ""} placeholder="https://…" onChange={(e) => set("source_url", e.target.value)} />
            </Field>
            <Field label="Which page">
              <select value={story.page_id} onChange={(e) => set("page_id", e.target.value)}>
                {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </More>
        </Step>

        <Step {...steps[3]}>
          <Field label="Cover style" hint={STYLES[story.hero_variant]}>
            <select value={story.hero_variant} onChange={(e) => set("hero_variant", e.target.value)}>
              {HERO_VARIANTS.map((v) => <option key={v} value={v}>{v} — {STYLES[v].split("—")[0].trim()}</option>)}
            </select>
          </Field>
          <div className="row">
            <button className="btn primary" onClick={() => render([story.hero_variant])} disabled={!!state.busy}>Make the images</button>
            <button className="btn" onClick={() => render(HERO_VARIANTS)} disabled={!!state.busy}>Try every cover style</button>
          </div>
          <More title="Advanced: status">
            <Field label="Status" hint="Where this story is in your process.">
              <select value={story.status} onChange={(e) => set("status", e.target.value)}>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
          </More>
        </Step>

        <div className="donebar">
          <div className="row">
            <button className="btn" onClick={save} disabled={!!state.busy}>Save now</button>
            <span className="note">
              {state.busy || state.msg ||
                (saved === "saving" ? "Saving…" :
                saved === "dirty" ? "Saving shortly…" :
                saved === "error" ? "" : "All changes saved")}
            </span>
          </div>
          {state.err && <p className="err">{state.err}</p>}
          {saved === "error" && !state.err && <p className="err">Couldn't save. Check the story still exists.</p>}
        </div>
      </aside>

      <main className="main">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
          <h1 style={{ margin: 0 }}>{story.title || "Untitled story"}</h1>
          <label className="check"><input type="checkbox" checked={allHeroes} onChange={(e) => setAllHeroes(e.target.checked)} />Compare all cover styles</label>
        </div>

        <h2>Preview</h2>
        <p className="note" style={{ marginTop: -4 }}>
          This is exactly what you'll get — same size, same layout, drawn live.
        </p>
        <div className="thumbs">
          {heroes.map((v) => <Thumb key={v} slide={{ ...cover, variant: v }} brand={brand} index={`hero-${v}`} scale={0.24} caption={allHeroes ? v : "Cover"} />)}
          {!allHeroes && rest.map((s, i) => <Thumb key={i} slide={s} brand={brand} index={i + 1} scale={0.24} caption={`Slide ${i + 2}`} />)}
        </div>

        <h2>Finished images</h2>
        {!hasRender && <p className="note">Nothing made yet. When you're happy with the preview, use “Make the images”.</p>}
        {renders.map((r) => (
          <div key={r.id} style={{ marginBottom: 24 }}>
            <p className="note">Cover style: {r.variant}, made {new Date(r.created_at).toLocaleString()}</p>
            <div className="thumbs renders" style={{ marginBottom: 0 }}>
              {r.files.map((f) => <a key={f.url} href={f.url} target="_blank" rel="noreferrer"><img src={f.url} alt={`Slide ${f.slide}`} /></a>)}
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}