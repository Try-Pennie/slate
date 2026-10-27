import type { Attributes, Criteria } from "@/lib/db/types";
import type { CoverageBookingRow } from "@/lib/booking/bulk-reassign-store";
import { unservedBookingIds, type RerouteCandidate } from "@/lib/booking/reroute-eligibility";

/**
 * One of the agent's upcoming bookings as the filtered demotion snapshot reads it: the row
 * fields a notice names (`CoverageBookingRow`), plus the `bucket_id` and `kind` the
 * eligibility join needs. The IO wrapper (`demotionBookings` in `bulk-reassign-store.ts`)
 * reads these; this module decides from them.
 */
export interface DemotionCandidateRow extends CoverageBookingRow {
  bucket_id: string;
  kind: string;
}

/**
 * The agent's upcoming bookings as `RerouteCandidate`s: the join (criteria looked up by
 * `bucket_id`, manual membership by set) that both the filtered snapshot and the demotion
 * DECISION (`planDemotionAction`, which needs every booking to run `bookingsToReroute`) read
 * from. Shared so the snapshot and the decision can never build a different candidate set
 * (L342).
 */
export function toRerouteCandidates(
  rows: DemotionCandidateRow[],
  criteriaByBucket: Map<string, Criteria | null>,
  manualMemberBucketIds: Set<string>,
): RerouteCandidate[] {
  return rows.map((r) => ({
    bookingId: r.id,
    kind: r.kind,
    criteria: criteriaByBucket.get(r.bucket_id) ?? null,
    isManualMember: manualMemberBucketIds.has(r.bucket_id),
  }));
}

/**
 * The FILTERED snapshot of a demotion sweep (#3582, Phase 4): of the agent's upcoming
 * bookings, the ones they no longer serve under the given `attributes`, as `CoverageBookingRow`s
 * (so the count, the work the sweep snapshots and any notice can never disagree, L16). Unlike
 * `coverageBookings` (every upcoming booking, correct only for a FULL pool exit) it keeps only
 * the bookings in the pools the agent LOST.
 *
 * Pure: it does the join (via `toRerouteCandidates`) and then delegates the eligibility verdict
 * to `unservedBookingIds`, which shares `agentStillServes` with the booker's own pool resolver,
 * so a snapshot can never move a booking the booker would still have offered this agent (L263,
 * L342).
 *
 * The fail-safes ride on `unservedBookingIds`: null/undefined `attributes` (a failed read) moves
 * NOBODY (L214, L50), and an `agent_link` booking is never moved. A manual member serves every
 * booking in their bucket, so none of theirs is kept.
 *
 * `criteriaByBucket` is complete for every `bucket_id` present in production: the IO wrapper
 * (`demotionBookings`) reads all referenced buckets and THROWS on a read error OR a missing
 * bucket rather than passing a partial map, so a failed or short read can never read as "no
 * criteria" and move everything (L214, L184). A GENUINELY empty-criteria bucket is present with
 * a null value and is served only via manual membership. This function keeps a defensive
 * fallback: a key somehow absent reads as null criteria, which `agentStillServes` scores as
 * not-served, so the booking MOVES rather than being silently kept, the safe side, since a
 * wrongly-moved booking is recoverable through the admin undo while a wrongly-kept one strands a
 * customer with an ineligible advisor (L648).
 */
export function selectDemotionBookings(
  attributes: Attributes | null | undefined,
  rows: DemotionCandidateRow[],
  criteriaByBucket: Map<string, Criteria | null>,
  manualMemberBucketIds: Set<string>,
): CoverageBookingRow[] {
  const candidates = toRerouteCandidates(rows, criteriaByBucket, manualMemberBucketIds);
  const moveIds = new Set(unservedBookingIds(attributes, candidates));
  return rows
    .filter((r) => moveIds.has(r.id))
    .map(({ id, starts_at, ends_at, attendee_name }) => ({ id, starts_at, ends_at, attendee_name }));
}

/**
 * Build the criteria map from a buckets read, requiring EVERY requested bucket to be present.
 * `bookings.bucket_id` is NOT NULL and references `buckets`, and buckets never fills a page, so
 * a missing bucket is a genuine anomaly (or a short/failed read), never an empty-criteria
 * bucket, which is present here with a null value. Throwing rather than returning a partial map
 * is what stops a demotion snapshot mass-moving off an incomplete read: an absent key would
 * otherwise read as null criteria and move the booking (L214, L184).
 */
export function criteriaMapOrThrow(
  bucketIds: string[],
  rows: { id: string; criteria: Criteria | null }[],
): Map<string, Criteria | null> {
  const byId = new Map<string, Criteria | null>(rows.map((r) => [r.id, r.criteria ?? null]));
  const missing = bucketIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `demotion snapshot: buckets read returned ${rows.length} of ${bucketIds.length}; missing ${missing.join(", ")}`,
    );
  }
  return byId;
}

