"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

/* Create carousel: ✓ tick the page it's for, optionally say what it should be
   about, press one button. Empty details = the AI picks a fresh story on its
   own, exactly like the old one-click — nothing extra to learn. */
export default function NewStory({ pages }) {
  const router = useRouter();
  const [pageId, setPageId] = useState(pages[0]?.id || "");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const story = await api("/api/stories", {
        method: "POST",
        // Details (a subject, an event, or a news link) steer the story finder;
        // empty details fall back to the autopilot's own pick.
        body: { page_id: pageId, generate: true, details: details.trim() },
      });
      router.push(`/stories/${story.id}?auto=1`);
    } catch (e) {
      setBusy(false);
      setError(e.message);
    }
  };

  return (
    <div className="create">
      <p className="create-label">Which page is it for?</p>
      <div className="pagepick" role="radiogroup" aria-label="Which page">
        {pages.map((p) => (
          <label key={p.id} className={`pagepick-row ${pageId === p.id ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={pageId === p.id}
              onChange={() => setPageId(p.id)}
              aria-label={p.name}
            />
            <span className="pagepick-name">{p.name}</span>
            {p.handle && <span className="pagepick-handle">{p.handle}</span>}
          </label>
        ))}
      </div>

      <p className="create-label">What should it be about? <span>(optional)</span></p>
      <textarea
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        rows={3}
        placeholder={'e.g. "the Brewers winning the World Series", "Week 10 football upsets" — or leave empty and the AI picks a fresh story for you.'}
      />

      <button className="btn primary create-btn" onClick={create} disabled={busy || !pageId}>
        {busy ? "Picking a story…" : details.trim() ? "Create carousel" : "Pick a story for me"}
      </button>
      <p className="hint" style={{ margin: 0 }}>
        Picks a real, current story{details.trim() ? " on your subject" : ""}, writes the words, finds
        the photos and makes the images — about 3 minutes, a few cents in AI calls. You can edit
        everything afterwards.
      </p>
      {error && <p className="err" style={{ marginTop: 0 }}>{error}</p>}
    </div>
  );
}
