/**
 * Confirms losing the overlap race, counted and whispered (#2838).
 *
 * Since #2281 a confirm whose insert loses the overlap race (#2274) is handed to
 * the next free advisor in the same rung, up to `MAX_RACE_REASSIGNS`, before the
 * lead is asked to pick another time. Until this, the loss was recorded only in
 * `routing_trace.race_lost` and a log line kept for seven days that nothing reads,
 * so the same slot being handed to several leads at once, or leads being refused
 * at the bound, would have been invisible after cutover.
 *
 * WHERE THE COUNT COMES FROM. The daily booking outcome tally (#418), not the
 * bookings table. A confirm REFUSED after a race writes no booking and no routing
 * decision, so `routing_trace.race_lost` can only ever see the rescued half, and a
 * count built on it would read quietest exactly when leads are being turned away.
 * The tally takes a free text outcome, so three names beside the existing ones
 * (`RACE_TALLY_OUTCOMES`) record both halves with no migration. They sit OUTSIDE
 * `OUTCOME_ORDER`, so they never enter the failure share's denominator, which is
 * the same trick the self inflicted refusals use. And numerator and denominator
 * then come from one read of one table on one day boundary with the smoke canary
 * and off site testers excluded exactly as the failure rate excludes them (L711).
 *
 * THE THRESHOLD IS DERIVED, not typed. A confirm loses the race only when another
 * confirm lands on the same advisor at an overlapping time inside the moment
 * between the live free check and the insert. Measured, that moment is at most the
 * confirm's p95 of 2,280ms (the booking load run, 2026-09-11), and the busiest
 * traffic Slate can receive is the whole Low tier at a median of 29 leads an hour
 * (#2484, 27,122 real leads over 14 days). If EVERY one of those leads converged
 * on one advisor at one time, the chance that another confirm arrives inside a
 * given confirm's race window is 29 / 3600 x 2.28, about 1.8 percent. That is the
 * worst organic traffic can do, since leads are not confirms and do not all pick
 * one time, so a share above it says something other than ordinary traffic is
 * converging on the same times: a link being replayed, a burst from one source, or
 * confirms slow enough that the race window itself has widened.
 *
 * THE FLOOR IS DERIVED TOO (L716). Below 1 / 1.8 percent, 55 confirms, a single
 * coincidence is the whole threshold on its own, so the share cannot tell noise
 * from a problem and the day is `unmeasured`. A loser floor of three keeps one or
 * two unlucky pairs from ever reporting. Saturation (half or more losing, with the
 * loser floor met) reports below the confirm floor, because a proportion floor
 * that silences noise also silences a total failure (L139).
 *
 * A BOUND HIT IS LOUDER. A lead refused after `MAX_RACE_REASSIGNS + 1` advisors in
 * a row were taken by other confirms is a lead turned away while the rung was still
 * handing out advisors, and five confirms converging on one time inside a couple of
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
 *  - `race_reassigned`: a booking made after its first advisor lost the race;
 *  - `race_refused`: refused after a lost race with nobody after the loser free;
 *  - `race_refused_bound`: refused at `MAX_RACE_REASSIGNS`, the bound hit.
 */
export const RACE_TALLY_OUTCOMES = ["race_reassigned", "race_refused", "race_refused_bound"] as const;
export type RaceTallyOutcome = (typeof RACE_TALLY_OUTCOMES)[number];

/** #2484: median Low leads an hour across the whole tier, the busiest traffic Slate can see. */
export const MEASURED_TIER_LEADS_PER_HOUR = 29;

/** The booking load run of 2026-09-11 (#2261): confirm p95, the widest a race window measured. */
export const MEASURED_CONFIRM_P95_MS = 2280;

/** The share of confirms losing a race that the worst organic traffic can produce. */
export const RACE_SHARE_THRESHOLD = (MEASURED_TIER_LEADS_PER_HOUR / 3_600_000) * MEASURED_CONFIRM_P95_MS;

/** Below this many confirms one coincidence is the whole threshold, so nothing is judged. */
export const RACE_MIN_CONFIRMS = Math.ceil(1 / RACE_SHARE_THRESHOLD);

/** Fewer losers than this never report, whatever the share. */
export const RACE_MIN_LOSERS = 3;

/** At or above this share the confirm floor stops mattering (L139). */
export const RACE_SATURATION_SHARE = 0.5;

