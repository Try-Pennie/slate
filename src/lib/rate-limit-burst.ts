/**
 * The second ceiling on every public edge limiter, the one a concurrent burst cannot spread
 * across (#1536 for availability, #1556 for the rest).
 *
 * Measured against production on 2026-08-17, from one machine, same address, same second:
 *
 * | shape                                              | requests | blocked |
 * |----------------------------------------------------|----------|---------|
 * | 45 sequential down one keep-alive socket, 1.06s    | 45       | 16, first at 30 |
 * | 60 fired in parallel into one datacenter, 1.1s     | 60       | 0 |
 *
 * That is how Cloudflare's native limiter counts, and the code comment already called it
 * permissive. The point is that the gap is much larger than permissive suggests: the practical
 * guarantee on the one endpoint anybody on the internet can reach without authentication is not
 * 30 a minute, it is 30 a minute PER ISOLATE, which a burst spreads across trivially. That
 * endpoint is a cache read, so what a flood actually costs is CPU and subrequest budget shared
 * with the cron lanes (#1245, #1246), not database load.
 *
 * The design keeps the fast check first and free, and adds two things behind it:
 *
 *   1. **An exact in-isolate count.** JavaScript is single threaded, so incrementing a Map is
 *      deterministic in a way an eventually consistent datacenter counter is not: sixty
 *      concurrent requests reaching one isolate ARE sixty increments. This costs nothing and
 *      is what notices a burst at all.
 *   2. **A Durable Object holding ONE count per address**, consulted only once an address looks
 *      hot. A DO is the only primitive here that can hold a single count across isolates, and
 *      restricting it to hot addresses is what keeps the hot path's no-round-trip property:
 *      an ordinary lead's page loads never reach it.
 *
 * The numbers that decide whether this is safe rather than merely strict have their reasoning
 * beside them rather than in a plan nobody will read again. The one worth arguing about is the
 * ceiling, and it is deliberately NOT in this file: it is per endpoint, on that endpoint's entry
 * in `EDGE_LIMITERS` (`@/lib/rate-limit-core`), because its whole safety argument is its ratio
 * to the sustained limit it backs up. Each sits far ABOVE that limit on purpose, because a large
 * office behind one NAT address is a real Pennie lead source, and today's gap is the only reason
 * those leads are not already being turned away. Making the sustained number exact would ship a
 * refusal to them. This is a flood backstop, not a tightening.
 */

/** The window every count and ceiling here is stated in. */
export const BURST_WINDOW_MS = 60_000;

/**
 * How busy an address has to look in ONE isolate before we spend a round trip on it, for the
 * LEAD FACING limiters. Machine to machine ones derive their own (see `burstEscalateAt`).
 *
 * Never blocks anything: it only decides whose requests get counted properly. A lead loading
 * the booker costs one availability call, and the closure search adds another, so 20 in a
 * minute is already far outside one person's use while staying well inside what a shared office
 * address can legitimately produce.
 */
export const BURST_ESCALATE_AT = 20;

/**
 * Where a MACHINE TO MACHINE limiter escalates, as a multiple of its own sustained per minute
 * limit (#1565).
 *
 * `BURST_ESCALATE_AT` above was sized for a lead loading the booker, and since #1556 it was
 * also the threshold for the booking API, whose read path is allowed 600 a minute. So an
 * integrator polling well inside its allowance escalated permanently and paid a Durable Object
 * round trip per memo window (about one a second) for as long as it was busy, to be counted
 * precisely while doing nothing wrong.
 *
 * The derivation: escalate once ONE isolate has seen the caller's whole sustained allowance.
 * The in-isolate count is a lower bound on what the datacenter saw, so past that point the
 * caller is already beyond what the native limiter is meant to let through, which is exactly
 * when its approximate count stops being trustworthy and the exact one is worth paying for.
 * Below it, a caller is by definition inside its budget and counting it precisely buys
 * nothing. One times, not a fraction, because the cost being removed is paid by callers who
 * are inside their limit.
 *
 * What this gives up, stated so nobody rediscovers it: a burst spread so that every isolate
 * stays under the sustained limit is never escalated, so for these limiters the burst ceiling
 * is reached only once some isolate crosses that line. These callers are authenticated (or, for
 * the per address backstop, sit under an authenticated key), and the EXACT hourly caps in
 * Postgres (`DIRECT_BOOKING_API_*_HOURLY_RATE_RULES`) still bound them regardless.
 *
 * Lead facing limiters keep `BURST_ESCALATE_AT`: their sustained limits (3 to 30 a minute) are
 * small enough that the shared number is already at or near them.
 */
export const MACHINE_ESCALATE_SUSTAINED_MULTIPLE = 1;

/** Who calls a limiter, which decides how its escalation point is derived. */
export type LimiterAudience = "lead" | "machine";

/**
 * The escalation point for one limiter (#1565). Never below the lead threshold, so a future
 * machine limiter with a tiny sustained limit cannot become MORE eager to pay round trips than
 * the lead facing ones.
 */
