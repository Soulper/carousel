/* Shared form controls for the studio editors.
   These used to live in Step.jsx alongside a numbered-step accordion. The step
   chrome is gone; what remains are the three pieces both editors share. */

/* A labelled group of fields. Replaces the old step accordion: a heading and a
   hairline, with no border, no numbering and no expand/collapse. */
export function Panel({ label, children }) {
  return (
    <section className="panel">
      {label && <span className="label">{label}</span>}
      <div className="panelbody">{children}</div>
    </section>
  );
}

/* Settings almost nobody needs, so it stays collapsed. `value` renders a
   one-line summary of the current settings on the summary row, which keeps a
   collapsed group readable instead of hiding what it holds. */
export function More({ title, value, children }) {
  return (
    <details className="more">
      <summary>
        <span>{title}</span>
        {value && <span className="summary-value">{value}</span>}
      </summary>
      <div className="morebody">{children}</div>
    </details>
  );
}

/* A labelled input. `hint` is used sparingly — only where the control does
   something the label alone can't convey. */
export function Field({ label, hint, children }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}
