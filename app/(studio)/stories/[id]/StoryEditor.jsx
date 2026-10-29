"use client";
import { useRef, useState } from "react";
import { api, runJob, upload } from "@/lib/client";
import { useAutosave } from "@/lib/useAutosave";
import { setPath } from "@/lib/carousel/setPath";
import { HERO_VARIANTS, Thumb, BrandFonts } from "@/lib/carousel/template";
import { BLOCKED } from "@/lib/preview";
import { More, Field } from "../../Controls";

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

/* Hostname only, for the collapsed summary line on the source-article group.
   Falls back to null on anything that isn't a parseable URL. */
const host = (u) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : null; } catch { return null; } };

// "This photo" — one image slot: paste a link or upload a file.
function ImageInput({ label, hint, value, folder, onChange, onBlocked }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    // Reset first, so re-picking the same file after a failure still fires onChange
    e.target.value = "";
    if (!f) return;
    if (onBlocked) return onBlocked(BLOCKED.upload);
    setBusy(true);
    setErr("");
    try {
      onChange(await upload(f, folder));
    } catch (er) {
      setErr(er.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field label={label} hint={hint}>
      <input value={value || ""} placeholder="Paste an image link…" onChange={(e) => onChange(e.target.value)} />
      <input type="file" accept="image/*" onChange={onFile} disabled={busy} />
      {busy && <span className="note">Uploading…</span>}
      {err && <span className="err">{err}</span>}
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

/* "Find a different photo" — searches again for this one slot and leaves every
   other slide alone. Costs a full sourcing run (search + downloads + vision),
   so the button says so up front and the result line reports what it spent. */
function RepickButton({ storyId, slotKey, saveNow, onDone, preview }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  if (preview) return null;
  const repick = async () => {
    setBusy(true);
    setMsg("");
    try {
      // Persist first: the search reads the story from the database, so unsaved
      // edits would be invisible to it and the photo could clash with text that
      // isn't there yet.
      await saveNow();
      const r = await api(`/api/source/${storyId}`, { method: "POST", body: { slots: [slotKey] } });
      if (r.message) { setMsg(r.message); return; }
      const picked = r.filled?.[0];
      if (r.unchanged?.includes(slotKey)) {
        setMsg("It picked the same photo again — there isn't another one that fits this slide.");
      } else {
        setMsg(`${picked?.why || "Swapped in a different photo."}${r.cost ? ` Cost: ${r.cost.cents.toFixed(1)}¢.` : ""}`);
      }
      onDone();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="repick">
      <button className="btn" onClick={repick} disabled={busy}>
        {busy ? "Finding another photo…" : "Find a different photo"}
      </button>
      <span className="hint">Searches again for this slide only. About a minute, and costs a few cents.</span>
      {msg && <span className="hint">{msg}</span>}
    </div>
  );
}

function SlideForm({ slide, i, storyId, onChange, onBlocked, preview, saveNow, refresh }) {
  const [raw, setRaw] = useState(null);
  const set = (path, v) => onChange(setPath(slide, path, v));
  const folder = `images/${storyId}`;
  const isCover = slide.layout === "cover";

  /* Discoverable-leaning: the fields people actually use sit at the top level
     with nothing hidden, and the rare ones (cutout, sticker, raw JSON) share
     one collapsed "Advanced" group at the bottom. */
  return (
    <div className="slideform">
      {isCover ? (
        <>
          <span className="label">Headline</span>
          <Field label="The big line on the cover">
            <textarea style={{ minHeight: 74 }} value={slide.headline || ""} onChange={(e) => set("headline", e.target.value)} />
          </Field>

          <span className="label">Photo</span>
          <ImageInput label="Main photo" value={slide.bg?.src} folder={folder} onBlocked={onBlocked} onChange={(v) => set("bg.src", v)} />
          <Alternates slot={slide.bg} onPick={(a) => set("bg", swapped(slide.bg, a))} />
          <RepickButton storyId={storyId} slotKey={`${i}.bg`} saveNow={saveNow} onDone={refresh} preview={preview} />
          <ImageInput label="Second photo" hint="Only the Circle and Framed photo styles use this." value={slide.inset?.src} folder={folder} onBlocked={onBlocked} onChange={(v) => set("inset.src", v)} />
          <Alternates slot={slide.inset} onPick={(a) => set("inset", swapped(slide.inset, a))} />
          {slide.inset?.src && <RepickButton storyId={storyId} slotKey={`${i}.inset`} saveNow={saveNow} onDone={refresh} preview={preview} />}
        </>
      ) : (
        <>
          <span className="label">Words</span>
          <Field label="Title">
            <input value={slide.title || ""} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="Body text" hint="Wrap a few words in [[double brackets]] to colour them in.">
            <textarea value={slide.body || ""} onChange={(e) => set("body", e.target.value)} />
          </Field>

          <span className="label">Photo</span>
          <ImageInput label="Photo for this slide" value={slide.bg?.src} folder={folder} onBlocked={onBlocked} onChange={(v) => set("bg.src", v)} />
          <Alternates slot={slide.bg} onPick={(a) => set("bg", swapped(slide.bg, a))} />
          <RepickButton storyId={storyId} slotKey={`${i}.bg`} saveNow={saveNow} onDone={refresh} preview={preview} />
        </>
      )}

      <span className="label">Position</span>
      <Field label="Photo position" hint="Drag if the subject is cut off. This moves the visible part of the photo.">
        <div className="grid2">
          <input type="range" min={0} max={100} value={slide.bg?.focal?.[0] ?? 50} onChange={(e) => set("bg.focal", [+e.target.value, slide.bg?.focal?.[1] ?? 50])} />
          <input type="range" min={0} max={100} value={slide.bg?.focal?.[1] ?? 50} onChange={(e) => set("bg.focal", [slide.bg?.focal?.[0] ?? 50, +e.target.value])} />
        </div>
      </Field>

      <More title="Advanced" value={isCover ? "Cutout, sticker, JSON" : "JSON"}>
        {isCover && (
          <>
            <ImageInput label="Cutout photo (filled in automatically)" value={slide.bg?.cutout} folder={folder} onBlocked={onBlocked} onChange={(v) => set("bg.cutout", v)} />
            <ImageInput label="Sticker image" value={slide.sticker?.src} folder={folder} onBlocked={onBlocked} onChange={(v) => set("sticker.src", v)} />
          </>
        )}
        {raw === null ? (
          <button className="btn ghost" onClick={() => setRaw(JSON.stringify(slide, null, 2))}>Edit this slide as JSON</button>
        ) : (
          <>
            <textarea value={raw} onChange={(e) => setRaw(e.target.value)} style={{ minHeight: 200 }} />
            <div className="row">
              <button className="btn" onClick={() => { try { onChange(JSON.parse(raw)); setRaw(null); } catch { alert("That JSON doesn't parse — check commas and quotes."); } }}>Apply JSON</button>
              <button className="btn ghost" onClick={() => setRaw(null)}>Cancel</button>
            </div>
          </>
        )}
      </More>
    </div>
  );
}

export default function StoryEditor({ story: initial, pages, preview = false }) {
  const [story, setStory] = useState(initial);
  const [renders, setRenders] = useState(initial.renders || []);
  const [allHeroes, setAllHeroes] = useState(false);
  const [selected, setSelected] = useState(0);
  const [state, setState] = useState({ busy: "", msg: "", err: "" });
  const menuRef = useRef(null);

  /* A menu item that starts a long job closes the menu first, so the progress
     message isn't hidden behind the dropdown the user just clicked. */
  const closeMenu = (fn) => {
    if (menuRef.current) menuRef.current.open = false;
    fn();
  };
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
    const r = await runJob(`/api/source/${story.id}`, story.id, { overwrite });
    if (r.message) return r.message;
    await refresh();
    const parts = [`Filled ${r.filled.length} of ${r.slots} slots from ${r.candidates} candidates (${r.kept} usable, ${r.distinct} different photo${r.distinct === 1 ? "" : "s"}).`];
    if (r.unfilled?.length) {
      parts.push(`${r.unfilled.length} slide${r.unfilled.length === 1 ? "" : "s"} left empty — the web doesn't have enough DIFFERENT pictures for this story. Add a source link, upload images, or pick a different topic.`);
    }
    if (r.lowRes) parts.push("Some photos are below full resolution and may look soft when scaled up.");
    if (r.cost) parts.push(`Cost: ${r.cost.cents.toFixed(1)}¢.`);
    return parts.join(" ");
  });
  const writeCopy = (overwrite) => blocked ? blocked(BLOCKED.copy) : act("Writing the words… this takes about half a minute", async () => {
    await saveNow();
    const r = await api(`/api/copy/${story.id}`, { method: "POST", body: { overwrite } });
    if (r.message) return r.message;
    await refresh();
    return `Wrote text for ${r.written} slide${r.written === 1 ? "" : "s"}.` +
      (r.cost ? ` Cost: ${r.cost.cents.toFixed(1)}¢.` : "");
  });
  const render = (variants) => blocked ? blocked(BLOCKED.render) : act("Making the final images… this takes 10–30 seconds", async () => {
    await saveNow();
    const r = await runJob(`/api/render/${story.id}`, story.id, { variants });
    setRenders((old) => [...r.renders, ...old]);
    set("status", "rendered");
    return `Rendered ${r.renders.reduce((n, x) => n + x.files.length, 0)} slides`;
  });

  const addSlide = () => {
    set("slides", [...story.slides, { layout: "body", title: "New slide", body: "", bg: { src: "", focal: [50, 40] } }]);
    setSelected(story.slides.length);
  };
  const removeLast = () => {
    if (story.slides.length < 2) return;
    set("slides", story.slides.slice(0, -1));
    // Drop the selection if it was pointing at the slide that just went.
    setSelected((i) => Math.min(i, story.slides.length - 2));
  };

  // Pull the story back from the database. Sourcing and copy both rewrite the
  // slides server-side, so the editor's local copy is stale the moment they
  // finish. Status is left alone — those routes no longer touch it.
  const refresh = async () => {
    const fresh = await api(`/api/stories/${story.id}`);
    setStory((s) => ({ ...s, slides: fresh.slides, source_url: fresh.source_url }));
    return fresh;
  };

  const [cover, ...rest] = story.slides;
  const hasRender = renders.length > 0;
  const current = story.slides[selected] || cover;
  const photoCount = story.slides.filter((s) => s.bg?.src).length;
  const hasWords = !!cover?.headline?.trim() && rest.every((s) => !!s.title?.trim());
  const progress = [
    `${photoCount} of ${story.slides.length} photos`,
    hasWords ? "words written" : "no words yet",
    hasRender ? "images made" : "not rendered",
  ].join(" · ");

  const savedText = state.busy || state.msg ||
    (saved === "saving" ? "Saving…" :
    saved === "dirty" ? "Saving shortly…" :
    saved === "error" ? "" : "All changes saved");

  // The batch tag rides along on every slide caption, so a screenshot of one
  // slide still says which generation run it came from.
  const batchTag = story.batch ? ` · ${story.batch}` : "";

  /* The canvas either shows the selected slide or, with "compare" ticked, all
     six cover variants — the two views answer different questions, so they
     can't share the same grid. */
  const stage = allHeroes
    ? <div className="stage-grid">
        {HERO_VARIANTS.map((v) => (
          <Thumb key={v} slide={{ ...cover, variant: v }} brand={brand} index={`hero-${v}`} scale={0.3} caption={v} />
        ))}
      </div>
    : <div className="stage">
        <Thumb
          slide={selected === 0 ? { ...current, variant: story.hero_variant } : current}
          brand={brand}
          index={`stage-${selected}`}
          scale={0.48}
          caption={selected === 0 ? `Cover${batchTag}` : `Slide ${selected + 1}${batchTag}`}
        />
      </div>;

  return (
    <div className="editor">
      <BrandFonts brand={brand} />

      <nav className="rail" aria-label="Slides">
        <span className="label">Slides</span>
        <div className="rail-list">
          {story.slides.map((s, i) => (
            <button
              key={i}
              className={`rail-item${i === selected ? " on" : ""}`}
              aria-current={i === selected}
              onClick={() => setSelected(i)}
            >
              <span className="rail-num">{i + 1}</span>
              <span className="rail-thumb">{s.bg?.src && <img src={s.bg.src} alt="" />}</span>
            </button>
          ))}
        </div>
        <div className="rail-foot">
          <button className="btn" onClick={addSlide}>Add a slide</button>
          <button className="btn ghost" onClick={removeLast} disabled={story.slides.length < 2}>Remove last</button>
        </div>
      </nav>

      <main className="canvas">
        <div className="canvas-head">
          <h1 className="display">{story.title || "Untitled story"}</h1>
          {story.batch && <span className="pill" title="Which generation run made this">{story.batch}</span>}
          <label className="check">
            <input type="checkbox" checked={allHeroes} onChange={(e) => setAllHeroes(e.target.checked)} />
            Compare all cover styles
          </label>
        </div>
        <p className="meta">{progress}</p>

        <div className="toolbar">
          <button className="btn primary" onClick={() => render([story.hero_variant])} disabled={!!state.busy}>
            {state.busy ? state.busy : "Make the images"}
          </button>
          <button className="btn" onClick={() => source(false)} disabled={!!state.busy}>Find photos</button>
          <button className="btn" onClick={() => writeCopy(false)} disabled={!!state.busy}>Write words</button>
          <details className="menu" ref={menuRef}>
            <summary className="btn ghost">More</summary>
            <div className="menu-body">
              <button className="btn ghost" onClick={() => closeMenu(() => source(true))} disabled={!!state.busy}>Replace all photos</button>
              <button className="btn ghost" onClick={() => closeMenu(() => writeCopy(true))} disabled={!!state.busy}>Rewrite all words</button>
              <button className="btn ghost" onClick={() => closeMenu(() => render(HERO_VARIANTS))} disabled={!!state.busy}>Try every cover style</button>
            </div>
          </details>
        </div>
        {state.msg && <p className="note">{state.msg}</p>}
        {state.err && <p className="err">{state.err}</p>}
        {saved === "error" && !state.err && <p className="err">Couldn't save. Check the story still exists.</p>}

        {stage}

        {!allHeroes && (
          <>
            <h2>All slides</h2>
            <div className="filmstrip">
              {story.slides.map((s, i) => (
                <button key={i} className={i === selected ? "on" : ""} onClick={() => setSelected(i)}>
                  <Thumb
                    slide={i === 0 ? { ...s, variant: story.hero_variant } : s}
                    brand={brand}
                    index={`strip-${i}`}
                    scale={0.15}
                    caption={i === 0 ? `Cover${batchTag}` : `Slide ${i + 1}${batchTag}`}
                  />
                </button>
              ))}
            </div>
          </>
        )}

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

      <aside className="inspector">
        <div className="inspector-head">
          <Field label="Story name (only you see this)">
            <input value={story.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <div className="row">
            <button className="btn ghost" onClick={save} disabled={!!state.busy}>Save now</button>
            <span className="note">{savedText}</span>
          </div>
          <More title="Page and status" value={`${page?.name || "No page"} · ${story.status}`}>
            <Field label="Which page">
              <select value={story.page_id} onChange={(e) => set("page_id", e.target.value)}>
                {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select value={story.status} onChange={(e) => set("status", e.target.value)}>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
          </More>
          <More title="Cover style" value={STYLES[story.hero_variant].split("—")[0].trim()}>
            <Field label="Style" hint={STYLES[story.hero_variant]}>
              <select value={story.hero_variant} onChange={(e) => set("hero_variant", e.target.value)}>
                {HERO_VARIANTS.map((v) => <option key={v} value={v}>{v} — {STYLES[v].split("—")[0].trim()}</option>)}
              </select>
            </Field>
          </More>
          <More title="Source article" value={host(story.source_url)}>
            <Field label="Link to a news article" hint="Given one, it finds photos from that story instead of guessing.">
              <input value={story.source_url || ""} placeholder="https://…" onChange={(e) => set("source_url", e.target.value)} />
            </Field>
          </More>
        </div>

        <div className="inspector-body">
          <div className="inspector-title">
            {current?.layout === "cover" ? "Cover slide" : `Slide ${selected + 1}`}
          </div>
          {current && (
            <SlideForm
              key={selected}
              slide={current}
              i={selected}
              storyId={story.id}
              onBlocked={blocked}
              onChange={(x) => setSlide(selected, x)}
              preview={preview}
              saveNow={saveNow}
              refresh={refresh}
            />
          )}
        </div>
      </aside>
    </div>
  );
}