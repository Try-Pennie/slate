import { loadCardPhotoRows } from "@/lib/advisor-photos/store";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { appUrl } from "@/lib/env";
import { sendGmailEmail } from "@/lib/notify/email";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { shortErrorReason } from "@/lib/notify/error-text";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { selectAllPages, sortByStamp } from "@/lib/supabase/paginate";
import { REMINDER_LEAD_MS, HOUR_REMINDER_LEAD_MS } from "@/lib/booking/reminder";
import {
  runBookingReminders,
  type DueBooking,
  type ReminderDeps,
  type ReminderKind,
  type ReminderRun,
} from "@/lib/booking/reminder-send";
import { runReminderFailureRateCheck } from "@/lib/booking/reminder-rate";
import {
  loadReminderRateState,
  reminderRateDay,
  saveReminderRateState,
} from "@/lib/booking/reminder-rate-store";
import { SHIPPED_REMINDER_FAILURE_RATE_THRESHOLDS } from "@/lib/monitor/failure-rate-thresholds";
import { log } from "@/lib/log";
import { getEventOnPrimary, updateEventDescription } from "@/lib/google/calendar";
import { readLeadCallingNumbersLive } from "@/lib/salesforce/lead-calling-number";
import { bookingLeadId } from "@/lib/booking/lookup-identity";

export const dynamic = "force-dynamic";

/**
 * The reminder email lane: 24 hours before the call (#2359), and 1 hour before it
 * (#4282). Each tick runs the lane once per email, the 24 hour one first.
 *
 * The decision and the copy are pure (`src/lib/booking/reminder.ts`) and the order of
 * effects is pure too (`reminder-send.ts`); this file is the IO and nothing else.
 *
 * It runs every five minutes, which is the precision this needs: the reminder lands
 * within five minutes of the 24 hour mark, and a same day booking is reminded on the
 * first tick after the hand-back hold (#2633) rather than at some second schedule. It is NOT on the every minute
 * trigger, which is the invocation already short of CPU headroom (#1245, #2021).
 */

/**
 * The cooldown on both keys this lane can send, and they say different things: the
 * per booking incident names one booking, and the share names a wave (#2496).
 *
 * The incident is keyed by booking (`booking_reminder_failed:<id>`, 2026-10-05), so
 * this bounds how often ONE booking can page, not how often the lane can. Under a
 * single shared key the first lost reminder held every other booking's page back for
 * six hours, and a second lead could go unreminded with nobody told. A bad afternoon
 * is still said once as a wave, by the share. Six hours is deliberate for the share,
 * since the condition it reports lasts until somebody repairs it and repeating that
 * hourly is how a page stops being read (L36).
 */
