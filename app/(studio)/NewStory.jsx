"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { blankSlides } from "@/lib/carousel/blank";

export default function NewStory({ pages }) {
  const router = useRouter();
  const [pageId, setPageId] = useState(pages[0]?.id);
  const [error, setError] = useState("");
  const create = async () => {
    setError("");
    try {
      const story = await api("/api/stories", { method: "POST", body: { page_id: pageId, title: "Untitled story", slides: blankSlides() } });
      router.push(`/stories/${story.id}`);
    } catch (e) { setError(e.message); }
  };
  return (
    <div className="row" style={{ marginBottom: 14, maxWidth: 640 }}>
      <select value={pageId} onChange={(e) => setPageId(e.target.value)} style={{ flex: 1 }} aria-label="Which page">
        {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button className="btn primary" onClick={create}>New story</button>
      {error && <span className="err">{error}</span>}
    </div>
  );
}