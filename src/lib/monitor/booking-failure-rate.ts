/**
 * Pure logic for the booking-failure-rate page (#1313).
 *
 * On 2026-08-06 cal.com refused more than 50 confirms in about two hours and
 * reported nothing; the only detector was Pennie's SMS complaint monitor. Slate
 * counts every booking attempt (#418, and both booker routes now record one), but
 * the tally is bucketed by DAY, and a wave of fifty refusals is invisible inside a
 * day's worth of successes. Nothing pages on it.
 *
 * The trick that gets a short window out of a daily counter without a schema
 * change: the tally is MONOTONIC within a day, so two consecutive reads give a
 * delta. The monitor lane runs every 5 minutes, so accumulating those deltas into
 * a rolling window held in one state row yields 5-minute resolution over any
 * window length.
 *
 * The edge that would silently lie is the ET day rollover: at midnight the
 * counter resets, so the next reading is SMALLER and the subtraction goes
 * negative. Clamping that to zero would report "no failures", which is the
 * healthy answer at exactly the moment we stopped measuring. Every non-advance
 * (first reading, rollover, an impossible same-day decrease) therefore
 * re-baselines and records NO sample, and says which it was.
 *
 * The window itself is time-based rather than day-based, so a rollover keeps the
 * measurements from the preceding hour: they are still true, and emptying the
 * window at midnight would blind the check for an hour every night.
 *
 * No `@/` imports, so scripts/test-monitor-booking-failure-rate.ts drives every
 * branch node-natively; the IO (the mix RPC, the state row, Slack) is injected by
 * the caller from booking-failure-rate-store.ts.
 */

import { DateTime } from "luxon";
import { formatClockTime } from "../date/parse.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state row key for the page and its all-clear. One constant, so the two
 *  can never drift onto different keys and leave a page that cannot be cleared. */

export const FAILURE_RATE_ALERT_KEY = "booking_failure_rate";

/**
 * alert_state key for the notice about a burst that had ALREADY ENDED by the time
 * the window first read as over the line (#3275). Its own key, and an INCIDENT
 * rather than a condition, because it reports a finished event: put on the
 * condition key above, it would open a page whose all-clear follows five minutes
 * later, which is the 6:00 and 6:05am pair of 2026-10-14 again with better words.
 */
export const FAILURE_BURST_ENDED_ALERT_KEY = "booking_failure_burst_ended";

/**
 * alert_state key for the VOLUME page (#3276): enough failed attempts in the last
 * half hour to page whatever share of traffic they are. Its own key beside the share
 * page's, so one ending cannot clear the other and a reader can tell which tripped.
 * A condition, like the share: it ends on a measured clean run of recent attempts.
 */
export const FAILURE_VOLUME_ALERT_KEY = "booking_failure_volume";

/** The zone every time in this copy is given in, labelled ET (the roster's zone and
 *  the one the tally is bucketed in). */
const COPY_ZONE = "America/New_York";

/** One tick's reading of the CUMULATIVE totals for the current ET day. */
export interface OutcomeReading {
  /** The ET calendar day these totals belong to. */
  day: string;
  /** Every recorded booking attempt today, across all outcomes. */
  attempts: number;
  /** Today's `error` outcome total. */
  failures: number;
  /** Today's error totals by error code. */
  byCode: Record<string, number>;
  /**
   * Today's SELF INFLICTED refusal totals (#1442 / #1450 / #1709), carried
   * through the same window as everything else.
   *
   * Deliberately NOT added to `attempts` or `failures`: the failure share is
   * unchanged by this, which is the whole reason these are counted apart. They
   * ride here because the window machinery is already exactly what they need
   * (a cumulative daily counter differenced into 5-minute intervals, rebasing at
   * the ET rollover) and building a second copy of it would be two things that
   * must agree about what "an hour" means.
   *
   * Optional, like the sample's, so an absent map reads as "nothing measured"
   * rather than taking the step down on the first tick after a deploy.
   */
  refusals?: Record<string, number>;
}

/** What changed between two consecutive readings: a real measurement of one
 *  interval, which is the thing a day's running total can never give you. */
export interface RateSample {
  atMs: number;
  attempts: number;
  failures: number;
  byCode: Record<string, number>;
  /** #1442 / #1450 / #1709. Optional on the way IN, because a state row written
   *  before this shipped has samples without it, and a missing key must read as
   *  "not measured then" rather than crash the lane on the first tick after a
   *  deploy. */
  refusals?: Record<string, number>;
  /** The reminder lane's window only (`reminder-rate.ts`): bookings whose failed
   *  send was RELEASED to be tried again, by booking id, with the code it failed
   *  with. Already inside `failures` and `byCode`; carried so one booking retried
   *  every tick can be counted once rather than once per tick. Optional for the
   *  same reason as `refusals`. */
  retried?: Record<string, string>;
  /** The reminder lane's window only: how a booking handed back earlier in the
   *  window ended on this tick, `sent` or `kept`, so it stops counting as retried. */
  settled?: Record<string, string>;
  /**
   * The reminder lane's window only (#4300): this tick's sends split by reminder email
   * slug, each with its own attempts, failures and codes, so each email's share can be
   * judged from the SAME row as the combined one. Only emails that attempted a send are
   * present. Inside `attempts`, `failures` and `byCode` already, never added to them.
   * Optional for the same reason as `refusals`: a sample written before it shipped
   * counts for no email at all.
   */
  byEmail?: Record<string, { attempts: number; failures: number; byCode: Record<string, number> }>;
  /**
   * The booking lane's window only (#3275): a page (`live`) was asked for on this
   * tick (sent, or held by its cooldown). It rides on the sample so it ages out of the
   * window with the failures it was about. While any sample in the window carries it, a
   * burst that ends is not reported as past: somebody was paged about these failures,
   * and the all-clear tells them it is over. A notice about a burst that had already
   * ended is NOT stored here: nothing would read it (that notice's own cooldown keeps
   * it to once per burst), so it is recorded on the `failure rate` log line only (L46).
   * Kept in the existing jsonb `samples` column, so it needs no migration, and optional
   * so a sample written before it reads as "nobody told", which at worst sends one notice.
   */
  told?: "live";
}

