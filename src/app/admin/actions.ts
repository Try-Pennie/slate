"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { refusedFromQuery, refusedQuery, savedQuery } from "@/lib/admin/save-outcomes";
import {
  CHANGED_SINCE_OPENED,
  PAGE_OUT_OF_DATE,
  loadedFieldsFrom,
  loadedVersionFrom,
  type LoadedFieldValue,
  type LoadedVersion,
} from "@/lib/admin/edit-version";
import { HOURS_CHANGED_SQLSTATE } from "@/lib/calcom/import-write";
import { fetchSlackChannel, listSlackChannels } from "@/lib/notify/slack";
import {
  channelCheckMessage,
  channelNames,
  readChannelReply,
  refusesSave,
} from "@/lib/notify/slack-channel-check";
import { checkChannels } from "@/lib/notify/slack-channel-names";
import {
  channelInputMessage,
  looksLikeChannelId,
  resolveChannelInput,
} from "@/lib/notify/slack-channel-input";
import { cookies } from "next/headers";
import { refreshOnePhoto, runAdvisorPhotoLane } from "@/lib/advisor-photos/lane";
import { photoOutcome, photoOutcomeQuery } from "@/lib/advisor-photos/copy";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  currentUser,
  realCurrentUser,
  requireAdmin,
  requireManager,
  requireSuperAdmin,
} from "@/lib/auth";
import {
  isGrantableStaffRole,
  normalizeStaffEmail,
  planStaffAccess,
  requiresAdminCount,
  staffAccessInputError,
  type StaffAccessOutcome,
  type StaffAccessTarget,
} from "@/lib/admin/staff-access";
import { googleHostedDomain, impersonationSigningSecret } from "@/lib/env";
import {
  IMPERSONATE_COOKIE,
  IMPERSONATE_TTL_SECONDS,
  encodeImpersonationCookie,
  impersonationTargetId,
} from "@/lib/auth/impersonation";
import {
  atLeast,
  canImpersonate,
  canManageUser,
  canChangeRole,
  canSetRole,
  isRole,
  isSelfDemotion,
  roleLabel,
} from "@/lib/auth/roles";
import { roundUpToQuarterHour } from "@/lib/date/parse";
import { SEED_START_TIME, SEED_END_TIME, WEEKDAY_NAMES } from "@/lib/schedule-core";
import {
  parseBusinessHoursForm,
  countBookingsOnWeekdays,
} from "@/lib/booking/business-hours-form";
import { loadBusinessHoursRows } from "@/lib/booking/business-hours-load";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { selectAllPages } from "@/lib/supabase/paginate";
import { unwrap } from "@/lib/db/result";
import { EVENT_TYPE_DEFAULTS } from "@/lib/booking/event-type-defaults";
import { allowRequest } from "@/lib/rate-limit";
import { WEBHOOK_TEST_SEND_RATE_RULES } from "@/lib/rate-limit-core";
import { buildRequest } from "@/lib/webhooks/wire";
import {
  TEST_SEND_AUTH,
  TEST_SEND_SECRET,
  TEST_SEND_PAYLOAD,
  testSendTargetError,
  summariseTestResponse,
} from "@/lib/webhooks/test-send";
import { shortErrorReason } from "@/lib/notify/error-text";
import type { WebhookFormat } from "@/lib/db/types";
import {
  applyBookableByUserId,
  BookableLookupError,
  type BlockedReason,
  type BookableResult,
} from "@/lib/bookable/service";
import { planClearPendingFlip } from "@/lib/bookable/plan";
import { GOOGLE_RELINK_REFUSED } from "@/lib/auth/google-identity-copy";
import { MISSING_TIMEZONE_HOURS, submittedTimezone } from "@/lib/submitted-timezone";
import { applyLifecycleByUserId } from "@/lib/offboarding/service";
import { runRosterSync } from "@/lib/salesforce/run-roster-sync";
import type { TwilioSyncResult } from "@/lib/twilio/sync";
import { replayDeadLetteredDeliveries, resendDelivery } from "@/lib/webhooks/emit";
import { webhookEndpointAuditDetails, webhookUrlError } from "@/lib/webhooks/url";
import { readPrimaryWebhookEndpoint } from "@/lib/webhooks/primary-endpoint";
import { acquireLock } from "@/lib/locks";
import { recordAudit } from "@/lib/audit";
import { CALCOM_RETIREMENT_FORM, loadCalcomRetired, __resetCalcomRetiredCache } from "@/lib/calcom/retirement";
import { loadPutBackCounts, putBackQuery } from "@/lib/calcom/put-back";
import { parseIgnoreAdd, personLabel, type IgnoreRosterUser } from "@/lib/admin/regal-call-ignores";
import { impersonationErrorUrl } from "@/lib/admin/imp-error-url";
import { isActive } from "@/lib/active-user";
import {
  parseMonitorSettingsForm,
  ALERT_KEYS as MONITOR_ALERT_KEYS,
  type MonitorAlertKey,
} from "@/lib/monitor/settings";
import { RAMP_END_FORM, parseRampEndForm } from "@/lib/monitor/volume-relearn";
import {
  coerceReasonOptionsForm,
  parseReasonOptionsForm,
} from "@/lib/booking/reason-options";
import {
  parseDefaultBucketForm,
  parseEventDescriptionForm,
  readNearlyFullPct,
} from "@/lib/booking/settings";
import { parseDaysOfferedForm } from "@/lib/booking/days-offered";
import { markAllBucketSlotsStale } from "@/lib/availability/precompute";
import {
  updateEventType,
  type EventTypeField,
  type EventTypePatch,
} from "@/lib/availability/event-type-store";
import { log } from "@/lib/log";
import { coverageForWeek } from "@/lib/booking/business-hours-coverage";
import { parseExceptionForm, countBookingsOnDate } from "@/lib/booking/business-hours-form";
import {
  loadCoverageAgents,
  currentWeekStartIso,
} from "@/lib/booking/business-hours-coverage-load";
import {
  COVERAGE_UNCHECKED_WARNING,
  newlyUncoveredGaps,
  newlyUncoveredWarning,
} from "@/lib/monitor/roster-coverage";
import { clearChannelCache } from "@/lib/notify/channels";
import {
  planScheduleReplacement,
  planUniformSchedule,
  type ScheduleReplacementPlan,
  type ScheduleRule,
} from "@/lib/schedule-replacement";
import type { Criteria, Role, User } from "@/lib/db/types";
import { seederOwnsCode } from "@/lib/xbc";
import { DAYS_OFFERED } from "@/lib/admin/days-offered-copy";
import { parseNearlyFullPct } from "@/lib/admin/team-capacity-copy";
import { ME_TABS } from "@/lib/me/nav";
import { REAL_ADVISOR_COLUMNS } from "@/lib/advisors/real-advisor";
import { COORDINATOR_BOOKING_COPY, COORDINATOR_BOOKING_HREF } from "@/lib/admin/coordinator-booking-copy";
import {
  COVERAGE_CHOICE_FIELD,
  readCoverageChoice,
} from "@/lib/offboarding/coverage-choice";

/**
 * What a refused WRITE says, and the one place it is said (#2379).
 *
 * supabase-js does NOT throw on a statement Postgres refuses: it resolves
 * `{ error }`. Eleven saves in this file awaited a write, read nothing off it,
 * and carried on to record an audit entry naming the value, revalidate, and land
 * on a saved notice. A refused kill switch left the embed taking bookings while
 * the trail said `public_booking_paused: true`, which is the one question that
 * record exists to answer (L529, L12).
 *
 * ONE builder rather than eleven sentences, so the saves cannot drift into
 * eleven different ways of telling somebody the same thing (L41), and so the
 * detail reaches the LOG in every case: Cloudflare stores the serialized error,
 * and the reader on screen gets the short reason without having to be handed a
 * stack (see "Alert copy never carries a raw error" in docs/alerts-runbook.md,
 * the same division applied to a screen).
 *
 * `what` names the thing that did not change, in the vocabulary of the form the
 * person is looking at, never the table (L399).
 */
function writeRefused(what: string, error: { message: string; code?: string }): string {
  log.error("admin-actions", { msg: "write refused", what, code: error.code ?? null }, error);
  return `${what} could not be saved: ${error.message}`;
}

/**
 * Asserts the signed-in user is a manager+ who may edit `userId` (escalation
 * guard: a manager can edit agents but not peers/admins). Returns the actor.
 *
 * #3089: it AUTHORIZES and nothing else. It used to write the `agent.*` audit row
 * here too, before the mutation had run and with no details, so a save the
 * database refused still read in the trail as an edit that happened, and an edit
 * that did happen said nothing about what changed (the contract on `recordAudit`).
 * Each caller now records its own entry after its write succeeds, with the value
 * before and after.
 */
async function requireManageAgent(userId: string): Promise<User> {
  const actor = await requireManager();
  // #1629: this is an AUTHORIZATION read, and swallowing it failed OPEN. A null
  // `data` defaulted the target to "agent", which is the role a manager is allowed
  // to edit, so an unreadable users row let a manager edit an admin. `unwrap`
  // refuses instead of guessing the answer that grants the most.
  const data = unwrap(
    await supabaseAdmin().from("users").select("role").eq("id", userId).maybeSingle(),
    "manage-agent target role",
  );
  // #1046: and a read that finds NOTHING must refuse too. The `?? "agent"` this
  // replaces defaulted an absent target to the one role every manager may edit, so
  // a stale or mistyped id passed the escalation guard and recorded an audit row
  // against a user that does not exist. Absent is not a role; it is a refusal.
  const target = data as { role: Role } | null;
  if (!target) throw new Error("Not authorized");
  const targetRole = target.role;
  if (!canManageUser(actor.role, targetRole, actor.id === userId)) {
    throw new Error("Not authorized");
  }
  return actor;
}

/** A user's week as the trail records it: the zone and each day's window. */
type ScheduleSnapshot = {
  timezone: string;
  rules: { weekday: number; start_minute: number; end_minute: number }[];
};

/**
 * The agent's week BEFORE an hours save, for the trail's "from" (#3089).
 *
 * Never throws and never blocks the save: an unreadable week is recorded as
 * "unreadable" rather than as no schedule, because "they had no hours" and "we
 * could not tell" are different facts about the past (L11), and refusing an hours
 * change over a read the change does not need would trade a real edit for a
 * better footnote. Null is a real answer: the agent had no schedule row yet.
 */
async function readScheduleForAudit(userId: string): Promise<ScheduleSnapshot | null | "unreadable"> {
  let data: unknown;
  let error: unknown;
  // Both failure shapes: a returned `{ error }`, and a call that REJECTS (a
  // network fault), which would otherwise escape and abort the save it decorates.
  try {
    ({ data, error } = await supabaseAdmin()
      .from("availability_schedules")
      .select("timezone, availability_rules(weekday, start_minute, end_minute)")
      .eq("user_id", userId)
      .maybeSingle());
  } catch (err) {
    error = err;
  }
  if (error) {
    log.warn("admin-actions", { msg: "schedule before an hours save could not be read", user_id: userId }, error);
    return "unreadable";
  }
  if (!data) return null;
  const row = data as {
    timezone: string;
    availability_rules: ScheduleSnapshot["rules"] | null;
  };
  return { timezone: row.timezone, rules: sortRules(row.availability_rules ?? []) };
}

function sortRules(rules: ScheduleSnapshot["rules"]): ScheduleSnapshot["rules"] {
  return [...rules]
    .map((r) => ({ weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute }))
    .sort((a, b) => a.weekday - b.weekday || a.start_minute - b.start_minute);
}

/** Records an hours save AFTER it landed, with the week before and after (#3089). */
async function auditScheduleSave(
  actor: User,
  userId: string,
  action: "agent.hours" | "agent.use_default_hours",
  before: ScheduleSnapshot | null | "unreadable",
  plan: ScheduleReplacementPlan,
): Promise<void> {
  if (!plan.ok) return;
  await recordAudit({
    orgId: actor.org_id,
    actorId: actor.id,
    action,
    targetUserId: userId,
    details: {
      schedule: {
        from: before,
        to: { timezone: plan.timezone, rules: sortRules(plan.rules) },
      },
    },
  });
}

/**
 * Replaces a user's weekly schedule, the timezone and the rules together, in ONE
 * transaction (#1293, #2002).
 *
 * Four things this must never do, because each one silently changes when an agent
 * is offered while reporting a successful save:
 *
 *   1. Apply an input that cannot produce a real week. Refused BEFORE anything is
 *      written, with a message for the person who pressed save.
 *   2. Leave the schedule half written. The delete and the insert are one
 *      transaction inside `replace_availability_rules` (migration 0097), so a
 *      failure keeps the previous rules rather than clearing them.
 *   3. Commit the TIMEZONE on its own. It used to: the schedule row was upserted
 *      with the new zone before the rules were replaced, so a failed rules write
 *      left the agent holding the new zone over their old hours, which moves every
 *      bookable hour by the offset between the two with nothing reporting it.
 *      `replace_user_schedule` (migration 0129) owns the row and its rules, and the
 *      expected count is checked inside that same transaction rather than compared
 *      here, where the comparison can only happen after the write has committed.
 *   4. Swallow the write's error. It throws, which the server action surfaces.
 */
async function replaceUserSchedule(
  userId: string,
  /** Who is writing (#1753): the agent themselves, or an admin acting on them. */
  source: "agent" | "admin",
  /**
   * The plan, already validated by the caller through `planScheduleReplacement`
   * (a window PER DAY, #1308) or `planUniformSchedule` (one window on several
   * days, which is what the org default and the "use company hours" button mean).
   * Taking the PLAN rather than raw days is what puts every writer on one
   * validator: the org-default button used to bypass it entirely (#1670).
   */
  plan: ScheduleReplacementPlan,
  /**
   * The schedule row's `updated_at` as the form loaded it, or null when the form
   * was drawn with no row (#3122). The write lands only while the row still holds
   * it, so two people editing one week cannot silently overwrite each other.
   */
  loadedUpdatedAt: string | null,
): Promise<"saved" | "changed"> {
  if (!plan.ok) throw new Error(plan.error);

  const db = supabaseAdmin();
  // ONE call, because the zone and the week are one change (#2002). This used to
  // upsert the schedule row with the new zone and THEN replace the rules, so a
  // failed rules write left the agent holding the new zone over their old hours:
  // every hour they are bookable moved by the offset between the two, invisibly,
  // while the form redrew the hours it had not changed. Migration 0129 owns the
  // row and its rules together, so a refusal anywhere inside leaves the agent
  // exactly as they were.
  //
  // The zone travelling here is the VALIDATED one, never the raw argument: an
  // unreadable one makes every weekday comparison in `isWithinWorkingHours` false,
  // so the agent is bookable at no time at all while the form still renders their
  // hours (#1671).
  //
  // #3122: through the guarded form, which locks the row and compares its version
  // against the one the form loaded inside the same transaction as the write.
  const { data, error } = await db.rpc("replace_user_schedule_if_unchanged", {
    p_user_id: userId,
    p_timezone: plan.timezone,
    p_rules: plan.rules,
    p_source: source,
    // The count is enforced INSIDE the transaction, so a write that landed the
    // wrong number of rules rolls the zone back with it.
    p_expected: plan.rules.length,
    p_loaded_updated_at: loadedUpdatedAt,
  });
  // Somebody saved this week after the form was opened. A refusal for the person,
  // not a fault: nothing was written and their edit is still on their screen.
  if (error?.code === HOURS_CHANGED_SQLSTATE) return "changed";
  if (error) {
    throw new Error(`Your hours could not be saved: ${error.message}`);
  }
  // A returned count this cannot read is a different failure from a count the
  // database refused: nothing came back to judge, so success is not claimable.
  // The comparison stays as well, because a client that cannot tell 5 from 3 has
  // no business reporting a save either way.
  const written = typeof data === "number" ? data : Number.NaN;
  if (written !== plan.rules.length) {
    throw new Error(
      `Your hours could not be saved: expected ${plan.rules.length} days, the database recorded ${Number.isFinite(written) ? written : "an unreadable count"}.`,
    );
  }
  return "saved";
}

/**
 * The schedule version a working hours form loaded (#3122), or a redirect refusing
 * the save when the form carried none. `null` is a real answer: the form was drawn
 * with no schedule row.
 */
function loadedScheduleVersion(form: FormData, page: string): string | null {
  const loaded: LoadedVersion = loadedVersionFrom(form);
  if (loaded.kind === "missing") redirect(`${page}${refusedQuery(PAGE_OUT_OF_DATE)}`);
  return loaded.stamp;
}

// #2103: `applyOrgDefaultToUser` was deleted here with its only caller.
//
// It turns out it had exactly one: the agent's own "use the company hours"
// button. The ADMIN equivalent (`useDefaultHours`, below) never called it and
// carries its own copy of the same reads, which is the shape L370 describes:
// the org defaults were shared as DATA while the logic applying them was
// duplicated, so the shared helper read as the single source of truth while a
// second implementation sat beside it. That duplication is pre-existing and is
// left as it stands rather than refactored on the way past; what is fixed here
// is that the unused half is gone rather than sitting there looking load
// bearing.

/**
 * The week as the per-day hours form submits it (#1308): a checkbox and its own
 * pair of times per weekday.
 *
 * A day that is not ticked contributes nothing, so its times are never read and a
 * blank pair on an unticked day cannot refuse the save. A TICKED day whose times
 * are unreadable is passed through as NaN deliberately, so `planScheduleReplacement`
 * refuses it and names the day, rather than a permissive default here quietly
 * moving somebody to midnight (L50).
 */
const perDayFrom = (form: FormData): ScheduleRule[] =>
  [1, 2, 3, 4, 5, 6, 7].filter((d) => form.get(`day_${d}`)).flatMap((weekday) => {
    // Repeated field names, paired by position (#1764). A single `start_1` can no
    // longer identify a window now that a day can hold several, and repeated names
    // survive a middle row being removed with no index bookkeeping to get wrong.
    const starts = form.getAll(`start_${weekday}`).map(String);
    const ends = form.getAll(`end_${weekday}`).map(String);
    const count = Math.max(starts.length, ends.length);

    const windows: ScheduleRule[] = [];
    let blanks = 0;
    for (let i = 0; i < count; i++) {
      const start = starts[i] ?? "";
      const end = ends[i] ?? "";
      // A window with NEITHER bound is a row somebody added and left alone, which
      // must not refuse a save. A HALF filled one is a mistake and is passed
      // through as NaN so the planner refuses it and names the day: dropping it
      // would save a week quietly missing hours that had just been entered.
      if (start.trim() === "" && end.trim() === "") {
        blanks++;
        continue;
      }
      windows.push({
        weekday,
        start_minute: toMinutes(start),
        end_minute: toMinutes(roundUpToQuarterHour(end)),
      });
    }

    // A ticked day that contributed nothing (every window blank, or no window
    // fields at all) is NOT silently dropped. Dropping it would either shorten the
    // week without saying so or, if it were the only day, produce the "pick at
    // least one day" refusal for a day that was in fact picked. One unreadable
    // window instead, so the refusal names this day (L11).
    if (windows.length === 0 && (blanks > 0 || count === 0)) {
      return [{ weekday, start_minute: Number.NaN, end_minute: Number.NaN }];
    }
    return windows;
  });

