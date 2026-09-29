import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  appUrl,
  mainOooCalendarId,
  oooCalcomDualWrite,
  oooCalendarActorEmail,
} from "@/lib/env";
import {
  createEventOnCalendar,
  deleteEventOnCalendar,
} from "@/lib/google/calendar";
import { syncCalcomOverrides } from "@/lib/ooo/calcom-sync";
import {
  previewBulkReassign,
  startBulkReassign,
  stopCoverageSweepForRequest,
} from "@/lib/booking/service";
import {
  dmSlackUserByEmail,
  postSlack,
  updateSlackMessage,
} from "@/lib/notify/slack";
import { approvalBlocks } from "@/lib/notify/ooo-slack-blocks";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { shortFailureReason } from "@/lib/notify/error-text";
import { recordAudit } from "@/lib/audit";
import { unwrap } from "@/lib/db/result";
import { recomputeBucketsForAgent } from "@/lib/availability/slot-cache";
import type { OooRequest, OooStatus, User } from "@/lib/db/types";
import * as orchestration from "@/lib/ooo/orchestration";
import type {
  ModifyOooInput,
  OooActionResult,
  OooDeps,
  SubmitOooInput,
} from "@/lib/ooo/orchestration";
import { log } from "@/lib/log";
import { afterResponse } from "@/lib/after-response";

export type { OooActionResult, SubmitOooInput, ModifyOooInput };

const OOO_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Binds the OOO orchestration to real IO — the only place the OOO flow touches
 * Supabase, Google Calendar, Slack, or Cal.com. The logic lives in
 * `orchestration.ts` and is exercised by `scripts/test-ooo-orchestration.ts`.
 */