/** The single persisted state row: the last reading (the baseline the next delta
 *  is taken against) plus the live window of samples. */
export interface RateWindowState {
  day: string;
  attempts: number;
  failures: number;
  byCode: Record<string, number>;
  /** The refusal baseline the next delta is measured against. Same optionality
   *  as the sample's, and for the same reason. */
  refusals?: Record<string, number>;
  samples: RateSample[];
}

/** Why a reading produced no sample, or null when it produced one normally. */
export type Rebase = "first" | "rollover" | "decrease" | null;

export interface RateThresholds {
  /** How far back the window reaches. */
  windowMs: number;
  /** Below this many measured attempts the window cannot be judged at all. */
  minAttempts: number;
  /** Failure share (percent) that must be EXCEEDED to page. */
  failPct: number;
}

/**
 * Drop samples that have aged out of the window. Strictly older than the cutoff
 * goes; a sample exactly on the boundary is still inside the window.
 *
 * Exported because the reminder lane's own rolling window (#2496) is judged by
 * `judgeFailureRate` below and so has to age its samples by exactly the same rule.
 * A second copy of this filter would be two things that must agree about what "in
 * the window" means, and the drift between them would be silent (L370).
 */
export function pruneSamples(
  samples: RateSample[],
  atMs: number,
  windowMs: number,
): RateSample[] {
  const cutoff = atMs - windowMs;
  return samples.filter((s) => s.atMs > cutoff);
}

const prune = pruneSamples;

/** Per-code delta between two cumulative maps, keeping only real increases. A
 *  code that appears for the first time counts from zero. */
function codeDeltas(
  prev: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, total] of Object.entries(next)) {
    const delta = total - (prev[code] ?? 0);
    if (delta > 0) out[code] = delta;
  }
  return out;
}

/**
 * Fold one reading into the window.
 *
 * Returns the new state and, when no sample could honestly be derived, WHY. A
 * rebase keeps the existing window (those samples are still true and still
 * inside it) and only replaces the baseline the next delta is measured against.
 */
export function advanceWindow(
  prev: RateWindowState | null,
  reading: OutcomeReading,
  atMs: number,
  windowMs: number,
): { state: RateWindowState; rebased: Rebase } {
  const baseline: RateWindowState = {
    day: reading.day,
    attempts: reading.attempts,
    failures: reading.failures,
    byCode: reading.byCode,
    refusals: reading.refusals,
    samples: prune(prev?.samples ?? [], atMs, windowMs),
  };

  if (prev === null) return { state: baseline, rebased: "first" };
  // A new ET day: the counter restarted, so the crossing interval's true delta
  // spans two days' rows and cannot be recovered from these two readings. Skip
  // the sample rather than invent one; one missing 5-minute sample out of twelve
  // is a far smaller error than a negative or a fabricated zero.
  if (prev.day !== reading.day) return { state: baseline, rebased: "rollover" };
  // Impossible while the tally only ever increments, so if it happens the rows
  // were pruned or corrected underneath us. Scoring it as zero new failures
  // would be a measurement we did not make.
  if (reading.attempts < prev.attempts || reading.failures < prev.failures) {
    return { state: baseline, rebased: "decrease" };
  }

  const sample: RateSample = {
    atMs,
    attempts: reading.attempts - prev.attempts,
    failures: reading.failures - prev.failures,
    byCode: codeDeltas(prev.byCode, reading.byCode),
    // Same delta rule as the codes, and for the same reason: the tally is
    // cumulative per ET day, so only the difference between two readings measures
    // an interval. A rebase records NO sample at all, so the refusals cannot be
    // credited to the wrong day either.
    // Both sides defaulted: a state row written before migration 0113 has no
    // baseline, and a reading assembled by anything that predates this carries no
    // refusals. Either absence must read as "nothing measured", never throw, or a
    // check that exists to speak where nothing else does would take the whole
    // lane's step down on the first tick after a deploy.
    refusals: codeDeltas(prev.refusals ?? {}, reading.refusals ?? {}),
  };
  return {
    state: { ...baseline, samples: prune([...baseline.samples, sample], atMs, windowMs) },
    rebased: null,
  };
}

export interface WindowTotals {
  attempts: number;
  failures: number;
  byCode: Record<string, number>;
}

/** Sum the samples still inside the window as of `atMs`. */
export function windowTotals(
  state: RateWindowState,
  atMs: number,
  windowMs: number,
): WindowTotals {
  const live = prune(state.samples, atMs, windowMs);
  const byCode: Record<string, number> = {};
  let attempts = 0;
  let failures = 0;
  for (const s of live) {
    attempts += s.attempts;
    failures += s.failures;
    for (const [code, n] of Object.entries(s.byCode)) byCode[code] = (byCode[code] ?? 0) + n;
  }
  return { attempts, failures, byCode };
}

export interface CodeCount {
  code: string;
  count: number;
}

export type RateVerdict =
  /** Too few measured attempts to judge. NOT healthy: it must never all-clear. */
  | { status: "insufficient"; attempts: number; failures: number }
  | { status: "healthy"; attempts: number; failures: number; pct: number; topCodes: CodeCount[] }
  | { status: "breach"; attempts: number; failures: number; pct: number; topCodes: CodeCount[] };

/**
 * Judge the window.
 *
 * Three outcomes, not two. `insufficient` exists because a quiet hour where 1 of
 * 1 attempts failed must neither page nor send an all-clear: a window too small
 * to judge measured nothing, and an all-clear hung off it would be the #1134
 * defect (a recovery notice off a signal that was never read).
 *
 * The share is compared BEFORE rounding, so a true 20.4% cannot present as an
 * at-threshold 20 and pass. `pct` is the rounded number for the reader.
 */
