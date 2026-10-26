import { unwrap, unwrapCount } from "@/lib/db/result";
import { inIdChunks } from "@/lib/db/id-batch";
import { hasLeftPool, POOL_STATE_COLUMNS, type PoolStateRow } from "@/lib/bookable/left-pool";
import { log } from "@/lib/log";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages, sortByStamp, type PageableQuery } from "@/lib/supabase/paginate";
import { selectRetryableUnplaceable, type RetryableUnplaceable } from "@/lib/booking/coverage-retry";
import type { ActionableBookingContext, BookingSnapshot, ItemOutcome } from "@/lib/booking/bulk-reassign";
import { enqueueCoverageSweep } from "@/lib/booking/coverage-sweep-enqueue";
import {
  cancelCoverageSweep,
  type CoverageSweepCancelReport,
} from "@/lib/booking/coverage-sweep-cancel";
import { coverageSelectionBounds } from "@/lib/booking/coverage-selection";
import {
  assembleDemotionSnapshot,
  assembleRerouteCandidates,
  criteriaMapOrThrow,
  type DemotionCandidateRow,
  type DemotionSnapshotReaders,
} from "@/lib/booking/demotion-snapshot";
import type { RerouteCandidate } from "@/lib/booking/reroute-eligibility";
import type { DemotionChange } from "@/lib/booking/demotion-plan";
import { pinnedByAgent } from "@/lib/booking/demotion-revert";
import type {
  Attributes,
  BookingStatus,
  BulkReassignItem,
  BulkReassignItemStatus,
  BulkReassignJob,
  BulkReassignJobStatus,
  Criteria,
} from "@/lib/db/types";

/**
 * The active-upcoming statuses a coverage sweep moves. Exported so the #1215
 * monitor counts exactly the bookings the coverage panel would enqueue: two
 * definitions of "still needs an agent" would let the page and the panel disagree
 * about the same gap (L16).
 */
export const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ["confirmed", "rescheduled"];

/**
 * The booking ids currently assigned to `outUserId` that need covering.
 *
 * The rule itself lives in `coverage-selection.ts` and is shared with the pure predicate, so
 * this query and anything that counts or previews the same gap cannot drift into meaning
 * different things by "needs covering" (L16).
 *
 * #1237 corrected the third bound. This used to floor the start at the window start, so an
 * appointment that BEGINS before the absence and runs into it was never selected, and the
 * customer kept a slot with an advisor who is away for part of it. The floor is now NOW (never
 * touch one already under way) and the overlap is expressed on `ends_at`, which is the field
 * that actually answers "is this still running when the absence begins".
 *
 * Paginated so an out agent with many upcoming bookings is fully covered rather than truncated
 * to one PostgREST page; the count drives both the preview and the item snapshot.
 */
export async function coverageBookingIds(
  outUserId: string,
  rangeStartIso: string,
  rangeEndIso: string | null,
): Promise<string[]> {
  const rows = await coverageBookings(outUserId, rangeStartIso, rangeEndIso);
  return rows.map((r) => r.id);
}

/**
 * One booking a coverage sweep would move, as a person reads it (#1239).
 *
 * `starts_at` / `ends_at` / `attendee_name` exist so the manager's approved notice can
 * NAME the appointments starting within the next couple of hours. They never decide
 * what moves: that is `movesUnderCoverage` alone, and it carries no lead time.
 */
export interface CoverageBookingRow {
  id: string;
  starts_at: string;
  ends_at: string;
  attendee_name: string | null;
}

/** A bookings select builder, as its own concrete type. Taking the builder's own type (rather
 *  than a hand-written structural interface, which trips TS2589 on the deep PostgREST generics)
 *  keeps `applyUpcomingWindow` an identity pass-through for the type. */
type BookingsSelectBuilder = ReturnType<
  ReturnType<ReturnType<typeof supabaseAdmin>["from"]>["select"]
>;

/**
 * Apply the "upcoming active bookings assigned to this agent" window to a `.from("bookings")`
 * select, whatever columns it selected. The rule lives HERE once so `coverageBookings` and the
 * demotion snapshot can never drift on what "upcoming" means (L16, L342): same statuses, same
 * `coverageSelectionBounds` (strictly after now so one under way is never moved; still running
 * when the absence begins, #1237). It applies NO order: selectAllPages pages by its key alone
 * (#4238), so a caller wanting time order sorts the rows with `byStartTime`. The
 * `.from`/`.select`/tag/key stay at each call site because the paged-read-key guard reads those
 * literally.
 */
function applyUpcomingWindow(
  base: BookingsSelectBuilder,
  outUserId: string,
  bounds: ReturnType<typeof coverageSelectionBounds>,
): PageableQuery {
  let q = base
    .eq("assigned_user_id", outUserId)
    .in("status", ACTIVE_BOOKING_STATUSES)
    // Strictly after now: one already under way is never moved out from under the customer.
    .gt("starts_at", bounds.startsAfterIso)
    // Still running when the absence begins. The bound that was missing (#1237).
    .gt("ends_at", bounds.endsAfterIso);
  // No .order here: selectAllPages pages by its key alone and refuses a query that orders
  // itself (#4238), so a caller wanting time order sorts the rows with `byStartTime`.
  if (bounds.startsBeforeIso) q = q.lt("starts_at", bounds.startsBeforeIso);
  return q;
}

