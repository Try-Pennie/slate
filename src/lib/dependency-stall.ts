/**
 * When Google and Supabase stall together, suspect the location first (#3784, L774).
 *
 * Placement pins every fetch Slate serves to the Cloudflare colos beside Oregon
 * (`aws:us-west-2`, #3730), so a degraded colo there slows EVERY dependency at once,
 * with no healthy location in Slate's own traffic to compare against. A page that
 * names whichever call happened to be in flight then sends the reader to Google or to
 * Supabase when neither is the fault. Two unrelated services stalling in the same
 * minutes is the tell, so the booking timeout page and the Google breaker page both
 * ask this one predicate before naming a service (L261).
 *
 * WHAT A STALL IS. One call that took `DEPENDENCY_STALL_MS` or longer, answered or
 * not. Measured against what these calls normally take: Supabase answers placed
 * requests in about 21ms (docs/cloudflare-platform-notes.md), and the confirm's Google
 * token mint ran at a daily p99 of 191 to 338ms over 2026-10-15 to 10-22 (#4081), with
 * the cron lanes' Google tail reaching about 1.9s. Two seconds is past every one of
 * those tails, and far below the deadlines (Google 8s, the confirm's 12s budget), so a
 * stall is seen well before anything times out.
 *
 * TWO SCOPES, ONE PREDICATE. The booking timeout page judges one confirm's own calls
 * (its profile's slowest call per dependency). The breaker page has no confirm, so it
 * reads this isolate's memory of recent calls: every call made inside a call budget
 * reports its span here (`fetchWithinBudget`), and a Supabase stall within
 * `STALLED_TOGETHER_WINDOW_MS` of the breaker opening counts as the same minutes. The
 * memory is per isolate, the same posture as the breaker itself
 * (`src/lib/google/breaker.ts`): an isolate runs in one colo, so its own calls are the
 * ones that shared the location.
 *
 * What that leaves out (L93): Supabase calls outside any budget, which are the cron
 * lanes' statements. Those can take 7.9s while healthy (`SUPABASE_FETCH_TIMEOUT_MS`),
 * and counting them would pin a real Google outage on the location. So a degraded
 * location while no confirm is running still reads as Google on the breaker page,
 * which is the page as it was before #3784, and the booking timeout page, judged per
 * confirm, is unaffected.
 */

/** One call this long or longer is a stall. See the module comment for the measurements. */
export const DEPENDENCY_STALL_MS = 2_000;

/**
 * How recent a Supabase stall must be for the breaker page to call it the same
 * minutes as Google's failures. The breaker opens after five consecutive failures,
 * which the every minute lanes alone can spread across five minutes.
 */
export const STALLED_TOGETHER_WINDOW_MS = 5 * 60_000;

/** True when one call took long enough to count as a stall; no call is never one (L90). */
export function isStall(ms: number | null | undefined): boolean {
  return typeof ms === "number" && ms >= DEPENDENCY_STALL_MS;
}

export interface StalledTogether {
  /** The slowest Google call, in ms. */
  googleMs: number;
  /** The slowest Supabase call, in ms. */
  supabaseMs: number;
}

/**
 * Both services stalled, from each one's slowest call, or null when either did not
 * (or made no call, which measured nothing). Only then does the page suspect the
 * location; one service stalling alone keeps the blame it earned.
 */
export function stalledTogether(slowest: { google: number | null; supabase: number | null }): StalledTogether | null {
  if (!isStall(slowest.google) || !isStall(slowest.supabase)) return null;
  return { googleMs: slowest.google!, supabaseMs: slowest.supabase! };
}

interface Memory {
  /** The most recent stall, or null when none was seen. */
  stall: { ms: number; at: number } | null;
  /** The colo this dependency's most recent ANSWER came from (`cf-ray`), if any said. */
  colo: string | null;
}

/** Per isolate. A Map, so a first word like `constructor` is just a key (L738). */
const memory = new Map<string, Memory>();

/** The dependency a call label names: its first word (`supabase`, `google`). */
function dependencyOf(label: string): string {
  return label.split(" ")[0] || label;
}

/**
 * Note one call this isolate made: its label, how long it took, when it ended, and
 * the colo its answer came from (null when it did not answer or named none). Only a
 * stall and the latest colo are kept, so the memory stays one entry per dependency.
 */
export function noteDependencyCall(label: string, ms: number, at: number, colo: string | null): void {
  const key = dependencyOf(label);
  const held = memory.get(key) ?? { stall: null, colo: null };
  if (colo) held.colo = colo;
  if (isStall(ms)) held.stall = { ms, at };
  memory.set(key, held);
}

/**
 * The most recent stall of `dependency` in this isolate within `windowMs` of `now`,
 * with the colo its answers last came from, or null when there was none.
 */
export function recentStall(
  dependency: string,
  now: number,
  windowMs: number = STALLED_TOGETHER_WINDOW_MS,
): { ms: number; at: number; colo: string | null } | null {
  const held = memory.get(dependency);
  if (!held?.stall || now - held.stall.at > windowMs) return null;
  return { ms: held.stall.ms, at: held.stall.at, colo: held.colo };
}

/** Forget every call noted so far. For tests. */
export function forgetDependencyCalls(): void {
  memory.clear();
}
