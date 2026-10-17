/**
 * Was a time refused at the free check a LOST RACE, or a stale offer (#3797)?
 *
 * `booking_failure_rate` paged at 12:35am ET on 2026-10-16 on seven refusals, and six
 * were ordinary lost races on thin Saturday capacity: the time was really free when
 * the lead's list was computed, and another booking (or an event added to an
 * advisor's calendar from outside Slate) took the last free advisor before the lead
 * pressed confirm. The cache was right every time, and the page sent the reader to it.
 * A lost race at the INSERT was already counted apart (#2838); one lost a step
 * earlier, at the cached free check, read as `candidate_read_empty`, inside the share,
 * indistinguishable from the stale row the stored offer check exists to catch
 * (#3366, #3633).
 *
 * Dan, 2026-10-16: a PROVEN race is counted apart and does not page. Only a time
 * offered when it was never free pages. So the rule is built to prove, and anything
 * it cannot prove stays a stale offer:
 *
 *  - The confirm carries the `computed_at` of the slot list the lead picked from. A
 *    refusal that carried none is not judged at all (`null`), and one whose stamp
 *    cannot be read is `unknown`. Neither is ever a race.
 *  - It is a race when some advisor in the refusing pools has busy time over the
 *    requested window, and EVERY such block was created after that `computed_at`: the
 *    advisor was free when the list was computed, and something has taken them since.
 *    A block whose stamp cannot be read counts as old, so it can only stop a race.
 *  - Unless Slate had ALREADY proven the row stale (the 2026-10-16 comment): an
 *    earlier refusal whose stored row still offered its refused time, made after this
 *    list was computed, means the lead was handed a list Slate already knew was wrong.
 *    That is a stale offer whatever the blocking write's timestamp (the 10:02:45pm
 *    reload). The proof is kept per bucket CODE, because `bucket_slots` holds one row
 *    per code and the stored offer check proves one row at a time ("112:offered"); a
 *    pool refresh rewrites its sibling codes' rows with it, so a list served from a
 *    sibling after that is newer than the proof anyway.
 *
 * What it does NOT see, so a green replay is never read as more than it is (L400):
 * an advisor taken by the daily cap (a booking at another time that day), or one whose
 * working hours alone kept them off the time, has no block over the window, so neither
 * can make a race; and an advisor off shift whose calendar gains an event after the
 * list was computed reads as taken, which is the one way this can call a stale offer a
 * race. Measured against the seven refusals of that night it named exactly the bookings
 * and the outside event the investigation found by hand.
 *
 * Pure, with no `@/` imports, so `scripts/test-offer-race.ts` drives it node natively.
 */

/** The tally outcome a proven race is recorded under, beside the ordinary outcomes and
 *  OUTSIDE `OUTCOME_ORDER`, so it is in neither the failure share's attempts nor its
 *  failures (the self inflicted refusals' trick, #1442). One constant for both routes,
 *  the mix reader and the tests. */
export const OFFER_RACE_OUTCOME = "race_since_offer";

/**
 * What the judge concluded about one refusal:
 *  - `race`: proven, so counted apart and never paged on;
 *  - `stale_offer`: judged, and nothing proves a race (or the row was proven stale);
 *  - `unknown`: could not be judged (an unreadable stamp, a failed read).
 * Only `race` leaves the failure share; the other two count exactly as before.
 */
export type OfferVerdict = "race" | "stale_offer" | "unknown";
export const OFFER_VERDICTS: readonly OfferVerdict[] = ["race", "stale_offer", "unknown"];

/** One busy block over the requested window, as the judge needs it. */
export interface BlockingWrite {
  userId: string;
  createdAt: string;
  source: string;
}

export interface OfferRaceInput {
  /** The `computed_at` the confirm carried. */
  servedComputedAt: string;
  /** Every advisor in the pools the refusal was read against (each rung tried). */
  memberIds: readonly string[];
  /** Their busy blocks overlapping the requested buffered window. */
  blocks: readonly BlockingWrite[];
  /** The newest instant at which a refusal proved one of these codes' rows stale, or
   *  null when none has. */
  provenStaleAtMs: number | null;
}

export interface OfferRaceJudgement {
  verdict: OfferVerdict;
  /** Why, for the log line: the one fact the verdict rests on. */
  reason: "taken_since_served" | "no_newer_write" | "row_proven_stale" | "unreadable_stamp";
  /** The advisors taken since the list was computed, on a race. */
  takenUserIds: string[];
}

/** A strict ISO-ish stamp to epoch ms, or null. `Date.parse` alone yields NaN, which
 *  compares false both ways and would read every block as old AND new (L50). */
function stampMs(s: string | null | undefined): number | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export function judgeOfferRace(input: OfferRaceInput): OfferRaceJudgement {
  const servedMs = stampMs(input.servedComputedAt);
  if (servedMs === null) return { verdict: "unknown", reason: "unreadable_stamp", takenUserIds: [] };
  // Slate already knew the list was wrong when this lead was handed it.
  if (input.provenStaleAtMs !== null && input.provenStaleAtMs > servedMs) {
    return { verdict: "stale_offer", reason: "row_proven_stale", takenUserIds: [] };
  }
  const members = new Set(input.memberIds);
  // Per advisor: the OLDEST block over the window. Hold blocks are left out, as the
  // candidate read leaves them out (a hold never makes an advisor unavailable to it).
  const oldest = new Map<string, number>();
  for (const b of input.blocks) {
    if (!members.has(b.userId) || b.source === "hold") continue;
    // An unreadable stamp counts as old: it can stop a race, never start one.
    const at = stampMs(b.createdAt) ?? Number.NEGATIVE_INFINITY;
    oldest.set(b.userId, Math.min(oldest.get(b.userId) ?? Number.POSITIVE_INFINITY, at));
  }
  const taken = [...oldest].filter(([, at]) => at > servedMs).map(([id]) => id).sort();
  return taken.length > 0
    ? { verdict: "race", reason: "taken_since_served", takenUserIds: taken }
    : { verdict: "stale_offer", reason: "no_newer_write", takenUserIds: [] };
}

/** The newest stale proof among `proofs` (refusal instants) for these codes, or null. */
export function newestProofMs(proofs: readonly { createdAt: string }[]): number | null {
  let newest: number | null = null;
  for (const p of proofs) {
    const ms = stampMs(p.createdAt);
    if (ms !== null && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}
