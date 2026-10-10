import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "studio_auth";

/* Both values are trimmed before comparison. Env vars pasted into a dashboard
   very often carry a trailing newline or space, and an exact match against an
   untrimmed value fails in a way that looks like a wrong password. */
const STUDIO_USER = () => (process.env.STUDIO_USER || "").trim();
const STUDIO_PASSWORD = () => (process.env.STUDIO_PASSWORD || "").trim();

/* POST /api/login   { user, password }
   Checks the credentials and hands back a session cookie, so the browser only
   has to sign in once instead of fighting its own cached 401. */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }
  const user = String(body?.user ?? "");
  const password = String(body?.password ?? "");

  if (!STUDIO_USER() || !STUDIO_PASSWORD()) {
    console.error("login: STUDIO_USER or STUDIO_PASSWORD is not set in this environment");
    return NextResponse.json(
      { error: "Server is missing STUDIO_USER or STUDIO_PASSWORD. Add both to this Vercel project's environment variables and redeploy." },
      { status: 503 }
    );
  }

  if (user !== STUDIO_USER() || password !== STUDIO_PASSWORD()) {
    return NextResponse.json({ error: "Wrong username or password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, Buffer.from(`${user}:${password}`, "utf8").toString("base64"), {
    httpOnly: true,       // JavaScript can't read it
    sameSite: "lax",      // not sent on cross-site posts
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // a month; it's a personal tool
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}