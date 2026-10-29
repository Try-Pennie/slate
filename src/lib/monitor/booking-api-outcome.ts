// Booking-API outcome mix (#418).
//
// #375 emits a per-call outcome log line from the direct booking API
// (created/deduped/rescheduled/confirm_required/error, with bucket + error code)
// but nothing consumed it, so there was no way to SEE whether person-dedupe,
// cross-bucket moves, and no-eligible-agents were behaving once the bot is live.
//
// This persists a lightweight daily tally (the bump_booking_api_outcome RPC does
// an atomic INSERT ... ON CONFLICT increment, so it is safe under concurrency and
// retry) and an admin panel reads the aggregated mix (the booking_api_outcome_mix
// RPC returns a single jsonb row, cap-safe). This module owns the two pure pieces:
// the tally args and the mix normalization. No alert; visibility only.

import { DateTime } from "luxon";
import type { HostClass } from "./offsite-origin.ts";
import { FOLLOW_UP_LEFT_TO_DRAIN_OUTCOME } from "./follow-up-drain-rate.ts";
import { OFFER_RACE_OUTCOME } from "../booking/offer-race.ts";
import { DUPLICATE_CANCEL_TALLY_NAMES } from "./duplicate-cancel-rate.ts";

/**
 * The zone whose calendar day the tally is KEYED by: a call is counted on its
 * Eastern day, matching the daily cap convention (#832), so day boundaries agree
 * app wide.
 *
 * This is a bookkeeping boundary, not a claim about where anybody works: the
 * roster spans seven zones (#1739). Exported so the admin panel asks for "since
 * N days ago" on the SAME day boundary the rows were written on, rather than
 * holding a second copy of the zone (#1916).
 */
export const OUTCOME_DAY_ZONE = "America/New_York";

/** The API outcomes, in the order the panel renders them (happy path first). */
export const OUTCOME_ORDER = [
  "created",
  "rescheduled",
  /**
   * A cancel THIS request made (#2373).
   *
   * In the denominator for the same reason `rescheduled` is: the manage page's
   * cancel records its refusals, and adding only those would inflate the very share
   * the failure-rate window pages on. A cancel that lost the claim to a concurrent
   * one is recorded as an error under `cancel_lost_race` instead, because one is a
   * second tab and a run of them is something terminating bookings underneath their
   * owners, which nothing else in Slate would see.
   */
  "cancelled",
  "deduped",
  "confirm_required",
  "error",
] as const;

export type OutcomeName = (typeof OUTCOME_ORDER)[number];

/**
 * Refusals Slate made to its OWN caller, recorded in the same tally table and
 * deliberately OUTSIDE `OUTCOME_ORDER` (#1442, #1450, #1709).
 *
 * That exclusion is the whole mechanism, and it needs no schema change: `total`
 * is summed over `OUTCOME_ORDER` alone, so a name that is not in it can never
 * enter the denominator the booking failure SHARE is measured against. Counting
 * these there would put a noisy caller's volume in that denominator and make a
 * real outage look proportionally smaller exactly while it is happening.
 *
 * The mix RPC's `by_error` slice filters on `outcome = 'error'`, so these never
 * pollute the error codes the failure-rate page names either.
 *
 * The two ceilings are keyed APART rather than summed, because they mean
 * different things and their repairs are different numbers: the key ceiling
 * bounds total volume, the IP backstop bounds any one host.
 */
