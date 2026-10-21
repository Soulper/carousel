import Link from "next/link";
import { db, isConfigured } from "@/lib/supabase";
import { missingEnv, samplePage, sampleStoryRow, SAMPLE_ID } from "@/lib/preview";
import { pageConfig } from "@/lib/topic";
import NewPage from "./NewPage";
import NewStory from "./NewStory";
import Cockpit from "./Cockpit";

export const dynamic = "force-dynamic";

/* The cockpit. One screen that answers the three questions: what went out,
   what's in the factory, and what's broken. The autopilot (the tick loop)
   does the work; this page just shows where every slot stands. */

const LED = {
  draft: ["queued", "warn"],
  ready: ["in factory", "warn"],
  rendered: ["ready to fly", "warn"],
  posted: ["posted", "ok"],
  rejected: ["failed", "bad"],
  approved: ["ready to fly", "warn"],
};

const slotLabel = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

/* Fall back to the sample board whenever the database can't be read, so a
   wrong SUPABASE_URL or an un-run migration shows a working cockpit with a
   banner instead of a blank 500. */
const SAMPLE = () => ({
  pages: [samplePage()],
  recent: [{ ...sampleStoryRow(), pages: { name: samplePage().name } }],
});

export default async function Dashboard() {
  let preview = !isConfigured();
  let dbError = null;
  let pages, recent;

  if (preview) {
    ({ pages, recent } = SAMPLE());
  } else {
    const [pagesRes, recentRes] = await Promise.all([
      db().from("pages").select("id,name,handle,config").order("name"),
      // Everything that could belong on today's board: scheduled, posted or
      // touched in the last 36 hours. The cockpit matches them to slots below.
      db().from("stories")
        .select("id,page_id,title,status,batch,scheduled_at,posted_at,job,created_at,updated_at,caption,pages(name)")
        .gte("updated_at", new Date(Date.now() - 36 * 3600e3).toISOString())
        .order("scheduled_at", { ascending: true, nullsFirst: false })
        .limit(120),
    ]);
    dbError = pagesRes.error || recentRes.error;
    if (dbError) {
      preview = true;
      ({ pages, recent } = SAMPLE());
    } else {
      pages = pagesRes.data || [];
      recent = recentRes.data || [];
    }
  }

  if (!preview && pages.length === 0) {
    return (
      <div className="wrap">
        <h1>Cockpit</h1>
        <div className="empty">
          <strong>Add your first page</strong>
          A page is one Instagram account: its look, its beats, and its posting schedule. The autopilot fills the slots you define here.
          <div id="newpage" style={{ marginTop: 20 }}>
            <NewPage />
          </div>
        </div>
      </div>
    );
  }

  const pageIds = new Set(pages.map((p) => p.id));
  const storyList = recent.filter((s) => pageIds.has(s.page_id));
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const cfg = pageConfig(pages[0]);

  // ---- gauges
  const posted = storyList.filter((s) => s.status === "posted" && s.posted_at && new Date(s.posted_at) >= dayStart);
  const factory = storyList.filter((s) => ["draft", "ready"].includes(s.status) && !s.job?.error);
  const renderedWaiting = storyList.filter((s) => ["rendered", "approved"].includes(s.status));
  const failed = storyList.filter((s) => s.job?.error && s.status !== "posted");
  const quota = cfg.posts_per_day || 12;
  const nextPost = storyList
    .filter((s) => ["rendered", "approved"].includes(s.status) && s.scheduled_at && new Date(s.scheduled_at) > new Date())
    .map((s) => s.scheduled_at)
    .sort()[0];
  const lastStep = storyList
    .map((s) => s.job?.started_at || s.posted_at)
    .filter(Boolean).sort().pop();

  // Finished carousels waiting on a hand to post them (no publishing account
  // connected). Their latest render gives the slide files.
  const ready = storyList.filter((s) => s.status === "approved");
  const readyRenders = new Map();
  if (ready.length) {
    const { data: r } = await db()
      .from("renders")
      .select("story_id,files,created_at")
      .in("story_id", ready.map((s) => s.id))
      .order("created_at", { ascending: false });
    for (const row of r || []) if (!readyRenders.has(row.story_id)) readyRenders.set(row.story_id, row.files);
  }

  // ---- today's slots, matched to scheduled stories (the tick generator
  // schedules stories onto exactly these slot times)
  const dayISO = dayStart.toISOString().slice(0, 10);
  const times = cfg.slots.length
    ? cfg.slots.map((t) => new Date(`${dayISO}T${t}:00Z`))
    : Array.from({ length: quota }, (_, i) => {
        const mins = Math.round(8 * 60 + ((14 * 60) / quota) * i);
        return new Date(`${dayISO}T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00Z`);
      });
  const fullSlots = times.sort((a, b) => a - b);
  const bySlot = new Map(storyList.filter((s) => s.scheduled_at).map((s) => [new Date(s.scheduled_at).toISOString(), s]));

  return (
    <div className="wrap">
      {preview && (dbError ? <DbBanner error={dbError} /> : <PreviewBanner />)}

      <div className="row" style={{ justifyContent: "space-between", marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>Cockpit</h1>
        <span className="note">
          {cfg.autopilot === false ? "Autopilot paused" : "Autopilot on"} · {slotLabel(new Date())} UTC
        </span>
      </div>

      <div className="ck-gauges">
        <Gauge big={`${posted.length}/${quota}`} label="posted today" />
        <Gauge big={String(factory.length)} label="in factory" />
        <Gauge big={String(renderedWaiting.length)} label="ready to fly" />
        <Gauge big={failed.length ? String(failed.length) : "—"} label="failures" tone={failed.length ? "bad" : undefined} />
        <Gauge big={nextPost ? slotLabel(new Date(nextPost)) : "—"} label="next post" />
        <Gauge big={lastStep ? ago(lastStep) : "idle"} label="last step" />
      </div>

      <Leds anthropic={!!process.env.ANTHROPIC_API_KEY} publishing={!!(process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN)} />

      <Cockpit pages={pages} failures={failed} preview={preview} />

      {ready.length > 0 && (
        <section className="ck-ready">
          <h2>Ready to post</h2>
          <div className="list">
            {ready.map((s) => {
              const files = readyRenders.get(s.id) || [];
              return (
                <div key={s.id} className="ck-readyrow">
                  <div className="ck-readytext">
                    <Link className="ck-title" href={`/stories/${s.id}`}>{s.title}</Link>
                    <span className="note">{s.pages?.name} · {files.length} slides · finished {ago(s.updated_at)}</span>
                    {s.caption && (
                      <details className="more">
                        <summary>Caption</summary>
                        <div className="morebody"><p className="note" style={{ whiteSpace: "pre-wrap" }}>{s.caption}</p></div>
                      </details>
                    )}
                  </div>
                  <div className="row ck-readyslides">
                    {files.map((f) => (
                      <a key={f.url} href={f.url} target="_blank" rel="noreferrer" download title={`Slide ${f.slide}`}>
                        <img src={f.url} alt={`Slide ${f.slide}`} />
                      </a>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="hint">Finished carousels with nowhere to go. Open a slide to save it, copy the caption, and post from the phone.</p>
        </section>
      )}

      <section className="ck-timeline">
        <h2>Today's slots</h2>
        <div className="list">
          {fullSlots.length === 0 && <div className="ck-slot"><span className="muted">No slots configured for this page.</span></div>}
          {fullSlots.map((d) => {
            const s = bySlot.get(d.toISOString());
            const [text, tone] = s ? (LED[s.status] || [s.status, "warn"]) : ["open", null];
            return (
              <div key={d.toISOString()} className={`ck-slot ${tone || ""}`}>
                <span className="ck-time">{slotLabel(d)}</span>
                {s ? (
                  <>
                    <Link className="ck-title" href={`/stories/${s.id}`}>{s.pages?.name ? `${s.pages.name} · ` : ""}{s.title}</Link>
                    <span className={`led ${tone}`} title={text} />
                    <span className="muted">{text}{s.batch ? ` · ${s.batch}` : ""}</span>
                  </>
                ) : (
                  <span className="ck-title muted">open slot</span>
                )}
              </div>
            );
          })}
        </div>
        <p className="hint">
          Slots run 08:00–22:00 UTC unless the page config sets its own. Stories land in slots when the topic finder runs; unsold slots stay open.
        </p>
      </section>

      <Secondary pages={pages} stories={storyList.slice(0, 15)} />
    </div>
  );
}

function Gauge({ big, label, tone }) {
  return (
    <div className={`ck-gauge ${tone || ""}`}>
      <span className="ck-gauge-big">{big}</span>
      <span className="label">{label}</span>
    </div>
  );
}

function Leds({ anthropic, publishing }) {
  const light = (ok, label, hint) => (
    <span className="ck-led" title={hint}>
      <span className={`led ${ok ? "ok" : "warn"}`} />
      {label}
    </span>
  );
  return (
    <div className="row ck-leds">
      {light(true, "Supabase")}
      {light(anthropic, "Claude API", "Set ANTHROPIC_API_KEY")}
      {light(publishing, "Auto-publish", "Connect a publishing account, or post finished carousels by hand below")}
      <span className="hint">Scheduler: GitHub Actions every 15 min → see .github/workflows/tick.yml</span>
    </div>
  );
}

/* Pages, story history and the create forms — still reachable, but the
   cockpit board above is the daily surface. */
function Secondary({ pages, stories }) {
  return (
    <>
      <h2 style={{ marginTop: 34 }}>Pages</h2>
      <div className="list">
        {pages.map((p) => (
          <Link key={p.id} href={`/pages/${p.id}`}>
            <span>{p.name}{p.config?.autopilot === false ? " · paused" : ""}</span>
            <span className="muted">{p.handle}</span>
          </Link>
        ))}
      </div>
      <div id="newpage"><NewPage /></div>

      <h2 style={{ marginTop: 32 }}>Recent stories</h2>
      <NewStory pages={pages} />
      <div className="list">
        {stories.length === 0 && (
          <div className="empty" style={{ border: 0, background: "none" }}>
            <strong>No stories yet</strong>
            The autopilot will fill today's slots, or start one by hand above.
          </div>
        )}
        {stories.map((s) => (
          <Link key={s.id} href={`/stories/${s.id}`}>
            <span>{s.title}</span>
            <span className="row">
              <span className="muted">{[s.pages?.name, s.batch].filter(Boolean).join(" · ")}</span>
              <span className={`pill ${s.status}`}>{s.status}</span>
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}

function PreviewBanner() {
  return (
    <div className="banner">
      <strong>Preview mode.</strong> Supabase isn't connected yet, so this shows sample data and nothing can be saved,
      uploaded, rendered, sourced or posted.
      <div>Missing environment variables: {missingEnv().map((k) => <code key={k}>{k}</code>)}</div>
      <div className="row">
        <Link href={`/pages/${SAMPLE_ID}`}>Open the sample page</Link>
        <Link href={`/stories/${SAMPLE_ID}`}>Open the sample story</Link>
        <Link href="/queue">Open the review queue</Link>
      </div>
    </div>
  );
}

/* Sample board because the database couldn't be read. Says exactly which env
   var to check rather than leaving a digest. */
function DbBanner({ error }) {
  const msg = error?.message || String(error || "");
  const missing = error?.code === "42703" || /column .* does not exist/i.test(msg);
  return (
    <div className="banner">
      {missing ? (
        <>
          <strong>The database needs an update — showing sample data.</strong>
          This version expects columns your project doesn't have yet (<code>pages.config</code>,{" "}
          <code>stories.scheduled_at</code>, <code>stories.caption</code>…). Open Supabase → SQL editor, paste{" "}
          <code>supabase/schema.sql</code>, run it, then reload.
        </>
      ) : (
        <>
          <strong>Can't reach Supabase — showing sample data.</strong>
          {msg}
          <div>
            Check <code>SUPABASE_URL</code> here and on Vercel: the host must resolve and the project must not be
            paused (paused free projects stop answering).
          </div>
        </>
      )}
    </div>
  );
}
