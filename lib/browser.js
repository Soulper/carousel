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
  return "http://localhost:3000";
}
