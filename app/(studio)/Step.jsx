"use client";

/* A numbered step in the editor sidebar. Collapsed by default unless `open`,
   with a tick on the circle once `done` is true, so a beginner can see at a
   glance how far along they are. */
import { useEffect, useRef } from "react";

export default function Step({ n, title, done, open, children }) {
  const ref = useRef(null);

  /* Uncontrolled on purpose. With `open={open}` React owns the attribute and
     re-asserts it on every render, so the panel slams itself shut the moment
     you type in it — the fields become unreachable and autosave silently does
     nothing. Instead we set the initial state ONCE on mount and never touch it
     again; after that the user is in control. Empty deps is deliberate: adding
     `open` back is what caused the bug. */
  useEffect(() => {
    const el = ref.current;
    if (el && open !== undefined) el.open = !!open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <details className={`step${done ? " done" : ""}`} ref={ref}>
      <summary>
        <span className="stepnum">{done ? "✓" : n}</span>
        <span>{title}</span>
        <span className="step-arrow">›</span>
      </summary>
      <div className="stepbody">{children}</div>
    </details>
  );
}

/* Settings almost nobody needs. Keeps the sidebar short. */
export function More({ title, children }) {
  return (
    <details className="more">
      <summary>{title}</summary>
      <div className="morebody">{children}</div>
    </details>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}