export const SELF_INFLICTED_REFUSALS = [
  "refused_ceiling_key",
  "refused_ceiling_ip",
  "refused_list_read",
  /**
   * A Bearer token that was PRESENT and is not one of ours (#1450).
   *
   * Deliberately narrower than the API_KEY_REJECTED error code beside it, which
   * also counts a request carrying no credential at all. The endpoint is public,
   * so anything crawling the internet produces those continuously and a signal
   * built on the error code would page on background noise. A present and wrong
   * token is the one that means a real integration is locked out.
   */
  "refused_key_wrong",
  /** No key configured on the Worker at all, so every call is refused. */
  "refused_not_configured",
  /**
   * The EMBED BOOKER's own three refusals (#1727), the surface real leads arrive on.
   * Each trip is abuse shaping, so counting it into the share would put bot volume
   * in the denominator a real outage has to move; each is still worth a sustained
   * signal, judged in `api-refusal-signals.ts`.
   *
   * The two caps are judged by how many DISTINCT addresses or people they are
   * locking out, read from the limiter's own rows, because a volume cannot tell one
   * bot hammering one identity from many leads each tripping once. These counts are
   * the volume beside that reading and the gate that decides whether it is needed.
   */
  "refused_embed_ip_hour",
  "refused_embed_contact_hour",
  /** A filled hidden field, which no person can see: volume here is bot traffic. */
  "refused_embed_honeypot",
] as const;

export type SelfInflictedRefusal = (typeof SELF_INFLICTED_REFUSALS)[number];

/** The embed booker's three recorded refusals (#1727), by what each one is, so the
 *  route names a constant the type checks against the list rather than a string. */
export const EMBED_REFUSAL_OUTCOME = {
  ipHour: "refused_embed_ip_hour",
  contactHour: "refused_embed_contact_hour",
  honeypot: "refused_embed_honeypot",
} as const satisfies Record<string, SelfInflictedRefusal>;

/**
 * #4391: a program lead's call that went on the placeholder advisor, recorded under its
 * own name OUTSIDE `OUTCOME_ORDER`, like the proven offer race (#3797). Neither is a
 * refusal: the lead was booked. Neither is `created` either: nothing was routed, and
 * counting a placeholder call there would grow the denominator the failure share is
 * judged against with bookings no advisor pool made. `afterRace` is a served time whose
 * normal create lost for want of a free advisor and fell to the placeholder; `straight`
 * a time only the placeholder was offering; `move` a lead's move onto it.
 */
export const PROGRAM_PLACEHOLDER_OUTCOME = {
  afterRace: "program_placeholder_after_race",
  straight: "program_placeholder",
  move: "program_placeholder_move",
} as const;

/** Zero-filled counts, so a reader never has to decide what an absent key meant. */
export type RefusalCounts = Record<SelfInflictedRefusal, number>;

export const emptyRefusalCounts = (): RefusalCounts => ({
  refused_ceiling_key: 0,
  refused_ceiling_ip: 0,
  refused_list_read: 0,
  refused_key_wrong: 0,
  refused_not_configured: 0,
  refused_embed_ip_hour: 0,
  refused_embed_contact_hour: 0,
  refused_embed_honeypot: 0,
});

export interface TallyArgs {
  p_day: string;
  p_outcome: string;
  p_bucket: string;
  p_error_code: string;
  /** #1616: whether this attempt was the smoke canary's rather than a customer's. */
  p_is_test: boolean;
  /** #2752, migration 0143: the host page class the attempt was made from. */
  p_host_class: HostClass;
}

export interface TallyInput {
  outcome: string;
  bucketCode: string;
  errorCode: string | null;
  /**
   * #1616. Decided at the point of recording from the BUCKET the attempt belongs
   * to, never inferred downstream: the manage-token reschedule path records an
   * empty bucket code, so a bucket-code filter would keep the canary's deliberate
   * `reschedule_conflict` and drop its successes.
   */
  isTest: boolean;
  /**
   * #2752. The host page the attempt came from, as `bookingHostClass` judges it
   * (the same verdict the off site page and the below tier exclusion reach), so
   * the failure rate can leave out a tester on a real code from a page that is not
   * the production site. Required, like `isTest`, so no recording site can forget it.
   */
  hostClass: HostClass;
  /** The call time (epoch ms), bucketed into its OUTCOME_DAY_ZONE calendar day. */
  atMs: number;
}