export function judgeFailureRate(
  state: RateWindowState,
  atMs: number,
  thresholds: RateThresholds,
): RateVerdict {
  const { attempts, failures, byCode } = windowTotals(state, atMs, thresholds.windowMs);
  if (attempts < thresholds.minAttempts) return { status: "insufficient", attempts, failures };

  const pct = Math.round((failures / attempts) * 100);
  const topCodes = Object.entries(byCode)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const over = failures * 100 > thresholds.failPct * attempts;
  return { status: over ? "breach" : "healthy", attempts, failures, pct, topCodes };
}

/**
 * The recent sub window the page stands down on (#3275).
 *
 * The judged window is a share over three hours, so it crosses the line in BOTH
 * directions as old samples age out with nothing new having happened: a success
 * leaving it raises the share, a failure leaving it lowers it. On 2026-10-14 that
 * paged at 6:00am on 8 of 38, an hour after the last failure, then said
 * "completing again" at 6:05am on 7 of 39 because a 3:02am failure aged out. So the
 * window still decides whether there WAS a wave, and the recent sub window decides
 * whether it is still happening and whether it has measurably stopped. The shipped
 * numbers, and the traffic they were measured against, are in
 * failure-rate-thresholds.ts.
 *
 * Deliberately NOT part of `RateThresholds` or `judgeFailureRate`: the reminder lane
 * (`reminder-rate.ts`) is judged by that same function with its own thresholds, and
 * this changes nothing there.
 */
export interface RecentThresholds {
  /** How far back "recent" reaches. */
  windowMs: number;
  /** Fewest attempts the recent window must hold before it can stand anything down. */
  minAttempts: number;
  /** Highest share (percent) of those attempts that may fail and still count as
   *  bookings completing. MET, not exceeded: the opposite comparison to `failPct`. */
  recoverPct: number;
}

export interface RecentReading {
  attempts: number;
  failures: number;
  /**
   * A MEASURED clean run: at least `minAttempts` attempts, of which no more than
   * `recoverPct` failed. The only thing the all-clear may hang off. Too few attempts
   * is false, never true: a quiet half hour measured nothing (L98, L695).
   */
  completing: boolean;
}

/** What the recent sub window holds as of `atMs`, aged by the window's own rule. */
export function readRecent(state: RateWindowState, atMs: number, recent: RecentThresholds): RecentReading {
  let attempts = 0;
  let failures = 0;
  for (const s of prune(state.samples, atMs, recent.windowMs)) {
    attempts += s.attempts;
    failures += s.failures;
  }
  const completing = attempts >= recent.minAttempts && failures * 100 <= recent.recoverPct * attempts;
  return { attempts, failures, completing };
}

/**
 * The volume page (#3276): a COUNT of failed attempts over a short window, beside the
 * share over the long one.
 *
 * The share has to outweigh every success already in three hours before it can fire,
 * so on 2026-10-04 leads were refused from 7:29pm ET and the share paged at 8:45pm.
 * A count does not wait on the successes. Every failure code counts (a time refused at
 * confirm and a Slate error alike, Dan 2026-10-04), over the share's own population,
 * because it is summed from the same window samples: test traffic and off site hosts
 * are already left out of the tally they are differenced from, and every refused
 * confirm is in it, the ones answered behind another in a crowd included. That is why
 * the count is never read from `routing_decisions`, which records no such follower.
 *
 * Resolution is one tick: a sample is recorded by the five minute tick that measured
 * it, so a 30 minute window is the last six ticks rather than a sliding half hour to
 * the second. The shipped numbers are in failure-rate-thresholds.ts.
 */
export interface VolumeThresholds {
  /** How far back the count reaches. Aged by the window's own rule (`pruneSamples`). */
  windowMs: number;
  /** Failed attempts in that window that page. MET, not exceeded. */
  failures: number;
}

export interface VolumeReading extends WindowTotals {
  /** At least `failures` attempts failed inside the window. */
  firing: boolean;
}

/** What the volume window holds as of `atMs`. */
export function readVolume(state: RateWindowState, atMs: number, volume: VolumeThresholds): VolumeReading {
  const totals = windowTotals(state, atMs, volume.windowMs);
  return { ...totals, firing: totals.failures >= volume.failures };
}

/**
 * The codes that mean a TIME was refused at confirm rather than Slate failing to
 * answer. A run of these looks like a sell out of the times on offer (Dan, 2026-10-04);
 * a run of anything else (internal, verify_unavailable, a timeout) looks like Slate
 * failing.
 */
const TAKEN_TIME_CODES: ReadonlySet<string> = new Set(["slot_unavailable"]);

/** Which a run of failures looks like, and the counts the page says it from. */
export interface FailureKind {
  kind: "sell_out" | "slate_failing";
  /** Failures that were a time refused at confirm. */
  taken: number;
  /** Every other failure, by code, most first. */
  errors: CodeCount[];
  errorCount: number;
}

/** A sell out when times refused at confirm outnumber everything else, otherwise Slate failing. */
export function failureKind(byCode: Record<string, number>): FailureKind {
  let taken = 0;
  const errors: CodeCount[] = [];
  for (const [code, count] of Object.entries(byCode)) {
    if (count <= 0) continue;
    if (TAKEN_TIME_CODES.has(code)) taken += count;
    else errors.push({ code, count });
  }
  errors.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const errorCount = errors.reduce((sum, e) => sum + e.count, 0);
  return { kind: taken > errorCount ? "sell_out" : "slate_failing", taken, errors, errorCount };
}

/**
 * When the window's failures were recorded: the ticks of the first and of the
 * newest sample holding one. A sample is recorded by the five minute tick that
 * measured it, up to one tick after the failure itself, which is why the copy says
 * "recorded". Null when the window holds no failure.
 */
export interface FailureSpan {
  firstMs: number;
  newestMs: number;
}

