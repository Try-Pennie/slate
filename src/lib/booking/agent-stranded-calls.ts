import { ACTIONABLE_ITEM_STATUSES, type BulkReassignActionableItem } from "@/lib/booking/bulk-reassign";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking/bulk-reassign-store";
import { POOL_STATE_COLUMNS, type PoolStateRow } from "@/lib/bookable/left-pool";
import { unwrap } from "@/lib/db/result";
import { inIdChunks } from "@/lib/db/id-batch";
import {
  countStranded,
  strandedHolderNow,
  strandedItemReads,
  type StrandedItemRow,
  type StrandedSweepRow,
} from "@/lib/monitor/coverage-needs-human";
import { parseStampMs } from "@/lib/date/stamp";
import { selectAllPages } from "@/lib/supabase/paginate";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * The calls a coverage sweep could not place that are still with this agent
 * (#3595), for the standing list at the top of the agent page.
 *
 * WHAT COUNTS is not decided here. It is `countStranded`, the predicate the
 * coverage needs human alert pages on (#3303, #3597), fed by the same assembly
 * (`strandedItemReads`, `strandedHolderNow`), so the page and the alert cannot
 * disagree about which calls are waiting for a person (L342). So a call is listed
 * when:
 *
 * - a sweep settled it `unplaceable` or `failed` (`ACTIONABLE_ITEM_STATUSES`);
 * - it is still active, upcoming, and with the agent that sweep was moving it off;
 * - that sweep has finished, or the give up has waited `SWEEP_FINISH_WAIT_MS` in
 *   one that has not (a running sweep's own progress view shows the rest);
 * - and it is not a Redistribute flap whose agent is back in the pool (#3597).
 *   Approved time off moves calls out of an agent who stays in the pool, so an in
 *   pool holder there is still listed.
 *
 * No paging lead window: the alert holds a call until an hour before it starts
 * while the hourly retry works it, but somebody who has opened this page wants
 * every call that still needs placing, however far out.
 *
 * Throws on any failed read. The page's error state hangs off the throw, and an
 * empty list here would read as "nothing is waiting" when nothing was measured (L10).
 */

/** One upcoming booking of this agent, with its holder's pool state. */
export interface AgentStrandedBookingRow {
  id: string;
  starts_at: string;
  attendee_name: string | null;
  assigned_user_id: string | null;
  users: PoolStateRow | null;
}

/** One actionable item, with the reason the sweep stored. */
export interface AgentStrandedItemRow extends StrandedItemRow {
  detail: string | null;
}

/** One sweep, with when it was started, which is how the page names it. */
export interface AgentStrandedJobRow extends StrandedSweepRow {
  created_at: string;
}

/** The three reads, injectable so the assembly is tested without a database. */
export interface AgentStrandedReads {
  upcomingBookings(agentId: string, nowIso: string): Promise<AgentStrandedBookingRow[]>;
  actionableItems(bookingIds: string[]): Promise<AgentStrandedItemRow[]>;
  jobs(jobIds: string[]): Promise<AgentStrandedJobRow[]>;
}

export interface AgentStrandedCalls {
  /** One row per call, soonest first, in the shape the move's own list draws. */
  calls: BulkReassignActionableItem[];
  /** When each move that left one of them was started, newest first. */
  moves: string[];
}

export async function loadAgentStrandedCalls(
  agentId: string,
  nowMs: number,
  reads: AgentStrandedReads = agentStrandedReads(),
): Promise<AgentStrandedCalls> {
  const none: AgentStrandedCalls = { calls: [], moves: [] };
  const bookings = await reads.upcomingBookings(agentId, new Date(nowMs).toISOString());
  if (bookings.length === 0) return none;
  const items = await reads.actionableItems(bookings.map((b) => b.id));
  if (items.length === 0) return none;
  const jobs = await reads.jobs([...new Set(items.map((it) => it.job_id))]);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const counted = countStranded(
    strandedItemReads(items, new Map(bookings.map((b) => [b.id, strandedHolderNow(b)])), jobById),
    nowMs,
  );
  // Only this agent's: `countStranded` already keeps a call only while its holder is
  // the sweep's out agent, and every booking read here is held by this agent.
  const mine = counted.appointments.filter((a) => a.outUserId === agentId);
  const calls = mine
    .map((a) => {
      const b = bookingById.get(a.bookingId);
      return {
        bookingId: a.bookingId,
        status: a.status,
        detail: a.detail ?? null,
        startsAt: b?.starts_at ?? null,
        attendeeName: b?.attendee_name ?? null,
      };
    })
    // Soonest first: the call nearest to being missed is the one to place first (L609).
    .sort((x, y) => (parseStampMs(x.startsAt) ?? Infinity) - (parseStampMs(y.startsAt) ?? Infinity));
  const moves = [...new Set(mine.flatMap((a) => (a.sweepId ? [a.sweepId] : [])))]
    .flatMap((id) => {
      const j = jobById.get(id);
      return j ? [j.created_at] : [];
    })
    .sort((x, y) => (parseStampMs(y) ?? -Infinity) - (parseStampMs(x) ?? -Infinity));
  return { calls, moves };
}

/** The reads against the database. Each throws on a failed query. */
export function agentStrandedReads(): AgentStrandedReads {
  const db = supabaseAdmin();
  return {
    upcomingBookings: (agentId, nowIso) =>
      selectAllPages<AgentStrandedBookingRow>("agent stranded calls: bookings", "id", () =>
        db
          // agent-link-ok: a stranded coverage item is a real call waiting for a
          // person, whatever kind of booking it is (#2073), as in the alert's read.
          .from("bookings")
          .select(`id, starts_at, attendee_name, assigned_user_id, users!bookings_assigned_user_id_fkey(${POOL_STATE_COLUMNS})`)
          .eq("assigned_user_id", agentId)
          .in("status", ACTIVE_BOOKING_STATUSES)
          .gte("starts_at", nowIso),
      ),
    actionableItems: async (bookingIds) =>
      (
        await inIdChunks("agent stranded calls: items", bookingIds, (batch) =>
          selectAllPages<AgentStrandedItemRow>("agent stranded calls: items", "id", () =>
            db
              .from("bulk_reassign_items")
              .select("id, booking_id, status, job_id, updated_at, detail")
              .in("booking_id", batch)
              .in("status", ACTIONABLE_ITEM_STATUSES),
          ),
        )
      ).flat(),
    jobs: async (jobIds) =>
      (
        await inIdChunks("agent stranded calls: jobs", jobIds, async (batch) =>
          (unwrap(
            await db
              .from("bulk_reassign_jobs")
              // cap-safe: primary-key lookup, already split to the URL budget.
              .select("id, out_user_id, status, created_at, updated_at, redistribute_marked_at")
              .in("id", batch),
            "agent stranded calls: jobs",
          ) ?? []) as AgentStrandedJobRow[],
        )
      ).flat(),
  };
}