export function burstEscalateAt(spec: { audience: LimiterAudience; perMinute: number }): number {
  if (spec.audience === "lead") return BURST_ESCALATE_AT;
  return Math.max(BURST_ESCALATE_AT, spec.perMinute * MACHINE_ESCALATE_SUSTAINED_MULTIPLE);
}

/** One endpoint's limits, passed per call so one tracker per isolate serves them all. */
export interface BurstLimits {
  /** The burst ceiling for this endpoint, per key per minute. */
  ceilingPerMinute: number;
  /** How many requests one isolate sees in a window before it asks the shared counter. */
  escalateAt: number;
  /**
   * Called once when a key escalates in a window, with the in-isolate count at that moment, so
   * the escalation rate can be measured (#1565). Never given the decision.
   */
  onEscalate?: (count: number) => void;
}

/**
 * The ceiling itself is NOT here. It is per endpoint, and it lives on that endpoint's entry in
 * `EDGE_LIMITERS` (`@/lib/rate-limit-core`), beside the sustained limit it is a multiple of.
 *
 * #1556 is why: a single constant was right while only availability had a ceiling, and became
 * wrong the moment five more endpoints did, because the whole safety argument for a ceiling is
 * its RATIO to the sustained limit it backs up, and 300 means "ten times" next to availability's
 * 30 and "a hundred times" next to the booking confirm's 3. Stated apart from the number it is a
 * multiple of, it is a number nobody can check. `allow` therefore takes each endpoint's limits
 * per call (`BurstLimits`: its ceiling, its escalation point and the escalation callback).
 */

/**
 * How long a verdict may be reused before asking again.
 *
 * This window IS the leak, and it is also what stops a hot address costing a round trip per
 * request. One second bounds both: at most a second of one address's traffic is served on a
 * stale verdict, and the requests it covered are reported on the next ask rather than dropped,
 * so the shared count does not quietly under-count the traffic the ceiling exists to measure.
 */
export const BURST_MEMO_MS = 1_000;

/**
 * How many addresses one isolate will track.
 *
 * An isolate can be reused for a long time and an attacker can rotate addresses, so this map
 * needs a bound or it becomes the memory leak that the rate limiter caused. When the cap is
 * reached the whole map is dropped rather than evicting cleverly: losing the counts costs at
 * most one window of escalation for everybody being tracked, and the alternative is keeping an
 * LRU on a hot path to defend against a case that also has to pass the ceiling above.
 */
export const BURST_TRACKED_KEY_CAP = 5_000;

interface WindowCount {
  windowStartMs: number;
  count: number;
}

/**
 * Count this request against its key's current fixed window, and return the new count.
 *
 * Fixed windows rather than sliding: a sliding window needs the timestamps kept per request,
 * which on this path is the allocation an availability read is trying to avoid. A fixed window
 * lets twice the ceiling through across a boundary in the worst case, which at ten times the
 * edge limit is not the property under threat.
 */