export function failureSpan(state: RateWindowState, atMs: number, windowMs: number): FailureSpan | null {
  let firstMs: number | null = null;
  let newestMs: number | null = null;
  for (const s of prune(state.samples, atMs, windowMs)) {
    if (s.failures <= 0) continue;
    if (firstMs === null || s.atMs < firstMs) firstMs = s.atMs;
    if (newestMs === null || s.atMs > newestMs) newestMs = s.atMs;
  }
  return firstMs === null || newestMs === null ? null : { firstMs, newestMs };
}

/** "5:05am ET", in the one spelling every surface uses (`formatClockTime`). */
function etTime(ms: number): string {
  return `${formatClockTime(DateTime.fromMillis(ms, { zone: COPY_ZONE })) ?? "an unreadable time"} ET`;
}

/** "between 3:05am and 5:05am ET", or "at 5:05am ET" when one tick recorded them all. */
function spanWords(span: FailureSpan): string {
  if (span.firstMs === span.newestMs) return `at ${etTime(span.newestMs)}`;
  const first = formatClockTime(DateTime.fromMillis(span.firstMs, { zone: COPY_ZONE })) ?? "an unreadable time";
  return `between ${first} and ${etTime(span.newestMs)}`;
}

/**
 * Who was refused a time in the window (#3633), read from `routing_decisions`, the
 * one place a refusal carries a person: the daily tally above counts attempts and
 * holds no identity, and of its failures only the refusals (`slot_unavailable`) can
 * be traced to a lead at all. Measured 2026-10-12 over seven days: 101 refusals in
 * the tally, 101 refusal rows, 98% of them with a lead id. The other failure codes
 * (internal errors, bad requests) carry nobody, so the page counts people for the
 * refusals only and says so.
 *
 * `refusals` comes from the same read as `people`, so the two numbers the page puts
 * side by side always describe the same rows.
 */
export interface RefusedPeople {
  /** Distinct lead ids among the refusals. */
  people: number;
  /** Refusals in the window, test buckets left out. */
  refusals: number;
  /** Refusals with no lead id, which can be no person in particular. */
  withoutLead: number;
  /**
   * How many distinct times the counted refusals asked for (#3276), or absent when the
   * read did not carry them. The volume page says it, because ten refusals for one
   * dead time and ten across the evening send a reader to different places.
   */
  times?: number;
  /**
   * #3797: proven lost races in the same window, counted APART: none of them is in
   * `refusals` or `people`, as the tally keeps them out of the failure share. Absent
   * when the read did not carry the verdict. The page states it beside the count so a
   * reader never has to work out which kind woke them.
   */
  races?: number;
}

/** One refusal row as the store reads it. `is_test` null is a bucket that could not
 *  be read, which counts as real: the tally takes the same direction, because hiding
 *  a real refusal is worse than counting a test one (test-traffic.ts). */
export interface RefusalRow {
  lead_id: string | null;
  is_test: boolean | null;
  /** The instant the lead asked for (#3272). Optional: a read that did not ask for it
   *  leaves `times` uncounted rather than counted as none. */
  requested_start?: string | null;
  /** #3797: `race` is a proven lost race, which is left out of the people count exactly
   *  as the tally leaves it out of the failure share. Anything else counts. */
  offer_verdict?: string | null;
}

/** Count the people among the window's refusals, leaving test buckets out exactly as
 *  the tally does, so both halves of the page describe one population. */
export function countRefusedPeople(rows: RefusalRow[]): RefusedPeople {
  const leads = new Set<string>();
  const times = new Set<string>();
  let timesRead = false;
  let racesRead = false;
  let races = 0;
  let refusals = 0;
  let withoutLead = 0;
  for (const row of rows) {
    if (row.is_test === true) continue;
    if (row.offer_verdict !== undefined) racesRead = true;
    // #3797 (Dan, 2026-10-16): a proven race is counted apart and never paged on.
    if (row.offer_verdict === "race") {
      races += 1;
      continue;
    }
    refusals += 1;
    if (row.lead_id) leads.add(row.lead_id);
    else withoutLead += 1;
    if (row.requested_start !== undefined) {
      timesRead = true;
      if (row.requested_start) times.add(row.requested_start);
    }
  }
  return {
    people: leads.size,
    refusals,
    withoutLead,
    ...(timesRead ? { times: times.size } : {}),
    ...(racesRead ? { races } : {}),
  };
}

/** "1 refusal" / "5 refusals". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * "4 people were" / "1 person was", and "At least 3 people were" when some refusal
 * had no lead id: that refusal could be one of the people counted or somebody else,
 * so the count is a floor and the page must not state it as exact (L11).
 */
function peopleWere(r: RefusedPeople): string {
  const who = r.people === 1 ? "1 person was" : `${r.people} people were`;
  return r.withoutLead > 0 ? `At least ${who}` : who;
}

/**
 * #3797: the sentence naming the proven lost races counted apart, or nothing when there
 * were none or the read could not say. Beside the count, never inside it.
 */
function racesApart(r: RefusedPeople | null | undefined): string {
  const n = r?.races ?? 0;
  if (n <= 0) return "";
  return (
    ` ${n === 1 ? "1 more was a lost race" : `${n} more were lost races`}, counted apart and not in these ` +
    "numbers: a time free when the lead's list was computed and taken before they confirmed."
  );
}

/** The top few codes as "slot_unavailable (35), internal (3)". */
function codeList(codes: CodeCount[]): string {
  return codes
    .slice(0, 3)
    .map((c) => `${c.code} (${c.count})`)
    .join(", ");
}

/**
 * The page. States what it measured (how many, out of how many, over what
 * window) and names the dominant error code, because the code is what tells the
 * reader which system to look at: `slot_unavailable` means the times being
 * offered are not really free, `no_eligible_agents` means a bucket has nobody,
 * `internal` means the booker itself is throwing. Points at where the per-call
 * detail lives rather than pasting any of it (#1133).
 *
 * The guidance sentence is CONDITIONAL on what is actually failing. An alert that
 * always advises checking availability would send the reader to the wrong system
 * every time the booker is the thing throwing, and canned remediation that steers
 * a diagnosis wrong is how a page becomes something people learn to distrust
 * (L36). So it appears only when slot_unavailable is what leads.
 */
