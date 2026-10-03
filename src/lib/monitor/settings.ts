import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { MonitorAlertConfig, MonitorSettings } from "@/lib/db/types";
import type { FloorOverride, FloorPolicy, VolumeBaseline } from "./volume-floors.ts";
import { MEASURED_VOLUME_BASELINE } from "./volume-baseline.ts";
import { baselineInForce, tierJudgedBaseline } from "./volume-relearn.ts";
import { LOW_TIER, VOLUME_TIERS, type VolumeTier } from "./volume-tiers.ts";
import { REAL_ANCHOR_SOURCE, type AnchorSource } from "./carried-share.ts";

/**
 * UI-tunable monitor alert settings (#571). Cooldowns and low-volume floors are
 * read from a store at runtime with precedence store > env > coded default. An
 * EMPTY store (no row, no stored value) falls through to the defaults; an
 * UNREADABLE one never does (#2773), because every armed switch defaults to off
 * and a failed read would silently disarm them. The pure resolvers own precedence
 * and validation; `loadMonitorSettings` is the DB read around them, and it throws.
 */

/**
 * Every monitor alert key, and the ONLY list of them: `MonitorAlertKey` is derived
 * from it rather than written beside it. Until 2026-09-24 they were two lists, and
 * `catchall_rate` reached the type without reaching this array, so the cooldown
 * resolver never visited it, its cooldown came back undefined, and its page went
 * out on every five minute tick. With one list, a key missing here is not a key at
 * all, and `tsc` fails every default, field and call site that names it.
 */
export const ALERT_KEYS = [
  "availability_data_anomaly",
  "availability_booked_solid",
  "fallback_covered_availability",
  "low_booking_volume",
  "thin_tier_staffing",
  "agents_without_schedule",
  "agents_without_routing",
  "migration_version_lag",
  "sync_staleness",
  "inactive_agent_bookings",
  "coverage_needs_human",
  "ooo_coverage_gap",
  "ooo_calcom_unprotected",
  "empty_tier",
  "booking_failure_rate",
  "catchall_rate",
  "availability_drift",
  "booker_empty_reason",
  "roster_coverage_gap",
  "roster_coverage_upcoming_gap",
  "ooo_protection_lost",
  "webhook_event_no_subscriber",
  "edge_limiter_unusable",
  "definer_grants_to_web_roles",
  "hydration_all_failing",
  "calendar_window_uncovered",
  "schedule_parity_drift",
  "agents_on_unset_hours",
  "agents_awaiting_activation",
  "agents_stranded_outside_pool",
  "departed_sessions_unconverged",
  "booking_below_lead_tier",
  "cross_system_booking",
  "regal_call_unroutable",
  "regal_calls_quiet",
  "regal_calls_unreadable",
  "regal_call_outcomes_short",
  "handoff_channel_unset",
  "handoff_undelivered",
  "main_not_deployed",
  "ci_runs_refused",
  "public_booking_stopped",
  "retired_booking_key",
  "advisor_photos_unread",
  "advisor_photos_held",
  "csp_violation",
] as const;

export type MonitorAlertKey = (typeof ALERT_KEYS)[number];

/**
 * The admin settings screen's cooldown fields, one per alert key. Kept beside
 * ALERT_KEYS rather than in the page so the two cannot drift: a key with no field
 * is a cooldown nobody can tune, and a field with no key is a control that does
 * nothing. A test asserts they stay in lockstep.
 */
/**
 * How loud an alert is, loudest first (#1955).
 *
 * Dan on the cooldowns section: "I hate everything about this. we can do so much
 * better than this design." One of the six faults was that it gave no sense of
 * which of these matter, while every `help` sentence said so in a word a reader
 * had to parse row by row. This is that word, as a FACT the section can group by
 * rather than something read back out of the prose (L192).
 *
 * The order is the order the section renders in, so a page is never below a
 * whisper. `settings.test.ts` holds every field to carrying one, holds every
 * level to being used, and holds each field's level to agreeing with its own
 * description, so the two cannot drift apart.
 */
export const ALERT_URGENCY_ORDER = ["page", "alert", "notice", "whisper"] as const;

export type AlertUrgency = (typeof ALERT_URGENCY_ORDER)[number];

/** What each level means, for the group heading. */
export const ALERT_URGENCY_COPY: Record<AlertUrgency, { label: string; meaning: string }> = {
  page: {
    label: "Pages",
    meaning: "Somebody is expected to act now.",
  },
  alert: {
    label: "Alerts",
    meaning: "Needs acting on, but not this minute.",
  },
  notice: {
    label: "Notices",
    meaning: "Worth knowing. Usually nothing is wrong.",
  },
  whisper: {
    label: "Whispers",
    meaning: "Logged for whoever goes looking.",
  },
};

