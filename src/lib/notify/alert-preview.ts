/**
 * Every alert Slate can send, rendered, so the wording can be read cold (#1153).
 *
 * The 2026-07-28 sync-failure page dumped eight lines of raw Google JSON cut off
 * mid-word, told the reader to re-authenticate an account it had itself called
 * self-healing, and said "1 of 97 bookable agent". Every one of those was only
 * visible once RENDERED, in Slack, at 7am, during the incident. Unit tests assert
 * substrings, so they cannot see that a whole message reads badly. Alert copy is
 * the one user-facing surface in Slate that had no way to be looked at before it
 * shipped (L21: read every new user-facing sentence cold, rendered, in the state
 * that produces it).
 *
 * THE ONE RULE HERE: every string below is produced by CALLING THE REAL CODE that
 * sends it. Nothing is retyped. A preview holding its own copy of the wording
 * would drift the first time someone edited the alert and not this file, and a
 * preview showing text that is not what ships is worse than no preview at all
 * (L41). That is why #1153 came with the copy being lifted out of the send sites
 * into pure builders: so this file can call them.
 *
 * Fixtures are chosen to be REPRESENTATIVE, not minimal: plural and singular
 * where the alert pluralizes, a long error where it embeds one, several states
 * where the alert reads differently in each. If a message can be embarrassing,
 * the fixture should be the state that embarrasses it.
 */
