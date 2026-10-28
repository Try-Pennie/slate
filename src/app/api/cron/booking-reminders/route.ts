import { loadCardPhotoRows } from "@/lib/advisor-photos/store";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { appUrl } from "@/lib/env";
import { sendGmailEmail } from "@/lib/notify/email";
import {
  firingFamilyMembers,
  sendThrottledAlert,
  sendThrottledInfo,
  resolveAlert,
  resolveRecovered,
} from "@/lib/notify/dispatch";
import { shortErrorReason } from "@/lib/notify/error-text";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { selectAllPages, sortByStamp } from "@/lib/supabase/paginate";
import { HOUR_REMINDER_GAP_MS } from "@/lib/booking/reminder";
import {
  laneEmailFromRow,
  reminderEmailUnrenderableKey,
  reminderFailedAlertKey,
  runBookingReminders,
  type DueBooking,
  type ReminderDeps,
  type ReminderRun,
} from "@/lib/booking/reminder-send";
import type { LegacySlug } from "@/lib/booking/reminder-legacy";
import { REMINDER_EMAIL_FAILING_PREFIX, runReminderFailureRateCheck } from "@/lib/booking/reminder-rate";
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
import type { ReminderClaimOutcome, ReminderEmailRow, ReminderSendStatus } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * The reminder email lane: every reminder email an admin has stored in
 * `reminder_emails` (#4298), which today are the two seeded ones, 24 hours before the
 * call (#2359) and 1 hour before it (#4282).
 *
 * The decision and the copy are pure (`reminder-decision.ts`, `reminder-template.ts`)
 * and the order of effects is pure too (`reminder-send.ts`); this file is the IO and
 * nothing else.
 *
 * It runs every five minutes, which is the precision this needs: a reminder lands
 * within five minutes of its mark, and a same day booking is reminded on the first tick
 * after the hand-back hold (#2633) rather than at some second schedule. It is NOT on the
 * every minute trigger, which is the invocation already short of CPU headroom (#1245,
 * #2021).
 *
 * Expected load (#4298): about 95 bookings a day, so a worklist of about 100 rows at the
 * 24 hour lead and about 200 at the 48 hour cap, one page, each embedding a handful of
 * send rows; per booking a claim and a mark when an email is due, and one skip the first
 * time an email is judged never to be sent.
 */

/**
 * The cooldown on the keys this lane can send, and they say different things: the
 * per booking incident names one booking, and the share names a wave (#2496).
 *
 * The incident is keyed by booking and email (`reminderFailedAlertKey`), so this bounds
 * how often ONE booking's email can page, not how often the lane can. Under a single
 * shared key the first lost reminder held every other booking's page back for six
 * hours, and a second lead could go unreminded with nobody told. A bad afternoon is
 * still said once as a wave, by the share. Six hours is deliberate for the share,
 * since the condition it reports lasts until somebody repairs it and repeating that
 * hourly is how a page stops being read (L36).
 */
const REMINDER_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** How often the "no reminder email is switched on" line may repeat: once a day. */
const NONE_ENABLED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The gap `claim_reminder_send` enforces, as the Postgres interval it takes. */
const CLAIM_GAP = `${HOUR_REMINDER_GAP_MS / 60_000} minutes`;

const CLAIM_OUTCOMES: ReadonlySet<string> = new Set<ReminderClaimOutcome>(["claimed", "taken", "superseded", "gap"]);

/** The columns the lane reads of each stored email. */
const EMAIL_COLUMNS =
  "id, slug, name, minutes_before, late_booking, enabled, effective_from, subject, body, card_block, placeholder_sends";

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/booking-reminders");
  if (claimed) return claimed;

  const db = supabaseAdmin();
  const now = Date.now();
  // THROWS when the stored emails or the worklist cannot be read: nothing is sent, the
  // heartbeat below is never stamped, and the lane watchdog pages.
  const run = await runBookingReminders(laneDeps(db, now));
  logRun(run);

  /**
   * Is this ONE lead's reminder, or every lead's? (#2496)
   *
   * The per booking incident cannot answer that: it names one booking each time, so
   * one refused address is one page and a total outage is a page per lead with nothing
   * saying they share a cause. This folds the tick into a rolling window and pages on
   * the SHARE, which is the only thing that can tell the two apart. Sends released to
   * be retried ride along by share key, with how every other attempted send settled, so
   * one send retried every tick counts once rather than once per tick and stops counting
   * once it is sent or given up (`judgeReminderWindow`).
   *
   * Every email in one window, as the two were before #4298: a broken send path fails
   * every email, and the alert speaks of "reminder emails". Each send is keyed apart
   * (`reminderShareKey`: the bare id for the 24 hour email, `hour:<id>` and `<slug>:<id>`
   * for the others), so one booking's emails are separate attempts.
   *
   * It runs AFTER the sends and cannot stop them: every failure inside it is caught
   * and reported, because a monitor bolted onto a lane that emails real people must
   * not be able to take that lane down.
   */
  const rate = await runReminderFailureRateCheck({
    nowMs: now,
    day: reminderRateDay(now),
    tick: rateTick(run),
    thresholds: SHIPPED_REMINDER_FAILURE_RATE_THRESHOLDS,
    cooldownMs: REMINDER_ALERT_COOLDOWN_MS,
    loadState: loadReminderRateState,
    saveState: saveReminderRateState,
    notify: async (key, cooldownMs, text) => {
      // alert-key: booking_reminders_failing
      // alert-key: reminder_email_failing:*
      // alert-text-ok: the text is built by `formatReminderFailureRateAlert` and, per
      // email (#4300), `reminderEmailFailingAlert`, which carry counts and
      // `ReminderFailureCode`s rather than the provider's body.
      await sendThrottledAlert(key, cooldownMs, text);
    },
    // alert-key: booking_reminders_failing
    // alert-key: reminder_email_failing:*
    // all-clear-proof: scripts/test-booking-reminder-rate.ts - a tick whose window
    // could not be READ returns `unverified` and is asserted to resolve nothing, and
    // a window below the floor is `insufficient` and resolves nothing either. The
    // recovery hangs only off a MEASURED healthy verdict (#1134, #1152). Per email
    // (#4300) the same holds in scripts/test-reminder-email-share.ts, and an email
    // stands down only off the lane's measured list of switched on emails.
    resolve: async (key, text) => resolveAlert(key, text),
    // #4300: the emails with an open per email page, so one switched off since is ended.
    // Throws on a failed read, which ends nothing this tick.
    loadFiringEmailSlugs: () => firingFamilyMembers(REMINDER_EMAIL_FAILING_PREFIX),
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

  // Stamped at the END, so a tick that threw on a read never stamps and the lane
  // watchdog notices. That is the whole dead man's switch for this lane: nothing
  // else would say the reminders had stopped, because "nothing to send" and "the
  // read is broken" both look like silence (L98).
  await recordHeartbeat("booking-reminders").catch((e) =>
    log.error("booking-reminder", { msg: "heartbeat failed" }, e instanceof Error ? e : new Error(shortErrorReason(e))),
  );

  return NextResponse.json({
    ...run,
    // Said out loud, because "the share was fine" and "the share could not be
    // measured" are the same silence otherwise (L98).
    rate: rate.status === "checked" ? rate.verdict.status : "unverified",
  });
}

/** The worklist row as the read returns it. */
interface WorklistRow {
  id: string;
  starts_at: string;
  created_at: string;
  reminder_sent_for: string | null;
  reminder_sent_at: string | null;
  hour_reminder_sent_for: string | null;
  status: string;
  attendee_email: string | null;
  attendee_phone: string | null;
  agent_email: string | null;
  agent_name: string | null;
  timezone: string;
  manage_token: string;
  salesforce_id: string | null;
  external_id: string | null;
  gcal_event_id: string | null;
  assigned_user_id: string | null;
  kind: string;
  booking_reminder_sends:
    | {
        reminder_email_id: string;
        sent_for: string;
        status: ReminderSendStatus;
        sent_at: string | null;
        claimed_at: string | null;
      }[]
    | null;
}

/** The legacy bookings column each of the two original emails claims (until phase 6). */
const LEGACY_COLUMN: Record<LegacySlug, "reminder_sent_for" | "hour_reminder_sent_for"> = {
  day: "reminder_sent_for",
  hour: "hour_reminder_sent_for",
};

function laneDeps(db: ReturnType<typeof supabaseAdmin>, now: number): ReminderDeps {
  const nowIso = new Date(now).toISOString();
  /** One of 0211's send record functions, which answer a boolean. */
  const sendRecordRpc = async (
    fn: "mark_reminder_sent" | "release_reminder_send",
    bookingId: string,
    emailId: string,
    sentForIso: string,
  ) => unwrap(await db.rpc(fn, { p_booking_id: bookingId, p_reminder_email_id: emailId, p_sent_for: sentForIso }), fn) === true;
  const reasonedRpc = async (
    fn: "fail_reminder_send" | "skip_reminder_send",
    bookingId: string,
    emailId: string,
    sentForIso: string,
    reason: string,
  ) =>
    unwrap(
      await db.rpc(fn, { p_booking_id: bookingId, p_reminder_email_id: emailId, p_sent_for: sentForIso, p_reason: reason }),
      fn,
    ) === true;

  return {
    now: () => now,
    // Every stored email, switched off ones included, once per tick. `unwrap` THROWS on
    // a failed read, and there is no fallback to the defaults: a lane that guessed its
    // emails could mail leads words an admin had changed or switched off. Roster
    // bounded (a handful of rows, `SAFE_TABLES`).
    loadEmails: async () => {
      const rows = unwrap(await db.from("reminder_emails").select(EMAIL_COLUMNS), "reminder emails") as ReminderEmailRow[];
      return rows.map(laneEmailFromRow);
    },
    loadDue: async (windowEndMs) => {
      // PAGINATED, not one capped page (#2500).
      //
      // The window is the longest enabled email's lead (at most 48 hours), and a booking
      // stays in it for that whole time, reminded or not. A single `.limit(200)` page
      // once filled with rows already dealt with, the unreminded ones behind them were
      // never reached, and nothing said so (L101, L98). Narrowing the query to rows that
      // are work is not available: whether a booking is owed an email depends on its
      // send rows, its legacy columns and the clock, which PostgREST cannot express as a
      // filter, so the read pages and the judgement stays in `reminderDecision`.
      //
      // The send rows come in the same read, embedded through their foreign key to the
      // booking, every start included (the judge ignores records about another start).
      //
      // `selectAllPages` throws on a read error rather than returning a short list. An
      // empty list here is indistinguishable from "nobody needs reminding", which is the
      // normal state, so a failed read that degraded would silently stop every reminder
      // (#277). A throw fails the tick, and the lane's heartbeat lapses, which pages.
      const windowEndIso = new Date(windowEndMs).toISOString();
      const rows = await selectAllPages<WorklistRow>("bookings due a reminder", "id", () =>
        db
          .from("bookings")
          .select(
            "id, starts_at, created_at, reminder_sent_for, reminder_sent_at, hour_reminder_sent_for, status, attendee_email, attendee_phone, agent_email, agent_name, timezone, manage_token, salesforce_id, external_id, gcal_event_id, assigned_user_id, kind, buckets!inner(is_test), booking_reminder_sends(reminder_email_id, sent_for, status, sent_at, claimed_at)",
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
      return rows.map(
        (r): DueBooking => ({
          id: r.id,
          startsAtIso: r.starts_at,
          createdAtIso: r.created_at,
          reminderSentForIso: r.reminder_sent_for,
          reminderSentAtIso: r.reminder_sent_at,
          hourReminderSentForIso: r.hour_reminder_sent_for,
          sends: (r.booking_reminder_sends ?? []).map((s) => ({
            emailId: s.reminder_email_id,
            sentForIso: s.sent_for,
            status: s.status,
            sentAtIso: s.sent_at,
            claimedAtIso: s.claimed_at,
          })),
          status: r.status,
          attendeeEmail: r.attendee_email,
          attendeePhone: r.attendee_phone,
          // A booking with no advisor mailbox is kept rather than dropped here, so the
          // judge counts it as a no_sender wait in the cycle line, stores nothing, and
          // sends once a mailbox is on record (#4298).
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
          // placeholder seat with its own copy: no calling number, no card (the
          // lead's own number is still named, #4292), and a reply
          // to our texts rather than to an inbox nobody reads.
          onPlaceholder: r.kind === "staff_placed",
        }),
      );
    },
    // The CLAIM, decided in Postgres under a per booking lock (`claim_reminder_send`,
    // migration 0211), so two overlapping ticks cannot both send. An answer this code
    // does not know is a throw, never a guess at which way to read it.
    claimSend: async (bookingId, emailId, sentForIso) => {
      const outcome = unwrap(
        await db.rpc("claim_reminder_send", {
          p_booking_id: bookingId,
          p_reminder_email_id: emailId,
          p_sent_for: sentForIso,
          p_gap: CLAIM_GAP,
        }),
        "claim reminder send",
      ) as string;
      if (!CLAIM_OUTCOMES.has(outcome)) throw new Error(`claim_reminder_send answered ${String(outcome)}`);
      return outcome as ReminderClaimOutcome;
    },
    markSendSent: (bookingId, emailId, sentForIso) => sendRecordRpc("mark_reminder_sent", bookingId, emailId, sentForIso),
    releaseSend: (bookingId, emailId, sentForIso) => sendRecordRpc("release_reminder_send", bookingId, emailId, sentForIso),
    failSend: (bookingId, emailId, sentForIso, reason) => reasonedRpc("fail_reminder_send", bookingId, emailId, sentForIso, reason),
    skipSend: (bookingId, emailId, sentForIso, reason) => reasonedRpc("skip_reminder_send", bookingId, emailId, sentForIso, reason),
    // LEGACY (until phase 6): the bookings column the old code reads, written exactly
    // as it wrote it, so a rollback resends nothing. A compare and swap on the value
    // THIS tick read rather than a filter that re-states the rule: it lands only if the
    // row still holds the start and the record this tick judged, so an overlapping
    // writer that claimed first finds the row changed and loses. And it keeps the
    // timestamp OUT of a hand built filter string: PostgREST's `.or()` grammar uses
    // commas and dots, and a Postgres timestamp would be a value parsed as syntax.
    legacyClaim: async (bookingId, slug, startsAtIso, seen) => {
      const column = LEGACY_COLUMN[slug];
      // The 24 hour claim CLEARS the send time (#4282): it is written once Gmail has
      // accepted the email, so a send that fails leaves it unknown and the old 1 hour
      // rule is not held back by an email that never went.
      const set =
        slug === "day" ? { reminder_sent_for: startsAtIso, reminder_sent_at: null } : { hour_reminder_sent_for: startsAtIso };
      let q = db.from("bookings").update(set).eq("id", bookingId).eq("starts_at", startsAtIso);
      q = seen === null ? q.is(column, null) : q.eq(column, seen);
      const won = unwrap(await q.select("id").maybeSingle(), "claim booking reminder") as { id: string } | null;
      return !!won;
    },
    // The mirror of the claim: back to the value THIS tick read, and only where the
    // row still holds the start this tick claimed, so it can undo its own claim and
    // nothing else. The timestamps go through `.eq`, never a filter string.
    legacyRelease: async (bookingId, slug, claimedForIso, restoreTo, restoreSentAt) => {
      const released = unwrap(
        await db
          .from("bookings")
          .update(
            slug === "day"
              ? { reminder_sent_for: restoreTo, reminder_sent_at: restoreSentAt }
              : { hour_reminder_sent_for: restoreTo },
          )
          .eq("id", bookingId)
          .eq(LEGACY_COLUMN[slug], claimedForIso)
          .select("id")
          .maybeSingle(),
        "release booking reminder claim",
      ) as { id: string } | null;
      return !!released;
    },
    // When the 24 hour email went out (#4282), only where the row still holds the
    // start this tick claimed it for.
    legacyMarkSent: async (bookingId, startsAtIso) => {
      unwrap(
        await db
          .from("bookings")
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq("id", bookingId)
          .eq("reminder_sent_for", startsAtIso)
          .select("id")
          .maybeSingle(),
        "record booking reminder send time",
      );
    },
    send: (msg) => sendGmailEmail(msg),
    alert: async (bookingId, slug, text) => {
      // Keyed per booking and email (2026-10-05, #4282, #4298): the 24 hour email keeps
      // `booking_reminder_failed:<id>`, the 1 hour email `:<id>:hour`, any other
      // `:<id>:<slug>`, the id always the segment after the family so the per booking
      // prune finds it. Under one shared key the first lost reminder held every other
      // booking's page back for the cooldown. A wave is the share's job above.
      // alert-key: booking_reminder_failed:*
      // alert-text-ok: the text is built by `reminderFailedAlert`, which carries a
      // short reason rather than the provider's body.
      await sendThrottledAlert(reminderFailedAlertKey(bookingId, slug), REMINDER_ALERT_COOLDOWN_MS, text);
    },
    alertUnrenderable: async (slug, text) => {
      // A condition per email: it holds while the email is switched on and its words
      // cannot be filled in, and clears below on a tick that rendered it.
      // alert-key: reminder_email_unrenderable:*
      // alert-text-ok: built by `reminderEmailUnrenderableAlert` from the template
      // problems, never a provider's error.
      await sendThrottledAlert(reminderEmailUnrenderableKey(slug), REMINDER_ALERT_COOLDOWN_MS, text);
    },
    resolveRenderable: async (recovered) => {
      const cleared = recovered.map((r) => ({ key: reminderEmailUnrenderableKey(r.slug), text: r.text }));
      // alert-key: reminder_email_unrenderable:*
      // all-clear-proof: scripts/test-booking-reminder-send.ts, where an email is listed
      // here only when this tick's render of it SUCCEEDED or it is switched off, both
      // measured from the read of reminder_emails, which throws rather than answering
      // empty; a failed read resolves nothing because the tick never gets here.
      await resolveRecovered(cleared);
    },
    notifyNoneEnabled: async (text) => {
      // alert-text-ok: fixed copy from `noReminderEmailEnabledText`.
      await sendThrottledInfo("reminder_emails_all_off", NONE_ENABLED_COOLDOWN_MS, text);
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
        // A line with nothing to attach (a record that was no longer claimed) passes
        // null, which is logged without a stack.
        err === null ? undefined : err,
      ),
  };
}

/** The tick's cycle line, and its error lines. Ids, slugs and counts only. */
function logRun(run: ReminderRun) {
  if (run.noneEnabled) {
    // Every tick, beside the once a day info alert, so the log never reads as a quiet
    // afternoon while the lane is in fact sending nothing at all.
    log.warn("booking-reminder", { msg: "no reminder email is switched on, so none is sent" });
  }
  if (run.unrenderable.length > 0) {
    log.error(
      "booking-reminder",
      { msg: "reminder emails cannot be rendered, so they are not sent", emails: run.unrenderable.join(",") },
      new Error("reminder email unrenderable"),
    );
  }
  if (run.failed > 0) {
    log.error(
      "booking-reminder",
      { msg: "reminders failed to send", failed: run.failed, retrying: run.retrying },
      new Error("reminder send failed"),
    );
  }
  log.info("booking-reminder", {
    msg: "cycle",
    emails_enabled: run.emailsEnabled,
    sent: run.sent,
    failed: run.failed,
    retrying: run.retrying,
    pages_folded: run.pagesFolded,
    skipped: run.skipped,
    skipped_by_reason: Object.entries(run.skippedByReason)
      .map(([reason, n]) => `${reason}:${n}`)
      .join(","),
    held: run.held,
    waiting: run.waiting,
    waiting_by_reason: Object.entries(run.waitingByReason)
      .map(([reason, n]) => `${reason}:${n}`)
      .join(","),
    idle: run.idle,
    unreadable: run.unreadable,
    lost: run.lost,
    attempted: run.attempted,
    with_calling_number: run.withCallingNumber,
    calling_number_unread: run.callingNumberUnread,
    invite_refresh_failed: run.inviteRefreshFailed,
    with_photo: run.withPhoto,
    photo_unread: run.photoUnread,
    with_logo: run.withLogo,
    // One compact field per email, so a line says which email sent what.
    by_email: Object.entries(run.byEmail)
      .map(([slug, c]) => `${slug}:sent=${c.sent},failed=${c.failed},held=${c.held},waiting=${c.waiting},skipped=${c.skipped},lost=${c.lost}`)
      .join(";"),
  });
}

/**
 * The tick the failure share is judged on: every email's sends, keyed apart (#4282,
 * #4298), plus each email's own counts so its share is judged on its own (#4300), and
 * the names and switched on slugs its pages and stand downs need.
 */
export function rateTick(run: ReminderRun) {
  return {
    attempts: run.attempted,
    failures: run.failed,
    byCode: { ...run.byCode },
    retried: { ...run.retried },
    settled: { ...run.settled },
    byEmail: Object.fromEntries(
      Object.entries(run.byEmail).map(([slug, c]) => [slug, { attempts: c.attempted, failures: c.failed, byCode: { ...c.byCode } }]),
    ),
    emailNames: { ...run.emailNames },
    enabledSlugs: [...run.enabledSlugs],
  };
}