export const ALERT_FIELDS: {
  key: MonitorAlertKey;
  label: string;
  help: string;
  /** REQUIRED, so `tsc` names a field added later with no level. */
  urgency: AlertUrgency;
}[] = [
  {
    key: "availability_data_anomaly",
    urgency: "page",
    label: "Data-anomaly page cooldown",
    help: "The cache disagrees with the calendars.",
  },
  {
    key: "availability_booked_solid",
    urgency: "notice",
    label: "Booked-solid notice cooldown",
    help: "Agents are genuinely full.",
  },
  {
    key: "fallback_covered_availability",
    urgency: "notice",
    label: "Fallback-covered notice cooldown",
    help: "A thin tier is covered by the fallback.",
  },
  {
    key: "low_booking_volume",
    urgency: "alert",
    label: "Low-volume alert cooldown",
    help: "Bookings in a window fell below the floor.",
  },
  {
    key: "thin_tier_staffing",
    urgency: "notice",
    label: "Thin-tier staffing cooldown",
    help: "A tier rests on 1 to 2 bookable agents.",
  },
  {
    key: "agents_without_schedule",
    urgency: "whisper",
    label: "Schedule-less agent cooldown",
    help: "A bookable agent's working hours schedule could not be auto created.",
  },
  {
    key: "agents_without_routing",
    urgency: "whisper",
    label: "Unroutable agent cooldown",
    help: "A bookable agent has no routing attributes and no manual bucket membership, so they match no bucket.",
  },
  {
    key: "migration_version_lag",
    urgency: "page",
    label: "Migration-lag page cooldown",
    help: "The live database is missing a migration the deployed code ships.",
  },
  {
    key: "sync_staleness",
    urgency: "alert",
    label: "Sync-staleness alert cooldown",
    help: "A bookable agent has not been calendar-synced for too long (the rotation is falling behind).",
  },
  {
    key: "inactive_agent_bookings",
    urgency: "alert",
    label: "Orphaned-appointment alert cooldown",
    help: "An agent who has left the booking pool (deactivated or not bookable) still holds future appointments, so those customers are booked with nobody.",
  },
  {
    key: "coverage_needs_human",
    urgency: "alert",
    label: "Stranded-appointment alert cooldown",
    help: "A coverage sweep could not move an appointment and gave up, so it is still with an agent who will not be there and only a person can place it.",
  },
  {
    key: "ooo_coverage_gap",
    urgency: "page",
    label: "Time off nobody has covered",
    help: "An agent on approved time off still holds an appointment starting within 48 hours that no coverage sweep has picked up, so that customer is booked with somebody who will not be there.",
  },
  {
    key: "calendar_window_uncovered",
    urgency: "page",
    label: "Calendar refresh not covering the booking window",
    help: "A bookable agent's calendar has not been refreshed far enough ahead to cover the days the booker offers, so a lead could book an hour that calendar already has taken.",
  },
  {
    key: "schedule_parity_drift",
    urgency: "alert",
    label: "Slate and cal.com disagree about the roster",
    help: "The daily comparison found an agent the two systems hold different working hours, days, timezone or pool membership for. While both systems are live this changes who a lead is booked with, or when, and nothing inside Slate can see it: a stored week is valid whether or not it matches the one the agent keeps. It stops once cal.com is marked retired, lower down these settings.",
  },
  {
    key: "agents_on_unset_hours",
    urgency: "alert",
    label: "Agents offered on hours nobody set",
    help: "A bookable agent has spent more than two days on the seeded default working week, so leads are offered times that are right only by coincidence. The first two days are silent, because every new hire starts on the seeded week and ordinary onboarding sets their real hours. It ends when their hours are set by them, an admin, or the cal.com import.",
  },
  {
    key: "agents_awaiting_activation",
    urgency: "alert",
    label: "Agents waiting to become bookable",
    help: "Somebody the roster counts as working has sat outside the booking pool for more than four hours, so no lead is ever offered their diary. The first four hours are silent, because the hourly roster sync retries on its own and an ordinary Google blip clears inside them. It ends when the activation succeeds or somebody decides either way.",
  },
  {
    key: "agents_stranded_outside_pool",
    urgency: "alert",
    label: "Agents nothing will ever add to the pool",
    help: "Somebody on the Sales profile has signed in and their calendar syncs, and they are not bookable with no activation pending and nobody on record holding them back. Nothing retries them, so they stay out of every pool until a person acts. It is checked every 5 minutes, and ends when they are made bookable or tagged Redistribute in Twilio.",
  },
  {
    key: "departed_sessions_unconverged",
    urgency: "alert",
    label: "Sign in access not following the roster",
    help: "Every hourly roster run bans everybody who has left from renewing a sign in, and lifts that ban from anybody active again. This fires when two runs in a row could not do it: the account list could not be read or came back partial, a ban was refused, or somebody active is still locked out. A backlog the run leaves for the next hour does not count. It ends when a run completes cleanly.",
  },
  {
    key: "booking_below_lead_tier",
    urgency: "alert",
    label: "A lead booked with a team below their tier",
    help: "An upcoming call is with a team below the tier Salesforce gives the lead today, for example an Ultra High lead booked with the Low team. It is checked every 5 minutes against the lead's current score, so a lead scored higher after booking is caught too. Each call pages on its own, and ends when the call moves to the right team, the score comes down, or the call is cancelled.",
  },
  {
    key: "cross_system_booking",
    urgency: "alert",
    label: "A lead booked in both Slate and cal.com",
    help: "A lead holds an upcoming call in Slate and another in cal.com, so two advisors expect them. It is checked once an hour while cal.com is live, matching on the Salesforce Submission or the lead's email address. Each Slate booking pages on its own, naming both bookings, and ends when either call is cancelled or its time comes. It stops once cal.com is marked retired, lower down these settings.",
  },
  {
    key: "regal_call_unroutable",
    urgency: "alert",
    label: "Agent calling in Regal while not bookable",
    help: "Somebody Slate routes no bookings to (their bookable switch is off, or they are deactivated) has placed a call in Regal, so the routing pool is a person short while they work. One message per person per cooldown. It ends when they are bookable again, or when they are added to the ignore list below, which is a suppression rather than a fix.",
  },
  {
    key: "regal_calls_quiet",
    urgency: "alert",
    label: "No call from Regal all business day",
    help: "Not one call by a Slate user reached Slate from Regal across the whole of the last business day, so the check above had nothing to judge. Either nobody worked the phones or Regal stopped posting. It ends when the next call from a Slate user arrives.",
  },
  {
    key: "regal_calls_unreadable",
    urgency: "alert",
    label: "Regal call events Slate cannot read",
    help: "Regal posted call events in the last day that were missing a field Slate needs, so they were invisible to the check above. Usually means Regal changed what it sends. It ends after a whole day of readable events.",
  },
  {
    key: "regal_call_outcomes_short",
    urgency: "alert",
    label: "Regal calls missing from the show rate",
    help: "Fewer than 80% of the completed calls Regal posted in the last two hours were stored with their lead and talk time, on two checks running. The show rate in the Slate vs cal.com split is computed from those calls, so every missing one is a show or no show it cannot see. It ends when a two hour window is back at 80% or more.",
  },
  {
    key: "ooo_calcom_unprotected",
    urgency: "alert",
    label: "Time off not blocked in cal.com",
    help: "An agent is on approved time off right now with no cal.com block in place, so cal.com can still book them while they are away. It stops once cal.com is marked retired, lower down these settings.",
  },
  {
    key: "availability_drift",
    urgency: "page",
    label: "Offered times that are not really free",
    help: "The times a bucket is offering turn out to be already busy on every eligible agent's real calendar, so customers would be refused at the last step.",
  },
  {
    key: "booking_failure_rate",
    urgency: "page",
    label: "Customers failing to book",
    help: "The share of booking attempts that fail over a rolling window crosses the threshold, so a wave of customers being turned away is caught as it happens rather than by complaints.",
  },
  {
    key: "catchall_rate",
    urgency: "page",
    label: "Leads booked with no routing code",
    help: "Too many of the last day's bookings arrived without a usable routing code and went to the Low pool, so a lead whose real tier was higher may be with the wrong team.",
  },
  {
    key: "booker_empty_reason",
    urgency: "page",
    label: "Booker cannot say why a week is empty",
    help: "The booker has no times to offer and cannot tell whether we are closed or fully booked, so a lead is shown a vague message instead of the reason.",
  },
  {
    key: "roster_coverage_gap",
    urgency: "page",
    label: "Advertised hours nobody is rostered for",
    help: "Inside the booking horizon, the org's business hours include time no agent is scheduled to work, so a lead is offered nothing during hours we say we are open. Saturday hours are never checked, and nothing is sent on a Sunday.",
  },
  {
    key: "roster_coverage_upcoming_gap",
    urgency: "alert",
    label: "Upcoming hours nobody is rostered for",
    help: "In the week past the booking horizon, the org's business hours include time no agent is scheduled to work. No lead can book it yet, so there is time to change someone's hours or find cover. Saturday hours are never checked, and nothing is sent on a Sunday.",
  },
  {
    key: "ooo_protection_lost",
    urgency: "page",
    label: "Approved time off no longer blocked",
    help: "An approved time off has no calendar event and no cached busy time covering it, so a lead can be booked into hours the agent is away.",
  },
  {
    key: "webhook_event_no_subscriber",
    urgency: "page",
    label: "Booking event nobody is subscribed to",
    help: "A booking event Slate sends has no active webhook endpoint subscribed to it, so the delivery is recorded and reaches no downstream system.",
  },
  {
    key: "edge_limiter_unusable",
    urgency: "page",
    label: "Request rate limits not being enforced",
    help: "The running deployment cannot use its request rate limits, so the public endpoints are open to unlimited traffic from one source. Clears itself once they are enforced again.",
  },
  {
    key: "definer_grants_to_web_roles",
    urgency: "page",
    label: "A privileged database function open to the web",
    help: "A database function that runs with its owner's privileges can be executed by an unauthenticated caller, so it is reachable from outside without a login. Clears itself once the grant is taken back.",
  },
  {
    key: "hydration_all_failing",
    urgency: "page",
    label: "Calendar refresh failing on every calendar",
    help: "The daily calendar refresh has failed on every calendar it tried, several runs in a row. Bookings are unaffected while this lasts; what stops is the cached cover being renewed.",
  },
  {
    key: "handoff_channel_unset",
    urgency: "page",
    label: "Booking handoffs with nowhere to go",
    help: "A booking is waiting on somebody in sales, such as a double booking Slate would not cancel, and no handoff channel is set, so nobody has been told. Ends when the channel is set or nothing is waiting.",
  },
  {
    key: "handoff_undelivered",
    urgency: "page",
    label: "Booking handoffs not reaching sales",
    help: "A booking handoff has waited more than 30 minutes without being posted to the handoff channel, so the sales team has not been told. Ends once every open handoff has been posted.",
  },
  {
    key: "empty_tier",
    urgency: "alert",
    label: "Debt tier offering no times",
    help: "A whole debt tier (Low, Medium, High, Very High or Ultra High) is offering no booking time before the end of the next working day, either because nobody is assigned to it or because every agent on it is full. Leads asking for that tier are served by a lower tier meanwhile. A bucket or backend inside a tier that is still offering times is not reported.",
  },
  {
    key: "main_not_deployed",
    urgency: "page",
    label: "Merged work that is not live",
    help: "The site is serving an older commit than main's tip, long after that commit landed. The usual cause is a run that was cancelled before it reached the deploy job, with nothing merged after it to carry the work live.",
  },
  {
    key: "public_booking_stopped",
    urgency: "alert",
    label: "Online booking left stopped",
    help: "The kill switch that stops Slate taking public bookings has been on for longer than the incident lever is meant to be held for. Nothing is broken: somebody turned it off deliberately and it asks whether that is still intended. It ends by itself when booking is started again.",
  },
  {
    key: "advisor_photos_unread",
    urgency: "alert",
    label: "Advisor photos not refreshed",
    help: "The daily read of advisor photos from the Google directory measured nothing, so leads and the roster keep the photos from the last good day. Says which of the causes it was.",
  },
  {
    key: "advisor_photos_held",
    urgency: "notice",
    label: "Advisor photos held for a person",
    help: "The daily photo read worked and held something back: a wave of removed photos, one image too many people share, somebody unreadable for three days, or somebody Google's directory does not hold.",
  },
  {
    key: "retired_booking_key",
    urgency: "page",
    label: "A retired booking key still in use",
    help: "A request presented a booking API key that has been retired, so it was refused. Whoever still holds it is being turned away on every call, which can leave a lead on a broken page. Repeats for each retired key and each kind of host the calls come from.",
  },
  {
    key: "csp_violation",
    urgency: "page",
    label: "Something blocked on a page by the content security policy",
    help: "A browser refused something on a Slate page because the content security policy does not allow it, so part of that page did not load for whoever had it open. Repeats for each kind of rule broken.",
  },
  {
    key: "ci_runs_refused",
    urgency: "page",
    label: "CI runs refused before they start",
    help: "GitHub is failing workflow jobs without running them, so every check goes red in about two seconds with no log behind it. While it lasts nothing automatic is watching main, because the push guard is a workflow too.",
  },
];

