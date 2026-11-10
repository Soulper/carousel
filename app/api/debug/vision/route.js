import { ai, provider, freeProvider, freeVisionModel, visionProvider } from "@/lib/ai";
import { ok, run } from "@/lib/http";

export const dynamic = "force-dynamic";

/* TEMP diagnostics: runs the ACTUAL vision-judge call shape against one tiny
   in-function generated test image and reports exactly which provider/model
   served it and what error (if any) came back — because photo judging has
   silently "failed" on this deployment and the code path checks out. */
export async function GET() {
  return run(async () => {
    // 1×4 red PNG, base64 — a real image the model can look at.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ).toString("base64");
    const conf = {
      provider: provider(),
      free: freeProvider() ? { name: freeProvider().name, model: freeProvider().model, vision: freeProvider().vision } : null,
      freeVisionModel: freeVisionModel(),
      visionProviderEnv: visionProvider() ? { name: visionProvider().name, model: visionProvider().model } : null,
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
    // Also enumerate both providers' live model lists, so stale model IDs
    // (scout 404) are visible without account access. Groq dropped vision
    // models entirely in Nov 2026 — the vision lane must live elsewhere.
    let models = null;
    try {
      const res = await fetch(`https://api.groq.com/openai/v1/models`, {
        headers: { authorization: `Bearer ${process.env.GROQ_API_KEY || ""}` },
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      models = (data.data || []).map((m) => m.id).filter((id) => id) || null;
    } catch (e) { models = `ERR ${String(e.message).slice(0, 120)}`; }
    let mistral = null;
    try {
      const res = await fetch(`https://api.mistral.ai/v1/models`, {
        headers: { authorization: `Bearer ${process.env.MISTRAL_API_KEY || ""}` },
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      mistral = (data.data || []).map((m) => ({ id: m.id, caps: (m.capabilities || {}) })) || null;
    } catch (e) { mistral = `ERR ${String(e.message).slice(0, 120)}`; }
    // And try the vision-judge call THROUGH the env-pinned provider, since
    // that's the path the pipeline will take when the main provider has no
    // vision model anymore.
    let visionCall = null;
    let vp = visionProvider();
    const conf2 = {...conf, visionProviderEnv: vp ? { name: vp.name, model: vp.model } : null};
    if (vp) {
      try {
        const { openaiCompat } = await import("@/lib/ai");
        const r = await openaiCompat({
          system: "You look at pictures and answer in JSON only.",
          messages: [{ role: "user", content: [
            { type: "text", text: 'Describe this image in JSON: {"kind":"<colour>","notes":"..."}. If you cannot see it, reply {"error":"cannot see"}.' },
            { type: "image", source: { media_type: "image/png", data: png } },
          ] }],
          json: true,
          maxTokens: 400,
          label: "debug:vision-vp",
        }, vp);
        visionCall = { ok: true, text: (r.text || "").slice(0, 400) };
      } catch (e) {
        visionCall = { ok: false, error: String(e.message || e).slice(0, 400) };
      }
    }
    return ok({ config: conf2, call, models, mistral, visionCall });
  });
}
