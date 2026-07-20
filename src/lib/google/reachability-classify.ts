import { GoogleHttpError } from "@/lib/google/http-error";

export type Reachability = "reachable" | "gone" | "transient";

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
 * whose reason is a rate limit is transient too, NOT gone (#917). Pure +
 * dependency-free so the node runner can import it directly.
 */
export function classifyGoogleStatus(
  status: number | undefined,
  reason?: string,
): Exclude<Reachability, "reachable"> {
  if (status === 403 && reason && RATE_LIMIT_REASONS.has(reason.toLowerCase())) return "transient";
  if (status === 400 || status === 401 || status === 403 || status === 404) return "gone";
  return "transient";
}

/** Map a caught probe error to gone/transient: a GoogleHttpError carries the
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
