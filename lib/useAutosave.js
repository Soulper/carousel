"use client";
import { useEffect, useRef, useState } from "react";

/* Both editors hold their whole document in React state, so a tweak that hadn't
   been saved used to vanish on refresh with no warning and no trace. This saves
   shortly after the last change, and blocks closing the tab while something is
   still unsaved.

   status: "saved" | "dirty" | "saving" | "error"
   Pass enabled: false in preview mode, where writes are blocked anyway. */
export function useAutosave(save, state, { delay = 1200, enabled = true } = {}) {
  const json = JSON.stringify(state);
  const [status, setStatus] = useState("saved");
  const saved = useRef(json);
  const latest = useRef(json);
  const timer = useRef(null);
  const busy = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  latest.current = json;

  // Throws on failure so the Save button can show why.
  async function attempt() {
    const target = latest.current;
    if (target === saved.current) return;
    busy.current = true;
    setStatus("saving");
    try {
      await saveRef.current();
    } finally {
      busy.current = false;
    }
    saved.current = target;
    setStatus("saved");
  }

  // Never throws, so an autosave failure can't become an unhandled rejection.
  async function quietly() {
    if (busy.current) { timer.current = setTimeout(quietly, delay); return; }
    try {
      await attempt();
    } catch {
      setStatus("error"); // stop retrying; the message is in the editor
      return;
    }
    // Something changed while the request was in flight.
    if (latest.current !== saved.current) timer.current = setTimeout(quietly, delay);
  }

  useEffect(() => {
    if (json === saved.current) return;
    setStatus("dirty");
    if (!enabled) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(quietly, delay);
    return () => clearTimeout(timer.current);
    // `json` stands in for the whole state object: it's a deep comparison, so
    // re-renders that don't change anything don't trigger a save.
  }, [json, delay, enabled]);

  useEffect(() => {
    if (status !== "dirty" && status !== "error") return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  async function saveNow() {
    clearTimeout(timer.current);
    if (busy.current) return;
    await attempt(); // rejects → caller catches and shows the message
  }

  return { status, saveNow };
}