// Coded defaults (the pre-#571 compile-time constants). Cooldowns in ms.
export const MONITOR_DEFAULTS = {
  cooldownMs: {
    availability_data_anomaly: 30 * 60_000,
    availability_booked_solid: 6 * 60 * 60_000,
    fallback_covered_availability: 6 * 60 * 60_000,
    low_booking_volume: 30 * 60_000,
    // Proactive staffing nudge (#569): a slow, once-a-day whisper. Staffing
    // changes over days, so a long cooldown keeps it from repeating every tick.
    thin_tier_staffing: 24 * 60 * 60_000,
    // Schedule-coverage gap (#838): the check self-heals first, so an alert means
    // the fill is broken and persists until a human acts. Once-a-day whisper, like
    // the thin-tier nudge; the settings screen can tighten it.
    agents_without_schedule: 24 * 60 * 60_000,
    // Routing-attribute gap (#226): a staffing/config gap that persists until a
    // human sets attributes or adds a manual member. Once-a-day whisper, like the
    // schedule-coverage and thin-tier nudges; the settings screen can tighten it.
    agents_without_routing: 24 * 60 * 60_000,
    // Leads arriving with no usable routing code (#1908). Repeats hourly while it
    // persists: the cause is an upstream page building links without an xbc, which
    // stays broken until somebody fixes that page, and every hour it runs is more
    // leads booked with the wrong team.
    catchall_rate: 60 * 60_000,
    // Schema behind the deployed code (#516). Repeats hourly while it persists:
    // it stays broken until a human runs db push, and a dormant schema gap has
    // twice gone unnoticed for a whole session, so it should keep asking.
    migration_version_lag: 60 * 60_000,
    // Sync-staleness (#241): the rotation being behind persists until the roster
    // shrinks or a stuck agent is fixed, so repeat while it lasts. Hourly, like the
    // migration-lag page; the settings screen can tighten it.
    sync_staleness: 60 * 60_000,
    // Orphaned appointments (#1215): a customer booked with an agent who has left
    // stays wrong until a human reassigns, and it only pages after an hour of the
    // gap standing open, so repeat while it lasts. Hourly, like the two above.
    inactive_agent_bookings: 60 * 60_000,
    // Stranded appointments (#1242): the sweep has already given up, so the state
    // is terminal and stays wrong until a human places it. Repeat while it lasts,
    // hourly, like the orphaned-appointment page it sits beside.
    coverage_needs_human: 60 * 60_000,
    // An approved absence nobody has covered (#1238): the appointment is inside two
    // days, no sweep is on it, and nothing repairs it on its own, so it stays wrong
    // until a person places it. Hourly, like the two coverage pages it sits beside.
    ooo_coverage_gap: 60 * 60_000,
    // Time off not blocked in cal.com (#1253): the agent is away NOW and cal.com can
    // still book them, and the sweep is already retrying every 5 minutes, so a
    // shorter repeat than its neighbours. Half an hour keeps it present without
    // becoming the thing people mute.
    ooo_calcom_unprotected: 30 * 60_000,
    // A bookable agent's calendar no longer hydrated past the booking horizon
    // (#1262): stays wrong until the rotation reaches it or someone fixes the
    // account, so it repeats hourly like the coverage pages it sits beside.
    calendar_window_uncovered: 60 * 60_000,
    // Slate against cal.com drift (#2031). The sweep runs once a day, so anything
    // under a day cannot make it repeat and anything over it silences a day's
    // findings. A day means at most one page per sweep while drift sits unfixed,
    // which is the point: it is real, it is actionable, and it is invisible
    // anywhere else. Turn it up on the settings screen if a known drift is being
    // lived with, rather than muting the check.
    schedule_parity_drift: 24 * 60 * 60_000,
    // Hours nobody set (#1753): a slow condition that ends when a person or the
    // import writes the week, so once a day, like the other staffing nudges.
    agents_on_unset_hours: 24 * 60 * 60_000,
    // Waiting to become bookable (#2318). Six hours, which is longer than the four
    // hour window it reports on: the repair is somebody granting Calendar in Google
    // Workspace or looking at a sync error, which takes a working morning rather
    // than minutes, and a cooldown shorter than the grace would repeat the same
    // names before anything could have changed.
    agents_awaiting_activation: 6 * 60 * 60_000,
    // Stranded outside the pool (#2481). Six hours, like the waiting page beside it:
    // the repair is a person pressing one button on an agent page, which happens
    // inside a working morning, and the state costs leads every hour it stands.
    agents_stranded_outside_pool: 6 * 60 * 60_000,
    // Sign in access not following the roster (#2459). Six hours, matching the
    // roster sync's own failure pages: it is judged hourly and only after two
    // unhealthy runs, so a shorter cooldown could not repeat any sooner, and a
    // longer one would leave somebody locked out without a reminder all day.
    departed_sessions_unconverged: 6 * 60 * 60_000,
    // Below the lead's tier (#2593), per booking. Six hours: the repair is a person
    // reassigning one call, and calls are usually booked a day or more ahead, so a
    // reminder inside the same working day is worth its noise while a repeat every
    // tick would not be. Each booking has its own key, so a second booking pages at
    // once however recently the first did.
    booking_below_lead_tier: 6 * 60 * 60_000,
    // A lead booked in both Slate and cal.com (#2933), per Slate booking. Six hours,
    // like the below tier page beside it: the repair is a person cancelling one call,
    // usually booked a day ahead, so a reminder inside the working day earns its
    // noise. The check runs hourly, so nothing shorter than an hour could repeat.
    cross_system_booking: 6 * 60 * 60_000,
    // Calling in Regal while not bookable (#2090): one page per agent per day,
    // decided by Dan on 2026-09-08. The repair is a person deciding about a
    // person, which does not happen inside an hour, and a day is also the rhythm
    // of the condition itself: an agent working a shift they are not bookable for
    // calls all day long.
    regal_call_unroutable: 24 * 60 * 60_000,
    // No call from a Slate user all business day (#2090). It is judged after the
    // day has closed, so it can only change once a day: anything shorter repeats
    // a sentence about a day that has not changed.
    regal_calls_quiet: 24 * 60 * 60_000,
    // Unreadable Regal events (#2090). Six hours: a changed payload blinds the
    // detector for every call until somebody updates the edge, which is worth
    // repeating within a working day, and it clears on a day of readable traffic.
    regal_calls_unreadable: 6 * 60 * 60_000,
    // Calls missing from the show rate (#2944). Two hours, the window it is judged
    // over: a repeat inside one window restates the same calls, and every window
    // that passes unfixed loses calls the split can only get back by a backfill.
    regal_call_outcomes_short: 2 * 60 * 60_000,
    // Routing dead zone (#327): unchanged from the constant this replaced. A bucket
    // with nobody stays wrong until someone is staffed onto it, so it repeats while
    // it lasts, six-hourly. Tunable since a deliberately dark roster (#1272) turned
    // it into sixty messages a wave with no way to quiet it.
    // Debt tier offering no times (#2505). Six hours, inherited from the per
    // bucket page it replaces: the repair is a staffing or calendar change that
    // takes hours rather than minutes, and a tighter cooldown would repeat the
    // same finding through one working morning.
    empty_tier: 6 * 60 * 60_000,
    // Customers being turned away (#1313): an active outage costing bookings by
    // the minute, so it repeats faster than the staffing nudges. Half an hour is
    // long enough not to spam a live incident, short enough that a page missed at
    // the start of a wave comes back while it is still happening.
    booking_failure_rate: 30 * 60_000,
    // A drifted cache (#1315) keeps mis-selling times until the sync lane
    // reconverges, and the probe re-measures that bucket only once per rotation
    // (a few hours), so a fast repeat would say nothing new. Hourly, matching the
    // other conditions that persist until something is fixed.
    availability_drift: 60 * 60_000,
    // The booker unable to explain an empty week (#1420) is a config read that
    // stays broken until somebody fixes it, and the lane re-measures it every
    // minute, so a fast repeat would say nothing new. Hourly, matching the other
    // conditions that persist until something is fixed.
    booker_empty_reason: 60 * 60_000,
    // An advertised hour nobody covers (#1454) is not a fault that clears itself:
    // it ends when somebody edits a roster or the org's week, which is a staffing
    // decision measured in days, not a service that recovers. Hourly here would
    // repeat the same unchanged sentence twenty four times before anyone could
    // act on it, which is how a pager gets muted (L36). Daily.
    roster_coverage_gap: 24 * 60 * 60_000,
    // The same gap a week out (#1936): nothing is broken yet, and the lead time is
    // STAFFING_LEAD_DAYS (7). Every three days says it about twice before the day
    // crosses into the horizon, where the live key above takes over at its daily
    // pace; daily here would restate an unchanged, not yet urgent fact seven times,
    // which is the repetition that gets a channel muted (L36).
    roster_coverage_upcoming_gap: 3 * 24 * 60 * 60_000,
    // Approved time off blocking nothing (#1467): the agent is away and a lead can
    // be booked into those hours right now, and nothing repairs it on its own (the
    // request still records the block as written, so no retry acts on it). It stays
    // wrong until a person opens the request, so repeat while it lasts. Hourly,
    // like the orphaned and stranded appointment pages it sits beside.
    ooo_protection_lost: 60 * 60_000,
    // An event reaching nobody (#1459) persists until a person updates the
    // endpoint's events array, which is a database edit no deploy will do. Repeat
    // daily rather than hourly: the fix is not urgent to the minute, and the state
    // can legitimately last as long as the person who has to make that edit is away.
    webhook_event_no_subscriber: 24 * 60 * 60_000,
    // The request ceilings being off (#1529) persists until a deploy puts them back, and
    // nothing self-heals it, so repeat while it lasts. Hourly rather than daily: unlike an
    // unsubscribed webhook event, the state leaves a public endpoint unprotected, and
    // unlike the fail-open incident it replaces, this one can say when it is over.
    edge_limiter_unusable: 60 * 60_000,
    // A privileged function open to the web (#2447) persists until somebody revokes the
    // grant, and nothing self-heals it, so repeat while it lasts. Hourly, for the same
    // reason as the ceilings above: it leaves something reachable from outside that should
    // not be, so it is not a maintenance item to pick up whenever.
    definer_grants_to_web_roles: 60 * 60_000,
    // The refresh failing everywhere (#1544) persists until somebody fixes the cause, and
    // nothing self-heals it, so repeat while it lasts. Every 6 hours rather than hourly:
    // cached cover has weeks of margin before it stops reaching the booking horizon, so this
    // is a maintenance problem to pick up in the working day, not an outage to page on.
    hydration_all_failing: 6 * 60 * 60_000,
    // Booking handoffs with no channel to go to (#2367). Somebody in sales is waiting
    // to be told about a booking and nothing will tell them until the setting is
    // saved, which is a minute's work for whoever reads this. Hourly, like the other
    // pages that stay true until a person acts.
    handoff_channel_unset: 60 * 60_000,
    // Handoffs not reaching the channel (#2367): the lane retries every tick, so a
    // repeat only says something when the retries are still failing. Hourly.
    handoff_undelivered: 60 * 60_000,
    // Merged work that is not live (#2476). It stays true until somebody re-runs a
    // deploy or merges again, and every hour it stands is an hour the fix somebody
    // believes shipped is not running. Hourly, like the other pages whose remedy is
    // a person doing something.
    main_not_deployed: 60 * 60_000,
    // CI refused before it starts (#2229). The remedy is a billing or account change
    // somebody has to make, and while it lasts main is unguarded, so it should keep
    // asking. Hourly.
    ci_runs_refused: 60 * 60_000,
    // Online booking left stopped (#2366). It repeats while it stands, because the
    // whole point is that the person who stopped it has forgotten, and one message
    // is exactly what a forgetful reader misses. Four hours rather than hourly: it
    // is a question about a deliberate state, and a state somebody is deliberately
    // holding through a long incident must not be asked about every hour (L36).
    public_booking_stopped: 4 * 60 * 60_000,
    // A retired booking key presented (#2879): somebody still holds a key Slate no
    // longer accepts, and every call they make is refused, so a lead may be on a
    // broken page right now. Hourly per retired key and kind of host, like the other pages whose
    // remedy is a person doing something, and it stops once they hold a live key.
    retired_booking_key: 60 * 60_000,
    // The daily advisor photo refresh (#3027). It runs at most twice a day, so a
    // cooldown under a day would never repeat anyway; 23 hours lets the next
    // morning's run ask again if the state still holds, and never twice in a day.
    advisor_photos_unread: 23 * 60 * 60_000,
    advisor_photos_held: 23 * 60 * 60_000,
    // Something refused under the enforced content security policy (#2575). Each
    // refusal is a page that did not fully load for a real person, and every lead
    // on a broken page reports the same thing, so hourly per directive: a broken
    // deploy pages once an hour rather than once a lead, and a second kind of
    // refusal still pages on its own key.
    csp_violation: 60 * 60_000,
  },
  // No coded low volume floors any more (#1956). They were 5 and 20, one pair for
  // every hour of the week, and nothing had measured either: replayed over two
  // real weeks they would have paged 258 times. The floors now come from
  // MEASURED_VOLUME_BASELINE, fitted per weekday and hour to real traffic.
} as const;

