/**
 * Repeated failures into ONE page, and a single failure into none (#3670).
 *
 * A check that fails open (a rate limiter, the shared confirm line) is right to serve the
 * request it could not judge, and wrong to page a person for the first one: one failed count
 * is a finished event, and on 2026-10-13 `rate_limit_broken:landing:h` paged for exactly that
 * while the counter answered again minutes later (Dan: "we probably shouldn't alert on one
 * instance", L36). What is worth a page is the same failure again and again, which is what an
 * outage looks like from inside one isolate: it reaches every request there.
 *
 * So a failure is counted under a key inside a sliding window, and the one that brings the
 * count to `pageAfter` raises the page, at most once per `cooldownMs` per key. The count is
 * per ISOLATE, deliberately: a count across isolates needs a shared store written on the
 * request path for every failure, during exactly the outage it reports, and the store most
 * likely to be failing is the very one that would hold it (L345). The alert store still
 * throttles the page across isolates once it is sent.
 *
 * Bounded: at most `maxKept` failures are held per key, so a flood that fails every request
 * cannot grow the isolate's memory; `truncated` says older ones inside the window were dropped,
 * so copy built from `recent` can say "at least" rather than understate (L11).
 *
 * Pure (the time is passed in), so scripts/test-sustained-failure-gate.ts drives it.
 */

export interface SustainedFailureGateOptions {
  /** Failures inside the window, on one key, before it pages. At least 2: one is never a page. */
  pageAfter: number;
  /** The sliding window those failures must fall in. */
  windowMs: number;
  /** How long a key stays quiet once it has paged. */
  cooldownMs: number;
  /** The most failures held per key. Defaults to 1000. */
  maxKept?: number;
}

export interface SustainedFailureVerdict<T> {
  /** True only for the failure that makes the run sustained, outside the key's cooldown. */
  page: boolean;
  /** Failures held for this key inside the window, this one included. */
  inWindow: number;
  /** Those failures, oldest first. */
  recent: T[];
  /** Whether older failures inside the window were dropped to keep memory bounded. */
  truncated: boolean;
}

export interface SustainedFailureGate<T> {
  record(key: string, at: number, item: T): SustainedFailureVerdict<T>;
}

const DEFAULT_MAX_KEPT = 1000;

export function makeSustainedFailureGate<T>(opts: SustainedFailureGateOptions): SustainedFailureGate<T> {
  if (!Number.isInteger(opts.pageAfter) || opts.pageAfter < 2) {
    throw new Error(`a sustained failure gate needs pageAfter of at least 2, got ${opts.pageAfter}`);
  }
  const maxKept = Math.max(opts.maxKept ?? DEFAULT_MAX_KEPT, opts.pageAfter);
  const runs = new Map<string, { entries: { at: number; item: T }[]; truncated: boolean }>();
  const lastPagedAt = new Map<string, number>();

  return {
    record(key, at, item) {
      const run = runs.get(key) ?? { entries: [], truncated: false };
      // Oldest first, so expired failures are always at the front. A dropped failure is older
      // than every one kept, so once any kept one has left the window every dropped one has
      // too, and the count is exact again.
      while (run.entries.length > 0 && at - run.entries[0]!.at >= opts.windowMs) {
        run.entries.shift();
        run.truncated = false;
      }
      run.entries.push({ at, item });
      if (run.entries.length > maxKept) {
        run.entries.shift();
        run.truncated = true;
      }
      runs.set(key, run);

      const paged = lastPagedAt.get(key);
      const page =
        run.entries.length >= opts.pageAfter && (paged === undefined || at - paged >= opts.cooldownMs);
      if (page) lastPagedAt.set(key, at);
      return {
        page,
        inWindow: run.entries.length,
        recent: run.entries.map((e) => e.item),
        truncated: run.truncated,
      };
    },
  };
}