import { ALERT_CATALOG, type AlertKind } from "@/lib/notify/alert-catalog";
import {
  formatWatchLapseAlert,
  formatSyncFailureAlert,
  formatSyncRecoveryNotice,
  type FailingAgent,
} from "@/lib/notify/alerts";
import { retentionAlertText, LANE_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { tierFallbackAlert } from "@/lib/routing/tier-alert";
import {
  oooAgentCalendarAlert,
  oooAgentDmAlert,
  oooBusyBlockFallbackAlert,
  oooCalcomAlert,
  oooCalendarCreateAlert,
  oooCalendarCreateBothFailedAlert,
  oooManagerCalendarAlert,
  oooUndoAgentAlert,
  oooUndoManagerAlert,
} from "@/lib/ooo/alert-copy";
import {
  auditWriteFailedAlert,
  bookableBlockedAlert,
  bookableUnverifiedAlert,
  externalDoubleBookAlert,
  internalErrorAlert,
  misrouteAlert,
  oooApprovalsDigestAlert,
  retentionResumedText,
  retentionSkippedText,
  unknownReasonCodeNotice,
  watchLapseRecovery,
} from "@/lib/notify/misc-alert-copy";
import {
  friendlyRateArea,
  limiterBlockedAlert,
  limiterFailOpenAlert,
  refundFailedAlert,
} from "@/lib/rate-limit-core";
import {
  snowflakeDriftAlert,
  snowflakeDriftRecovery,
  snowflakeHealthcheckAlert,
  snowflakeHealthcheckRecovery,
  erasureResidualAlert,
  erasureResidualRecovery,
  purgeSqlBrokenAlert,
  purgeSqlBrokenRecovery,
} from "@/lib/snowflake/alert-copy";
import {
  agentSyncFailureAlert,
  agentSyncRecovery,
  bucketSlotsStaleAlert,
  bucketSlotsStaleRecovery,
  digestUnreachableAlert,
  digestUnreachableRecovery,
  recomputeHeadroomAlert,
  recomputeHeadroomRecovery,
  webhookDeadAlert,
  webhookDeadRecovery,
} from "@/lib/monitor/cron-alert-copy";
import {
  coreLaneAlertText,
  canaryAlertText,
  canaryRecoveryText,
  laneRecoveryText,
  mirrorAlertText,
  mirrorRecoveryText,
  retentionRecoveryText,
} from "@/lib/monitor/lane-copy";
import {
  formatInactiveAgentBookingsAlert,
  formatInactiveAgentBookingsRecovery,
} from "@/lib/monitor/inactive-agent-bookings";
import {
  formatSaturationAlert,
  formatSaturationRecovery,
  formatCompletionSaturationAlert,
  formatCompletionSaturationRecovery,
  formatDeletionSaturationAlert,
  formatDeletionSaturationRecovery,
} from "@/lib/monitor/sweep-saturation";
import {
  bookingEventInsertAlert,
  busyBlockWriteThroughAlert,
  creationOrphanAlert,
  outboxDrainRecovery,
  outboxDrainStuckAlert,
  pendingDeletionAlert,
  pendingDeletionRecovery,
  reassignIntentDroppedAlert,
  reconcileFreedAlert,
  reconcileRecreatedAlert,
  reschedulePinDroppedAlert,
  reservationDrainRecovery,
  reservationDrainStuckAlert,
  unfairOrderingAlert,
  verifyOutageAlert,
  rescheduleLockOutageAlert,
  verifyReadFailedAlert,
} from "@/lib/booking/alert-copy";
import {
  emptyBucketMessage,
  recoveredBucketMessage,
  noEligibleAgentsAlert,
} from "@/lib/availability/bucket-coverage";

/** One rendered state of one alert. */
export interface AlertPreview {
  /** The catalog key this belongs to. */
  key: string;
  /** Which situation produces this wording, e.g. "one agent" vs "several agents". */
  state: string;
  /** Whether this is the page or the all-clear. */
  channel: "alert" | "info" | "recovery";
  text: string;
}

const AGENT_ONE: FailingAgent[] = [
  {
    email: "dana.whitfield@trypennie.com",
    consecutiveFailures: 4,
    lastSuccessAt: "2026-07-29T09:12:00.000Z",
    error: "503 backendError",
    failureKind: "transient",
  },
];

const AGENT_MANY: FailingAgent[] = [
  ...AGENT_ONE,
  {
    email: "sam.oyelaran@trypennie.com",
    consecutiveFailures: 11,
    lastSuccessAt: null,
    error: "404 notFound: the calendar no longer exists",
    failureKind: "gone",
  },
  {
    email: "ivy.marchetti@trypennie.com",
    consecutiveFailures: 2,
    lastSuccessAt: "2026-07-29T11:40:00.000Z",
    error: null,
    failureKind: null,
  },
];

/** A fixed "now", so a preview reads the same on every run and in every diff. */
// parse-ok: a hard-coded valid ISO literal in a fixture, not a stored stamp; if it
// ever failed to parse the preview output would be visibly broken, not silently healthy.
const NOW_MS = Date.parse("2026-07-29T12:00:00.000Z");

export const ALERT_PREVIEWS: AlertPreview[] = [
  // --- calendar sync and push watches ---------------------------------------
  {
    key: "sync_failures",
    state: "one agent failing",
    channel: "alert",
    text: formatSyncFailureAlert(AGENT_ONE, 97, NOW_MS),
  },
  {
    key: "sync_failures",
    state: "several agents failing (reads as systemic)",
    channel: "alert",
    text: formatSyncFailureAlert(AGENT_MANY, 97, NOW_MS),
  },
  {
    key: "sync_failures",
    state: "recovered",
    channel: "recovery",
    text: formatSyncRecoveryNotice(),
  },
  {
    key: "watch_lapse",
    state: "one agent, one total (the pluralization trap)",
    channel: "alert",
    text: formatWatchLapseAlert(AGENT_ONE, 1, NOW_MS),
  },
  {
    key: "watch_lapse",
    state: "several agents of a full roster",
    channel: "alert",
    text: formatWatchLapseAlert(AGENT_MANY, 97, NOW_MS),
  },

  // --- routing dead zones ----------------------------------------------------
  {
    key: "empty_buckets:*",
    state: "a bucket with nobody to route to",
    channel: "alert",
    text: emptyBucketMessage("411"),
  },
  {
    key: "empty_buckets:*",
    state: "recovered with a single agent",
    channel: "recovery",
    text: recoveredBucketMessage("411", 1),
  },
  {
    key: "empty_buckets:*",
    state: "recovered with several agents",
    channel: "recovery",
    text: recoveredBucketMessage("411", 6),
  },
  {
    key: "no_eligible_agents:*",
    state: "a live booking hit the dead zone",
    channel: "alert",
    text: noEligibleAgentsAlert("411"),
  },

  // --- retention lanes -------------------------------------------------------
  {
    key: "retention_skipped:*",
    state: "never completed a run",
    channel: "alert",
    text: retentionAlertText("prune-bookings-pii", Infinity, 1680),
  },
  {
    key: "retention_skipped:*",
    state: "overdue by a measured age",
    channel: "alert",
    text: retentionAlertText("prune-webhook-payloads", 30 * 60 * 60_000, 1680),
  },
  {
    key: "retention_skipped:*",
    state: "its last-run record cannot be read",
    channel: "alert",
    text: retentionAlertText("prune-routing", NOW_MS, 1680, true),
  },
  {
    key: "retention_skipped:*",
    state: "the export lane has fallen behind",
    channel: "alert",
    text: retentionSkippedText(
      "prune-routing",
      "routing_decisions: the export lane is 4 hours behind, with 812 rows waiting",
    ),
  },
  {
    key: "retention_skipped:*",
    state: "the mirror is not configured",
    channel: "alert",
    text: retentionSkippedText("prune-bookings-pii", "mirror not configured"),
  },

  // --- appointments held by an agent who left the pool (#1215) --------------
  // Three states, because the wording changes shape in each: one agent holding
  // one appointment (the singular that shipped as "1 of 97 bookable agent"),
  // several agents on both exit axes, and a gap wide enough to truncate.
  {
    key: "inactive_agent_bookings",
    state: "one deactivated agent holding one appointment",
    channel: "alert",
    text: formatInactiveAgentBookingsAlert([
      {
        userId: "u1",
        name: "Dana Ruiz",
        email: "dana.ruiz@example.com",
        reason: "deactivated",
        bookingCount: 1,
      },
    ]),
  },
  {
    key: "inactive_agent_bookings",
    state: "several agents, both exit reasons",
    channel: "alert",
    text: formatInactiveAgentBookingsAlert([
      {
        userId: "u1",
        name: "Dana Ruiz",
        email: "dana.ruiz@example.com",
        reason: "deactivated",
        bookingCount: 6,
      },
      {
        userId: "u2",
        name: "Sam Okafor",
        email: "sam.okafor@example.com",
        reason: "not_bookable",
        bookingCount: 2,
      },
      { userId: "u3", name: null, email: "kim.ito@example.com", reason: "deactivated", bookingCount: 1 },
    ]),
  },
  {
    key: "inactive_agent_bookings",
    state: "more agents than the list cap",
    channel: "alert",
    text: formatInactiveAgentBookingsAlert(
      Array.from({ length: 11 }, (_, i) => ({
        userId: `u${i}`,
        name: `Agent ${i}`,
        email: `agent${i}@example.com`,
        reason: (i % 2 === 0 ? "deactivated" : "not_bookable") as "deactivated" | "not_bookable",
        bookingCount: 11 - i,
      })),
    ),
  },
  {
    key: "inactive_agent_bookings",
    state: "every appointment reassigned",
    channel: "recovery",
    text: formatInactiveAgentBookingsRecovery(),
  },

  // --- saturated sweeps ------------------------------------------------------
  {
    key: "reconcile_cancelled_saturated",
    state: "draining at the cap",
    channel: "alert",
    text: formatSaturationAlert("cancelled-booking reconcile", 12, 200),
  },
  {
    key: "reconcile_cancelled_saturated",
    state: "caught up",
    channel: "recovery",
    text: formatSaturationRecovery("cancelled-booking reconcile"),
  },
  {
    key: "reconcile_missing_saturated",
    state: "draining at the cap",
    channel: "alert",
    text: formatSaturationAlert("missing busy block reconcile", 30, 200),
  },
  {
    key: "reconcile_missing_saturated",
    state: "caught up",
    channel: "recovery",
    text: formatSaturationRecovery("missing busy block reconcile"),
  },
  {
    key: "completion_sweep_saturated",
    state: "out of budget for consecutive runs",
    channel: "alert",
    text: formatCompletionSaturationAlert(6, 100),
  },
  {
    key: "completion_sweep_saturated",
    state: "caught up",
    channel: "recovery",
    text: formatCompletionSaturationRecovery(),
  },
  {
    key: "deletion_drain_saturated",
    state: "running at the cap",
    channel: "alert",
    text: formatDeletionSaturationAlert(20, 50),
  },
  {
    key: "deletion_drain_saturated",
    state: "caught up",
    channel: "recovery",
    text: formatDeletionSaturationRecovery(),
  },

  // --- the cron dead-man's switch -------------------------------------------
  {
    key: "cron_lane_stale:*",
    state: "quiet for a measured age",
    channel: "alert",
    text: coreLaneAlertText({
      lane: "sync",
      ageMs: 42 * 60_000,
      maxStaleMs: LANE_STALE_BOUNDS_MS.sync,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "its last-run record cannot be read",
    channel: "alert",
    text: coreLaneAlertText({
      lane: "outbox",
      ageMs: NOW_MS,
      maxStaleMs: LANE_STALE_BOUNDS_MS.outbox,
      unreadable: true,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "a core lane recovered",
    channel: "recovery",
    text: laneRecoveryText("sync"),
  },
  {
    key: "cron_lane_stale:*",
    state: "the booking canary's full pass went quiet",
    channel: "alert",
    text: canaryAlertText(
      { lane: "smoke-canary-full", ageMs: 9 * 60 * 60_000, maxStaleMs: 8 * 60 * 60_000, unreadable: false },
      480,
    ),
  },
  {
    key: "cron_lane_stale:*",
    state: "the booking canary recovered",
    channel: "recovery",
    text: canaryRecoveryText("smoke-canary-full"),
  },
  {
    key: "cron_lane_stale:*",
    state: "the erasure audit went quiet",
    channel: "alert",
    text: mirrorAlertText(
      { lane: "erasure-audit", ageMs: 14 * 60 * 60_000, maxStaleMs: 8 * 60 * 60_000, unreadable: false },
      480,
    ),
  },
  {
    key: "cron_lane_stale:*",
    state: "the erasure audit recovered",
    channel: "recovery",
    text: mirrorRecoveryText("erasure-audit"),
  },
  {
    key: "cron_lane_stale:*",
    state: "a retention lane recovered",
    channel: "recovery",
    text: retentionRecoveryText("prune-bookings-pii"),
  },

  // --- the booking layer's incidents ----------------------------------------
  {
    key: "busy_block_write_through",
    state: "an insert that did not land",
    channel: "alert",
    text: busyBlockWriteThroughAlert("insert", "booking bk_8f21c4", "503 backendError"),
  },
  {
    key: "busy_block_write_through",
    state: "a move that did not land",
    channel: "alert",
    text: busyBlockWriteThroughAlert("move", "bk_8f21c4", "permission denied for table busy_blocks"),
  },
  {
    key: "busy_block_write_through",
    state: "a delete that did not land",
    channel: "alert",
    text: busyBlockWriteThroughAlert("delete", "bk_8f21c4", "statement timeout"),
  },
  {
    key: "booking_event_insert",
    state: "a cancel reason that went unrecorded",
    channel: "alert",
    text: bookingEventInsertAlert("bk_8f21c4", "cancel", "statement timeout"),
  },
  {
    key: "pending_event_deletions",
    state: "deletions stuck retrying",
    channel: "alert",
    text: pendingDeletionAlert(7, 5, ["evt_9a2", "evt_9a3", "evt_9a4"]),
  },
  {
    key: "pending_event_deletions",
    state: "the queue drained",
    channel: "recovery",
    text: pendingDeletionRecovery(),
  },
  {
    key: "creation_orphan_events",
    state: "events outliving their booking",
    channel: "alert",
    text: creationOrphanAlert(2, ["evt_71b", "evt_71c"]),
  },
  {
    key: "reconcile_busy_blocks",
    state: "stuck slots freed",
    channel: "alert",
    text: reconcileFreedAlert(14, 6),
  },
  {
    key: "reconcile_missing_busy_blocks",
    state: "slots re-created, list truncated",
    channel: "alert",
    text: reconcileRecreatedAlert(12, ["bk_1", "bk_2", "bk_3"], true),
  },
  {
    key: "outbox_drain_stuck",
    state: "rows past the attempt cap",
    channel: "alert",
    text: outboxDrainStuckAlert(4, 5, "ob_11, ob_12, ob_13, ob_14"),
  },
  {
    key: "outbox_drain_stuck",
    state: "the backlog delivered",
    channel: "recovery",
    text: outboxDrainRecovery(),
  },
  {
    key: "reservation_drain_stuck",
    state: "crash-recovered creates not completing",
    channel: "alert",
    text: reservationDrainStuckAlert(3, 5, "rs_4, rs_5, rs_6"),
  },
  {
    key: "reservation_drain_stuck",
    state: "the backlog completed",
    channel: "recovery",
    text: reservationDrainRecovery(),
  },
  {
    key: "reschedule_pin_dropped",
    state: "a move that never happened",
    channel: "alert",
    text: reschedulePinDroppedAlert(2),
  },
  {
    key: "reassign_intent_dropped",
    state: "a reassignment that never happened",
    channel: "alert",
    text: reassignIntentDroppedAlert(1),
  },
  {
    key: "verify_on_book_calendars_read",
    state: "on the booking path",
    channel: "alert",
    text: verifyReadFailedAlert("book", "dana.whitfield@trypennie.com"),
  },
  {
    key: "verify_on_book_calendars_read",
    state: "on the in-place reschedule path",
    channel: "alert",
    text: verifyReadFailedAlert("reschedule", "dana.whitfield@trypennie.com"),
  },
  {
    key: "rr_ordering_degraded",
    state: "fair-share ordering unavailable",
    channel: "alert",
    text: unfairOrderingAlert("verify-on-book candidate order"),
  },

  // --- booking failures that point at an outage, not a full calendar ---------
  {
    key: "verify_on_book_outage",
    state: "no candidate could be verified",
    channel: "alert",
    text: verifyOutageAlert(),
  },
  {
    key: "reschedule_lock_outage",
    state: "the lock claim hit a DB error",
    channel: "alert",
    text: rescheduleLockOutageAlert(),
  },
  {
    key: "tier_fallback:*",
    state: "a booking fell back one tier",
    channel: "alert",
    text: tierFallbackAlert({ requestedCode: "411", effectiveCode: "410", rungsDropped: 1 })?.text ?? "",
  },
  {
    key: "tier_fallback_deep:*",
    state: "a booking fell back several tiers",
    channel: "alert",
    text: tierFallbackAlert({ requestedCode: "411", effectiveCode: "400", rungsDropped: 3 })?.text ?? "",
  },

  // --- the warehouse mirror ---------------------------------------------------
  { key: "snowflake_healthcheck", state: "self-check failing", channel: "alert",
    text: snowflakeHealthcheckAlert("390100 SQL compilation error") },
  { key: "snowflake_healthcheck", state: "passing again", channel: "recovery",
    text: snowflakeHealthcheckRecovery() },
  { key: "snowflake_reconcile_drift", state: "counts disagree", channel: "alert",
    text: snowflakeDriftAlert(["bookings: supabase 10412, snowflake 9880", "routing_decisions: supabase 51002, snowflake 50871"]) },
  { key: "snowflake_reconcile_drift", state: "back in step", channel: "recovery",
    text: snowflakeDriftRecovery() },
  { key: "snowflake_erasure_residual", state: "data still in the warehouse", channel: "alert",
    text: erasureResidualAlert(["bookings: 3 rows still hold contact data for erased booking bk_77a"]) },
  { key: "snowflake_erasure_residual", state: "erasure complete", channel: "recovery",
    text: erasureResidualRecovery() },
  { key: "snowflake_purge_sql_broken", state: "a statement no longer compiles", channel: "alert",
    text: purgeSqlBrokenAlert([
      "webhook_deliveries: the statement no longer runs (400 SQL compilation error: invalid identifier 'PAYLOAD_ERASED')",
    ]) },
  { key: "snowflake_purge_sql_broken", state: "running again", channel: "recovery",
    text: purgeSqlBrokenRecovery() },

  // --- the hourly and every-minute lanes ---------------------------------------
  { key: "agent_sync_failures", state: "consecutive failures", channel: "alert",
    text: agentSyncFailureAlert("SF token failed: 522 error code: 522") },
  { key: "agent_sync_failures", state: "working again", channel: "recovery",
    text: agentSyncRecovery() },
  { key: "recompute_headroom", state: "falling behind its budget", channel: "alert",
    text: recomputeHeadroomAlert(18, 64, 60, 98) },
  { key: "recompute_headroom", state: "caught up", channel: "recovery",
    text: recomputeHeadroomRecovery() },
  { key: "bucket_slots_stale", state: "rows stale after a pass", channel: "alert",
    text: bucketSlotsStaleAlert(9, 12, ["411", "412", "511", "512", "611"]) },
  { key: "bucket_slots_stale", state: "nothing stale", channel: "recovery",
    text: bucketSlotsStaleRecovery() },

  // --- reaching people ---------------------------------------------------------
  { key: "ooo-digest-unreachable:*", state: "a manager unreachable for days", channel: "alert",
    text: digestUnreachableAlert("Priya Raman (priya.raman@trypennie.com)", 2) },
  { key: "ooo-digest-unreachable:*", state: "reached again", channel: "recovery",
    text: digestUnreachableRecovery("Priya Raman (priya.raman@trypennie.com)") },
  { key: "webhook_dead:*", state: "an endpoint dead-lettering", channel: "alert",
    text: webhookDeadAlert("https://hooks.regal.io/slate/bookings", "booking.created", 5, "502 Bad Gateway") },
  { key: "webhook_dead:*", state: "delivering again", channel: "recovery",
    text: webhookDeadRecovery("https://hooks.regal.io/slate/bookings") },

  // --- the rest ----------------------------------------------------------------
  { key: "watch_lapse", state: "renewal healthy again", channel: "recovery", text: watchLapseRecovery() },
  { key: "retention_skipped:*", state: "deleting again", channel: "recovery",
    text: retentionResumedText("prune-bookings-pii") },
  { key: "bookable_blocked:*", state: "calendar definitively gone", channel: "alert",
    text: bookableBlockedAlert("dana.whitfield@trypennie.com") },
  { key: "bookable_unverified:*", state: "transient error persisted", channel: "alert",
    text: bookableUnverifiedAlert("dana.whitfield@trypennie.com") },
  { key: "ooo_approvals_digest", state: "one approval, one recipient", channel: "alert",
    text: oooApprovalsDigestAlert(1, 1, "530 authentication required") },
  { key: "ooo_approvals_digest", state: "several of each", channel: "alert",
    text: oooApprovalsDigestAlert(6, 3, "530 authentication required") },
  { key: "external_double_book:*", state: "an overlap with an outside event", channel: "alert",
    text: externalDoubleBookAlert("dana.whitfield@trypennie.com", 2, "bk_41a, bk_41b") },
  { key: "misroute:*", state: "a booking that matched no criteria", channel: "alert",
    text: misrouteAlert("bk_8f21c4", "411", "usr_22") },
  { key: "internal_error:*", state: "an unexpected 500", channel: "alert",
    text: internalErrorAlert("POST /api/bookings", "503 backendError") },
  // Two states: the returned-error shape (a schema/grant break, what actually
  // happens) and the thrown shape. Both read the same to the person paged.
  { key: "audit_write_failed", state: "the trail stopped recording (schema or grant)", channel: "alert",
    text: auditWriteFailedAlert("role.set", 'column "details" does not exist') },
  { key: "audit_write_failed", state: "the trail stopped recording (client threw)", channel: "alert",
    text: auditWriteFailedAlert("agent.deactivate", "connection reset") },
  { key: "reassign-unknown-reason-code", state: "an unrecognised code", channel: "info",
    text: unknownReasonCodeNotice("owner_switch") },
  // The area label MUST be a value the code really produces (friendlyRateArea, or
  // a `friendly` from the rule table): every one is a bare noun with no article,
  // and the copy supplies the article itself. An invented "the public booker"
  // rendered "The the public booker rate limit" here, which is the fixture lying
  // about the shape of its own input (L48).
  { key: "rate_limit_blocked:*", state: "a caller throttled", channel: "alert",
    text: limiterBlockedAlert(friendlyRateArea("book"), "203.0.113.9", 30, 60) },
  { key: "rate_limit_broken:*", state: "the limiter failed open", channel: "alert",
    text: limiterFailOpenAlert(friendlyRateArea("bookapi")) },
  { key: "rate_limit_refund_broken:*", state: "a refund of a counted hit failed", channel: "alert",
    text: refundFailedAlert(friendlyRateArea("book")) },

  // --- time off ----------------------------------------------------------------
  { key: "ooo_manager_calendar", state: "manager calendar unreachable", channel: "alert",
    text: oooManagerCalendarAlert("req_9f2", "403 forbidden") },
  { key: "ooo_calendar_create", state: "failed on the main calendar", channel: "alert",
    text: oooCalendarCreateAlert("req_9f2", "503 backendError") },
  { key: "ooo_calendar_create", state: "failed on both calendars", channel: "alert",
    text: oooCalendarCreateBothFailedAlert("req_9f2", "503 backendError") },
  { key: "ooo_agent_calendar", state: "agent calendar event failed", channel: "alert",
    text: oooAgentCalendarAlert("req_9f2", "503 backendError") },
  { key: "ooo_busy_block_fallback", state: "fell back to a native block", channel: "alert",
    text: oooBusyBlockFallbackAlert("req_9f2") },
  { key: "ooo_calcom", state: "the cutover dual-write failed", channel: "alert",
    text: oooCalcomAlert("req_9f2", "409 conflict") },
  { key: "ooo_agent_dm", state: "the decision DM did not land", channel: "alert",
    text: oooAgentDmAlert("dana.whitfield@trypennie.com", "req_9f2") },
  { key: "ooo_undo", state: "undoing the manager event failed", channel: "alert",
    text: oooUndoManagerAlert("req_9f2", "404 notFound") },
  { key: "ooo_undo", state: "undoing the agent event failed", channel: "alert",
    text: oooUndoAgentAlert("req_9f2", "404 notFound") },
];

/** Previews grouped by key, in catalog order, for a renderer. */
export function previewsByKey(): { key: string; kind: AlertKind; why: string; states: AlertPreview[] }[] {
  return ALERT_CATALOG.map((entry) => ({
    key: entry.key,
    kind: entry.kind,
    why: entry.why,
    states: ALERT_PREVIEWS.filter((p) => p.key === entry.key).map((p) => ({
      ...p,
      kind: entry.kind,
    })),
  }));
}
