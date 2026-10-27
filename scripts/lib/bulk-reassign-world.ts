// An in-memory stand-in for the two coverage-sweep tables and the bookings they
// move, written so a CANCEL and a DRAIN can be interleaved in one process (#1665).
//
// Not named test-*.ts: the runner globs that pattern as a suite, and this is a
// library.
//
// The point of this file is the CONDITIONAL writes. The real fix rests on the
// database deciding who wins between "stop this sweep" and "record what this item
// did", so a fake whose updates always land would prove nothing about the race it
// exists to test. Every method here therefore mirrors the WHERE clause of the
// statement it stands for, and refuses when the row no longer matches:
//
//   cancelPendingItems   UPDATE ... WHERE job_id = $1 AND status = 'pending'
//   cancelJob            UPDATE ... WHERE id = $1 AND status = 'active'
//   commitItemOutcome    UPDATE ... WHERE id = $1 AND status IN (allowed)
//   markJobDoneIfDrained UPDATE ... WHERE id = $1 AND status = 'active'
//
// It is still a fake, so it agrees with our reading of the store by construction
// (L52). What it can prove is that the ENGINE and the CANCEL, run against a store
// with those refusals, never double-move a booking and never leave a job in a
// state no lane picks up.
import type {
  BookingStatus,
  BulkReassignItem,
  BulkReassignItemStatus,
  BulkReassignJob,
  BulkReassignJobStatus,
} from "../../src/lib/db/types.ts";
import type { BulkReassignDeps, ItemOutcome } from "../../src/lib/booking/bulk-reassign.ts";
import type { CoverageSweepCancelDeps } from "../../src/lib/booking/coverage-sweep-cancel.ts";

export interface WorldBooking {
  id: string;
  status: BookingStatus;
  assigned_user_id: string;
}

export interface WorldOptions {
  /** The agent every job in this world is covering for. */
  outUserId?: string;
  /** The covering agent `selectTarget` places bookings on; null means unplaceable. */
  targetUserId?: string | null;
  /** True while the calendar verify is unavailable, so items retry rather than move. */
  verifyUnavailable?: boolean;
}

let seq = 0;

export class BulkReassignWorld {
  readonly jobs = new Map<string, BulkReassignJob>();
  readonly items = new Map<string, BulkReassignItem>();
  readonly bookings = new Map<string, WorldBooking>();

  /** Every reassign the engine performed, in order. One entry per booking is the
   *  invariant the double-move assertions read. */
  readonly reassigns: { bookingId: string; targetEmail: string }[] = [];
  /** Sweeps whose done flip a tick landed, in the order `jobFinished` heard them. */
  readonly finishedJobs: string[] = [];
  /** Commits the store REFUSED because the row had moved on underneath. */
  readonly refusedCommits: { itemId: string; status: BulkReassignItemStatus }[] = [];
  /** Claims the store REFUSED because the row was no longer pending. */
  readonly refusedClaims: string[] = [];

  /** Runs just before a reassign is applied, so a test can land a cancellation in
   *  the exact gap between the drain choosing to move a booking and recording it. */
  onBeforeReassign: ((bookingId: string) => Promise<void> | void) | null = null;
  /** Booking ids whose reassign should throw, so the item takes the retry path. */
  failReassignFor = new Set<string>();

  outUserId: string;
  targetUserId: string | null;
  verifyUnavailable: boolean;

  constructor(opts: WorldOptions = {}) {
    this.outUserId = opts.outUserId ?? "agent-out";
    this.targetUserId = opts.targetUserId === undefined ? "agent-cover" : opts.targetUserId;
    this.verifyUnavailable = opts.verifyUnavailable ?? false;
  }

  // --- fixture construction -------------------------------------------------

