/**
 * The real wiring behind the reroute drill (#3615). The steps, their order and every verdict live
 * in `demotion-drill.ts`; this hands them Slate's own booking, sweep, drain, move back and cancel,
 * so the drill exercises exactly what a real demotion would.
 *
 * It touches the two smoke test advisors and the DRILL test bucket ONLY. The one write that could
 * reach a real person, an advisor's attributes, refuses any row that is not `is_test`, so a pool
 * that somehow reached a real advisor could never demote them.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { Attributes } from "@/lib/db/types";
import { DRILL_TEST_BUCKET_CODE } from "@/lib/embed/public-test-bucket";
import {
  getBucketSlots,
  namedAgentResolver,
  resolveBucketAgentIds,
  resolveBucketByCode,
} from "@/lib/availability/service";
import { DEMOTION_SWEEP_REASON } from "@/lib/booking/demotion-plan";
import { firstTimeAllFree, runDemotionDrill, type DrillResult } from "@/lib/booking/demotion-drill";
import {
  demotionBookings,
  pinnedDemotionBookingIds,
  rerouteCandidatesForAgent,
} from "@/lib/booking/bulk-reassign-store";
import {
  adminMoveBackDemotionReroute,
  bookViaApi,
  cancelBooking,
  drainBulkReassignJob,
  startBulkReassign,
} from "@/lib/booking/service";

/** How far ahead the drill looks for a free time to book its test call. */
const DRILL_SLOT_WINDOW_MS = 14 * 24 * 60 * 60_000;

/** The reason the drill's cleanup records on the cancelled test call. */
const DRILL_CANCEL_REASON = { code: "other", detail: "Reroute drill cleanup" };

export async function runDemotionDrillLive(): Promise<DrillResult> {
  const resolved = await resolveBucketByCode(DRILL_TEST_BUCKET_CODE);
  const orgId = resolved?.bucket.org_id ?? null;
  return runDemotionDrill({
    loadDrillAgents: async () => {
      if (!resolved || !resolved.bucket.is_test) return [];
      const ids = await resolveBucketAgentIds(resolved.bucket);
      if (ids.length === 0) return [];
      const rows = unwrap(
        // cap-safe: the DRILL bucket's pool, the two smoke advisors by design.
        // in-chunk-ok: the drill pool is two test advisors.
        await supabaseAdmin().from("users").select("id, email, attributes, is_test").in("id", ids),
        "reroute drill advisors",
      ) as { id: string; email: string | null; attributes: Attributes | null; is_test: boolean }[];
      // Only test advisors are ever part of the drill.
      return rows.filter((r) => r.is_test).map(({ id, email, attributes }) => ({ id, email, attributes }));
    },
    findSlot: async (agentIds) => {
      const now = Date.now();
      const fromIso = new Date(now).toISOString();
      const toIso = new Date(now + DRILL_SLOT_WINDOW_MS).toISOString();
      // Each advisor's times through the same predicate the bucket uses, narrowed to that one
      // advisor as an advisor's own link is, so the time booked is one both can take.
      const perAdvisor = await Promise.all(
        agentIds.map((id) => getBucketSlots(DRILL_TEST_BUCKET_CODE, fromIso, toIso, namedAgentResolver(id))),
      );
      return firstTimeAllFree(perAdvisor.map((r) => r?.slots ?? []));
    },
    book: async (startIso, attendee) => {
      const res = await bookViaApi({
        bucketCode: DRILL_TEST_BUCKET_CODE,
        startIso,
        timezone: "America/New_York",
        attendee: { name: attendee.name, email: attendee.email },
        prefill: {},
        externalId: attendee.externalId,
        confirmReschedule: false,
        // DRILL is a test bucket, which the booking path refuses as unknown unless the caller says
        // it may book one; the canary route says so once its key is checked, and so does this.
        allowTestBuckets: true,
      });
      if (res.outcome !== "created") return null;
      return { bookingId: res.booking.id, manageToken: res.booking.manage_token, assignedUserId: res.booking.assigned_user_id };
    },
    writeAttributes: async (userId, attributes) => {
      const rows = unwrap(
        await supabaseAdmin()
          .from("users")
          .update({ attributes })
          .eq("id", userId)
          .eq("is_test", true)
          .select("id"),
        "reroute drill attributes",
      ) as { id: string }[] | null;
      if ((rows ?? []).length !== 1) throw new Error("the drill may only change a test advisor's attributes");
    },
    loadCandidates: (userId) => rerouteCandidatesForAgent(userId, new Date().toISOString(), null),
    startSweep: async ({ outUserId, markedAtIso, attributes, change }) => {
      const { jobId, itemCount } = await startBulkReassign({
        outUserId,
        rangeStartIso: markedAtIso,
        rangeEndIso: null,
        reason: DEMOTION_SWEEP_REASON,
        actor: null,
        demotionMarkedAtIso: markedAtIso,
        demotionChange: change,
        snapshotBookings: () => demotionBookings(outUserId, markedAtIso, null, attributes),
      });
      return { jobId, itemCount };
    },
    processJob: async (jobId) => {
      await drainBulkReassignJob(jobId);
    },
    loadBooking: async (bookingId) =>
      unwrap(
        await supabaseAdmin().from("bookings").select("status, assigned_user_id").eq("id", bookingId).maybeSingle(),
        "reroute drill booking",
      ) as { status: string; assigned_user_id: string | null } | null,
    sweepItem: async (jobId, bookingId) =>
      unwrap(
        // One row: (job_id, booking_id) is unique.
        await supabaseAdmin()
          .from("bulk_reassign_items")
          .select("status, detail")
          .eq("job_id", jobId)
          .eq("booking_id", bookingId)
          .maybeSingle(),
        "reroute drill sweep item",
      ) as { status: string; detail: string | null } | null,
    loadJobChange: async (jobId) =>
      (
        unwrap(
          await supabaseAdmin().from("bulk_reassign_jobs").select("demotion_change").eq("id", jobId).maybeSingle(),
          "reroute drill sweep",
        ) as { demotion_change: unknown } | null
      )?.demotion_change ?? null,
    auditActions: async (bookingId) =>
      (
        unwrap(
          await supabaseAdmin()
            .from("audit_log")
            .select("action")
            .filter("details->>booking_id", "eq", bookingId)
            .limit(20),
          "reroute drill audit rows",
        ) as { action: string }[] | null
      )?.map((r) => r.action) ?? [],
    moveBack: (bookingId, actorUserId) => {
      if (!orgId) throw new Error("the DRILL bucket has no org");
      return adminMoveBackDemotionReroute(bookingId, orgId, { userId: actorUserId }, false);
    },
    pinnedFor: async (userId) => (await pinnedDemotionBookingIds([userId])).get(userId) ?? new Set<string>(),
    cancel: async (manageToken) => {
      await cancelBooking(manageToken, DRILL_CANCEL_REASON, "system");
    },
    nowMs: () => Date.now(),
    nonce: () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
}
