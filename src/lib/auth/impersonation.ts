import { atLeast } from "@/lib/auth/roles";
import type { Role } from "@/lib/db/types";

/** Cookie carrying the impersonated user's id. Only honored for admin+ sessions. */
export const IMPERSONATE_COOKIE = "slate_impersonate";

/**
 * Which user id a request should act as. This is the FLOOR gate: impersonation is
 * honored ONLY when the real session is an admin or super_admin — for everyone
 * else the cookie is ignored, so a forged cookie can never escalate privileges. A
 * cookie pointing at the actor themselves is a no-op. The CEILING (you can only
 * ever act as someone ranked strictly below you) needs the target's role and so is
 * enforced downstream in `currentUser()` via `canImpersonate`. See
 * `scripts/test-impersonation.ts`.
 */
export function resolveEffectiveUserId(
  realRole: Role,
  realId: string,
  impersonateCookie: string | undefined,
): string {
  if (!atLeast(realRole, "admin")) return realId;
  if (!impersonateCookie || impersonateCookie === realId) return realId;
  return impersonateCookie;
}
