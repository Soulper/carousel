import Link from "next/link";
import { db, isConfigured } from "@/lib/supabase";
import { missingEnv, samplePage, sampleStoryRow, SAMPLE_ID } from "@/lib/preview";
import NewPage from "./NewPage";
import NewStory from "./NewStory";
import Guide from "./Guide";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const preview = !isConfigured();
  const [{ data: pages = [] }, { data: stories = [] }] = preview
    ? [{ data: [samplePage()] }, { data: [{ ...sampleStoryRow(), pages: { name: samplePage().name } }] }]
    : await Promise.all([
        db().from("pages").select("id,name,handle").order("name"),
        db().from("stories").select("id,title,status,updated_at,pages(name)").order("updated_at", { ascending: false }).limit(50),
      ]);

  return (
    <div className="wrap">
      {preview && (
        <div className="banner">
          <strong>Preview mode.</strong> Supabase isn't connected yet, so this shows sample data and nothing can be saved,
          uploaded, rendered or sourced.
          <div>Missing environment variables: {missingEnv().map((k) => <code key={k}>{k}</code>)}</div>
          <div className="row">
            <Link href={`/pages/${SAMPLE_ID}`}>Open the sample page</Link>
            <Link href={`/stories/${SAMPLE_ID}`}>Open the sample story</Link>
            <Link href="/queue">Open the review queue</Link>
          </div>
        </div>
      )}
      {!preview && <Guide />}

      <h1>Your pages</h1>
      <p className="note" style={{ marginTop: -6, marginBottom: 14 }}>
        One per Instagram account. Click one to change its colours, fonts and logo.
      </p>
      <div className="list">
        {pages.length === 0 && (
          <div className="empty" style={{ border: 0 }}>
            <strong>No pages yet</strong>
            Add your first one below to get started.
          </div>
        )}
        {pages.map((p) => (
          <Link key={p.id} href={`/pages/${p.id}`}>
            <span>{p.name}</span>
            <span className="muted">{p.handle}</span>
          </Link>
        ))}
      </div>
      <div id="newpage"><NewPage /></div>

      <h1 style={{ marginTop: 36 }}>Your stories</h1>
      <p className="note" style={{ marginTop: -6, marginBottom: 14 }}>
        Each story becomes one carousel post. Click one to edit its slides.
      </p>
      {pages.length === 0 ? (
        <div className="empty">
          <strong>Add a page first</strong>
          Stories belong to a page, so you'll need one before you can make a story.
        </div>
      ) : (
        <NewStory pages={pages} />
      )}
      <div className="list">
        {stories.length === 0 && (
          <div className="empty" style={{ border: 0 }}>
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