/**
 * Build the bump_booking_api_outcome RPC args for one API call. A null error code
 * becomes "" so it fits the table's non-null unique key (day, outcome, bucket,
 * error_code, is_test) rather than making the row NULL-distinct.
 *
 * Takes one named object rather than five positionals: `outcome`, `bucketCode`
 * and `errorCode` are all strings and `isTest` sits beside them, and a pair of
 * same-typed positionals silently swapped is a defect this codebase has already
 * shipped once (#1220).
 */
export function outcomeTallyArgs(input: TallyInput): TallyArgs {
  const day = DateTime.fromMillis(input.atMs, { zone: OUTCOME_DAY_ZONE }).toISODate() ?? "";
  return {
    p_day: day,
    p_outcome: input.outcome,
    p_bucket: input.bucketCode,
    p_error_code: input.errorCode ?? "",
    p_is_test: input.isTest,
    p_host_class: input.hostClass,
  };
}

export interface OutcomeSlice {
  outcome: OutcomeName;
  count: number;
  pct: number;
}

export interface ErrorSlice {
  code: string;
  count: number;
}

export interface OutcomeMix {
  total: number;
  outcomes: OutcomeSlice[];
  errors: ErrorSlice[];
  /**
   * How many TEST attempts fell in this window (#1616), or null when the read did
   * not report it. Null, never 0: "the canary wrote nothing this week" and "we
   * could not count what we hid" are different facts, and a panel that shows a
   * smaller number without saying what it left out is the silently-smaller-number
   * the issue rules out.
   */
  testTotal: number | null;
  /**
   * How many attempts on REAL buckets came from a page that is not the production
   * site in this window (#2752), or null when the read did not report it. Null,
   * never 0, for the same reason as `testTotal`.
   */
  offsiteTotal: number | null;
  /**
   * The self-inflicted refusals (#1442 / #1450 / #1709), carried on the SAME
   * reading rather than fetched separately: four cron lanes share one invocation's
   * subrequest budget, so a second RPC for three numbers already in this row
   * would be spending that budget to learn nothing new.
   *
   * Deliberately NOT folded into `total` or `outcomes`: see SELF_INFLICTED_REFUSALS.
   */
  refusals: RefusalCounts;
  /**
   * #3267: confirms that answered the booking and left the work after the save to
   * the reservation drain (`follow_up_left_to_drain`), each also counted as `created`.
   * Outside `total` for the same reason as the refusals: it is a second row about a
   * confirm already counted, never an attempt of its own.
   */
  followUpLeftToDrain: number;
  /**
   * #3797: times refused at the free check that were PROVEN lost races: free when the
   * lead's list was computed, taken since. Recorded in place of the error, outside
   * `total`, so they are in neither the failure share's attempts nor its failures, and
   * shown on the panel so a reader can still see how often leads lose one.
   */
  lostRacesSinceOffer: number;
  /**
   * #2377: every answer POST /api/bookings/cancel-duplicate gave, by its tally name
   * (`DUPLICATE_CANCEL_TALLY_NAMES`), zero filled. Outside `total` for the same reason
   * as the refusals: a duplicate cancel is not a booking attempt, and counting it there
   * would move the denominator the failure share is taken against.
   */
  duplicateCancel: Record<string, number>;
}

/** The jsonb shape the booking_api_outcome_mix RPC returns for a window. */
export interface RawMix {
  by_outcome?: Record<string, number> | null;
  by_error?: Record<string, number> | null;
  /** #1616, migration 0108. Absent from a pre-0108 function and from a failed read. */
  test_total?: number | null;
  /** #2752, migration 0143. Absent from a pre-0143 function and from a failed read. */
  offsite_total?: number | null;
}

/**
 * Normalize the mix RPC's jsonb into an ordered, percentage-carrying view. Always
 * returns every outcome row (zero-filled) so the panel layout is stable, and the
 * error slice sorted by count desc. A null/absent result normalizes to an empty
 * mix rather than throwing.
 */
