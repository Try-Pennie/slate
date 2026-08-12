import { GoogleHttpError } from "@/lib/google/http-error";
import type { FailureKind } from "@/lib/google/sync-health";

// `isDefinitiveFailure` lives in sync-health.ts, which is import-free, so the
// every-minute sync coalescer can reach the predicate without pulling this
// module's Google dependency in behind it. Re-exported here because the
// reachability callers already import their vocabulary from this file.
export { isDefinitiveFailure } from "@/lib/google/sync-health";

/**
 * Derived from `FailureKind` rather than restated, so the two vocabularies cannot
 * drift: a probe either reached the calendar or failed in one of the ways a sync
 * can fail (#1396).
 */
export type Reachability = FailureKind | "reachable";

/**
 * The reason Google returns when the account exists but has never been given
 * Calendar (#1396): `403 notACalendarUser`, "The user must be signed up for
 * Google Calendar".
 *
 * Its own outcome, not `gone`, because the two need DIFFERENT people doing
 * different things: a gone account is a credential or membership repair (re-auth,
 * or take them out of the pool), and this one is a Workspace admin ticking a box.
 * Every message about it was previously telling the reader to fix a credential
 * problem that does not exist, and new hires reaching Slate before their Google
 * provisioning completes make this the expected case rather than a curiosity.
 *
 * Lowercased at the comparison, because Google's casing of a reason string is not
 * a contract we should depend on.
 */
export const NOT_A_CALENDAR_USER_REASON = "notACalendarUser";

// Google returns 403 for BOTH a genuine permission failure (gone) AND a rate
// limit (transient), disambiguated only by the error `reason` (#917).
const RATE_LIMIT_REASONS = new Set([
  "ratelimitexceeded",
  "userratelimitexceeded",
  "quotaexceeded",
]);

/**
 * Classify a failed Google calendar probe from its HTTP status (#913). A
 * definitive account or permission failure means the connection is genuinely
 * GONE (account removed from the Workspace, domain-wide delegation revoked, or
 * the calendar not found); anything else (5xx, or a network/timeout error that
 * carries no status) is TRANSIENT and worth a retry before we give up. A 403
 * whose reason is a rate limit is transient too, NOT gone (#917), and a 403
 * whose reason is `notACalendarUser` is NOT-PROVISIONED, which is definitive like
 * gone but fixed by a different person doing a different thing (#1396). Pure +
 * dependency-free so the node runner can import it directly.
 */
export function classifyGoogleStatus(
  status: number | undefined,
  reason?: string,
): Exclude<Reachability, "reachable"> {
  const lower = reason?.toLowerCase();
  if (status === 403 && lower && RATE_LIMIT_REASONS.has(lower)) return "transient";
  // Checked before the general 4xx rule below, which would otherwise swallow it
  // as gone (#1396).
  if (lower === NOT_A_CALENDAR_USER_REASON.toLowerCase()) return "not-provisioned";
  if (status === 400 || status === 401 || status === 403 || status === 404) return "gone";
  return "transient";
}

/** Map a caught probe error to a failure kind: a GoogleHttpError carries the
 *  status (and reason) to classify; anything else (network, timeout/abort) is
 *  transient. */
export function reachabilityFromError(err: unknown): Exclude<Reachability, "reachable"> {
  if (err instanceof GoogleHttpError) return classifyGoogleStatus(err.status, err.reason);
  return classifyGoogleStatus(undefined);
}

/** Pull the machine-readable reason out of a Google error response body. Handles
 *  the calendar API shape ({ error: { errors: [{ reason }] } }) and the OAuth
 *  token shape ({ error: "..." }). Returns undefined on anything unparseable. */
export function parseGoogleErrorReason(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { errors?: Array<{ reason?: string }> };
    };
    const err = parsed?.error;
    if (typeof err === "string") return err;
    const reason = err?.errors?.[0]?.reason;
    return reason ? String(reason) : undefined;
  } catch {
    return undefined;
  }
}
