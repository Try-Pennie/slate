import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { User } from "@/lib/db/types";

/**
 * DEV-ONLY preview. Lets you view Slate as any user on localhost WITHOUT Google
 * OAuth, so the agent/manager surfaces can be iterated on without logging in (or
 * waiting on a deploy). Hard-gated to non-production: in the deployed Worker
 * (NODE_ENV=production) every function here is inert, so it can never grant
 * access in prod. Set/cleared via /dev/preview?email=...
 */
export const DEV_PREVIEW_COOKIE = "slate_dev_user";

export function devPreviewEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** The user a local dev session is previewing as, or null (always null in prod). */
export async function devPreviewUser(): Promise<User | null> {
  if (!devPreviewEnabled()) return null;
  const store = await cookies();
  const email = store.get(DEV_PREVIEW_COOKIE)?.value;
  if (!email) return null;
  // error-ok: a failed read leaves the preview unset, which is what an unknown
  // email already does, so localhost falls back to ordinary sign in. This whole
  // module is inert in production, so the empty result reaches no lead and no
  // agent.
  const { data } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("email", email)
    .maybeSingle();
  return (data as User | null) ?? null;
}