/** Agent self-service: set my own working hours. */
export async function setMyWorkingHours(form: FormData): Promise<void> {
  const me = await currentUser();
  if (!me) return;
  // #1994: a REFUSAL is the person's to fix, so it is sent back as a message
  // rather than thrown. Every one of these sentences ("Tuesday's windows overlap
  // each other", "Monday's end time needs to be later than its start time") was
  // unreachable: a thrown error in a server action is redacted in production and
  // arrives as the generic error boundary, which says it cannot tell what
  // happened. A refusal only speakable by a path that can never speak it (L109).
  //
  // A FAULT still throws. A database that refused the write is not something a
  // person can retype their way out of, and dressing one as advice would send
  // them round the same loop.
  // #2107: the availability page's own address, from the tab list, on all three
  // of these. A redirect carrying an outcome must name the page it is actually
  // on: /me is a redirect now, and a redirect whose target redirects again DROPS
  // the query string (L586), so a saved notice sent to /me would arrive nowhere
  // and the form would look like it had done nothing.
  const availability = ME_TABS[0].href;
  // #1989: a missing zone is refused, never saved as Eastern.
  const timezone = submittedTimezone(form);
  if (!timezone) redirect(`${availability}${refusedQuery(MISSING_TIMEZONE_HOURS)}`);
  const plan = planScheduleReplacement(perDayFrom(form), timezone);
  if (!plan.ok) redirect(`${availability}${refusedQuery(plan.error)}`);
  const loaded = loadedScheduleVersion(form, availability);
  if ((await replaceUserSchedule(me.id, "agent", plan, loaded)) === "changed") {
    redirect(`${availability}${refusedQuery(CHANGED_SINCE_OPENED)}`);
  }
  revalidatePath(availability);
  // #1988: the save said nothing at all, so it looked exactly like a click that
  // did nothing. Post-redirect-get with a NAMED outcome, the same shape every
  // other settings form here uses, and the redirect is AFTER the write so a
  // refusal (which throws out of `planScheduleReplacement`) never reaches it.
  redirect(`${availability}${savedQuery("working-hours")}`);
}

// #2103: `useMyDefaultHours` was deleted here, and the deletion matters more
// than the two controls that called it. This file is "use server", so every
// export is a callable endpoint: leaving it behind would have kept a route any
// signed in person could invoke to replace their whole week with the org
// default, reachable by nothing on any screen and watched by nobody (L29).
//
// Nothing is lost. A new agent's week is seeded by `ensureDefaultSchedules`
// inside the same `runRosterSync` that inserts them, so the "apply the company
// hours to me" button was a manual route to something that had already
// happened. An admin can still apply the org default from the agent's own page,
// which is a different actor writing a different person's hours.

/**
 * "Sync from Salesforce", from the roster page (#491, #2071).
 *
 * Managers may press it, not only admins: the person who has just added a hire in
 * Salesforce and cannot see them here is a manager, and telling them to wait for
 * the top of the hour is the wrong answer to "where are my agents". It runs the
 * WHOLE hourly job under the hour's own lock (`runRosterSync`), so a press does
 * everything the schedule would have, and a press while a run is under way says
 * so rather than starting a second one.
 *
 * The banner comes back to THIS page (L608), and it says what changed in the terms
 * the presser cares about: who was added, who became bookable, and who is waiting
 * on a Google calendar. Counts rather than names in the query string, since the
 * roster below already lists the people and an email in a URL is an identity in
 * browser history for no gain.
 */
export async function syncSalesforceNow(): Promise<void> {
  await requireManager();
  const back = "/admin/agents";
  // The run and the redirects are kept apart: a redirect is thrown, so one inside
  // the try would be caught below and reported as a failure.
  let outcome: Awaited<ReturnType<typeof runRosterSync>>;
  try {
    outcome = await runRosterSync();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    revalidatePath(back);
    redirect(`${back}?sync_error=${encodeURIComponent(message.slice(0, 200))}`);
    return;
  }
  if (outcome.skipped) {
    revalidatePath(back);
    redirect(`${back}?sync_error=${encodeURIComponent("a sync is already running; try again in a minute")}`);
    return;
  }
  let summary: string;
  {
    const r = outcome.sync;
    const plural = (n: number, one: string, many = `${one}s`) =>
      `${n} ${n === 1 ? one : many}`;
    const parts = [
      `${r.updated + r.inserted} agents synced`,
      r.inserted ? `${r.inserted} added` : null,
      // #2071: the three onboarding facts, each its own line, because the presser
      // is usually asking about one of them.
      r.createdUntiered
        ? `${plural(r.createdUntiered, "new hire")} added not yet bookable (not on the Sales profile yet)`
        : null,
      // #2621: a state only a person can settle, said every run so it cannot sit
      // silent the way three missed hires did for up to eighteen days.
      r.salesNotBookableUnexplained
        ? `${plural(r.salesNotBookableUnexplained, "agent")} on the Sales profile ${r.salesNotBookableUnexplained === 1 ? "is" : "are"} not bookable and nothing records why`
        : null,
      r.bookableFlipped.length
        ? `${plural(r.bookableFlipped.length, "agent")} made bookable from a first debt team or the Sales profile`
        : null,
      r.bookablePending.length
        ? `${plural(r.bookablePending.length, "agent")} waiting to become bookable until a Google calendar exists for them`
        : null,
      // #3028: refused because Twilio holds them on Redistribute, and handed to the
      // Twilio sync, which makes them bookable once the tag comes off. Its own line,
      // because the remedy is in Twilio and not in Google.
      r.bookableHeldByTwilio.length
        ? `${plural(r.bookableHeldByTwilio.length, "agent")} held out of the pool by the Twilio Redistribute tag, and made bookable once it comes off`
        : null,
      // #2302: planned for activation and not attempted this run, because reading a
      // calendar per agent is bounded per run. Said because the presser can
      // otherwise not tell it from a run where everybody came through, and saying
      // that the next run picks them up is what stops a queue reading as an error.
      r.bookableDeferredToNextRun.length
        ? `${plural(r.bookableDeferredToNextRun.length, "agent")} still waiting to be made bookable, which the next hourly sync picks up`
        : null,
      r.managersLinked
        ? `${plural(r.managersLinked, "agent")} reassigned to a manager`
        : null,
      // Reported, because a run that CLEARS a link changes who approves someone's
      // time off just as much as one that sets it, and a summary that only ever
      // counts additions makes convergence look like a quiet run (#1474).
      r.managersUnlinked
        ? `${plural(r.managersUnlinked, "agent")} no longer has a manager in Salesforce`
        : null,
      // The two refusals, said separately (#1653). Before the split, one line
      // covered both, so an admin who pressed sync to fix a manager problem read
      // "could not be matched" whether the name was missing (a picklist value to
      // correct) or shared by two people (a Salesforce record to fix), and the
      // second is the one that decides whether an approval reaches the right
      // person. The unit is AGENTS, which is what the count has always held: the
      // old line said "manager name" and rendered "15 manager names" for one
      // unmatched name shared by a team of fifteen.
      r.managersUnresolved
        ? `${plural(r.managersUnresolved, "agent")} ${r.managersUnresolved === 1 ? "has" : "have"} a manager name nothing in Salesforce matched, so those links were left alone`
        : null,
      r.managersAmbiguous
        ? `${plural(r.managersAmbiguous, "agent")} left unlinked because ${plural(r.managerNamesAmbiguous, "manager name")} in Salesforce ${r.managerNamesAmbiguous === 1 ? "answers" : "answer"} to more than one user`
        : null,
      r.managersCreated ? `${plural(r.managersCreated, "new manager")}` : null,
      r.managersPromoted ? `${r.managersPromoted} promoted to manager` : null,
      r.deactivated ? `${plural(r.deactivated, "user")} deactivated` : null,
      // #1833: still taking booked calls, and the roster query no longer returns
      // them. Only the BOOKABLE ones are on the page, because that is the half an
      // admin can act on from here (the toggle is on this very screen); the rest
      // are counted in the sync's own log line. Nothing was changed for them, and
      // the line says so, because a count beside a list of things the run DID
      // would otherwise read as another thing it did.
      r.rosterUnconfirmedBookable.length
        ? `${plural(r.rosterUnconfirmedBookable.length, "bookable agent")} no longer returned by the Salesforce roster query, left exactly as they are`
        : null,
      outcome.hoursApplied ? `${plural(outcome.hoursApplied, "agent")} given the default working hours` : null,
      // #2097: what the TWILIO half changed. The label used to say Salesforce and the
      // job now reads two sources, so a run that took twelve agents out of the pool
      // for a Twilio tag would otherwise report half of what it did.
      ...(outcome.twilio.ok ? twilioParts(outcome.twilio.result, plural) : []),
    ].filter(Boolean);
    summary =
      parts.length > 1 ? parts.join(" · ") : `${parts[0]} (already up to date)`;
  }
  revalidatePath(back);
  // A failed Twilio half rides BESIDE the success rather than replacing it (#2097).
  // The Salesforce writes committed, so reporting the run as a failure would be a
  // lie; reporting it as a plain success would hide that nobody was taken out of the
  // pool for the Redistribute tag, and a silent Twilio half has every symptom of a
  // healthy one. Its own parameter, so the page draws it as a refusal instead of
  // burying a failure sentence in a green wash.
  const twilioError = outcome.twilio.ok
    ? ""
    : `&twilio_error=${encodeURIComponent(outcome.twilio.reason.slice(0, 200))}`;
  redirect(`${back}?synced=${encodeURIComponent(summary)}${twilioError}`);
}

/**
 * The Twilio half's lines, in the order a reader cares about them (L609): who is out
 * of the pool now, who is back in, and who could not be let back in.
 *
 * Counts, never addresses: the summary travels in a URL, and an email in a URL is an
 * identity in browser history and in every referrer.
 */
function twilioParts(
  r: TwilioSyncResult,
  plural: (n: number, one: string, many?: string) => string,
): (string | null)[] {
  const tagLanded = tagOnly(r.redistributeTagLanded, r.turnedOff).length;
  const tagCleared = tagOnly(r.redistributeTagCleared, [...r.turnedBackOn, ...r.reactivationRefused]).length;
  return [
    r.turnedOff.length
      ? `${plural(r.turnedOff.length, "agent")} taken out of the bookable pool because Twilio marks them redistribute`
      : null,
    r.turnedBackOn.length
      ? `${plural(r.turnedBackOn.length, "agent")} put back in the pool because Twilio no longer marks them redistribute`
      : null,
    // Dan, 2026-09-08: on the page, not only in Slack an hour later. The gate refuses
    // anybody with no reachable Google calendar, which is the ordinary state for
    // somebody whose tag came off before their Google account was provisioned.
    r.reactivationRefused.length
      ? `${plural(r.reactivationRefused.length, "agent")} could not be put back in the pool until a Google calendar exists for them`
      : null,
    // What the agents taken out of the pool were holding (#2115). Right after the
    // pool change that caused it, because it is the consequence of that line rather
    // than a separate event, and the coverage panel is where somebody follows it up.
    r.coverageSweeps.length
      ? `${plural(r.coverageSweeps.reduce((n, c) => n + c.bookings, 0), "upcoming call")} being moved off ${plural(r.coverageSweeps.length, "agent")} who left the pool`
      : null,
    r.coverageSweepFailures
      ? `${plural(r.coverageSweepFailures, "agent")} left the pool and their upcoming calls could not be queued for a move, so use the coverage panel on their profile`
      : null,
    // #3615: the PARTIAL sibling of the line above, a demotion sweep moving only the calls in
    // the pool an agent lost, then the reroute's own faults. An unreadable switch is said on its
    // own, because it means nobody was checked at all. "Queued", because this run only queues
    // the moves; the Slack line says how they settled once the sweep finishes.
    r.demotionSweeps.length
      ? `${plural(r.demotionSweeps.reduce((n, c) => n + c.bookings, 0), "upcoming call")} queued to move off ${plural(r.demotionSweeps.length, "agent")} whose Twilio tiers no longer cover them`
      : null,
    r.demotionSwitchUnreadable
      ? "Slate could not read whether the automatic reroute is switched on and checked nobody, so press this again in a minute"
      : null,
    r.demotionEvalFailures + r.demotionSweepFailures + r.demotionWriteFailures
      ? `${plural(r.demotionEvalFailures + r.demotionSweepFailures + r.demotionWriteFailures, "agent")} the automatic reroute could not finish for, so press this again in a minute`
      : null,
    // The routing attributes (#2152), before the failures, because a
    // changed tier moves somebody between buckets and is the one a reader will go
    // and check.
    r.tiersChanged.length
      ? `${plural(r.tiersChanged.length, "agent")} whose debt teams now match their Twilio tags`
      : null,
    r.backendChanged.length
      ? `${plural(r.backendChanged.length, "agent")} whose backend service now matches their Twilio tags`
      : null,
    // The Redistribute tag itself (#2735), which is what exempts somebody from the
    // Regal call page. Anybody the flip lines above already named is left out, so
    // one tag moving is one line (L605).
    tagLanded ? `${plural(tagLanded, "agent")} newly tagged Redistribute in Twilio` : null,
    tagCleared ? `${plural(tagCleared, "agent")} whose Redistribute tag came off in Twilio` : null,
    // A flip that threw. Said out loud, because the counts above are the only
    // evidence anybody looks at and one agent missing from them is the whole fault.
    r.flipFailures
      ? `${plural(r.flipFailures, "agent")} could not be flipped at all, so press this again in a minute`
      : null,
    r.attributeWriteFailures
      ? `${plural(r.attributeWriteFailures, "agent")} whose routing attributes could not be recorded, so press this again in a minute`
      : null,
  ];
}

/** The emails in `moved` that no flip line already names. */
function tagOnly(moved: string[], namedByFlip: string[]): string[] {
  const named = new Set(namedByFlip);
  return moved.filter((e) => !named.has(e));
}

function num(form: FormData, key: string, fallback: number): number {
  const v = form.get(key);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Create an event type (#1950).
 *
 * The defaults come from EVENT_TYPE_DEFAULTS rather than from a fallback
 * argument per field, so the number a blank box gets is the same number the box
 * showed as its placeholder and the same one the column declares.
 *
 * It REFUSES three things it used to accept quietly:
 *
 * A BLANK NAME. It used to fall back to "Consult", so an empty Title created a
 * record named after a word nobody typed. The name is what a lead reads on the
 * invite, so there is no safe value to invent (L67).
 *
 * A NAME AN EVENT TYPE ALREADY HAS. There is no unique index on
 * `(org_id, name)`, so nothing stopped a second "Senior Loan Advisor Call" with
 * different timings, and the form used to prefill the existing record's title,
 * which made pressing Add with nothing edited the way to produce one. The read
 * goes through `unwrap`: an unreadable table must refuse rather than resolve to
 * an empty list, because empty here means "no name is taken" and would let the
 * duplicate through exactly when the database is unwell (L105).
 *
 * A FAILED INSERT. The insert's error was neither bound nor read, so a rejected
 * write returned normally and the page redrew as though the event type existed.
 */
export async function createEventType(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  // #2385: these two are REFUSALS, so they come back to the form as sentences.
  // They used to throw, and a thrown message is replaced by Next in production,
  // so an admin who typed a title already in use met the generic error boundary
  // telling them to reload and check whether it had gone through. It had not,
  // and reloading changes nothing about the state they are stuck in (L111): they
  // retype the same title and meet the same screen.
  const name = String(form.get("name") ?? "").trim();
  if (!name) {
    redirect(
      `/admin/event-types${refusedQuery("An event type needs a title, which is the name a lead reads on the invite.")}`,
    );
  }

  const existing = unwrap(
    await db.from("event_types").select("name").eq("org_id", admin.org_id),
    "createEventType duplicate name check",
  ) as { name: string }[] | null;
  const taken = (existing ?? []).some(
    (e) => e.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    redirect(
      `/admin/event-types${refusedQuery(`An event type called ${name} already exists. Edit that one, or give this a different title.`)}`,
    );
  }

  // A blank gap takes the column default; anything typed must read the same way
  // the editor reads it.
  const gapRaw = String(form.get("gap_min") ?? "").trim();
  const gap = gapRaw === "" ? EVENT_TYPE_DEFAULTS.buffer_after_min : parseGapMin(gapRaw);
  if (gap === null) {
    redirect(`/admin/event-types${refusedQuery(GAP_REFUSAL)}`);
  }

  const { data: created, error } = await db
    .from("event_types")
    .insert({
      org_id: admin.org_id,
      name,
      description: String(form.get("description") ?? "").trim() || null,
      regal_type:
        String(form.get("regal_type") ?? "").trim() || EVENT_TYPE_DEFAULTS.regal_type,
      duration_min: num(form, "duration_min", EVENT_TYPE_DEFAULTS.duration_min),
      // One gap sets both buffers: Slate pads only the call being offered, so a
      // buffer on one side alone still lets two calls touch (see setEventTypeGap).
      buffer_before_min: gap,
      buffer_after_min: gap,
      min_notice_min: num(form, "min_notice_min", EVENT_TYPE_DEFAULTS.min_notice_min),
      daily_cap: form.get("daily_cap") ? num(form, "daily_cap", 0) : null,
      slot_interval_min: num(
        form,
        "slot_interval_min",
        EVENT_TYPE_DEFAULTS.slot_interval_min,
      ),
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`The event type could not be created: ${error.message}`);
  }
  const row = created as { id: string } | null;
  if (!row) {
    // throw-ok: a fault, not a refusal. An insert that reported no error and
    // returned no row is the database disagreeing with itself, and nothing the
    // admin retypes changes it, so the boundary saying the state is unknown is
    // the truthful screen and the detail belongs in the log.
    throw new Error("The event type could not be created: the database returned no row.");
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "event_type.created",
    details: {
      event_type_id: row.id,
      name,
      duration_min: num(form, "duration_min", EVENT_TYPE_DEFAULTS.duration_min),
      slot_interval_min: num(
        form,
        "slot_interval_min",
        EVENT_TYPE_DEFAULTS.slot_interval_min,
      ),
      min_notice_min: num(form, "min_notice_min", EVENT_TYPE_DEFAULTS.min_notice_min),
      buffer_before_min: gap,
      buffer_after_min: gap,
    },
  });

  // The form is on /admin/event-types, so that is the page whose list has to
  // redraw. The Overview keeps its refresh because it names event types too.
  revalidatePath("/admin/event-types");
  revalidatePath("/admin");
  // #2385: it says so, now that the page has somewhere to say it. The form sits
  // inside a disclosure that closes on the redirect, so "the new row is in the
  // list above" was a confirmation only for somebody already looking at the part
  // of the screen the press had just moved away from.
  redirect(`/admin/event-types${savedQuery("event-type-created")}`);
}

/**
 * Routing criteria from the editor's dynamic `crit_<key>` checkboxes. Any key
 * is allowed (no hardcoded list), so new attribute dimensions need no deploy;
 * the admin UI offers only keys/values that exist on agents (see catalog.ts).
 * Repeated `crit_<key>` values become an array (matchesCriteria intersects).
 */
function criteriaFromForm(form: FormData): Criteria {
  const out: Record<string, string[]> = {};
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("crit_") || typeof v !== "string") continue;
    const val = v.trim();
    if (!val) continue;
    (out[k.slice(5)] ??= []).push(val);
  }
  return out;
}

/**
 * Replace a bucket's manual members, atomically (#1930).
 *
 * It was a delete then an insert, as two statements, binding NEITHER error. So a
 * failed insert, or an isolate evicted between them, left the bucket with no
 * manual members while this returned normally and the page redrew as saved. A
 * routing pool with nobody in it turns every matching lead away.
 *
 * Through the migration 0114 function, which commits or rolls back as a whole,
 * exactly as `replaceUserSchedule` does since #1293. Ordering in application code
 * cannot close that window.
 *
 * Success is claimed on the COUNT the database reports, never on the absence of
 * an error, because a replace that landed a different number of members than
 * asked for is a silently wrong pool and this is the last place that can tell.
 * The count is compared against the DEDUPLICATED input, since the function
 * inserts `distinct` (the form can post one id twice when a membership is both
 * matched from the roster and carried over as an off roster id, #1762) and
 * comparing against the raw length would fail every such save.
 */
