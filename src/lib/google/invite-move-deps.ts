/**
 * The real seams behind the moved invite handler and the launch sweep (#3919): the
 * database, Google and Slack. The order of effects is `invite-move-notice.ts` and
 * `invite-move-sweep.ts`; the rules are `invite-moves.ts`.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { unwrap } from "@/lib/db/result";
import { getEventOnPrimary, updateEventTime } from "@/lib/google/calendar";
import { dmSlackUserByEmail, slackConfigured } from "@/lib/notify/slack";
import { mayWriteAlerts, sendThrottledAlert, type SendOutcome } from "@/lib/notify/dispatch";
import { isLoadtest } from "@/lib/loadtest-guard";
import { appUrl } from "@/lib/env";
import { log } from "@/lib/log";
import { chunkIdsByUrlBudget } from "@/lib/db/id-batch";
import type { BookingInviteChange } from "@/lib/db/types";
import { mayTakeOverLock, type InviteChangeRecord } from "./invite-moves";
import {
  INVITE_CHECK_FAILED_KEY,
  INVITE_MOVED_KEY,
  type InviteMoveDeps,
  type NewInviteChange,
} from "./invite-move-notice";
import { inviteCheckFailedAlert } from "./invite-move-copy";
import type { InviteSweepDeps, SweepBooking } from "./invite-move-sweep";

/**
 * How long the handler holds a booking's reschedule lock. The same two minutes a
 * reschedule's own lease runs (`RESCHEDULE_LOCK_TTL_MS` in booking/service.ts), so a
 * handler that dies holding it blocks a reschedule no longer than a crashed
 * reschedule would, and the next claimant takes it over as it would that one.
 */
export const INVITE_MOVE_LOCK_LEASE_MS = 2 * 60_000;

/**
 * Each change posts under its own key, so the cooldown only ever stops the same
 * change being posted twice. A day, so a key is never posted again however late a
 * retry is.
 */
const INVITE_POST_COOLDOWN_MS = 24 * 60 * 60_000;

const ACTIVE_STATUSES = ["confirmed", "rescheduled"] as const;

function toRecord(r: BookingInviteChange): InviteChangeRecord {
  return {
    id: r.id,
    kind: r.kind,
    moveNumber: r.move_number,
    action: r.action,
    outcome: r.outcome,
    eventStartsAt: r.event_starts_at,
    eventEndsAt: r.event_ends_at,
    eventUpdated: r.event_updated,
  };
}

/** Write a change. Its id, or null when the unique keys say another run wrote it first. Throws otherwise. */
async function recordChange(row: NewInviteChange): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("booking_invite_changes")
    .insert({
      booking_id: row.bookingId,
      user_id: row.userId,
      gcal_event_id: row.gcalEventId,
      kind: row.kind,
      move_number: row.moveNumber,
      action: row.action,
      booked_starts_at: row.bookedStartsAt,
      booked_ends_at: row.bookedEndsAt,
      event_starts_at: row.eventStartsAt,
      event_ends_at: row.eventEndsAt,
      event_updated: row.eventUpdated,
    })
    .select("id")
    .single();
  if (!error) return (data as { id: string }).id;
  // 23505: one of the two unique keys refused, so another run recorded this change.
  if ((error as { code?: string }).code === "23505") return null;
  throw new Error(`booking invite change could not be recorded: ${error.message}`);
}

/** Whether anything about a moved invite may be sent, and so done, from this process. */
function messagesAvailable(): boolean {
  return mayWriteAlerts(INVITE_MOVED_KEY, "moved booking invite") && slackConfigured() && !isLoadtest();
}

async function post(key: string, text: string): Promise<void> {
  // alert-key: booking_invite_moved:*
  // alert-key: booking_invite_resized:*
  // alert-key: booking_invite_check_failed:*
  // alert-key: booking_invite_launch_sweep
  await sendThrottledAlert(key, INVITE_POST_COOLDOWN_MS, text).catch((err: unknown) =>
    log.error("invite-move", { msg: "alert failed to send", key }, err),
  );
}

/** A post whose delivery the caller must know (the launch sweep's one report). */
async function postDelivered(key: string, text: string): Promise<boolean> {
  // A holder rather than a bare `let`, so the outcome the callback writes is read as
  // it stands after the await, never as the type narrowed at the declaration.
  const seen: { outcome: SendOutcome | null } = { outcome: null };
  // alert-key: booking_invite_launch_sweep
  await sendThrottledAlert(key, INVITE_POST_COOLDOWN_MS, text, {
    onOutcome: (o) => {
      seen.outcome = o;
    },
  }).catch((err: unknown) => log.error("invite-move", { msg: "alert failed to send", key }, err));
  return seen.outcome === "sent";
}

