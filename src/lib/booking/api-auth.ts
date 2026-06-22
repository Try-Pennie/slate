/**
 * Bearer auth for the direct booking API (#355). Pure + IO-free so it unit-tests
 * under `node --experimental-strip-types` and stays out of the route's Next/
 * Supabase/Google surface. The route reads the two configured secrets from env,
 * builds the key set with `parseApiKeys`, and gates every request through
 * `authenticateBearer`.
 *
 * Two keys (primary + secondary) are accepted at once so the secret can be
 * rotated with zero downtime: add the new secret as the secondary, point the
 * caller at it, then retire the old primary. Each authenticated call reports the
 * matched key's LABEL (never the secret) so logs can attribute traffic per key.
 */

export interface ApiKey {
  /** Stable label for logs — "primary" or "secondary". Never the secret. */
  id: "primary" | "secondary";
  secret: string;
}

export type AuthResult =
  | { ok: true; keyId: ApiKey["id"] }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Build the labeled key set from the two env slots, skipping any that are unset
 * or blank. A whitespace-only value is treated as unset — never a usable secret.
 */
export function parseApiKeys(primary: string, secondary: string): ApiKey[] {
  const keys: ApiKey[] = [];
  if (primary.trim()) keys.push({ id: "primary", secret: primary });
  if (secondary.trim()) keys.push({ id: "secondary", secret: secondary });
  return keys;
}

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
function bearerToken(header: string | null): string | null {
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
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  }
  return diff === 0;
}

/**
 * Verify a Bearer Authorization header against the configured keys. Fails CLOSED
 * with 503 when NO key is configured (the endpoint is effectively disabled),
 * distinct from 401 for a present-but-wrong credential. On success, reports which
 * key matched.
 */
export function authenticateBearer(
  header: string | null,
  keys: ApiKey[],
): AuthResult {
  if (keys.length === 0) {
    return { ok: false, status: 503, error: "booking api not configured" };
  }
  const token = bearerToken(header);
  if (token !== null) {
    for (const key of keys) {
      if (timingSafeEqual(token, key.secret)) {
        return { ok: true, keyId: key.id };
      }
    }
  }
  return { ok: false, status: 401, error: "unauthorized" };
}