const REMINDER_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/booking-reminders");
  if (claimed) return claimed;

  const db = supabaseAdmin();
  const now = Date.now();
  // The 24 hour email first, so one sent this tick is on record before the 1 hour
  // read judges its two hour gap (#4282): a call moved close in gets one email, not two.
  const run = await runBookingReminders(laneDeps(db, now, "day"), "day");
  const hourRun = await runBookingReminders(laneDeps(db, now, "hour"), "hour");

  logRun("day", run);
  logRun("hour", hourRun);


  /**
   * Is this ONE lead's reminder, or every lead's? (#2496)
   *
   * The per booking incident above cannot answer that: it names one booking each
   * time, so one refused address is one page and a total outage is a page per lead
   * with nothing saying they share a cause. This folds the tick into a rolling window
   * and pages on the SHARE, which is the only thing that can tell the two apart.
   * Sends released to be retried ride along by booking id, with how every other
   * attempted booking settled, so one booking retried every tick counts once rather
   * than once per tick and stops counting once it is sent or given up
   * (`judgeReminderWindow`).
   *
   * It runs AFTER the sends and cannot stop them: every failure inside it is caught
   * and reported, because a monitor bolted onto a lane that emails real people must
   * not be able to take that lane down.
   */
  const rate = await runReminderFailureRateCheck({
    nowMs: now,
    day: reminderRateDay(now),
    // Both kinds in one window: a broken send path fails both, and the alert speaks
    // of "reminder emails". A 1 hour entry is keyed `hour:<id>`, so one booking's two
    // emails are two attempts rather than one overwriting the other.
    tick: combinedTick(run, hourRun),
    thresholds: SHIPPED_REMINDER_FAILURE_RATE_THRESHOLDS,
    cooldownMs: REMINDER_ALERT_COOLDOWN_MS,
    loadState: loadReminderRateState,
    saveState: saveReminderRateState,
    notify: async (key, cooldownMs, text) => {
      // alert-key: booking_reminders_failing
      // alert-text-ok: the text is built by `formatReminderFailureRateAlert`, which
      // carries counts and `ReminderFailureCode`s rather than the provider's body.
      await sendThrottledAlert(key, cooldownMs, text);
    },
    // alert-key: booking_reminders_failing
    // all-clear-proof: scripts/test-booking-reminder-rate.ts - a tick whose window
    // could not be READ returns `unverified` and is asserted to resolve nothing, and
    // a window below the floor is `insufficient` and resolves nothing either. The
    // recovery hangs only off a MEASURED healthy verdict (#1134, #1152).
    resolve: async (key, text) => resolveAlert(key, text),
    log: (fields) => log.info("booking-reminder", fields),
    onError: (context, err) =>
      log.error(
        "booking-reminder",
        { msg: "reminder rate step failed", step: context },
        err instanceof Error ? err : new Error(shortErrorReason(err)),
      ),
  }).catch((err) => {
    // Nothing above throws today, and a fault nobody predicted here must still not
    // cost a lead their reminder or the lane its heartbeat.
    log.error(
      "booking-reminder",
      { msg: "reminder rate check threw" },
      err instanceof Error ? err : new Error(shortErrorReason(err)),
    );
    return { status: "unverified", why: "state" } as const;
  });

  // Stamped at the END, so a tick that threw on the read never stamps and the lane
  // watchdog notices. That is the whole dead man's switch for this lane: nothing
  // else would say the reminders had stopped, because "nothing to send" and "the
  // read is broken" both look like silence (L98).
  await recordHeartbeat("booking-reminders").catch((e) =>
    log.error("booking-reminder", { msg: "heartbeat failed" }, e instanceof Error ? e : new Error(shortErrorReason(e))),
  );

  return NextResponse.json({
    ...run,
    hour: hourRun,
    // Said out loud, because "the share was fine" and "the share could not be
    // measured" are the same silence otherwise (L98).
    rate: rate.status === "checked" ? rate.verdict.status : "unverified",
  });
}

/**
 * What one run of the lane works on, for one kind of reminder email (#4282). The two
 * kinds share everything but the window they read and the record they claim: the 24
 * hour email's `reminder_sent_for` (stamping `reminder_sent_at` beside it, which the 1
 * hour email's two hour gap is judged from), and the 1 hour email's
 * `hour_reminder_sent_for`.
 */
