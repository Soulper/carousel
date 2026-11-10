import { ai, provider, freeProvider, freeVisionModel, visionProvider, openaiCompat } from "@/lib/ai";
import { ok, run } from "@/lib/http";

export const dynamic = "force-dynamic";

/* TEMP diagnostics: runs the ACTUAL vision-judge call shape against a test
   image and reports exactly which provider/model served it and what error
   (if any) came back — because photo judging has silently "failed" on this
   deployment and Groq dropped every vision model (Nov 2026, measured). */

// 256×140: red band over green band — describable by any working encoder.
const TEST_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAOAAAACMCAIAAACPnnBXAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAY0lEQVR42u3BAQ0AAADCoMR9/WAbGwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYINYXAABP0nT2QAAAABJRU5ErkJggg==";

export async function GET(req) {
  return run(async () => {
    // Optional ?img=<url>: a REAL photo instead of the blocks, so the probe
    // answers the only question that matters — does the lane describe photos.
    // Stamped image/jpeg exactly like the pipeline's resized previews.
    let png = TEST_PNG;
    let mime = "image/png";
    let imgError = null;
    const imgUrl = new URL(req.url).searchParams.get("img");
    if (imgUrl) {
      try {
        const res = await fetch(imgUrl, { signal: AbortSignal.timeout(15000) });
        const buf = Buffer.from(await res.arrayBuffer());
        mime = "image/jpeg";
        png = buf.toString("base64");
        if (buf.length < 2000) imgError = `suspiciously small body (${buf.length}b): ${buf.toString("utf8").slice(0, 60)}`;
      } catch (e) { imgError = String(e.message).slice(0, 120); }
    }
    const conf = {
      provider: provider(),
      free: freeProvider() ? { name: freeProvider().name, model: freeProvider().model, vision: freeProvider().vision } : null,
      freeVisionModel: freeVisionModel(),
      FREE_VISION_MODEL: process.env.FREE_VISION_MODEL ?? null,
      FREE_VISION_PROVIDER: process.env.FREE_VISION_PROVIDER ?? null,
    };
    let call = null;
    try {
      const r = await ai({
        system: "You look at pictures and answer in JSON only.",
        messages: [{ role: "user", content: [
          { type: "text", text: 'Describe this image in JSON: {"kind":"<colour>","notes":"..."}. If you cannot see it, reply {"error":"cannot see"}.' },
          { type: "image", source: { media_type: "image/png", data: png } },
        ] }],
        json: true,
        maxTokens: 400,
        label: "debug:vision",
      });
      call = { ok: true, text: (r.text || "").slice(0, 400) };
    } catch (e) {
      call = { ok: false, error: String(e.message || e).slice(0, 400) };
    }
    /* Every candidate judge model on the env-pinned key, so the fix can pick a
       lane that measurably SEES rather than guessing again. */
    const probes = [];
    for (const m of ["mistral-small-latest", "ministral-8b-latest", "ministral-3b-latest", "ministral-14b-latest"]) {
      const body = { model: m, messages: [{ role: "user", content: [
        { type: "text", text: "Describe what you see in one short JSON: {\"seen\":true,\"describe\":\"...\"}. If you cannot see any image, reply {\"seen\":false}." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ] }], max_tokens: 160 };
      try {
        const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MISTRAL_API_KEY || ""}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        const data = await res.json().catch(() => ({}));
        probes.push({ model: m, status: res.status, out: (data.choices?.[0]?.message?.content || JSON.stringify(data)).slice(0, 300) });
      } catch (e) { probes.push({ model: m, error: String(e.message).slice(0, 120) }); }
    }
    return ok({ config: conf, imgError, call, probes });
  });
}
