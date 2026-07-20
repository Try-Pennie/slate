import { GoogleHttpError } from "@/lib/google/http-error";

export type Reachability = "reachable" | "gone" | "transient";

/**
 * Classify a failed Google calendar probe from its HTTP status (#913). A
 * definitive account or permission failure means the connection is genuinely
 * GONE (account removed from the Workspace, domain-wide delegation revoked, or
 * the calendar not found); anything else (5xx, rate limit, or a network/timeout
 * error that carries no status) is TRANSIENT and worth a retry before we give
 * up. Pure + dependency-free so the node runner can import it directly.
 */
export function classifyGoogleStatus(status: number | undefined): Exclude<Reachability, "reachable"> {
  if (status === 400 || status === 401 || status === 403 || status === 404) return "gone";
  return "transient";
}

/** Map a caught probe error to gone/transient: a GoogleHttpError carries the
 *  status to classify; anything else (network, timeout/abort) is transient. */
export function reachabilityFromError(err: unknown): Exclude<Reachability, "reachable"> {
  const status = err instanceof GoogleHttpError ? err.status : undefined;
  return classifyGoogleStatus(status);
}