/**
 * The one sentence saying what to DO about the code that is failing most, or
 * nothing when the code speaks for itself.
 *
 * A page that names a code and stops leaves the reader to work out the repair
 * mid-incident, and two of these codes have repairs that are not guessable from
 * the name (L111: advice has to name an action that changes the state, and L80: a
 * message naming a specific cause owes the reader somewhere to go).
 *
 * Not every code needs one, and the empty default is deliberate rather than an
 * omission: `no_eligible_agents` and `internal` already page on their own with
 * their own copy, and a generic sentence bolted onto them would say less than the
 * code does. Keyed on the TOP code only, because a page with three sentences of
 * advice for three codes is a page nobody finishes on a phone.
 */
const CODE_GUIDANCE: Record<string, string> = {
  slot_unavailable:
    "slot_unavailable means the times being offered are not really free, so start with the " +
    "availability cache.",
  // #1429. Both of these mean the direct booking integration is locked out, so
  // every lead it handles is refused until someone fixes a secret. The two are
  // named apart because the repair is in different hands.
  API_KEY_REJECTED:
    "API_KEY_REJECTED means the caller is presenting a key Slate does not accept, so every lead " +
    "it handles is refused until the key is fixed. Check whether that caller's key " +
    "(BOOKING_API_KEY_REGAL, _TRYPENNIE, _CANARY or _MARCIA) was rotated " +
    "without the caller being updated. Counted per refused call, so a caller that retries can " +
    "appear more than once.",
  API_NOT_CONFIGURED:
    "API_NOT_CONFIGURED means Slate has no booking API key set, so the endpoint refuses " +
    "everyone. Check the per caller booking API key secrets " +
    "(BOOKING_API_KEY_REGAL, _TRYPENNIE, _CANARY, _MARCIA) on the deployed Worker. Counted per refused " +
    "call, so a caller that retries can appear more than once.",
};

function guidanceFor(code: string | undefined): string {
  const advice = code ? CODE_GUIDANCE[code] : undefined;
  return advice ? ` ${advice}` : "";
}

/** What the window measured, shared by the page and the burst notice. */
interface WindowCounts {
  attempts: number;
  failures: number;
  pct: number;
  windowMinutes: number;
  topCodes: CodeCount[];
  /** Who was refused a time in the same window, or null when that read failed. */
  refused?: RefusedPeople | null;
}

/**
 * The window's counts as one clause with no closing full stop, so the burst notice
 * can say when they were recorded inside the same sentence.
 *
 * #3633: the window counts ATTEMPTS, and one lead retrying a dead time five times is
 * five of them, which the page used to call five customers. With the refused people
 * counted it leads with them (Dan's choice, 2026-10-12); without them (the read
 * failed, or no failure carried a person) it says attempts, which is all the tally
 * can claim.
 */
function countsClause(input: WindowCounts): string {
  const r = input.refused;
  return r && r.people > 0
    ? `${peopleWere(r)} refused a time in the last ${input.windowMinutes} minutes ` +
        `(${plural(r.refusals, "refusal")}); ${input.failures} of ${input.attempts} attempts ` +
        `failed overall (${input.pct}%)`
    : `${input.failures} of ${input.attempts} booking attempts failed in the last ` +
        `${input.windowMinutes} minutes (${input.pct}%)`;
}

/** What the recent sub window held, as a page reads it. */
interface RecentCounts {
  recentMinutes: number;
  recent: { attempts: number; failures: number };
}

/**
 * The page, for failures that are still happening: the window is over the line AND
 * the recent sub window holds more failures than a clean run allows (#3275). It says
 * so in words ("Still failing"), with how many of the last half hour's attempts
 * failed and when the window's failures were recorded, so a reader can tell a live
 * outage from the tail of one without opening anything.
 */
export function formatFailureRateAlert(
  input: WindowCounts &
    RecentCounts & {
      /** When the window's failures were recorded. A breach always has one. */
      span: FailureSpan;
    },
): string {
  const codes = codeList(input.topCodes);
  const naming = codes ? ` Failing with: ${codes}.` : "";
  const guidance = guidanceFor(input.topCodes[0]?.code);
  const { attempts, failures } = input.recent;
  const now =
    attempts === 1 && failures === 1
      ? `the only attempt in the last ${input.recentMinutes} minutes failed`
      : `${failures} of ${attempts} attempts in the last ${input.recentMinutes} minutes failed`;
  const when =
    input.span.firstMs === input.span.newestMs
      ? `The failures in that window were all recorded ${spanWords(input.span)}.`
      : `The failures in that window were recorded ${spanWords(input.span)}.`;
  return (
    `${countsClause(input)}.${racesApart(input.refused)} Still failing: ${now}. ${when}${naming}${guidance} ` +
    "The per call breakdown is in the booking outcome panel."
  );
}

/**
 * The notice for a burst that had already ENDED when the window first read as over
 * the line (#3275): no failure in the recent sub window. Sent once per burst, on its
 * own incident key, and never when somebody was already paged about these failures.
 *
 * Still sent rather than held, because a burst that refused people is worth knowing
 * about even after it stopped (2026-10-14's included a Google token stall and a
 * stored row offering full times). But it is worded as past, says when the failures
 * were, and says what the last half hour measured: a clean run, too few attempts to
 * call it, or none at all. Only the first may say bookings have stopped failing in so
 * many words (L11).
 */
