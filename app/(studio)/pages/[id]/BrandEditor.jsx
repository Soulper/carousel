"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, runJob, upload } from "@/lib/client";
import { useAutosave } from "@/lib/useAutosave";
import { setPath } from "@/lib/carousel/setPath";
import { blankSlides } from "@/lib/carousel/blank";
import { resolveBrand, HERO_VARIANTS, Thumb, BrandFonts } from "@/lib/carousel/template";
import { BLOCKED } from "@/lib/preview";
import { Panel, More, Field } from "../../Controls";

const FONTS_DISPLAY = ["Anton", "Bebas Neue", "Oswald", "Archivo Black", "Bricolage Grotesque", "Big Shoulders Display"];
const FONTS_BODY = ["Inter Tight", "DM Sans", "Manrope", "Archivo", "Space Grotesk"];
const POSITIONS = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

function FontPicker({ label, path, value, options, pageId, onChange, onBlocked }) {
  const custom = !!value.url;
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (onBlocked) { e.target.value = ""; return onBlocked(BLOCKED.upload); }
    const url = await upload(f, `fonts/${pageId}`);
    const family = f.name.replace(/\.(woff2?|ttf|otf)$/i, "").replace(/[-_]+/g, " ");
    onChange(`${path}`, { ...value, family, url });
  };
  return (
    <>
      <Field label={label}>
        <select value={custom ? "__custom" : value.family}
          onChange={(e) => e.target.value !== "__custom" && onChange(path, { ...value, family: e.target.value, url: undefined })}>
          {options.map((f) => <option key={f}>{f}</option>)}
          {custom && <option value="__custom">{value.family} (uploaded)</option>}
        </select>
      </Field>
      <Field label="…or upload your own font file">
        <input type="file" accept=".woff2,.woff,.ttf,.otf" onChange={onFile} />
      </Field>
    </>
  );
}

