import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/supabase";
import { PREVIEW_MESSAGE } from "@/lib/preview";

export const ok = (data, status = 200) => NextResponse.json(data, { status });
export const fail = (message, status = 400) => NextResponse.json({ error: message }, { status });

export async function run(fn) {
  // Preview mode (no Supabase yet): answer 503 instead of failing inside the client
  if (!isConfigured()) return fail(PREVIEW_MESSAGE, 503);
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    return fail(e.message || "Something went wrong", 500);
  }
}
