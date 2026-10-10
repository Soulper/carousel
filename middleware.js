import { NextResponse } from "next/server";

/* Access control for an internal tool.
   Three ways in:
   - x-api-key header  → your pipeline calling /api/stories
   - Authorization: Basic → curl, and the browser's own login box
   - a session cookie   → set by the /login form, so you get one click instead
                          of a browser prompt that won't re-appear once cancelled

   The cookie holds base64(user:password), which is the same secret Basic auth
   already sends on every request. Changing STUDIO_PASSWORD invalidates every
   outstanding cookie automatically. */
const COOKIE = "studio_auth";

const known = (user, pass) =>
  !!process.env.STUDIO_USER && user === process.env.STUDIO_USER && pass === process.env.STUDIO_PASSWORD;

function credentials(req) {
  const cookie = req.cookies.get(COOKIE)?.value;
  if (cookie) {
    const [user, pass] = Buffer.from(cookie, "base64").toString("utf8").split(":");
    return { user, pass, via: "cookie" };
  }
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const [user, pass] = Buffer.from(auth.slice(6), "utf8").split(":");
    return { user, pass, via: "basic" };
  }
  return null;
}

export function middleware(req) {
  const key = req.headers.get("x-api-key");
  if (key && process.env.PIPELINE_API_KEY && key === process.env.PIPELINE_API_KEY) return NextResponse.next();

  const creds = credentials(req);
  if (creds && known(creds.user, creds.pass)) return NextResponse.next();

  // API callers want a status code, not an HTML redirect they can't follow.
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }

  // Browser: send them to the login form. Keeps the ?next= so they land back
  // where they were headed after signing in.
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = req.nextUrl.pathname === "/" ? "" : `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/login).*)"],
};