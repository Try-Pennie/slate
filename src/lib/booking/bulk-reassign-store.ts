import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import type { BookingSnapshot, ItemOutcome } from "@/lib/booking/bulk-reassign";
import type { BookingStatus, BulkReassignItem, BulkReassignJob } from "@/lib/db/types";

/** The active-upcoming statuses a coverage sweep moves. */
const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ["confirmed", "rescheduled"];

/**
 * The booking ids currently assigned to `outUserId` that fall inside a coverage
 * window: active, still upcoming (start floored at now so a past booking is never
 * moved), and starting within [range_start, range_end). Paginated so an out agent
 * with many upcoming bookings is fully covered rather than truncated to one
 * PostgREST page (the count drives both the preview and the item snapshot).
 */
export async function coverageBookingIds(
  outUserId: string,
  rangeStartIso: string,
  rangeEndIso: string | null,
): Promise<string[]> {
  const nowIso = new Date().toISOString();
  const startFloor = rangeStartIso > nowIso ? rangeStartIso : nowIso;
  const rows = await selectAllPages<{ id: string }>("bulk-reassign-coverage-bookings", (from, to) => {
    let q = supabaseAdmin()
      // cap-safe: read every page via selectAllPages (.range below), so an out
      // agent with more than one page of upcoming bookings is fully snapshotted.
      .from("bookings")
      .select("id")
      .eq("assigned_user_id", outUserId)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gte("starts_at", startFloor)
      .order("starts_at", { ascending: true })
      .order("id", { ascending: true });
    if (rangeEndIso) q = q.lt("starts_at", rangeEndIso);
    return q.range(from, to);
  });
  return rows.map((r) => r.id);
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
}

/**
 * Create a coverage sweep and snapshot its work: insert the job, then one pending
 * item per booking currently assigned to the out agent in range. Item creation is
 * idempotent (UNIQUE(job_id, booking_id)). A job with no bookings to move is born
 * already `done`. Fails loud on any write error so a half-created job can't look
 * like a successful empty sweep.
 */
export async function createBulkReassignJob(
  input: CreateBulkReassignJobInput,
): Promise<{ jobId: string; itemCount: number }> {
  const bookingIds = await coverageBookingIds(input.outUserId, input.rangeStartIso, input.rangeEndIso);

  const { data, error } = await supabaseAdmin()
    .from("bulk_reassign_jobs")
    .insert({
      org_id: input.orgId,
      out_user_id: input.outUserId,
      range_start: input.rangeStartIso,
      range_end: input.rangeEndIso,
      reason_code: input.reasonCode,
      reason_detail: input.reasonDetail,
      status: bookingIds.length > 0 ? "active" : "done",
      created_by: input.createdBy,
      acting_as_user_id: input.actingAsUserId,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`bulk-reassign job insert failed: ${error?.message ?? "no row"}`);
  const jobId = (data as { id: string }).id;

  if (bookingIds.length > 0) {
    const items = bookingIds.map((booking_id) => ({ job_id: jobId, booking_id }));
    const { error: itemErr } = await supabaseAdmin().from("bulk_reassign_items").insert(items);
    if (itemErr) throw new Error(`bulk-reassign items insert failed: ${itemErr.message}`);
  }
  return { jobId, itemCount: bookingIds.length };
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
