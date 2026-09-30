/**
 * The measure commands' pacing helpers. The reader itself, `extractCode` and `tierOf`
 * live in `src/lib/calcom/routing-responses.ts` since #2893, so the Worker's daily
 * refit and these commands count cal.com's traffic through one reader.
 */
export {
  readRoutingResponses,
  tierOf,
  type RoutingReadResult,
  type RoutingResponse,
} from "../../src/lib/calcom/routing-responses.ts";

/**
 * The pause between cal.com pages, read from MEASURE_PACE_MS, or null when it
 * cannot be read. Unguarded, a typo becomes NaN, which a timer reads as no wait at
 * all, and the run meets cal.com's rate limit on every page instead of refusing
 * (L50). One reader for both commands that page through this module.
 */
export function paceMsOrNull(raw: string): number | null {
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The refusal both commands print for an unreadable pace, so it reads the same. */
export const PACE_REFUSAL = "FAILED (bad-input): MEASURE_PACE_MS must be a number of milliseconds, 0 or more";


/**
 * The GET both measure commands page cal.com with, sending the version the reader
 * names (#2893). One copy, so the two commands cannot drift apart on how they ask.
 */
export function calcomGetter(key: string): (path: string, apiVersion: string) => Promise<{ status: number; json: unknown }> {
  return async (path, apiVersion) => {
    const res = await fetch(`https://api.cal.com/v2${path}`, {
      headers: { Authorization: `Bearer ${key}`, "cal-api-version": apiVersion },
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };
}