  addJob(over: Partial<BulkReassignJob> = {}): BulkReassignJob {
    const id = over.id ?? `job-${++seq}`;
    const job: BulkReassignJob = {
      id,
      org_id: "org1",
      out_user_id: this.outUserId,
      range_start: "2026-09-01T13:00:00Z",
      range_end: "2026-09-01T21:00:00Z",
      reason_code: "coverage",
      reason_detail: null,
      status: "active",
      created_by: "mgr1",
      acting_as_user_id: null,
      ooo_request_id: null,
      offboarding_deactivated_at: null,
      created_at: "2026-08-31T00:00:00Z",
      updated_at: "2026-08-31T00:00:00Z",
      ...over,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  /** One booking assigned to the out agent, plus its pending item on `jobId`. */
  addPendingItem(jobId: string, bookingId: string): BulkReassignItem {
    this.bookings.set(bookingId, {
      id: bookingId,
      status: "confirmed",
      assigned_user_id: this.outUserId,
    });
    const item: BulkReassignItem = {
      id: `item-${++seq}`,
      job_id: jobId,
      booking_id: bookingId,
      status: "pending",
      target_user_id: null,
      detail: null,
      attempts: 0,
      created_at: `2026-08-31T00:00:${String(seq).padStart(2, "0")}Z`,
      updated_at: "2026-08-31T00:00:00Z",
    };
    this.items.set(item.id, item);
    return item;
  }

  // --- reads a test asserts on ---------------------------------------------

  itemFor(bookingId: string): BulkReassignItem {
    for (const it of this.items.values()) if (it.booking_id === bookingId) return it;
    throw new Error(`no item for booking ${bookingId}`);
  }

  statusOf(bookingId: string): BulkReassignItemStatus {
    return this.itemFor(bookingId).status;
  }

  assigneeOf(bookingId: string): string {
    const b = this.bookings.get(bookingId);
    if (!b) throw new Error(`no booking ${bookingId}`);
    return b.assigned_user_id;
  }

  jobStatus(jobId: string): BulkReassignJobStatus {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no job ${jobId}`);
    return j.status;
  }

  pendingCount(jobId: string): number {
    return [...this.items.values()].filter((i) => i.job_id === jobId && i.status === "pending").length;
  }

  reassignCountFor(bookingId: string): number {
    return this.reassigns.filter((r) => r.bookingId === bookingId).length;
  }

  /**
   * A job no lane will ever pick up again: still 'active', but with nothing
   * pending, so `markBulkReassignJobDoneIfDrained` never runs for it (it only runs
   * for a job a tick actually touched). This is the #1235 stranded shape, and a
   * cancellation racing the drain must not create one.
   */
  strandedJobs(): string[] {
    return [...this.jobs.values()]
      .filter((j) => j.status === "active" && this.pendingCount(j.id) === 0)
      .map((j) => j.id);
  }

  /** A pending item under a job nothing drains: the other half of stranded. */
  strandedItems(): string[] {
    return [...this.items.values()]
      .filter((i) => i.status === "pending" && this.jobs.get(i.job_id)?.status !== "active")
      .map((i) => i.booking_id);
  }

  // --- the drain's side of the store ---------------------------------------

  drainDeps(): BulkReassignDeps {
    return {
      loadPendingItems: async (limit) =>
        [...this.items.values()]
          .filter((i) => i.status === "pending")
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(0, limit)
          .flatMap((item) => {
            const job = this.jobs.get(item.job_id);
            // A snapshot, exactly as the real read returns rows rather than live
            // objects: a cancel landing mid-tick must not retro-edit what the tick
            // already loaded, or the fake would hide the race instead of showing it.
            return job ? [{ item: { ...item }, job: { ...job } }] : [];
          }),

      loadBooking: async (bookingId) => {
        const b = this.bookings.get(bookingId);
        return b ? { id: b.id, status: b.status, assigned_user_id: b.assigned_user_id } : null;
      },

      selectTarget: async () => {
        if (this.verifyUnavailable) return { assignment: null, anyUnverified: true };
        if (!this.targetUserId) return { assignment: null, anyUnverified: false };
        return {
          assignment: { userId: this.targetUserId, email: `${this.targetUserId}@trypennie.com` },
          anyUnverified: false,
        };
      },

      // #4052: nobody in this world gets a tier back, so every demotion call still moves.
      callsTakenAgain: async () => new Set<string>(),

      claimItem: async (itemId) => {
        const item = this.items.get(itemId);
        // WHERE id = $1 AND status = 'pending'. The row may have been stopped since
        // the tick read its batch; only the database can answer that.
        if (!item || item.status !== "pending") {
          this.refusedClaims.push(itemId);
          return false;
        }
        return true;
      },

      reassign: async (bookingId, targetEmail) => {
        if (this.onBeforeReassign) await this.onBeforeReassign(bookingId);
        if (this.failReassignFor.has(bookingId)) {
          throw new Error(`reassign failed for ${bookingId}`);
        }
        const b = this.bookings.get(bookingId);
        if (!b) throw new Error(`no booking ${bookingId}`);
        b.assigned_user_id = targetEmail.split("@")[0]!;
        this.reassigns.push({ bookingId, targetEmail });
      },

      commitItemOutcome: async (itemId, outcome, attempts) => {
        this.commit(itemId, outcome, attempts);
      },

      markJobDoneIfDrained: async (jobId) => {
        const job = this.jobs.get(jobId);
        // WHERE status = 'active': a cancelled sweep is never relabelled 'done'.
        if (!job || job.status !== "active") return false;
        if (this.pendingCount(jobId) !== 0) return false;
        job.status = "done";
        return true;
      },

      jobFinished: async (job) => {
        this.finishedJobs.push(job.id);
      },
    };
  }

  /**
   * The conditional commit. An outcome may only be written while the item is in a
   * status it is allowed to leave: 'pending' normally, and 'pending' or 'cancelled'
   * for a completed move, because a move that really happened must be recorded
   * whichever write got there first (the booking is off the out agent either way,
   * and an item reading 'cancelled' over a moved booking would be a lie).
   */
  private commit(itemId: string, outcome: ItemOutcome, attempts: number): void {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`no item ${itemId}`);
    const allowed: BulkReassignItemStatus[] =
      outcome.status === "moved" ? ["pending", "cancelled"] : ["pending"];
    if (!allowed.includes(item.status)) {
      this.refusedCommits.push({ itemId, status: item.status });
      return;
    }
    item.status = outcome.status;
    item.target_user_id = outcome.targetUserId;
    item.detail = outcome.detail;
    item.attempts = attempts;
  }

  // --- the cancel's side of the store --------------------------------------

  cancelDeps(oooRequestId: string): CoverageSweepCancelDeps {
    return {
      findJobs: async () =>
        [...this.jobs.values()]
          .filter((j) => j.ooo_request_id === oooRequestId)
          .map((j) => ({ id: j.id, status: j.status })),

      cancelJob: async (jobId) => {
        const job = this.jobs.get(jobId);
        // WHERE status = 'active'. A sweep that already drained stays 'done': there
        // is nothing to stop, and relabelling it would lose that it finished.
        if (job && job.status === "active") job.status = "cancelled";
      },

      cancelPendingItems: async (jobId) => {
        let n = 0;
        for (const item of this.items.values()) {
          // WHERE job_id = $1 AND status = 'pending'. An item that already reached an
          // outcome, including one moved a moment ago, is untouched.
          if (item.job_id === jobId && item.status === "pending") {
            item.status = "cancelled";
            item.detail = "The time off was cancelled before this appointment moved.";
            n++;
          }
        }
        return n;
      },

      countMovedItems: async (jobId) =>
        [...this.items.values()].filter((i) => i.job_id === jobId && i.status === "moved").length,
    };
  }
}