export function formatFailureBurstEnded(
  input: WindowCounts &
    RecentCounts & {
      span: FailureSpan;
      /** The recent floor, so the copy can tell a measured clean run from a thin one. */
      minRecentAttempts: number;
    },
): string {
  const codes = codeList(input.topCodes);
  const naming = codes ? ` Failed with: ${codes}.` : "";
  const guidance = guidanceFor(input.topCodes[0]?.code);
  const since = etTime(input.span.newestMs);
  const n = input.recent.attempts;
  const minutes = input.recentMinutes;
  const lead =
    n >= input.minRecentAttempts
      ? `Bookings failed in a burst that has stopped: nothing has failed since ${since}, and all ${n} ` +
        `attempts in the last ${minutes} minutes completed.`
      : n > 0
        ? `Bookings failed in a burst, and nothing has failed since ${since}, but only ` +
          `${plural(n, "attempt")} came in the last ${minutes} minutes, too few to say bookings are ` +
          "completing again."
        : `Bookings failed in a burst, and nothing has failed since ${since}, but nobody has tried ` +
          `to book in the last ${minutes} minutes, so whether bookings are completing again is not ` +
          "yet known.";
  return (
    `${lead} ${countsClause(input)}, recorded ${spanWords(input.span)}.${racesApart(input.refused)}${naming}${guidance} ` +
    "The per call breakdown is in the booking outcome panel."
  );
}

/**
 * The volume page (#3276). Leads with the count and the window, because the count is
 * what tripped it, then says which it looks like (Dan, 2026-10-04): a sell out, times
 * offered and refused at confirm, or Slate failing, errors and timeouts.
 *
 * The people behind the refusals come from `routing_decisions` and are DETAIL only:
 * a confirm answered from the verdict of the one ahead of it in a crowd records no
 * row, so the number is a floor and is always said as one (L11), never as "N people".
 * A failed read is said as such, never as nobody.
 */
export function formatFailureVolumeAlert(input: {
  volume: VolumeReading;
  volumeMinutes: number;
  /** Who was refused a time in the same window, or null when that read failed. */
  refused: RefusedPeople | null;
}): string {
  const { failures, attempts, byCode } = input.volume;
  const head = `${failures} of ${attempts} booking attempts failed in the last ${input.volumeMinutes} minutes.`;
  const k = failureKind(byCode);
  const looks =
    k.kind === "sell_out"
      ? ` This looks like a sell out rather than Slate failing: ${k.taken} of them were times offered on the page ` +
        "and refused at confirm (slot_unavailable)."
      : ` This looks like Slate failing rather than a sell out: ${k.errorCount} of them were errors or timeouts ` +
        `(${codeList(k.errors)}).${guidanceFor(k.errors[0]?.code)}`;
  return `${head}${looks}${peopleDetail(input.refused, k.taken)}${racesApart(input.refused)} The per call breakdown is in the booking outcome panel.`;
}

/** The people sentence of the volume page, or nothing when no failure was a refusal. */
function peopleDetail(refused: RefusedPeople | null, taken: number): string {
  if (taken === 0) return "";
  if (refused === null) return " The people behind the refusals could not be counted: the read of the refusal records failed.";
  if (refused.people === 0) {
    return refused.refusals > 0
      ? " None of the refusals recorded carried a lead id, so the people behind them are not known."
      : " No refusal record was found for them, so the people behind them are not known.";
  }
  const who = refused.people === 1 ? "1 person was" : `${refused.people} people were`;
  const times = refused.times && refused.times > 0 ? `, across ${plural(refused.times, "time")} asked for` : "";
  return (
    ` At least ${who} refused a time${times}. That is a floor: a confirm answered from the one ahead of it in a ` +
    "crowd records no person."
  );
}

/**
 * The volume page's all-clear. Hung off the same measured clean run of recent attempts
 * as the share's (#3275), never off the count dropping under ten, which happens as soon
 * as the oldest tick ages out with nothing having recovered. Worded apart from the
 * share's all-clear, because both are open together in a big wave and two identical
 * messages in a row read as a glitch.
 */
export function formatFailureVolumeAllClear(
  input: RecentCounts & {
    /** The newest failure still in the share's window, or null when none is left. */
    newestFailureMs: number | null;
  },
): string {
  const { attempts, failures } = input.recent;
  const lead = "Failed bookings have stopped piling up:";
  if (failures > 0) {
    return `${lead} ${attempts - failures} of ${attempts} attempts in the last ${input.recentMinutes} minutes completed.`;
  }
  const since = input.newestFailureMs === null ? "" : `, and nothing has failed since ${etTime(input.newestFailureMs)}`;
  return `${lead} all ${attempts} attempts in the last ${input.recentMinutes} minutes completed${since}.`;
}

export type FailureRateResult =
  /** The tick could not read what it needs, so it claims nothing in either
   *  direction. Deliberately NOT folded into a zero-failure "healthy". */
  | { status: "unverified"; why: "state" | "tally" }
  | {
      status: "checked";
      armed: boolean;
      verdict: RateVerdict;
      rebased: Rebase;
      /**
       * The window this tick just advanced and persisted (#1442/#1450/#1709).
       *
       * Handed back rather than re-read by the refusal signals beside it: four
       * cron lanes share one invocation's subrequest budget, and a second load of
       * a row this step has already written would spend that budget to learn
       * nothing. It also removes any chance of the two checks judging different
       * windows, which is how two things that must agree drift apart (L53).
       */
      state: RateWindowState;
      /** What the recent sub window measured (#3275). */
      recent: RecentReading;
      /** What the volume window measured (#3276). */
      volume: VolumeReading;
    };

/**
 * The monitor-lane step: read, advance the window, judge, and decide whether a
 * human hears about it.
 *
 * Four rules this encodes, each of which has shipped wrong somewhere before:
 *
 *  - A read that failed is `unverified`, never an empty window scored as zero
 *    failures. An empty result here is indistinguishable from a healthy one, so
 *    it must fail loud rather than degrade (#277, #1134, #1152).
 *  - The all-clear hangs off a MEASURED clean run of recent attempts (#3275). Not
 *    off "we did not page this tick", which is also true of every tick that could
 *    not measure, and not off the window's share dipping under the line, which
 *    happens whenever an old failure ages out (2026-10-04, 2026-10-14).
 *  - Only failures that are still happening page the condition. Failures that have
 *    aged into the past are reported once, worded as past, on their own key.
 *  - While disarmed it measures and logs but stays silent in BOTH directions
 *    (L56): its first live run must not also be its first enforcing run, and an
 *    all-clear for a page nobody received is noise.
 *
 * Fail-soft throughout: a flaky Slack or a failed state write must never fail the
 * tick, because this lane also carries twelve other checks.
 */
