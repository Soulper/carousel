"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client";

/* The cockpit's live pieces. Split in two so the page can lay them out
   separately: CockpitActions sits in the header, CockpitFailures in the side
   column. Both share the same tick/act plumbing. */
function useCockpit(preview) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const act = async (label, fn) => {
    if (preview) { setErr("Connect Supabase to run the autopilot."); return; }
    setBusy(label); setMsg(""); setErr("");
    try {
      const r = await fn();
      setMsg(r?.message || "Done.");
      router.refresh();
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };

  const tick = (storyId) =>
    act(storyId ? "Retrying…" : "Running…", async () => {
      const r = await api("/api/cron/tick", { method: "POST", body: { story_id: storyId || undefined } });
      if (r?.idle) return { message: "Nothing to do — every story is waiting on its slot." };
      const step = r?.result?.step || r?.step || "a step";
      const what = {
        generate: "Generated a new story from today's topics.",
        copy: "Wrote the words for a story.",
        source: "Found photos for a story.",
        render: "Rendered the images for a story.",
        post: "Sent a carousel out.",
        ready: "A carousel is finished — it's ready to post.",
      }[step] || `Ran ${step}.`;
      return { message: what };
    });

  const toggle = (page) =>
    act("Switching…", async () => {
      await api(`/api/pages/${page.id}`, { method: "PUT", body: { config: { ...page.config, autopilot: page.config?.autopilot === false } } });
      return { message: page.config?.autopilot === false ? `Autopilot resumed for ${page.name}.` : `Autopilot paused for ${page.name}.` };
    });

  return { busy, msg, err, tick, toggle };
}

export function CockpitActions({ pages = [], preview }) {
  const { busy, msg, err, tick, toggle } = useCockpit(preview);
  return (
    <div className="ck-controls">
      <button className="btn primary" onClick={() => tick()} disabled={!!busy}>
        {busy || "Run next step now"}
      </button>
      {pages.map((p) => (
        <button key={p.id} className="btn" onClick={() => toggle(p)} disabled={!!busy}>
          {p.config?.autopilot === false ? `Resume ${p.name}` : `Pause ${p.name}`}
        </button>
      ))}
      {(msg || err) && <p className={err ? "err ck-note" : "note ck-note"}>{err || msg}</p>}
    </div>
  );
}

export function CockpitFailures({ failures = [], preview }) {
  const { busy, msg, err, tick } = useCockpit(preview);
  if (!failures.length) {
    return (
      <section className="ck-card">
        <div className="ck-card-head">
          <h2>Failure board</h2>
        </div>
        <div className="ck-empty">
          <span className="led ok" />
          Nothing broken. Every story is moving.
        </div>
      </section>
    );
  }
  return (
    <section className="ck-card">
      <div className="ck-card-head">
        <h2>Failure board</h2>
        <span className="ck-count bad">{failures.length}</span>
      </div>
      <div className="ck-list">
        {failures.map((f) => (
          <div key={f.id} className="ck-failrow">
            <div className="ck-failtext">
              <Link className="ck-row-title" href={`/stories/${f.id}`}>{f.title}</Link>
              <span className="err">{f.job?.error}</span>
            </div>
            <div className="ck-failacts">
              <button className="btn" onClick={() => tick(f.id)} disabled={!!busy}>{busy ? "…" : "Retry"}</button>
              <Link className="btn ghost" href={`/stories/${f.id}`}>Open</Link>
            </div>
          </div>
        ))}
      </div>
      {(msg || err) && <p className={err ? "err ck-note" : "note ck-note"}>{err || msg}</p>}
    </section>
  );
}