async function replaceBucketMembers(
  bucketId: string,
  memberIds: string[],
): Promise<void> {
  const expected = new Set(memberIds).size;
  const { data, error } = await supabaseAdmin().rpc("replace_bucket_members", {
    p_bucket_id: bucketId,
    p_user_ids: memberIds,
  });
  if (error) {
    throw new Error(`The bucket's members could not be saved: ${error.message}`);
  }
  const written = typeof data === "number" ? data : Number.NaN;
  if (written !== expected) {
    throw new Error(
      `The bucket's members could not be saved: expected ${expected}, the database recorded ` +
        `${Number.isFinite(written) ? written : "an unreadable count"}.`,
    );
  }
}

export async function createBucket(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const memberIds = form.getAll("members").map(String).filter(Boolean);

  const { data: bucket, error } = await supabaseAdmin()
    .from("buckets")
    .insert({
      org_id: admin.org_id,
      code: String(form.get("code") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      event_type_id: String(form.get("event_type_id") ?? ""),
      criteria: criteriaFromForm(form),
      routing_form_id: String(form.get("routing_form_id") ?? "").trim() || null,
      fallback_user_id: String(form.get("fallback_user_id") ?? "") || null,
    })
    .select("id")
    .single();

  // #1930: the insert's error was bound and then ignored, so a duplicate XBC
  // against the `(org_id, code)` unique index (the index the seeder upserts on)
  // was indistinguishable from a successful create. It refuses by NAME now, since
  // "that code already has a bucket" and "the database is unreachable" send a
  // person to different places (L11).
  // #2385: the duplicate code is a REFUSAL and comes back to the form; the rest
  // is a fault and still throws. #1930 wrote both sentences and delivered
  // neither, because a thrown message is replaced in production, so an admin
  // typing an XBC that already had a bucket read "something went wrong, reload
  // and check whether it went through", found no bucket, and typed the same code
  // again, indefinitely.
  if (error) {
    if (error.code === "23505") {
      redirect(
        `/admin/buckets${refusedQuery(`A bucket with code ${String(form.get("code") ?? "").trim()} already exists.`)}`,
      );
    }
    throw new Error(`The bucket could not be created: ${error.message}`);
  }
  const created = bucket as { id: string } | null;
  if (!created) {
    // throw-ok: a fault, not a refusal. An insert reporting no error and
    // returning no row is the database disagreeing with itself; no code the
    // admin types changes it, so the boundary saying the state is unknown is
    // the honest screen.
    throw new Error("The bucket could not be created: the database returned no row.");
  }
  if (memberIds.length) {
    await replaceBucketMembers(created.id, memberIds);
  }
  // #1932: editing where leads get SENT was the one privileged action absent from
  // the trail. Recorded AFTER the writes, so it reflects what actually happened.
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "bucket.created",
    details: {
      bucket_id: created.id,
      code: String(form.get("code") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      members_added: [...new Set(memberIds)],
    },
  });
  revalidatePath("/admin/buckets");
  // #1990: this page already confirms one of its forms, so silence after this
  // one reads as a failure rather than as a feature nobody built. Named, because
  // the page holds three forms and an unnamed flag lit whichever sentence the
  // page had written down.
  redirect(`/admin/buckets${savedQuery("bucket-created")}`);
}

export async function updateBucket(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(form.get("bucket_id") ?? "");
  if (!id) return;
  const db = supabaseAdmin();

  // #1932: the state BEFORE the write, so the trail can answer the question an
  // audit exists to answer, which is what the configuration was at a given
  // moment. An entry naming only the bucket can never answer it (L529). Read
  // through `unwrap`, because merging over a failed read would record the change
  // as though nothing had been there.
  const before = unwrap(
    await db
      .from("buckets")
      .select("code, name, event_type_id, criteria, routing_form_id, fallback_user_id")
      .eq("id", id)
      .maybeSingle(),
    "bucket before update",
  ) as Record<string, unknown> | null;
  const membersBefore = (
    unwrap(
      await db.from("bucket_members").select("user_id").eq("bucket_id", id),
      "bucket members before update",
    ) ?? []
  ).map((m) => (m as { user_id: string }).user_id);

  // #1935: THE SEEDER OWNS THREE OF THESE, so they are taken from the stored row
  // and whatever the form posted is ignored.
  //
  // `scripts/seed-buckets.ts` rewrites `code`, `name` and `criteria` from
  // `src/lib/xbc.ts` on every run, which is what the seeder is for. Accepting an
  // edit to them wrote a value the next seed run replaced, which is the #1874
  // defect: an override that is silently undone is worse than none.
  //
  // The refusal is HERE rather than in the form's markup, because markup is a
  // request and this is the thing that writes. A hidden input, a stale tab, a
  // curl, or the next person restoring the field because it looked like an
  // oversight all reach this line, and all of them now leave the seeder's
  // columns alone. The form is read only too, but only so a field nobody can
  // change does not look like one.
  //
  // A read that failed has already thrown above, so `before` is null only when
  // the bucket is genuinely gone, and the update below then matches no row.
  // #2006: SCOPED TO THE CODES THE SEEDER ACTUALLY WRITES, not to "this bucket
  // exists". #1935 used the broader condition, which froze the hand created
  // buckets too: the seeder writes only `allXbcCodes()`, so nothing was ever
  // going to overwrite one of those, and the create form is the only place those
  // fields can be set, so a typo made once was permanent (L615).
  const seederOwned = seederOwnsCode(String(before?.code ?? ""));
  const after = {
    code: seederOwned ? String(before?.code ?? "") : String(form.get("code") ?? "").trim(),
    name: seederOwned ? String(before?.name ?? "") : String(form.get("name") ?? "").trim(),
    criteria: (seederOwned ? (before?.criteria ?? {}) : criteriaFromForm(form)) as Criteria,
    event_type_id: String(form.get("event_type_id") ?? ""),
    routing_form_id: String(form.get("routing_form_id") ?? "").trim() || null,
    fallback_user_id: String(form.get("fallback_user_id") ?? "") || null,
  };

  // #1930: the error was discarded, so a refused update still ran the membership
  // replace and redrew as saved. It throws now, and it throws BEFORE the members
  // are touched, so a refused bucket edit cannot half apply.
  const { error } = await db.from("buckets").update(after).eq("id", id);
  // #2385: as in `createBucket` directly above. The duplicate code is the
  // reader's to fix and comes back to the form; a refused write is not and
  // throws. Both still happen BEFORE the members are touched, so a refused
  // bucket edit cannot half apply.
  if (error) {
    if (error.code === "23505") {
      redirect(`/admin/buckets${refusedQuery(`A bucket with code ${after.code} already exists.`)}`);
    }
    throw new Error(`The bucket could not be saved: ${error.message}`);
  }

  const memberIds = form.getAll("members").map(String).filter(Boolean);
  await replaceBucketMembers(id, memberIds);

  const membersAfter = [...new Set(memberIds)];
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "bucket.updated",
    details: {
      bucket_id: id,
      code: after.code,
      // Only what CHANGED, with both values, so a reader is not left comparing
      // two full objects to find the one field that moved.
      changed: Object.fromEntries(
        Object.entries(after).filter(([k, v]) =>
          JSON.stringify(before?.[k] ?? null) !== JSON.stringify(v ?? null),
        ).map(([k, v]) => [k, { from: before?.[k] ?? null, to: v }]),
      ),
      members_added: membersAfter.filter((m) => !membersBefore.includes(m)),
      members_removed: membersBefore.filter((m) => !membersAfter.includes(m)),
    },
  });
  revalidatePath("/admin/buckets");
  // #1990: as above, and said differently, because creating a pool and editing
  // one are different events and the confirmation is worth reading.
  redirect(`/admin/buckets${savedQuery("bucket-updated")}`);
}

export async function setWorkingHours(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  const actor = await requireManageAgent(userId);
  // #1989: a form that sent no zone used to save the week in Eastern and report
  // success, which is how a stored default came to read as a choice (#1739).
  const timezone = submittedTimezone(form);
  if (!timezone) redirect(`/admin/agents/${userId}${refusedQuery(MISSING_TIMEZONE_HOURS)}`);

  // One schedule per user (enforced by the availability_schedules(user_id)
  // unique index, #532): replaceUserSchedule upserts it, then replaces its rules.
  // #1994: as on the agent's own page above, a refusal comes back as a message
  // the person can act on rather than as the generic error boundary.
  const plan = planScheduleReplacement(perDayFrom(form), timezone);
  if (!plan.ok) {
    redirect(`/admin/agents/${userId}${refusedQuery(plan.error)}`);
  }
  const loaded = loadedScheduleVersion(form, `/admin/agents/${userId}`);
  const before = await readScheduleForAudit(userId);
  if ((await replaceUserSchedule(userId, "admin", plan, loaded)) === "changed") {
    redirect(`/admin/agents/${userId}${refusedQuery(CHANGED_SINCE_OPENED)}`);
  }
  await auditScheduleSave(actor, userId, "agent.hours", before, plan);
  // #1769: the form that calls this lives on the agent's own page, so that is the
  // route that has to be refreshed. Revalidating only /admin left the page the
  // person is looking at showing what it showed before they pressed the button.
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
  // #1988: and the same reasoning decides where the confirmation lands. The
  // route is NAMED from the subject rather than assumed, because this form and
  // the one on /me post from different pages into actions that look alike.
  redirect(`/admin/agents/${userId}${savedQuery("working-hours")}`);
}

/**
 * The names Slack gives for the channels STORED on /admin/alerts, by id (#2438).
 *
 * The same set the page hands the channel fields, so a name the field accepts is
 * one this save accepts (L99). A failed read is NO names, never a guess: the
 * typed name then stays unmatched and the save refuses it, which is the safe side,
 * since the alternative is storing a name nothing has resolved.
 */
async function storedChannelNames(): Promise<Record<string, string>> {
  const { data, error } = await supabaseAdmin()
    .from("monitor_alert_config")
    .select("alerts_channel, info_channel, handoff_channel")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    log.warn("admin-actions", { msg: "stored channels could not be read to resolve a typed name" }, error);
    return {};
  }
  const row = (data ?? {}) as Partial<Record<"alerts_channel" | "info_channel" | "handoff_channel", string | null>>;
  const ids = [row.alerts_channel, row.info_channel, row.handoff_channel].filter((c): c is string => !!c);
  if (ids.length === 0) return {};
  return channelNames(await checkChannels(ids), ids);
}

/**
 * Saves the UI-tunable monitor alert settings (#571). Blank fields revert to
 * fallback (explicit null, never 0); out-of-range values are refused. Each row is
 * written as one complete object so clearing one field can't wipe a sibling.
 */
export async function setMonitorSettings(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const cooldownMin = Object.fromEntries(
    MONITOR_ALERT_KEYS.map((k) => [k, String(form.get(`cooldown_${k}`) ?? "")]),
  ) as Record<MonitorAlertKey, string>;

  const parsed = parseMonitorSettingsForm({
    cooldownMin,
    floor30: String(form.get("floor_30") ?? ""),
    floor120: String(form.get("floor_120") ?? ""),
    alertsChannel: String(form.get("alerts_channel") ?? ""),
    infoChannel: String(form.get("info_channel") ?? ""),
    handoffChannel: String(form.get("handoff_channel") ?? ""),
    lowVolumeArmed: String(form.get("low_volume_armed") ?? ""),
    failureRateArmed: String(form.get("failure_rate_armed") ?? ""),
    availabilityDriftArmed: String(form.get("availability_drift_armed") ?? ""),
    awaitingActivationArmed: String(form.get("awaiting_activation_armed") ?? ""),
    belowLeadTierArmed: String(form.get("below_lead_tier_armed") ?? ""),
    regalCallsArmed: String(form.get("regal_calls_armed") ?? ""),
    ownerReassignNoticeOn: String(form.get("owner_reassign_notice_on") ?? ""),
    rosterCoverageArmed: String(form.get("roster_coverage_armed") ?? ""),
    tierRecoveryMinTimes: String(form.get("empty_tier_recovery_min_times") ?? ""),
    tierRecoveryHoldMin: String(form.get("empty_tier_recovery_hold_min") ?? ""),
    poolNearlyFullOpenPct: String(form.get("pool_nearly_full_open_pct") ?? ""),
  });

  if (parsed.errors.length) {
    redirect(`/admin/alerts${refusedQuery(parsed.errors.join(" "))}`);
  }

  const channelFields = [
    ["Alerts channel", "alerts_channel"],
    ["Info channel", "info_channel"],
    // #2367: checked the same way. A handoff channel that does not exist sends every
    // handoff nowhere, and the lane's own page about it only fires half an hour later.
    ["Handoff channel", "handoff_channel"],
  ] as const;

  // #2438: A NAME BECOMES ITS ID, before anything is checked or stored.
  //
  // The picker submits the id of a channel picked from its list, but a name typed
  // and saved without picking still arrives as a name, and a name sent to
  // `conversations.info` came back "Slack has no channel <name>": true, and naming
  // the wrong mistake. So a value that is not an id is looked up in the same list
  // the picker shows, and one matching nothing is refused with what was wrong with
  // it and where an id is found. The rule is `resolveChannelInput`, which the
  // picker also runs, so the field never accepts what this refuses (L99).
  //
  // The list is read only when some field holds a name: an id needs no list, and a
  // save of three ids costs no extra call to Slack.
  const needsChannelList = channelFields.some(([, key]) => {
    const v = parsed.config[key];
    return v !== null && !looksLikeChannelId(v);
  });
  const channelList = needsChannelList ? await listSlackChannels() : null;
  // A private channel is never in that list, but one already STORED was named by
  // Slack when asked about its id, and the field displays that name, so typing it
  // back must save (#2438 review). Asked only when a name misses the list.
  let storedNames: Record<string, string> | null = null;
  for (const [label, key] of channelFields) {
    const typed = parsed.config[key];
    if (typed === null) continue;
    let resolved = resolveChannelInput(typed, channelList);
    if (!resolved.ok) {
      storedNames ??= await storedChannelNames();
      resolved = resolveChannelInput(typed, channelList, storedNames);
    }
    if (!resolved.ok) {
      redirect(`/admin/alerts${refusedQuery(`${label}: ${channelInputMessage(resolved)}`)}`);
    }
    parsed.config[key] = resolved.value;
  }

  // #1957: CHECK A CHANNEL BEFORE STORING IT.
  //
  // The field accepted any string, and a typo sent every alert nowhere. The send
  // path is not the problem: a failed post is already logged with its Slack
  // error and stamps only a short retry window (#1035). The residual is that the
  // only signal is a log line, and that is correct, because the paging channel
  // cannot page about itself. So a wrong id degrades ALL alerting to log only
  // and nothing can alert about it by construction.
  //
  // Save time is the one place this can be caught, because it is the only moment
  // somebody is looking at the screen.
  //
  // An UNVERIFIABLE answer is refused neither way. `conversations.info` needs a
  // scope the Slate app may not carry yet, and scoring that as good ships the
  // typo while scoring it as bad refuses a correct channel. It saves, and the
  // PANEL says it could not check, on every render rather than once in a notice
  // that clears: being unable to check is a standing condition of the Slack app,
  // not an event that happened during this save (L126).
  for (const [label, key] of channelFields) {
    const channel = parsed.config[key];
    // A blank field is not a channel to check: it MEANS fall back to the env or
    // to the alerts channel, and `parseMonitorSettingsForm` already turned it
    // into null. Asking Slack about "" would refuse every save that clears one.
    if (!channel) continue;
    const check = readChannelReply(await fetchSlackChannel(channel));
    if (refusesSave(check)) {
      redirect(
        `/admin/alerts${refusedQuery(`${label}: ${channelCheckMessage(check, channel)}`)}`,
      );
    }
  }

  const db = supabaseAdmin();
  const now = new Date().toISOString();
  // #2379: both writes are checked, and each refuses BEFORE the audit entry, the
  // channel cache clear and the saved notice. The cooldowns land first, so a
  // refusal on the config leaves them written: that is stated rather than hidden,
  // because the alternative (one transaction) is a migration this save does not
  // need, and a half applied save that SAYS so is recoverable by pressing save
  // again, while a silent one is not.
  const { error: cooldownError } = await db.from("monitor_settings").upsert(
    parsed.cooldowns.map((c) => ({
      key: c.key,
      cooldown_min: c.cooldown_min,
      updated_at: now,
      updated_by: admin.id,
    })),
    { onConflict: "key" },
  );
  if (cooldownError) {
    redirect(
      `/admin/alerts${refusedQuery(writeRefused("The alert cooldowns", cooldownError))}`,
    );
  }
  const { error: configError } = await db
    .from("monitor_alert_config")
    .upsert({ id: 1, ...parsed.config, updated_at: now, updated_by: admin.id }, { onConflict: "id" });
  if (configError) {
    redirect(
      `/admin/alerts${refusedQuery(
        writeRefused("The alert settings", configError),
      )}`,
    );
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "monitor.settings",
    details: { cooldowns: parsed.cooldowns, config: parsed.config },
  });
  // Channels are cached in-process; clear so the new destination takes effect now.
  clearChannelCache();
  revalidatePath("/admin/alerts");
  redirect(`/admin/alerts${savedQuery("alerts")}`);
}

/**
 * Declare, change or clear the day the booking ramp ended (#2739). Admin only, the
 * same gate as the rest of /admin/alerts.
 *
 * Its own action rather than a field on the settings form, because it is the one
 * setting on that page whose effect arrives WEEKS later with nobody watching: from
 * this date the monitor lane refits the low volume floors from Slate's own bookings.
 * So the page confirms it with that consequence named, and a save of the cooldowns
 * can never touch it.
 *
 * Refused before the audit entry and the saved notice (#2379). The audit entry
 * carries the date before and after, because "what did the alarm judge against on a
 * given day" is answered from the trail (L529).
 */
export async function setVolumeRampEnd(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = parseRampEndForm({
    intent: String(form.get("intent") ?? ""),
    rampEnd: String(form.get("ramp_end") ?? ""),
  });
  if (!parsed.ok) redirect(`/admin/alerts${refusedFromQuery(parsed.error, RAMP_END_FORM)}#volume-learning`);

  const db = supabaseAdmin();
  const before = unwrap(
    await db.from("monitor_alert_config").select("volume_ramp_end_on").eq("id", 1).maybeSingle(),
    "volume ramp end before",
  ) as { volume_ramp_end_on: string | null } | null;
  const from = before?.volume_ramp_end_on ?? null;

  // Clearing also drops the stored refit, so declaring the same date again later
  // starts from a fresh refit rather than bringing back floors fitted weeks ago.
  const { error } = await db.from("monitor_alert_config").upsert(
    {
      id: 1,
      volume_ramp_end_on: parsed.rampEndOn,
      ...(parsed.rampEndOn === null ? { volume_learning: null } : {}),
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );
  if (error) {
    redirect(`/admin/alerts${refusedFromQuery(writeRefused("The ramp end", error), RAMP_END_FORM)}#volume-learning`);
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "monitor.volume_ramp_end",
    details: { from, to: parsed.rampEndOn },
  });
  revalidatePath("/admin/alerts");
  redirect(
    `/admin/alerts${savedQuery(parsed.rampEndOn === null ? "volume-ramp-end-cleared" : "volume-ramp-end-set")}#volume-learning`,
  );
}

/**
 * Retire cal.com, or put it back (#2875). Admin only, the same gate as the rest of
 * /admin/alerts.
 *
 * One stored switch, `monitor_alert_config.calcom_retired`, read by every cal.com
 * lane (src/lib/calcom/retirement.ts), so cutover needs no code change. It writes
 * that one column on id=1 and nothing else, so a save here cannot touch a cooldown,
 * a channel or an arming switch on the same row, and a save of the settings form
 * can never touch it (that form's upsert does not name it).
 *
 * The form posts the STATE it wants rather than toggling, like the kill switch, and
 * anything that is not an explicit "true" means live: a stray submit must never
 * retire cal.com, because that stops the time off dual write while cal.com may still
 * be taking every lead.
 *
 * Refused before the audit entry and the saved notice (#2379). The audit entry
 * carries the value before and after (L529), and the before value is null when it
 * could not be read rather than a guess.
 *
 * Putting it back (#2890) also reports what the override sweep will now bring into
 * line in cal.com: approved time off to copy in, and blocks for cancelled or changed
 * time off to take out (`src/lib/calcom/put-back.ts`).
 */