// Exported so the wiring itself can be tested (#1239): the orchestration suite
// drives in-memory fakes, which proves the flow and says nothing about whether these
// bindings do what the flow assumes (L3).
export function realDeps(): OooDeps {
  const db = supabaseAdmin;
  return {
    // #1674: `unwrap` rather than `data ?? null`, because a failed read here
    // arrives at every caller as "Request not found.", a claim about the row
    // that the read never measured. A throw is loud and is what the caller's own
    // error boundary is for.
    loadRequest: async (id) =>
      (unwrap(
        await db().from("ooo_requests").select("*").eq("id", id).maybeSingle(),
        "ooo.loadRequest",
      ) as OooRequest | null) ?? null,

    // #1674: null on a read error, NEVER `[]`. The overlap guard behind the time
    // off form treats `[]` as a measured empty calendar and accepts the request;
    // null is "could not measure" and refuses it retriably. The two are not
    // interchangeable and the empty one fails open.
    listActiveRequests: async (userId) => {
      const { data, error } = await db()
        // cap-safe: one user's active (pending/approved) time off requests.
        .from("ooo_requests")
        .select("id, starts_at, ends_at, display_tz_id, display_tz_label")
        .eq("user_id", userId)
        .in("status", ["pending", "approved"]);
      if (error) {
        log.error("ooo", { msg: "active requests unreadable", user_id: userId }, error);
        return null;
      }
      return (data ?? []) as {
        id: string;
        starts_at: string;
        ends_at: string;
        display_tz_id: string;
        display_tz_label: string;
      }[];
    },

    insertRequest: async (row) => {
      const { data, error } = await db()
        .from("ooo_requests")
        .insert(row)
        .select("*")
        .single();
      if (error || !data) {
        // 23505 = the active-window unique index (one pending/approved request
        // per agent + exact window) rejected a duplicate submission.
        return {
          ok: false,
          duplicate: error?.code === "23505",
          error: error?.message,
        };
      }
      return { ok: true, request: data as OooRequest };
    },

    transitionRequest: async (id, from, patch) => {
      const { data, error } = await db()
        .from("ooo_requests")
        .update(patch)
        .eq("id", id)
        .in("status", from as OooStatus[])
        .select("*")
        .maybeSingle();
      if (error) return { ok: false, duplicate: error.code === "23505" };
      if (!data) return { ok: false, duplicate: false };
      return { ok: true, request: data as OooRequest };
    },

    // THROWS on a refused write (#2482). Every OOO status transition goes through
    // here, and the caller that writes `side_effects` returns `{ ...request, ...patch }`
    // straight afterwards, so a refused update used to leave the request in its old
    // state while the Slack message, the calendar events and the cal.com override all
    // proceeded as though it had changed. A caller that can carry on regardless has to
    // say so at its own site rather than have this one swallow it for everybody.
    patchRequest: async (id, patch) => {
      const { error } = await db().from("ooo_requests").update(patch).eq("id", id);
      if (error) {
        throw new Error(`ooo request ${id} could not be updated: ${error.message}`);
      }
    },

    // #1674: a swallowed error here reads as "the requesting agent no longer
    // exists", which is a claim about the roster made by a read that never ran.
    getUser: async (userId) =>
      (unwrap(
        await db().from("users").select("*").eq("id", userId).maybeSingle(),
        "ooo.getUser",
      ) as User | null) ?? null,

    // #1674: a swallowed error here silently falls back to "primary", i.e. it
    // writes the time off block to a DIFFERENT calendar than the one the agent
    // is actually booked against, so the absence would not block anything. The
    // fallback is only correct for an agent with no agent_calendars row, which
    // is a null data with a null error and still passes through unwrap.
    agentPrimaryCalendarId: async (userId) =>
      (
        unwrap(
          await db()
            .from("agent_calendars")
            .select("calendar_id")
            .eq("user_id", userId)
            .limit(1)
            .maybeSingle(),
          "ooo.agentPrimaryCalendarId",
        ) as { calendar_id: string } | null
      )?.calendar_id ?? "primary",

    createCalendarEvent: (actorEmail, calendarId, args, clientId) =>
      createEventOnCalendar(actorEmail, calendarId, args, clientId),
    deleteCalendarEvent: (actorEmail, calendarId, eventId) =>
      deleteEventOnCalendar(actorEmail, calendarId, eventId),

    // Same retry-once + throttled-alert posture as the booking write-through:
    // the approval already happened, so a cache failure must not fail it, but
    // a missed insert leaves the agent bookable while OOO.
    insertBusyBlock: async (block) => {
      const insert = () =>
        db().from("busy_blocks").insert(block).select("id").single();
      let { data, error } = await insert();
      if (error) ({ data, error } = await insert());
      if (error || !data) {
        log.error("ooo", { msg: "busy_blocks write-through insert failed" }, error);
        await sendThrottledAlert(
          "busy_block_write_through",
          OOO_ALERT_COOLDOWN_MS,
          `Busy_blocks INSERT for an approved OOO request failed (${shortFailureReason(error?.message)}). The agent may keep getting bookings until the next sync pass.`,
        ).catch(() => {});
        return null;
      }
      // OOO just blocked this agent: refresh the precomputed rows for the buckets
      // they affect so they drop out of availability promptly. Through after()
      // (#503) so the recompute survives the isolate teardown after the response,
      // instead of a float Cloudflare can drop; cron backstops it regardless.
      afterResponse("ooo-recompute", () =>
        recomputeBucketsForAgent((block as { user_id: string }).user_id),
      );
      return (data as { id: string }).id;
    },

    deleteBusyBlock: async ({ id, userId, gcalEventId }) => {
      // #2482: these THROW, which is what the catch below was already written for.
      // It says a slate-source leftover is the bad case and alerts on it, and that
      // was only ever reached by a delete that raised. supabase-js resolves a
      // refused statement instead of throwing, so the one failure the handler
      // exists to catch was the one it could not see: the block stayed, the agent
      // stayed blocked, and the recompute below ran as though they were free.
      const run = async () => {
        if (id) {
          const { error } = await db().from("busy_blocks").delete().eq("id", id);
          if (error) throw new Error(`busy block ${id} not deleted: ${error.message}`);
        }
        if (gcalEventId) {
          const { error } = await db()
            .from("busy_blocks")
            .delete()
            .eq("user_id", userId)
            .eq("gcal_event_id", gcalEventId);
          if (error) {
            throw new Error(`busy block for ${gcalEventId} not deleted: ${error.message}`);
          }
        }
      };
      try {
        await run();
        // OOO ended / was removed: the agent is bookable again, so refresh their
        // buckets' precomputed rows. Through after() (#503) so it survives the
        // isolate teardown after the response; cron backstops it regardless.
        afterResponse("ooo-recompute", () => recomputeBucketsForAgent(userId));
      } catch {
        // Sync self-heals gcal-source rows once the Google event is deleted;
        // a slate-source leftover is the bad case, so alert.
        await sendThrottledAlert(
          "busy_block_write_through",
          OOO_ALERT_COOLDOWN_MS,
          `Busy_blocks DELETE for a cancelled OOO request failed. The agent may look busy until cleaned up.`,
        ).catch(() => {});
      }
    },

    // Cal.com dual-write only during the cutover transition; flag off records
    // "skipped" so side_effects stays honest.
    // #1237: the agent is definitely absent, so their upcoming appointments move. Goes
    // through the SAME sweep an admin starts from the coverage panel, so there is one
    // implementation of "move this agent's bookings" rather than a second that drifts.
    // `oooRequestId` is what makes it idempotent: re-approving or retrying converges on one
    // sweep rather than moving customers' bookings twice.
    startCoverageSweep: async ({ requestId, outUserId, startIso, endIso, createdBy }) => {
      const { itemCount, snapshot } = await startBulkReassign({
        outUserId,
        rangeStartIso: startIso,
        rangeEndIso: endIso,
        reason: { code: "coverage", detail: null },
        actor: { userId: createdBy, actingAsUserId: null },
        oooRequestId: requestId,
      });
      // The same rows the sweep snapshotted, so the manager's notice describes the work
      // that was queued rather than the answer a second query would give a moment later
      // (#1239).
      return {
        queued: itemCount,
        moves: snapshot.map((b) => ({
          startsAtIso: b.starts_at,
          endsAtIso: b.ends_at,
          attendeeName: b.attendee_name,
        })),
      };
    },

    // #1665: stop the sweep the approval started, and say what that stopped and
    // what had already moved.
    //
    // Deliberately NOT wrapped in a try/catch here. The orchestration's own
    // `stopCoverage` catches, pages and tells the reader it could not be confirmed;
    // swallowing it in the binding would report a stop that never happened, which is
    // the one answer nobody can act on.
    stopCoverageSweep: async ({ requestId }) => {
      const report = await stopCoverageSweepForRequest(requestId);
      return { stopped: report.stopped, alreadyMoved: report.alreadyMoved };
    },

    // #1239: how many appointments approving would move, for the pending notice.
    //
    // NULL on a read error, never 0. The notice stays silent on zero, so a swallowed
    // failure would render as "nothing will move" on the one screen where a manager is
    // deciding whether to approve. Reads through previewBulkReassign, which is the same
    // selection the sweep itself uses.
    countCoverageBookings: async ({ outUserId, startIso, endIso }) => {
      try {
        return await previewBulkReassign(outUserId, startIso, endIso);
      } catch (err) {
        log.error("ooo", { msg: "coverage preview count failed", user_id: outUserId }, err);
        return null;
      }
    },

    // #2417: both go through `syncCalcomOverrides`, which reads the agent's
    // OTHER approved absences on the same dates and refuses the write when that
    // read fails. Nothing here builds a window set of its own.
    //
    // #2875: the deploy level OOO_CALCOM_DUAL_WRITE flag is not the cutover lever.
    // The stored "cal.com retired" switch on /admin/alerts is, and it is checked
    // inside `syncCalcomOverrides`, which is where the monitor lane's retry starts
    // too, so retiring cal.com stops every override write with no deploy.
    calcomAddOverrides: async (target) =>
      oooCalcomDualWrite()
        ? syncCalcomOverrides({ mode: "add", ...target })
        : "skipped",
    calcomRemoveOverrides: async (target) =>
      oooCalcomDualWrite()
        ? syncCalcomOverrides({ mode: "remove", ...target })
        : "skipped",

    dmUserByEmail: (email, text, oooRequestId) =>
      dmSlackUserByEmail(
        email,
        text,
        oooRequestId ? approvalBlocks(text, oooRequestId) : undefined,
      ),
    postFallbackChannel: async (text, oooRequestId) => {
      const r = await postSlack({
        text,
        ...(oooRequestId ? { blocks: approvalBlocks(text, oooRequestId) } : {}),
      });
      return r.ok && r.channel && r.ts
        ? { channel: r.channel, ts: r.ts }
        : null;
    },
    editMessage: async (ref, text) => {
      await updateSlackMessage(ref, text);
    },
    alertOps: (key, message) =>
      // alert-key: ooo_agent_calendar
      // alert-key: ooo_manager_calendar
      // alert-key: ooo_calendar_create
      // alert-key: ooo_agent_dm
      // alert-key: ooo_busy_block_fallback
      // alert-key: ooo_calcom
      // alert-key: ooo_undo
      // alert-key: ooo_coverage_stop
      sendThrottledAlert(key, OOO_ALERT_COOLDOWN_MS, message).catch(() => {}),

    recordAudit: ({ action, actorId, orgId, targetUserId, requestId, details }) =>
      recordAudit({
        orgId,
        actorId,
        action,
        targetUserId,
        details: { ...details, ooo_request_id: requestId },
      }),

    appBaseUrl: appUrl,
    mainOooCalendarId,
    oooCalendarActorEmail,
    nowIso: () => new Date().toISOString(),
  };
}

export const submitOoo = (
  agent: User,
  input: SubmitOooInput,
): Promise<OooActionResult> => orchestration.submitOoo(agent, input, realDeps());

export const approveOoo = (
  requestId: string,
  actor: User,
): Promise<OooActionResult> =>
  orchestration.approveOoo(requestId, actor, realDeps());

export const rejectOoo = (
  requestId: string,
  actor: User,
  note: string,
): Promise<OooActionResult> =>
  orchestration.rejectOoo(requestId, actor, note, realDeps());

export const cancelOoo = (
  requestId: string,
  actor: User,
): Promise<orchestration.OooCancelResult> =>
  orchestration.cancelOoo(requestId, actor, realDeps());

export const modifyOoo = (
  requestId: string,
  actor: User,
  input: ModifyOooInput,
): Promise<OooActionResult> =>
  orchestration.modifyOoo(requestId, actor, input, realDeps());

export const retryOooSideEffects = (
  requestId: string,
  actor: User,
): Promise<OooActionResult> =>
  orchestration.retryOooSideEffects(requestId, actor, realDeps());
