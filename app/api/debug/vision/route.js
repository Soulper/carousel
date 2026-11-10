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
    return ok({ config: conf, call });
  });
}
