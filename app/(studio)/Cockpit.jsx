"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client";

/* The cockpit's live controls: run the next step by hand, pause/resume the
   autopilot, and retry a failed story. Everything else on the dashboard is
   server-rendered; these buttons re-fetch after acting so the gauges move. */
export default function Cockpit({ pages, failures = [], preview }) {
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
      const step = r?.step || (r?.result?.step ?? "a step");
      const what = {
        generate: "Generated a new story from today's topics.",
        copy: "Wrote the words for a story.",
        source: "Found photos for a story.",
        render: "Rendered the images for a story.",
        post: "Posted a carousel to Instagram.",
      }[step] || `Ran ${step}.`;
      return { message: what };
    });
  const toggle = (page) =>
    act("Switching…", async () => {
      await api(`/api/pages/${page.id}`, { method: "PUT", body: { config: { ...page.config, autopilot: page.config?.autopilot === false } } });
      return { message: page.config?.autopilot === false ? `Autopilot resumed for ${page.name}.` : `Autopilot paused for ${page.name}.` };
    });

  const on = pages.filter((p) => p.config?.autopilot !== false);
  const allOn = on.length === pages.length && pages.length > 0;

  return (
    <>
      <div className="ck-actions row">
        <button className="btn primary" onClick={() => tick()} disabled={!!busy}>
          {busy || "Run next step now"}
        </button>
        {pages.map((p) => (
          <button key={p.id} className="btn" onClick={() => toggle(p)} disabled={!!busy}>
            {p.config?.autopilot === false ? `Resume ${p.name}` : `Pause ${p.name}`}
          </button>
        ))}
        {(msg || err) && <span className={err ? "err" : "note"}>{err || msg}</span>}
      </div>

      {failures.length > 0 && (
        <section className="ck-failures">
          <h2>Failure board</h2>
          <div className="list">
            {failures.map((f) => (
              <div key={f.id} className="ck-failrow">
                <div className="ck-failtext">
                  <strong>{f.title}</strong>
                  <span className="err">{f.job?.error}</span>
                </div>
                <div className="row">
                  <button className="btn" onClick={() => tick(f.id)} disabled={!!busy}>{busy || "Retry"}</button>
                  <Link className="btn ghost" href={`/stories/${f.id}`}>Open</Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {pages.length > 0 && !allOn && !failures.length && (
        <p className="note" style={{ marginTop: 12 }}>Autopilot is paused — nothing new gets made until you resume it.</p>
      )}
    </>
  );
}