export function normalizeMix(raw: RawMix | null | undefined): OutcomeMix {
  const byOutcome = raw?.by_outcome ?? {};
  const byError = raw?.by_error ?? {};
  const total = OUTCOME_ORDER.reduce((sum, o) => sum + (byOutcome[o] ?? 0), 0);
  const outcomes: OutcomeSlice[] = OUTCOME_ORDER.map((outcome) => {
    const count = byOutcome[outcome] ?? 0;
    return { outcome, count, pct: total === 0 ? 0 : Math.round((count / total) * 100) };
  });
  const errors: ErrorSlice[] = Object.entries(byError)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const testTotal = typeof raw?.test_total === "number" ? raw.test_total : null;
  const offsiteTotal = typeof raw?.offsite_total === "number" ? raw.offsite_total : null;
  const refusals = emptyRefusalCounts();
  for (const name of SELF_INFLICTED_REFUSALS) refusals[name] = byOutcome[name] ?? 0;
  const followUpLeftToDrain = byOutcome[FOLLOW_UP_LEFT_TO_DRAIN_OUTCOME] ?? 0;
  const lostRacesSinceOffer = byOutcome[OFFER_RACE_OUTCOME] ?? 0;
  const duplicateCancel: Record<string, number> = {};
  for (const name of DUPLICATE_CANCEL_TALLY_NAMES) duplicateCancel[name] = byOutcome[name] ?? 0;
  return { total, outcomes, errors, testTotal, offsiteTotal, refusals, followUpLeftToDrain, lostRacesSinceOffer, duplicateCancel };
}

/**
 * The one sentence the outcome panel shows about what it left out (#1616).
 *
 * The panel HIDES test traffic, so it measures the same population the
 * failure-rate page does and a reader following that page's "the per call
 * breakdown is in the booking outcome panel" is not handed a different number.
 * Hiding is only honest if the reader can see that something was hidden, so the
 * count comes back with the mix and is stated either way.
 *
 * Three states, three sentences, because they are three different facts: some was
 * excluded, none existed, and it could not be counted (L11). The last one must
 * never render as "0 excluded".
 */
export function excludedTestTrafficNote(testTotal: number | null): string {
  if (testTotal === null) {
    return "Could not count the smoke canary calls this window leaves out.";
  }
  if (testTotal === 0) return "No smoke canary calls in this window.";
  const calls = testTotal === 1 ? "call" : "calls";
  return `Excludes ${testTotal} smoke canary ${calls}.`;
}

/**
 * The second sentence the outcome panel shows about what it left out (#2752):
 * attempts on real buckets made from a page that is not the production site,
 * which is where testers book. Same three states as the canary note, for the same
 * reason (L11): some left out, none, and could not count.
 */
export function excludedOffsiteTrafficNote(offsiteTotal: number | null): string {
  if (offsiteTotal === null) {
    return "Could not count the calls from pages other than the production site this window leaves out.";
  }
  if (offsiteTotal === 0) return "No calls from pages other than the production site in this window.";
  const calls = offsiteTotal === 1 ? "call" : "calls";
  return `Excludes ${offsiteTotal} ${calls} from pages other than the production site.`;
}

/**
 * The third thing the outcome panel leaves out (#3797): refusals proven to be lost
 * races, a time another booking took after the lead's list was computed. They are
 * ordinary contention, kept out of the failure share, and stated here so a quiet
 * share on a busy night is not read as nobody being refused.
 */
export function excludedLostRacesNote(lostRaces: number): string {
  if (lostRaces === 0) return "No lost races in this window.";
  const races = lostRaces === 1 ? "lost race" : "lost races";
  const times = lostRaces === 1 ? "a time" : "times";
  return `Excludes ${lostRaces} ${races}: ${times} another booking took after the lead's list loaded.`;
}