export async function runBookingFailureRateCheck(deps: {
  nowMs: number;
  /** The stored window, or null when there is none yet. THROWS on a read error,
   *  which is why "no state" and "could not read the state" stay distinct. */
  loadState: () => Promise<RateWindowState | null>;
  saveState: (state: RateWindowState) => Promise<void>;
  /** Today's cumulative tally, or null when the read failed. */
  readToday: () => Promise<OutcomeReading | null>;
  /**
   * Who was refused a time since `sinceMs` (#3633). Called only on an ARMED tick that
   * sends a live page, a burst notice or (#3276) a volume page, never on a healthy,
   * insufficient or disarmed one, since four cron lanes share one invocation's
   * subrequest budget. The volume page reads over ITS window (the last 30 minutes), so
   * a tick on which both pages are live makes two reads: one paged read more per tick
   * only while both are firing, accepted so each page names the people behind the
   * failures it counted rather than one window's people under the other's count. It still
   * runs on every live tick while the page's cooldown holds, because the cooldown
   * lives inside `notify` and asking it first would cost the same subrequest the skip
   * would save: one paged read per five minute tick, only while failures are live.
   * Required, so `tsc` names any caller that forgot it rather than the page quietly
   * staying in the attempts form. May throw; the page then goes out without it.
   */
  readRefusedPeople: (sinceMs: number) => Promise<RefusedPeople>;
  thresholds: RateThresholds;
  /** The recent sub window the page stands down on (#3275). Required, so `tsc`
   *  names a caller that would otherwise judge on the window's share alone. */
  recent: RecentThresholds;
  /** The volume page (#3276). Required, so `tsc` names a caller that would otherwise
   *  page on the share alone. */
  volume: VolumeThresholds;
  armed: boolean;
  /** The cooldown both pages are held by: the volume page borrows the share's setting. */
  cooldownMs: number;
  notify: ThrottledNotify;
  resolve: AlertResolve;
  /** Structurally the log helper's field shape (primitives only), spelled out
   *  rather than imported so this module keeps no `@/` dependency. */
  log?: (fields: Record<string, string | number | boolean | null | undefined>) => void;
  /**
   * A step that is deliberately fail-soft still has to be VISIBLE. Slack being
   * down, or a state write failing, must not take the monitor tick down with it,
   * but a caught error that reaches no sink is invisible twice (L13). The caller
   * passes the Error object straight through to `log.error`, which is how
   * Cloudflare gets a serialized stack.
   */
  onError?: (context: "saveState" | "notify" | "resolve" | "refusedPeople", err: unknown) => void;
}): Promise<FailureRateResult> {
  let prev: RateWindowState | null;
  try {
    prev = await deps.loadState();
  } catch {
    deps.log?.({ msg: "failure rate unverified", why: "state unreadable" });
    return { status: "unverified", why: "state" };
  }

  const reading = await deps.readToday().catch(() => null);
  if (reading === null) {
    deps.log?.({ msg: "failure rate unverified", why: "tally unreadable" });
    return { status: "unverified", why: "tally" };
  }

  const windowMinutes = Math.round(deps.thresholds.windowMs / 60_000);
  const recentMinutes = Math.round(deps.recent.windowMs / 60_000);
  const advanced = advanceWindow(prev, reading, deps.nowMs, deps.thresholds.windowMs);
  const { rebased } = advanced;
  const verdict = judgeFailureRate(advanced.state, deps.nowMs, deps.thresholds);
  const recent = readRecent(advanced.state, deps.nowMs, deps.recent);
  const span = failureSpan(advanced.state, deps.nowMs, deps.thresholds.windowMs);
  const volume = readVolume(advanced.state, deps.nowMs, deps.volume);
  const volumeMinutes = Math.round(deps.volume.windowMs / 60_000);

  // #3275. The window says whether there WAS a wave; the recent sub window says
  // whether it is still happening. Three decisions, each on a measured reading:
  //  - live: over the line AND the last half hour holds more failures than a clean
  //    run allows. Only this pages the condition, so failures that have aged into
  //    the past can never re-page it as the share wobbles.
  //  - past: over the line with NO failure in the last half hour, and nobody paged
  //    about these failures. One notice, on its own incident key.
  //  - clear: the last half hour is a measured clean run. Only this may all-clear,
  //    never the share dipping under the line, and never a quiet half hour.
  //
  // `past` is asked for on EVERY such tick and held to once by its own cooldown, not
  // by the window's marker: the dispatcher answers a failed post with a short retry
  // stamp, which only helps if the check asks again, so a marker that stopped the
  // asking would lose the notice to one Slack failure (L33). The marker gates it only
  // on a LIVE page, whose all-clear is already the end of that story.
  const breach = verdict.status === "breach" && span !== null;
  const live = deps.armed && breach && recent.failures > 0 && !recent.completing;
  // #3276: the volume page, beside the share rather than in place of it. It needs no
  // breach of the share: ten failures in half an hour page whatever share of traffic
  // they are.
  const volumeLive = deps.armed && volume.firing;
  // The volume page stands down on the measured clean run, but never on a tick still
  // holding ten failures: ten in 200 or more attempts is also a clean run by the 5%
  // rule, and a page and its all-clear on one tick would say both things at once.
  const clearVolume = deps.armed && recent.completing && !volume.firing;
  const pagedLive = advanced.state.samples.some((s) => s.told === "live");
  const past = deps.armed && breach && recent.failures === 0 && !pagedLive && !volumeLive;
  const clear = deps.armed && recent.completing;

  // Recorded on the newest sample BEFORE the save, so the record survives a Slack
  // that hangs. A page held by its cooldown still counts: one is open. Either page
  // counts, since both mean somebody was told about these failures and the all-clear
  // is what ends that story, not a second notice saying the burst is past.
  const told: RateSample["told"] = live || volumeLive ? "live" : undefined;
  const samples = advanced.state.samples;
  const newest = samples[samples.length - 1];
  const state: RateWindowState =
    told && newest ? { ...advanced.state, samples: [...samples.slice(0, -1), { ...newest, told }] } : advanced.state;
  // Persist BEFORE notifying: a hung Slack must not cost us the window.
  await deps.saveState(state).catch((err) => deps.onError?.("saveState", err));

  deps.log?.({
    msg: "failure rate",
    status: verdict.status,
    armed: deps.armed,
    rebased,
    window_min: windowMinutes,
    attempts: verdict.attempts,
    failures: verdict.failures,
    pct: verdict.status === "insufficient" ? null : verdict.pct,
    top_code: verdict.status === "insufficient" ? null : (verdict.topCodes[0]?.code ?? null),
    recent_attempts: recent.attempts,
    recent_failures: recent.failures,
    recent_completing: recent.completing,
    newest_failure_min_ago: span === null ? null : Math.round((deps.nowMs - span.newestMs) / 60_000),
    // What this tick knows before any resolve answers: whether a page is open for
    // these failures (`told`) and whether a burst has ended (`burst_ended`). Whether
    // the ended burst's notice actually went out is decided after the all-clear and
    // logged on its own line below, so this line never claims a notice it held.
    told: told ?? null,
    burst_ended: past,
    volume_min: volumeMinutes,
    volume_attempts: volume.attempts,
    volume_failures: volume.failures,
    volume_firing: volume.firing,
  });

  // The people count refines a page and is never a condition of one: a failed read is
  // reported and the message goes out in the attempts form.
  const readRefused = () =>
    deps.readRefusedPeople(deps.nowMs - deps.thresholds.windowMs).catch((err) => {
      deps.onError?.("refusedPeople", err);
      return null;
    });

  if (live && verdict.status === "breach" && span !== null) {
    const refused = await readRefused();
    await deps
      .notify(
        FAILURE_RATE_ALERT_KEY,
        deps.cooldownMs,
        formatFailureRateAlert({ ...verdict, windowMinutes, refused, recentMinutes, recent, span }),
      )
      .catch((err) => deps.onError?.("notify", err));
  }

  if (volumeLive) {
    // Its own read, over its own window, so the people it names are the ones behind
    // the failures it counted rather than three hours of them.
    const refused = await deps.readRefusedPeople(deps.nowMs - deps.volume.windowMs).catch((err) => {
      deps.onError?.("refusedPeople", err);
      return null;
    });
    await deps
      .notify(FAILURE_VOLUME_ALERT_KEY, deps.cooldownMs, formatFailureVolumeAlert({ volume, volumeMinutes, refused }))
      .catch((err) => deps.onError?.("notify", err));
  }

  let settled = false;
  if (clearVolume) {
    // #3276: the volume page stands down on the same measured clean run. Asked on its
    // own, so a resolve that throws for one key still asks for the other.
    await deps
      .resolve(
        FAILURE_VOLUME_ALERT_KEY,
        formatFailureVolumeAllClear({ recentMinutes, recent, newestFailureMs: span?.newestMs ?? null }),
      )
      .catch((err) => {
        deps.onError?.("resolve", err);
        return false;
      });
  }
  if (clear) {
    const answer = await deps
      .resolve(
        FAILURE_RATE_ALERT_KEY,
        formatFailureRateAllClear({ recentMinutes, recent, newestFailureMs: span?.newestMs ?? null }),
      )
      .catch((err) => {
        deps.onError?.("resolve", err);
        return false;
      });
    settled = answer === true;
  }

  // A page that was open and has just been all-cleared already told this story, so
  // the burst notice would say it twice. A resolve that THREW cannot say whether one
  // was open, and the notice still goes: a duplicate is better than a burst nobody
  // hears about.
  if (past && settled) {
    deps.log?.({ msg: "burst ended notice", outcome: "held_page_cleared" });
  }
  if (past && !settled && verdict.status === "breach" && span !== null) {
    deps.log?.({ msg: "burst ended notice", outcome: "asked" });
    const refused = await readRefused();
    // The cooldown is the window's length, and it is what holds this to once per
    // burst: a burst reads as ended only from 30 minutes after its newest failure
    // until that failure leaves the window, a stretch shorter than the window, so a
    // delivered notice is never repeated for it. The cost, accepted: a SECOND burst
    // that ends within the same three hours goes unreported by this key.
    await deps
      .notify(
        FAILURE_BURST_ENDED_ALERT_KEY,
        deps.thresholds.windowMs,
        formatFailureBurstEnded({
          ...verdict,
          windowMinutes,
          refused,
          recentMinutes,
          recent,
          span,
          minRecentAttempts: deps.recent.minAttempts,
        }),
      )
      .catch((err) => deps.onError?.("notify", err));
  }
  return { status: "checked", armed: deps.armed, verdict, rebased, state, recent, volume };
}

/**
 * The all-clear. Hung off a MEASURED clean run in the recent sub window (#3275),
 * never off the window's share dipping under the line, and never off a quiet tick,
 * so it can only say something the check observed. It quotes the recent attempts and
 * nothing else: "completing again" beside the window's 18% read as a contradiction
 * (Dan, 2026-10-14), and the window's share was never what ended it.
 */
export function formatFailureRateAllClear(
  input: RecentCounts & {
    /** The window's newest failure, or null when none is left in it. */
    newestFailureMs: number | null;
  },
): string {
  const { attempts, failures } = input.recent;
  if (failures > 0) {
    return (
      `Bookings are completing again: ${attempts - failures} of ${attempts} attempts in the last ` +
      `${input.recentMinutes} minutes completed.`
    );
  }
  const since = input.newestFailureMs === null ? "" : `, and nothing has failed since ${etTime(input.newestFailureMs)}`;
  return `Bookings are completing again: all ${attempts} attempts in the last ${input.recentMinutes} minutes completed${since}.`;
}
