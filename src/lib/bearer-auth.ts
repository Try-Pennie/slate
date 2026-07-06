/**
 * Constant-time Bearer-token auth primitives shared by every machine-to-machine
 * endpoint (booking API, reassign, offboarding, cron). Pure + IO-free so it
 * unit-tests under `node --experimental-strip-types` and stays out of the
 * routes' Next/Supabase/Google surface.
 *
 * #594 consolidated three ad-hoc `header === `Bearer ${key}`` checks (which
 * compared with a plain `===`, a timing side channel) onto this one
 * constant-time path, matching what the booking API (`api-auth.ts`) already did.
 */

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length);
  return token.length > 0 ? token : null;
}

/**
 * Constant-time string comparison so a wrong key can't be brute-forced by
 * timing the response. Length mismatch returns false but still walks the loop to
 * avoid a length-based early-out leak.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  }
  return diff === 0;
}

/**
 * Constant-time check of a Bearer header against a single expected secret.
 * Returns false when the secret is unset/blank or the header is missing or
 * malformed, so an unconfigured endpoint never authenticates. Callers that need
 * to distinguish "unconfigured" (503) from "wrong credential" (401) should check
 * the secret's presence themselves before delegating here.
 */
export function bearerTokenMatches(header: string | null, secret: string): boolean {
  if (!secret) return false;
  const token = bearerToken(header);
  if (token === null) return false;
  return timingSafeEqual(token, secret);
}