const validPositiveInt = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isInteger(n) && n > 0;
const validNonNegInt = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

/** Store cooldown-minutes (if valid & positive) → ms, else the coded default. */
export function resolveCooldownMs(
  rows: Pick<MonitorSettings, "key" | "cooldown_min">[],
): Record<MonitorAlertKey, number> {
  const byKey = new Map(rows.map((r) => [r.key, r.cooldown_min]));
  const out = {} as Record<MonitorAlertKey, number>;
  for (const k of ALERT_KEYS) {
    const stored = byKey.get(k);
    out[k] = validPositiveInt(stored) ? stored * 60_000 : MONITOR_DEFAULTS.cooldownMs[k];
  }
  return out;
}

/**
 * A cooldown in minutes as a person would say it: "30 minutes", "6 hours",
 * "7 days". The stored numbers run from single minutes to 10080, and a reader
 * comparing 10080 against 360 has to do arithmetic to see that one is a week and
 * the other six hours, which is the whole thing #1289 is trying to make obvious.
 * Falls back to minutes for anything that does not divide cleanly, so the number
 * is never rounded into a different value.
 */
export function formatMinutes(minutes: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes >= 1440 && minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes >= 60 && minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

/** One alarm whose stored cooldown is longer than its coded default (#1289). */
export interface QuietedAlarm {
  key: MonitorAlertKey;
  /** The same label the settings screen shows, so the two never diverge. */
  label: string;
  /** The stored cooldown, in minutes. Always greater than `defaultMinutes`. */
  storedMinutes: number;
  defaultMinutes: number;
  /** When the stored value last changed, so the reason can be traced. */
  updatedAt: string | null;
}

/**
 * Every alarm currently QUIETER than its coded default, worst first (#1289).
 *
 * Two cooldowns were stretched to a weekly repeat on purpose while the routing
 * pool is off (#1272, #1283) and nothing in the product said so. An alarm quieted
 * for a good reason is indistinguishable from an alarm that was always quiet.
 *
 * Derived from `MONITOR_DEFAULTS` and the SAME validity rule `resolveCooldownMs`
 * applies, never a second copy of either. That matters because a stored 0, a
 * negative, or a fraction is IGNORED by the resolver, which falls back to the
 * default: such a row quiets nothing, and reporting it would send somebody to fix
 * a setting that is already correct. A row for a key the code no longer sends is
 * ignored for the same reason.
 */
export function quietedAlarms(
  rows: Pick<MonitorSettings, "key" | "cooldown_min" | "updated_at">[],
): QuietedAlarm[] {
  const labels = new Map(ALERT_FIELDS.map((f) => [f.key, f.label]));
  const effective = resolveCooldownMs(rows);
  const out: QuietedAlarm[] = [];
  for (const row of rows) {
    const key = row.key as MonitorAlertKey;
    if (!labels.has(key)) continue;
    const defaultMinutes = MONITOR_DEFAULTS.cooldownMs[key] / 60_000;
    // Compare the EFFECTIVE cooldown, which is what the alerts actually use, so
    // a value the resolver discarded can never be reported as quieting anything.
    const storedMinutes = effective[key] / 60_000;
    if (storedMinutes <= defaultMinutes) continue;
    out.push({
      key,
      label: labels.get(key)!,
      storedMinutes,
      defaultMinutes,
      updatedAt: row.updated_at ?? null,
    });
  }
  return out.sort(
    (a, b) => b.storedMinutes / b.defaultMinutes - a.storedMinutes / a.defaultMinutes,
  );
}

/**
 * The low volume floors (#1956): the MEASURED floors per weekday and hour, each
 * window replaced only where a person set a value. Store (valid, including 0) wins
 * over env, and either one is an OVERRIDE of the measured floor at every hour,
 * reported as such so the page can show it beside the measurement it replaced.
 *
 * The baseline is the cal.com measurement until a ramp end is declared and a refit
 * for it has been learned (#2739), and it is decided by `baselineInForce`, the one
 * judge the admin page also reads, so the page and the alarm cannot disagree.
 */
export function resolveFloors(
  config: Pick<MonitorAlertConfig, "floor_30" | "floor_120" | "volume_ramp_end_on" | "volume_learning"> | null,
  env: { floor30?: number; floor120?: number },
): FloorPolicy {
  const pick = (stored: number | null, envVal: number | undefined): FloorOverride | null =>
    validNonNegInt(stored)
      ? { value: stored, origin: "stored" }
      : validNonNegInt(envVal)
        ? { value: envVal, origin: "env" }
        : null;
  const inForce = baselineInForce(
    { rampEndOn: config?.volume_ramp_end_on ?? null, learning: config?.volume_learning ?? null },
    LOW_TIER,
  );
  return {
    // Low has a cal.com measurement, so it is never unjudged; the measurement is the
    // answer for every state that is not a learned result.
    baseline: inForce.kind === "unjudged" ? MEASURED_VOLUME_BASELINE : inForce.baseline,
    override30: pick(config?.floor_30 ?? null, env.floor30),
    override120: pick(config?.floor_120 ?? null, env.floor120),
  };
}

/**
 * The tiers judged BESIDE Low (#2874), each with the floors it is judged against,
 * decided by `tierJudgedBaseline`, the same predicate /admin/alerts states them from:
 * exactly the tiers whose own bookings have been learned, on those floors. A tier
 * carried and not yet learned is absent here and stated as not judged on
 * /admin/alerts, never judged against a guess. No overrides: the two floor overrides
 * are Low's knobs, named for the alarm that predates the tiers.
 */
export function resolveTierBaselines(
  config: Pick<MonitorAlertConfig, "volume_ramp_end_on" | "volume_learning"> | null,
  anchors: AnchorSource = REAL_ANCHOR_SOURCE,
): Partial<Record<VolumeTier, VolumeBaseline>> {
  const out: Partial<Record<VolumeTier, VolumeBaseline>> = {};
  for (const tier of VOLUME_TIERS) {
    if (tier === LOW_TIER) continue;
    const judged = tierJudgedBaseline(
      baselineInForce(
        { rampEndOn: config?.volume_ramp_end_on ?? null, learning: config?.volume_learning ?? null },
        tier,
        anchors,
      ),
    );
    if (judged) out[tier] = judged;
  }
  return out;
}

/** The env half of the floors, read in one place for the monitor and the admin page. */
export const envFloors = (): { floor30?: number; floor120?: number } => ({
  floor30: parseEnvInt(process.env.BOOKING_VOLUME_FLOOR_30),
  floor120: parseEnvInt(process.env.BOOKING_VOLUME_FLOOR_120),
});

/**
 * The arming precedence, shared by every arm/disarm switch: an explicit stored
 * boolean > env (where one exists) > the coded default, which is always DISARMED.
 * A null store column is "unset" and falls through, exactly like the floors; once
 * the admin saves the settings form an explicit true/false is written and the UI
 * wins in both directions.
 *
 * One implementation on purpose. Two switches resolving "unset" by their own copy
 * of this rule is how they drift, and the direction they drift in (a flag reading
 * armed when nobody armed it) is the one that pages off an uncalibrated threshold.
 */
function resolveArmed(stored: boolean | null | undefined, envArmed?: boolean): boolean {
  if (typeof stored === "boolean") return stored;
  if (typeof envArmed === "boolean") return envArmed;
  return false;
}

/** Low-volume ARMED switch (#575): store > env (BOOKING_VOLUME_ALERT_ARMED) >
 *  disarmed. */
export function resolveLowVolumeArmed(
  config: Pick<MonitorAlertConfig, "low_volume_armed"> | null,
  envArmed: boolean | undefined,
): boolean {
  return resolveArmed(config?.low_volume_armed, envArmed);
}

/**
 * Booking-failure-rate ARMED switch (#1313): store > disarmed. No env fallback,
 * unlike its low-volume sibling: that one predates the store and kept its env var
 * for the cutover, whereas this ships with the admin toggle from day one, and a
 * second way to arm it would just be a second place for the answer to hide.
 *
 * The disarmed default is L56: a new detector must observe one real cycle before
 * it may page, so its first live run is not also its first enforcing run. The
 * issue that arms it is filed alongside this one (L65).
 */
export function resolveFailureRateArmed(
  config: Pick<MonitorAlertConfig, "failure_rate_armed"> | null,
): boolean {
  return resolveArmed(config?.failure_rate_armed);
}

/** Availability-truth ARMED switch (#1315): store > disarmed, same shape and
 *  same observe-first reasoning as its sibling above. */
export function resolveAvailabilityDriftArmed(
  config: Pick<MonitorAlertConfig, "availability_drift_armed"> | null,
): boolean {
  return resolveArmed(config?.availability_drift_armed);
}

/**
 * Roster-coverage ARMED switch (#1454): store > disarmed, same shape as its three
 * siblings above.
 *
 * The disarmed default is NOT the usual observe-a-cycle-first reasoning. This
 * check counts bookable agents, and the roster is deliberately dark before
 * cutover (#1272), so an armed check would report the whole advertised week
 * uncovered on every tick until go-live: correct, useless, and muted long before
 * the day it starts telling the truth. It measures and logs throughout.
 */
export function resolveRosterCoverageArmed(
  config: Pick<MonitorAlertConfig, "roster_coverage_armed"> | null,
): boolean {
  return resolveArmed(config?.roster_coverage_armed);
}

/**
 * Awaiting-activation ARMED switch (#2318): store > disarmed, same shape as its
 * four siblings above.
 *
 * Disarmed for the usual observe-first reason (L56). Nobody can say from a desk
 * how many people carry `bookable_pending_since` on an ordinary day: since #2302
 * the population is whoever the hourly roster run refused or deferred, and it has
 * never been watched over a working week. The check measures and logs throughout,
 * and #2531 is what arms it once somebody has read a few ordinary days (L65).
 */
export function resolveAwaitingActivationArmed(
  config: Pick<MonitorAlertConfig, "awaiting_activation_armed"> | null,
): boolean {
  return resolveArmed(config?.awaiting_activation_armed);
}

/**
 * Below-lead-tier ARMED switch (#2593): store > disarmed, same shape as its
 * siblings above.
 *
 * Disarmed for the observe-first reason (L56), and for a sharper one: no real
 * lead has an upcoming booking in Slate yet, so nobody has seen a single ordinary
 * day of this check. It measures and logs every tick either way, and #2696 arms
 * it before cutover (L65).
 */
export function resolveBelowLeadTierArmed(
  config: Pick<MonitorAlertConfig, "below_lead_tier_armed"> | null,
): boolean {
  return resolveArmed(config?.below_lead_tier_armed);
}

/**
 * Regal call alerts ARMED switch (#2090): store > disarmed, same shape again, and
 * ONE switch for the three Regal call alerts (calling while not bookable, a quiet
 * business day, unreadable events), because all three become meaningful on the
 * same day: when Regal's reporting webhook is pointed at Slate. Before that the
 * quiet alarm would page every evening about a configuration nobody has done.
 *
 * Disarmed for the observe first reason (L56): nobody can say from a desk how many
 * people are calling while not bookable on an ordinary day, and if it is dozens the
 * role rule or the ignore list is wrong. The checks measure and log throughout, and
 * #2695 armed them once Regal's webhook was live; the setting still switches them off.
 */
export function resolveRegalCallsArmed(config: Pick<MonitorAlertConfig, "regal_calls_armed"> | null): boolean {
  return resolveArmed(config?.regal_calls_armed);
}

// Sane bounds so a fat-finger can't silently mute an alert for a week.
const COOLDOWN_MIN_MIN = 1;
const COOLDOWN_MIN_MAX = 7 * 24 * 60; // one week in minutes
const FLOOR_MIN = 0;
const FLOOR_MAX = 100_000;

export interface MonitorSettingsFormInput {
  cooldownMin: Record<MonitorAlertKey, string>;
  floor30: string;
  floor120: string;
  alertsChannel: string;
  infoChannel: string;
  /** #2367: where booking handoffs are posted. Blank is unset, with no fallback. */
  handoffChannel: string;
  /** Raw value of the arm-low-volume checkbox ("on"/"true" when checked, else blank). */
  lowVolumeArmed: string;
  /** Raw value of the arm-failure-rate checkbox (#1313), same encoding. */
  failureRateArmed: string;
  /** Raw value of the arm-availability-drift checkbox (#1315), same encoding. */
  availabilityDriftArmed: string;
  rosterCoverageArmed: string;
  /** Raw value of the arm-awaiting-activation checkbox (#2318), same encoding. */
  awaitingActivationArmed: string;
  /** Raw value of the arm-below-lead-tier checkbox (#2593), same encoding. */
  belowLeadTierArmed: string;
  /** Raw value of the arm-Regal-calls checkbox (#2090), same encoding. */
  regalCallsArmed: string;
}

export interface MonitorSettingsPayload {
  cooldowns: { key: MonitorAlertKey; cooldown_min: number | null }[];
  config: {
    floor_30: number | null;
    floor_120: number | null;
    alerts_channel: string | null;
    info_channel: string | null;
    handoff_channel: string | null;
    low_volume_armed: boolean;
    failure_rate_armed: boolean;
    availability_drift_armed: boolean;
    roster_coverage_armed: boolean;
    awaiting_activation_armed: boolean;
    below_lead_tier_armed: boolean;
    regal_calls_armed: boolean;
  };
  errors: string[];
}

/**
 * Parses the admin form into a store payload. A blank field becomes explicit
 * `null` (revert to fallback), NEVER 0. Non-blank values outside their valid
 * range produce an error (the action should refuse to save rather than coerce).
 */
export function parseMonitorSettingsForm(input: MonitorSettingsFormInput): MonitorSettingsPayload {
  const errors: string[] = [];

  const parseBounded = (
    raw: string,
    label: string,
    min: number,
    max: number,
  ): number | null => {
    const t = (raw ?? "").trim();
    if (t === "") return null; // blank = unset = fall back
    const n = Number(t);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${label} must be a whole number between ${min} and ${max}.`);
      return null;
    }
    return n;
  };

  const cooldowns = ALERT_KEYS.map((key) => ({
    key,
    cooldown_min: parseBounded(input.cooldownMin[key] ?? "", `Cooldown (${key})`, COOLDOWN_MIN_MIN, COOLDOWN_MIN_MAX),
  }));

  const channel = (raw: string): string | null => {
    const t = (raw ?? "").trim();
    return t === "" ? null : t;
  };

  // The checkbox is a definite on/off decision: checked -> armed, absent/blank ->
  // disarmed. Saving therefore always writes an explicit boolean, so the UI wins.
  const checked = (raw: string): boolean => {
    const t = (raw ?? "").trim().toLowerCase();
    return t === "on" || t === "true";
  };

  return {
    cooldowns,
    config: {
      floor_30: parseBounded(input.floor30, "30-min floor", FLOOR_MIN, FLOOR_MAX),
      floor_120: parseBounded(input.floor120, "120-min floor", FLOOR_MIN, FLOOR_MAX),
      alerts_channel: channel(input.alertsChannel),
      info_channel: channel(input.infoChannel),
      handoff_channel: channel(input.handoffChannel),
      low_volume_armed: checked(input.lowVolumeArmed),
      failure_rate_armed: checked(input.failureRateArmed),
      availability_drift_armed: checked(input.availabilityDriftArmed),
      roster_coverage_armed: checked(input.rosterCoverageArmed),
      awaiting_activation_armed: checked(input.awaitingActivationArmed),
      below_lead_tier_armed: checked(input.belowLeadTierArmed),
      regal_calls_armed: checked(input.regalCallsArmed),
    },
    errors,
  };
}

const parseEnvInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

export interface ResolvedMonitorSettings {
  cooldownMs: Record<MonitorAlertKey, number>;
  /** #1956: the measured floors and any override; resolve an instant with `floorsFor`. */
  floors: FloorPolicy;
  /** #2874: the floors of every tier judged beside Low, from `resolveTierBaselines`. */
  tierBaselines: Partial<Record<VolumeTier, VolumeBaseline>>;
  /** #575: is the low-booking-volume alert armed (store > env > disarmed)? */
  lowVolumeArmed: boolean;
  /** #1313: is the booking-failure-rate page armed (store > disarmed)? */
  failureRateArmed: boolean;
  /** #1315: is the availability-truth page armed (store > disarmed)? */
  availabilityDriftArmed: boolean;
  /** #1454: is the roster-coverage page armed (store > disarmed)? */
  rosterCoverageArmed: boolean;
  /** #2318: is the "waiting to become bookable" page armed (store > disarmed)? */
  awaitingActivationArmed: boolean;
  /** #2593: is the "booked below the lead's tier" page armed (store > disarmed)? */
  belowLeadTierArmed: boolean;
  /** #2090: are the three Regal call alerts armed (store > disarmed)? */
  regalCallsArmed: boolean;
}

type AlertConfigRow = Pick<
  MonitorAlertConfig,
  | "floor_30"
  | "floor_120"
  | "volume_ramp_end_on"
  | "volume_learning"
  | "low_volume_armed"
  | "failure_rate_armed"
  | "availability_drift_armed"
  | "roster_coverage_armed"
  | "awaiting_activation_armed"
  | "below_lead_tier_armed"
  | "regal_calls_armed"
>;

/**
 * The last settings this isolate read successfully, or null on a cold isolate.
 * Only ever written by a SUCCESSFUL read: a failure is never recorded as a value.
 */
let lastKnown: ResolvedMonitorSettings | null = null;

/**
 * Reads the store and resolves the monitor's runtime settings, and THROWS when
 * either read fails (#2773).
 *
 * It used to swallow any error into env and coded defaults, on the theory that
 * config must never take down alerting. The defaults are not neutral, though:
 * every armed switch defaults to OFF, so a single failed read of
 * `monitor_alert_config` disarmed the low volume alarm, the failure rate, drift,
 * roster coverage, activation, below tier and Regal pages, dropped the floor
 * overrides and reverted the learned floors to the cal.com measurement, for that
 * tick, with nothing reporting it. Swallowing it WAS config taking alerting down,
 * just quietly.
 *
 * So a failure is the caller's to handle, with two tools:
 *
 * - `lastKnownMonitorSettings()`, the last successful read in this isolate, which
 *   is what the monitor lane falls back to inside its `setup_settings` step. The
 *   step still FAILS, so a sustained outage pages through the step streak even
 *   while the last known value is carrying the tick (the business hours cache's
 *   shape: the fallback buys time, it does not hide the fault).
 * - with no last known value, the lane's checks whose decision to page is a switch
 *   or a floor stand down through `monitorSetupGates` rather than judge on a guess.
 *
 * A store that is readable and EMPTY is not a failure: no config row, or no stored
 * cooldown, resolves through the resolvers exactly as before.
 */
export async function loadMonitorSettings(): Promise<ResolvedMonitorSettings> {
  const db = supabaseAdmin();
  const [cooldowns, cfg] = await Promise.all([
    db.from("monitor_settings").select("key, cooldown_min"),
    db
      .from("monitor_alert_config")
      .select(
        "floor_30, floor_120, volume_ramp_end_on, volume_learning, low_volume_armed, failure_rate_armed, availability_drift_armed, roster_coverage_armed, awaiting_activation_armed, below_lead_tier_armed, regal_calls_armed",
      )
      .eq("id", 1)
      .maybeSingle(),
  ]);
  const rows = (unwrap(cooldowns, "monitor cooldowns") ?? []) as Pick<
    MonitorSettings,
    "key" | "cooldown_min"
  >[];
  const config = unwrap(cfg, "monitor alert config") as AlertConfigRow | null;
  const resolved: ResolvedMonitorSettings = {
    cooldownMs: resolveCooldownMs(rows),
    floors: resolveFloors(config, envFloors()),
    tierBaselines: resolveTierBaselines(config),
    lowVolumeArmed: resolveLowVolumeArmed(config, envLowVolumeArmed()),
    failureRateArmed: resolveFailureRateArmed(config),
    availabilityDriftArmed: resolveAvailabilityDriftArmed(config),
    rosterCoverageArmed: resolveRosterCoverageArmed(config),
    awaitingActivationArmed: resolveAwaitingActivationArmed(config),
    belowLeadTierArmed: resolveBelowLeadTierArmed(config),
    regalCallsArmed: resolveRegalCallsArmed(config),
  };
  lastKnown = resolved;
  return resolved;
}

/** The last settings this isolate read successfully, or null if it never has. */
export function lastKnownMonitorSettings(): ResolvedMonitorSettings | null {
  return lastKnown;
}

/** The coded cooldowns, for a caller with no settings reading at all. */
export function codedCooldownMs(): Record<MonitorAlertKey, number> {
  return resolveCooldownMs([]);
}

/**
 * The cooldowns alone, for a lane that needs nothing else from the settings
 * (hydrate-calendars, the schedule parity sweep). Never throws.
 *
 * This is the one place a failed read may fall as far as a coded default, and the
 * reason is specific to what a cooldown IS: it paces an alarm that has already
 * decided to fire, so no value of it can disarm anything. The worst a coded
 * cooldown does is repeat a page more or less often than somebody tuned it to.
 * Taking the lane down instead would stop the work the alarm is about. Last known
 * first, coded only with nothing known, and either fallback is logged by name.
 */
export async function loadMonitorCooldowns(tag: string): Promise<Record<MonitorAlertKey, number>> {
  try {
    return (await loadMonitorSettings()).cooldownMs;
  } catch (err) {
    const known = lastKnownMonitorSettings();
    if (known) {
      log.warn(tag, { msg: "monitor settings unreadable; using the last known cooldowns" }, err);
      return known.cooldownMs;
    }
    log.warn(tag, { msg: "monitor settings unreadable and none known; using the coded cooldowns" }, err);
    return codedCooldownMs();
  }
}

/** The deploy-gated arm flag (#370), now only the fallback when the store is unset
 *  (#575). Undefined when the env var is absent, so the store/default can decide. */
export const envLowVolumeArmed = (): boolean | undefined => {
  const raw = process.env.BOOKING_VOLUME_ALERT_ARMED;
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw === "1";
};
