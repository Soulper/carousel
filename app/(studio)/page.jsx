import Link from "next/link";
import { db, isConfigured } from "@/lib/supabase";
import { missingEnv, samplePage, sampleStoryRow, SAMPLE_ID } from "@/lib/preview";
import NewPage from "./NewPage";
import NewStory from "./NewStory";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const preview = !isConfigured();
  const [{ data: pages = [] }, { data: stories = [] }] = preview
    ? [{ data: [samplePage()] }, { data: [{ ...sampleStoryRow(), pages: { name: samplePage().name } }] }]
    : await Promise.all([
        db().from("pages").select("id,name,handle").order("name"),
        db().from("stories").select("id,title,status,updated_at,pages(name)").order("updated_at", { ascending: false }).limit(50),
      ]);

  /* First run: one empty state that says what a page is and puts the form
     inside it. Previously a separate four-step guide sat above the list, which
     described the whole workflow before the user had anything to act on. */
  if (pages.length === 0) {
    return (
      <div className="wrap">
        {preview && <PreviewBanner />}
        <h1>Carousel Studio</h1>
        <div className="empty">
          <strong>Add your first page</strong>
          A page is one Instagram account. Set its colours, fonts and logo once, and every story you make for it inherits them.
          <div id="newpage" style={{ marginTop: 20 }}>
            <NewPage />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      {preview && <PreviewBanner />}

      <h1>Your pages</h1>
      <p className="note" style={{ marginTop: -8, marginBottom: 14 }}>
        One per Instagram account. Click one to change its colours, fonts and logo.
      </p>
      <div className="list">
        {pages.map((p) => (
          <Link key={p.id} href={`/pages/${p.id}`}>
            <span>{p.name}</span>
            <span className="muted">{p.handle}</span>
          </Link>
        ))}
      </div>
      <div id="newpage"><NewPage /></div>

      <h1 style={{ marginTop: 32 }}>Your stories</h1>
      <p className="note" style={{ marginTop: -8, marginBottom: 14 }}>
        Each story becomes one carousel post. Click one to edit its slides.
      </p>
      <NewStory pages={pages} />
      <div className="list">
        {stories.length === 0 && (
          <div className="empty" style={{ border: 0, background: "none" }}>
            <strong>No stories yet</strong>
            Use “New story” above, or have your pipeline POST to /api/stories.
          </div>
        )}
        {stories.map((s) => (
          <Link key={s.id} href={`/stories/${s.id}`}>
            <span>{s.title}</span>
            <span className="row">
              <span className="muted">{s.pages?.name}</span>
              <span className={`pill ${s.status}`}>{s.status}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function PreviewBanner() {
  return (
    <div className="banner">
      <strong>Preview mode.</strong> Supabase isn&apos;t connected yet, so this shows sample data and nothing can be saved,
      uploaded, rendered or sourced.
      <div>Missing environment variables: {missingEnv().map((k) => <code key={k}>{k}</code>)}</div>
      <div className="row">
        <Link href={`/pages/${SAMPLE_ID}`}>Open the sample page</Link>
        <Link href={`/stories/${SAMPLE_ID}`}>Open the sample story</Link>
        <Link href="/queue">Open the review queue</Link>
      </div>
    </div>
  );
}