export async function setCalcomRetired(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const retired = String(form.get("retired") ?? "") === "true";
  const before = await loadCalcomRetired();

  const { error } = await supabaseAdmin().from("monitor_alert_config").upsert(
    { id: 1, calcom_retired: retired, updated_at: new Date().toISOString(), updated_by: admin.id },
    { onConflict: "id" },
  );
  if (error) {
    redirect(
      `/admin/alerts${refusedFromQuery(
        writeRefused(retired ? "The change to retire cal.com" : "The change to put cal.com back", error),
        CALCOM_RETIREMENT_FORM,
      )}#calcom-retirement`,
    );
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "monitor.calcom_retired",
    details: { from: before, to: retired },
  });
  // The lanes read the switch through a per isolate cache; drop this isolate's copy
  // so a lane sharing it acts on the change now rather than a TTL later.
  __resetCalcomRetiredCache();
  revalidatePath("/admin/alerts");
  if (retired) redirect(`/admin/alerts${savedQuery("calcom-retired")}#calcom-retirement`);
  // #2890: putting cal.com back says what the override sweep will now bring into
  // line: time off approved during retirement to copy into cal.com, and blocks for
  // time off cancelled or changed during retirement to take out. Nothing is queued
  // here: the recorded "skipped: cal.com retired" outcome and the
  // calcom_override_removals rows are what the live sweep works through, so a second
  // press does nothing twice. An unreadable count travels as unknown, never as 0.
  const counts = await loadPutBackCounts(supabaseAdmin(), Date.now());
  redirect(`/admin/alerts${savedQuery("calcom-live")}${putBackQuery(counts)}#calcom-retirement`);
}

/**
 * Save the direct-booking default bucket (#1016, phase 2 of #541). Admin-only.
 * The selection is validated against the current non-test bucket codes so we
 * never persist a code that points at no bucket; blank clears the default. The
 * write is a single keyed upsert on id=1 (assume-it-runs-twice: idempotent,
 * last-writer-wins).
 */
export async function setDefaultBucket(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  // The valid set = current non-test bucket codes (a test bucket must never be
  // the public default). Roster-bounded (~60 buckets), so a single page holds all.
  // #1629: an empty valid set makes EVERY code invalid, so a failed read told the
  // admin their real bucket code does not exist. That is fail-closed, but with a
  // false reason, which sends them hunting for a typo that is not there (L11).
  const buckets = unwrap(
    await db.from("buckets").select("code, is_test").eq("is_test", false),
    "default bucket valid codes",
  );
  const validCodes = new Set(((buckets ?? []) as { code: string }[]).map((b) => b.code));

  const parsed = parseDefaultBucketForm(String(form.get("default_bucket_code") ?? ""), validCodes);
  if (parsed.errors.length) {
    redirect(`/admin/buckets${refusedQuery(parsed.errors.join(" "))}`);
  }

  // #2379: refused before the audit entry and the saved notice. A default bucket
  // the write never landed is the one that routes every direct booking, so a
  // confirmation nobody can act on sends leads to the previous pool.
  const { error } = await db.from("booking_settings").upsert(
    {
      id: 1,
      default_bucket_code: parsed.default_bucket_code,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );
  if (error) {
    redirect(
      `/admin/buckets${refusedQuery(writeRefused("The default bucket", error))}`,
    );
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { default_bucket_code: parsed.default_bucket_code },
  });
  revalidatePath("/admin/buckets");
  redirect(`/admin/buckets${savedQuery("bucket-routing")}`);
}

/**
 * Save the Days offered card (#3922): how many open days every lead is offered, and
 * how many extra days the last resort may add. Admin only. One button saves both
 * (D9 in docs/design/days-offered.html).
 *
 * `parseDaysOfferedForm` holds the rules (offered 1 to 7, extra 0 or more, the two
 * together at most 7) and a refusal redirects with its reason and NEVER writes. The
 * reach is stored as `horizon_days` = offered + extra, so every existing reader of
 * the horizon (the availability compute, the slot cache, the supply page, the
 * monitor) keeps working unchanged, and `offered_open_days` beside it (migration
 * 0190). The write is a column scoped upsert on id=1, so it cannot clobber the
 * other settings on that row, and it is idempotent (assume it runs twice).
 *
 * On a successful save every precomputed row is marked stale so the recompute lane
 * rebuilds rows over the new reach promptly (refresh on save, #216); a failure
 * there only logs, because the freshness window still backstops convergence. The
 * offered days need no refresh: the booker cuts its strip at read time, through a
 * cached read that picks the new value up within seconds.
 */
export async function setDaysOffered(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const parsed = parseDaysOfferedForm(
    String(form.get("offered_open_days") ?? ""),
    String(form.get("last_resort_extra_days") ?? ""),
  );
  const { offered_open_days, horizon_days } = parsed;
  if (parsed.errors.length || offered_open_days === null || horizon_days === null) {
    redirect(`/admin/business-hours${refusedQuery(parsed.errors.join(" "))}`);
  }

  // #2379: refused before anything downstream acts on values that were never
  // stored. The invalidation below is the sharpest of those: it marks every cached
  // slot row stale, so a refused save would spend a whole recompute cycle
  // rebuilding 60 rows over a window that did not change.
  const { error } = await db.from("booking_settings").upsert(
    {
      id: 1,
      offered_open_days,
      horizon_days,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );
  if (error) {
    redirect(`/admin/business-hours${refusedQuery(writeRefused(DAYS_OFFERED, error))}`);
  }

  // Refresh-on-save: converge rows onto the new reach now, not only as they age.
  try {
    await markAllBucketSlotsStale();
  } catch (err) {
    log.error("admin", { msg: "days offered save: row invalidation failed" }, err);
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: {
      offered_open_days: parsed.offered_open_days,
      last_resort_extra_days: parsed.extra_days,
      horizon_days: parsed.horizon_days,
    },
  });
  revalidatePath("/admin/business-hours");
  redirect(`/admin/business-hours${savedQuery("days-offered")}`);
}

/**
 * Save the nearly full line on Team capacity (#3936, D9 in docs/design/team-capacity.html):
 * the percent of a day's capacity at which the page flags the day. Admin only; a manager
 * reads the line and never sees Change.
 *
 * A value outside 1 to 99 is refused with its reason and never written. The write is a
 * column scoped upsert on id=1, so it cannot clobber the other settings on that row, and
 * it is idempotent (assume it runs twice). Refused before the audit entry, the cache
 * invalidation and the saved notice, so none of them claims a value that was not stored.
 */
export async function setNearlyFullPct(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = parseNearlyFullPct(String(form.get("capacity_nearly_full_pct") ?? ""));
  if ("error" in parsed) {
    redirect(`/admin/team-capacity${refusedQuery(parsed.error)}`);
  }
  // The line it replaces, so the trail says what it was as well as what it became (L529). A read
  // that fails does not stop the save; the entry says the old value could not be read.
  const before = await readNearlyFullPct();
  const { error } = await supabaseAdmin().from("booking_settings").upsert(
    {
      id: 1,
      capacity_nearly_full_pct: parsed.pct,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );
  if (error) {
    redirect(`/admin/team-capacity${refusedQuery(writeRefused("The nearly full line", error))}`);
  }
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { from: { capacity_nearly_full_pct: before ?? "unreadable" }, to: { capacity_nearly_full_pct: parsed.pct } },
  });
  revalidatePath("/admin/team-capacity");
  redirect(`/admin/team-capacity${savedQuery("nearly-full")}`);
}

/** The longest gap an admin may keep between calls, in minutes. Two hours is
 *  already more than the call itself several times over; anything larger is a
 *  typo that would close the booker for the day. */
const MAX_GAP_MIN = 120;

/** The one reading of a gap box, shared by the add form and the editor so the
 *  same field cannot carry two contracts. Null for anything that is not a whole
 *  number of minutes inside the bound; never NaN, which compares false and would
 *  slip past a range check (L50). */
function parseGapMin(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_GAP_MIN ? n : null;
}

const GAP_REFUSAL = `The gap between calls has to be a whole number of minutes from 0 to ${MAX_GAP_MIN}.`;

/**
 * The one save every event type editor makes, and the refusals that can come back
 * from it, each sent to the page the form is on (#3122).
 *
 * Returns only when the write landed. A database error, a field being saved that
 * somebody else changed after the page was opened (judged by that field's value
 * as the form loaded it, never by the row's `updated_at`, which a save of any
 * other field moves: #3798), and an id that matched nothing this org owns each
 * redirect with their own sentence, because they send the person to do three
 * different things. Zero rows is never a success: saying otherwise would be a lie
 * about somebody else's data as much as about theirs.
 */
async function saveEventTypeOrRefuse<K extends EventTypeField>(opts: {
  page: string;
  orgId: string;
  eventTypeId: string;
  patch: Required<Pick<EventTypePatch, K>>;
  loaded: NoInfer<Record<K, LoadedFieldValue>>;
  /** What the person was saving, for the failure sentence and the log. */
  what: string;
}): Promise<void> {
  const saved = await updateEventType<K>({
    eventTypeId: opts.eventTypeId,
    orgId: opts.orgId,
    patch: opts.patch,
    loaded: opts.loaded,
  });
  if (saved.error) {
    log.error("admin", { msg: "event type save failed", what: opts.what, event_type_id: opts.eventTypeId }, saved.error);
    redirect(`${opts.page}${refusedQuery(`Could not save the ${opts.what}. Please try again.`)}`);
  }
  if (saved.changed) redirect(`${opts.page}${refusedQuery(CHANGED_SINCE_OPENED)}`);
  if (saved.count === 0) redirect(`${opts.page}${refusedQuery("That event type was not found.")}`);
}

/**
 * Set the gap kept between two calls on one advisor.
 *
 * BC, 2026-10-02: cal.com kept 10 minutes between calls as a cap on capacity, and
 * the move to Slate dropped it. One number sets BOTH buffers, because Slate pads
 * only the call being offered: with a buffer after alone, a new call could still
 * start the minute an earlier one ends. Before and after together guarantee the
 * gap on both sides of every call.
 *
 * A plain UPDATE of two columns, so it is idempotent under a retry or a double
 * submit. It goes through `updateEventType`, which refreshes the cached slots the
 * booker serves, since the buffer rides inside that payload.
 */
export async function setEventTypeGap(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const page = "/admin/event-types";

  const eventTypeId = String(form.get("event_type_id") ?? "").trim();
  if (!eventTypeId) {
    redirect(`${page}${refusedQuery("No event type was named.")}`);
  }
  const gap = parseGapMin(String(form.get("gap_min") ?? "").trim());
  if (gap === null) {
    redirect(`${page}${refusedQuery(GAP_REFUSAL)}`);
  }
  const loaded = loadedFieldsFrom(form, ["buffer_before_min", "buffer_after_min"] as const);
  if (loaded === null) redirect(`${page}${refusedQuery(PAGE_OUT_OF_DATE)}`);

  // The current value, so the trail records what it was as well as what it became.
  const before = unwrap(
    await supabaseAdmin()
      .from("event_types")
      .select("buffer_before_min, buffer_after_min")
      .eq("id", eventTypeId)
      .eq("org_id", admin.org_id)
      .maybeSingle(),
    "setEventTypeGap current gap",
  ) as { buffer_before_min: number; buffer_after_min: number } | null;
  if (!before) {
    redirect(`${page}${refusedQuery("That event type was not found.")}`);
  }

  const patch = { buffer_before_min: gap, buffer_after_min: gap };
  await saveEventTypeOrRefuse({
    page,
    orgId: admin.org_id,
    eventTypeId,
    patch,
    loaded,
    what: "gap between calls",
  });

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "event_type.gap",
    details: {
      event_type_id: eventTypeId,
      from: { buffer_before_min: before.buffer_before_min, buffer_after_min: before.buffer_after_min },
      to: patch,
    },
  });
  revalidatePath(page);
  redirect(`${page}${savedQuery("event-type-gap")}`);
}

/** The longest notice an admin may ask of a lead, in minutes: one day. Anything
 *  longer is a typo that would empty the booker for a whole day. */
const MAX_NOTICE_MIN = 1440;

/** Null for anything that is not a whole number of minutes inside the bound;
 *  never NaN, which compares false and would slip past a range check (L50). */
function parseNoticeMin(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_NOTICE_MIN ? n : null;
}

const NOTICE_REFUSAL = `The notice has to be a whole number of minutes from 0 to ${MAX_NOTICE_MIN}.`;

/**
 * Set how far ahead of now the earliest offered time can be (#3003).
 *
 * It could only be chosen when an event type was created, so the live call type
 * kept a 2 hour notice nobody could change from the screen while cal.com let a
 * lead book a few minutes out. Dan, 2026-10-02: a lead at 11am should be able to
 * book anything from 11:05.
 *
 * A plain UPDATE of one column, so it is idempotent under a retry or a double
 * submit. It goes through `updateEventType`, which refreshes the cached slots,
 * because those were computed under the old notice: a shorter one offers nothing
 * new near now until they rebuild.
 */
export async function setEventTypeNotice(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const page = "/admin/event-types";

  const eventTypeId = String(form.get("event_type_id") ?? "").trim();
  if (!eventTypeId) {
    redirect(`${page}${refusedQuery("No event type was named.")}`);
  }
  const notice = parseNoticeMin(String(form.get("min_notice_min") ?? "").trim());
  if (notice === null) {
    redirect(`${page}${refusedQuery(NOTICE_REFUSAL)}`);
  }
  const loaded = loadedFieldsFrom(form, ["min_notice_min"] as const);
  if (loaded === null) redirect(`${page}${refusedQuery(PAGE_OUT_OF_DATE)}`);

  // The current value, so the trail records what it was as well as what it became.
  const before = unwrap(
    await supabaseAdmin()
      .from("event_types")
      .select("min_notice_min")
      .eq("id", eventTypeId)
      .eq("org_id", admin.org_id)
      .maybeSingle(),
    "setEventTypeNotice current notice",
  ) as { min_notice_min: number } | null;
  if (!before) {
    redirect(`${page}${refusedQuery("That event type was not found.")}`);
  }

  const patch = { min_notice_min: notice };
  await saveEventTypeOrRefuse({ page, orgId: admin.org_id, eventTypeId, patch, loaded, what: "notice" });

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "event_type.notice",
    details: {
      event_type_id: eventTypeId,
      from: { min_notice_min: before.min_notice_min },
      to: patch,
    },
  });
  revalidatePath(page);
  redirect(`${page}${savedQuery("event-type-notice")}`);
}

/**
 * Save the description a lead reads before booking (#1335).
 *
 * Admin only, guarding independently of the page gate. It was previously settable
 * only when an event type was CREATED, so changing the one that already exists
 * needed an engineer, and Dan's rewrite on 2026-08-07 should be the last time that
 * is true. The second half of that copy is a real instruction that changes how the
 * call goes, and it will want tuning once advisors report back.
 *
 * Keyed on the event type id from the form, so an org with more than one is not
 * quietly editing whichever happened to be first.
 *
 * The write is a plain UPDATE on one column, so it is idempotent under a retry or
 * a double submit (assume it runs twice). Its result is CHECKED rather than
 * discarded: a failed save that redirected to a cheerful "Saved" would leave the
 * old copy in front of every lead while telling the author it had changed, which is
 * the exact shape of a success claimed over a write that never committed (L12).
 */
export async function setEventDescription(form: FormData): Promise<void> {
  const admin = await requireAdmin();

  const eventTypeId = String(form.get("event_type_id") ?? "").trim();
  if (!eventTypeId) {
    redirect(`/admin/booker-copy${refusedQuery("No event type was named.")}`);
  }

  const parsed = parseEventDescriptionForm(String(form.get("description") ?? ""));
  if (parsed.errors.length) {
    redirect(`/admin/booker-copy${refusedQuery(parsed.errors.join(" "))}`);
  }
  const loaded = loadedFieldsFrom(form, ["description"] as const);
  if (loaded === null) redirect(`/admin/booker-copy${refusedQuery(PAGE_OUT_OF_DATE)}`);

  // #1435: one helper owns the write AND the refresh of what the booker serves,
  // because the description rides inside the cached slots payload and editing the
  // row is not the same as serving it. Nothing else in src/ may write this table
  // (scripts/test-event-type-writes.ts), so the next editor added here cannot ship
  // the stale-copy defect by forgetting a step.
  await saveEventTypeOrRefuse({
    page: "/admin/booker-copy",
    orgId: admin.org_id,
    eventTypeId,
    patch: { description: parsed.description },
    loaded,
    what: "description",
  });

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { event_type_id: eventTypeId, description_chars: parsed.description?.length ?? 0 },
  });
  revalidatePath("/admin/booker-copy");
  redirect(`/admin/booker-copy${savedQuery("booker-copy")}`);
}

/**
 * Save the reschedule/cancel/reassign reason options (#346). Admin-only (guards
 * independently of the page gate). The editor posts the COMPLETE ordered set as a
 * JSON `payload`; parseReasonOptionsForm derives codes for new rows, forces locked
 * rows active, and re-injects any missing locked code. The write is a single keyed
 * upsert on (action, code), never a diff and never retire-by-absence, so it is
 * idempotent under retries and last-writer-wins per row (assume-it-runs-twice).
 */
export async function setReasonOptions(form: FormData): Promise<void> {
  const admin = await requireAdmin();

  let raw: unknown = {};
  try {
    raw = JSON.parse(String(form.get("payload") ?? "{}"));
  } catch {
    redirect(`/admin/booking-reasons${refusedQuery("Could not read the submitted form.")}`);
  }

  const { rows, errors } = parseReasonOptionsForm(coerceReasonOptionsForm(raw));
  if (errors.length) {
    redirect(`/admin/booking-reasons${refusedQuery([...new Set(errors)].join(" "))}`);
  }

  const now = new Date().toISOString();
  // #2379: refused before the audit entry and the saved notice. The editor posts
  // the COMPLETE set, so a refused save means the page is about to redraw the
  // stored options, which are the ones the admin just edited away from.
  const { error } = await supabaseAdmin()
    .from("reason_options")
    .upsert(
      rows.map((r) => ({ ...r, updated_at: now, updated_by: admin.id })),
      { onConflict: "action,code" },
    );
  if (error) {
    redirect(
      `/admin/booking-reasons${refusedQuery(
        writeRefused("The booking reasons", error),
      )}`,
    );
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "reason.options",
    details: { rows: rows.map((r) => ({ action: r.action, code: r.code, active: r.active })) },
  });
  revalidatePath("/admin/booking-reasons");
  redirect(`/admin/booking-reasons${savedQuery("booking-reasons")}`);
}

