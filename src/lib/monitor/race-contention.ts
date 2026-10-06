/**
 * Confirms losing the overlap race, counted and whispered (#2838).
 *
 * Since #2281 a confirm whose insert loses the overlap race (#2274) is handed to
 * the next free advisor in the same rung, and since #3338 on down the tier ladder
 * when nobody after it in that rung is free, up to `MAX_RACE_REASSIGNS` advisors in
 * all, before the lead is asked to pick another time. Until this, the loss was recorded only in
 * `routing_trace.race_lost` and a log line kept for seven days that nothing reads,
 * so the same slot being handed to several leads at once, or leads being refused
 * at the bound, would have been invisible after cutover.
 *
 * WHERE THE COUNT COMES FROM. The daily booking outcome tally (#418), not the
 * bookings table. A confirm REFUSED after a race writes no booking and no routing
 * decision, so `routing_trace.race_lost` can only ever see the rescued half, and a
 * count built on it would read quietest exactly when leads are being turned away.
 * The tally takes a free text outcome, so the race names beside the existing ones
 * (`RACE_TALLY_OUTCOMES`) record both halves with no migration. They sit OUTSIDE
 * `OUTCOME_ORDER`, so they never enter the failure share's denominator, which is
 * the same trick the self inflicted refusals use. And numerator and denominator
 * then come from one read of one table on one day boundary with the smoke canary
 * and off site testers excluded exactly as the failure rate excludes them (L711).
 *
 * THE THRESHOLD IS DERIVED, not typed. A confirm loses the race only when another
 * confirm lands on the same advisor at an overlapping time inside the moment
 * between the live free check and the insert. Measured, that moment is at most the
 * confirm's p95 of 2,280ms (the booking load run, 2026-09-11). The arrival rate is
 * the BUSIEST TIER SLATE ACTUALLY CARRIES (#2877), measured from its own routed
 * bookings: each debt tier's median busy hour over the last
 * `RACE_RATE_LOOKBACK_DAYS`, and the busiest of those. If EVERY one of those
 * confirms converged on one advisor at one time, the chance that another arrives
 * inside a given confirm's race window is rate / 3600 x 2.28. That is the worst
 * organic traffic can do, since confirms do not all pick one time, so a share above
 * it says something other than ordinary traffic is converging on the same times: a
 * link being replayed, a burst from one source, or confirms slow enough that the
 * race window itself has widened.
 *
 * Measured rather than typed because which tier is busiest changes as the flip
 * widens. It started as a constant for the Low tier, 29 leads an hour (#2484,
 * 27,122 real leads over 14 days), a premise that stops holding the day another
 * tier routes through Slate. Bookings rather than leads, because a race is between
 * CONFIRMS and every booking is one. With too few bookings to take a median of
 * (fewer than `RACE_RATE_MIN_ACTIVE_HOURS` separate hours in every tier) the Low
 * constant is the fallback, and the verdict and the whisper both SAY it was used
 * and why, so a threshold nobody measured is never presented as one somebody did.
 *
 * The measurement is read only when it can change what is sent
 * (`raceThresholdNeeded`): below the loser floor nothing can report, and a
 * saturated day reports whatever the threshold. Fourteen days of bookings is
 * several pages at full volume, and reading it every five minutes to decide
 * nothing would spend the lane's budget on a number that moves over days.
 *
 * THE FLOOR IS DERIVED TOO (L716), and apart from the share (#2886). A loser floor
 * of three keeps one or two unlucky pairs from ever reporting. The confirm floor
 * (`RACE_MIN_CONFIRMS`, seven) is the first day size where three losers is still
 * short of saturation, so the share rule decides the day; below it the day is
 * `unmeasured`. It was one over the share until #2886, which rose to hundreds of
 * confirms at pilot volume and left nearly every pilot day unjudged. Saturation (half or
 * more losing, with the loser floor met) reports below the confirm floor, because
 * a proportion floor that silences noise also silences a total failure (L139).
 *
 * A BOUND HIT IS LOUDER. A lead refused after `MAX_RACE_REASSIGNS + 1` advisors in
 * a row were taken by other confirms (counted across every rung it walked, #3338)
 * is a lead turned away while the ladder was still handing out advisors, and five
 * confirms converging on one time inside a couple of
 * seconds is two orders of magnitude past the derived share. So it is paged at the
 * moment it happens (`raceBoundHitPageText`, sent from the confirm path), as an
 * INCIDENT on the alerts channel: that lead has gone and there is no healthy state
 * to announce. It is also counted in the daily whisper. Paging it from this lane
 * instead would have meant either a day's cooldown, holding back a second day's
 * page for up to a day, or a short one, re-paging the same lead every hour of the
 * day on a daily counter.
 *
 * NO VERDICT STAMP, deliberately, for the reason `catchall-rate.ts` gives: before
 * cutover no lead reaches Slate and this reads `unmeasured` every tick, which is the
 * correct answer rather than a blindness to page about (L129). Its liveness comes
 * from the monitor lane's step boundary and the lane watchdog.
 *
 * Imports only relative, type only modules, so `scripts/test-race-contention.ts`
 * drives every branch node natively; the reading and the sending are the caller's.
 */