function laneDeps(db: ReturnType<typeof supabaseAdmin>, now: number, kind: ReminderKind): ReminderDeps {
  const windowEndIso = new Date(now + (kind === "day" ? REMINDER_LEAD_MS : HOUR_REMINDER_LEAD_MS)).toISOString();
  const nowIso = new Date(now).toISOString();
  /** The column this kind's claim writes. */
  const sentFor = kind === "day" ? "reminder_sent_for" : "hour_reminder_sent_for";

  /**
   * What this tick READ for each booking's reminder record, so the claim below can
   * compare and swap against the exact value rather than re-stating the rule in a
   * filter. Keyed by booking id, filled by the load.
   */
  const rowsSeen = new Map<string, { sentFor: string | null; sentAt: string | null }>();


  return {
    now: () => now,
    loadDue: async () => {
      // PAGINATED, not one capped page (#2500).
      //
      // This used to be a single `.limit(200)`, justified against the busiest hour
      // measured across the roster. The justification was about the wrong quantity:
      // the 24 hour WINDOW is a day, and a booking stays in it for the whole 24 hours
      // before it starts, reminded or not (the 1 hour run reads an hour, #4282). So once more than 200 live bookings sat inside a
      // day the page filled with rows already dealt with, the unreminded ones behind
      // them were never reached, and nothing said so: the heartbeat stamped, `sent`
      // stayed non zero, and a truncated page is indistinguishable from the whole set
      // (L101, L98).
      //
      // Narrowing the query to the rows that are actually work is not available
      // here. The condition is this kind's record (`reminder_sent_for` or
      // `hour_reminder_sent_for`) being distinct from `starts_at`, a
      // comparison between two COLUMNS, which PostgREST cannot express as a filter,
      // and the arithmetic dodge does not hold either: a booking that MOVED carries
      // the start it used to hold, which can sit anywhere. So the read pages instead,
      // which is exact rather than clever, and the judgement stays where it already
      // lives (`reminderDue`, or `hourReminderDue` for the 1 hour email).
      //
      // `selectAllPages` throws on a read error rather than returning a short list,
      // which is the `unwrap` rule by the other route. An empty list here is
      // indistinguishable from "nobody needs reminding", which is the normal state,
      // so a failed read that degraded would silently stop every reminder and look
      // exactly like a quiet afternoon (#277). A throw fails the tick, and the lane's
      // heartbeat lapses, which is what pages.
      const rows = await selectAllPages<{
        id: string;
        starts_at: string;
        created_at: string;
        reminder_sent_for: string | null;
        reminder_sent_at: string | null;
        hour_reminder_sent_for: string | null;
        status: string;
        attendee_email: string | null;
        agent_email: string | null;
        agent_name: string | null;
        timezone: string;
        manage_token: string;
        salesforce_id: string | null;
        external_id: string | null;
        gcal_event_id: string | null;
        assigned_user_id: string | null;
        kind: string;
      }>("bookings due a reminder", "id", () =>
        db
          .from("bookings")
          .select(
            "id, starts_at, created_at, reminder_sent_for, reminder_sent_at, hour_reminder_sent_for, status, attendee_email, agent_email, agent_name, timezone, manage_token, salesforce_id, external_id, gcal_event_id, assigned_user_id, kind, buckets!inner(is_test)",
          )
          .in("status", ["confirmed", "rescheduled"])
          .gt("starts_at", nowIso)
          .lte("starts_at", windowEndIso)
          // Test bookings are excluded through the BUCKET, which is where the flag
          // lives: `bookings` has no `is_test` of its own. The canary books and
          // cancels a real row every hour against a real inbox, and reminding
          // SMOKE about its own fixture would be a live email nobody asked for
          // (#396).
          .eq("buckets.is_test", false),
      );
      // Soonest first, as the read used to ask Postgres for: the order decides which
      // bookings a tick sends first and which are paged by name. The read itself is
      // ordered by id, which keyset paging owns (2026-10-25).
      sortByStamp("bookings due a reminder", rows, "starts_at", "id");
      for (const r of rows) {
        rowsSeen.set(r.id, kind === "day"
          ? { sentFor: r.reminder_sent_for, sentAt: r.reminder_sent_at }
          : { sentFor: r.hour_reminder_sent_for, sentAt: null });
      }
      return rows
        .filter((r): r is typeof r & { agent_email: string } => !!r.agent_email)
        .map(
          (r): DueBooking => ({
            id: r.id,
            startsAtIso: r.starts_at,
            createdAtIso: r.created_at,
            reminderSentForIso: r.reminder_sent_for,
            reminderSentAtIso: r.reminder_sent_at,
            hourReminderSentForIso: r.hour_reminder_sent_for,
            status: r.status,
            attendeeEmail: r.attendee_email,
            agentEmail: r.agent_email,
            // The advisor's name signs the email and names the contact card. A
            // missing one stays null, and the copy then speaks for Pennie: an
            // address is never shown to a lead as a name (#1334 review).
            agentName: r.agent_name,
            timezone: r.timezone,
            manageUrl: `${appUrl()}/booking/manage/${r.manage_token}`,
            // #1334: who to ask Salesforce about, and the invite to write the
            // calling number into.
            leadId: bookingLeadId(r),
            gcalEventId: r.gcal_event_id,
            // Whose photo goes on the card: the CURRENT assignee, read live like the
            // manage page's, never stamped on the booking.
            agentId: r.assigned_user_id,
            // #4206: a call on the placeholder advisor is reminded from the
            // placeholder seat with its own copy: no number, no card, and a reply
            // to our texts rather than to an inbox nobody reads.
            onPlaceholder: r.kind === "staff_placed",
          }),
        );
    },
    // The CLAIM, and every clause of it is load bearing. It is conditional on the
    // booking still holding this start AND on no reminder having been recorded for
    // it, so two overlapping ticks cannot both send: Postgres decides the winner,
    // not the order the two reads happened in.
    claim: async (id, startsAtIso) => {
      // A compare and swap on the value THIS tick read, rather than a filter that
      // re-states the rule. Two reasons, and the second is the one that bites.
      //
      // It is exact: the write lands only if the row still holds the start and the
      // reminder record this caller judged, so an overlapping tick that claimed
      // first finds the row changed and loses. Postgres decides, not the order two
      // reads happened in.
      //
      // And it keeps the timestamp OUT of a hand built filter string. PostgREST's
      // `.or()` takes one string with commas separating its arms and dots
      // separating operator from value, while a Postgres timestamp renders as
      // `2026-09-17T10:00:00+00:00`. Embedding one in that grammar is a value being
      // parsed as syntax, which is the shape that fails on the character nobody
      // pictured rather than on the common case.
      const seen = rowsSeen.get(id)?.sentFor ?? null;
      // The 24 hour claim CLEARS the send time (#4282): it is written by `markSent`
      // once Gmail has accepted the email, so a send that fails leaves it unknown and
      // the 1 hour email is not held back by an email that never went.
      const set =
        kind === "day"
          ? { reminder_sent_for: startsAtIso, reminder_sent_at: null }
          : { hour_reminder_sent_for: startsAtIso };
      let q = db
        .from("bookings")
        .update(set)
        .eq("id", id)
        .eq("starts_at", startsAtIso);
      q = seen === null ? q.is(sentFor, null) : q.eq(sentFor, seen);
      const claimed = unwrap(await q.select("id").maybeSingle(), "claim booking reminder") as
        | { id: string }
        | null;
      return !!claimed;
    },
    // Hand a claim back after a send that provably delivered nothing (2026-10-05).
    // The mirror of the claim: back to the value THIS tick read, and only where the
    // row still holds the start this tick claimed, so it can undo its own claim and
    // nothing else. The timestamps go through `.eq`, never a filter string, for the
    // reason the claim gives.
    release: async (id, claimedForIso, restoreTo) => {
      const released = unwrap(
        await db
          .from("bookings")
          .update(
            kind === "day"
              ? { reminder_sent_for: restoreTo, reminder_sent_at: rowsSeen.get(id)?.sentAt ?? null }
              : { hour_reminder_sent_for: restoreTo },
          )
          .eq("id", id)
          .eq(sentFor, claimedForIso)
          .select("id")
          .maybeSingle(),
        "release booking reminder claim",
      ) as { id: string } | null;
      return !!released;
    },
    // When the 24 hour email went out (#4282), only where the row still holds the
    // start this tick claimed it for. Never called for the 1 hour email.
    markSent: async (id, startsAtIso) => {
      unwrap(
        await db
          .from("bookings")
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq("id", id)
          .eq("reminder_sent_for", startsAtIso)
          .select("id")
          .maybeSingle(),
        "record booking reminder send time",
      );
    },
    send: (msg) => sendGmailEmail(msg),
    alert: async (bookingId, text) => {
      // alert-key: booking_reminder_failed:*
      // alert-text-ok: the text is built by `reminderFailedAlert`, which carries a
      // short reason rather than the provider's body.
      // Keyed per booking (2026-10-05): under one shared key the first lost reminder
      // held every other booking's page back for the six hour cooldown, so a second
      // lead could go unreminded with nobody told. A wave is the share's job below.
      // The 1 hour email pages under its own key (#4282), the id still the segment
      // after the family so the per booking prune finds it, so a 24 hour page for the
      // same booking inside the cooldown cannot silence it.
      const key = kind === "day" ? `booking_reminder_failed:${bookingId}` : `booking_reminder_failed:${bookingId}:hour`;
      await sendThrottledAlert(key, REMINDER_ALERT_COOLDOWN_MS, text);
    },
    // #1334: one Salesforce read per tick (a token exchange and one SOQL query for
    // the leads being sent to). It throws on a refusal, and the lane then sends
    // every reminder without a number rather than none.
    readCallingNumbers: (leadIds) => readLeadCallingNumbersLive(leadIds),
    // #3027: the advisors' stored directory photos, one read for the tick, straight
    // from the database rather than over HTTP. `advisor_photos` is roster bounded.
    // A failed read throws, and the lane then sends every card with the Pennie
    // logo, logged and counted.
    readAdvisorPhotos: (userIds) => loadCardPhotoRows(userIds),
    // `sendUpdates=none`: Google syncs the description to the attendee either way,
    // and mailing "your event was updated" for a line we added is noise.
    refreshInvite: (agentEmail, eventId, description) => updateEventDescription(agentEmail, eventId, description),
    // What the invite says now, so only the calling number line changes. Null when
    // the event is gone; a failed read throws and nothing is written.
    readInviteDescription: async (agentEmail, eventId) => {
      const event = await getEventOnPrimary(agentEmail, eventId);
      return event === null ? null : (event.description ?? "");
    },
    // Every failed send arrives here with its booking id, code, outcome and whether
    // the claim was released, and the Error itself as the third argument so the log
    // keeps its cause (the token endpoint's body, the deadline) whole. Never contact
    // data: the lane passes ids and codes only.
    warn: (msg, bookingId, err, fields) =>
      log.warn(
        "booking-reminder",
        {
          msg,
          ...(bookingId ? { booking_id: bookingId } : {}),
          ...(fields ?? {}),
          reason: shortErrorReason(err),
        },
        err,
      ),
  };
}

