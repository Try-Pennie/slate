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
import { addOooOverrides, removeOooOverrides } from "@/lib/calcom/client";
import { dmSlackUserByEmail, postSlack } from "@/lib/notify/slack";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { recordAudit } from "@/lib/audit";
import type { OooRequest, OooStatus, User } from "@/lib/db/types";
import * as orchestration from "@/lib/ooo/orchestration";
import type {
  ModifyOooInput,
  OooActionResult,
  OooDeps,
  SubmitOooInput,
} from "@/lib/ooo/orchestration";

export type { OooActionResult, SubmitOooInput, ModifyOooInput };

const OOO_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Binds the OOO orchestration to real IO — the only place the OOO flow touches
 * Supabase, Google Calendar, Slack, or Cal.com. The logic lives in
 * `orchestration.ts` and is exercised by `scripts/test-ooo-orchestration.ts`.
 */
function realDeps(): OooDeps {
  const db = supabaseAdmin;
  return {
    loadRequest: async (id) => {
      const { data } = await db()
        .from("ooo_requests")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      return (data as OooRequest | null) ?? null;
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

    patchRequest: async (id, patch) => {
      await db().from("ooo_requests").update(patch).eq("id", id);
    },

    getUser: async (userId) => {
      const { data } = await db()
        .from("users")
        .select("*")
        .eq("id", userId)
        .maybeSingle();
      return (data as User | null) ?? null;
    },

    agentPrimaryCalendarId: async (userId) => {
      const { data } = await db()
        .from("agent_calendars")
        .select("calendar_id")
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      return (data as { calendar_id: string } | null)?.calendar_id ?? "primary";
    },

    createCalendarEvent: (actorEmail, calendarId, args) =>
      createEventOnCalendar(actorEmail, calendarId, args),
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
        console.error(
          `busy_blocks OOO write-through insert failed: ${error?.message}`,
        );
        await sendThrottledAlert(
          "busy_block_write_through",
          OOO_ALERT_COOLDOWN_MS,
          `Slate: busy_blocks INSERT for an approved OOO request failed (${error?.message}). The agent may keep getting bookings until the next sync pass.`,
        ).catch(() => {});
        return null;
      }
      return (data as { id: string }).id;
    },

    deleteBusyBlock: async ({ id, userId, gcalEventId }) => {
      const run = async () => {
        if (id) await db().from("busy_blocks").delete().eq("id", id);
        if (gcalEventId) {
          await db()
            .from("busy_blocks")
            .delete()
            .eq("user_id", userId)
            .eq("gcal_event_id", gcalEventId);
        }
      };
      try {
        await run();
      } catch {
        // Sync self-heals gcal-source rows once the Google event is deleted;
        // a slate-source leftover is the bad case, so alert.
        await sendThrottledAlert(
          "busy_block_write_through",
          OOO_ALERT_COOLDOWN_MS,
          `Slate: busy_blocks DELETE for a cancelled OOO request failed. The agent may look busy until cleaned up.`,
        ).catch(() => {});
      }
    },

    // Cal.com dual-write only during the cutover transition; flag off records
    // "skipped" so side_effects stays honest.
    calcomAddOverrides: async (email, startIso, endIso) =>
      oooCalcomDualWrite()
        ? addOooOverrides(email, startIso, endIso)
        : "skipped",
    calcomRemoveOverrides: async (email, startIso, endIso) =>
      oooCalcomDualWrite()
        ? removeOooOverrides(email, startIso, endIso)
        : "skipped",

    dmUserByEmail: (email, text) => dmSlackUserByEmail(email, text),
    postFallbackChannel: async (text) => {
      await postSlack({ text });
    },
    alertOps: (key, message) =>
      sendThrottledAlert(key, OOO_ALERT_COOLDOWN_MS, message).catch(() => {}),

    recordAudit: (action, actorId, orgId, requestId, details) =>
      recordAudit({
        orgId,
        actorId,
        action,
        targetId: requestId,
        details,
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
): Promise<OooActionResult> =>
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