/** Which tally row a successful confirm adds, or null for an uncontested one. */
export function raceOutcomeForBooking(
  trace: { race_lost?: string[] } | null | undefined,
): RaceTallyOutcome | null {
  return trace?.race_lost && trace.race_lost.length > 0 ? "race_reassigned" : null;
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
  /** Bookings made after the first advisor lost the race. */
  reassigned: number;
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
  const refused = read("race_refused");
  const refusedAtBound = read("race_refused_bound");
  if (created === null || reassigned === null || refused === null || refusedAtBound === null) return null;
  return { day, created, reassigned, refused, refusedAtBound };
}

export type RaceContentionVerdict =
  /** Nothing judged. Never an all clear (L98). */
  | { kind: "unmeasured"; reason: string }
  /** Measured, and within what ordinary traffic produces. */
  | { kind: "quiet"; confirms: number; losers: number }
  /** Measured, and above it. */
  | {
      kind: "report";
      window: RaceContentionWindow;
      confirms: number;
      losers: number;
      share: number;
      trigger: "rate" | "saturation";
    };

/** Judge one window. */
export function raceContentionVerdict(w: RaceContentionWindow | null): RaceContentionVerdict {
  if (!w) return { kind: "unmeasured", reason: "the booking outcome tally could not be read" };
  if (w.reassigned > w.created) {
    return {
      kind: "unmeasured",
      reason: `counted ${w.reassigned} reassigned bookings out of ${w.created} made, which cannot be right`,
    };
  }
  const confirms = w.created + w.refused + w.refusedAtBound;
  const losers = w.reassigned + w.refused + w.refusedAtBound;
  if (confirms === 0) {
    return { kind: "unmeasured", reason: `nothing was booked on ${w.day}, so there is no rate to judge` };
  }
  const share = losers / confirms;
  if (losers >= RACE_MIN_LOSERS && share >= RACE_SATURATION_SHARE) {
    return { kind: "report", window: w, confirms, losers, share, trigger: "saturation" };
  }
  if (confirms < RACE_MIN_CONFIRMS) {
    return {
      kind: "unmeasured",
      reason: `${confirms} confirms on ${w.day}, fewer than the ${RACE_MIN_CONFIRMS} a race share needs`,
    };
  }
  if (losers >= RACE_MIN_LOSERS && share > RACE_SHARE_THRESHOLD) {
    return { kind: "report", window: w, confirms, losers, share, trigger: "rate" };
  }
  return { kind: "quiet", confirms, losers };
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** The daily whisper: the numbers, the rule they break, and what to look at. */
export function raceContentionNoticeText(v: Extract<RaceContentionVerdict, { kind: "report" }>): string {
  const w = v.window;
  const refusedTotal = w.refused + w.refusedAtBound;
  const refusedLine =
    refusedTotal === 0
      ? "None were refused."
      : `${refusedTotal} were refused and asked to pick another time` +
        (w.refusedAtBound > 0
          ? `, ${w.refusedAtBound} of them after every advisor they were handed was taken as well.`
          : ".");
  return (
    `Confirms losing the overlap race on ${w.day} (Eastern): ${v.losers} of ${v.confirms} (${pct(v.share)}) ` +
    `lost their advisor to another lead confirming the same time, above the ${pct(RACE_SHARE_THRESHOLD)} ` +
    `that even the busiest tier's measured traffic, all converging on one time, would produce. ` +
    `${w.reassigned} were handed to the next free advisor in the same bucket and booked. ${refusedLine} ` +
    `What to do: look at today's bookings whose routing_trace carries race_lost, by start time and bucket. ` +
    `Many leads confirming one time points at a booking link being replayed or a burst from one source; ` +
    `races spread across many times points at slow confirms widening the race, so check verify on book ` +
    `latency.` +
    (refusedTotal > 0 ? ` The refused ones made no booking and are in the logs under tag=booking.` : "")
  );
}

/** The bound hit page, sent from the confirm path the moment a lead is refused at the bound. */
export function raceBoundHitPageText(p: { bucketCode: string; startIso: string; lostRaces: number }): string {
  const ms = parseStampMs(p.startIso);
  const when = ms === null ? p.startIso : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return (
    `A lead confirming ${when} in bucket ${p.bucketCode} was refused after ${p.lostRaces} advisors in a row ` +
    `were taken by other leads confirming the same time, the most a confirm is handed on before it gives up. ` +
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
  bucketCode: string;
  startIso: string;
  lostRaces: number;
}): { key: string; cooldownMs: number; text: string } | null {
  if (!p.boundHit || p.isTest || p.loadtest) return null;
  return {
    key: RACE_BOUND_HIT_ALERT_KEY,
    cooldownMs: RACE_BOUND_HIT_COOLDOWN_MS,
    text: raceBoundHitPageText({ bucketCode: p.bucketCode, startIso: p.startIso, lostRaces: p.lostRaces }),
  };
}
