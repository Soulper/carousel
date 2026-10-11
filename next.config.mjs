/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Keep the browser packages out of the server bundle. They read files from
    // disk at runtime, so bundling relocates them and breaks them.
    serverComponentsExternalPackages: ["puppeteer-core", "@sparticuz/chromium", "sharp"],

    /* @sparticuz/chromium finds its browser by reading files next to its own
       JavaScript — join(__dirname, "..", "bin") — and those are brotli
       archives that no file tracer can follow. Output tracing therefore picks
       up build/index.js and package.json but silently drops bin/, and the
       function dies on first launch with:

         The input directory "/var/task/node_modules/@sparticuz/chromium/bin"
         does not exist.

       Naming the payload explicitly is the fix, and it has to go here under
       `experimental` rather than at the top level: in Next 14.2.15
       collect-build-traces.js destructures it from config.experimental, so a
       top-level key loads without error and is then ignored.

       Only /api/render/[id] needs it — that is the sole route reaching
       lib/render.js, which is the sole reacher of lib/browser.js.

       Netlify doesn't need this. Its background functions are assembled by
       netlify.toml's external_node_modules and included_files, which copy the
       whole package including bin/ — verified with `netlify functions:build`,
       which yields a 68 MB zip containing all four .br archives. */
    outputFileTracingIncludes: {
      "/api/render/[id]": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    },
  },
};
export default nextConfig;