/**
 * Page about invites the handler could not check (`InviteMoveSummary.failed`), one
 * post per booking. Never throws: it rides on the sync, which must not fail for it.
 */
export async function reportInviteCheckFailures(
  advisorEmail: string,
  failed: { bookingId: string; reason: string }[],
): Promise<void> {
  for (const f of failed) {
    log.error("invite-move", { msg: "an out of step invite could not be checked", booking_id: f.bookingId, reason: f.reason });
    // alert-key: booking_invite_check_failed:*
    await post(
      `${INVITE_CHECK_FAILED_KEY}:${f.bookingId}`,
      // alert-text-ok: `reason` is already shortErrorReason output, one line and short
      inviteCheckFailedAlert(advisorEmail, `${appUrl()}/admin/bookings/${f.bookingId}`, f.reason),
    );
  }
}

/** The handler's seams for one advisor's sync pass. */
export function realInviteMoveDeps(args: { userId: string; email: string; timeZone: string }): InviteMoveDeps {
  const db = () => supabaseAdmin();
  return {
    nowMs: Date.now(),
    advisorUserId: args.userId,
    advisorEmail: args.email,
    appBaseUrl: appUrl(),
    timeZone: args.timeZone,
    messagesAvailable,
    claimLock: async (bookingId, targetStartsAt) => {
      const now = Date.now();
      const claimedAt = new Date(now).toISOString();
      const { error } = await db()
        .from("reschedule_locks")
        .insert({
          booking_id: bookingId,
          target_starts_at: targetStartsAt,
          claimed_at: claimedAt,
          lease_until: new Date(now + INVITE_MOVE_LOCK_LEASE_MS).toISOString(),
        });
      if (!error) return claimedAt;
      if ((error as { code?: string }).code !== "23505") {
        throw new Error(`reschedule lock could not be taken for a moved invite: ${error.message}`);
      }
      // Held. A live lease is a reschedule (or another run of this) at work: leave it.
      // An expired UNPINNED one is a run that died before its Google call, which
      // nothing else ever removes, so it is taken over (`mayTakeOverLock`).
      const held = unwrap(
        await db().from("reschedule_locks").select("lease_until, gcal_client_id").eq("booking_id", bookingId).maybeSingle(),
        "moved invite held lock",
      ) as { lease_until: string | null; gcal_client_id: string | null } | null;
      if (!held || !mayTakeOverLock(held, now)) return null;
      // The same compare and swap the reschedule's own takeover makes, so of two
      // claimants only one wins, and never over a row that was re-leased or pinned.
      const took = unwrap(
        await db()
          .from("reschedule_locks")
          .update({ claimed_at: claimedAt, lease_until: new Date(now + INVITE_MOVE_LOCK_LEASE_MS).toISOString() })
          .eq("booking_id", bookingId)
          .is("gcal_client_id", null)
          .or(`lease_until.is.null,lease_until.lte.${claimedAt}`)
          .select("booking_id"),
        "moved invite lock takeover",
      );
      return (took ?? []).length > 0 ? claimedAt : null;
    },
    releaseLock: async (bookingId, claimedAt) => {
      // Only the row this run wrote: same booking, same claim stamp, and never one a
      // reschedule has since pinned (a pin names its event).
      const { error } = await db()
        .from("reschedule_locks")
        .delete()
        .eq("booking_id", bookingId)
        .eq("claimed_at", claimedAt)
        .is("gcal_client_id", null);
      if (error) {
        // The lease runs out on its own in two minutes, as a crashed reschedule's does.
        log.error("invite-move", { msg: "reschedule lock release failed", booking_id: bookingId }, error);
      }
    },
    reassignInFlight: async (bookingId) => {
      const rows = unwrap(
        await db().from("reassign_intents").select("booking_id").eq("booking_id", bookingId).limit(1),
        "moved invite reassign intent",
      );
      return (rows ?? []).length > 0;
    },
    loadBooking: async (bookingId) => {
      const row = unwrap(
        await db()
          .from("bookings")
          .select("id, status, starts_at, ends_at, gcal_event_id, assigned_user_id, timezone")
          .eq("id", bookingId)
          .maybeSingle(),
        "moved invite booking",
      );
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        gcalEventId: row.gcal_event_id,
        assignedUserId: row.assigned_user_id,
        timezone: row.timezone,
      };
    },
    readEvent: (email, eventId) => getEventOnPrimary(email, eventId),
    loadChanges: async (bookingId) => {
      const rows = unwrap(
        await db()
          .from("booking_invite_changes")
          .select("*")
          .eq("booking_id", bookingId)
          .order("detected_at", { ascending: true })
          // One booking's invite edits: a handful. A ceiling nobody reaches, not a
          // page that could truncate a real set.
          .limit(500),
        "moved invite changes",
      );
      return ((rows ?? []) as BookingInviteChange[]).map(toRecord);
    },
    recordChange,
    setOutcome: async (id, outcome, detail) => {
      const { error } = await db()
        .from("booking_invite_changes")
        .update({ outcome, outcome_detail: detail })
        .eq("id", id);
      if (error) {
        // The revert already happened; a missing outcome reads as reverted, and a
        // later sighting of a refused one is escalated rather than put back.
        log.error("invite-move", { msg: "revert outcome not recorded", change_id: id, outcome }, error);
      }
    },
    revert: (email, eventId, startIso, endIso, timezone) => updateEventTime(email, eventId, startIso, endIso, timezone),
    loadPeople: async (userId) => {
      try {
        const me = unwrap(
          await db().from("users").select("name, manager_id").eq("id", userId).maybeSingle(),
          "moved invite advisor",
        ) as { name: string | null; manager_id: string | null } | null;
        let manager: { name: string | null; email: string } | null | "unread" = null;
        if (me?.manager_id) {
          const m = unwrap(
            await db().from("users").select("name, email").eq("id", me.manager_id).maybeSingle(),
            "moved invite manager",
          ) as { name: string | null; email: string | null } | null;
          // A manager of record with no row or no address exists and cannot be
          // reached, which is not the same as having none.
          manager = m?.email ? { name: m.name, email: m.email } : "unread";
        }
        return { advisorName: me?.name ?? null, manager };
      } catch (err) {
        // Said in the channel post as a manager who could not be looked up, never as
        // one who does not exist (L11); the post still reaches a person.
        log.error("invite-move", { msg: "advisor or manager could not be read", user_id: userId }, err);
        return { advisorName: null, manager: "unread" as const };
      }
    },
    dm: async (email, text) => (await dmSlackUserByEmail(email, text)) !== null,
    post,
  };
}