export async function setOrgDefaultHours(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => form.get(`dday_${d}`));
  // #1671: validated before it is stored, because this value is what an agent
  // with no zone of their own ADOPTS, so an unreadable one here makes every new
  // agent bookable at no time at all. `planUniformSchedule` is the same validator
  // the per-agent writes use, so the two can never disagree about what a
  // storable week is.
  const defaultTimezone = String(form.get("default_timezone") ?? "America/New_York");
  const defaults = planUniformSchedule(
    weekdays.length ? weekdays : [1, 2, 3, 4, 5],
    readableMinutes(String(form.get("default_start") ?? ""), SEED_START_TIME),
    readableMinutes(roundUpToQuarterHour(String(form.get("default_end") ?? "")), SEED_END_TIME),
    defaultTimezone,
  );
  // #2385: an unstorable week is the reader's to fix (an end time before its
  // start, a day with no hours at all), so the sentence `planUniformSchedule`
  // wrote comes back to the form that produced it. It used to throw, and this
  // form is the one whose value every agent created afterwards ADOPTS, so a
  // refusal nobody could read left the previous default in place with nothing on
  // screen saying so.
  if (!defaults.ok) {
    redirect(`/admin/business-hours${refusedQuery(defaults.error)}`);
  }

  // #2379: a refused WRITE must not run on to the audit entry and the saved
  // notice. The value here is what a new agent ADOPTS, so a save that only
  // appeared to land leaves every agent created afterwards on the previous
  // default, which nothing else on the page would reveal.
  //
  // #2385: it still THROWS while the week check above redirects, and the two are
  // not one rule applied twice. An unstorable week is a sentence about what was
  // typed, which the reader can fix; a write Postgres refused is a sentence about
  // the system, which no retyping fixes, so the boundary saying the state is
  // unknown is the honest screen and the detail goes to the log.
  const { error } = await supabaseAdmin()
    .from("organizations")
    .update({
      default_timezone: defaultTimezone,
      // The fallbacks come from the seeded day (#1299), never a literal: a blank
      // field must not be able to write 09:00 back over the backfilled roster.
      // An unreadable time falls back to the SEEDED day rather than to midnight
      // (L50): a blank or malformed field must not be able to write a window
      // nobody chose over the backfilled roster's starting hours.
      default_start_minute: readableMinutes(
        String(form.get("default_start") ?? ""),
        SEED_START_TIME,
      ),
      default_end_minute: readableMinutes(
        roundUpToQuarterHour(String(form.get("default_end") ?? "")),
        SEED_END_TIME,
      ),
      default_weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5],
    })
    .eq("id", admin.org_id);
  if (error) throw new Error(writeRefused("The default hours for a new agent", error));
  // #1990: `/admin` was the only route refreshed, and this form is not on it.
  // That is #1769 exactly: the page the person is looking at redrew with what it
  // showed before they pressed the button, which is indistinguishable from the
  // save not happening. Both routes now, and the one the form is ON carries the
  // confirmation.
  revalidatePath("/admin");
  revalidatePath("/admin/business-hours");
  redirect(`/admin/business-hours${savedQuery("org-default-hours")}`);
}

/** Applies the org default schedule to one agent (keeps their tz if already set). */
export async function useDefaultHours(form: FormData): Promise<void> {
  const db = supabaseAdmin();
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  const actor = await requireManageAgent(userId);
  const loaded = loadedScheduleVersion(form, `/admin/agents/${userId}`);

  // #1629: same pair as applyOrgDefaultToUser above, same reasoning. Both reads
  // decide what is written to the agent's schedule, so neither may be guessed.
  const org = unwrap(
    await db
      .from("organizations")
      .select(
        "default_timezone, default_start_minute, default_end_minute, default_weekdays",
      )
      .eq("id", actor.org_id)
      .single(),
    "org default schedule",
  );
  const o = org as {
    default_timezone: string;
    default_start_minute: number;
    default_end_minute: number;
    default_weekdays: number[];
  };

  // Applying the org default keeps the agent's own timezone if they have one,
  // else adopts the org default. It is passed back through
  // `replace_user_schedule`, whose upsert honours the single row (user_id) unique
  // index (#532) without a check then insert race, and which commits the zone and
  // the week together (#2002).
  const existing = unwrap(
    await db.from("availability_schedules").select("timezone").eq("user_id", userId).maybeSingle(),
    "agent schedule timezone",
  );
  const tz =
    (existing as { timezone: string } | null)?.timezone ?? o.default_timezone;

  // #1670: through `replaceUserSchedule`, like every other writer on this path.
  // This button used to be the straggler: a bare delete then insert, with neither
  // `error` bound, no transaction and no validation. If the insert errored, or the
  // isolate died between the two statements, the action still reported success and
  // left the agent with a schedule row holding NO rules, which makes
  // `isWithinWorkingHours` reject every instant, so that agent offers no times,
  // permanently. Two things hid it: the reloaded page draws
  // `workingHoursDays(rules, org.default_weekdays)`, so zero rules renders as the
  // org default week the admin just asked for, and the #838 coverage monitor looks
  // for agents with no availability_schedules ROW, which a row with no rules is
  // not. `planUniformSchedule`, whose own docstring says it is what this button
  // means, had no callers at all.
  //
  // #3122: guarded like the save beside it. This button submits the same form, so it
  // carries the version that form was drawn from, and its confirm named the week it
  // was about to replace; a week somebody saved since is not that week.
  const plan = planUniformSchedule(
    o.default_weekdays,
    o.default_start_minute,
    o.default_end_minute,
    tz,
  );
  const before = await readScheduleForAudit(userId);
  if ((await replaceUserSchedule(userId, "admin", plan, loaded)) === "changed") {
    redirect(`/admin/agents/${userId}${refusedQuery(CHANGED_SINCE_OPENED)}`);
  }
  await auditScheduleSave(actor, userId, "agent.use_default_hours", before, plan);
  // #1769: the form that calls this lives on the agent's own page, so that is the
  // route that has to be refreshed. Revalidating only /admin left the page the
  // person is looking at showing what it showed before they pressed the button.
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
  // #1988: as above. This button replaces the whole week with the company
  // default, so "did that do anything" is the question it most invites.
  redirect(`/admin/agents/${userId}${savedQuery("working-hours")}`);
}

export async function setBookable(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  const actor = await requireManageAgent(userId);
  const wantBookable = form.get("bookable") === "true";
  const back = `/admin/agents/${userId}`;
  // Same guarded path as the bookable-toggle API (#281/#912): making an agent
  // bookable when Slate can't reach their Google calendar is refused here too,
  // so the UI can't put a calendar-less agent into the pool. Deactivation
  // (bookable=false) is never gated. A flip in for an advisor Twilio holds on
  // Redistribute is refused the same way (#3028), inside the service, so the
  // machine API and the Salesforce activation are held by the same rule.
  //
  // A row the service could not READ is refused too (nothing is written on an
  // unread row), and it lands as an outcome rather than a throw: on this route a
  // throw is Next's generic error page with the message scrubbed. Only that one
  // failure, because it is the only one where "nothing was changed" is known to
  // be true; anything else still throws.
  let result: BookableResult;
  try {
    result = await applyBookableByUserId(userId, wantBookable);
  } catch (err) {
    if (!(err instanceof BookableLookupError)) throw err;
    log.error("admin", { msg: "bookable target could not be read", user_id: userId }, err);
    redirect(`${back}?bookable=unreadable`);
  }

  /**
   * The page this form is on, and it comes back saying what happened (#1769).
   *
   * It used to `revalidatePath("/admin")`, which names the Overview page rather
   * than the agent page the form is on, and return void. So the only thing that
   * changed on screen was one button being replaced by another in the corner of a
   * dense row, which is not a confirmation, it is a difference you would have to
   * already be looking for. The refusal was worse: it threw, there is no error
   * boundary on this route, and Next scrubs a server error's message in
   * production, so the most useful sentence in this action reached nobody.
   *
   * A fixed CODE rather than the sentence, for two reasons: the copy stays in the
   * page where the preview and the copy lint can see it, and nothing an admin can
   * type reaches the banner. The agent is not named because they are the subject of
   * the page this lands on, and a name or an email in a query string is a person's
   * identity in browser history for no gain.
   */
  revalidatePath(back);
  if (result.status === "blocked") {
    // Nothing was written: the gate refused before the update.
    //
    // One code per reason, keyed off the union so `tsc` names a new one rather than
    // letting it fall into whichever arm a two-way branch happened to end on. That
    // is not hypothetical: `google_not_provisioned` shipped inside the transient
    // arm, so an account that had never been given Calendar was answered with
    // "try again shortly", which can never work (AGENTS.md, "Three ways a Google
    // calendar can fail, not two").
    const outcome: Record<BlockedReason, string> = {
      google_unreachable: "blocked-gone",
      google_not_provisioned: "blocked-not-provisioned",
      google_unverified: "blocked-transient",
      calendar_unhydrated: "blocked-unread",
      activation_timed_out: "blocked-timeout",
      calendar_contended: "blocked-contended",
      twilio_redistribute: "blocked-redistribute",
    };
    redirect(`${back}?bookable=${outcome[result.reason]}`);
    return;
  }
  if (result.status === "not_found") {
    redirect(`${back}?bookable=missing`);
    return;
  }
  // #3089: only a flip that HAPPENED is recorded, after it landed. `applied` means
  // the row moved, so the value before is the opposite of the one it moved to; a
  // noop changed nothing and records nothing.
  if (result.status === "applied") {
    await recordAudit({
      orgId: actor.org_id,
      actorId: actor.id,
      action: "agent.bookable",
      targetUserId: userId,
      details: { bookable: { from: !result.bookable, to: result.bookable } },
    });
  }
  redirect(`${back}?bookable=${wantBookable ? "on" : "off"}`);
}

/**
 * Admin only: stop Slate waiting to make somebody bookable (#2078).
 *
 * When the activation gate refuses a flip the roster sync planned, the row keeps
 * `bookable_pending_since`, so the sync retries every hour and the alert re-fires
 * on its cooldown. Any explicit bookable write settles that mark, but the toggle
 * cannot reach it: "not bookable" on somebody already not bookable is a noop in
 * `planBookableChange`, so the write that clears the mark never runs. This is the
 * deliberate "do not flip this one": it clears the mark and never touches
 * `bookable`, which is why it is not routed through the toggle's owning writer.
 * The sync's planner already reads a row with no mark as settled.
 *
 * The write is a compare and swap on the stamp that was read, so a second press,
 * or a sync run that settled or re-marked the row in between, changes nothing and
 * records nothing. The trail gets the stamp before and after (L529).
 */
export async function clearPendingBookableFlip(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  const admin = await requireAdmin();
  const back = `/admin/agents/${userId}`;
  const db = supabaseAdmin();

  let row: { role: Role; bookable: boolean; bookable_pending_since: string | null } | null;
  try {
    row = unwrap(
      await db
        .from("users")
        .select("role, bookable, bookable_pending_since")
        .eq("id", userId)
        .eq("org_id", admin.org_id)
        .maybeSingle(),
      "pending flip target",
    ) as typeof row;
  } catch (err) {
    log.error("admin", { msg: "pending flip target could not be read", user_id: userId }, err);
    redirect(`${back}?bookable=unreadable`);
  }
  // The same escalation rule every agent control uses: an admin cannot act on a
  // super admin, whatever the button on their screen offered. Said on the page
  // rather than thrown, since a thrown sentence reaches nobody in production.
  if (row && !canManageUser(admin.role, row.role, admin.id === userId)) {
    redirect(`${back}?bookable=not-permitted`);
  }

  const plan = planClearPendingFlip(row);
  if (plan.status === "not_found") redirect(`${back}?bookable=missing`);
  if (plan.status === "not_pending") redirect(`${back}?bookable=pending-none`);

  const { data, error } = await db
    .from("users")
    .update({ bookable_pending_since: null })
    .eq("id", userId)
    .eq("org_id", admin.org_id)
    .eq("bookable_pending_since", plan.pendingSince)
    .select("id");
  if (error) {
    redirect(`${back}${refusedQuery(writeRefused("Stopping the wait to make them bookable", error))}`);
  }
  revalidatePath(back);
  // Nothing matched the stamp that was read: somebody or something settled it
  // first, so there is nothing of ours to record.
  if (!data || data.length === 0) redirect(`${back}?bookable=pending-none`);

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "agent.pending_flip_cleared",
    targetUserId: userId,
    details: { bookable_pending_since: { from: plan.pendingSince, to: null }, bookable: row!.bookable },
  });
  redirect(`${back}?bookable=pending-cleared`);
}

/**
 * Admin only: forget the Google account somebody signs in with (#3526), so the
 * next Google account that signs in with their address records itself instead.
 *
 * Sign in refuses a Google account other than the one a Slate account holds,
 * because an address handed to somebody new would otherwise hand them the old
 * account. A rehire on a NEW Google account meets the same refusal, and this is
 * how an admin lets them through. The role, bookings and calendar stay with the
 * account, which is the point of relinking rather than recreating.
 *
 * IT ALSO DELETES THE OLD SUPABASE AUTH USER (security review of #4169). GoTrue
 * links a new Google identity onto an existing auth user with the same address, so
 * forgetting the stored id alone would leave the rehire's next sign in landing on
 * the OLD auth user holding BOTH accounts, which the per request check refuses as
 * two accounts. GoTrue's admin API has no call that removes one identity from a
 * user (`unlinkIdentity` acts only on the caller's own session), so the auth user
 * goes, through the same `supabaseAdmin().auth.admin` client the offboarding ban
 * uses. Deleting it ends every session on it, and `users.auth_user_id` is set null
 * by its foreign key (`on delete set null`, migration 0006). The next sign in makes
 * a fresh auth user with one Google identity, which provisioning finds by email.
 *
 * ORDER: the auth user goes FIRST and the row second. A failed delete changes
 * nothing and the admin can press again; a failed row write after a delete leaves
 * the row still holding the account id, so the control is still offered and the
 * retry finds no auth user to delete and finishes.
 *
 * A compare and swap on the id it read, so a press that races a sign in (or a
 * second press) writes nothing twice and records nothing it did not do. Every
 * outcome comes back to the page as a sentence (`?error=` or the saved notice),
 * never a throw, which production would replace with the generic error page.
 * Never on your own account: it would delete the sign in you are using.
 */
export async function relinkGoogleAccount(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  const admin = await requireAdmin();
  const back = `/admin/agents/${userId}`;
  const db = supabaseAdmin();
  if (admin.id === userId) redirect(`${back}${refusedQuery(GOOGLE_RELINK_REFUSED.self)}`);

  let row: { role: Role; google_sub: string | null; auth_user_id: string | null } | null;
  try {
    row = unwrap(
      await db
        .from("users")
        .select("role, google_sub, auth_user_id")
        .eq("id", userId)
        .eq("org_id", admin.org_id)
        .maybeSingle(),
      "relink google account target",
    ) as typeof row;
  } catch (err) {
    log.error("admin", { msg: "relink target could not be read", user_id: userId }, err);
    redirect(`${back}${refusedQuery(GOOGLE_RELINK_REFUSED.unreadable)}`);
  }
  if (!row) return redirect(`${back}${refusedQuery(GOOGLE_RELINK_REFUSED.missing)}`);
  // The same escalation rule every agent control uses: an admin cannot act on a
  // super admin, whatever the button on their screen offered.
  if (!canManageUser(admin.role, row.role, admin.id === userId)) {
    redirect(`${back}${refusedQuery(GOOGLE_RELINK_REFUSED.notPermitted)}`);
  }
  const stored = row.google_sub;
  const oldAuthUserId = row.auth_user_id;
  // Something to undo: an account on record, or a sign in on record. A row with no
  // account recorded but a sign in holding no Google account, or two, is refused on
  // every request, and this is its way out too (re-review of #4169).
  if (stored == null && !oldAuthUserId) {
    redirect(`${back}${refusedQuery(GOOGLE_RELINK_REFUSED.nothingLinked)}`);
  }

  if (oldAuthUserId) {
    const { error: deleteError } = await db.auth.admin.deleteUser(oldAuthUserId);
    // 404 is an auth user already gone (a retry after a delete that landed, or a
    // race with another press), which is the state this step exists to reach.
    if (deleteError && deleteError.status !== 404) {
      log.error("admin", { msg: "relink could not delete the old auth user", user_id: userId }, deleteError);
      redirect(`${back}${refusedQuery(GOOGLE_RELINK_REFUSED.signInNotRemoved)}`);
    }
    // Recorded the moment it lands and only when THIS press deleted it: the row
    // write below can still fail, the deletion cannot be undone, and a retry finds
    // no auth user to delete, so this is the one entry it will ever get.
    if (!deleteError) {
      await recordAudit({
        orgId: admin.org_id,
        actorId: admin.id,
        action: "agent.sign_in_removed",
        targetUserId: userId,
        details: { sign_in: { from: "present", to: "deleted" }, because: "relink google account" },
      });
    }
  }

  const unlink = db
    .from("users")
    // `auth_user_id` is already null through the foreign key once the auth user is
    // deleted; written here too so the row says so whatever the database did.
    .update({ google_sub: null, auth_user_id: null })
    .eq("id", userId)
    .eq("org_id", admin.org_id);
  // A compare and swap on the account as read, null included.
  const { data, error } = await (stored == null ? unlink.is("google_sub", null) : unlink.eq("google_sub", stored)).select(
    "id",
  );
  if (error) {
    redirect(`${back}${refusedQuery(writeRefused("Linking a new Google account", error))}`);
  }
  revalidatePath(back);
  // Nothing matched the account that was read: another press got there first, so
  // there is no unlink of ours to record.
  if (!data || data.length === 0) redirect(`${back}${refusedQuery(GOOGLE_RELINK_REFUSED.nothingLinked)}`);

  // Only when an account was on record: with none, the deletion above was the
  // whole of the change and its entry already says so.
  if (stored != null) {
    await recordAudit({
      orgId: admin.org_id,
      actorId: admin.id,
      action: "agent.google_relinked",
      targetUserId: userId,
      details: { google_account: { from: "linked", to: "unlinked" } },
    });
  }
  redirect(`${back}${savedQuery("agent-google-relinked")}`);
}

/**
 * Manager+-only: deactivate or reactivate a user by hand (#278), the same
 * lifecycle the offboarding automation drives, so an admin can offboard or
 * rehire without invoking the API. `action` is "deactivate" | "reactivate".
 * Self-lockout guard: you cannot deactivate your own account (you'd lose access
 * immediately); reactivating yourself is moot since you couldn't reach this page
 * while deactivated. requireManageAgent enforces the manager+ / strict-outrank
 * escalation gate and writes the audit row.
 *
 * #2124: the confirm ASKS what happens to the agent's upcoming bookings, and the
 * answer arrives as the pressed button's own value. Only the explicit "move"
 * sweeps; anything else, including a form that carries no answer at all, leaves
 * them where they are.
 *
 * That default is deliberate and it is the safe one. A missing or misspelled
 * value must not be able to start moving customers' appointments, because nobody
 * asked for it and nothing on the screen would say it happened. The opposite
 * mistake, a move the admin chose that did not run, is loud: the agent is
 * deactivated with their bookings still on them, which the `inactive_agent_bookings`
 * monitor pages about within the hour.
 */
// outcome-ok: the account status it changes is shown on this page and visibly flips, and the controls offered change with it
export async function setUserLifecycle(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  const action = String(form.get("action") ?? "");
  if (!userId || (action !== "deactivate" && action !== "reactivate")) return;
  const actor = await requireManager();
  // #2385: the one refusal this action can speak, said on the page the button is
  // on. It used to throw, so an admin who pressed Deactivate on their own row met
  // the generic error boundary and could not tell a refusal from the page
  // breaking, on a control whose whole point is that it locks you out.
  if (action === "deactivate" && actor.id === userId) {
    redirect(
      `/admin/agents/${userId}${refusedQuery("You cannot deactivate your own account. Ask another admin to do it.")}`,
    );
  }
  await requireManageAgent(userId);
  // The field and its values come from the component that writes them, so the
  // two cannot drift into disagreeing about a wire value (L263). A drift here is
  // silent in the worst direction: every press would fall to not sweeping while
  // the admin believed they had chosen to move.
  const sweepCoverage = readCoverageChoice(form.get(COVERAGE_CHOICE_FIELD));
  const result = await applyLifecycleByUserId(userId, action, { sweepCoverage });
  // #3089: after the change, and only when it changed something. `applied` is a
  // transition, so the state before is the other one; a noop records nothing.
  if (result.status === "applied") {
    const deactivated = action === "deactivate";
    await recordAudit({
      orgId: actor.org_id,
      actorId: actor.id,
      action: deactivated ? "agent.deactivate" : "agent.reactivate",
      targetUserId: userId,
      details: {
        deactivated: { from: !deactivated, to: deactivated },
        moved_upcoming_bookings: sweepCoverage,
        ...(result.clearedStaleBookable ? { cleared_stale_bookable: true } : {}),
      },
    });
  }
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
}

