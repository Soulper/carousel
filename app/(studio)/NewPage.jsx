"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export default function NewPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [error, setError] = useState("");
  const create = async () => {
    setError("");
    try {
      const page = await api("/api/pages", { method: "POST", body: { name, handle } });
      router.push(`/pages/${page.id}`);
    } catch (e) { setError(e.message); }
  };
  return (
<div className="row" style={{ maxWidth: 640 }}>
          <input placeholder="Page name" aria-label="Page name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <input placeholder="@handle" aria-label="Handle" value={handle} onChange={(e) => setHandle(e.target.value)} style={{ width: 180 }} />
          <button className="btn primary" disabled={!name} onClick={create}>Add page</button>
          {error && <span className="err">{error}</span>}
        </div>
  );
}
