/**
 * The carrier between `McpBookingGateway` (worker/index.ts) and Slate's internal
 * booking route (#3543, plan locked decision 1).
 *
 * `worker/index.ts` and the OpenNext bundle are separate builds, so nothing the
 * entrypoint holds in memory reaches a Next route. The carrier is the inner Request
 * itself, the `LogShippingReceipt` precedent: the gateway builds a request to an
 * INTERNAL path carrying Marcia's signed token and a gateway secret header, and hands
 * it straight to the app's handler, in process, never over the network.
 *
 * Two checks keep that path private, independent of each other (L345):
 *  - the public fetch handler refuses every internal MCP path, and strips the carrier
 *    headers from every public request (`isInternalMcpPath` with `internalMcpRefusal`,
 *    and `stripCarrierHeaders`);
 *  - the internal route itself compares the gateway secret, constant time, and
 *    refuses when it is missing on the deployment.
 *
 * Pure and import free: the Worker entry and the Next route both import it.
 */

/** Every internal MCP path starts with this; the public handler refuses it. */
export const INTERNAL_MCP_PREFIX = "/api/internal/mcp-";
/** Marcia's internal booking routes, one per operation. */
export const MARCIA_INTERNAL_PREFIX = "/api/internal/mcp-booking/";

export const GATEWAY_SECRET_HEADER = "x-slate-mcp-gateway-secret";
export const LEAD_TOKEN_HEADER = "x-slate-mcp-lead-token";
/** Every header the carrier uses, all stripped from a public request. */
export const CARRIER_HEADERS = [GATEWAY_SECRET_HEADER, LEAD_TOKEN_HEADER] as const;

/** The env name of the secret the gateway and the internal route share. */
export const GATEWAY_SECRET_ENV = "MCP_BOOKING_GATEWAY_SECRET";

/** The path an operation's internal route answers on (`find_times` is `find-times`). */
export function marciaInternalPath(operation: string): string {
  return `${MARCIA_INTERNAL_PREFIX}${operation.replace(/_/g, "-")}`;
}

/** Whether a public request's path is an internal MCP path. An unreadable URL is refused too. */
export function isInternalMcpPath(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return true;
  }
  // Decoded and case folded, so `/api/Internal/%6Dcp-booking` is not a way round it.
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, "/").startsWith(INTERNAL_MCP_PREFIX);
}

/** The answer the public handler gives an internal MCP path: the same 404 an unknown path gets. */
export function internalMcpRefusal(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** The request with every carrier header removed, or the same request when it carried none. */
export function stripCarrierHeaders(request: Request): Request {
  if (!CARRIER_HEADERS.some((h) => request.headers.has(h))) return request;
  const headers = new Headers(request.headers);
  for (const h of CARRIER_HEADERS) headers.delete(h);
  return new Request(request, { headers });
}
