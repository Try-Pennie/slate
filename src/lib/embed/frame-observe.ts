/**
 * How the framing record is written without handing its write volume to whoever sends
 * the requests (#3137, L498).
 *
 * Every framed booker load is observed, and the request is unauthenticated with a
 * Referer the caller chooses, so a naive recorder is one database write per request,
 * for any origin anybody cares to invent. This one keeps counts in memory per isolate
 * and writes them in batches:
 *
 *  - A host is written AT ONCE the first time this isolate sees it today, so a partner
 *    who frames the booker once is recorded even if the isolate is gone a minute later.
 *  - After that its loads are batched and written at most once per `FRAME_OBSERVE_FLUSH_MS`.
 *  - At most `FRAME_OBSERVE_MAX_KEYS` hosts outside the exact allow list get a name of
 *    their own per isolate per day; past that they are counted together as `(other)`.
 *    The production hosts, `self` and `unstated` are never folded, and are a fixed,
 *    small set. A localhost port is allowed but NOT exact, since a caller can mint one
 *    per port, so it counts like any other host.
 *
 * So a flood of invented origins costs at most `FRAME_OBSERVE_MAX_KEYS` writes plus one
 * per window per isolate, and a bounded map. The cost is that counts still pending when
 * an isolate is evicted are lost, so the loads column is a lower bound; first sightings,
 * the fact the allow list decision rests on, are not.
 *
 * A failed write puts its counts back, so the next flush carries them (L368), and starts
 * a backoff (`FRAME_OBSERVE_RETRY_MIN_MS`, doubling) so an outage is not hit once per load.
 *
 * Pure apart from its injected write, scheduler and clock: scripts/test-frame-observe.ts.
 */
import { allowListMatch, type FrameSurface } from "@/lib/embed/frame-policy";

/**
 * The zone the record's days are keyed in, passed to `record_frame_origins` and read
 * back by the admin page. It is BUSINESS_ZONE; written out rather than imported because
 * the middleware imports this module and the module holding BUSINESS_ZONE brings a date
 * library with it. scripts/test-frame-observe.ts holds the two equal.
 */
// zone-ok: the org's business day, the same value as BUSINESS_ZONE, pinned by a test
export const FRAME_DAY_ZONE = "America/New_York";

/** How often an isolate writes its batched counts. */
export const FRAME_OBSERVE_FLUSH_MS = 30_000;

/**
 * After a failed write, no write is attempted for this long, doubling on each further
 * failure up to `FRAME_OBSERVE_FLUSH_MS` and reset by a success. Without it, a pending
 * first sighting would send a failing write on every framed load while the database is
 * down.
 */
export const FRAME_OBSERVE_RETRY_MIN_MS = 2_000;

/** Hosts outside the exact allow list one isolate names per day before folding. */
export const FRAME_OBSERVE_MAX_KEYS = 50;

/** One row of a batch, as `record_frame_origins` reads it. */
export interface FramingBatchRow {
  origin: string;
  surface: string;
  loads: number;
  /** Counts against the database's per day cap on distinct hosts. */
  capped: boolean;
}

/** The calendar day in FRAME_DAY_ZONE, the boundary the database keys rows by, so a
 *  first sighting here and a new row there begin on the same day. Intl rather than a
 *  date library, because the middleware loads this module on every request. */
const dayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: FRAME_DAY_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Hosts that always get a row of their own: a fixed set, so not an attacker's to grow.
 *  Judged by the same predicate as the lock (`allowListMatch`); only an EXACT match is
 *  fixed, since a `:*` source admits a fresh port per request. */
function uncapped(origin: string): boolean {
  return (
    origin === "self" ||
    origin === "unstated" ||
    origin === "(other)" ||
    allowListMatch(origin) === "exact"
  );
}

/** Keeps a write alive past the response: the request's own `waitUntil`, which is why it
 *  is passed per call rather than fixed when the recorder is made. */
export type Defer = (work: Promise<unknown>) => void;

export function makeFramingRecorder(deps: {
  write: (rows: FramingBatchRow[]) => Promise<void>;
  now: () => number;
  onError: (err: unknown) => void;
}): (obs: { origin: string; surface: FrameSurface | string }, defer: Defer) => void {
  let pending = new Map<string, FramingBatchRow>();
  let lastFlushMs = -Infinity;
  let inFlight = false;
  // Backoff after a failed write: no write before `retryAtMs`, and the next wait.
  let retryAtMs = -Infinity;
  let backoffMs = FRAME_OBSERVE_RETRY_MIN_MS;
  let day = "";
  // (host, page) keys whose first sighting today has been WRITTEN. Marked only after
  // the write succeeds, so a failed one is retried at the next flush, not lost (L368).
  let written = new Set<string>();
  // Capped HOSTS this isolate has named today, the set a caller could try to grow.
  let cappedHosts = new Set<string>();

  const keyOf = (row: { origin: string; surface: string }) => `${row.origin}|${row.surface}`;

  const add = (row: FramingBatchRow) => {
    const key = keyOf(row);
    const prev = pending.get(key);
    if (prev) prev.loads += row.loads;
    else pending.set(key, { ...row });
  };

  const flush = (defer: Defer) => {
    // One write in flight per isolate, so a failing database is not hit once per load.
    if (inFlight || pending.size === 0 || deps.now() < retryAtMs) return;
    const batch = [...pending.values()];
    pending = new Map();
    lastFlushMs = deps.now();
    inFlight = true;
    const batchDay = day;
    defer(
      deps
        .write(batch)
        .then(
          () => {
            backoffMs = FRAME_OBSERVE_RETRY_MIN_MS;
            if (batchDay === day) for (const row of batch) written.add(keyOf(row));
          },
          (err) => {
            deps.onError(err);
            for (const row of batch) add(row);
            retryAtMs = deps.now() + backoffMs;
            backoffMs = Math.min(backoffMs * 2, FRAME_OBSERVE_FLUSH_MS);
          },
        )
        .finally(() => {
          inFlight = false;
        }),
    );
  };

  /** A key whose first sighting has not landed yet: flushed at once, never batched. */
  const unwrittenPending = () => [...pending.keys()].some((k) => !written.has(k));

  return (obs, defer) => {
    const today = dayKey.format(deps.now());
    if (today !== day) {
      day = today;
      written = new Set();
      cappedHosts = new Set();
    }

    let origin = obs.origin;
    if (!uncapped(origin) && !cappedHosts.has(origin)) {
      if (cappedHosts.size < FRAME_OBSERVE_MAX_KEYS) cappedHosts.add(origin);
      else origin = "(other)";
    }

    add({ origin, surface: obs.surface, loads: 1, capped: !uncapped(origin) });
    if (unwrittenPending() || deps.now() - lastFlushMs >= FRAME_OBSERVE_FLUSH_MS) flush(defer);
  };
}
