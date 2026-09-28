/**
 * Bearer auth for the direct booking API (#355). Pure + IO-free so it unit-tests
 * under `node --experimental-strip-types` and stays out of the route's Next/
 * Supabase/Google surface. The route reads the two configured secrets from env,
 * builds the key set with `parseApiKeys`, and gates every request through
 * `authenticateBearer`.
 *
 * #2645: one key per CALLER. Each caller in `BOOKING_API_CALLERS` holds its own
 * secret, and each has two slots (primary + secondary) so its secret rotates with
 * zero downtime: add the new secret as the secondary, point the caller at it, then
 * retire the old primary. `shared` is the original pair, which Regal and the
 * canary held together before the split; it stays accepted so nothing breaks
 * before the named keys are handed out. Each authenticated call reports the
 * matched CALLER and slot (labels, never the secret), so the rate ceiling and the
 * logs can say who made a request rather than which of two shared slots it used.
 *
 * The constant-time comparison + `Bearer` parsing live in the shared
 * `bearer-auth` module (#594) so this rotation-aware layer and the single-secret
 * machine-to-machine endpoints all run the same timing-safe path.
 */
import { bearerToken, timingSafeEqual } from "@/lib/bearer-auth";
import { isPublicTestBucket } from "@/lib/embed/public-test-bucket";

/**
 * Every system that holds a booking API key (#2645). Named callers come first so
 * that, if two callers were ever handed the same value by mistake, the request is
 * attributed to the named one rather than to the legacy pair.
 */
export const BOOKING_API_CALLERS = ["regal", "trypennie", "canary", "shared"] as const;
export type BookingApiCaller = (typeof BOOKING_API_CALLERS)[number];
export type NamedBookingApiCaller = Exclude<BookingApiCaller, "shared">;

/**
 * Who may call the smoke endpoints. They can stamp the canary's own heartbeat and
 * reach the hidden test buckets, so a partner key there could keep a dead canary
 * looking alive. The shared key left once the canary was seen on its own (#2854),
 * because Regal still holds it.
 */
export const CANARY_CALLERS: readonly BookingApiCaller[] = ["canary"];

/**
 * Whether an authenticated caller may book (or check) a test bucket through the
 * key-authed API (#2669). The hidden test buckets are the canary's own (#396), so
 * only `CANARY_CALLERS` may reach them, the same set the availability route lets
 * READ them: a partner key used to be able to write where it could not read. The
 * PUBLIC test bucket (#2660) exists for partners and is open to every caller, and
 * that string check authorises the public code alone, never any other. A refused
 * caller gets the same UnknownBucketError an unknown code gets, from the service.
 */
export function mayBookTestBuckets(caller: BookingApiCaller, bucketCode: string): boolean {
  return CANARY_CALLERS.includes(caller) || isPublicTestBucket(bucketCode);
}

export type KeySlot = "primary" | "secondary";

/**
 * The environment variable holding one caller's slot. `shared` keeps the names
 * the Worker has always had; every other caller is suffixed, so the whole set
 * follows one rule and `scripts/test-booking-api-auth.ts` can hold `env.ts` to it.
 */
export function bookingApiKeyEnvName(caller: BookingApiCaller, slot: KeySlot): string {
  const base = caller === "shared" ? "BOOKING_API_KEY" : `BOOKING_API_KEY_${caller.toUpperCase()}`;
  return slot === "primary" ? base : `${base}_2`;
}

export interface ApiKey {
  caller: BookingApiCaller;
  slot: KeySlot;
  /** Stable label for logs, `<caller>:<slot>`. Never the secret. */
  id: `${BookingApiCaller}:${KeySlot}`;
  secret: string;
}

/** One caller's two configured slots, as read from the environment. */
export interface CallerSecrets {
  caller: BookingApiCaller;
  primary: string;
  secondary: string;
}

export type AuthResult =
  | { ok: true; keyId: ApiKey["id"]; caller: BookingApiCaller }
  /**
   * `tokenPresent` (#1450) separates two things a 401 cannot: a caller that sent
   * a Bearer token which is not one of ours, and a request that carried no usable
   * credential at all.
   *
   * The endpoint is public, so anything crawling the internet produces the second
   * kind continuously. A signal that could not tell them apart would page on
   * background noise, and an alert that cries wolf gets ignored (L36). A PRESENT
   * and wrong token is the one that means a real integration is locked out.
   */
  | { ok: false; status: 401 | 503; error: string; tokenPresent: boolean };

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
 * Build the labelled key set from each caller's two slots, skipping any that are
 * unset or blank. A whitespace-only value is treated as unset, never a usable
 * secret. Named callers are ordered before `shared` whatever order they arrive in.
 */
export function parseApiKeys(callers: readonly CallerSecrets[]): ApiKey[] {
  const rank = (c: BookingApiCaller) => BOOKING_API_CALLERS.indexOf(c);
  const keys: ApiKey[] = [];
  for (const entry of [...callers].sort((a, b) => rank(a.caller) - rank(b.caller))) {
    for (const slot of ["primary", "secondary"] as const) {
      const secret = entry[slot];
      if (secret.trim()) keys.push({ caller: entry.caller, slot, id: `${entry.caller}:${slot}`, secret });
    }
  }
  return keys;
}

/**
 * Verify a Bearer Authorization header against the configured keys. Fails CLOSED
 * with 503 when NO key is configured (the endpoint is effectively disabled),
 * distinct from 401 for a present-but-wrong credential. On success, reports which
 * caller and slot matched.
 */
export function authenticateBearer(
  header: string | null,
  keys: ApiKey[],
): AuthResult {
  if (keys.length === 0) {
    // No key configured, so nothing about the request was even looked at.
    return { ok: false, status: 503, error: "booking api not configured", tokenPresent: false };
  }
  const token = bearerToken(header);
  if (token !== null) {
    for (const key of keys) {
      if (timingSafeEqual(token, key.secret)) {
        return { ok: true, keyId: key.id, caller: key.caller };
      }
    }
  }
  return { ok: false, status: 401, error: "unauthorized", tokenPresent: token !== null };
}
