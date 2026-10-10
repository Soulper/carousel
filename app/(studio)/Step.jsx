"use client";

/* A numbered step in the editor sidebar. Collapsed by default unless `open`,
   with a tick on the circle once `done` is true, so a beginner can see at a
   glance how far along they are. */
export default function Step({ n, title, done, open, children }) {
  /* Uncontrolled on purpose. With `open={open}` React owns the attribute, so it
     re-asserts the initial value on the next render and slams the panel shut
     the moment you type in it — which left the fields unreachable and autosave
     silently doing nothing. Default-open still works; the user is in control
     afterwards. `defaultOpen` sets it once, on first render only. */
  return (
    <details className={`step${done ? " done" : ""}`} defaultOpen={open}>
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