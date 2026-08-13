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
 *
 * The constant-time comparison + `Bearer` parsing live in the shared
 * `bearer-auth` module (#594) so this rotation-aware layer and the single-secret
 * machine-to-machine endpoints all run the same timing-safe path.
 */
import { bearerToken, timingSafeEqual } from "@/lib/bearer-auth";

export interface ApiKey {
  /** Stable label for logs — "primary" or "secondary". Never the secret. */
  id: "primary" | "secondary";
  secret: string;
}

export type AuthResult =
  | { ok: true; keyId: ApiKey["id"] }
  | { ok: false; status: 401 | 503; error: string };

/**
 * WHICH refusal the shared authorizer made (#1429).
 *
 * The authorizer used to hand the route a ready-made response and nothing else,
 * so two opposite things sat behind one branch: a rotated key (the bot cannot
 * book at all, every lead it handles is refused) and a rate ceiling trip (one
 * caller going too fast, which is what the ceiling is for). They want opposite
 * treatment, and nothing downstream could tell them apart.
 */
export const AUTH_REFUSAL_REASONS = [
  /** 503: no key is configured, so the endpoint is effectively off. */
  "not_configured",
  /** 401: the credential is missing, malformed, or no longer one of ours. */
  "bad_credential",
  /** 429: the per-key ceiling, burst or hourly. */
  "throttled_key",
  /** 429: the coarse per-IP backstop, so one host cannot spend the whole budget. */
  "throttled_ip",
] as const;

export type AuthRefusalReason = (typeof AUTH_REFUSAL_REASONS)[number];

/** Which entry point refused: the booking write, or the bookable read. */
export type AuthSurface = "write" | "read";

/** What the failure-rate window (#1313) is told about one refusal, if anything. */
export type AuthRefusalCounting =
  | { kind: "error"; code: string }
  | { kind: "none"; why: string };

/**
 * Map the authenticator's own status onto the reason, so the classification is
 * DERIVED from the refusal that was actually made rather than guessed again at the
 * call site. Two things that must agree cannot both be authoritative (L53).
 */
export function refusalReasonForStatus(status: number): AuthRefusalReason {
  return status === 503 ? "not_configured" : "bad_credential";
}

/**
 * Whether a refusal reaches the booking-failure-rate window, and under what code.
 *
 * The rule that decides it (from src/lib/booking/refusal-catalog.ts): `attempts`
 * is every recorded outcome summed, so what gets counted is not a free choice.
 * Recording a noisy caller's refusals would put its volume in the DENOMINATOR the
 * failure share is measured against, making a real outage look proportionally
 * smaller exactly while it is happening.
 *
 * So the credential refusals are counted, under distinct codes because the repair
 * differs (a wrong key versus a secret nobody set), and the throttles are
 * deliberately not. Every reason has an explicit answer: a lookup keyed on a
 * vocabulary silently takes its default branch for the entry nobody added, and a
 * default is indistinguishable from a deliberate choice (L113).
 */
export function authRefusalCounting(
  reason: AuthRefusalReason,
  surface: AuthSurface,
): AuthRefusalCounting {
  if (surface === "read") {
    // The bookable check shares this authorizer. Its refusals stay out of the
    // window for the reason the catalog already keeps read traffic out: the share
    // is a share of BOOKING attempts. Nothing is lost, because a key that cannot
    // read cannot write either, and the write path IS counted.
    return {
      kind: "none",
      why:
        "The bookable read shares the authorizer, and the failure share is a share of booking " +
        "attempts. A rotated key refuses the write path too, which is counted, so leaving reads " +
        "out costs no visibility and keeps read volume out of the denominator.",
    };
  }
  switch (reason) {
    case "bad_credential":
      return { kind: "error", code: "API_KEY_REJECTED" };
    case "not_configured":
      return { kind: "error", code: "API_NOT_CONFIGURED" };
    case "throttled_key":
    case "throttled_ip":
      return {
        kind: "none",
        why:
          "A ceiling trip is one caller going faster than the budget allows, which is what the " +
          "ceiling exists to shape. Counting it would put that caller's volume in the denominator " +
          "the failure share is measured against, diluting the share a real outage has to move, " +
          "so the counting would actively hurt. Every trip is logged with its scope. What WOULD " +
          "change this decision is a SUSTAINED trip on the write path, which would mean the " +
          "ceiling is wrong for the bot's real volume rather than that the caller is abusive: " +
          "that is a capacity question, and it needs attempts against the ceiling, which this " +
          "counter cannot express.",
      };
  }
}

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
