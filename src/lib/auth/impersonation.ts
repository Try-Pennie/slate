import type { Role } from "@/lib/db/types";

/** Cookie carrying the impersonated user's id. Only honored for admin sessions. */
export const IMPERSONATE_COOKIE = "slate_impersonate";

/**
 * Which user id a request should act as. Impersonation is honored ONLY when the
 * real session belongs to an admin — for everyone else the cookie is ignored,
 * so a forged cookie can never escalate privileges. A cookie pointing at the
 * admin themselves is a no-op. This is the single security gate for the whole
 * feature; `currentUser()` reads its result. See `scripts/test-impersonation.ts`.
 */
export function resolveEffectiveUserId(
  realRole: Role,
  realId: string,
  impersonateCookie: string | undefined,
): string {
  if (realRole !== "admin") return realId;
  if (!impersonateCookie || impersonateCookie === realId) return realId;
  return impersonateCookie;
}