import type { RawMix } from "./booking-api-outcome.ts";
import { parseStampMs } from "../date/stamp.ts";
import { DEBT_TIER } from "../xbc.ts";

/** alert_state key for the daily whisper. One constant for sender, catalog and preview. */
export const RACE_CONTENTION_NOTICE_KEY = "booking_race_contention";

/** alert_state key for the bound hit page, apart from the whisper so neither throttles the other. */
export const RACE_BOUND_HIT_ALERT_KEY = "booking_race_bound_hit";

/** Once a day: the window it reads is the Eastern day so far. */
export const RACE_CONTENTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** A burst of bound hits sends one page; a burst an hour later is a new one. */
export const RACE_BOUND_HIT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * The tally rows a race records, beside the ordinary outcome of the same confirm:
 *  - `race_reassigned`: a booking made on the create arm after its first advisor
 *    lost the race, so a `created` row always sits beside it. Since #3338 the
 *    booking can be on a rung below the one the race was lost on;
 *  - `race_reassigned_move`: a cross bucket move made after its first advisor
 *    lost the race (#2867). Its ordinary outcome row is `rescheduled` or
 *    `deduped`, never `created`, so it counts as a confirm AND a loser itself;
 *  - `race_refused`: refused after a lost race below the bound. Since #3338 that
 *    means nobody after the loser was free on its rung OR on any rung below it, or
 *    the rest could not be asked (a live check that could not answer, a named
 *    link, an adopted pin). Before #3338 it also counted leads refused while a
 *    rung below still had somebody free, so a day either side of the change is not
 *    the same measure;
 *  - `race_refused_bound`: refused at `MAX_RACE_REASSIGNS`, the bound hit.
 *
 * A confirm that lost a race and had too little of its budget left to walk down
 * (#3338) is answered with the retryable dependency timeout, and counted there,
 * not here: it was not refused, and no row above describes it.
 */
export const RACE_TALLY_OUTCOMES = [
  "race_reassigned",
  "race_reassigned_move",
  "race_refused",
  "race_refused_bound",
] as const;
export type RaceTallyOutcome = (typeof RACE_TALLY_OUTCOMES)[number];

/** #2484: median Low leads an hour across the whole tier. The FALLBACK rate, used
 *  only while Slate holds too few bookings to measure its own (#2877). */
export const MEASURED_TIER_LEADS_PER_HOUR = 29;

/** The booking load run of 2026-09-11 (#2261): confirm p95, the widest a race window measured. */
export const MEASURED_CONFIRM_P95_MS = 2280;

/** How far back the busiest tier's rate is measured: the span #2484 measured over. */
export const RACE_RATE_LOOKBACK_DAYS = 14;

/**
 * The fewest separate hours holding a booking a tier needs before its median hour
 * is a rate. Below a day's worth of hours the median rests on a handful of hours
 * and one burst hour moves it. The Low pilot page's measured 18 leads an hour
 * clears it within its first few business days.
 */
export const RACE_RATE_MIN_ACTIVE_HOURS = 24;

/** Fewer losers than this never report, whatever the share. */
export const RACE_MIN_LOSERS = 3;

/** At or above this share the confirm floor stops mattering (L139). */
export const RACE_SATURATION_SHARE = 0.5;

/**
 * The fewest confirms a day needs before it is judged (#2886): the first day size
 * at which reaching `RACE_MIN_LOSERS` is still BELOW saturation, so the share rule,
 * and not saturation alone, is what decides the day. Seven, with today's loser floor
 * and saturation share.
 *
 * It used to be one over the share, which was sized for the wrong job: it stopped a
 * single coincidence from carrying the share on its own, which the loser floor
 * already does. And it moved the wrong way with traffic. At the pilot's measured six
 * bookings an hour the share is about 0.4%, so the floor rose to 264 confirms and
 * nearly every pilot day read unmeasured, leaving only saturation able to report.
 *
 * What a day needs to be statistically meaningful is that a report from it cannot
 * be coincidence, and the loser floor gives that at this size: if every confirm
 * raced at the worst case share (all of them converging on one time), three losers
 * in seven confirms has a chance far under 1% at the pilot rate, at the Low
 * fallback, and at twice the Low rate (`scripts/test-race-contention.ts` computes
 * the Poisson tail at each). A bigger day only makes three losers MORE likely by
 * chance, so raising the floor buys no confidence a report does not already have;
 * past it the share rule is what holds a large day to ordinary traffic.
 */
export const RACE_MIN_CONFIRMS = Math.floor(RACE_MIN_LOSERS / RACE_SATURATION_SHARE) + 1;

/** Any arrival rate as a share and a confirm floor, through the one race window.
 *  The floor is the same at every rate (#2886); it travels with the threshold so a
 *  verdict can name the floor it was judged against. */
export function raceThresholdForRate(perHour: number): { share: number; minConfirms: number } {
  const share = (perHour / 3_600_000) * MEASURED_CONFIRM_P95_MS;
  return { share, minConfirms: RACE_MIN_CONFIRMS };
}

/** The share the Low constant gives: the fallback when Slate cannot measure its own. */
export const FALLBACK_RACE_SHARE_THRESHOLD = raceThresholdForRate(MEASURED_TIER_LEADS_PER_HOUR).share;

/** The confirm floor at the fallback share. */
export const FALLBACK_RACE_MIN_CONFIRMS = raceThresholdForRate(MEASURED_TIER_LEADS_PER_HOUR).minConfirms;

/** What a day is judged against, and where that came from. */
export interface RaceThreshold {
  /** Confirms an hour the share is derived from. */
  perHour: number;
  share: number;
  minConfirms: number;
  basis:
    | {
        source: "measured";
        /** The first XBC digit. */
        tier: string;
        tierLabel: string;
        /** Separate hours that held one of the tier's bookings. */
        activeHours: number;
        /** The tier's bookings the median rests on. */
        bookings: number;
      }
    | { source: "fallback"; reason: string };
}

/** The Low constant's threshold, carrying why it was used. */
export function fallbackRaceThreshold(reason: string): RaceThreshold {
  return {
    perHour: MEASURED_TIER_LEADS_PER_HOUR,
    ...raceThresholdForRate(MEASURED_TIER_LEADS_PER_HOUR),
    basis: { source: "fallback", reason },
  };
}

/** One routed customer booking, reduced to what the rate needs. */
export interface TierBooking {
  createdMs: number;
  bucketCode: string | null;
}

const HOUR_MS = 3_600_000;

/**
 * The bookings window the rate is measured over, clipped to whole hours at BOTH
 * ends: it starts on the hour `RACE_RATE_LOOKBACK_DAYS` before the hour under
 * way, and ends where that hour begins. A window starting at exactly now minus 14
 * days would hold part of its first hour and count it as a full, quiet one, and
 * the hour under way is partial the same way (L696, L709). The store reads this
 * window and the measurement counts this window, so the two cannot drift apart.
 */
export function raceRateWindow(nowMs: number): { sinceMs: number; untilMs: number } {
  const untilMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  return { sinceMs: untilMs - RACE_RATE_LOOKBACK_DAYS * 24 * HOUR_MS, untilMs };
}

/** The same quantile `pnpm measure:lead-hours` reports, so the two agree on "median". */
function medianOf(sorted: number[]): number {
  return sorted[Math.floor(0.5 * (sorted.length - 1))]!;
}

/**
 * The threshold from the busiest tier Slate carries (#2877). Counts each tier's
 * bookings per UTC hour over the `RACE_RATE_LOOKBACK_DAYS` before `nowMs`, keeps
 * only hours that held one (a night is not a slow hour, and folding nights in
 * would halve every rate), and takes each tier's median hour. The busiest is the
 * highest median among tiers with at least `RACE_RATE_MIN_ACTIVE_HOURS`, since a
 * tier with a few burst hours is noise rather than the busiest traffic.
 *
 * The hour still under way is left out (L696): it is a partial count and would
 * read as a slow hour. A code whose first digit is not a tier, and a stamp that
 * cannot be read, are left out rather than guessed at.
 */
export function measuredRaceThreshold(bookings: readonly TierBooking[], nowMs: number): RaceThreshold {
  const win = raceRateWindow(nowMs);
  const currentHour = win.untilMs / HOUR_MS;
  const firstHour = win.sinceMs / HOUR_MS;
  const byTier = new Map<string, Map<number, number>>();
  let counted = 0;
  for (const b of bookings) {
    if (!Number.isFinite(b.createdMs)) continue;
    const tier = b.bucketCode?.[0];
    if (!tier || !DEBT_TIER[tier]) continue;
    const hour = Math.floor(b.createdMs / HOUR_MS);
    if (hour < firstHour || hour >= currentHour) continue;
    const hours = byTier.get(tier) ?? new Map<number, number>();
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
    byTier.set(tier, hours);
    counted++;
  }
  if (counted === 0) {
    return fallbackRaceThreshold(`Slate made no routed bookings in the last ${RACE_RATE_LOOKBACK_DAYS} days`);
  }
  let best: { tier: string; median: number; activeHours: number; bookings: number } | null = null;
  let mostHours = 0;
  for (const [tier, hours] of byTier) {
    const counts = [...hours.values()].sort((a, b) => a - b);
    mostHours = Math.max(mostHours, counts.length);
    if (counts.length < RACE_RATE_MIN_ACTIVE_HOURS) continue;
    const median = medianOf(counts);
    const total = counts.reduce((s, n) => s + n, 0);
    // A tied median gives the same threshold either way; the larger tier names it.
    if (!best || median > best.median || (median === best.median && total > best.bookings)) {
      best = { tier, median, activeHours: counts.length, bookings: total };
    }
  }
  if (!best) {
    return fallbackRaceThreshold(
      `no tier's Slate bookings fell in ${RACE_RATE_MIN_ACTIVE_HOURS} separate hours over the last ` +
        `${RACE_RATE_LOOKBACK_DAYS} days (the most was ${mostHours}), too few to take a median of`,
    );
  }
  return {
    perHour: best.median,
    ...raceThresholdForRate(best.median),
    basis: {
      source: "measured",
      tier: best.tier,
      tierLabel: DEBT_TIER[best.tier]!.label,
      activeHours: best.activeHours,
      bookings: best.bookings,
    },
  };
}

/** Which tally row a successful confirm adds, or null for an uncontested one. */
export function raceOutcomeForBooking(
  trace: { race_lost?: string[] } | null | undefined,
): RaceTallyOutcome | null {
  return trace?.race_lost && trace.race_lost.length > 0 ? "race_reassigned" : null;
}

/**
 * Which tally row a confirm that returned a booking adds, or null. Only when THIS
 * confirm's own insert made the booking (`newlyInserted`): a replay returns an
 * earlier confirm's booking, whose race was counted when that confirm made it.
 * The one judge for the booker, the booking API's create arm and its cross bucket
 * move (#2861), so the three cannot disagree about when a race counts.
 */
export function raceOutcomeForConfirm(r: {
  booking: { routing_trace?: { race_lost?: string[] } | null };
  newlyInserted?: true;
}): RaceTallyOutcome | null {
  return r.newlyInserted ? raceOutcomeForBooking(r.booking.routing_trace) : null;
}

/**
 * Which tally row a cross bucket move that returned a booking adds, or null
 * (#2867). The same judge as a create, on its own row: a move's ordinary outcome
 * is `rescheduled` or `deduped`, so counting it as `race_reassigned` would put a
 * loser in the window with no `created` behind it.
 */
export function raceOutcomeForMove(r: Parameters<typeof raceOutcomeForConfirm>[0]): RaceTallyOutcome | null {
  return raceOutcomeForConfirm(r) ? "race_reassigned_move" : null;
}

/** Which tally row a confirm refused after a lost race adds. */
export function raceOutcomeForRefusal(r: { boundHit: boolean }): RaceTallyOutcome {
  return r.boundHit ? "race_refused_bound" : "race_refused";
}

export interface RaceContentionWindow {
  /** The Eastern day the counts cover, so far. */
  day: string;
  /** Bookings made, contested or not. */
  created: number;
  /** Bookings made on the create arm after the first advisor lost the race. */
  reassigned: number;
  /** Cross bucket moves made after the first advisor lost the race (#2867). */
  reassignedMoves: number;
  /** Confirms refused after a lost race, below the bound. */
  refused: number;
  /** Confirms refused at the bound. */
  refusedAtBound: number;
}

/** Read the window out of the outcome mix, or null when it cannot be read. An
 *  absent key is a real zero (the RPC aggregates only rows that exist); a present
 *  key that is not a count is a broken read, never a zero. */
export function raceWindowFromMix(raw: RawMix | null | undefined, day: string): RaceContentionWindow | null {
  const by = raw?.by_outcome;
  if (!by || typeof by !== "object") return null;
  const read = (k: string): number | null => {
    const v = (by as Record<string, unknown>)[k];
    if (v === undefined) return 0;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  };
  const created = read("created");
  const reassigned = read("race_reassigned");
  const reassignedMoves = read("race_reassigned_move");
  const refused = read("race_refused");
  const refusedAtBound = read("race_refused_bound");
  if (
    created === null ||
    reassigned === null ||
    reassignedMoves === null ||
    refused === null ||
    refusedAtBound === null
  ) {
    return null;
  }
  return { day, created, reassigned, reassignedMoves, refused, refusedAtBound };
}

export type RaceContentionVerdict =
  /** Nothing judged. Never an all clear (L98). The threshold is present when the
   *  day was too thin for the confirm floor it sets. */
  | { kind: "unmeasured"; reason: string; threshold?: RaceThreshold }
  /** Measured, and within what ordinary traffic produces. */
  | { kind: "quiet"; confirms: number; losers: number; threshold: RaceThreshold }
  /** Measured, and above it. */
  | {
      kind: "report";
      window: RaceContentionWindow;
      confirms: number;
      losers: number;
      share: number;
      trigger: "rate" | "saturation";
      threshold: RaceThreshold;
    };

/** Every confirm in the window, and every one that lost at least one race. A
 *  rescued move is both, with no `created` row behind it (#2867). */
function raceCounts(w: RaceContentionWindow): { confirms: number; losers: number } {
  const refusedTotal = w.refused + w.refusedAtBound;
  return {
    confirms: w.created + w.reassignedMoves + refusedTotal,
    losers: w.reassigned + w.reassignedMoves + refusedTotal,
  };
}

/** The create arm's own invariant: its rescues are among its own bookings. */
function brokenRead(w: RaceContentionWindow): boolean {
  return w.reassigned > w.created;
}

/**
 * Whether the day's verdict can turn on the threshold, so the caller measures it
 * only then. False below the loser floor (nothing can report), on a saturated day
 * (it reports whatever the threshold), and on a window that is unreadable, broken
 * or empty. When false the caller still hands the verdict a threshold, the
 * fallback, which then only decides whether a thin day reads as quiet or
 * unmeasured, and the verdict says the fallback was used.
 */
export function raceThresholdNeeded(w: RaceContentionWindow | null): boolean {
  if (!w || brokenRead(w)) return false;
  const { confirms, losers } = raceCounts(w);
  if (confirms === 0 || losers < RACE_MIN_LOSERS) return false;
  return losers / confirms < RACE_SATURATION_SHARE;
}

/**
 * The threshold the lane judges a day against: measured from `readBookings` when
 * the verdict can turn on it, otherwise the fallback, saying why. A failed read
 * propagates to the step boundary rather than becoming a fallback, because a
 * whisper stating the Low constant "because Slate has too few bookings" off a read
 * that never ran would be a claim nothing measured (L11).
 */
export async function raceThresholdFor(
  w: RaceContentionWindow | null,
  readBookings: () => Promise<readonly TierBooking[]>,
  nowMs: number,
): Promise<RaceThreshold> {
  if (!raceThresholdNeeded(w)) {
    return fallbackRaceThreshold(
      `the day could not turn on the threshold, so the busiest tier's rate was not measured`,
    );
  }
  return measuredRaceThreshold(await readBookings(), nowMs);
}

/**
 * The lane's whole decision for one tick (PR #2883): at most one bookings read
 * per whisper decision. A day that can turn on the threshold stays that way for
 * the rest of the day, and the whisper sends at most once per cooldown, so without
 * this every five minute tick after the first report would page through a
 * fortnight of bookings to build a message the throttle then drops.
 *
 * The cooldown is asked only on such a day, so an ordinary tick costs nothing
 * extra. While it is running the day is NOT judged, rather than judged against a
 * threshold nobody measured, and the result says so.
 *
 * A qualifying day that stays UNDER the share never sends, so the cooldown never
 * starts and would not stop the read. So the measured threshold is also kept for
 * the Eastern day it was measured on (`cache`): one read per day per isolate. The
 * rate is a fortnight's median, which one day cannot move enough to matter. A
 * failed read throws to the step boundary and caches nothing, so the next tick
 * tries again rather than judging on a threshold nobody measured.
 */
export async function judgeRaceContention(
  w: RaceContentionWindow,
  nowMs: number,
  deps: {
    readBookings: () => Promise<readonly TierBooking[]>;
    whisperDue: () => Promise<boolean>;
    cache: RaceThresholdCache;
  },
): Promise<
  | { kind: "judged"; verdict: RaceContentionVerdict; threshold: RaceThreshold }
  | { kind: "cooling-down" }
> {
  const needed = raceThresholdNeeded(w);
  if (needed && !(await deps.whisperDue())) return { kind: "cooling-down" };
  let threshold = needed ? deps.cache.get(w.day) : null;
  if (!threshold) {
    threshold = await raceThresholdFor(w, deps.readBookings, nowMs);
    if (needed) deps.cache.set(w.day, threshold);
  }
  return { kind: "judged", verdict: raceContentionVerdict(w, threshold), threshold };
}

/** The measured threshold for one Eastern day, so a day measures at most once. */
export interface RaceThresholdCache {
  get(day: string): RaceThreshold | null;
  set(day: string, threshold: RaceThreshold): void;
}

/** A cache holding only the latest day, so it never grows. */
export function createRaceThresholdCache(): RaceThresholdCache {
  let entry: { day: string; threshold: RaceThreshold } | null = null;
  return {
    get: (day) => (entry && entry.day === day ? entry.threshold : null),
    set: (day, threshold) => {
      entry = { day, threshold };
    },
  };
}

/** Judge one window against a threshold. */
export function raceContentionVerdict(
  w: RaceContentionWindow | null,
  threshold: RaceThreshold,
): RaceContentionVerdict {
  if (!w) return { kind: "unmeasured", reason: "the booking outcome tally could not be read" };
  if (brokenRead(w)) {
    return {
      kind: "unmeasured",
      reason: `counted ${w.reassigned} reassigned bookings out of ${w.created} made, which cannot be right`,
    };
  }
  const { confirms, losers } = raceCounts(w);
  if (confirms === 0) {
    return { kind: "unmeasured", reason: `nothing was booked on ${w.day}, so there is no rate to judge` };
  }
  const share = losers / confirms;
  if (losers >= RACE_MIN_LOSERS && share >= RACE_SATURATION_SHARE) {
    return { kind: "report", window: w, confirms, losers, share, trigger: "saturation", threshold };
  }
  if (confirms < threshold.minConfirms) {
    return {
      kind: "unmeasured",
      // No word about where the share came from: the floor is the same at every
      // rate since #2886, so naming the Low constant here would be a claim about a
      // floor it did not set (L11).
      reason: `${confirms} confirms on ${w.day}, fewer than the ${threshold.minConfirms} a race share needs`,
      threshold,
    };
  }
  if (losers >= RACE_MIN_LOSERS && share > threshold.share) {
    return { kind: "report", window: w, confirms, losers, share, trigger: "rate", threshold };
  }
  return { kind: "quiet", confirms, losers, threshold };
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

const wasWere = (n: number): string => (n === 1 ? "was" : "were");

/** The daily whisper: the numbers, the rule they break, and what to look at. */
export function raceContentionNoticeText(v: Extract<RaceContentionVerdict, { kind: "report" }>): string {
  const w = v.window;
  const t = v.threshold;
  const basis =
    t.basis.source === "measured"
      ? `that the busiest tier Slate carries (${t.basis.tierLabel}, a median of ${t.perHour} bookings an hour ` +
        `over the last ${RACE_RATE_LOOKBACK_DAYS} days), all converging on one time, would produce.`
      : `that the Low tier's measured lead volume (${t.perHour} an hour), all converging on one time, would ` +
        `produce. That is the fallback threshold, because ${t.basis.reason}.`;
  const rescued = w.reassigned + w.reassignedMoves;
  const refusedTotal = w.refused + w.refusedAtBound;
  const refusedLine =
    refusedTotal === 0
      ? "None were refused."
      : `${refusedTotal} ${wasWere(refusedTotal)} refused and asked to pick another time` +
        (w.refusedAtBound > 0
          ? `, ${w.refusedAtBound} of them after every advisor they were handed was taken as well.`
          : ".");
  return (
    `Confirms losing the overlap race on ${w.day} (Eastern): ${v.losers} of ${v.confirms} (${pct(v.share)}) ` +
    `lost their advisor to another lead confirming the same time, above the ${pct(t.share)} ${basis} ` +
    `${rescued} ${wasWere(rescued)} booked with the next free advisor, in the bucket they were confirming into or a tier below it. ${refusedLine} ` +
    `What to do: look at today's bookings whose routing_trace carries race_lost, by start time and bucket. ` +
    `Many leads confirming one time points at a booking link being replayed or a burst from one source; ` +
    `races spread across many times points at slow confirms widening the race, so check verify on book ` +
    `latency.` +
    (refusedTotal > 0 ? ` The refused ones made no booking and are in the logs under tag=booking.` : "")
  );
}

/**
 * The bound hit page, sent from the confirm path the moment a lead is refused at the
 * bound. `requestedCode` is the bucket the lead was confirming into and `bucketCode`
 * the one it was refused on, which differ when it walked down the ladder (#3338).
 */
export function raceBoundHitPageText(p: { requestedCode: string; bucketCode: string; startIso: string; lostRaces: number }): string {
  const ms = parseStampMs(p.startIso);
  const when = ms === null ? p.startIso : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const down = p.bucketCode === p.requestedCode ? "" : `, down to bucket ${p.bucketCode},`;
  return (
    `A lead confirming ${when} in bucket ${p.requestedCode} was refused after ${p.lostRaces} advisors in a row${down} ` +
    `were taken by other leads confirming the same time, the most a confirm is handed on, across every tier it walks, before it gives up. ` +
    `That many confirms on one time inside a couple of seconds is far past ordinary traffic, and the lead was ` +
    `asked to pick another time, so they may have gone. What to do: look at bookings in that bucket starting ` +
    `then, created within a few seconds of each other. One source replaying a booking link, or a burst the ` +
    `booking ceiling should have held, is the likely cause.`
  );
}

/**
 * Whether the confirm path pages a refusal, and with what. Null below the bound
 * (that refusal is counted in the daily whisper, not paged), for the smoke
 * canary's buckets, and under a load run, whose burst of simultaneous confirms at
 * one time is this exact shape by design. Decided here rather than inline so the
 * rule is tested where the send is not observable.
 */
export function raceBoundHitPage(p: {
  boundHit: boolean;
  isTest: boolean;
  loadtest: boolean;
  requestedCode: string;
  bucketCode: string;
  startIso: string;
  lostRaces: number;
}): { key: string; cooldownMs: number; text: string } | null {
  if (!p.boundHit || p.isTest || p.loadtest) return null;
  return {
    key: RACE_BOUND_HIT_ALERT_KEY,
    cooldownMs: RACE_BOUND_HIT_COOLDOWN_MS,
    text: raceBoundHitPageText({ requestedCode: p.requestedCode, bucketCode: p.bucketCode, startIso: p.startIso, lostRaces: p.lostRaces }),
  };
}
