import { db } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req, { params }) {
  return run(async () => {
    const { data, error } = await db().from("pages").select("*").eq("id", params.id).single();
    if (error) return fail("Page not found", 404);
    return ok(data);
  });
}

export async function PUT(req, { params }) {
  return run(async () => {
    const { name, handle, brand, config } = await req.json();
    const patch = Object.fromEntries(Object.entries({ name, handle, brand, config }).filter(([, v]) => v !== undefined));
    const { data, error } = await db().from("pages").update(patch).eq("id", params.id).select().single();
    if (error) throw error;
    return ok(data);
  });
}