/** The launch sweep's seams. `apply` false reads only. */
export function realInviteSweepDeps(args: { apply: boolean }): InviteSweepDeps {
  const db = () => supabaseAdmin();
  return {
    nowMs: Date.now(),
    appBaseUrl: appUrl(),
    apply: args.apply,
    loadUpcoming: async () => {
      const nowIso = new Date().toISOString();
      const rows = await selectAllPages<{
        id: string;
        status: string;
        starts_at: string;
        ends_at: string;
        gcal_event_id: string | null;
        assigned_user_id: string | null;
        timezone: string;
        agent_email: string | null;
        agent_name: string | null;
      }>("invite sweep upcoming bookings", "id", () =>
        db()
          .from("bookings")
          .select("id, status, starts_at, ends_at, gcal_event_id, assigned_user_id, timezone, agent_email, agent_name")
          .in("status", [...ACTIVE_STATUSES])
          .gt("ends_at", nowIso)
          .not("gcal_event_id", "is", null),
      );
      return rows.map(
        (r): SweepBooking => ({
          id: r.id,
          status: r.status,
          startsAt: r.starts_at,
          endsAt: r.ends_at,
          gcalEventId: r.gcal_event_id,
          assignedUserId: r.assigned_user_id,
          timezone: r.timezone,
          advisorEmail: r.agent_email,
          advisorName: r.agent_name,
        }),
      );
    },
    bookingsWithChanges: async (ids) => {
      const out = new Set<string>();
      for (const chunk of chunkIdsByUrlBudget(ids)) {
        const rows = await selectAllPages<{ booking_id: string }>("invite sweep recorded changes", "id", () =>
          db().from("booking_invite_changes").select("id, booking_id").in("booking_id", chunk),
        );
        for (const r of rows) out.add(r.booking_id);
      }
      return out;
    },
    readEvent: (email, eventId) => getEventOnPrimary(email, eventId),
    recordChange,
    writeMirror: async (m) => {
      // The row the sync itself would write for this event (`partitionBusyWrites`),
      // on the advisor's synced calendar, under the sync's own conflict key.
      const cals = unwrap(
        await db().from("agent_calendars").select("calendar_id").eq("user_id", m.userId).limit(20),
        "invite sweep advisor calendars",
      ) as { calendar_id: string }[] | null;
      const calendarId = cals?.[0]?.calendar_id;
      if (!calendarId) throw new Error(`advisor ${m.userId} has no synced calendar to block the moved time on`);
      const { error } = await db()
        .from("busy_blocks")
        .upsert(
          {
            user_id: m.userId,
            calendar_id: calendarId,
            gcal_event_id: m.eventId,
            source: "gcal",
            starts_at: m.startsAt,
            ends_at: m.endsAt,
          },
          { onConflict: "user_id,calendar_id,gcal_event_id" },
        );
      if (error) throw new Error(`moved invite busy block could not be written: ${error.message}`);
    },
    post: postDelivered,
  };
}
