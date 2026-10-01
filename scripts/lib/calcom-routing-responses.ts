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

/**
 * Where the measured span ends, read from MEASURE_END (#2888, #2494): blank is the
 * moment of the run. Since the split went to 50/50 on every tier (2026-10-01 15:46
 * UTC) cal.com takes about half of each tier, so a span ending now measures half
 * the traffic it claims to and has to be pinned before the split, or scaled.
 *
 * Refused by name: anything unreadable, an instant with no zone (local time on the
 * machine running it would move the end by hours, silently), and an end after the
 * run, which would read cal.com's future as zero traffic (L50).
 */
export function measureEndOrRefusal(
  raw: string,
  nowMs: number,
): { ok: true; endMs: number } | { ok: false; refusal: string } {
  const text = raw.trim();
  if (!text) return { ok: true, endMs: nowMs };
  const refuse = (why: string) => ({
    ok: false as const,
    refusal: `FAILED (bad-input): MEASURE_END ${why}, for example 2026-10-01T15:45:00Z; nothing was read`,
  });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    return refuse("must be an instant carrying its zone");
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return refuse("must be an instant carrying its zone");
  if (ms > nowMs) return refuse("must not be later than now");
  return { ok: true, endMs: ms };
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