/** Time order, then id, for rows read through `applyUpcomingWindow` (the order the window
 *  itself carried before keyset paging, #4238). Returns a new array. */
function byStartTime<T extends { id: string; starts_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/**
 * The bookings a coverage sweep over this window would move, with enough of each row
 * to describe it. `coverageBookingIds` is this, narrowed to ids: ONE query, so the
 * count in the preview, the work the sweep snapshots and the appointments the notice
 * names can never mean different things (L16).
 */
export async function coverageBookings(
  outUserId: string,
  rangeStartIso: string,
  rangeEndIso: string | null,
): Promise<CoverageBookingRow[]> {
  const bounds = coverageSelectionBounds(
    { startIso: rangeStartIso, endIso: rangeEndIso },
    new Date().toISOString(),
  );
  return byStartTime(
    await selectAllPages<CoverageBookingRow>("bulk-reassign-coverage-bookings", "id", () =>
      // cap-safe: read every page via selectAllPages, which orders and pages it, so an out
      // agent with more than one page of upcoming bookings is fully snapshotted.
      applyUpcomingWindow(
        supabaseAdmin().from("bookings").select("id, starts_at, ends_at, attendee_name"),
        outUserId,
        bounds,
      ),
    ),
  );
}

/**
 * The invites on the bookings a coverage sweep over this window would move (#3667):
 * the SAME window as `coverageBookings`, through the shared `applyUpcomingWindow`, so
 * the invites cleared before the archive and the calls the sweep moves after it can
 * never be two different sets (L16). A booking with no event id holds no invite and
 * is left out.
 */
export async function coverageInvites(
  outUserId: string,
  rangeStartIso: string,
): Promise<{ id: string; gcal_event_id: string }[]> {
  const bounds = coverageSelectionBounds({ startIso: rangeStartIso, endIso: null }, new Date().toISOString());
  const rows = await selectAllPages<{ id: string; gcal_event_id: string | null }>(
    "bulk-reassign-coverage-invites",
    "id",
    () =>
      // cap-safe: read every page via selectAllPages, which orders and pages it.
      applyUpcomingWindow(supabaseAdmin().from("bookings").select("id, gcal_event_id"), outUserId, bounds),
  );
  return rows.flatMap((r) => (r.gcal_event_id ? [{ id: r.id, gcal_event_id: r.gcal_event_id }] : []));
}

/**
 * The shared reads behind the demotion snapshot and the demotion decision: the agent's upcoming
 * bookings (the same window as `coverageBookings`, plus bucket_id and kind), the criteria of the
 * buckets they reference, and the buckets they are a manual member of. The agent's ATTRIBUTES are
 * NOT here: `demotionBookings` supplies them (the decision-time value), and `rerouteCandidatesForAgent`
 * does not need them. Each read goes through `unwrap` / `criteriaMapOrThrow`, so a failed or short
 * read THROWS rather than reading as "nothing to move" (L184).
 */
function demotionSnapshotReaders(
  outUserId: string,
  rangeStartIso: string,
  rangeEndIso: string | null,
): Omit<DemotionSnapshotReaders, "agentAttributes"> {
  const bounds = coverageSelectionBounds(
    { startIso: rangeStartIso, endIso: rangeEndIso },
    new Date().toISOString(),
  );
  return {
    candidates: async () =>
      // The SAME window as coverageBookings (via the shared applyUpcomingWindow), plus the
      // bucket_id and kind the eligibility join needs. Its own inline paged read so the
      // paged-read-key guard can read the table, tag and key literally here.
      byStartTime(
        await selectAllPages<DemotionCandidateRow>("bulk-reassign-demotion-candidates", "id", () =>
          // cap-safe: read every page via selectAllPages, which orders and pages it.
          applyUpcomingWindow(
            supabaseAdmin()
              .from("bookings")
              .select("id, starts_at, ends_at, attendee_name, bucket_id, kind"),
            outUserId,
            bounds,
          ),
        ),
      ),
    bucketCriteria: async (bucketIds) => {
      if (bucketIds.length === 0) return new Map<string, Criteria | null>();
      const rows = unwrap(
        // cap-safe: buckets is roster-bounded (~60) and this is a primary-key `in` over the
        // distinct buckets of one agent's upcoming bookings, so it never fills a page.
        await supabaseAdmin().from("buckets").select("id, criteria").in("id", bucketIds),
        "demotion-bucket-criteria",
      ) as { id: string; criteria: Criteria | null }[];
      // Fails loud when a requested bucket is missing (a short or failed read), so a demotion
      // never mass-moves off an incomplete read (L214, L184). See criteriaMapOrThrow.
      return criteriaMapOrThrow(bucketIds, rows);
    },
    manualMemberBucketIds: async () => {
      const rows = unwrap(
        // cap-safe: bucket_members for one user is bounded by the roster's ~60 buckets.
        await supabaseAdmin()
          .from("bucket_members")
          .select("bucket_id")
          .eq("user_id", outUserId)
          .eq("active", true),
        "demotion-manual-members",
      ) as { bucket_id: string }[];
      return new Set(rows.map((r) => r.bucket_id));
    },
    pinnedBookingIds: async () => (await pinnedDemotionBookingIds([outUserId])).get(outUserId) ?? new Set<string>(),
  };
}

/**
 * The calls an admin moved BACK to each of these agents after a demotion move (#3615), by agent.
 * Pinned to them: the demotion sweep, the demotion decision and the demoted-agent backstop all
 * leave these alone (Dan, 2026-10-11). One read over every agent asked about, so the backstop
 * spends it once rather than per agent. Fails loud on a read error (`selectAllPages` throws), so
 * a failed read can never drop a pin and move a call an admin deliberately kept (L184).
 */
export async function pinnedDemotionBookingIds(outUserIds: string[]): Promise<Map<string, Set<string>>> {
  if (outUserIds.length === 0) return new Map();
  const rows = await selectAllPages<{
    booking_id: string;
    reverted_at: string | null;
    bulk_reassign_jobs: { out_user_id: string } | null;
  }>(
    "demotion-pinned-bookings",
    "id",
    () =>
      // cap-safe: read every page via selectAllPages, which orders and pages it.
      // in-chunk-ok: outUserIds is one agent, or the backstop's currently marked agents, a subset
      // of the bookable roster (design ceiling 200, the in() URL id limit).
      supabaseAdmin()
        .from("bulk_reassign_items")
        .select("id, booking_id, reverted_at, bulk_reassign_jobs!inner(out_user_id, demotion_marked_at)")
        .not("reverted_at", "is", null)
        .not("bulk_reassign_jobs.demotion_marked_at", "is", null)
        .in("bulk_reassign_jobs.out_user_id", outUserIds),
  );
  return pinnedByAgent(rows);
}

/**
 * The FILTERED snapshot for a Twilio tier/pool DEMOTION (#3582): of the agent's upcoming
 * bookings, only the ones they no longer serve under `attributes`, as `CoverageBookingRow`s.
 * Unlike `coverageBookings` (every upcoming booking, for a FULL pool exit) it keeps only the
 * bookings in the pools the agent LOST.
 *
 * `attributes` are PASSED IN, the agent's eligibility as the decision saw it, rather than
 * re-read here: when a sweep coincides with a tier change this sync, the narrowed attributes
 * have not been written to the database yet (the swept-marker write comes after the enqueue), so
 * re-reading would filter against the agent's OLD eligibility and move the wrong set. The
 * bookings themselves ARE re-read on every call (including the conflict re-snapshot), so a
 * booking that landed between the decision and the enqueue is still caught. The bucket criteria
 * and manual membership reads fail loud (`unwrap`, `criteriaMapOrThrow`), so a partial read
 * throws rather than moving everything (L184).
 */
export async function demotionBookings(
  outUserId: string,
  rangeStartIso: string,
  rangeEndIso: string | null,
  attributes: Attributes | null | undefined,
): Promise<CoverageBookingRow[]> {
  return assembleDemotionSnapshot({
    ...demotionSnapshotReaders(outUserId, rangeStartIso, rangeEndIso),
    agentAttributes: async () => attributes ?? null,
  });
}

/**
 * The agent's upcoming bookings as `RerouteCandidate`s, for the demotion DECISION (#3582): the
 * demotion trigger runs `planDemotionAction` (which runs `bookingsToReroute` over EVERY held
 * booking), so this returns them all, unlike `demotionBookings` which filters to the lost-pool
 * set for the enqueue. Shares the same reads, so the decision and the snapshot never build a
 * different candidate set (L342).
 */
export async function rerouteCandidatesForAgent(
  outUserId: string,
  rangeStartIso: string,
  rangeEndIso: string | null,
): Promise<RerouteCandidate[]> {
  return assembleRerouteCandidates(demotionSnapshotReaders(outUserId, rangeStartIso, rangeEndIso));
}

export interface CreateBulkReassignJobInput {
  orgId: string;
  outUserId: string;
  rangeStartIso: string;
  rangeEndIso: string | null;
  reasonCode: string;
  reasonDetail: string | null;
  createdBy: string | null;
  actingAsUserId: string | null;
  /** The approved time-off request this sweep covers (#1235), when it came from
   *  one. Present means the enqueue is idempotent by database constraint: a unique
   *  key on (request, window) makes re-running the approval converge on one sweep
   *  rather than creating a second. Absent for an admin-initiated sweep. */
  oooRequestId?: string | null;
  /** The offboarding deactivation this sweep covers (#1241), when the lifecycle API
   *  triggered it. The agent's stored `deactivated_at`, which is both the window
   *  start and, paired with the agent, the idempotency key: a retried or concurrent
   *  offboarding call reads the same stamp back and converges on one sweep. Absent
   *  for every other sweep. */
  offboardingDeactivatedAtIso?: string | null;
  /** The Twilio redistribute pool exit this sweep covers (#2115), when the hourly
   *  roster sync triggered it. The moment Slate marked the agent, stored on their
   *  own `attributes.redistribute_at` in the same write as the mark, which is both
   *  the window start and, paired with the agent, the idempotency key: a sync that
   *  died mid flip reads the same stamp back and converges on one sweep. Absent for
   *  every other sweep. */
  redistributeMarkedAtIso?: string | null;
  /** The Twilio tier/pool DEMOTION this sweep covers (#3582), when the hourly roster sync
   *  triggered it. The moment Slate stamped the demotion, stored on the agent's own
   *  `attributes.demotion_marked_at` in the same write as the narrowed tiers, which is both
   *  the window start and, paired with the agent, the idempotency key: a sync that died mid
   *  flip reads the same stamp back and converges on one sweep. Absent for every other sweep.
   *  Unlike the three keys above, a demotion is PARTIAL (the agent still serves the pools they
   *  kept), so it is paired with `snapshotBookings` below rather than the full coverage read. */
  demotionMarkedAtIso?: string | null;
  /** What the demotion behind this sweep changed (#3615), recorded on the job so each move's
   *  audit row and the undo screen can say it. Null or absent for every other sweep, and for a
   *  demotion whose earlier tiers were never saved. */
  demotionChange?: DemotionChange | null;
  /** The bookings this sweep should move, when the caller already knows them (the demotion
   *  case passes the FILTERED set, only the bookings the agent no longer serves, via
   *  `demotionBookings`). Absent means the full coverage read, which is correct for a pool
   *  exit but would move the still-served bookings of a partial demotion. The conflict path
   *  re-snapshots through this too, so a crashed first attempt still converges on its work. */
  snapshotBookings?: () => Promise<CoverageBookingRow[]>;
}

/** Postgres unique-violation. The ONLY error class that means "a sweep already
 *  exists for this request and window"; anything else is a real error and must not
 *  be mistaken for it. */
const UNIQUE_VIOLATION = "23505";

/** How many booking ids ride in one `in()` filter. The filter is part of the URL,
 *  so a long list is REFUSED, not truncated: 200 uuids are fine and 400 are not. */
const RE_ARM_CHUNK = 100;

/**
 * Create a coverage sweep and snapshot its work: insert the job, then one pending
 * item per booking currently assigned to the out agent in range. A job with no
 * bookings to move is born already `done`. Fails loud on any write error so a
 * half-created job can't look like a successful empty sweep.
 *
 * The two-write shape is why the conflict path re-snapshots rather than just
 * returning the existing job: see `coverage-sweep-enqueue.ts`, which holds that
 * decision and its tests. This function is only the IO.
 */
export async function createBulkReassignJob(
  input: CreateBulkReassignJobInput,
): Promise<{ jobId: string; itemCount: number; snapshot: CoverageBookingRow[] }> {
  const oooRequestId = input.oooRequestId ?? null;
  const offboardingDeactivatedAt = input.offboardingDeactivatedAtIso ?? null;
  const redistributeMarkedAt = input.redistributeMarkedAtIso ?? null;
  const demotionMarkedAt = input.demotionMarkedAtIso ?? null;
  // The rows this run snapshotted, kept so the caller can describe the work to a
  // person (#1239) without asking the database the same question a second time and
  // getting a different answer. The enqueue layer itself only ever needs the ids.
  //
  // Assigned on EVERY path through the enqueue, including the #1241 offboarding key
  // and the convergent conflict path, because `snapshotBookingIds` is what both of
  // them snapshot with: there is no route to a job that leaves this holding the
  // wrong rows for the run that just happened.
  let snapshot: CoverageBookingRow[] = [];
  const result = await enqueueCoverageSweep({
    snapshotBookingIds: async () => {
      // A demotion passes the FILTERED set (only the bookings the agent no longer serves);
      // every other sweep reads the full coverage window. Both resolve into `snapshot`, so the
      // conflict path re-snapshots through the same source and the caller's notice describes
      // exactly what this run moved.
      snapshot = input.snapshotBookings
        ? await input.snapshotBookings()
        : await coverageBookings(input.outUserId, input.rangeStartIso, input.rangeEndIso);
      return snapshot.map((r) => r.id);
    },

    insertJob: async (status) => {
      const { data, error } = await supabaseAdmin()
        .from("bulk_reassign_jobs")
        .insert({
          org_id: input.orgId,
          out_user_id: input.outUserId,
          range_start: input.rangeStartIso,
          range_end: input.rangeEndIso,
          reason_code: input.reasonCode,
          reason_detail: input.reasonDetail,
          status,
          created_by: input.createdBy,
          acting_as_user_id: input.actingAsUserId,
          ooo_request_id: oooRequestId,
          offboarding_deactivated_at: offboardingDeactivatedAt,
          redistribute_marked_at: redistributeMarkedAt,
          demotion_marked_at: demotionMarkedAt,
          demotion_change: input.demotionChange ?? null,
        })
        .select("id")
        .single();
      if (error) {
        return { ok: false, conflict: error.code === UNIQUE_VIOLATION, message: error.message };
      }
      if (!data) return { ok: false, conflict: false, message: "no row returned" };
      return { ok: true, jobId: (data as { id: string }).id };
    },

    findExistingJob: async () => {
      // #1241: an offboarding sweep is keyed on (agent, deactivation) instead of
      // (request, window). Same convergent conflict path, different unique index,
      // so the lookup has to ask the question that index answers.
      if (offboardingDeactivatedAt) {
        const row = unwrap(
          await supabaseAdmin()
            .from("bulk_reassign_jobs")
            // cap-safe: the unique index on (out_user_id, offboarding_deactivated_at)
            // means this matches at most one row.
            .select("id")
            .eq("out_user_id", input.outUserId)
            .eq("offboarding_deactivated_at", offboardingDeactivatedAt)
            .maybeSingle(),
          "find-existing-offboarding-sweep",
        ) as { id: string } | null;
        return row ?? null;
      }
      // #2115: a redistribute sweep is keyed on (agent, mark) instead. Same
      // convergent conflict path, a third unique index, so the lookup has to ask
      // the question THAT index answers.
      if (redistributeMarkedAt) {
        const row = unwrap(
          await supabaseAdmin()
            .from("bulk_reassign_jobs")
            // cap-safe: the unique index on (out_user_id, redistribute_marked_at)
            // means this matches at most one row.
            .select("id")
            .eq("out_user_id", input.outUserId)
            .eq("redistribute_marked_at", redistributeMarkedAt)
            .maybeSingle(),
          "find-existing-redistribute-sweep",
        ) as { id: string } | null;
        return row ?? null;
      }
      // #3582: a demotion sweep is keyed on (agent, demotion mark), a fourth unique index.
      // Same convergent conflict path, so the lookup asks the question THAT index answers.
      if (demotionMarkedAt) {
        const row = unwrap(
          await supabaseAdmin()
            .from("bulk_reassign_jobs")
            // cap-safe: the unique index on (out_user_id, demotion_marked_at) means this
            // matches at most one row.
            .select("id")
            .eq("out_user_id", input.outUserId)
            .eq("demotion_marked_at", demotionMarkedAt)
            .maybeSingle(),
          "find-existing-demotion-sweep",
        ) as { id: string } | null;
        return row ?? null;
      }
      if (!oooRequestId) return null;
      let q = supabaseAdmin()
        .from("bulk_reassign_jobs")
        // cap-safe: the unique index on (ooo_request_id, range_start, range_end)
        // means this matches at most one row.
        .select("id")
        .eq("ooo_request_id", oooRequestId)
        .eq("range_start", input.rangeStartIso);
      q = input.rangeEndIso === null ? q.is("range_end", null) : q.eq("range_end", input.rangeEndIso);
      const data = unwrap(await q.maybeSingle(), "find-existing-coverage-sweep") as { id: string } | null;
      return data ?? null;
    },

    addItems: async (jobId, bookingIds) => {
      // ignoreDuplicates on the existing UNIQUE(job_id, booking_id): re-snapshotting
      // can never insert a booking twice, and `.select()` reports what was NEWLY
      // added, which is what decides whether the job gained work.
      const { data, error } = await supabaseAdmin()
        .from("bulk_reassign_items")
        .upsert(
          bookingIds.map((booking_id) => ({ job_id: jobId, booking_id })),
          { onConflict: "job_id,booking_id", ignoreDuplicates: true },
        )
        .select("id");
      if (error) throw new Error(`bulk-reassign items insert failed: ${error.message}`);
      return (data as { id: string }[] | null)?.length ?? 0;
    },

    reArmCancelledItems: async (jobId, bookingIds) => {
      // Chunked because an `in()` filter rides in the URL, and a long enough list
      // is refused by PostgREST rather than truncated (PR#1251 shipped a 500-id
      // batch that failed outright).
      let reArmed = 0;
      for (let i = 0; i < bookingIds.length; i += RE_ARM_CHUNK) {
        reArmed += unwrapCount(
          await supabaseAdmin()
            .from("bulk_reassign_items")
            .update(
              { status: "pending", detail: null, updated_at: new Date().toISOString() },
              { count: "exact" },
            )
            .eq("job_id", jobId)
            .in("booking_id", bookingIds.slice(i, i + RE_ARM_CHUNK))
            // Only ones a cancellation stopped. A 'moved' item can never be re-armed
            // this way, so a re-approval cannot hand the same customer over twice.
            .eq("status", "cancelled"),
          "re-arm-cancelled-coverage-items",
        );
      }
      return reArmed;
    },

    reactivateJob: async (jobId) => {
      const { error } = await supabaseAdmin()
        .from("bulk_reassign_jobs")
        .update({ status: "active", updated_at: new Date().toISOString() })
        .eq("id", jobId);
      if (error) throw new Error(`bulk-reassign job reactivate failed: ${error.message}`);
    },
  });
  return { ...result, snapshot };
}

/**
 * The oldest pending items, bounded per tick, each paired with its job. Keyed on the
 * ITEM's status, never the job's: the drain picks up a pending item whatever its sweep's
 * status. That is usually an active sweep (a sweep is flipped 'done' only once it has zero
 * pending items), but the #3485 hourly retry re-arms a stranded item under a sweep it
 * leaves 'done', and the drain must still process it, which is why the job is loaded by id
 * rather than filtered on. The jobs are loaded in a second primary-key query (at most one
 * per distinct job). Fails loud on a read error (the lane catches, logs, and retries)
 * rather than draining nothing silently, which would look like "no work left".
 */
export async function loadPendingBulkReassignItems(
  limit: number,
  /** #3615: one sweep's items only, for the reroute drill. Absent means every sweep's. */
  jobId?: string,
): Promise<{ item: BulkReassignItem; job: BulkReassignJob }[]> {
  let q = supabaseAdmin()
    .from("bulk_reassign_items")
    // cap-safe: bounded by the explicit .limit(limit) below.
    .select("*")
    .eq("status", "pending");
  if (jobId) q = q.eq("job_id", jobId);
  const items = (unwrap(
    await q.order("created_at", { ascending: true }).limit(limit),
    "load-pending-bulk-reassign-items",
  ) as BulkReassignItem[] | null) ?? [];
  if (items.length === 0) return [];

  const jobIds = [...new Set(items.map((it) => it.job_id))];
  const jobs = (unwrap(
    await supabaseAdmin()
      .from("bulk_reassign_jobs")
      // cap-safe: primary-key lookup of the (few) jobs these items belong to.
      .select("*")
      .in("id", jobIds),
    "load-bulk-reassign-jobs",
  ) as BulkReassignJob[] | null) ?? [];
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  return items.flatMap((item) => {
    const job = jobById.get(item.job_id);
    return job ? [{ item, job }] : [];
  });
}

/** How many of one sweep's items are still pending (#3615), as a server side count. */
export async function countPendingBulkReassignItems(jobId: string): Promise<number> {
  return unwrapCount(
    await supabaseAdmin()
      .from("bulk_reassign_items")
      // cap-safe: server-side count (head:true), no rows returned.
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .eq("status", "pending"),
    "count-pending-bulk-reassign-items",
  );
}

/**
 * Unplaceable coverage items that are still stranded (#3485 part C), each paired with its
 * sweep's status, for the hourly retry. "Still stranded" is the same predicate the monitor
 * uses (L342): the booking is active and UPCOMING (a passed call is never re-attempted), it
 * is STILL on the sweep's out agent (one already moved off is not, and would just re-settle
 * `moved`), and it is NOT a Redistribute sweep whose agent is back in the pool (#3597: that
 * call is covered, and re-arming it would move it off the now-available agent). The sweep
 * status lets the retry skip a cancelled sweep. Only `unplaceable` is retried, not `failed`:
 * "nobody was free" self-heals as calendars open, whereas a move that kept erroring is a
 * systemic fault for a person. Fails loud on a read error (the lane catches and retries).
 */
export async function loadRetryableUnplaceable(nowIso: string): Promise<RetryableUnplaceable[]> {
  const items = await selectAllPages<{ id: string; job_id: string; booking_id: string }>(
    "load-retryable-unplaceable-items",
    "id",
    () =>
      supabaseAdmin()
        .from("bulk_reassign_items")
        .select("id, job_id, booking_id")
        .eq("status", "unplaceable"),
  );
  if (items.length === 0) return [];
  // Who holds each item's booking now, for the active+upcoming ones only, and whether that
  // holder is back IN THE POOL (#3597). A missing entry means the booking is gone, inactive
  // or in the past, so the item is not retryable.
  const holderByBooking = new Map<string, { assignedUserId: string | null; inPool: boolean }>();
  await inIdChunks(
    "load-retryable-unplaceable bookings",
    [...new Set(items.map((i) => i.booking_id))],
    async (batch) => {
      const rows = (unwrap(
        await supabaseAdmin()
          .from("bookings")
          // cap-safe: primary-key lookup, already split to the URL budget.
          .select(`id, assigned_user_id, users!bookings_assigned_user_id_fkey(${POOL_STATE_COLUMNS})`)
          .in("id", batch)
          .in("status", ACTIVE_BOOKING_STATUSES)
          .gte("starts_at", nowIso),
        "load-retryable-unplaceable bookings",
      ) ?? []) as { id: string; assigned_user_id: string | null; users: PoolStateRow | null }[];
      for (const r of rows) {
        holderByBooking.set(r.id, {
          assignedUserId: r.assigned_user_id,
          inPool: r.users != null && !hasLeftPool(r.users),
        });
      }
      return rows.length;
    },
  );
  const live = items.filter((i) => holderByBooking.has(i.booking_id));
  if (live.length === 0) return [];
  // Attach each item's sweep status, out agent, AND whether it was a Redistribute sweep, so
  // the retry can skip a cancelled sweep, confirm the call is STILL on the out agent, and
  // apply the #3597 rule below.
  const jobById = new Map<
    string,
    { status: BulkReassignJobStatus; outUserId: string; fromRedistribute: boolean }
  >();
  await inIdChunks(
    "load-retryable-unplaceable jobs",
    [...new Set(live.map((i) => i.job_id))],
    async (batch) => {
      const rows = (unwrap(
        await supabaseAdmin()
          .from("bulk_reassign_jobs")
          // cap-safe: primary-key lookup, already split to the URL budget.
          .select("id, status, out_user_id, redistribute_marked_at")
          .in("id", batch),
        "load-retryable-unplaceable jobs",
      ) ?? []) as {
        id: string;
        status: BulkReassignJobStatus;
        out_user_id: string;
        redistribute_marked_at: string | null;
      }[];
      for (const r of rows) {
        jobById.set(r.id, {
          status: r.status,
          outUserId: r.out_user_id,
          fromRedistribute: r.redistribute_marked_at != null,
        });
      }
      return rows.length;
    },
  );
  // The "still stranded" predicate is pure and tested in coverage-retry.ts (L342).
  return selectRetryableUnplaceable({ items: live, holderByBooking, jobById });
}

/**
 * Flip the given coverage items `unplaceable` -> `pending` (#3485 part C), chunked for the
 * URL budget. Conditional on the row still being `unplaceable`: a raced `moved` or
 * `cancelled` item must NEVER be re-armed, or a customer could be handed to a second
 * advisor, or a cancelled time off's move undone. The sweep is deliberately left `done`
 * (the drain picks up a pending item whatever its sweep's status); the prior `detail` is
 * left in place, so the "why it was unplaceable" diagnosis survives the retry and the drain
 * rewrites it on the next settle. Returns how many rows were actually flipped.
 */
export async function reArmUnplaceableItems(itemIds: string[]): Promise<number> {
  let reArmed = 0;
  for (let i = 0; i < itemIds.length; i += RE_ARM_CHUNK) {
    reArmed += unwrapCount(
      await supabaseAdmin()
        .from("bulk_reassign_items")
        .update({ status: "pending", updated_at: new Date().toISOString() }, { count: "exact" })
        .in("id", itemIds.slice(i, i + RE_ARM_CHUNK))
        .eq("status", "unplaceable"),
      "re-arm-unplaceable-coverage-items",
    );
  }
  return reArmed;
}

/** One booking's current status + assignment, or null if it no longer exists. */
export async function loadBookingSnapshot(bookingId: string): Promise<BookingSnapshot | null> {
  const data = unwrap(
    await supabaseAdmin()
      .from("bookings")
      // cap-safe: single-row primary-key lookup.
      .select("id, status, assigned_user_id")
      .eq("id", bookingId)
      .maybeSingle(),
    "load-booking-snapshot-bulk-reassign",
  ) as BookingSnapshot | null;
  return data ?? null;
}

/**
 * Take one item for processing while it is still pending (#1665), answering
 * whether it still was.
 *
 * A conditional UPDATE that changes only `updated_at`: the value it is really
 * asking about is `status`, and asking through a WHERE clause is what makes the
 * answer atomic. It deliberately leaves the status alone, so an item is never
 * half claimed and a tick that dies mid item leaves it exactly as it was.
 *
 * Fails loud rather than answering false on a read error: a claim that could not
 * be made and a row that is no longer pending are different things, and treating
 * the first as the second would silently stop draining a healthy sweep.
 */
export async function claimBulkReassignItem(itemId: string): Promise<boolean> {
  const count = unwrapCount(
    await supabaseAdmin()
      .from("bulk_reassign_items")
      .update({ updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", itemId)
      .eq("status", "pending"),
    "claim-bulk-reassign-item",
  );
  return count > 0;
}

/**
 * Persist an item's outcome and its new attempt count.
 *
 * CONDITIONAL on the status the item is leaving (#1665). The lane lock serializes
 * this against another tick, but a cancellation is a person pressing a button
 * while a tick is running, and the two writes want the same row. Ordering them in
 * application code cannot settle that; the WHERE clause can, because Postgres
 * takes the row lock and exactly one of them matches.
 *
 * A COMPLETED MOVE may also leave 'cancelled', and that asymmetry is the whole
 * design. By the time the engine answers 'moved' the booking is already off the
 * out agent on both sides, so the only question left is what the record SAYS. An
 * item reading 'cancelled' over a booking that really moved would be a lie a
 * later re-approval acts on (it re-arms cancelled items), and it would strand the
 * appointment #1235 exists to keep converging. Every other outcome, including the
 * retry that writes 'pending' back, is refused: nothing moved, so a stopped sweep
 * stays stopped rather than putting the customer back in a queue that no longer
 * has a reason to exist.
 */
export async function commitBulkReassignItemOutcome(
  itemId: string,
  outcome: ItemOutcome,
  attempts: number,
): Promise<void> {
  const leaving: BulkReassignItemStatus[] =
    outcome.status === "moved" ? ["pending", "cancelled"] : ["pending"];
  const { error } = await supabaseAdmin()
    .from("bulk_reassign_items")
    .update({
      status: outcome.status,
      target_user_id: outcome.targetUserId,
      detail: outcome.detail,
      attempts,
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .in("status", leaving);
  if (error) throw new Error(`bulk-reassign item commit failed: ${error.message}`);
}

/**
 * Stop every sweep an approved time-off request produced (#1665), and say what
 * that stopped and what had already moved.
 *
 * The IO only; the decision (what order, and why a job is settled before its
 * items) lives in `coverage-sweep-cancel.ts` where it can be driven by fakes.
 */
export async function cancelCoverageSweepForRequest(
  oooRequestId: string,
): Promise<CoverageSweepCancelReport> {
  return cancelCoverageSweep({
    findJobs: async () =>
      (unwrap(
        await supabaseAdmin()
          // cap-safe: bounded by the unique index on (ooo_request_id, range_start,
          // range_end): one sweep per window, and a request has a handful at most.
          .from("bulk_reassign_jobs")
          .select("id, status")
          .eq("ooo_request_id", oooRequestId),
        "find-coverage-sweeps-for-request",
      ) as { id: string; status: BulkReassignJobStatus }[] | null) ?? [],

    cancelJob: async (jobId) => {
      const { error } = await supabaseAdmin()
        .from("bulk_reassign_jobs")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", jobId)
        // A sweep that already drained stays 'done'. Nothing is left to stop, and
        // relabelling it would lose that it finished.
        .eq("status", "active");
      if (error) throw new Error(`coverage sweep cancel failed: ${error.message}`);
    },

    cancelPendingItems: async (jobId) =>
      unwrapCount(
        await supabaseAdmin()
          .from("bulk_reassign_items")
          .update(
            {
              status: "cancelled",
              detail: "The time off was cancelled before this appointment moved.",
              updated_at: new Date().toISOString(),
            },
            { count: "exact" },
          )
          .eq("job_id", jobId)
          // The guarantee. An item that has reached any outcome, including one a
          // drain tick moved a moment ago, does not match and is left alone.
          .eq("status", "pending"),
        "cancel-pending-coverage-items",
      ),

    countMovedItems: async (jobId) =>
      unwrapCount(
        await supabaseAdmin()
          .from("bulk_reassign_items")
          // cap-safe: server-side count (head:true), no rows returned.
          .select("id", { count: "exact", head: true })
          .eq("job_id", jobId)
          .eq("status", "moved"),
        "count-moved-coverage-items",
      ),
  });
}

/** The org a user belongs to, or null if the user does not exist (#974). Used to
 *  stamp a coverage job with the out agent's org. */
export async function loadUserOrgId(userId: string): Promise<string | null> {
  const data = unwrap(
    await supabaseAdmin()
      .from("users")
      // cap-safe: single-row primary-key lookup.
      .select("org_id")
      .eq("id", userId)
      .maybeSingle(),
    "load-user-org-bulk-reassign",
  ) as { org_id: string } | null;
  return data?.org_id ?? null;
}

/** One job by id, or null if it does not exist (the #974 progress read). */
export async function loadBulkReassignJob(jobId: string): Promise<BulkReassignJob | null> {
  const data = unwrap(
    await supabaseAdmin()
      .from("bulk_reassign_jobs")
      // cap-safe: single-row primary-key lookup.
      .select("*")
      .eq("id", jobId)
      .maybeSingle(),
    "load-bulk-reassign-job",
  ) as BulkReassignJob | null;
  return data ?? null;
}

/** Every item of a job, paginated so a large job is fully summarized (#974). */
export async function loadBulkReassignItems(jobId: string): Promise<BulkReassignItem[]> {
  return selectAllPages<BulkReassignItem>("bulk-reassign-job-items", "id", () =>
    supabaseAdmin()
      .from("bulk_reassign_items")
      .select("*")
      .eq("job_id", jobId),
  ).then((rows) => sortByStamp("bulk-reassign-job-items", rows, "created_at", "id"));
}

/** Booking display context for the (small) set of actionable item booking ids. */
export async function loadActionableBookingContext(
  bookingIds: string[],
): Promise<Map<string, ActionableBookingContext>> {
  if (bookingIds.length === 0) return new Map();
  const rows = unwrap(
    await supabaseAdmin()
      .from("bookings")
      // cap-safe: primary-key lookup of the actionable items' bookings.
      .select("id, starts_at, attendee_name, status, assigned_user_id")
      .in("id", bookingIds),
    "load-actionable-booking-context",
  ) as { id: string; starts_at: string; attendee_name: string | null; status: string; assigned_user_id: string | null }[] | null;
  return new Map(
    (rows ?? []).map((r) => [
      r.id,
      { startsAt: r.starts_at, attendeeName: r.attendee_name, status: r.status, assignedUserId: r.assigned_user_id },
    ]),
  );
}

/** Flip the job to 'done' once it has no pending items left. Best-effort: a
 *  tracking miss just leaves it 'active' and the next drained tick retries.
 *
 *  Only ever flips a job that is still 'active' (#1665). A sweep stopped while its
 *  last in-flight item was being committed must not be relabelled 'done' by the
 *  tick that finished it: 'done' means every item reached an outcome, 'cancelled'
 *  means the reason for the sweep went away, and the admin panel and the #1242
 *  give-up page read the difference.
 *
 *  Answers whether THIS call made the flip (#3615). The WHERE on 'active' means one call
 *  ever does, so the drain reports a finished sweep exactly once; a failed read or write
 *  answers false and is logged, as before. */
export async function markBulkReassignJobDoneIfDrained(jobId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin()
    .from("bulk_reassign_items")
    // cap-safe: server-side count (head:true), no rows returned.
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)
    .eq("status", "pending");
  if (error) {
    log.error("bulk-reassign", { msg: "pending-count failed", job_id: jobId }, error);
    return false;
  }
  if ((count ?? 0) !== 0) return false;
  const { count: flipped, error: upErr } = await supabaseAdmin()
    .from("bulk_reassign_jobs")
    .update({ status: "done", updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", jobId)
    .eq("status", "active");
  if (upErr) {
    log.error("bulk-reassign", { msg: "job-done update failed", job_id: jobId }, upErr);
    return false;
  }
  return flipped === 1;
}
