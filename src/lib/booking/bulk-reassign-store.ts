import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import type { ActionableBookingContext, BookingSnapshot, ItemOutcome } from "@/lib/booking/bulk-reassign";
import { enqueueCoverageSweep } from "@/lib/booking/coverage-sweep-enqueue";
import { coverageSelectionBounds } from "@/lib/booking/coverage-selection";
import type { BookingStatus, BulkReassignItem, BulkReassignJob } from "@/lib/db/types";

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
  return selectAllPages<CoverageBookingRow>("bulk-reassign-coverage-bookings", (from, to) => {
    let q = supabaseAdmin()
      // cap-safe: read every page via selectAllPages (.range below), so an out
      // agent with more than one page of upcoming bookings is fully snapshotted.
      .from("bookings")
      .select("id, starts_at, ends_at, attendee_name")
      .eq("assigned_user_id", outUserId)
      .in("status", ACTIVE_BOOKING_STATUSES)
      // Strictly after now: one already under way is never moved out from under the customer.
      .gt("starts_at", bounds.startsAfterIso)
      // Still running when the absence begins. The bound that was missing.
      .gt("ends_at", bounds.endsAfterIso)
      .order("starts_at", { ascending: true })
      .order("id", { ascending: true });
    if (bounds.startsBeforeIso) q = q.lt("starts_at", bounds.startsBeforeIso);
    return q.range(from, to);
  });
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
}

/** Postgres unique-violation. The ONLY error class that means "a sweep already
 *  exists for this request and window"; anything else is a real error and must not
 *  be mistaken for it. */
const UNIQUE_VIOLATION = "23505";

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
      snapshot = await coverageBookings(input.outUserId, input.rangeStartIso, input.rangeEndIso);
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
 * The oldest pending items, bounded per tick, each paired with its job. A job is
 * flipped to 'done' only once it has zero pending items, so every pending item
 * necessarily belongs to an ACTIVE job: no job-status join is needed. The jobs
 * are loaded in a second primary-key query (at most one per distinct job). Fails
 * loud on a read error (the lane catches, logs, and retries) rather than draining
 * nothing silently, which would look like "no work left".
 */
export async function loadPendingBulkReassignItems(
  limit: number,
): Promise<{ item: BulkReassignItem; job: BulkReassignJob }[]> {
  const items = (unwrap(
    await supabaseAdmin()
      .from("bulk_reassign_items")
      // cap-safe: bounded by the explicit .limit(limit) below.
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit),
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

/** Persist an item's outcome and its new attempt count. Serialized by the lane lock. */
export async function commitBulkReassignItemOutcome(
  itemId: string,
  outcome: ItemOutcome,
  attempts: number,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("bulk_reassign_items")
    .update({
      status: outcome.status,
      target_user_id: outcome.targetUserId,
      detail: outcome.detail,
      attempts,
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId);
  if (error) throw new Error(`bulk-reassign item commit failed: ${error.message}`);
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
  return selectAllPages<BulkReassignItem>("bulk-reassign-job-items", (from, to) =>
    supabaseAdmin()
      .from("bulk_reassign_items")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: true })
      .range(from, to),
  );
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
      .select("id, starts_at, attendee_name")
      .in("id", bookingIds),
    "load-actionable-booking-context",
  ) as { id: string; starts_at: string; attendee_name: string | null }[] | null;
  return new Map((rows ?? []).map((r) => [r.id, { startsAt: r.starts_at, attendeeName: r.attendee_name }]));
}

/** Flip the job to 'done' once it has no pending items left. Best-effort: a
 *  tracking miss just leaves it 'active' and the next drained tick retries. */
export async function markBulkReassignJobDoneIfDrained(jobId: string): Promise<void> {
  const { count, error } = await supabaseAdmin()
    .from("bulk_reassign_items")
    // cap-safe: server-side count (head:true), no rows returned.
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)
    .eq("status", "pending");
  if (error) {
    log.error("bulk-reassign", { msg: "pending-count failed", job_id: jobId }, error);
    return;
  }
  if ((count ?? 0) === 0) {
    const { error: upErr } = await supabaseAdmin()
      .from("bulk_reassign_jobs")
      .update({ status: "done", updated_at: new Date().toISOString() })
      .eq("id", jobId);
    if (upErr) log.error("bulk-reassign", { msg: "job-done update failed", job_id: jobId }, upErr);
  }
}
