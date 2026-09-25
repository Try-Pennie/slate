/**
 * Which runbook procedure each alert belongs to (#1047).
 *
 * There are 87 alert keys and there is no world in which 87 hand-written stanzas stay
 * true: the ones nobody has been paged by would rot first, and a runbook section that
 * is wrong is worse than a missing one, because somebody follows it at 7am.
 *
 * What is actually true is that the DIAGNOSIS clusters. A stale lane is one procedure
 * whichever lane it is. A saturated sweep is one procedure. Every Google reachability
 * alert is one procedure with three branches. So the runbook is written per FAMILY, and
 * this is the map from key to family, in code rather than in the prose, so a guard can
 * check both directions: every alert has a procedure, and no procedure exists for
 * nothing.
 *
 * A key ending in `:*` in the catalog is a prefix (one alert per lane, per agent, per
 * endpoint), and matching here is on that prefix.
 */

/** The families, each a section in `docs/alerts-runbook.md` with this slug as its anchor. */
export const ALERT_FAMILIES = [
  "a-lane-or-schedule-has-gone-quiet",
  "the-booker-is-offering-nothing-or-too-little",
  "a-sweep-cannot-keep-up",
  "google-cannot-be-reached-for-an-agent",
  "a-booking-side-effect-did-not-complete",
  "time-off-cover-or-protection-is-in-doubt",
  "the-roster-or-routing-data-is-wrong",
  "the-warehouse-mirror-or-an-erasure-is-in-doubt",
  "a-limit-or-a-guard-is-not-working",
  "the-booking-api-is-refusing-its-caller",
  "an-unexpected-fault-was-reported",
  "a-merge-has-not-shipped-or-ci-cannot-run",
  "something-was-measured-and-is-only-worth-knowing",
] as const;

export type AlertFamily = (typeof ALERT_FAMILIES)[number];

/**
 * Key (or `prefix:` for a prefixed family) to family.
 *
 * Ordered longest-prefix-first at lookup, so a specific key always beats a prefix that
 * would also match it.
 */
