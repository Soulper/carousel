import { db, BUCKET, publicUrl } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";

export const dynamic = "force-dynamic";

/* Files go straight from the browser to Supabase Storage, not through this
   function (Vercel caps request bodies at a few MB, and full-size photos are
   bigger). This route just hands out a one-time signed upload slot.
   POST { name, folder } → { path, token, url } */
export async function POST(req) {
  return run(async () => {
    const { name, folder } = await req.json().catch(() => ({}));
    if (!name) return fail("File name is required");
    const safeFolder = String(folder || "misc").replace(/[^a-zA-Z0-9/_-]/g, "");
    const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${safeFolder}/${Date.now()}-${safeName}`;
    const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) throw error;
    return ok({ path, token: data.token, url: publicUrl(path) });
  });
}
