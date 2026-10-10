"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

/* The browser's own Basic-auth box appears once and, if you cancel it, Chrome
   remembers and never offers it again — leaving a dead "Login required" page
   with no way back in. This is a normal form instead: it posts to /api/login,
   which sets a cookie, and it works every time. */
function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next") || "/";
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, password }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error || "Login required");
        return;
      }
      // Full reload rather than a client nav, so every server component
      // re-fetches with the cookie in place.
      window.location.assign(next);
    } catch {
      setError("Could not reach the server. Is it running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
      <label className="login-field">
        Username
        <input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </label>
      <label className="login-field">
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <button className="login-btn" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {error && <p className="login-err">{error}</p>}
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="login-wrap">
      <div className="login-card">
        <h1>Carousel Studio</h1>
        <p className="login-sub">Sign in to continue.</p>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}