/**
 * Admin+-only: start viewing the app as another user ranked below you. The cookie
 * only takes effect for a real admin+ session and only for a lower-ranked target
 * (resolveEffectiveUserId + canImpersonate gate it downstream), so it can't be
 * used to escalate. Lands on /me — the impersonated user's home.
 *
 * OFFBOARDED TARGETS ARE REFUSED HERE (#1795), and not because the cookie would
 * otherwise work: `resolveImpersonationState` filters the target on
 * `deactivated_at` and has always refused a departed user. The defect was what
 * happened instead. The cookie was set, an `impersonate.start` audit row was
 * written, and the very next request found the target ineligible and reverted the
 * admin to themselves, so the audit log recorded a session that never existed and
 * the admin got a silent round trip. Two distinct causes were sharing one
 * outcome (L11), and the fix is to give this one its own refusal before anything
 * is written.
 */
// outcome-ok: the whole session becomes somebody else and a banner says so on every page, which is a larger confirmation than a sentence
export async function startImpersonation(form: FormData): Promise<void> {
  const admin = await realCurrentUser();
  // throw-ok: not a refusal anybody is standing in front of. The control that
  // submits here renders only for an admin who may use it, so the only caller
  // that reaches this line is one invoking the action directly, and there is no
  // form to send a sentence back to.
  if (!admin || !atLeast(admin.role, "admin")) throw new Error("Not authorized");

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  // Every remaining caller is a per row control submitting that row's own address
  // in a hidden field (#1749), so an empty email is a malformed call rather than a
  // typo. It still refuses rather than looking up the empty string.
  if (!email) redirect(impersonationErrorUrl("No address was submitted."));

  // #1629: a null on error took the "No user with email X." branch, which tells an
  // admin the person does not exist when the read simply failed. The next thing
  // somebody does with that answer is create the account again.
  const data = unwrap(
    await supabaseAdmin()
      .from("users")
      .select("id, role, deactivated_at")
      .eq("org_id", admin.org_id)
      .eq("email", email)
      .maybeSingle(),
    "impersonation target lookup",
  );
  const target = data as { id: string; role: Role; deactivated_at: string | null } | null;
  if (!target) {
    redirect(impersonationErrorUrl(`No user with email ${email}.`));
  }
  if (target.id === admin.id) {
    redirect(impersonationErrorUrl("That is already you."));
  }
  // #1795: a departed employee. Refused before the cookie and before the audit
  // row, since downstream would drop the session on the next request anyway and
  // the only trace left would be an audit entry for something that never ran.
  if (!isActive(target)) {
    redirect(impersonationErrorUrl(`${email} has been offboarded.`));
  }
  // Role ceiling (#588): can't view-as someone who outranks or equals you.
  if (!canImpersonate(admin.role, target.role)) {
    redirect(impersonationErrorUrl(`You can't impersonate a ${roleLabel(target.role)}.`));
  }

  // Audited BEFORE the cookie is set (#3113), so no session can exist that the
  // trail does not record starting. The cookie is signed for this admin, which is
  // what stops one being written by hand and skipping this row altogether.
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "impersonate.start",
    targetUserId: target.id,
  });
  const value = await encodeImpersonationCookie({
    issuerId: admin.id,
    targetId: target.id,
    issuedAtMs: Date.now(),
    secret: impersonationSigningSecret(),
  });
  const store = await cookies();
  // Timestamped, signed value + matching maxAge so the session auto-expires
  // (#653): the server-side TTL check in impersonationCookieOutcome is
  // authoritative, maxAge is defense in depth.
  store.set(IMPERSONATE_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: IMPERSONATE_TTL_SECONDS,
  });
  // Straight to the page rather than through /me's redirect: this is where
  // "view as" lands somebody, and the address is read from the tab list so it
  // cannot drift from the page it names (#2107).
  redirect(ME_TABS[0].href);
}

/** Stop impersonating and revert to your own session. Safe for anyone to call. */
// outcome-ok: the banner disappears and the session is the admin's own again, on every page
export async function stopImpersonation(): Promise<void> {
  const real = await realCurrentUser();
  const store = await cookies();
  const targetId = impersonationTargetId(store.get(IMPERSONATE_COOKIE)?.value);
  store.delete(IMPERSONATE_COOKIE);
  if (real && targetId) {
    await recordAudit({
      orgId: real.org_id,
      actorId: real.id,
      action: "impersonate.stop",
      targetUserId: targetId,
    });
  }
  redirect("/admin");
}

/**
 * Clear a silently-dropped "view as" session (#652): the impersonated user became
 * ineligible mid-session (timed out, deactivated, removed, or promoted past the
 * ceiling), so the app already reverted the admin to themselves. The header fires
 * this in the background to delete the stale cookie and record the auto-end.
 *
 * Unlike stopImpersonation this does NOT redirect or revalidate: the admin is
 * already on their own view, and leaving the current render intact keeps the
 * "session ended" notice visible while the cookie clears behind it. Safe to call
 * repeatedly and when no cookie remains (idempotent).
 */
// outcome-ok: the dropped session notice is the confirmation, and it is drawn by the page this ends on
export async function endDroppedImpersonation(
  reason: "expired" | "unavailable",
): Promise<void> {
  const real = await realCurrentUser();
  const store = await cookies();
  const targetId = impersonationTargetId(store.get(IMPERSONATE_COOKIE)?.value);
  store.delete(IMPERSONATE_COOKIE);
  if (real && targetId) {
    await recordAudit({
      orgId: real.org_id,
      actorId: real.id,
      action: "impersonate.ended",
      targetUserId: targetId,
      details: { reason },
    });
  }
}

/** Admin-only: set the OOO Google calendar approval events land on (manager rows). */
export async function setOooCalendarId(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(form.get("user_id") ?? "");
  if (!userId) return;
  const calendarId = String(form.get("ooo_calendar_id") ?? "").trim();
  // #2379: refused before the audit entry and the saved notice. The field redraws
  // holding the same text whether the write landed or not, so the notice is the
  // ONLY thing on screen that says anything about it, and a refused write made it
  // say the wrong thing. It throws, like the role form beside it on this page:
  // the page's `?error=` notice belongs to the working hours card above.
  const { error } = await supabaseAdmin()
    .from("users")
    .update({ ooo_calendar_id: calendarId || null })
    .eq("id", userId);
  if (error) throw new Error(writeRefused("The time off calendar", error));
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "agent.ooo_calendar",
    targetUserId: userId,
    details: { ooo_calendar_id: calendarId || null },
  });
  // #1769: the form that calls this lives on the agent's own page, so that is the
  // route that has to be refreshed. Revalidating only /admin left the page the
  // person is looking at showing what it showed before they pressed the button.
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
  // #1990: this page confirms its other forms now, so a silent save here reads as
  // a failure rather than as a feature nobody built. There is nothing else on
  // screen to show it landed: the field redraws holding the same text either way.
  redirect(`/admin/agents/${userId}${savedQuery("agent-ooo-calendar")}`);
}

/** Admin-only: change a user's tier (agent/manager/admin). Guards last-admin. */
// outcome-ok: the role it writes is drawn on this page and visibly changes, including which controls are offered at all
export async function setUserRole(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();
  const userId = String(form.get("user_id") ?? "");
  const next = String(form.get("role") ?? "");
  if (!userId || !isRole(next)) return;

  // #1629: an unreadable row made `current` undefined and this returned SILENTLY,
  // so the admin pressed "set role", the page re-rendered unchanged, and nothing
  // anywhere said why. The read also feeds `canSetRole`, so guessing it is a
  // guess at an authorization input.
  const target = unwrap(
    await db.from("users").select("role, bookable").eq("id", userId).maybeSingle(),
    "set-role target role",
  );
  const current = (target as { role: Role } | null)?.role;
  if (!current) return;
  const inPool = (target as { bookable?: boolean } | null)?.bookable === true;

  // #2385: all four refusals below come back to this agent's own page as
  // sentences. Every one of them used to throw, so the reader met the generic
  // error boundary: "Cannot remove the last admin" was never drawn for anybody,
  // and a manager who tried it was told to reload and check whether it had gone
  // through, which is advice that cannot resolve a rule they have not been told
  // about (L111).
  const back = `/admin/agents/${userId}`;

  // Only a super admin can grant or revoke super_admin; regular admins can't
  // mint a peer above themselves nor demote one.
  if (!canSetRole(admin.role, current, next)) {
    redirect(
      `${back}${refusedQuery(`Your own role cannot set somebody to ${roleLabel(next)}, so the role was left as ${roleLabel(current)}.`)}`,
    );
  }

  // #4205: a coordinator is never bookable (users_coordinator_never_bookable), so the
  // write would be refused by the database. Said here instead, naming what to do.
  if (next === "coordinator" && inPool) {
    redirect(
      `${back}${refusedQuery("This person takes calls in the booking pool, and a coordinator never does, so the role was left unchanged. Take them out of the pool first.")}`,
    );
  }

  // Block self-lockout: an admin can't strip their own org power and orphan
  // their /admin access (recovery would need a direct DB write).
  if (isSelfDemotion(admin.id === userId, current, next)) {
    redirect(
      `${back}${refusedQuery("You cannot remove your own admin access. Ask another admin to change your role.")}`,
    );
  }

  // #1165: consult `error`. A failed count came back null, `?? 0` scored it as
  // "zero admins left", and the refusal then claimed "Cannot remove the last
  // admin", a fact the check never actually measured. Still refuse (fail closed
  // on the safe side), but say which of the two happened.
  // any-advisor-ok: counts who holds admin, whatever kind of row holds it; the
  // last admin lockout rule is about access, not the advisor roster.
  const { count, error: countError } = await db
    .from("users")
    .select("id", { count: "exact", head: true })
    .in("role", ["admin", "super_admin"]);
  if (countError) {
    log.error(
      "admin-actions",
      { msg: "admin count read failed", user_id: userId },
      countError,
    );
    redirect(
      `${back}${refusedQuery("The number of admins could not be verified, so the role was left unchanged. Try again in a moment.")}`,
    );
  }
  if (!canChangeRole(current, next, count ?? 0)) {
    redirect(
      `${back}${refusedQuery("This is the last admin account, so its role was left unchanged. Give somebody else admin first.")}`,
    );
  }

  // #2379: the revocation twin of the kill switch. The result was discarded, so a
  // refused write recorded `role.set { from: "admin", to: "agent" }` for a role
  // that never changed: an admin removing a departing admin's access is told it is
  // done, the trail says it is done, and the person keeps admin (L529). It throws,
  // like every other refusal in this action, rather than adding a fourth way of
  // saying no to one form.
  const { error: roleWriteError } = await db
    .from("users")
    .update({ role: next })
    .eq("id", userId);
  if (roleWriteError) throw new Error(writeRefused("The role", roleWriteError));
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "role.set",
    targetUserId: userId,
    details: { from: current, to: next },
  });
  // #1769: the form that calls this lives on the agent's own page, so that is the
  // route that has to be refreshed. Revalidating only /admin left the page the
  // person is looking at showing what it showed before they pressed the button.
  revalidatePath("/admin");
  revalidatePath(`/admin/agents/${userId}`);
}

/**
 * Super admin only: give a staff member elevated access by email (#160).
 *
 * These people are not in the Salesforce agent feed, so nothing creates them.
 * Until now that meant a developer editing the users table by hand, which is why
 * four admins were seeded that way in one session, and it carried a silent
 * failure: `provisionUser` matches a login to a row BY EMAIL, so a row keyed to
 * an address that is not the person's real Google login is never used and nothing
 * anywhere reports it.
 *
 * The guards, all server side and none of them relying on the button being hidden:
 *
 *  - **Who may call it.** `requireSuperAdmin`, the highest role, at the top of the
 *    action. `planStaffAccess` asks the same question again from its own module,
 *    so a second entry point wired to a weaker guard still could not grant.
 *  - **What may be granted.** The same `canSetRole` the per user role editor runs,
 *    over a narrower set of roles: `super_admin` is never minted from a typed
 *    address, and `agent` is not a grant.
 *  - **Whose data it touches.** Everything is scoped to the caller's org: the row
 *    is created in it, an address already held by another org is refused by name,
 *    and the admin count is counted within it.
 *  - **The last admin.** Typing a current admin's address and picking a lower role
 *    is a demotion by another name, so it carries the same invariant. A count that
 *    could not be READ is not a count (#1165): it refuses in its own words rather
 *    than being scored as zero and producing a confident claim about a roster
 *    nothing measured, and it is only read where it actually decides something, so
 *    a broken read cannot block a grant that never depended on it.
 *
 * Every ending, refusal and success alike, comes back on the page as its own
 * sentence rather than as an error boundary, because the person needs to read the
 * address back: it is the address, not the button, that decides whether this works.
 */
export async function grantStaffAccess(form: FormData): Promise<void> {
  const actor = await requireSuperAdmin();
  const email = normalizeStaffEmail(String(form.get("email") ?? ""));
  const requestedRole = String(form.get("role") ?? "");
  const allowedDomain = googleHostedDomain();

  // Annotated rather than inferred: TypeScript only treats a call as ending
  // control flow when the callee carries an explicit `never` TYPE, and without
  // that every `done()` below reads as a fall through.
  // #2384, found by the guard rather than by eye: this named `/admin` while the
  // form and the only reader of `?staff=` are on `/admin/team-access`. The
  // Overview declares no search params, so every ending this action has, the
  // grant, the refusal and the address that could never sign in, was encoded,
  // attached to a URL and thrown away, and the `#team-access` fragment pointed at
  // a section that moved out of that page with #1763. The Overview keeps its
  // refresh because it counts admins.
  const done: (outcome: StaffAccessOutcome) => never = (outcome) => {
    revalidatePath("/admin");
    revalidatePath("/admin/team-access");
    redirect(
      `/admin/team-access?staff=${outcome}&staff_email=${encodeURIComponent(email)}` +
        `&staff_role=${encodeURIComponent(requestedRole)}`,
    );
  };

  // Judged before any database read, so a caller who may not do this at all, or an
  // address that could never sign in, never reaches the roster.
  const inputError = staffAccessInputError({
    actorRole: actor.role,
    email,
    requestedRole,
    allowedDomain,
  });
  // The second half is a narrowing for `tsc`, not a second policy: it can only be
  // reached when `staffAccessInputError` already returned `invalid_role`.
  if (inputError || !isGrantableStaffRole(requestedRole)) done(inputError ?? "invalid_role");

  const db = supabaseAdmin();
  // Not org scoped on purpose: `users.email` is globally unique, so an address
  // held by another org has to be FOUND in order to be refused by name. The plan
  // then compares the org. An unreadable lookup is not an absent row, so it stops
  // here rather than falling through to the create path.
  const { data: existingRow, error: lookupError } = await db
    .from("users")
    .select("id, org_id, role, deactivated_at, auth_user_id, bookable")
    .eq("email", email)
    .maybeSingle();
  if (lookupError) {
    log.error("admin-actions", { msg: "staff access lookup failed" }, lookupError);
    done("lookup_failed");
  }
  const existing = (existingRow as StaffAccessTarget | null) ?? null;

  let adminCount: number | null = null;
  if (existing && requiresAdminCount(existing.role, requestedRole)) {
    // any-advisor-ok: counts who holds admin, whatever kind of row holds it; the
    // last admin lockout rule is about access, not the advisor roster.
    const { count, error: countError } = await db
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("org_id", actor.org_id)
      .in("role", ["admin", "super_admin"]);
    if (countError) {
      log.error("admin-actions", { msg: "admin count read failed" }, countError);
    }
    adminCount = countError ? null : (count ?? 0);
  }

  const plan = planStaffAccess({
    actorRole: actor.role,
    actorId: actor.id,
    actorOrgId: actor.org_id,
    allowedDomain,
    email,
    requestedRole,
    existing,
    adminCount,
  });
  if (!plan.ok) done(plan.outcome);

  if (plan.outcome === "granted") {
    const { error } = await db.from("users").insert({
      org_id: actor.org_id,
      email: plan.email,
      role: plan.role,
      // Never bookable on arrival, for the same reason `provisionUser` says so at
      // its own insert (#1266): adding an account must not put anyone into the
      // round robin pool. A staff member added here is not an agent at all.
      bookable: false,
    });
    if (error) {
      log.error("admin-actions", { msg: "staff access insert failed" }, error);
      done("write_failed");
    }
    await recordAudit({
      orgId: actor.org_id,
      actorId: actor.id,
      action: "staff.access_granted",
      details: { email: plan.email, role: plan.role },
    });
  } else if (plan.outcome === "updated") {
    const { error } = await db
      .from("users")
      .update({ role: plan.role })
      .eq("id", plan.userId);
    if (error) {
      log.error("admin-actions", { msg: "staff access update failed" }, error);
      done("write_failed");
    }
    await recordAudit({
      orgId: actor.org_id,
      actorId: actor.id,
      action: "role.set",
      targetUserId: plan.userId,
      details: { from: plan.from, to: plan.role, via: "team_access" },
    });
  }

  done(plan.outcome);
}

// Server-side duplicate guard for the non-idempotent webhook re-delivery
// actions (#674). The SubmitButton's client-side disable (#630) can't stop a
// flaky-network retry (the client lost the response and retries AFTER the server
// already ran) or a racing request from re-firing a delivery. A DB-backed claim
// (acquireLock, sync_locks) that we DELIBERATELY DO NOT RELEASE makes a duplicate
// within the window a no-op: the claim lingers until its TTL expires, so it
// covers the retry-after-completion case, not just an in-flight race. A genuinely
// new action after the window still steals the stale claim and proceeds. `send()`
// records failure internally (never throws), so there is no error path that needs
// the claim released early.
/**
 * The page all three webhook forms are on (#2384).
 *
 * Named once rather than written out at each of the eight sites, because the
 * defect this closes was three of them naming a DIFFERENT page: #1763 moved this
 * surface off `/admin` and the actions kept the old address, so every outcome
 * they wrote went to a page that reads none of them. One constant is what makes
 * the next route move one edit instead of eight (L41).
 */
const WEBHOOKS_PAGE = "/admin/webhooks";

const WEBHOOK_RESEND_DEDUPE_TTL_MS = 60_000;
const WEBHOOK_REPLAY_DEDUPE_TTL_MS = 5 * 60_000;