export function burstWindowCount(
  counts: Map<string, WindowCount>,
  key: string,
  nowMs: number,
  windowMs: number,
): number {
  if (counts.size >= BURST_TRACKED_KEY_CAP && !counts.has(key)) counts.clear();
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const existing = counts.get(key);
  if (!existing || existing.windowStartMs !== windowStartMs) {
    counts.set(key, { windowStartMs, count: 1 });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

/** What the shared counter answers: the count for this address's current window, after the
 *  reported requests have been added to it. */
export interface BurstAskResult {
  count: number;
}

interface Memo {
  allowed: boolean;
  atMs: number;
}

interface Escalation {
  /** Requests seen since the last SUCCESSFUL report, which the next report must carry. */
  unreported: number;
  memo: Memo | null;
  /** The in-flight report, so a burst crossing the threshold shares one round trip. */
  inFlight: Promise<void> | null;
}

/**
 * The per-isolate half of the ceiling: count everything, escalate the hot addresses, and reuse
 * a verdict briefly so neither a busy office nor a flood costs a round trip per request.
 *
 * Fails OPEN, like every other limiter on these paths: a check we could not make must never
 * turn away a real lead loading the booker. The loud half of fail-open (the log and the Slack
 * alert) lives with the other limiters in `rate-limit.ts`; what this owns is the decision.
 */
export class BurstTracker {
  private readonly counts = new Map<string, WindowCount>();
  private readonly escalations = new Map<string, Escalation>();
  private readonly ask: (key: string, bump: number) => Promise<BurstAskResult>;

  constructor(deps: {
    /** Report `bump` requests for this key and read back the shared count. */
    ask: (key: string, bump: number) => Promise<BurstAskResult>;
  }) {
    this.ask = deps.ask;
  }

  /**
   * May this request be served?
   *
   * `key` carries the endpoint as well as the caller (see `burstKey`), and `limits` are that
   * endpoint's own ceiling and escalation point. Both are passed per call rather than fixed on
   * the tracker, so one tracker per isolate serves every endpoint while none of them can spend
   * another's allowance.
   */
  async allow(
    key: string,
    nowMs: number,
    limits: BurstLimits,
    /**
     * Called on an unreachable shared counter, so the caller can fail LOUD while this fails
     * open. Never given the decision: this class always serves the request.
     *
     * Per call rather than per tracker (#1556) because one tracker now serves every endpoint,
     * and a report that could not name which endpoint's ceiling stopped counting would send
     * the reader to the wrong one (L11).
     */
    onFailure?: (err: unknown) => void,
  ): Promise<boolean> {
    const count = burstWindowCount(this.counts, key, nowMs, BURST_WINDOW_MS);
    const { ceilingPerMinute, escalateAt } = limits;
    if (count <= escalateAt) {
      // The ordinary case, and the reason the hot path keeps its no-round-trip property.
      this.escalations.delete(key);
      return true;
    }

    let state = this.escalations.get(key);
    if (!state) {
      state = { unreported: 0, memo: null, inFlight: null };
      this.escalations.set(key, state);
      // The requests already counted in this window have not been reported to anyone, and the
      // first report has to carry them: an unreported request is one the shared count never
      // learns about, which is how a ceiling ends up measuring less than the traffic.
      state.unreported = count - 1;
      // Reported once per key per window (the state is dropped when the next window starts
      // below the threshold), so a hot key costs one line a minute, not one per request.
      limits.onEscalate?.(count);
    }
    state.unreported += 1;

    if (state.memo && nowMs - state.memo.atMs < BURST_MEMO_MS) return state.memo.allowed;

    // One flight per key. Without this, a burst crossing the threshold opens a round trip per
    // request to the same object: the slowest possible answer, and a self inflicted flood on
    // the very thing measuring the flood.
    if (state.inFlight) {
      await state.inFlight;
      return state.memo?.allowed ?? true;
    }

    const flight = (async () => {
      const bump = state!.unreported;
      try {
        const { count: shared } = await this.ask(key, bump);
        // Only clear what was actually reported: requests that arrived DURING the flight are
        // still owed to the next report.
        state!.unreported -= bump;
        state!.memo = { allowed: shared <= ceilingPerMinute, atMs: nowMs };
      } catch (err) {
        // Fail open, and keep the unreported count so an outage leaves no hole in it.
        onFailure?.(err);
        state!.memo = { allowed: true, atMs: nowMs };
      } finally {
        state!.inFlight = null;
      }
    })();
    state.inFlight = flight;
    await flight;
    return state.memo?.allowed ?? true;
  }
}

/**
 * The shared counter's own arithmetic, kept here rather than inside the Durable Object class.
 *
 * `worker/` is excluded from `tsconfig.json`, so anything that lives in the DO file is neither
 * typechecked nor reachable from either test harness. Keeping the decision here and leaving the
 * class as a shell around storage means the part that can be wrong is the part that is tested.
 */
export function bumpSharedWindow(
  stored: { windowStartMs: number; count: number } | null,
  bump: number,
  nowMs: number,
): { windowStartMs: number; count: number } {
  const windowStartMs = Math.floor(nowMs / BURST_WINDOW_MS) * BURST_WINDOW_MS;
  // A negative or absurd bump can only come from a caller bug, and it would let a flood talk
  // its own count down. Clamped rather than trusted.
  const safeBump = Number.isFinite(bump) ? Math.max(0, Math.floor(bump)) : 0;
  if (!stored || stored.windowStartMs !== windowStartMs) return { windowStartMs, count: safeBump };
  return { windowStartMs, count: stored.count + safeBump };
}

/**
 * The shared counter's key: the endpoint, then the caller.
 *
 * The Durable Object id is derived from this string, so the prefix is the entire reason two
 * endpoints do not share one count. #1556 chose one namespace with a prefixed key over a
 * namespace per endpoint: a namespace each would mean six Durable Object bindings, six
 * migration entries and six things for the monitor lane to check, for a separation a prefix
 * already gives completely. Without the prefix a lead's availability reads and their Confirm
 * tap would draw on ONE count, and the lower of the two ceilings would be spent by the other
 * endpoint's traffic (the same defect the unique `namespace_id` check catches for the native
 * bindings).
 */
export function burstKey(area: string, callerKey: string): string {
  return `${area}:${callerKey}`;
}

/**
 * The binding name the app looks up, and the class name wrangler binds it to.
 *
 * Constants rather than literals at the call site because four places have to agree on them
 * (wrangler.jsonc's binding, its migrations block, the worker entry's re-export, and the
 * lookup in `rate-limit.ts`) and none of the four can see the others.
 * `scripts/test-burst-ceiling.ts` compares them.
 *
 * Named `BURST_LIMITER` rather than `AVAIL_BURST_LIMITER` since #1556: it counts for every
 * edge limiter now, and a name saying otherwise is the kind of comment that outlives the thing
 * it describes. Renaming the BINDING is safe for the counts, because a Durable Object id is
 * derived within the namespace its CLASS defines, which is unchanged.
 */
export const BURST_LIMITER_BINDING = "BURST_LIMITER";
export const BURST_LIMITER_CLASS = "BurstLimiter";
