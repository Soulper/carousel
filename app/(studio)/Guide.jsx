import Link from "next/link";

/* Four steps, in the order you'd actually do them. Shown on the dashboard so a
   new user isn't dropped into a list of pages with no idea what to click. */
export default function Guide() {
  const steps = [
    {
      n: 1,
      title: "Create a page",
      body: "A page is one Instagram account. Set its colours, fonts and logo once — every story you make for it inherits them.",
      cta: "Add a page below",
    },
    {
      n: 2,
      title: "Make a story",
      body: "A story is a set of slides. Give it a headline and some words, or let the AI write them for you.",
      cta: "New story",
      needs: "page",
    },
    {
      n: 3,
      title: "Add photos",
      body: "Paste a link to a news article and the AI finds photos for it. Or upload your own. Cutouts (backgrounds removed) need the Python worker running.",
      needs: "story",
    },
    {
      n: 4,
      title: "Make the images",
      body: "One click turns each slide into a finished 1080×1350 JPG, ready to post.",
      needs: "story",
    },
  ];

  return (
    <div className="steps-guide">
      <h2 style={{ margin: "0 0 4px" }}>How this works</h2>
      {steps.map((s) => (
        <div className="guide-step" key={s.n}>
          <span className="n">{s.n}</span>
          <div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
            {s.cta && !s.needs && <a className="btn" href="#newpage">{s.cta}</a>}
          </div>
        </div>
      ))}
      <p className="note" style={{ marginTop: 4 }}>
        New here? Start at the <Link href="/queue">review queue</Link> — it shows every story waiting on you and what's still missing.
      </p>
    </div>
  );
}