const FAMILY_BY_KEY: Record<string, AlertFamily> = {
  // A lane, a schedule, or a detector has stopped producing.
  cron_lane_stale: "a-lane-or-schedule-has-gone-quiet",
  // #2382. The same family one level in: the lane is running, and one CHECK on it
  // has stopped producing. The remedy is the family's, since what the reader has to
  // establish is the same thing, which of the scheduled work is not happening.
  monitor_step_failing: "a-lane-or-schedule-has-gone-quiet",
  sync_staleness: "a-lane-or-schedule-has-gone-quiet",
  // #2090. A feed rather than a lane, and the same first question: is the thing
  // that should be producing still producing, here Regal's reporting webhook.
  regal_calls_quiet: "a-lane-or-schedule-has-gone-quiet",
  // #2090. Events arrive and the edge cannot read them, so the detector behind it
  // judges nobody: a guard that has quietly stopped covering anything.
  regal_calls_unreadable: "a-limit-or-a-guard-is-not-working",
  // #2544. The same family one level in, for the same reason `monitor_step_failing`
  // is here: the lane is running and one JOB on it has stopped producing, so what
  // the reader has to establish is which of the scheduled work is not happening.
  // Not the saturated sweep family: that procedure is about a backlog and a per run
  // cap, and neither exists when the sweep never ran.
  completion_sweep_failing: "a-lane-or-schedule-has-gone-quiet",
  webhook_retry_sweep_failing: "a-lane-or-schedule-has-gone-quiet",
  detector_parked: "a-lane-or-schedule-has-gone-quiet",
  detector_unpark: "a-lane-or-schedule-has-gone-quiet",
  migration_version_lag: "a-lane-or-schedule-has-gone-quiet",

  // #2476, #2229. Its own family rather than folded into the quiet lane one above,
  // because the reader's first move is different in a way that matters: those are
  // answered inside Slate (a heartbeat, a log, a lane), and these two are answered on
  // GitHub, by somebody who may need billing access rather than a deploy. They are
  // together because they are the same pipeline seen from two ends, and because the
  // refusal is what makes the deploy page's own remedy unavailable.
  main_not_deployed: "a-merge-has-not-shipped-or-ci-cannot-run",
  ci_runs_refused: "a-merge-has-not-shipped-or-ci-cannot-run",
  volume_count_unreadable: "a-lane-or-schedule-has-gone-quiet",
  low_volume_verdict_gap: "a-lane-or-schedule-has-gone-quiet",
  audit_write_failed: "a-lane-or-schedule-has-gone-quiet",

  // A lead would find nothing to book, or too little.
  empty_tier: "the-booker-is-offering-nothing-or-too-little",
  bucket_slots_stale: "the-booker-is-offering-nothing-or-too-little",
  availability_booked_solid: "the-booker-is-offering-nothing-or-too-little",
  availability_data_anomaly: "the-booker-is-offering-nothing-or-too-little",
  availability_drift: "the-booker-is-offering-nothing-or-too-little",
  fallback_covered_availability: "the-booker-is-offering-nothing-or-too-little",
  thin_tier_staffing: "the-booker-is-offering-nothing-or-too-little",
  tier_fallback: "the-booker-is-offering-nothing-or-too-little",
  tier_fallback_deep: "the-booker-is-offering-nothing-or-too-little",
  // #2158: this one IS the booker offering nothing, and to a real person, so it
  // sits with the family whose first check is the availability health endpoint.
  booker_unstaffed: "the-booker-is-offering-nothing-or-too-little",
  no_eligible_agents: "the-booker-is-offering-nothing-or-too-little",
  low_booking_volume: "the-booker-is-offering-nothing-or-too-little",
  // #2738. The same family as the tier alarm it sits beside: one page's customers
  // are not getting through, and the procedure starts from what that page links to.
  low_page_volume: "the-booker-is-offering-nothing-or-too-little",
  // #2366. The same family, and deliberately so: this is the one cause of an empty
  // booker that the family's own first check cannot see, because availability is
  // healthy and the refusal happens on the write. A reader who arrives here from the
  // volume alarm is already in this section, and the procedure's first line is now
  // the kill switch.
  public_booking_stopped: "the-booker-is-offering-nothing-or-too-little",
  booking_failure_rate: "the-booker-is-offering-nothing-or-too-little",

  // Slate is turning its own integration away (#1442, #1450, #1709). Its own
  // family rather than folded into the limiter one next door, because that
  // section's whole premise is the opposite: those limiters fail OPEN, so the page
  // means requests are being served UNMETERED. These three mean somebody IS being
  // refused, and following the wrong procedure at 7am is what a runbook section
  // that is wrong costs.
  booking_api_ceiling: "the-booking-api-is-refusing-its-caller",
  booking_api_credential: "the-booking-api-is-refusing-its-caller",
  booking_api_list_read: "the-booking-api-is-refusing-its-caller",
  recompute_headroom: "a-sweep-cannot-keep-up",
  calendar_window_uncovered: "the-booker-is-offering-nothing-or-too-little",
  hydration_all_failing: "google-cannot-be-reached-for-an-agent",

  // A backlog is growing faster than its sweep drains it.
  completion_sweep_saturated: "a-sweep-cannot-keep-up",
  reconcile_cancelled_saturated: "a-sweep-cannot-keep-up",
  reconcile_missing_saturated: "a-sweep-cannot-keep-up",
  deletion_drain_saturated: "a-sweep-cannot-keep-up",
  pending_event_deletions: "a-sweep-cannot-keep-up",

  // Google is refusing, for one agent or for many.
  sync_failures: "google-cannot-be-reached-for-an-agent",
  watch_lapse: "google-cannot-be-reached-for-an-agent",
  bookable_blocked: "google-cannot-be-reached-for-an-agent",
  bookable_unverified: "google-cannot-be-reached-for-an-agent",
  // #2577: the deletion drain ended rows because Google refused the calendar for
  // good; the remedy is the gone or not-provisioned branch of the same procedure.
  pending_event_deletions_refused: "google-cannot-be-reached-for-an-agent",
  verify_on_book_outage: "google-cannot-be-reached-for-an-agent",
  verify_on_book_calendars_read: "google-cannot-be-reached-for-an-agent",

  // A booking exists and one of its side effects did not land.
  // #2359. The reminder is a side effect of a booking like the invite and the
  // webhook, and it is the one with no retry behind it, so the remedy is this
  // family's: look at what did not land for that specific booking.
  booking_reminder_failed: "a-booking-side-effect-did-not-complete",
  // #2496. Same family, deliberately: the remedy is still "look at what did not
  // land", and the difference between this and the key above is how MANY bookings
  // it landed for, which the message itself says.
  booking_reminders_failing: "a-booking-side-effect-did-not-complete",
  outbox_drain_stuck: "a-booking-side-effect-did-not-complete",
  outbox_all_handed_off: "a-booking-side-effect-did-not-complete",
  reservation_drain_stuck: "a-booking-side-effect-did-not-complete",
  booking_event_insert: "a-booking-side-effect-did-not-complete",
  busy_block_write_through: "a-booking-side-effect-did-not-complete",
  reconcile_busy_blocks: "a-booking-side-effect-did-not-complete",
  reconcile_missing_busy_blocks: "a-booking-side-effect-did-not-complete",
  creation_orphan_events: "a-booking-side-effect-did-not-complete",
  external_double_book: "a-booking-side-effect-did-not-complete",
  reassign_intent_dropped: "a-booking-side-effect-did-not-complete",
  reschedule_pin_dropped: "a-booking-side-effect-did-not-complete",
  reschedule_lock_outage: "a-booking-side-effect-did-not-complete",
  stale_phone_invite: "a-booking-side-effect-did-not-complete",
  webhook_dead: "a-booking-side-effect-did-not-complete",
  bookable_trait_unrecorded: "a-booking-side-effect-did-not-complete",
  webhook_event_no_subscriber: "a-booking-side-effect-did-not-complete",
  handoff_channel_unset: "a-booking-side-effect-did-not-complete",
  handoff_undelivered: "a-booking-side-effect-did-not-complete",

  // Somebody is off and the cover, or the block itself, is in doubt.
  ooo_coverage_gap: "time-off-cover-or-protection-is-in-doubt",
  ooo_coverage_gap_later: "time-off-cover-or-protection-is-in-doubt",
  ooo_coverage_stop: "time-off-cover-or-protection-is-in-doubt",
  coverage_needs_human: "time-off-cover-or-protection-is-in-doubt",
  inactive_agent_bookings: "time-off-cover-or-protection-is-in-doubt",
  ooo_protection_lost: "time-off-cover-or-protection-is-in-doubt",
  ooo_busy_block_fallback: "time-off-cover-or-protection-is-in-doubt",
  ooo_calcom: "time-off-cover-or-protection-is-in-doubt",
  ooo_calcom_unprotected: "time-off-cover-or-protection-is-in-doubt",
  ooo_calendar_create: "time-off-cover-or-protection-is-in-doubt",
  ooo_agent_calendar: "time-off-cover-or-protection-is-in-doubt",
  ooo_manager_calendar: "time-off-cover-or-protection-is-in-doubt",
  ooo_agent_dm: "something-was-measured-and-is-only-worth-knowing",
  ooo_approvals_digest: "something-was-measured-and-is-only-worth-knowing",
  "ooo-digest-unreachable": "something-was-measured-and-is-only-worth-knowing",
  "ooo-digest-unrouted-unreachable": "something-was-measured-and-is-only-worth-knowing",
  ooo_undo: "something-was-measured-and-is-only-worth-knowing",
  // #2228. It used to be `tier_fallback_overflow`, and it used to sit with the
  // booker family on the grounds that the remedy was staffing the requested pool.
  // Dan retired Beyond as a backend service on 2026-09-13, so there is no staffing
  // remedy to send anybody to and the count exists to put the number on the record.
  // The procedure is now "read it and carry on", which is this family's whole text.
  beyond_overflow_rate: "something-was-measured-and-is-only-worth-knowing",
  // #2641: a host misconfiguration Slate cannot fix, worth passing on and never
  // worth waking for, because bookings still complete inside the embed.
  embed_origin_mismatch: "something-was-measured-and-is-only-worth-knowing",
  // #2660: a partner's own page throwing while on the public test bucket. Theirs
  // to fix, and the booking it stopped was a test one.
  client_error_test_bucket: "something-was-measured-and-is-only-worth-knowing",

  // The roster or the routing inputs disagree with Salesforce, or with themselves.
  agent_sync_failures: "the-roster-or-routing-data-is-wrong",
  // #2097. The same family: while Twilio cannot be read, the Redistribute tag is
  // not being acted on, so Slate's idea of who may take a booked call is wrong.
  twilio_sync_failures: "the-roster-or-routing-data-is-wrong",
  // #2114. The same family, one step later: Twilio was read fine and Slate could
  // not finish acting on it, so an agent Twilio withholds may still be in the
  // pool, or somebody's calls are still with an agent who has left it.
  twilio_write_failures: "the-roster-or-routing-data-is-wrong",
  // #2114. Slate is holding somebody out of the pool and Twilio no longer has a
  // worker for them, so nothing can say whether the tag went or the worker did.
  // The repair is in Twilio or on the agent's profile, both upstream of any run.
  twilio_marked_no_worker: "the-roster-or-routing-data-is-wrong",
  // #1908. The lead's own routing input is missing, so they are routed to the Low
  // pool rather than their real tier. Same family as the rest: the routing data is
  // wrong, and the fix is upstream of Slate rather than inside it.
  catchall_rate: "the-roster-or-routing-data-is-wrong",
  agents_without_routing: "the-roster-or-routing-data-is-wrong",
  agents_without_schedule: "the-roster-or-routing-data-is-wrong",
  roster_coverage_gap: "the-roster-or-routing-data-is-wrong",
  roster_coverage_upcoming_gap: "the-roster-or-routing-data-is-wrong",
  schedule_parity_drift: "the-roster-or-routing-data-is-wrong",
  agents_on_unset_hours: "the-roster-or-routing-data-is-wrong",
  // #2318. Same family: the finding is about a roster row, and the first thing
  // to establish is the same one, whether the person is really meant to be taking
  // calls and what the roster says about them.
  agents_awaiting_activation: "the-roster-or-routing-data-is-wrong",
  // #2090. The finding is about a roster row (somebody working who is not in the
  // pool), and the first question is the same one: is this person meant to be
  // taking calls, and what does the roster say about them.
  regal_call_unroutable: "the-roster-or-routing-data-is-wrong",
  salesforce_user_id_conflicts: "the-roster-or-routing-data-is-wrong",
  salesforce_manager_ambiguous: "the-roster-or-routing-data-is-wrong",
  salesforce_roster_divergence: "the-roster-or-routing-data-is-wrong",
  misroute: "the-roster-or-routing-data-is-wrong",
  // #2593. The routing input or the lead's score disagrees with where the call
  // landed, so the first thing to establish is the same as for a misroute: which
  // of the two is right, and whether the call has to move.
  booking_below_lead_tier: "the-roster-or-routing-data-is-wrong",
  // #2715. A booking landed on a real advisor from a page that is not the
  // production site, usually a test from a partner's or a developer's machine.
  // The first question is the same as a misroute's: is this booking where it
  // belongs, and does it have to move or go.
  booking_offsite_origin: "the-roster-or-routing-data-is-wrong",
  rr_ordering_degraded: "the-roster-or-routing-data-is-wrong",
  reassign_unknown_reason_code: "the-roster-or-routing-data-is-wrong",
  "reassign-unknown-reason-code": "the-roster-or-routing-data-is-wrong",
  booker_empty_reason: "the-roster-or-routing-data-is-wrong",

  // The archival mirror, or a deletion we promised somebody.
  snowflake_healthcheck: "the-warehouse-mirror-or-an-erasure-is-in-doubt",
  snowflake_reconcile_drift: "the-warehouse-mirror-or-an-erasure-is-in-doubt",
  snowflake_erasure_residual: "the-warehouse-mirror-or-an-erasure-is-in-doubt",
  snowflake_erasure_residual_test: "the-warehouse-mirror-or-an-erasure-is-in-doubt",
  snowflake_purge_sql_broken: "the-warehouse-mirror-or-an-erasure-is-in-doubt",
  snowflake_credential_residual: "the-warehouse-mirror-or-an-erasure-is-in-doubt",
  retention_skipped: "the-warehouse-mirror-or-an-erasure-is-in-doubt",

  // A control that is supposed to bound something has stopped bounding it.
  edge_limiter_unusable: "a-limit-or-a-guard-is-not-working",
  definer_grants_to_web_roles: "a-limit-or-a-guard-is-not-working",
  rate_limit_broken: "a-limit-or-a-guard-is-not-working",
  rate_limit_refund_broken: "a-limit-or-a-guard-is-not-working",
  rate_limit_unidentified: "a-limit-or-a-guard-is-not-working",
  rate_limit_blocked: "something-was-measured-and-is-only-worth-knowing",

  // A fault nothing predicted.
  internal_error: "an-unexpected-fault-was-reported",
  // #1974: the same family. A page that failed to render is an unpredicted
  // fault, and the procedure is the same one: find it by its digest in the
  // Worker logs and decide whether a deploy caused it.
  boundary_error: "an-unexpected-fault-was-reported",
};

/**
 * The family an alert key belongs to, or null when nothing claims it.
 *
 * Null is the answer a guard fails on, deliberately: an alert with no procedure is one
 * somebody will be paged by at 7am with nothing to read.
 */
export function alertFamily(key: string): AlertFamily | null {
  const exact = FAMILY_BY_KEY[key];
  if (exact) return exact;
  // A catalog entry ends `:*` for a prefixed family; a real page carries the instance
  // (`cron_lane_stale:outbox`). Both resolve through the prefix before the colon.
  const prefix = key.replace(/:\*$/, "").split(":")[0] ?? "";
  return FAMILY_BY_KEY[prefix] ?? null;
}