/**
 * The four reads a demotion snapshot needs, injected so `assembleDemotionSnapshot` is pure of
 * the database and node-testable. Each MUST fail loud (throw) on a read error rather than
 * returning empty, so a failed query can never be mistaken for "nothing to move" (L184): the
 * live binding in `bulk-reassign-store.ts` reads through `unwrap`, which throws on error and
 * passes a genuine not-found through as null.
 */
export interface DemotionSnapshotReaders {
  /** The agent's upcoming active bookings, with each booking's bucket and kind. */
  candidates(): Promise<DemotionCandidateRow[]>;
  /** The agent's CURRENT attributes, or null when the agent row is genuinely absent (which
   *  moves nobody, the fail-safe). A read ERROR must throw, never resolve to null. */
  agentAttributes(): Promise<Attributes | null>;
  /** The criteria of each given bucket, complete for every id passed. */
  bucketCriteria(bucketIds: string[]): Promise<Map<string, Criteria | null>>;
  /** The buckets the agent is an ACTIVE manual member of. */
  manualMemberBucketIds(): Promise<Set<string>>;
  /** The calls an admin moved BACK to this agent after a demotion move (#3615): pinned to them,
   *  so neither the sweep nor the decision weighs them again. A read error must throw. */
  pinnedBookingIds(): Promise<Set<string>>;
}

/** The agent's upcoming bookings without the ones an admin moved back to them (#3615). Read only
 *  when the agent holds something, like the other reads. */
async function unpinnedCandidates(
  readers: Pick<DemotionSnapshotReaders, "candidates" | "pinnedBookingIds">,
): Promise<DemotionCandidateRow[]> {
  const candidates = await readers.candidates();
  if (candidates.length === 0) return [];
  const pinned = await readers.pinnedBookingIds();
  return pinned.size === 0 ? candidates : candidates.filter((c) => !pinned.has(c.id));
}

/**
 * Build the filtered demotion snapshot from its four reads (#3582, Phase 4). Reads the agent's
 * upcoming bookings first and SHORT-CIRCUITS when there are none, so an agent holding nothing
 * costs one query rather than four on the shared cron budget. The bucket criteria are read once
 * per DISTINCT bucket. Any read that throws propagates, so a partial read never becomes a
 * snapshot that moves the wrong set (L184).
 */
export async function assembleDemotionSnapshot(
  readers: DemotionSnapshotReaders,
): Promise<CoverageBookingRow[]> {
  const candidates = await unpinnedCandidates(readers);
  if (candidates.length === 0) return [];
  const bucketIds = [...new Set(candidates.map((c) => c.bucket_id))];
  const [attributes, criteriaByBucket, manualMemberBucketIds] = await Promise.all([
    readers.agentAttributes(),
    readers.bucketCriteria(bucketIds),
    readers.manualMemberBucketIds(),
  ]);
  return selectDemotionBookings(attributes, candidates, criteriaByBucket, manualMemberBucketIds);
}

/**
 * The agent's upcoming bookings as `RerouteCandidate`s (#3582, Phase 3), which the demotion
 * DECISION needs: `planDemotionAction` runs `bookingsToReroute` over EVERY held booking, so
 * unlike the filtered snapshot this returns them all. Does not read the agent's attributes
 * (the decision supplies before/after itself). Short-circuits when the agent holds nothing, and
 * any read that throws propagates so a partial read never becomes a decision (L184).
 */
export async function assembleRerouteCandidates(
  readers: Omit<DemotionSnapshotReaders, "agentAttributes">,
): Promise<RerouteCandidate[]> {
  const candidates = await unpinnedCandidates(readers);
  if (candidates.length === 0) return [];
  const bucketIds = [...new Set(candidates.map((c) => c.bucket_id))];
  const [criteriaByBucket, manualMemberBucketIds] = await Promise.all([
    readers.bucketCriteria(bucketIds),
    readers.manualMemberBucketIds(),
  ]);
  return toRerouteCandidates(candidates, criteriaByBucket, manualMemberBucketIds);
}

/**
 * Which of a demotion sweep's calls the advisor holding them can take AGAIN (#4052), given the
 * calls each advisor cannot serve under their tiers NOW (`unservedBookingIds`, the rule the sweep
 * moved by, L342). Null for an advisor means their tiers could not be read, which answers
 * nothing: their calls are not taken again, so the move, the count and the page behave as they
 * always did. Pure.
 *
 * 2026-10-21: an advisor lost Medium at 3 PM ET, calls were left unplaceable, Medium came back
 * that evening, and the hourly retry kept trying to move them off an advisor who could take them.
 */
export function callsTakenAgain(
  calls: readonly { bookingId: string; outUserId: string }[],
  unservedNowByUser: ReadonlyMap<string, ReadonlySet<string> | null>,
): Set<string> {
  const again = new Set<string>();
  for (const c of calls) {
    const unserved = unservedNowByUser.get(c.outUserId);
    if (unserved != null && !unserved.has(c.bookingId)) again.add(c.bookingId);
  }
  return again;
}
