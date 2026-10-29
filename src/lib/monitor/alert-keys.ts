// The monitor alert keys, in a module that imports nothing (#3801).
//
// It lived in settings.ts, which the alert dispatcher cannot import: settings reaches
// the volume checks, which import the dispatcher, so the import would be a cycle.
// The dispatcher needs the list to know which keys a person can tune, because a
// stored cooldown must keep deciding a tunable alert's reminder interval. It is
// still ONE list: settings.ts re-exports it rather than holding a copy.

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
  "pool_nearly_full",
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
  "booking_budget",
  "booking_follow_up_left_to_drain",
  "catchall_rate",
  "availability_drift",
  "offered_nobody_free",
  "booker_empty_reason",
  "roster_coverage_gap",
  "roster_coverage_upcoming_gap",
  "ooo_protection_lost",
  "webhook_event_no_subscriber",
  "edge_limiter_unusable",
  "definer_grants_to_web_roles",
  "auth_sign_in_beyond_google",
  "auth_unexpected_sign_in",
  "audit_log_chain_broken",
  "lane_claim_unreadable",
  "hydration_all_failing",
  "calendar_window_uncovered",
  "db_saturation",
  "db_saturation_warn",
  "busy_cache_drift",
  "schedule_parity_drift",
  "agents_on_unset_hours",
  "agents_awaiting_activation",
  "agents_stranded_outside_pool",
  "ladder_advisor_unreadable",
  "departed_sessions_unconverged",
  "cross_system_booking",
  "regal_call_unroutable",
  "regal_calls_quiet",
  "regal_calls_unreadable",
  "regal_call_outcomes_short",
  "handoff_channel_unset",
  "handoff_undelivered",
  "owner_alert_skips",
  "duplicate_cancel_unavailable",
  "duplicate_cancel_refused",
  "main_not_deployed",
  "ci_runs_refused",
  "public_booking_stopped",
  "shared_confirm_line_left_off",
  "retired_booking_key",
  "advisor_photos_unread",
  "advisor_photos_held",
  "load_bar_outgrown",
  "load_bar_unread",
  "csp_violation",
] as const;

export type MonitorAlertKey = (typeof ALERT_KEYS)[number];