export default function BrandEditor({ page, previewStoryId, previewSlides, preview = false }) {
  const [name, setName] = useState(page.name);
  const [handle, setHandle] = useState(page.handle || "");
  const [brand, setBrand] = useState(() => resolveBrand(page.brand));
  const [state, setState] = useState({ saving: false, msg: "", err: "" });
  const [renders, setRenders] = useState([]);
  const [shot, setShot] = useState({ busy: "", err: "" });
  const router = useRouter();
  const set = (path, value) => setBrand((b) => setPath(b, path, value));

  // Preview mode: no database, so writes stop here with a message
  const blocked = preview ? (err) => setState({ saving: false, msg: "", err }) : null;

  // Everything on this form is the page row, so it saves itself a moment after
  // you stop changing it.
  const persist = async () => {
    await api(`/api/pages/${page.id}`, { method: "PUT", body: { name, handle, brand } });
  };
  const { status, saveNow } = useAutosave(persist, { name, handle, brand }, { enabled: !preview });

  const save = async () => {
    if (blocked) return blocked(BLOCKED.save);
    setState({ saving: true, msg: "", err: "" });
    try {
      await saveNow();
      setState({ saving: false, msg: "Saved", err: "" });
    } catch (e) { setState({ saving: false, msg: "", err: e.message }); }
  };

  /* The thumbnails are drawn live in the browser, so they're a preview and not
     a deliverable. This renders the page's latest story for real, which is the
     only way to get finished JPGs out of the brand editor. */
  const render = async () => {
    if (preview) return setShot({ busy: "", err: BLOCKED.render });
    setShot({ busy: "Making the images… this takes 10–30 seconds", err: "" });
    try {
      const r = await runJob(`/api/render/${previewStoryId}`, previewStoryId, {});
      setRenders(r.renders);
      setShot({ busy: "", err: "" });
    } catch (e) { setShot({ busy: "", err: e.message }); }
  };

  // A brand can't be rendered on its own, so offer the missing first step here
  // rather than sending the user back to the dashboard to hunt for it.
  const makeStory = async () => {
    setShot({ busy: "Creating a story…", err: "" });
    try {
      const s = await api("/api/stories", { method: "POST", body: { page_id: page.id, title: `${name} — new story`, slides: blankSlides() } });
      router.push(`/stories/${s.id}`);
    } catch (e) { setShot({ busy: "", err: e.message }); }
  };

  const onLogo = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (blocked) { e.target.value = ""; return blocked(BLOCKED.upload); }
    try { set("logo.src", await upload(f, `logos/${page.id}`)); } catch (er) { setState((s) => ({ ...s, err: er.message })); }
  };

  // The logo either has a file or falls back to a coloured letter, which is
  // how the form knows to show one control and hide the other.
  const hasLogo = !!brand.logo.src;
  const [cover, ...rest] = previewSlides;

  return (
    <div className="cols">
      <BrandFonts brand={brand} />
      <aside className="side">
        <Panel label="Page">
          <Field label="Page name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Instagram handle">
            <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@yourpage" />
          </Field>
        </Panel>

        <Panel label="Logo">
          <Field label="Logo file">
            <input type="file" accept="image/*" onChange={onLogo} />
          </Field>
          {hasLogo && (
            <div className="row">
              <img src={brand.logo.src} alt="" style={{ height: 44, background: "#2a2f39", borderRadius: 6, padding: 4 }} />
              <button className="btn" onClick={() => set("logo.src", null)}>Remove</button>
            </div>
          )}
          {!hasLogo && (
            <Field label="Or just a letter">
              <input value={brand.mark} maxLength={3} onChange={(e) => set("mark", e.target.value)} />
            </Field>
          )}
          <More title="Placement and size" value={`${brand.logo.style} · ${brand.logo.position} · ${brand.logo.size}px`}>
            <Field label="Style">
              <select value={brand.logo.style} onChange={(e) => set("logo.style", e.target.value)}>
                <option value="badge">Square tile</option>
                <option value="plain">Just the image</option>
              </select>
            </Field>
            <Field label="Usual position">
              <select value={brand.logo.position} onChange={(e) => set("logo.position", e.target.value)}>
                {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label={`Max size: ${brand.logo.size}px`}>
              <input type="range" min={40} max={240} value={brand.logo.size} onChange={(e) => set("logo.size", +e.target.value)} />
            </Field>
            <Field label={`Edge margin: ${brand.logo.margin}px`}>
              <input type="range" min={0} max={90} value={brand.logo.margin} onChange={(e) => set("logo.margin", +e.target.value)} />
            </Field>
            <Field label={`Rotation: ${brand.logo.rotate}°`}>
              <input type="range" min={-15} max={15} value={brand.logo.rotate} onChange={(e) => set("logo.rotate", +e.target.value)} />
            </Field>
            <Field label={`Opacity: ${Math.round(brand.logo.opacity * 100)}%`}>
              <input type="range" min={20} max={100} value={brand.logo.opacity * 100} onChange={(e) => set("logo.opacity", +e.target.value / 100)} />
            </Field>
            <label className="check"><input type="checkbox" checked={brand.logo.avoid} onChange={(e) => set("logo.avoid", e.target.checked)} />Move out of the way when something's behind it</label>
            <label className="check"><input type="checkbox" checked={brand.logo.onCover} onChange={(e) => set("logo.onCover", e.target.checked)} />Show on the cover</label>
            <label className="check"><input type="checkbox" checked={brand.logo.onBody} onChange={(e) => set("logo.onBody", e.target.checked)} />Show on other slides</label>
            <Field label="Name used on the colour bar layout">
              <input value={brand.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
          </More>
        </Panel>

        <Panel label="Colours">
          <div className="grid2">
            <Field label="Highlight colour">
              <input type="color" value={brand.colors.accent} onChange={(e) => set("colors.accent", e.target.value)} />
            </Field>
            <Field label="Text on that colour">
              <input type="color" value={brand.colors.onAccent} onChange={(e) => set("colors.onAccent", e.target.value)} />
            </Field>
            <Field label="Text on photos">
              <input type="color" value={brand.colors.text} onChange={(e) => set("colors.text", e.target.value)} />
            </Field>
            <Field label="Shading colour">
              <input type="color" value={brand.colors.shade} onChange={(e) => set("colors.shade", e.target.value)} />
            </Field>
          </div>
          <More title="Colour strength" value={`${Math.round(brand.colors.shadeStrength * 100)}% dark fade`}>
            <Field label={`Highlighted words`}>
              <input type="color" value={brand.colors.highlight || brand.colors.accent} onChange={(e) => set("colors.highlight", e.target.value)} />
            </Field>
            <Field label={`Dark fade strength: ${Math.round(brand.colors.shadeStrength * 100)}%`}>
              <input type="range" min={40} max={100} value={brand.colors.shadeStrength * 100} onChange={(e) => set("colors.shadeStrength", +e.target.value / 100)} />
            </Field>
          </More>
        </Panel>

        <Panel label="Fonts">
          <FontPicker label="Big headline font" path="fonts.display" value={brand.fonts.display} options={FONTS_DISPLAY} pageId={page.id} onChange={set} onBlocked={blocked} />
          <label className="check"><input type="checkbox" checked={brand.fonts.display.uppercase} onChange={(e) => set("fonts.display.uppercase", e.target.checked)} />Always in capitals</label>
          <FontPicker label="Body text font" path="fonts.body" value={brand.fonts.body} options={FONTS_BODY} pageId={page.id} onChange={set} onBlocked={blocked} />
          <More title="Text sizes" value={`${brand.type.hero.max} / ${brand.type.title.max} / ${brand.type.body.max}px`}>
            <label className="check"><input type="checkbox" checked={brand.divider} onChange={(e) => set("divider", e.target.checked)} />Rule and logo above the cover headline</label>
            <Field label={`Cover headline: ${brand.type.hero.max}px`}>
              <input type="range" min={90} max={220} value={brand.type.hero.max} onChange={(e) => set("type.hero.max", +e.target.value)} />
            </Field>
            <Field label={`Slide title: ${brand.type.title.max}px`}>
              <input type="range" min={60} max={160} value={brand.type.title.max} onChange={(e) => set("type.title.max", +e.target.value)} />
            </Field>
            <Field label={`Body text: ${brand.type.body.max}px`}>
              <input type="range" min={34} max={64} value={brand.type.body.max} onChange={(e) => set("type.body.max", +e.target.value)} />
            </Field>
            <Field label={`Side margin: ${brand.safe}px`}>
              <input type="range" min={30} max={110} value={brand.safe} onChange={(e) => set("safe", +e.target.value)} />
            </Field>
          </More>
        </Panel>

        <div className="donebar">
          <div className="row">
            <button className="btn" onClick={save} disabled={state.saving || status === "saving"}>
              {state.saving ? "Saving…" : "Save now"}
            </button>
            <span className="note">
              {state.msg || (status === "saving" ? "Saving…" : status === "dirty" ? "Saving shortly…" : "All changes saved")}
            </span>
          </div>
          {state.err && <span className="err">{state.err}</span>}
          {status === "error" && !state.err && <span className="err">Couldn't save. Check the page still exists.</span>}
        </div>
      </aside>

      <main className="main">
        <h1>{name}</h1>

        <h2>How each cover style looks</h2>
        <p className="note" style={{ marginTop: -4 }}>
          Live previews at the real size. Change anything on the left and these update as you type.
        </p>
        <div className="thumbs">
          {HERO_VARIANTS.map((v) => <Thumb key={v} slide={{ ...cover, variant: v }} brand={brand} index={`hero-${v}`} scale={0.22} caption={v} />)}
        </div>

        <h2>Other slides</h2>
        <div className="thumbs">
          {rest.map((s, i) => <Thumb key={i} slide={s} brand={brand} index={i + 1} scale={0.22} caption={`Slide ${i + 2}`} />)}
        </div>

        <h2>Make the finished images</h2>
        {!previewStoryId ? (
          <div className="empty">
            <strong>No stories on this page yet</strong>
            A page's colours and fonts need a story to apply to. Create one and you can make finished images here.
            <div style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={makeStory} disabled={!!shot.busy}>
                {shot.busy || "Create a story for this page"}
              </button>
            </div>
            {shot.err && <p className="err" style={{ marginTop: 10 }}>{shot.err}</p>}
          </div>
        ) : (
          <>
            <p className="note" style={{ marginTop: -4 }}>
              Renders this page's most recent story so you can judge the brand on finished images.
            </p>
            <button className="btn primary" onClick={render} disabled={!!shot.busy}>
              {shot.busy || (renders.length ? "Make them again" : "Make the images")}
            </button>
            {shot.err && <p className="err">{shot.err}</p>}
          </>
        )}
        {renders.map((r) => (
          <div key={r.id} style={{ marginTop: 18 }}>
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