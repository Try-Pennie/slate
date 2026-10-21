// The two refusals every hand run command that books on smoketest@'s calendar makes
// before it touches production: no Supabase credentials, or a start that could meet the
// smoke canary mid flight (it books, moves and cancels on the same advisor). One copy,
// shared by `verify-reroute-live.ts` and `verify-marcia-lead-fill-live.ts`, so the two
// cannot drift on either.
import { runMeetsCanary } from "./reroute-live-check.ts";

export type PreflightRefusal = { outcome: "notConfigured" | "canaryWindow"; detail: string };

export function liveTestWorldPreflight(env: Record<string, string | undefined>, nowMs: number): PreflightRefusal | null {
  if (!env.SUPABASE_SECRET_KEY || !env.NEXT_PUBLIC_SUPABASE_URL) {
    return { outcome: "notConfigured", detail: "no Supabase credentials in .env.local or .dev.vars" };
  }
  if (runMeetsCanary(nowMs)) {
    return { outcome: "canaryWindow", detail: "start again between eight and twenty one minutes past :00 or :30" };
  }
  return null;
}
