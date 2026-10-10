import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "studio_auth";

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
  const { user, password } = body || {};
  const ok =
    !!process.env.STUDIO_USER &&
    user === process.env.STUDIO_USER &&
    password === process.env.STUDIO_PASSWORD;
  if (!ok) return NextResponse.json({ error: "Wrong username or password" }, { status: 401 });

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