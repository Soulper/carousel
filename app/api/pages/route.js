import { db } from "@/lib/supabase";
import { ok, fail, run } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return run(async () => {
    const { data, error } = await db().from("pages").select("id,name,handle,brand,updated_at").order("name");
    if (error) throw error;
    return ok(data);
  });
}

export async function POST(req) {
  return run(async () => {
    const { name, handle, brand = {} } = await req.json();
    if (!name) return fail("Give the page a name");
    const { data, error } = await db().from("pages").insert({ name, handle, brand }).select().single();
    if (error) throw error;
    return ok(data, 201);
  });
}