/** One run's cycle line, and its error line when sends failed. Ids and counts only. */
function logRun(kind: ReminderKind, run: ReminderRun) {
  if (run.failed > 0) {
    log.error(
      "booking-reminder",
      { msg: "reminders failed to send", kind, failed: run.failed, retrying: run.retrying },
      new Error("reminder send failed"),
    );
  }
  log.info("booking-reminder", {
    msg: "cycle",
    kind,
    sent: run.sent,
    failed: run.failed,
    retrying: run.retrying,
    pages_folded: run.pagesFolded,
    skipped: run.skipped,
    held: run.held,
    lost: run.lost,
    attempted: run.attempted,
    with_calling_number: run.withCallingNumber,
    calling_number_unread: run.callingNumberUnread,
    invite_refresh_failed: run.inviteRefreshFailed,
    with_photo: run.withPhoto,
    photo_unread: run.photoUnread,
    with_logo: run.withLogo,
  });
}

/** The tick the failure share is judged on: both kinds' sends, summed (#4282). */
export function combinedTick(day: ReminderRun, hour: ReminderRun) {
  const byCode: Record<string, number> = { ...day.byCode };
  for (const [code, n] of Object.entries(hour.byCode)) byCode[code] = (byCode[code] ?? 0) + n;
  const hourKeyed = <T,>(r: Record<string, T>) =>
    Object.fromEntries(Object.entries(r).map(([id, v]) => [`hour:${id}`, v]));
  return {
    attempts: day.attempted + hour.attempted,
    failures: day.failed + hour.failed,
    byCode,
    retried: { ...day.retried, ...hourKeyed(hour.retried) },
    settled: { ...day.settled, ...hourKeyed(hour.settled) },
  };
}
