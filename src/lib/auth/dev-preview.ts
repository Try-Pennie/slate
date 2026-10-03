import { cookies, headers } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { User } from "@/lib/db/types";

/**
 * DEV-ONLY preview. Lets you view Slate as any user on localhost WITHOUT Google
 * OAuth, so the agent/manager surfaces can be iterated on without logging in (or
 * waiting on a deploy). Set/cleared via /dev/preview?email=...
 *
 * It acts as ANY user, super admins included, against the live Supabase `next
 * dev` reads, so it is on only when every one of these holds (#3086):
 *   - NODE_ENV is exactly "development" (not merely "not production", which a
 *     test run or an unset value also satisfies);
 *   - SLATE_DEV_PREVIEW is exactly "1", an opt-in in your own .env.local;
 *   - the request came to a loopback Host (`isLoopbackHost`), checked by the
 *     route AND on every read of the cookie, so a cookie is never honoured from
 *     another machine on the network.
 * `pnpm dev` also binds to 127.0.0.1, which is what actually keeps the network
 * out: a Host header is the caller's to write.
 */
export const DEV_PREVIEW_COOKIE = "slate_dev_user";

export function devPreviewEnabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env.SLATE_DEV_PREVIEW === "1";
}

/** True only for localhost, 127.0.0.1 or [::1], with or without a port. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host.trim());
}

/** The user a local dev session is previewing as, or null (always null when the gate is off). */
export async function devPreviewUser(): Promise<User | null> {
  if (!devPreviewEnabled()) return null;
  if (!isLoopbackHost((await headers()).get("host"))) return null;
  const store = await cookies();
  const email = store.get(DEV_PREVIEW_COOKIE)?.value;
  if (!email) return null;
  // error-ok: a failed read leaves the preview unset, which is what an unknown
  // email already does, so localhost falls back to ordinary sign in. This whole
  // module is inert outside an opted-in local dev server, so the empty result reaches no lead and no
  // agent.
  const { data } = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("email", email)
    .maybeSingle();
  return (data as User | null) ?? null;
}