/** Admin-only: re-fire a webhook delivery from the delivery log. */
export async function resendWebhookDelivery(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const deliveryId = String(form.get("delivery_id") ?? "");
  if (!deliveryId) return;
  // lock-overlap: deliberately held for its TTL as a dedupe window for repeated
  // presses, never released. The send itself goes through claimAndSend, which compares
  // and swaps on attempts, so a press after the window cannot double POST.
  const claim = await acquireLock(
    `webhook_resend:${admin.org_id}:${deliveryId}`,
    WEBHOOK_RESEND_DEDUPE_TTL_MS,
  );
  // A duplicate or racing request already re-fired this delivery. Reported as the
  // deduped outcome rather than returning silently (#1076): from the admin's side a
  // second press that says nothing is indistinguishable from a broken button, and
  // the truthful thing to say is that the receiver already has it.
  //
  // #2384: on `/admin/webhooks`, which is where the button is. It named `/admin`,
  // the Overview, which takes no search params at all, so every outcome #1076
  // wrote was encoded, attached to a URL and thrown away, and the admin was moved
  // off the log they pressed the button in. The three sentences that page can
  // show, "the receiver has it", "there is nothing left to send" and "test traffic
  // is never delivered", had never once been drawn.
  if (!claim) {
    redirect(`${WEBHOOKS_PAGE}?resend=${encodeURIComponent("deduped")}`);
  }
  const result = await resendDelivery(deliveryId, admin.org_id);
  // #1073: a refused resend (payload erased for PII retention, suppressed, etc.)
  // must not look like a silent success. The reason goes to the server logs so it
  // is observable, AND to the admin (#1076), because logging it server side left
  // the person who pressed the button watching the log re-render unchanged.
  if (result !== "sent") {
    log.warn("webhook-resend", { msg: "resend not sent", delivery_id: deliveryId, result });
  }
  // #3089: a resend posts a lead's stored payload to the endpoint again, which is
  // a privileged outbound action like the test send. Recorded with its outcome and
  // the count actually re-sent, so a refusal reads as zero rather than as a send.
  // A deduped press above did nothing and records nothing.
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "webhook.resent",
    details: { delivery_id: deliveryId, result, sent: result === "sent" ? 1 : 0 },
  });
  revalidatePath(WEBHOOKS_PAGE);
  redirect(`${WEBHOOKS_PAGE}?resend=${encodeURIComponent(result)}`);
}

/**
 * Admin-only: batch replay of dead-lettered deliveries after a receiver
 * outage (#33). Window is clamped to 1 hour - 7 days.
 */
export async function replayFailedWebhooks(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const hours = Math.min(Math.max(Number(form.get("hours")) || 24, 1), 168);
  // `hours` is in the key so a genuinely different window isn't deduped away,
  // while an identical resubmit (same window) is.
  // lock-overlap: deliberately held for its TTL as a dedupe window for repeated
  // presses. Each row's send compares and swaps on attempts in claimAndSend, so a
  // second replay cannot double POST a row.
  const claim = await acquireLock(
    `webhook_replay:${admin.org_id}:${hours}`,
    WEBHOOK_REPLAY_DEDUPE_TTL_MS,
  );
  // #2384: it says what it did, and both endings are said out loud. A duplicate
  // press inside the five minute window used to `return` in silence, so the one
  // control that re-fires a receiver's whole backlog was indistinguishable from a
  // broken button on the second press, which is the exact fault #1076 closed for
  // the per delivery Resend beside it and left open here.
  if (!claim) {
    redirect(`${WEBHOOKS_PAGE}?replay=${encodeURIComponent("deduped")}`);
  }
  const sinceIso = new Date(Date.now() - hours * 3_600_000).toISOString();
  const queued = await replayDeadLetteredDeliveries(admin.org_id, sinceIso);
  // #3089: the window and how many it queued, after the replay ran.
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "webhook.replayed",
    details: { hours, queued },
  });
  revalidatePath(WEBHOOKS_PAGE);
  // The COUNT, because zero and nine send a reader to two different places: zero
  // says the window held nothing dead lettered, and nine says nine are on their
  // way and the log below is about to change.
  redirect(`${WEBHOOKS_PAGE}?replay=${encodeURIComponent(String(queued))}`);
}

/**
 * `setAgentAttributes` is GONE (#2120), and the routing attributes panel writes
 * nothing at all.
 *
 * It survived #1874 as the writer of one key, on the reasoning that routing
 * matched on it and nothing else wrote it. The first half was true and the second
 * was the problem: it was the second place to set a fact that lives in Twilio, and
 * it wrote a boolean where routing compared a string, so the choice it offered
 * changed nothing anybody could see (L109).
 *
 * The key it wrote was retired outright in #2218, so the panel now has nothing it
 * could write even if somebody wanted it to.
 */

export async function setWebhookEndpoint(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();
  const url = String(form.get("url") ?? "").trim();
  if (!url) return;
  // #1032: reject a non-https endpoint before storing it. Every booking event
  // (lead PII) and the Regal API key header would otherwise be POSTed in
  // plaintext on the first delivery. redirect() throws, so no write happens.
  const urlError = webhookUrlError(url);
  if (urlError) {
    redirect(`${WEBHOOKS_PAGE}${refusedQuery(urlError)}`);
  }

  const format = form.get("format") === "regal" ? "regal" : "generic";
  // #3091: the Regal API key and the signing secret are Worker secrets now, so this
  // form writes neither column, whatever it is sent. Changing either is a deploy
  // step (DEPLOY.md, section 2b), and the page shows only whether each is set.
  // #600's rule that a blank field must never wipe the key holds trivially: there
  // is no field.

  // #1629: this null decides UPDATE versus INSERT. On a read error it read as "no
  // endpoint exists" and took the insert branch, adding a SECOND endpoint row for
  // the org: every booking event then delivered twice, and the page's own
  // `.limit(1)` read would afterwards show whichever row came back first.
  //
  // #3089: the url and format are read too, as the "before" the trail records.
  //
  // #4381: the org's PRIMARY (oldest) endpoint, so a second endpoint, the dialer's
  // lead sender, is never the row this form overwrites.
  const existing = unwrap(
    await readPrimaryWebhookEndpoint(db, admin.org_id, "id, url, format"),
    "webhook endpoint upsert lookup",
  ) as { id: string; url: string; format: string } | null;

  // #2379: both branches are checked, and each refuses through the same `?error=`
  // the URL guard above already uses, so this form has ONE way of saying no. A
  // refused write here is the quietest failure in the file: the page redraws from
  // the stored row, so an endpoint that was never written looks exactly like one
  // that was.
  //
  // #2384: that channel used to be `?webhook_error=` pointed at `/admin`, which
  // reads neither the name nor the value, so the refusal of an `http://` endpoint
  // (which saves nothing) moved the admin to the Overview and said nothing there.
  // They would reasonably believe the new URL was live.
  if (existing) {
    const { error } = await db
      .from("webhook_endpoints")
      .update({ url, format })
      .eq("id", existing.id);
    if (error) {
      redirect(
        `${WEBHOOKS_PAGE}${refusedQuery(writeRefused("The webhook endpoint", error))}`,
      );
    }
  } else {
    const { error } = await db.from("webhook_endpoints").insert({
      org_id: admin.org_id,
      url,
      format,
      // #3091: no credential column is written. The signing secret is the Worker
      // secret WEBHOOK_SIGNING_SECRET, and since migration 0163 the column is
      // nullable and never read.
    });
    if (error) {
      redirect(
        `${WEBHOOKS_PAGE}${refusedQuery(writeRefused("The webhook endpoint", error))}`,
      );
    }
  }
  // #3089: where lead contact data is POSTed is the most consequential setting on
  // this page, and changing it left no trace. After the write, so the trail records
  // what happened; host and format only, never the path, the query or a credential.
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "webhook.endpoint_set",
    details: webhookEndpointAuditDetails(existing, { url, format }),
  });
  // #2384: the form is on `/admin/webhooks`, so that is the route to refresh and
  // the route the confirmation lands on. Revalidating `/admin` and returning void
  // left the page the person was looking at redrawing exactly what it showed
  // before they pressed Save, including the old URL and the old key marker, which
  // is #1769 on a different page.
  revalidatePath(WEBHOOKS_PAGE);
  redirect(`${WEBHOOKS_PAGE}${savedQuery("webhook-endpoint")}`);
}

/**
 * Working-hours times snap down to a quarter hour (matching the 15 minute pickers;
 * a safety net if an off-grid value slips through).
 *
 * An UNREADABLE time returns NaN, deliberately, and every caller has to map that to
 * a refusal. It used to coalesce a missing hour to zero, so "not a time" and a blank
 * field both became MIDNIGHT and were saved as a real window: the agent's day
 * silently started at 00:00 and the form reported success (L50). Midnight is a
 * perfectly valid time, so nothing downstream could tell the difference.
 */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.NaN;
  return Math.floor((h * 60 + m) / 15) * 15;
}


/** `toMinutes`, with a named fallback for the one caller whose field is optional. */
function readableMinutes(hhmm: string, fallback: string): number {
  const parsed = toMinutes(hhmm);
  return Number.isFinite(parsed) ? parsed : toMinutes(fallback);
}

export type BusinessHoursFormState = {
  error: string | null;
  /**
   * Set when the save is being HELD for confirmation: the week is valid, but it
   * closes a day that already holds appointments. Re-submitting with `confirm_close`
   * goes through. Distinct from `error` because nothing is wrong; the person just
   * has to see the consequence first.
   */
  confirm?: { message: string } | null;
  ok?: boolean;
  /**
   * Set on a SAVE THAT WENT THROUGH which opened hours no bookable agent covers
   * (#1458). A warning, never a refusal: opening hours ahead of rostering them is
   * a legitimate order of operations, so this says what will happen rather than
   * standing in the way (L54). The roster alarm still notices it later; this
   * reaches the person who caused it, while they are looking at the screen.
   */
  warning?: string | null;
  /**
   * WHICH save this was, so the notice can be derived from what was written
   * rather than asserted over both outcomes (#2219).
   *
   * The date form confirmed a CLOSED date with "Leads see that date straight
   * away", which is the opposite of what closing a date does, and it was the
   * commonest save. A bare `ok: true` cannot tell a component which of the two
   * happened, so the sentence had nothing to be derived from and one claim was
   * written over both (L608).
   *
   * Absent on every outcome that wrote nothing: a refusal, and a close still
   * waiting to be confirmed. Only a real write may produce a notice.
   */
  saved?: { onDate: string; isOpen: boolean } | null;
};

/**
 * Save the org's business hours (#1297).
 *
 * Returns state rather than redirecting so a refusal keeps the typed week on screen
 * (the same reason `submitMyOoo` does), which matters here because the form is
 * twenty-one fields and re-entering them after a bounce would be miserable.
 *
 * Two deliberate behaviours:
 *
 *  * CLOSING A DAY THAT HOLDS APPOINTMENTS WARNS, THEN SAVES. Per Dan's decision the
 *    existing appointments stand and nothing is moved automatically; the person is
 *    told how many there are and confirms. So the first submit comes back as
 *    `confirm`, and the second (carrying `confirm_close`) writes.
 *
 *  * NO MASS INVALIDATION. Unlike the days offered save next door, this does NOT
 *    call `markAllBucketSlotsStale`. Gate 1 filters cached slots against the current
 *    hours at READ time (#1296), so a narrowing takes effect on the next request
 *    without touching a single row. Marking 60+ buckets stale would additionally risk
 *    a false `bucket_slots_stale` page, which is the finding that shaped #1296.
 */
/**
 * Add or replace a date the org is shut (or open), whatever the weekly pattern
 * says (#1363).
 *
 * The confirmation mirrors the weekly editor's, and Dan's decision behind it
 * (#1297): closing a date that already holds appointments WARNS with a count and
 * then saves anyway. Existing appointments stand and nothing moves automatically,
 * because a closure is about what we OFFER from now on, and silently cancelling
 * somebody's call would be a far larger action than the one being taken.
 */
export async function setBusinessHoursException(
  _prev: BusinessHoursFormState,
  form: FormData,
): Promise<BusinessHoursFormState> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") raw[k] = v;

  const parsed = parseExceptionForm(raw);
  if (parsed.errors.length || !parsed.row) return { error: parsed.errors.join(" ") };
  const row = parsed.row;

  if (!row.is_open && !form.get("confirm_close")) {
    // Every future active booking, paged: bookings is a growth table, and a
    // truncated read would under-count and let someone close a date believing it
    // was empty.
    const nowIso = new Date().toISOString();
    const rows = await selectAllPages<{ starts_at: string }>(
      "business hours exception closure check",
      "id",
      () =>
        db
          .from("bookings")
          .select("id, starts_at")
          .in("status", ["confirmed", "rescheduled"])
          .gte("starts_at", nowIso),
    );
    const affected = countBookingsOnDate(rows.map((r) => r.starts_at), BUSINESS_ZONE, row.on_date);
    if (affected > 0) {
      const appts = affected === 1 ? "1 appointment" : `${affected} appointments`;
      return {
        error: null,
        confirm: {
          message: `Closing ${row.on_date} leaves ${appts} already booked. They stay in the diary and nobody is moved. Save again to close that date anyway.`,
        },
      };
    }
  }

  const { error } = await db
    .from("business_hours_exceptions")
    .upsert(
      { ...row, updated_at: new Date().toISOString(), updated_by: admin.id },
      { onConflict: "on_date" },
    );
  if (error) return { error: `Could not save that date: ${error.message}` };

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "org.business_hours_exception",
    details: { on_date: row.on_date, is_open: row.is_open, note: row.note },
  });
  revalidatePath("/admin/business-hours");
  // Reported from the row that was actually written, never from what was posted,
  // so the notice can only ever describe a save that happened.
  return { error: null, ok: true, saved: { onDate: row.on_date, isOpen: row.is_open } };
}

/**
 * Add somebody to the Regal call ignore list (#2090): their calls in Regal are no
 * longer reported while Slate routes no bookings to them.
 *
 * Admin only, like every other alert setting on the page: it suppresses an alert
 * about a named person, so it is a permission rather than a preference. Every rule
 * the picker applied is re-checked here (an agent, not a test user, with a reason),
 * because a posted form is not bound by the options it was drawn with. The write is
 * checked and refused before the audit entry and the saved notice (#2379).
 */
export async function addRegalCallIgnore(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(form.get("user_id") ?? "").trim();
  const reason = String(form.get("reason") ?? "");
  const db = supabaseAdmin();
  const target = userId
    ? (unwrap(
        await db
          .from("users")
          .select(`id, name, email, deactivated_at, ${REAL_ADVISOR_COLUMNS}`)
          .eq("id", userId)
          .maybeSingle(),
        "regal ignore target",
      ) as IgnoreRosterUser | null)
    : null;
  const parsed = parseIgnoreAdd({ userId, reason }, target);
  if (!parsed.ok) redirect(`/admin/alerts${refusedQuery(parsed.error)}#regal-ignores`);

  const { error } = await db
    .from("regal_call_ignores")
    .insert({ ...parsed.row, added_by: admin.id, added_at: new Date().toISOString() });
  if (error) {
    // The primary key is the user, so a second add of the same person is refused
    // by the database rather than quietly replacing the reason somebody wrote.
    const message =
      error.code === "23505"
        ? `${personLabel(target!)} is already on the ignore list.`
        : writeRefused("The ignore list entry", error);
    redirect(`/admin/alerts${refusedQuery(message)}#regal-ignores`);
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "regal.ignore_added",
    targetUserId: parsed.row.user_id,
    details: { reason: parsed.row.reason },
  });
  revalidatePath("/admin/alerts");
  redirect(`/admin/alerts${savedQuery("regal-ignore-added")}#regal-ignores`);
}

/**
 * Take somebody off the Regal call ignore list (#2090), so their calls are
 * reported again. Confirmed on the page first, with the consequence named, because
 * the next call they place while not bookable pages.
 */
export async function removeRegalCallIgnore(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(form.get("user_id") ?? "").trim();
  if (!userId) redirect(`/admin/alerts${refusedQuery("Nobody was named to remove.")}#regal-ignores`);
  const { data, error } = await supabaseAdmin()
    .from("regal_call_ignores")
    .delete()
    .eq("user_id", userId)
    .select("reason");
  if (error) {
    redirect(`/admin/alerts${refusedQuery(writeRefused("The ignore list removal", error))}#regal-ignores`);
  }
  // Nothing deleted means somebody else removed them first; the list redraws
  // without them either way, so it says so rather than claiming this press did it.
  if (!data || data.length === 0) {
    redirect(`/admin/alerts${refusedQuery("They were no longer on the ignore list.")}#regal-ignores`);
  }
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "regal.ignore_removed",
    targetUserId: userId,
    details: { reason: (data[0] as { reason: string }).reason },
  });
  revalidatePath("/admin/alerts");
  redirect(`/admin/alerts${savedQuery("regal-ignore-removed")}#regal-ignores`);
}

/** Drop a date exception, so that date goes back to following the weekly pattern. */
// outcome-ok: the date it removes disappears from the list beside the form, and the add form on the same card draws its own result
export async function removeBusinessHoursException(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const on_date = String(form.get("on_date") ?? "").trim();
  if (!on_date) return;
  const { error } = await supabaseAdmin()
    .from("business_hours_exceptions")
    .delete()
    .eq("on_date", on_date);
  if (error) {
    // Loud rather than a silent no-op: the admin would otherwise see the date
    // vanish from the list on the next render and reappear on the one after.
    log.error("business-hours", { msg: "could not remove date exception", on_date }, error);
    return;
  }
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "org.business_hours_exception_removed",
    details: { on_date },
  });
  revalidatePath("/admin/business-hours");
}

export async function setBusinessHours(
  _prev: BusinessHoursFormState,
  form: FormData,
): Promise<BusinessHoursFormState> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const current = await loadBusinessHoursRows();
  const currentlyOpen = current.filter((r) => r.is_open).map((r) => r.weekday);

  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") raw[k] = v;

  const parsed = parseBusinessHoursForm(raw, { currentlyOpen });
  if (parsed.errors.length) return { error: parsed.errors.join(" ") };

  if (parsed.newlyClosed.length > 0 && !form.get("confirm_close")) {
    // Every future active booking, paged: bookings is a growth table, and a
    // truncated read would under-count and let someone close a day believing it
    // was empty. The count is taken in the org's zone (see countBookingsOnWeekdays).
    const nowIso = new Date().toISOString();
    const rows = await selectAllPages<{ starts_at: string }>(
      "business hours closure check",
      "id",
      () =>
        db
          .from("bookings")
          .select("id, starts_at")
          .in("status", ["confirmed", "rescheduled"])
          .gte("starts_at", nowIso),
    );
    const affected = countBookingsOnWeekdays(
      rows.map((r) => r.starts_at),
      BUSINESS_ZONE,
      parsed.newlyClosed,
    );
    if (affected > 0) {
      const days = parsed.newlyClosed.map((d) => WEEKDAY_NAMES[d]).join(" and ");
      const appts = affected === 1 ? "1 appointment" : `${affected} appointments`;
      return {
        error: null,
        confirm: {
          message: `Closing ${days} leaves ${appts} already booked. They stay in the diary and nobody is moved. Save again to close ${parsed.newlyClosed.length === 1 ? "the day" : "those days"} anyway.`,
        },
      };
    }
  }

  // Seven rows in one upsert, so the week can never be left half-saved.
  const { error } = await db
    .from("business_hours")
    .upsert(parsed.rows, { onConflict: "weekday" });
  if (error) return { error: `Could not save the hours: ${error.message}` };

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "org.business_hours",
    details: {
      week: parsed.rows.map((r) => ({
        weekday: r.weekday,
        is_open: r.is_open,
        start_minute: r.start_minute,
        end_minute: r.end_minute,
      })),
      newly_closed: parsed.newlyClosed,
    },
  });

  revalidatePath("/admin/business-hours");

  // #1458: measured AFTER the write, so it can only ever describe hours that are
  // really saved. Wrapped, because a coverage read that fails must not turn a
  // successful save into an error the admin will try to repeat.
  let warning: string | null = null;
  try {
    const agents = await loadCoverageAgents(db);
    const weekStartIso = currentWeekStartIso();
    const readout = (rows: typeof current) =>
      coverageForWeek({ businessHours: rows, zone: BUSINESS_ZONE, agents, weekStartIso });
    const added = newlyUncoveredGaps(readout(current), readout(parsed.rows));
    // Null is "could not check", which is a different thing from "nothing added"
    // and must not render as silence (L11).
    if (added === null) warning = COVERAGE_UNCHECKED_WARNING;
    else if (added.length > 0) warning = newlyUncoveredWarning(added);
  } catch (err) {
    log.warn("business-hours", { msg: "coverage check after save failed" }, err);
    warning = COVERAGE_UNCHECKED_WARNING;
  }

  return { error: null, ok: true, warning };
}

