import puppeteer from "puppeteer-core";

/* One warm Chromium per server instance.
   - On Vercel / Linux servers: @sparticuz/chromium (a serverless-sized Chromium).
   - Locally on a Mac/PC: set CHROME_EXECUTABLE_PATH to your installed Chrome, e.g.
     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome */
let browserPromise;

export function browser() {
  if (!browserPromise) {
    browserPromise = launch();
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

async function launch() {
  if (process.env.CHROME_EXECUTABLE_PATH) {
    return puppeteer.launch({
      executablePath: process.env.CHROME_EXECUTABLE_PATH,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  const chromium = (await import("@sparticuz/chromium")).default;
  return puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: chromium.args,
    headless: true,
  });
}

// The app's own public URL, which Puppeteer loads /render/:id from
export function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  // Netlify: URL is the production site, DEPLOY_PRIME_URL this particular
  // deploy. The production one is what carries the newest code, so prefer it.
  if (process.env.CONTEXT === "production" && process.env.URL) return process.env.URL;
  if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL;
  return "http://localhost:3000";
}

/* Get the browser past the studio's own login.
   middleware.js sends an unauthenticated browser to /login, so answering a
   prompt isn't enough — the page would load the login form instead of the
   slides. It also accepts base64(user:password) in the studio_auth cookie, so
   set that directly; authenticate() covers the 401 case as well. */
export async function login(page) {
  const user = process.env.STUDIO_USER;
  if (!user) return;
  const password = process.env.STUDIO_PASSWORD || "";
  await page.setCookie({
    name: "studio_auth",
    value: Buffer.from(`${user}:${password}`).toString("base64"),
    url: appUrl(),
  });
  await page.authenticate({ username: user, password });
}
