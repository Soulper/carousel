"use client";

/* A numbered step in the editor sidebar. Collapsed by default unless `open`,
   with a tick on the circle once `done` is true, so a beginner can see at a
   glance how far along they are. */
export default function Step({ n, title, done, open, children }) {
  return (
    <details className={`step${done ? " done" : ""}`} open={open}>
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