/** What the webhook test send panel shows after a press (#1951). */
export type WebhookTestState = {
  error: string | null;
  sent: {
    target: string;
    format: WebhookFormat;
    requestBody: string;
    requestHeaders: [string, string][];
    status: number;
    ok: boolean;
    responseBody: string;
    truncated: boolean;
  } | null;
};

/**
 * POST one sample event at a URL the admin pastes (#1951).
 *
 * Dan's ask was for a way to be confident in the shape of what Slate sends, and
 * his call was a REAL request at a scratch endpoint (webhook.site or similar)
 * rather than a preview panel or a send at the configured endpoint. So the
 * mechanics being proved are the real ones: the body and headers come from the
 * same `buildRequest` the live path uses, never a second builder, for the same
 * reason `preview:alerts` and `preview:booker` call the real copy builders (a
 * preview that shows something other than what ships is worse than none,
 * because it is believed).
 *
 * Five things are settled deliberately, and each is stated on the panel too:
 *
 * NOTHING REACHES THE REAL DESTINATION. `testSendTargetError` refuses the
 * configured endpoint's HOST, anything that is not public https, and the private
 * and metadata address ranges, because a URL an operator supplies and the server
 * fetches is a server side request whoever typed it chose the target of.
 *
 * NO REAL LEAD, KEY OR SECRET LEAVES. The body is the sample payload, the
 * Authorization is a placeholder that says so in its own value, and the
 * signature is made with a placeholder secret. See `test-send.ts` for why each.
 *
 * IT IS NOT RECORDED as a delivery. A test in `webhook_deliveries` would skew
 * the delivery log, the dead letter sweep and the resend controls, so it writes
 * no row there, and the panel says so, since a person who cannot find it
 * otherwise assumes the send did not happen. It IS recorded in the audit trail,
 * because an admin making the server fetch an arbitrary address is a privileged
 * action and the trail is where that belongs.
 *
 * THE RESPONSE IS SHOWN, status and body. A tick proves less than a 200 with the
 * echoed body, which is the whole point of pressing it.
 *
 * IT IS RATE LIMITED, keyed on the admin, because it is an outbound fetch to an
 * arbitrary address.
 */
export async function sendTestWebhook(
  _prev: WebhookTestState,
  form: FormData,
): Promise<WebhookTestState> {
  const admin = await requireAdmin();
  const target = String(form.get("target") ?? "").trim();

  const allowed = await allowRequest(
    { kind: "opaque", key: `webhook-test:${admin.id}` },
    WEBHOOK_TEST_SEND_RATE_RULES,
  );
  if (!allowed) {
    return {
      error: "That is a lot of test sends in a short time. Wait a minute and press it again.",
      sent: null,
    };
  }

  // The configured endpoint, read for two things: the format to build in, and
  // the host the test may not be aimed at. `unwrap`, because a failed read
  // resolving to null would drop the collision check, which is the one rule
  // standing between a test send and the live destination (L345).
  // The primary endpoint (#4381), the same row the page shows and its form saves.
  const endpoint = unwrap(
    await readPrimaryWebhookEndpoint(supabaseAdmin(), admin.org_id, "url, format"),
    "sendTestWebhook endpoint",
  ) as { url: string; format: WebhookFormat } | null;

  // Every endpoint's host is refused, not only the primary's (#4381): the dialer's
  // lead sender is a live destination too. `unwrap` for the same reason as above.
  const liveUrls = (
    (unwrap(
      // cap-safe: webhook_endpoints is roster-bounded config, a handful of rows per org.
      await supabaseAdmin().from("webhook_endpoints").select("url").eq("org_id", admin.org_id),
      "sendTestWebhook live endpoints",
    ) ?? []) as { url: string }[]
  ).map((e) => e.url);

  const refusal = testSendTargetError(target, liveUrls);
  if (refusal) return { error: refusal, sent: null };

  const format: WebhookFormat = endpoint?.format ?? "regal";
  const { body, headers } = buildRequest(
    {
      id: "test-send",
      org_id: admin.org_id,
      url: target,
      secret: TEST_SEND_SECRET,
      events: [],
      format,
      auth_header: TEST_SEND_AUTH,
      active: true,
      created_at: new Date().toISOString(),
    },
    // A delivery id shaped like a real one, so a subscriber's dedupe logic can
    // be exercised, but not one that names a real delivery row.
    `test-${crypto.randomUUID()}`,
    "booking.created",
    TEST_SEND_PAYLOAD,
  );

  let status = 0;
  let responseText = "";
  try {
    const res = await fetch(target, {
      method: "POST",
      headers,
      body,
      // A scratch endpoint that never answers must not hold the request open.
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    responseText = await res.text();
  } catch (err) {
    // A failed fetch is the answer, not an exception to swallow: "it did not
    // answer" is a result the person needs, and it is different from a 500.
    log.warn("admin", { msg: "webhook test send failed", host: new URL(target).hostname }, err);
    return {
      error: `Slate could not reach that address: ${shortErrorReason(err)}`,
      sent: null,
    };
  }

  const summary = summariseTestResponse(status, responseText);
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "webhook.test_sent",
    details: { host: new URL(target).hostname, format, status: summary.status },
  });

  return {
    error: null,
    sent: {
      target,
      format,
      requestBody: body,
      requestHeaders: Object.entries(headers),
      status: summary.status,
      ok: summary.ok,
      responseBody: summary.body,
      truncated: summary.truncated,
    },
  };
}

/**
 * Stop or start public booking (#2297). Admin-only.
 *
 * The one control behind the kill switch. It writes a single column on
 * `booking_settings` id=1 and nothing else: the booking route reads that column on
 * every request, so the change is live on the next one, with no deploy and no cache
 * to wait out.
 *
 * The form posts the STATE it wants rather than toggling whatever is stored. Two
 * admins reacting to the same incident within a minute of each other would
 * otherwise leave bookings open while both believed they had stopped them, and this
 * is a control whose entire value is being certain about what it did (L60).
 *
 * Anything that is not an explicit "true" means open, so a stray or malformed
 * submit fails toward taking bookings rather than toward silently taking none. That
 * is the opposite direction from the gate itself, which refuses when it cannot read
 * the flag, and both point the same way: a booker that is down must never be down
 * because of something nobody chose.
 */
export async function setPublicBookingPaused(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const paused = String(form.get("paused") ?? "") === "true";

  // Column-scoped upsert, so pausing bookings cannot also clear the default bucket
  // or the horizon sharing this row. Idempotent: pressing it twice is the same as
  // pressing it once (assume-it-runs-twice).
  const { error } = await db.from("booking_settings").upsert(
    {
      id: 1,
      public_booking_paused: paused,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );
  // #2379: the write is CONSULTED, and the refusal comes before everything that
  // would otherwise report a success. supabase-js does not throw on a statement
  // Postgres refuses, so this awaited and read nothing: the audit entry below
  // recorded the value, the page drew "Online booking is stopped", and the embed
  // kept taking bookings. Both halves of a control matter and only the enforcing
  // one was hardened (L397); this is the arming half.
  //
  // It refuses rather than retrying, and says so on the page the control is on, so
  // whoever pressed it can press it again or reach for the second lever. A control
  // whose whole value is being certain about what it did must never report a
  // certainty it does not have.
  if (error) {
    redirect(
      `/admin/business-hours${refusedQuery(
        // The direction is kept in the sentence, because which way it went is the
        // one thing a reader of this control needs (L60), and "the booking switch"
        // would be the word that appears whatever you pressed.
        writeRefused(
          paused ? "The change to stop online booking" : "The change to start online booking",
          error,
        ),
      )}`,
    );
  }

  // The audit entry carries the VALUE, not just the fact that somebody touched the
  // switch. "Were we taking bookings at 3am" is the only question anybody asks of
  // this record afterwards, and a bare "changed" cannot answer it (L529).
  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { public_booking_paused: paused },
  });

  revalidatePath("/admin/business-hours");
  revalidatePath("/admin");
  redirect(`/admin/business-hours${savedQuery(paused ? "booking-paused" : "booking-resumed")}`);
}

/**
 * Lock or unlock who may frame the booker (#3137). Admin only.
 *
 * Built the way `setPublicBookingPaused` above is, for the same reasons: one column on
 * `booking_settings` id=1 through a column scoped upsert, the STATE the form wants rather
 * than a toggle (L60), the write consulted before anything reports a save (#2379), and
 * an audit entry carrying which way it went (L529). The middleware reads the column
 * through a per isolate cache, so a flip lands within `FRAME_LOCK_TTL_MS`, with no
 * deploy, in both directions.
 *
 * Anything that is not an explicit "true" UNLOCKS. Unlocked is how the booker has
 * always run; a stray submit that locked it would black the booker out on any host
 * not on the allow list, where nobody at Pennie would see the error.
 */
export async function setFrameLock(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const locked = String(form.get("locked") ?? "") === "true";

  const { error } = await supabaseAdmin().from("booking_settings").upsert(
    {
      id: 1,
      frame_lock_enabled: locked,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );
  if (error) {
    redirect(
      `/admin/embedding${refusedQuery(
        writeRefused(locked ? "The change to lock framing" : "The change to unlock framing", error),
      )}`,
    );
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { frame_lock_enabled: locked },
  });

  revalidatePath("/admin/embedding");
  redirect(`/admin/embedding${savedQuery(locked ? "frame-locked" : "frame-unlocked")}`);
}

/**
 * Turn building the booker at page load on or off (#3706). Admin only.
 *
 * Built the way `setFrameLock` above is, for the same reasons: one column on
 * `booking_settings` id=1 through a column scoped upsert, the STATE the form wants rather
 * than a toggle (L60), the write consulted before anything reports a save (#2379), and
 * an audit entry carrying which way it went (L529). `GET /api/embed/config` reads the
 * column through a per isolate cache, so a flip reaches partner pages within
 * `EMBED_PRERENDER_LANDS_SECONDS`, with no deploy, in both directions.
 *
 * Anything that is not an explicit "true" turns it OFF, which is how the embed has always
 * run: the booker loads when a lead taps.
 */
export async function setEmbedPrerender(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const on = String(form.get("on") ?? "") === "true";

  const { error } = await supabaseAdmin().from("booking_settings").upsert(
    {
      id: 1,
      embed_prerender_enabled: on,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );
  if (error) {
    redirect(
      `/admin/embedding${refusedQuery(
        writeRefused(
          on ? "The change to load the booker with the page" : "The change to load the booker on the tap",
          error,
        ),
      )}`,
    );
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { embed_prerender_enabled: on },
  });

  revalidatePath("/admin/embedding");
  redirect(`/admin/embedding${savedQuery(on ? "prerender-on" : "prerender-off")}`);
}

/**
 * Turn the shared confirm line on or off (#3325). Admin only.
 *
 * Built the way `setFrameLock` above is, for the same reasons: one column on
 * `booking_settings` id=1 through a column scoped upsert, the STATE the form wants
 * rather than a toggle (L60), the write consulted before anything reports a save
 * (#2379), and an audit entry carrying which way it went (L529). The confirm path reads
 * the column through a per isolate cache (`shared-line-switch-core.ts`), so a flip
 * lands within `SHARED_LINE_SWITCH_TTL_MS`, with no deploy, in both directions.
 *
 * Anything that is not an explicit "true" turns it OFF. Off is how confirms have always
 * run, each server keeping its own line, so a stray submit lands on the known path.
 */
export async function setSharedConfirmLine(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const on = String(form.get("on") ?? "") === "true";

  const { error } = await supabaseAdmin().from("booking_settings").upsert(
    {
      id: 1,
      shared_confirm_line: on,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    },
    { onConflict: "id" },
  );
  if (error) {
    redirect(
      `/admin/business-hours${refusedQuery(
        writeRefused(
          on ? "The change to turn the shared confirm line on" : "The change to turn the shared confirm line off",
          error,
        ),
      )}`,
    );
  }

  await recordAudit({
    orgId: admin.org_id,
    actorId: admin.id,
    action: "booking.settings",
    details: { shared_confirm_line: on },
  });

  revalidatePath("/admin/business-hours");
  redirect(`/admin/business-hours${savedQuery(on ? "shared-line-on" : "shared-line-off")}`);
}

/**
 * Let scheduling coordinators book a call nobody is free for on Marcia, or stop them
 * (#4264, `booking_settings.placeholder_booking_enabled`, migration 0207). SUPER ADMIN only.
 *
 * WHO: `requireSuperAdmin`, checked here, never trusted to the page hiding the button
 * (D2 in docs/design/coordinator-admin.html). WHOSE DATA: the one org wide settings row.
 *
 * Built the way `setSharedConfirmLine` above is: one column on `booking_settings` id=1
 * through a column scoped upsert, the STATE the form wants rather than a toggle (L60), the
 * write consulted before anything reports a save (#2379), and an audit entry carrying which
 * way it went (L529). The booking path reads the column on every coordinator booking
 * (`readPlaceholderBookingEnabled`), so a flip lands on the next one.
 *
 * Anything that is not an explicit "true" turns it OFF. Off is the default and the safe
 * side: nothing is put on Marcia, and a stray submit must never be what starts that.
 */
export async function setPlaceholderBookingEnabled(form: FormData): Promise<void> {
  const actor = await requireSuperAdmin();
  const on = String(form.get("on") ?? "") === "true";

  const { error } = await supabaseAdmin().from("booking_settings").upsert(
    {
      id: 1,
      placeholder_booking_enabled: on,
      updated_at: new Date().toISOString(),
      updated_by: actor.id,
    },
    { onConflict: "id" },
  );
  if (error) {
    // The direction stays in the sentence, in the button's own words (L60, L399).
    redirect(
      `${COORDINATOR_BOOKING_HREF}${refusedQuery(
        writeRefused(
          on
            ? `The change to ${lowerFirst(COORDINATOR_BOOKING_COPY.switch.turnOn)}`
            : `The change to ${lowerFirst(COORDINATOR_BOOKING_COPY.switch.turnOff)}`,
          error,
        ),
      )}`,
    );
  }

  await recordAudit({
    orgId: actor.org_id,
    actorId: actor.id,
    action: "booking.settings",
    details: { placeholder_booking_enabled: on },
  });

  revalidatePath(COORDINATOR_BOOKING_HREF);
  redirect(`${COORDINATOR_BOOKING_HREF}${savedQuery(on ? "placeholder-on" : "placeholder-off")}`);
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Take a scheduling coordinator's access away (#4264, D12). SUPER ADMIN only.
 *
 * Team access GRANTS access and never removes it; a staff member's access is removed by
 * departing them, which is what `setUserLifecycle` does from an advisor's page. A
 * coordinator has no such page (the real advisor rule keeps them off every advisor
 * screen), so this is that same removal for them, through the same one path,
 * `applyLifecycleByUserId(id, "deactivate")`: it stamps `deactivated_at` through
 * `writeRoutableState` and bans their Supabase sign in. So a removed coordinator is
 * refused on their very next request (`gateSessionRow` in `realCurrentUser`, which the
 * coordinator page's own gate reads) and at sign in (`DeactivatedAccountError`).
 *
 * Their role is left as coordinator, so removing them can never make them an advisor,
 * and no coverage sweep is asked for: the calls a coordinator booked sit with the
 * advisors they booked them with, and stay.
 *
 * WHOSE DATA: only a coordinator in the caller's own org; anybody else is refused by name
 * before anything is written, so this can never depart an advisor or an admin.
 */
// outcome-ok: the person's row leaves the list on this page, under a notice saying what Remove did
export async function removeCoordinator(form: FormData): Promise<void> {
  const actor = await requireSuperAdmin();
  const userId = String(form.get("user_id") ?? "");
  const refuse = (reason: string): never => redirect(`${COORDINATOR_BOOKING_HREF}${refusedQuery(reason)}`);
  if (!userId) refuse("No coordinator was named, so nothing was changed. Reload the page and try again.");

  // cap-safe: single-row primary-key lookup.
  const { data, error: lookupError } = await supabaseAdmin()
    .from("users")
    .select("id, org_id, role, name, email, deactivated_at")
    .eq("id", userId)
    .maybeSingle();
  if (lookupError) {
    log.error("admin-actions", { msg: "coordinator removal lookup failed", user_id: userId }, lookupError);
    refuse("Slate could not check who that is, so nobody's access changed. Try again in a moment.");
  }
  const target = data as Pick<User, "id" | "org_id" | "role" | "name" | "email" | "deactivated_at"> | null;
  if (!target || target.org_id !== actor.org_id || target.role !== "coordinator") {
    refuse("That person is not a coordinator here, so nothing was changed.");
  }
  const who = target!.name?.trim() || target!.email;

  let result: Awaited<ReturnType<typeof applyLifecycleByUserId>>;
  try {
    result = await applyLifecycleByUserId(userId, "deactivate");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    refuse(writeRefused(`Removing ${who}`, { message }));
  }
  if (result!.status === "not_found") refuse("That person is not a coordinator here, so nothing was changed.");

  // After the change, and only when it changed something: a second press on somebody
  // already removed is a no-op and records nothing, as `setUserLifecycle` does.
  if (result!.status === "applied") {
    await recordAudit({
      orgId: actor.org_id,
      actorId: actor.id,
      action: "agent.deactivate",
      targetUserId: userId,
      details: {
        deactivated: { from: false, to: true },
        role: "coordinator",
        via: "coordinator_booking",
        // A ban that did not land is recorded: the session gate refuses them anyway, and
        // this is the fact somebody reading the trail would need.
        ...(result!.sessionRevoke ? { session_revoke: result!.sessionRevoke } : {}),
      },
    });
  }
  revalidatePath(COORDINATOR_BOOKING_HREF);
  redirect(`${COORDINATOR_BOOKING_HREF}${savedQuery("coordinator-removed")}`);
}

/**
 * Refresh every advisor photo from the Google directory now (#3027): the same run
 * the daily lane makes, with its guards, alerts and verdict, for rollout and for
 * whenever an admin wants the roster current without waiting for the morning.
 *
 * WHO: admins only, checked here on the server. WHOSE DATA: the org's own staff
 * photos, read from the org's own directory. The outcome comes back to the roster
 * (L608), as counts and never names, since it travels in the address.
 */
export async function refreshAdvisorPhotosNow(): Promise<void> {
  await requireAdmin();
  const back = "/admin/agents";
  // The run and the redirects are kept apart: a redirect is thrown, so one inside
  // the try would be caught below and reported as a failure.
  let query: string;
  try {
    query = photoOutcomeQuery(photoOutcome(await runAdvisorPhotoLane("manual"), "all"), "photos");
  } catch (err) {
    log.error("advisor-photos", { msg: "manual refresh failed" }, err);
    query = photoOutcomeQuery({ code: "run-failed" }, "photos");
  }
  revalidatePath(back);
  redirect(`${back}?${query}`);
}

/**
 * "Refresh from Google" on one agent's page (#3027), so a photo fixed in Google
 * Admin shows the same minute. Admins only, server side. It never touches the
 * daily alerts or the verdict: one person's answer says nothing about the roster.
 * The outcome goes back as a code, never as words (see `photoOutcomeQuery`).
 */
export async function refreshAdvisorPhotoFor(form: FormData): Promise<void> {
  await requireAdmin();
  const userId = String(form.get("user_id") ?? "").trim();
  if (!userId) {
    redirect(`/admin/agents?${photoOutcomeQuery({ code: "unknown-user" }, "photos")}`);
    return;
  }
  const back = `/admin/agents/${encodeURIComponent(userId)}`;
  let query: string;
  try {
    query = photoOutcomeQuery(photoOutcome(await refreshOnePhoto(userId), "one"), "photo");
  } catch (err) {
    log.error("advisor-photos", { msg: "one photo refresh failed" }, err);
    query = photoOutcomeQuery({ code: "run-failed" }, "photo");
  }
  revalidatePath(back);
  revalidatePath("/admin/agents");
  redirect(`${back}?${query}`);
}
