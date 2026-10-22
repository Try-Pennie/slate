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
  "two-calls-on-one-advisor-sit-inside-the-buffer",
  "the-warehouse-mirror-or-an-erasure-is-in-doubt",
  "a-limit-or-a-guard-is-not-working",
  "the-audit-log-was-changed-after-it-was-written",
  "the-booking-api-is-refusing-its-caller",
  "an-unexpected-fault-was-reported",
  "a-merge-has-not-shipped-or-ci-cannot-run",
  "the-database-is-running-low-on-memory",
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
  // #3801. The booking canary failing against production: a lead may be seeing a
  // broken or slow booker, which is that family's first question.
  smoke_canary_failed: "the-booker-is-offering-nothing-or-too-little",
  // #3133. The lane ran and FAILED, which is the case the stale watchdog cannot see
  // when the lane stamped its heartbeat first. Same question: which scheduled work
  // is not happening.
  cron_lane_failed: "a-lane-or-schedule-has-gone-quiet",
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
  // The per page alarm is running and judging nobody, because the pilot switch in
  // Salesforce cannot be read: a guard that has stopped covering anything.
  page_volume_share_unknown: "a-limit-or-a-guard-is-not-working",
  // #2944. Calls arrive and their outcome rows are not being written, so the table
  // the show rate reads stops filling: the same first question as a lane gone
  // quiet, which of the work that should be producing is not.
  regal_call_outcomes_short: "a-lane-or-schedule-has-gone-quiet",
  // #2544. The same family one level in, for the same reason `monitor_step_failing`
  // is here: the lane is running and one JOB on it has stopped producing, so what
  // the reader has to establish is which of the scheduled work is not happening.
  // Not the saturated sweep family: that procedure is about a backlog and a per run
  // cap, and neither exists when the sweep never ran.
  completion_sweep_failing: "a-lane-or-schedule-has-gone-quiet",
  webhook_retry_sweep_failing: "a-lane-or-schedule-has-gone-quiet",
  // #3424. The same family, for the demo booking auto cancel on the same lane.
  demo_auto_cancel_failing: "a-lane-or-schedule-has-gone-quiet",
  // #3077. The same family on the outbox lane.
  reservation_drain_failing: "a-lane-or-schedule-has-gone-quiet",
  // #3846. The outbox drain itself, the lane's primary job.
  outbox_drain_failing: "a-lane-or-schedule-has-gone-quiet",
  reschedule_pin_sweep_failing: "a-lane-or-schedule-has-gone-quiet",
  reassign_intent_sweep_failing: "a-lane-or-schedule-has-gone-quiet",
  // #3485. The same family for the hourly coverage-reassignment retry.
  coverage_retry_sweep_failing: "a-lane-or-schedule-has-gone-quiet",
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
  // #3381. The same question as the drift probe one level in: what the booker serves
  // against what the confirm accepts.
  offered_nobody_free: "the-booker-is-offering-nothing-or-too-little",
  fallback_covered_availability: "the-booker-is-offering-nothing-or-too-little",
  thin_tier_staffing: "the-booker-is-offering-nothing-or-too-little",
  // #1256: a pool close to offering nothing today; the same family as the booked
  // solid page that owns the moment it does.
  pool_nearly_full: "the-booker-is-offering-nothing-or-too-little",
  // #2590: the same question as the nearly full whisper, for the whole roster at once.
  roster_filling_up: "the-booker-is-offering-nothing-or-too-little",
  tier_fallback_deep: "the-booker-is-offering-nothing-or-too-little",
  // #2158: this one IS the booker offering nothing, and to a real person, so it
  // sits with the family whose first check is the availability health endpoint.
  booker_unstaffed: "the-booker-is-offering-nothing-or-too-little",
  // #2841: the booker offered too little inside the window, so it reached past it.
  booking_window_extended: "the-booker-is-offering-nothing-or-too-little",
  no_eligible_agents: "the-booker-is-offering-nothing-or-too-little",
  // #2838. Both about confirms losing the overlap race on a time the booker offered:
  // the daily share (info) and a lead refused at the reassign bound (a page). The
  // first check is the same as the family's, what the booker offered and to whom.
  booking_race_contention: "the-booker-is-offering-nothing-or-too-little",
  booking_race_bound_hit: "the-booker-is-offering-nothing-or-too-little",
  low_booking_volume: "the-booker-is-offering-nothing-or-too-little",
  // #2738. The same family as the tier alarm it sits beside: one page's customers
  // are not getting through, and the procedure starts from what that page links to.
  low_page_volume: "the-booker-is-offering-nothing-or-too-little",
  // #2874. The same family again: one debt tier's customers are not getting
  // through, judged against that tier's own learned floors.
  low_tier_volume: "the-booker-is-offering-nothing-or-too-little",
  // #2874. The check itself broke, not the booker: the same family as the count
  // that cannot be read, whose procedure starts from the monitor lane's logs.
  tier_volume_check_failed: "a-lane-or-schedule-has-gone-quiet",
  // #2366. The same family, and deliberately so: this is the one cause of an empty
  // booker that the family's own first check cannot see, because availability is
  // healthy and the refusal happens on the write. A reader who arrives here from the
  // volume alarm is already in this section, and the procedure's first line is now
  // the kill switch.
  public_booking_stopped: "the-booker-is-offering-nothing-or-too-little",
  booking_failure_rate: "the-booker-is-offering-nothing-or-too-little",
  // #3275. The same failures as the page above, reported once they had already
  // stopped; the investigation is the same one.
  booking_failure_burst_ended: "the-booker-is-offering-nothing-or-too-little",
  // #3276. The same failures counted rather than shared out; the same investigation.
  booking_failure_volume: "the-booker-is-offering-nothing-or-too-little",
  // #3179. The same population as the hourly page, judged over the month.
  booking_budget: "the-booker-is-offering-nothing-or-too-little",
  // #3267. A booking exists and the work after its save is waiting on the drain.
  booking_follow_up_left_to_drain: "a-booking-side-effect-did-not-complete",

  // Slate is turning its own integration away (#1442, #1450, #1709). Its own
  // family rather than folded into the limiter one next door, because that
  // section's whole premise is the opposite: those limiters fail OPEN, so the page
  // means requests are being served UNMETERED. These three mean somebody IS being
  // refused, and following the wrong procedure at 7am is what a runbook section
  // that is wrong costs.
  booking_api_ceiling: "the-booking-api-is-refusing-its-caller",
  booking_api_credential: "the-booking-api-is-refusing-its-caller",
  booking_api_list_read: "the-booking-api-is-refusing-its-caller",
  // #1727. The booker's own limits turning leads away: the booker's family, since the
  // lead sees fewer times or none, and the first question is whose keys they are.
  booking_embed_ip_cap: "the-booker-is-offering-nothing-or-too-little",
  booking_embed_contact_cap: "the-booker-is-offering-nothing-or-too-little",
  booking_embed_honeypot: "the-booker-is-offering-nothing-or-too-little",
  // #2879. A caller presenting a key Slate retired is being refused on every call,
  // which is this family's premise, with a named repair: give it its own key.
  retired_booking_key: "the-booking-api-is-refusing-its-caller",
  // #3543: Marcia's booking MCP endpoint turning her away, or one of her calls failing.
  marcia_booking_failed: "the-booking-api-is-refusing-its-caller",
  marcia_token_refused: "the-booking-api-is-refusing-its-caller",
  marcia_gateway_refused: "the-booking-api-is-refusing-its-caller",
  // #3718: a lead asked for a call and Salesforce failed before they were marked for one.
  call_me_now_failed: "a-booking-side-effect-did-not-complete",
  call_me_now_hidden: "a-booking-side-effect-did-not-complete",
  recompute_headroom: "a-sweep-cannot-keep-up",
  cron_budget_headroom: "a-sweep-cannot-keep-up",
  calendar_window_uncovered: "the-booker-is-offering-nothing-or-too-little",
  // #1591: the cache missing busy time means the booker offers times that are taken,
  // which is the calendar window page's family, for the same reason.
  busy_cache_drift: "the-booker-is-offering-nothing-or-too-little",
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
  // #3700. Slate acted on a refused account; the procedure is that family's.
  refused_advisor_left_pool: "google-cannot-be-reached-for-an-agent",
  // #2577: the deletion drain ended rows because Google refused the calendar for
  // good; the remedy is the gone or not-provisioned branch of the same procedure.
  pending_event_deletions_refused: "google-cannot-be-reached-for-an-agent",
  verify_on_book_outage: "google-cannot-be-reached-for-an-agent",
  verify_on_book_calendars_read: "google-cannot-be-reached-for-an-agent",
  // #3134. The transient branch at its widest: Google is not answering anybody.
  google_calendar_breaker_open: "google-cannot-be-reached-for-an-agent",

  // A booking exists and one of its side effects did not land.
  // #2359. The reminder is a side effect of a booking like the invite and the
  // webhook, and a page about it means no retry is set for it (a send that provably
  // did not go out is retried and never pages), so the remedy is this family's:
  // look at what did not land for that specific booking. Keyed per booking since
  // 2026-10-05, matched here by its prefix.
  booking_reminder_failed: "a-booking-side-effect-did-not-complete",
  // #2496. Same family, deliberately: the remedy is still "look at what did not
  // land", and the difference between this and the key above is how MANY bookings
  // it landed for, which the message itself says.
  booking_reminders_failing: "a-booking-side-effect-did-not-complete",
  outbox_drain_stuck: "a-booking-side-effect-did-not-complete",
  outbox_all_handed_off: "a-booking-side-effect-did-not-complete",
  reservation_drain_stuck: "a-booking-side-effect-did-not-complete",
  reservation_created_owed: "a-booking-side-effect-did-not-complete",
  booking_event_insert: "a-booking-side-effect-did-not-complete",
  busy_block_write_through: "a-booking-side-effect-did-not-complete",
  reconcile_busy_blocks: "a-booking-side-effect-did-not-complete",
  reconcile_missing_busy_blocks: "a-booking-side-effect-did-not-complete",
  creation_orphan_events: "a-booking-side-effect-did-not-complete",
  reassign_intent_dropped: "a-booking-side-effect-did-not-complete",
  reschedule_pin_dropped: "a-booking-side-effect-did-not-complete",
  reschedule_invite_stranded: "a-booking-side-effect-did-not-complete",
  reschedule_lock_outage: "a-booking-side-effect-did-not-complete",
  stale_phone_invite: "a-booking-side-effect-did-not-complete",
  phone_correction_unsent: "a-booking-side-effect-did-not-complete",
  booking_invite_moved: "a-booking-side-effect-did-not-complete",
  booking_invite_resized: "a-booking-side-effect-did-not-complete",
  booking_invite_check_failed: "a-booking-side-effect-did-not-complete",
  booking_invite_launch_sweep: "a-booking-side-effect-did-not-complete",
  webhook_dead: "a-booking-side-effect-did-not-complete",
  bookable_trait_unrecorded: "a-booking-side-effect-did-not-complete",
  webhook_event_no_subscriber: "a-booking-side-effect-did-not-complete",
  handoff_channel_unset: "a-booking-side-effect-did-not-complete",
  handoff_undelivered: "a-booking-side-effect-did-not-complete",
  owner_alert_skips: "google-cannot-be-reached-for-an-agent",
  duplicate_cancel_unavailable: "the-booking-api-is-refusing-its-caller",
  duplicate_cancel_refused: "the-booking-api-is-refusing-its-caller",

  // Somebody is off and the cover, or the block itself, is in doubt.
  ooo_coverage_gap: "time-off-cover-or-protection-is-in-doubt",
  ooo_coverage_gap_later: "time-off-cover-or-protection-is-in-doubt",
  ooo_coverage_stop: "time-off-cover-or-protection-is-in-doubt",
  coverage_needs_human: "time-off-cover-or-protection-is-in-doubt",
  inactive_agent_bookings: "time-off-cover-or-protection-is-in-doubt",
  demoted_agent_bookings: "time-off-cover-or-protection-is-in-doubt",
  // #3040. Two calls on one advisor closer than the buffers: its own procedure, since
  // the cause is either a forced move that was not marked or a buffer raised under
  // bookings that already existed, and the remedy is moving one call of the pair.
  booking_buffer_breach: "two-calls-on-one-advisor-sit-inside-the-buffer",
  ooo_protection_lost: "time-off-cover-or-protection-is-in-doubt",
  ooo_busy_block_fallback: "time-off-cover-or-protection-is-in-doubt",
  ooo_event_mismatch: "time-off-cover-or-protection-is-in-doubt",
  ooo_calcom: "time-off-cover-or-protection-is-in-doubt",
  ooo_calcom_unprotected: "time-off-cover-or-protection-is-in-doubt",
  ooo_calendar_create: "time-off-cover-or-protection-is-in-doubt",
  ooo_agent_calendar: "time-off-cover-or-protection-is-in-doubt",
  ooo_manager_calendar: "time-off-cover-or-protection-is-in-doubt",
  ooo_agent_dm: "something-was-measured-and-is-only-worth-knowing",
  ooo_approvals_digest: "something-was-measured-and-is-only-worth-knowing",
  "ooo-digest-unreachable": "something-was-measured-and-is-only-worth-knowing",
  "ooo-digest-unrouted-unreachable": "something-was-measured-and-is-only-worth-knowing",
  ooo_calcom_stale_unrecorded: "time-off-cover-or-protection-is-in-doubt",
  ooo_undo: "something-was-measured-and-is-only-worth-knowing",
  // #3660: an event may still be standing on a calendar, so it is a protection doubt,
  // not a fact only worth knowing.
  ooo_undo_unchecked: "time-off-cover-or-protection-is-in-doubt",
  // #2843: sales ops made the Ultra High and Very High cascade ordinary routing on
  // 2026-09-28, so the number is put on the record and nobody is sent to act on it.
  top_tier_cascade_rate: "something-was-measured-and-is-only-worth-knowing",
  owner_notice_withheld: "something-was-measured-and-is-only-worth-knowing",
  // #3141: the cron CPU check cannot run without its optional token. An info line,
  // so it sits with the other things only worth knowing rather than with the pages.
  cron_cpu_not_configured: "something-was-measured-and-is-only-worth-knowing",
  // #2641: a host misconfiguration Slate cannot fix, worth passing on and never
  // worth waking for, because bookings still complete inside the embed.
  embed_origin_mismatch: "something-was-measured-and-is-only-worth-knowing",
  // #1630: invites left on the calendar of somebody who has left, whose licence
  // offboarding revoked. Nothing to repair and nobody to act, so it sits with the
  // things only worth knowing rather than with the Google reachability pages.
  pending_event_deletions_departed: "something-was-measured-and-is-only-worth-knowing",
  // #2660: a partner's own page throwing while on the public test bucket. Theirs
  // to fix, and the booking it stopped was a test one.
  client_error_test_bucket: "something-was-measured-and-is-only-worth-knowing",

  // The roster or the routing inputs disagree with Salesforce, or with themselves.
  agent_sync_failures: "the-roster-or-routing-data-is-wrong",
  // #2097. The same family: while Twilio cannot be read, the Redistribute tag is
  // not being acted on, so Slate's idea of who may take a booked call is wrong.
  twilio_sync_failures: "the-roster-or-routing-data-is-wrong",
  // #3027. The photo refresh has stopped producing (no subject, a refused one, an
  // unanswering directory): the family's question is which scheduled work is not
  // happening, and the copy names the cause.
  advisor_photos_unread: "a-lane-or-schedule-has-gone-quiet",
  // #3027. The refresh ran and the directory's data looks wrong for some people.
  advisor_photos_held: "the-roster-or-routing-data-is-wrong",
  // #3124. The bar outgrown is a measurement worth knowing: nothing is broken, and the
  // remedy (raise the bar, rerun the load run) is in the message. The check unable to
  // count is a detector that has stopped producing, the first question of that family.
  load_bar_outgrown: "something-was-measured-and-is-only-worth-knowing",
  load_bar_unread: "a-lane-or-schedule-has-gone-quiet",
  // #2114. The same family, one step later: Twilio was read fine and Slate could
  // not finish acting on it, so an agent Twilio withholds may still be in the
  // pool, or somebody's calls are still with an agent who has left it.
  twilio_write_failures: "the-roster-or-routing-data-is-wrong",
  // #2459. A roster run that cannot finish acting on what it read, like the
  // Twilio writes above: the first question is which person and which error.
  departed_sessions_unconverged: "the-roster-or-routing-data-is-wrong",
  // #2114. Slate is holding somebody out of the pool and Twilio no longer has a
  // worker for them, so nothing can say whether the tag went or the worker did.
  // The repair is in Twilio or on the agent's profile, both upstream of any run.
  twilio_marked_no_worker: "the-roster-or-routing-data-is-wrong",
  // #3615. The reroute for demoted advisors could not finish acting on a roster change, like the
  // Twilio writes above: the first question is which agent and which error.
  demotion_trigger_failures: "the-roster-or-routing-data-is-wrong",
  demotion_reroute_moved: "the-roster-or-routing-data-is-wrong",
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
  // #2481. The waiting page's twin for the rows that lost their mark, so the same
  // family and the same first question.
  agents_stranded_outside_pool: "the-roster-or-routing-data-is-wrong",
  // #3530. A bookable advisor every confirm leaves out because a row of theirs cannot
  // be read: a roster record to correct, so the same family and the same first question.
  ladder_advisor_unreadable: "the-roster-or-routing-data-is-wrong",
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
  // #2933. A lead reached both bookers during the split, so the first question is
  // the same as a misroute's: which call is the right one, and which has to go.
  cross_system_booking: "the-roster-or-routing-data-is-wrong",
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
  auth_sign_in_beyond_google: "a-limit-or-a-guard-is-not-working",
  // #3090. Its own family: the guard did not fail, somebody switched it off, and the
  // first move is to keep the evidence rather than to repair anything.
  audit_log_chain_broken: "the-audit-log-was-changed-after-it-was-written",
  rate_limit_broken: "a-limit-or-a-guard-is-not-working",
  rate_limit_refund_broken: "a-limit-or-a-guard-is-not-working",
  rate_limit_unidentified: "a-limit-or-a-guard-is-not-working",
  // #3325: the shared confirm line fails open to each server's own line, like a limiter.
  confirm_line_unreachable: "a-limit-or-a-guard-is-not-working",
  // #3339: the same guard, turned off by hand and left off, and the same guard's switch
  // unreadable on the confirm path.
  shared_confirm_line_left_off: "a-limit-or-a-guard-is-not-working",
  shared_line_switch_unreadable: "a-limit-or-a-guard-is-not-working",
  rate_limit_blocked: "something-was-measured-and-is-only-worth-knowing",

  // The database instance itself is out of memory, not a query or a lane (#3588). Its own
  // family because the remedy is different from everything above: nothing in Slate is
  // misconfigured, the fix is to scale the Supabase instance or shed load, and the first
  // check is the metrics figures in the page rather than any Slate log. The warn whisper
  // shares it: same subject, same diagnosis, one step earlier.
  db_saturation: "the-database-is-running-low-on-memory",
  db_saturation_warn: "the-database-is-running-low-on-memory",

  // A fault nothing predicted.
  internal_error: "an-unexpected-fault-was-reported",
  // #1974: the same family. A page that failed to render is an unpredicted
  // fault, and the procedure is the same one: find it by its digest in the
  // Worker logs and decide whether a deploy caused it.
  boundary_error: "an-unexpected-fault-was-reported",
  // #2575: the same family. Something was refused on a page under the enforced
  // content security policy; the procedure is to find the report in the logs and
  // decide whether a deploy caused it or the policy did its job.
  csp_violation: "an-unexpected-fault-was-reported",
  // #3323: the same family. Browsers reported errors from a script another site put
  // on the page; the procedure is to read those log lines, see which browsers they
  // came from, and try the page in one of them.
  opaque_script_errors: "an-unexpected-fault-was-reported",
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
