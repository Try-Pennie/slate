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
import { RECOMPUTE_BEHIND_CYCLES, RECOMPUTE_REARM_CYCLES } from "@/lib/availability/recompute-alert";
import {
  formatWatchLapseAlert,
  formatSyncFailureAlert,
  formatSyncRecoveryNotice,
  type FailingAgent,
} from "@/lib/notify/alerts";
import { retentionAlertText, LANE_STALE_BOUNDS_MS, VERDICT_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { PARKED_VERDICT_DETECTORS } from "@/lib/monitor/verdict-freshness";
import { formatUnsetHoursAlert, formatUnsetHoursRecovery } from "@/lib/monitor/unset-hours";
import {
  classifyParitySweep,
  buildScheduleParityAlert,
  buildScheduleParityAllClear,
} from "@/lib/monitor/schedule-parity-alert";
import {
  formatSyncStalenessAlert,
  formatSyncStalenessRecovery,
  SYNC_STALENESS_THRESHOLD_MS,
} from "@/lib/monitor/sync-staleness";
import {
  formatEmptyReasonAlert,
  formatEmptyReasonRecovery,
} from "@/lib/monitor/empty-reason-health";
import {
  formatRosterCoverageAlert,
  formatRosterCoverageRecovery,
} from "@/lib/monitor/roster-coverage";
import { formatThinTierNotice } from "@/lib/monitor/thin-tier";
import { formatScheduleGapNotice } from "@/lib/monitor/schedule-coverage";
import { formatAttributeGapNotice } from "@/lib/monitor/attribute-coverage";
import {
  formatDataAnomalyAlert,
  formatAvailabilityRecovery,
  formatBookedSolidAlert,
  formatBookedSolidRecovery,
  formatFallbackCoveredNotice,
} from "@/lib/monitor/availability-health";
import {
  formatMigrationDriftAlert,
  formatMigrationDriftRecovery,
} from "@/lib/monitor/migration-drift";
import { catchallPageText, catchallClearText } from "@/lib/monitor/catchall-rate";
import {
  formatFailureRateAlert,
  formatFailureRateAllClear,
} from "@/lib/monitor/booking-failure-rate";
import { refusalAllClear, refusalSignalCopy } from "@/lib/monitor/api-refusal-signals";
import {
  BOOKING_API_IP_LIMITER,
  BOOKING_API_WRITE_LIMITER,
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "@/lib/rate-limit-core";

/** The same figures the lane passes, read from the rules that actually refuse, so
 *  the preview shows the sentence that really ships rather than a lookalike. */
const PREVIEW_CEILING_LIMITS = {
  keyPerHour: DIRECT_BOOKING_API_HOURLY_RATE_RULES[0].max,
  keyPerMinute: BOOKING_API_WRITE_LIMITER.perMinute,
  ipPerHour: DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES[0].max,
  ipPerMinute: BOOKING_API_IP_LIMITER.perMinute,
};
import {
  formatVolumeCountUnreadableAlert,
  formatVolumeCountReadableNotice,
  formatLowVolumeAlert,
  formatLowVolumeRecoveryNotice,
} from "@/lib/monitor/booking-volume";
import {
  formatAvailabilityDriftAlert,
  formatAvailabilityDriftAllClear,
  formatAvailabilityDriftAggregateAlert,
  formatAvailabilityDriftAggregateAllClear,
} from "@/lib/monitor/availability-truth";
import { tierFallbackAlert } from "@/lib/routing/tier-alert";
import {
  beyondOverflowVerdict,
  beyondOverflowNoticeText,
  BEYOND_OVERFLOW_WINDOW_HOURS,
} from "@/lib/monitor/beyond-overflow";
import { bookerUnstaffedAlert } from "@/lib/booking/alert-copy";
import {
  oooAgentCalendarAlert,
  oooAgentDmAlert,
  oooBusyBlockFallbackAlert,
  oooCalcomAlert,
  oooCalendarCreateAlert,
  oooCalendarCreateBothFailedAlert,
  oooManagerCalendarAlert,
  oooUndoAgentAlert,
  oooCoverageStopAlert,
  oooUndoManagerAlert,
} from "@/lib/ooo/alert-copy";
import {
  auditWriteFailedAlert,
  bookableBlockedAlert,
  bookableNotProvisionedAlert,
  bookableUnverifiedAlert,
  bookableUnhydratedAlert,
  externalDoubleBookAlert,
  boundaryCatchAlert,
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
  unidentifiedCallerAlert,
  BOOKING_LIMITER,
  CLIENT_ERROR_ADDRESS_POLICY,
  refundFailedAlert,
} from "@/lib/rate-limit-core";
import { evaluateRecon } from "@/lib/snowflake/reconcile-core";
import { evaluateExportLag } from "@/lib/snowflake/export-lag-core";
import {
  snowflakeDriftAlert,
  snowflakeDriftRecovery,
  snowflakeHealthcheckAlert,
  snowflakeHealthcheckRecovery,
  erasureClassificationUnreadable,
  erasureResidualAlert,
  erasureResidualTestNotice,
  erasureResidualRecovery,
  purgeSqlBrokenAlert,
  purgeSqlBrokenRecovery,
} from "@/lib/snowflake/alert-copy";
import {
  agentSyncFailureAlert,
  twilioSyncFailureAlert,
  twilioSyncRecovery,
  twilioWriteFailureAlert,
  twilioWriteFailureRecovery,
  twilioOrphanedMarkAlert,
  twilioOrphanedMarkRecovery,
  agentSyncRecovery,
  salesforceManagerAmbiguousAlert,
  salesforceManagerAmbiguousRecovery,
  salesforceRosterDivergenceAlert,
  salesforceRosterDivergenceRecovery,
  salesforceUserIdConflictAlert,
  salesforceUserIdConflictRecovery,
  bucketSlotsStaleAlert,
  bucketSlotsStaleRecovery,
  bucketSlotsStaleUnreadableMarkerAlert,
  digestUnreachableAlert,
  digestUnreachableRecovery,
  digestUnroutedUnreachableAlert,
  digestUnroutedUnreachableRecovery,
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
  verdictBlindAlertText,
  verdictParkedInfoText,
  verdictRecoveryText,
  verdictUnparkAlertText,
  verdictUnparkLapsedText,
  verdictUnparkRecoveryText,
} from "@/lib/monitor/lane-copy";
import {
  formatInactiveAgentBookingsAlert,
  formatInactiveAgentBookingsRecovery,
} from "@/lib/monitor/inactive-agent-bookings";
import {
  formatFallbackClearedRecovery,
  formatOooProtectionAlert,
  formatOooProtectionRecovery,
} from "@/lib/monitor/ooo-protection";
import {
  formatCoverageNeedsHumanAlert,
  formatCoverageNeedsHumanRecovery,
} from "@/lib/monitor/coverage-needs-human";
import {
  formatCalendarWindowAlert,
  formatCalendarWindowRecovery,
} from "@/lib/monitor/calendar-window-coverage";
import {
  formatOooCoverageGapAlert,
  formatOooCoverageGapRecovery,
  formatOooCoverageGapWhisper,
} from "@/lib/monitor/ooo-coverage-gap";
import {
  formatUnprotectedAlert,
  formatOverrideRecovery,
  formatUnprotectedRecovery,
} from "@/lib/monitor/calcom-override-sweep";
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
  outboxAllHandedOffAlert,
  outboxHandoffRecovery,
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
  stalePhoneInviteAlert,
} from "@/lib/booking/alert-copy";
import {
  emptyBucketMessage,
  recoveredBucketMessage,
  noEligibleAgentsAlert,
  emptyBucketsAggregateMessage,
  emptyBucketsAggregateRecoveredMessage,
} from "@/lib/availability/bucket-coverage";
import {
  formatUnsubscribedEventsAlert,
  formatUnsubscribedEventsRecovery,
} from "@/lib/monitor/webhook-subscriber-coverage";
import {
  formatEdgeLimiterUnusableAlert,
  formatEdgeLimiterRecovery,
} from "@/lib/monitor/edge-limiter-health";
import {
  formatHydrationFailingAlert,
  formatHydrationRecovery,
} from "@/lib/google/hydration";
import { EDGE_LIMITER_BINDINGS } from "@/lib/rate-limit-core";
import {
  formatHandoffChannelUnsetAlert,
  formatHandoffChannelUnsetRecovery,
  formatHandoffNotice,
  formatHandoffUndeliveredAlert,
  formatHandoffUndeliveredRecovery,
  type HandoffNoticeBooking,
} from "@/lib/handoffs/copy";
import { HANDOFF_UNDELIVERED_AFTER_MS } from "@/lib/handoffs/check";
import { formatOwnerReassignNotice } from "@/lib/booking/owner-notice-copy";
import type { HandoffKind } from "@/lib/handoffs/kinds";

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

/**
 * The account Google refuses outright (#1396). Definitive like `gone`, but the
 * fix is a Workspace admin giving them Calendar, so its label and the alert's
 * instruction have to differ; previewing it is how you can see that they do.
 */
const AGENT_NOT_PROVISIONED: FailingAgent[] = [
  {
    email: "ariel.nwosu@trypennie.com",
    consecutiveFailures: 6,
    lastSuccessAt: null,
    error: "403 notACalendarUser",
    failureKind: "not-provisioned",
  },
];

const AGENT_MANY: FailingAgent[] = [
  ...AGENT_ONE,
  ...AGENT_NOT_PROVISIONED,
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

/**
 * One rendered Beyond overflow report (#2228).
 *
 * It goes through the real `beyondOverflowVerdict` rather than calling the copy
 * builder straight, so a preview can only ever show a message the lane could
 * really send: a pair of counts the verdict would have refused to report on
 * throws here instead of rendering a sentence nobody will see.
 */
function beyondOverflowReportPreview(overflowed: number, beyondBooked: number): string {
  const verdict = beyondOverflowVerdict({
    overflowed,
    beyondBooked,
    windowHours: BEYOND_OVERFLOW_WINDOW_HOURS,
  });
  if (verdict.kind !== "report") {
    throw new Error(
      `beyond overflow preview fixture ${overflowed}/${beyondBooked} is not a reportable window (${verdict.kind})`,
    );
  }
  return beyondOverflowNoticeText(verdict, BEYOND_OVERFLOW_WINDOW_HOURS);
}

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
    // #1396: read the instruction. Telling this reader to re-auth would send them
    // to repair a credential that is fine.
    key: "sync_failures",
    state: "an account was never signed up for Calendar",
    channel: "alert",
    text: formatSyncFailureAlert(AGENT_NOT_PROVISIONED, 97, NOW_MS),
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
    // #1315. The fixture is the leading form of the 2026-08-06 cal.com shape:
    // the cache is still advertising times the calendars say are taken.
    key: "availability_drift:*",
    state: "most of a bucket's offered times are really busy",
    channel: "alert",
    text: formatAvailabilityDriftAlert({ code: "411", drifted: 4, verified: 5, driftPct: 80 }),
  },
  {
    key: "availability_drift:*",
    state: "a single bad time (the sentence has to read in the singular too)",
    channel: "alert",
    text: formatAvailabilityDriftAlert({ code: "411", drifted: 1, verified: 3, driftPct: 33 }),
  },
  {
    key: "availability_drift:*",
    state: "the bucket is offering true times again",
    channel: "recovery",
    text: formatAvailabilityDriftAllClear({ code: "411", verified: 5 }),
  },
  {
    // #1373. The realistic cause of several at once is calendar sync or the push
    // channels falling behind, which is one fault, so it gets one message.
    key: "availability_drift:*",
    state: "several buckets drifting at once, folded into one page",
    channel: "alert",
    text: formatAvailabilityDriftAggregateAlert({ codes: ["101", "202", "411"], totalBuckets: 60 }),
  },
  {
    // The shape #1272 produced for the empty-bucket alert: the whole ladder at
    // once. The named list truncates and SAYS it did, so a cut list is never
    // read as the whole set.
    key: "availability_drift:*",
    state: "the whole ladder drifting, so the named list truncates",
    channel: "alert",
    text: formatAvailabilityDriftAggregateAlert({
      codes: Array.from({ length: 60 }, (_, i) => String(101 + i)),
      totalBuckets: 60,
    }),
  },
  {
    key: "availability_drift:*",
    state: "every bucket is offering true times again",
    channel: "recovery",
    text: formatAvailabilityDriftAggregateAllClear({ stillDrifting: 0, totalBuckets: 60 }),
  },
  {
    // The partial ending must not read like the full one: two buckets are still
    // wrong and about to page on their own.
    key: "availability_drift:*",
    state: "no longer widespread, but two buckets are still wrong",
    channel: "recovery",
    text: formatAvailabilityDriftAggregateAllClear({ stillDrifting: 2, totalBuckets: 60 }),
  },
  {
    // #370, previewable and classified since #1390. The fixture is a real drought
    // shape: the 30 minute window empty while the 2 hour window is merely thin, so
    // the message has to carry both numbers rather than one headline.
    key: "low_booking_volume",
    state: "bookings have dried up",
    channel: "alert",
    text: formatLowVolumeAlert([
      { label: "30 min", count: 0, floor: 3 },
      { label: "120 min", count: 4, floor: 12 },
    ]),
  },
  {
    key: "low_booking_volume",
    state: "volume is back above the floors",
    channel: "recovery",
    text: formatLowVolumeRecoveryNotice([
      { label: "30 min", count: 5, floor: 3 },
      { label: "120 min", count: 18, floor: 12 },
    ]),
  },
  {
    // #1288. Distinct from the low-volume page on purpose: this one sends the
    // reader to the QUERY, because a reader told "volume is low" checks the
    // booker, the embed and the cache and finds nothing wrong with any of them.
    key: "volume_count_unreadable",
    state: "the monitor cannot read its own booking count",
    channel: "alert",
    text: formatVolumeCountUnreadableAlert(),
  },
  {
    key: "volume_count_unreadable",
    state: "the count reads again",
    channel: "recovery",
    text: formatVolumeCountReadableNotice(),
  },
  // #1442 / #1450 / #1709. Every state that reads differently, because each of
  // these names a DIFFERENT repair in a different place and the wrong one at 7am
  // is worse than none.
  {
    key: "booking_api_ceiling",
    state: "our own per key ceiling is turning the booker away",
    channel: "alert",
    text: refusalSignalCopy.ceiling({
      status: "paging",
      dominant: "key",
      key: 240,
      ip: 12,
      sent: 900,
      pct: 28,
    }, 60 * 60_000, PREVIEW_CEILING_LIMITS)!,
  },
  {
    // The other ceiling, whose repair is a different number, so it has to be
    // readable separately.
    key: "booking_api_ceiling",
    state: "the per IP backstop is the one refusing",
    channel: "alert",
    text: refusalSignalCopy.ceiling({
      status: "paging",
      dominant: "ip",
      key: 4,
      ip: 310,
      sent: 1100,
      pct: 29,
    }, 60 * 60_000, PREVIEW_CEILING_LIMITS)!,
  },
  {
    key: "booking_api_ceiling",
    state: "the ceiling stopped refusing",
    channel: "recovery",
    text: refusalAllClear.ceiling,
  },
  {
    key: "booking_api_credential",
    state: "the caller's key is being rejected",
    channel: "alert",
    text: refusalSignalCopy.credential({
      status: "paging",
      cause: "rejected",
      total: 48,
      intervals: 11,
    })!,
  },
  {
    // A different fact with a different repair: this one is our deployment, not
    // the caller. Sharing one sentence would name a fix that cannot work.
    key: "booking_api_credential",
    state: "no key is configured on the Worker at all",
    channel: "alert",
    text: refusalSignalCopy.credential({
      status: "paging",
      cause: "not_configured",
      total: 63,
      intervals: 12,
    })!,
  },
  {
    key: "booking_api_credential",
    state: "the key is accepted again",
    channel: "recovery",
    text: refusalAllClear.credential,
  },
  {
    key: "booking_api_list_read",
    state: "the bookings list keeps coming back unreadable",
    channel: "alert",
    text: refusalSignalCopy.list({ status: "paging", total: 19, intervals: 8 })!,
  },
  {
    key: "booking_api_list_read",
    state: "the list is readable again",
    channel: "recovery",
    text: refusalAllClear.list,
  },
  {
    // #1908. Calibrated against the incumbent: cal.com's own catch-all runs at
    // about 2 percent, so 11 percent is the shape of a real regression rather
    // than ordinary movement.
    key: "catchall_rate",
    state: "leads arriving with no routing code, above what cal.com runs at",
    channel: "alert",
    text: catchallPageText({ kind: "page", share: 0.11, catchall: 22, total: 200, trigger: "rate" }, 24),
  },
  {
    // The other trigger, and the reason it exists: a count floor that stops a
    // rate being noisy at small samples would otherwise silence the case where an
    // upstream page has stopped sending codes ENTIRELY (L139).
    key: "catchall_rate",
    state: "an upstream page has stopped sending codes entirely, on a tiny sample",
    channel: "alert",
    text: catchallPageText({ kind: "page", share: 1, catchall: 3, total: 3, trigger: "saturation" }, 24),
  },
  {
    key: "catchall_rate",
    state: "back within tolerance",
    channel: "recovery",
    text: catchallClearText(0.018, 24),
  },
  {
    // #1313. The fixture is the 2026-08-06 cal.com shape: a wave of customers
    // refused on times that were offered to them.
    key: "booking_failure_rate",
    state: "a wave of customers turned away",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 82,
      failures: 38,
      pct: 46,
      windowMinutes: 60,
      topCodes: [
        { code: "slot_unavailable", count: 35 },
        { code: "internal", count: 3 },
      ],
    }),
  },
  {
    key: "booking_failure_rate",
    state: "a single failure (the sentence has to read in the singular too)",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 24,
      failures: 1,
      pct: 4,
      windowMinutes: 60,
      topCodes: [{ code: "internal", count: 1 }],
    }),
  },
  {
    // The guidance sentence is conditional (L36), so the not-availability case
    // reads differently and has to be previewable too.
    key: "booking_failure_rate",
    state: "the booker itself is throwing (no availability advice)",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 60,
      failures: 30,
      pct: 50,
      windowMinutes: 60,
      topCodes: [
        { code: "internal", count: 28 },
        { code: "no_eligible_agents", count: 2 },
      ],
    }),
  },
  {
    // #1429: a locked out direct booking integration. Counted as a failure share,
    // and the page has to say which secret to look at, since neither code's repair
    // is guessable from its name.
    key: "booking_failure_rate",
    state: "the booking API key is being rejected (the integration is locked out)",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 31,
      failures: 29,
      pct: 94,
      windowMinutes: 60,
      topCodes: [{ code: "API_KEY_REJECTED", count: 29 }],
    }),
  },
  {
    key: "booking_failure_rate",
    state: "no booking API key is configured at all",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 18,
      failures: 18,
      pct: 100,
      windowMinutes: 60,
      topCodes: [{ code: "API_NOT_CONFIGURED", count: 18 }],
    }),
  },
  {
    key: "booking_failure_rate",
    state: "failing with no error code recorded",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 40,
      failures: 12,
      pct: 30,
      windowMinutes: 60,
      topCodes: [],
    }),
  },
  {
    key: "booking_failure_rate",
    state: "bookings completing again",
    channel: "recovery",
    text: formatFailureRateAllClear({ attempts: 90, failures: 2, pct: 2, windowMinutes: 60 }),
  },
  {
    key: "empty_buckets:*",
    state: "a pool with nobody to route to",
    channel: "alert",
    text: emptyBucketMessage({
      key: "very-high",
      label: "Very High",
      codes: ["400", "401", "402", "410", "411", "412"],
      representative: "400",
    }),
  },
  {
    key: "empty_buckets:*",
    state: "a pool of one code, whose criteria have no name",
    channel: "alert",
    text: emptyBucketMessage({
      key: "custom",
      label: null,
      codes: ["411"],
      representative: "411",
    }),
  },
  {
    key: "empty_buckets:*",
    state: "recovered with a single agent",
    channel: "recovery",
    text: recoveredBucketMessage(
      { key: "very-high", label: "Very High", codes: ["411"], representative: "411" },
      1,
    ),
  },
  {
    key: "empty_buckets:*",
    state: "recovered with several agents",
    channel: "recovery",
    text: recoveredBucketMessage(
      { key: "very-high", label: "Very High", codes: ["411"], representative: "411" },
      6,
    ),
  },
  {
    key: "empty_buckets:*",
    state: "the whole routing matrix is dark (one page for every pool)",
    channel: "alert",
    text: emptyBucketsAggregateMessage(15, 15, 0),
  },
  {
    key: "empty_buckets:*",
    state: "many pools dead while agents ARE bookable",
    channel: "alert",
    text: emptyBucketsAggregateMessage(6, 15, 40),
  },
  {
    key: "empty_buckets:*",
    state: "many buckets dead, agent count unreadable",
    channel: "alert",
    text: emptyBucketsAggregateMessage(60, 60, null),
  },
  {
    key: "empty_buckets:*",
    state: "the broad outage cleared completely",
    channel: "recovery",
    text: emptyBucketsAggregateRecoveredMessage(0, 60),
  },
  {
    key: "empty_buckets:*",
    state: "the broad outage cleared with buckets still dead",
    channel: "recovery",
    text: emptyBucketsAggregateRecoveredMessage(3, 60),
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
      evaluateExportLag([
        {
          table: "routing_decisions",
          cursorTs: "2026-08-03T02:00:00.000Z",
          newestTs: "2026-08-03T06:55:00.000Z",
          oldestPendingTs: "2026-08-03T02:00:30.000Z",
          lagMs: 4 * 60 * 60_000,
          backlog: 812,
        },
      ]).reasons.join("; "),
    ),
  },
  {
    key: "retention_skipped:*",
    state: "the mirror is not configured",
    channel: "alert",
    text: retentionSkippedText("prune-bookings-pii", "mirror not configured"),
  },
  // #1180's lane, previewed on its own because it is the only one whose stake
  // sentence is about the WAREHOUSE copy rather than the live database, and
  // because it is the only skip reason that lane can have.
  {
    key: "retention_skipped:*",
    state: "the warehouse lane has no credential",
    channel: "alert",
    text: retentionSkippedText("prune-warehouse-pii", "mirror not configured"),
  },
  {
    key: "retention_skipped:*",
    state: "the warehouse lane is clearing again",
    channel: "recovery",
    text: retentionResumedText("prune-warehouse-pii"),
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

  // --- approved time off that has stopped blocking anything (#1467) ----------
  // Three states: the singular (which is what production produced), the shape
  // that cannot heal itself sitting beside one that can, and the all-clear.
  {
    key: "ooo_protection_lost",
    state: "one window, and the record still claims the block is written",
    channel: "alert",
    text: formatOooProtectionAlert(
      [
        {
          requestId: "d8b51044-c005-42e7-be99-b05e47f4f350",
          userId: "u1",
          agentName: "Dana Ruiz",
          agentEmail: "dana.ruiz@example.com",
          startsAt: "2026-08-20T21:00:00.000Z",
          endsAt: "2026-08-20T23:00:00.000Z",
          displayTzId: "America/New_York",
          displayTzLabel: "ET",
          claimedOk: true,
        },
      ],
      "https://slate.trypennie.app",
    ),
  },
  {
    key: "ooo_protection_lost",
    state: "two windows, one repairable by a retry and one not",
    channel: "alert",
    text: formatOooProtectionAlert(
      [
        {
          requestId: "req-a",
          userId: "u1",
          agentName: "Dana Ruiz",
          agentEmail: "dana.ruiz@example.com",
          startsAt: "2026-08-20T21:00:00.000Z",
          endsAt: "2026-08-20T23:00:00.000Z",
          displayTzId: "America/New_York",
          displayTzLabel: "ET",
          claimedOk: true,
        },
        {
          requestId: "req-b",
          userId: "u2",
          agentName: null,
          agentEmail: "sam.okafor@example.com",
          startsAt: "2026-08-21T13:00:00.000Z",
          endsAt: "2026-08-22T21:00:00.000Z",
          displayTzId: "America/New_York",
          displayTzLabel: "ET",
          claimedOk: false,
        },
      ],
      "https://slate.trypennie.app",
    ),
  },
  {
    key: "ooo_protection_lost",
    state: "every approved window is blocked again",
    channel: "recovery",
    text: formatOooProtectionRecovery(),
  },

  // --- appointments a coverage sweep gave up on (#1242) -----------------------
  // Four states, because the wording changes shape in each: the singular, the two
  // outcomes side by side on one agent (nobody free vs the move erroring), a list
  // wide enough to truncate, and the all-clear.
  // #1253: the sentence a person reads when cal.com can still book someone who is
  // away. Singular and plural read differently, and the all-clear has to say the
  // thing that is now true rather than that an alert stopped.
  {
    key: "ooo_calcom_unprotected",
    state: "one agent away and bookable",
    channel: "alert",
    text: formatUnprotectedAlert(
      [
        {
          id: "r1",
          email: "dana.ruiz@example.com",
          startsAt: "2026-08-07T13:00:00Z",
          endsAt: "2026-08-08T02:00:00Z",
          effect: "failed: schedule patch returned 500",
        },
      ],
      Date.UTC(2026, 7, 7, 15),
    ),
  },
  {
    key: "ooo_calcom_unprotected",
    state: "several agents away and bookable",
    channel: "alert",
    text: formatUnprotectedAlert(
      ["dana.ruiz@example.com", "sam.okafor@example.com", "lee.chen@example.com", "ada.blake@example.com"].map(
        (email, n) => ({
          id: `r${n}`,
          email,
          startsAt: "2026-08-07T13:00:00Z",
          endsAt: "2026-08-08T02:00:00Z",
          effect: "failed: schedule patch returned 500",
        }),
      ),
      Date.UTC(2026, 7, 7, 15),
    ),
  },
  {
    key: "ooo_calcom_unprotected",
    state: "every absence blocked again",
    channel: "recovery",
    text: formatUnprotectedRecovery(),
  },
  {
    key: "coverage_needs_human",
    state: "one appointment nobody was free for",
    channel: "alert",
    text: formatCoverageNeedsHumanAlert([
      { userId: "u1", name: "Dana Ruiz", email: "dana.ruiz@example.com", unplaceable: 1, failed: 0 },
    ]),
  },
  {
    key: "coverage_needs_human",
    state: "both outcomes, several agents",
    channel: "alert",
    text: formatCoverageNeedsHumanAlert([
      { userId: "u1", name: "Dana Ruiz", email: "dana.ruiz@example.com", unplaceable: 4, failed: 2 },
      { userId: "u2", name: "Sam Okafor", email: "sam.okafor@example.com", unplaceable: 0, failed: 1 },
      { userId: "u3", name: null, email: "kim.ito@example.com", unplaceable: 1, failed: 0 },
    ]),
  },
  {
    key: "coverage_needs_human",
    state: "more agents than the list cap",
    channel: "alert",
    text: formatCoverageNeedsHumanAlert(
      Array.from({ length: 11 }, (_, i) => ({
        userId: `u${i}`,
        name: `Agent ${i}`,
        email: `agent${i}@example.com`,
        unplaceable: 11 - i,
        failed: i % 3 === 0 ? 1 : 0,
      })),
    ),
  },
  {
    key: "coverage_needs_human",
    state: "everything placed or passed",
    channel: "recovery",
    text: formatCoverageNeedsHumanRecovery(),
  },

  // --- a calendar window that stopped covering the horizon (#1262) -------------
  {
    key: "calendar_window_uncovered",
    state: "one agent, never covered at all",
    channel: "alert",
    text: formatCalendarWindowAlert(
      [
        {
          userId: "u1",
          name: "Dana Ruiz",
          email: "dana.ruiz@example.com",
          calendarId: "dana.ruiz@example.com",
          syncWindowToIso: null,
          // Established for weeks: a calendar inside its first hydration cadence is
          // withheld by the #2300 grace and never reaches this copy at all.
          createdAtIso: "2026-07-01T00:00:00.000Z",
          hasRecordedFailure: false,
        },
      ],
      4,
    ),
  },
  {
    key: "calendar_window_uncovered",
    state: "several agents, one with no name, one short rather than never",
    channel: "alert",
    text: formatCalendarWindowAlert(
      [
        {
          userId: "u1",
          name: "Dana Ruiz",
          email: "dana.ruiz@example.com",
          calendarId: "dana.ruiz@example.com",
          syncWindowToIso: "2026-08-23T09:00:00.000Z",
          createdAtIso: "2026-07-01T00:00:00.000Z",
          hasRecordedFailure: false,
        },
        {
          userId: "u2",
          name: null,
          email: "sam.okafor@example.com",
          calendarId: "sam.okafor@example.com",
          syncWindowToIso: null,
          createdAtIso: "2026-07-01T00:00:00.000Z",
          hasRecordedFailure: false,
        },
      ],
      4,
    ),
  },
  {
    key: "calendar_window_uncovered",
    state: "more agents than the list cap",
    channel: "alert",
    text: formatCalendarWindowAlert(
      Array.from({ length: 11 }, (_, i) => ({
        userId: `u${i}`,
        name: `Agent ${i}`,
        email: `agent${i}@example.com`,
        calendarId: `agent${i}@example.com`,
        syncWindowToIso: null,
        createdAtIso: "2026-07-01T00:00:00.000Z",
        hasRecordedFailure: false,
      })),
      4,
    ),
  },
  {
    key: "calendar_window_uncovered",
    state: "every bookable calendar covered again",
    channel: "recovery",
    text: formatCalendarWindowRecovery(0),
  },
  {
    // #2300: with calendars withheld inside their first hydration cadence this reads
    // differently, and it is the wording that could overclaim, so it is previewed as
    // its own state rather than trusted to be a variation of the one above.
    key: "calendar_window_uncovered",
    state: "covered again, with new calendars still joining the rotation",
    channel: "recovery",
    text: formatCalendarWindowRecovery(2),
  },

  // --- an approved absence nobody has covered (#1238) -------------------------
  {
    key: "ooo_coverage_gap",
    state: "one appointment, one agent, inside 48 hours",
    channel: "alert",
    text: formatOooCoverageGapAlert([
      {
        userId: "u1",
        name: "Dana Ruiz",
        email: "dana.ruiz@example.com",
        imminent: 1,
        later: 0,
        soonestStartIso: "2026-08-18T14:00:00.000Z",
      },
    ]),
  },
  {
    key: "ooo_coverage_gap",
    state: "several agents, one with no name on the roster read",
    channel: "alert",
    text: formatOooCoverageGapAlert([
      {
        userId: "u1",
        name: "Dana Ruiz",
        email: "dana.ruiz@example.com",
        imminent: 3,
        later: 2,
        soonestStartIso: "2026-08-18T14:00:00.000Z",
      },
      {
        userId: "u2",
        name: null,
        email: "sam.okafor@example.com",
        imminent: 1,
        later: 0,
        soonestStartIso: "2026-08-18T18:00:00.000Z",
      },
    ]),
  },
  {
    key: "ooo_coverage_gap",
    state: "more agents than the list cap",
    channel: "alert",
    text: formatOooCoverageGapAlert(
      Array.from({ length: 11 }, (_, i) => ({
        userId: `u${i}`,
        name: `Agent ${i}`,
        email: `agent${i}@example.com`,
        imminent: 11 - i,
        later: 0,
        soonestStartIso: "2026-08-18T14:00:00.000Z",
      })),
    ),
  },
  {
    key: "ooo_coverage_gap",
    state: "every imminent one covered or passed",
    channel: "recovery",
    text: formatOooCoverageGapRecovery(),
  },
  {
    key: "ooo_coverage_gap_later",
    state: "the further-out worklist, which is not urgent",
    channel: "info",
    text: formatOooCoverageGapWhisper([
      {
        userId: "u1",
        name: "Dana Ruiz",
        email: "dana.ruiz@example.com",
        imminent: 0,
        later: 4,
        soonestStartIso: "2026-08-24T14:00:00.000Z",
      },
      {
        userId: "u2",
        name: "Sam Okafor",
        email: "sam.okafor@example.com",
        imminent: 0,
        later: 1,
        soonestStartIso: "2026-08-25T18:00:00.000Z",
      },
    ]),
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


  // --- the eight keys that were invisible until #1400 ------------------------
  // Every one of these is sent by a pure monitor check and wired in by bare
  // reference, so none of their copy had ever been rendered anywhere before it
  // reached somebody's phone. Read them.
  {
    // Every blocker rendered, because the blocker IS the actionable half and a
    // generic "could not classify" would send the reader nowhere (#1420). The
    // unusable-week one is worth reading beside the unreadable one: they look
    // similar and mean different things, and only one of them is a failed read.
    key: "booker_empty_reason",
    state: "the org's week could not be read",
    channel: "alert",
    text: formatEmptyReasonAlert("the org's business hours could not be read"),
  },
  {
    key: "booker_empty_reason",
    state: "both of its inputs were unreadable, so both are named",
    channel: "alert",
    text: formatEmptyReasonAlert(
      "the org's business hours and the booking horizon could not be read",
    ),
  },
  {
    key: "booker_empty_reason",
    state: "the week read, and is not a usable one",
    channel: "alert",
    text: formatEmptyReasonAlert("the org's business hours are unusable (timezone Mars/Olympus)"),
  },
  {
    key: "booker_empty_reason",
    state: "the booker can explain an empty week again",
    channel: "recovery",
    text: formatEmptyReasonRecovery(),
  },
  {
    // The production shape as of 2026-08-13, which is the state this alert was
    // built for: a whole uncovered Saturday plus a 17:00 to 20:00 tail on the five
    // weekdays. Rendered so the day grouping can be READ: five separate weekday
    // lines would push the uncovered Saturday off a phone notification.
    key: "roster_coverage_gap",
    state: "a whole advertised day and a weekday tail have nobody rostered",
    channel: "alert",
    text: formatRosterCoverageAlert([
      { weekday: 6, startMinute: 480, endMinute: 1200, wholeDay: true },
      ...[1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMinute: 1020,
        endMinute: 1200,
        wholeDay: false,
      })),
    ]),
  },
  {
    // The partial case alone, because it must not read like the whole-day one:
    // "we are thin after five" and "we say we are open and are shut" are different
    // findings and the reader acts on them differently.
    key: "roster_coverage_gap",
    state: "only a weekday evening tail is uncovered",
    channel: "alert",
    text: formatRosterCoverageAlert([
      { weekday: 1, startMinute: 1020, endMinute: 1200, wholeDay: false },
      { weekday: 3, startMinute: 1020, endMinute: 1200, wholeDay: false },
    ]),
  },
  {
    key: "roster_coverage_gap",
    state: "every advertised hour is covered again",
    channel: "recovery",
    text: formatRosterCoverageRecovery(),
  },
  {
    key: "sync_staleness",
    state: "agents have dropped out of the sync rotation",
    channel: "alert",
    text: formatSyncStalenessAlert(
      {
        staleCount: 2,
        worstAgeMs: 47 * 60_000,
        worstNeverSynced: true,
        stale: [
          {
            id: "u1",
            name: "Jordan Reyes",
            email: "jordan@trypennie.com",
            lastSyncedMs: null,
            ageMs: null,
            // An ESTABLISHED agent who has never been synced, which is the case
            // worth previewing: a brand new calendar row is withheld by the
            // first-run grace (#2299) and never reaches this copy at all.
            rotationSinceMs: NOW_MS - 3 * 24 * 60 * 60_000,
            hasRecordedFailure: false,
          },
          {
            id: "u2",
            name: "Sam Okafor",
            email: "sam@trypennie.com",
            lastSyncedMs: NOW_MS - 47 * 60_000,
            ageMs: 47 * 60_000,
            rotationSinceMs: NOW_MS - 3 * 24 * 60 * 60_000,
            hasRecordedFailure: false,
          },
        ],
        gracedCount: 0,
      },
      SYNC_STALENESS_THRESHOLD_MS,
    ),
  },
  {
    key: "sync_staleness",
    state: "the rotation has caught up",
    channel: "recovery",
    text: formatSyncStalenessRecovery(97, 0),
  },
  {
    // #2299: the same all-clear with agents withheld by the first-run grace reads
    // differently, and it is the wording that could overclaim, so it is previewed
    // as its own state rather than trusted to be a variation of the one above.
    key: "sync_staleness",
    state: "the rotation has caught up while new agents are still joining it",
    channel: "recovery",
    text: formatSyncStalenessRecovery(97, 4),
  },
  {
    // The fixture carries `healed`, because the auto-recompute case is the one the
    // copy has to get right: the customer impact is over and the fault is not.
    key: "availability_data_anomaly",
    state: "cached availability disagrees with the calendars",
    channel: "alert",
    text: formatDataAnomalyAlert(
      { bookedSolid: [], dataAnomaly: ["204", "311"], unverified: ["417"] },
      ["204"],
    ),
  },
  {
    key: "availability_data_anomaly",
    state: "availability reconverged",
    channel: "recovery",
    text: formatAvailabilityRecovery(),
  },
  {
    // Past the two day grace, which is the only state that reaches Slack: a hire
    // seeded this morning is silent, so a fixture inside the window would render a
    // message the lane never sends.
    key: "agents_on_unset_hours",
    state: "bookable agents left on the seeded week past the grace",
    channel: "alert",
    text: formatUnsetHoursAlert(
      [
        { id: "u1", email: "cfrank@trypennie.com", name: "C Frank", unsetSinceMs: NOW_MS - 6 * 24 * 60 * 60_000 },
        { id: "u2", email: "jsaminu@trypennie.com", name: null, unsetSinceMs: NOW_MS - 41 * 24 * 60 * 60_000 },
      ],
      NOW_MS,
    ),
  },
  {
    // The stamp nothing can read, which is reported rather than spared. It renders
    // its own words, so a broken date can never arrive as "NaN days".
    key: "agents_on_unset_hours",
    state: "one whose stamp cannot be read",
    channel: "alert",
    text: formatUnsetHoursAlert([{ id: "u3", email: "dpatel@trypennie.com", name: "D Patel", unsetSinceMs: null }], NOW_MS),
  },
  {
    key: "agents_on_unset_hours",
    state: "nobody past the grace",
    channel: "recovery",
    text: formatUnsetHoursRecovery(),
  },
  {
    // The fixture is the real 2026-09-07 sweep: 21 of 102 agents drifted in the five
    // days after 97 schedules were imported and verified idempotent, which is the
    // measurement this alert exists because of.
    key: "schedule_parity_drift",
    state: "the two systems hold different weeks",
    channel: "alert",
    text: buildScheduleParityAlert(
      classifyParitySweep({
        total: 102,
        compared: 100,
        runUrl: "https://github.com/Try-Pennie/slate/actions/runs/1",
        findings: [
          { verdict: "days-differ", count: 6, agents: ["forellana@", "jarias@", "lcastillo@"] },
          { verdict: "hours-differ", count: 6, agents: ["mharris@"] },
          { verdict: "timezone-differs", count: 9, agents: ["cfrank@"] },
          { verdict: "no-calcom-schedule", count: 2, agents: ["jsaminu@"] },
        ],
      }),
    ),
  },
  {
    // The state the lane produces on an ordinary morning since #2092: it corrected
    // most of the drift itself and what is left needs a person. Previewed
    // separately from the state above because the two read differently in the part
    // that matters, the last line: with an apply reported, the message must NOT
    // tell the reader to run the import the lane has just run (L111).
    key: "schedule_parity_drift",
    state: "the lane corrected what it could and something is left",
    channel: "alert",
    text: buildScheduleParityAlert(
      classifyParitySweep({
        total: 102,
        compared: 100,
        runUrl: "https://github.com/Try-Pennie/slate/actions/runs/1",
        findings: [
          { verdict: "hours-differ", count: 2, agents: ["jsullivan@", "pdelacerda@"] },
          { verdict: "no-calcom-schedule", count: 2, agents: ["jsaminu@"] },
        ],
        corrected: { count: 17, agents: ["forellana@", "jarias@", "lcastillo@", "mharris@"] },
      }),
    ),
  },
  {
    key: "schedule_parity_drift",
    state: "the two systems agree again",
    channel: "recovery",
    text: buildScheduleParityAllClear(
      classifyParitySweep({ total: 102, compared: 100, runUrl: "https://github.com/x/y", findings: [] }),
    ),
  },
  {
    key: "schedule_parity_drift",
    state: "they agree again after the lane corrected some of them",
    channel: "recovery",
    text: buildScheduleParityAllClear(
      classifyParitySweep({
        total: 102,
        compared: 100,
        runUrl: "https://github.com/x/y",
        findings: [],
        corrected: { count: 4, agents: ["dshearer@", "sconner@", "chammar@", "jarmstrong@"] },
      }),
    ),
  },
  {
    key: "migration_version_lag",
    state: "shipped code is ahead of the applied schema",
    channel: "alert",
    // Applied 0001 to 0102 with 0104 shipped, so the message names the two real
    // gaps. A fixture with a handful of applied versions would render 100 missing
    // migrations, which is not a state anyone will ever be paged about.
    text: formatMigrationDriftAlert(
      "db-behind",
      "0104",
      Array.from({ length: 102 }, (_, i) => String(i + 1).padStart(4, "0")),
    ),
  },
  {
    key: "migration_version_lag",
    state: "the schema caught up",
    channel: "recovery",
    text: formatMigrationDriftRecovery("0104"),
  },
  {
    key: "webhook_event_no_subscriber",
    state: "one event reaches nobody, with a live endpoint to fix",
    channel: "alert",
    text: formatUnsubscribedEventsAlert({
      measured: true,
      unsubscribed: ["booking.updated"],
      declared: [],
      // One active endpoint, which is production today: the remedy sentence has to
      // name editing THAT endpoint.
      endpointCount: 1,
    }),
  },
  {
    key: "webhook_event_no_subscriber",
    state: "several events reach nobody",
    channel: "alert",
    text: formatUnsubscribedEventsAlert({
      measured: true,
      unsubscribed: ["booking.updated", "booking.no_show"],
      declared: [],
      endpointCount: 3,
    }),
  },
  {
    key: "webhook_event_no_subscriber",
    state: "no active endpoint exists at all",
    channel: "alert",
    // A different remedy, not a different phrasing of the same one: with nothing to
    // edit, "add the event to that endpoint" names an action nobody can take.
    text: formatUnsubscribedEventsAlert({
      measured: true,
      unsubscribed: ["booking.created"],
      declared: [],
      endpointCount: 0,
    }),
  },
  {
    key: "webhook_event_no_subscriber",
    state: "every event has a subscriber again",
    channel: "recovery",
    text: formatUnsubscribedEventsRecovery(),
  },
  // #2367: the two ways booking handoffs fail to reach the sales side.
  {
    key: "handoff_channel_unset",
    state: "several handoffs waiting and no handoff channel set",
    channel: "alert",
    text: formatHandoffChannelUnsetAlert({
      waiting: 3,
      oldestWaitMs: 50 * 60_000,
      settingsUrl: "https://slate.trypennie.app/admin/alerts",
    }),
  },
  {
    key: "handoff_channel_unset",
    state: "one handoff waiting and no handoff channel set",
    channel: "alert",
    text: formatHandoffChannelUnsetAlert({
      waiting: 1,
      oldestWaitMs: 4 * 60_000,
      settingsUrl: "https://slate.trypennie.app/admin/alerts",
    }),
  },
  {
    key: "handoff_channel_unset",
    state: "a channel is set, or nothing is waiting",
    channel: "recovery",
    text: formatHandoffChannelUnsetRecovery(),
  },
  {
    key: "handoff_undelivered",
    state: "one handoff stuck behind a Slack refusal",
    channel: "alert",
    text: formatHandoffUndeliveredAlert({
      count: 1,
      oldestWaitMs: 95 * 60_000,
      thresholdMs: HANDOFF_UNDELIVERED_AFTER_MS,
      lastError: "not_in_channel",
      settingsUrl: "https://slate.trypennie.app/admin/alerts",
    }),
  },
  {
    // No post attempted yet (the booking read keeps failing), so there is no error to
    // quote and the sentence about one must not appear.
    key: "handoff_undelivered",
    state: "several handoffs waiting with no attempt to quote",
    channel: "alert",
    text: formatHandoffUndeliveredAlert({
      count: 4,
      oldestWaitMs: 3 * 60 * 60_000,
      thresholdMs: HANDOFF_UNDELIVERED_AFTER_MS,
      lastError: null,
      settingsUrl: "https://slate.trypennie.app/admin/alerts",
    }),
  },
  {
    key: "handoff_undelivered",
    state: "every open handoff has been posted",
    channel: "recovery",
    text: formatHandoffUndeliveredRecovery(),
  },
  {
    key: "hydration_all_failing",
    state: "every calendar in the batch failed, four runs running",
    channel: "alert",
    text: formatHydrationFailingAlert({ due: 6, consecutiveTicks: 4 }),
  },
  {
    key: "hydration_all_failing",
    state: "a single-calendar batch failed",
    channel: "alert",
    // Today's roster gives a batch of 2, so a one-calendar tick is reachable and the
    // singular grammar is the version that will actually ship first.
    text: formatHydrationFailingAlert({ due: 1, consecutiveTicks: 4 }),
  },
  {
    key: "hydration_all_failing",
    state: "the refresh is progressing again",
    channel: "recovery",
    text: formatHydrationRecovery(),
  },
  {
    key: "edge_limiter_unusable",
    state: "one endpoint's ceiling is missing from the deploy",
    channel: "alert",
    text: formatEdgeLimiterUnusableAlert({
      status: "unusable",
      runtime: "Cloudflare-Workers",
      missing: ["AVAIL_RATE_LIMITER"],
      contextUnreadable: false,
      serviceUnreachable: false,
      burstCeilingMissing: false,
    }),
  },
  {
    key: "edge_limiter_unusable",
    state: "the whole ratelimits block is missing",
    channel: "alert",
    // The shape a deploy that dropped the block produces. Read this one for the plural
    // grammar and for whether six plain-language endpoint names still scan on a phone.
    text: formatEdgeLimiterUnusableAlert({
      status: "unusable",
      runtime: "Cloudflare-Workers",
      missing: [...EDGE_LIMITER_BINDINGS],
      contextUnreadable: false,
      serviceUnreachable: false,
      burstCeilingMissing: false,
    }),
  },
  {
    key: "edge_limiter_unusable",
    state: "the request context cannot be read at all",
    channel: "alert",
    // A different remedy, not a rephrasing: nothing is misconfigured, so telling the
    // reader to check wrangler.jsonc would send them to a file that is already correct.
    text: formatEdgeLimiterUnusableAlert({
      status: "unusable",
      runtime: "Cloudflare-Workers",
      missing: [],
      contextUnreadable: true,
      serviceUnreachable: false,
      burstCeilingMissing: false,
    }),
  },
  {
    key: "edge_limiter_unusable",
    state: "the rate limit service refused a test call",
    channel: "alert",
    text: formatEdgeLimiterUnusableAlert({
      status: "unusable",
      runtime: "Cloudflare-Workers",
      missing: [],
      contextUnreadable: false,
      serviceUnreachable: true,
      burstCeilingMissing: false,
    }),
  },
  {
    key: "edge_limiter_unusable",
    state: "only the burst backstop is missing from the deploy",
    channel: "alert",
    // #1558. Read this one for whether it is clear that no endpoint is UNCAPPED here: every
    // per minute ceiling is still enforced and what is gone is the one count held across
    // datacenters. Borrowing the "no ceiling at all" wording from the states above would
    // read as an open door and get this treated as a drop-everything page.
    text: formatEdgeLimiterUnusableAlert({
      status: "unusable",
      runtime: "Cloudflare-Workers",
      missing: [],
      contextUnreadable: false,
      serviceUnreachable: false,
      burstCeilingMissing: true,
    }),
  },
  {
    key: "edge_limiter_unusable",
    state: "a ceiling AND the burst backstop are missing",
    channel: "alert",
    // The shape a truncated config produces. Read it for whether both faults survive in one
    // message: a reader told about only one will fix that one and stop.
    text: formatEdgeLimiterUnusableAlert({
      status: "unusable",
      runtime: "Cloudflare-Workers",
      missing: ["BOOKING_RATE_LIMITER"],
      contextUnreadable: false,
      serviceUnreachable: false,
      burstCeilingMissing: true,
    }),
  },
  {
    key: "edge_limiter_unusable",
    state: "the ceilings are being enforced again",
    channel: "recovery",
    text: formatEdgeLimiterRecovery(),
  },
  {
    key: "thin_tier_staffing",
    state: "a tier is resting on one agent",
    channel: "info",
    // #2237: a pool, not a code. The six codes of a tier resolve the same agents,
    // so the reader sees one line naming every booking link it covers rather than
    // six identical ones filling the whole list.
    text: formatThinTierNotice([
      ...["520", "521", "522"].map((code) => ({
        code,
        name: "Ultra High with Beyond",
        depth: 1,
        effectiveDepth: 1,
        outCount: 0,
        soleAgentName: "Jordan Reyes",
        hasWorkingFallback: false,
        flag: "spof" as const,
        effectiveFlag: "spof" as const,
        agents: [{ id: "u1", name: "Jordan Reyes", out: false }],
        poolKey: "ultra-high-beyond",
        poolLabel: "Ultra High with Beyond",
      })),
      {
        code: "311",
        name: "High",
        depth: 2,
        effectiveDepth: 1,
        outCount: 1,
        soleAgentName: null,
        hasWorkingFallback: true,
        flag: "thin",
        effectiveFlag: "spof",
        agents: [
          { id: "u2", name: "Sam Okafor", out: false },
          { id: "u3", name: "Priya Nair", out: true },
        ],
        poolKey: "high",
        poolLabel: "High",
      },
    ]),
  },
  {
    key: "agents_without_schedule",
    state: "bookable agents have no working hours",
    channel: "info",
    text: formatScheduleGapNotice([
      { id: "u1", name: "Jordan Reyes", email: "jordan@trypennie.com", org_id: "org1" },
      { id: "u2", name: null, email: "sam@trypennie.com", org_id: "org1" },
    ]),
  },
  {
    key: "agents_without_routing",
    state: "bookable agents match no bucket criteria",
    channel: "info",
    text: formatAttributeGapNotice([
      { id: "u1", name: "Jordan Reyes", email: "jordan@trypennie.com" },
      { id: "u2", name: null, email: "sam@trypennie.com" },
    ]),
  },
  {
    // #1412: a PAGE now. Read the first line: the reader has to know at once that
    // they are not hunting a fault, they are looking at leads being turned away
    // while every calendar behaves correctly.
    key: "availability_booked_solid",
    state: "several tiers are full",
    channel: "alert",
    text: formatBookedSolidAlert(["204", "311", "417"]),
  },
  {
    key: "availability_booked_solid",
    state: "one tier is full, so the count must not read as plural",
    channel: "alert",
    text: formatBookedSolidAlert(["204"]),
  },
  {
    key: "availability_booked_solid",
    state: "every tier is offering times again",
    channel: "recovery",
    text: formatBookedSolidRecovery(),
  },
  {
    key: "fallback_covered_availability",
    state: "an empty tier is covered by its fallback",
    channel: "info",
    text: formatFallbackCoveredNotice([
      {
        code: "204",
        via: "311",
        tierName: "Debt 20k to 30k, backend",
        viaTierName: "Debt 30k to 50k, frontend",
        emptyDepth: 1,
        coverDepth: 1,
      },
      {
        code: "417",
        via: "511",
        tierName: "Debt 40k to 50k, backend",
        viaTierName: "Debt 50k plus, backend",
        emptyDepth: 2,
        coverDepth: 4,
      },
    ]),
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
    state: "the daily cal.com comparison went quiet",
    channel: "alert",
    text: canaryAlertText(
      { lane: "schedule-parity", ageMs: 36 * 60 * 60_000, maxStaleMs: 30 * 60 * 60_000, unreadable: false },
      1800,
    ),
  },
  {
    key: "cron_lane_stale:*",
    state: "the daily cal.com comparison recovered",
    channel: "recovery",
    text: canaryRecoveryText("schedule-parity"),
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
  // #1394: the same key, a different fault. These lanes are NOT quiet; they run
  // faithfully and conclude nothing, which every other message here would
  // misdescribe.
  {
    key: "cron_lane_stale:*",
    state: "a detector has never once reached a verdict",
    channel: "alert",
    text: verdictBlindAlertText({
      lane: "verdict:availability-truth",
      ageMs: Infinity,
      maxStaleMs: VERDICT_STALE_BOUNDS_MS["verdict:availability-truth"],
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "a detector stopped reaching a verdict",
    channel: "alert",
    text: verdictBlindAlertText({
      lane: "verdict:booking-failure-rate",
      ageMs: 5 * 24 * 60 * 60_000,
      maxStaleMs: VERDICT_STALE_BOUNDS_MS["verdict:booking-failure-rate"],
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "a detector is measuring again",
    channel: "recovery",
    text: verdictRecoveryText("verdict:low-booking-volume"),
  },
  // #1561: the third thing that can be true of a detector. Not blind by fault and
  // not measuring, but deliberately switched off, which needs its own voice: the
  // whisper must not read as an incident, and the page must not read as a fault.
  {
    key: "detector_parked",
    state: "the checks that cannot conclude before cutover",
    channel: "info",
    text: verdictParkedInfoText(Object.keys(PARKED_VERDICT_DETECTORS)),
  },
  // There WAS a second state here rendering one named lane, back when two were
  // parked and the whisper had a visibly different singular form to read. Since
  // #1831 armed the truth probe the registry holds exactly one entry, so the state
  // above IS the singular form, and the only way to preview the plural again would
  // be to name a lane the registry has no entry for, which renders the word
  // undefined into a sentence somebody reads. Nothing is lost: the state above is
  // derived from the registry, so a second park brings the plural wording back into
  // the preview on its own.
  {
    key: "detector_unpark:*",
    state: "a parked check has started concluding",
    channel: "alert",
    text: verdictUnparkAlertText("verdict:booking-failure-rate"),
  },
  {
    key: "detector_unpark:*",
    state: "a parked check has been armed",
    channel: "recovery",
    text: verdictUnparkRecoveryText("verdict:booking-failure-rate"),
  },
  // #1562: the same page's OTHER ending, and the reason it needs reading beside the
  // one above. Nobody armed anything here; the verdict simply lapsed, and the armed
  // wording would have claimed otherwise.
  {
    key: "detector_unpark:*",
    state: "a parked check went quiet again with nobody arming it",
    channel: "recovery",
    text: verdictUnparkLapsedText("verdict:booking-failure-rate"),
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
    state: "stuck slots freed after a missed cancel",
    channel: "alert",
    text: reconcileFreedAlert({ freedCancelled: 14, freedOrphans: 0, agentCount: 6 }),
  },
  {
    key: "reconcile_busy_blocks",
    state: "rows freed that nothing owned",
    channel: "alert",
    text: reconcileFreedAlert({ freedCancelled: 0, freedOrphans: 2, agentCount: 1 }),
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
    key: "outbox_all_handed_off",
    state: "every leased row stood down",
    channel: "alert",
    text: outboxAllHandedOffAlert(3, 5),
  },
  {
    key: "outbox_all_handed_off",
    state: "the drain is completing rows again",
    channel: "recovery",
    text: outboxHandoffRecovery(),
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
  // #2228. Three states, because the number is the message and it reads
  // differently at each: the realistic steady rate (most of a small day's Beyond
  // leads), the day it is only one, and the mixed case where the noun and the verb
  // take different numbers. The old per booking page previewed one example, which
  // is exactly how a rate nobody had read at its real frequency shipped.
  {
    key: "beyond_overflow_rate",
    state: "the realistic day: most Beyond leads overflow",
    channel: "info",
    text: beyondOverflowReportPreview(9, 11),
  },
  {
    key: "beyond_overflow_rate",
    state: "one Beyond lead, and it overflowed",
    channel: "info",
    text: beyondOverflowReportPreview(1, 1),
  },
  {
    key: "beyond_overflow_rate",
    state: "one of several overflowed",
    channel: "info",
    text: beyondOverflowReportPreview(1, 7),
  },
  {
    key: "tier_fallback:*",
    state: "a booking fell back one debt tier",
    channel: "alert",
    text: tierFallbackAlert({ requestedCode: "411", effectiveCode: "311" })?.text ?? "",
  },
  {
    key: "tier_fallback:*",
    state: "the same, where the backend service changed as well",
    channel: "alert",
    text: tierFallbackAlert({ requestedCode: "522", effectiveCode: "432" })?.text ?? "",
  },
  {
    key: "tier_fallback_deep:*",
    state: "a booking fell back several debt tiers",
    channel: "alert",
    text: tierFallbackAlert({ requestedCode: "411", effectiveCode: "111" })?.text ?? "",
  },
  { key: "booker_unstaffed:*", state: "a customer opened a bucket with nobody in it", channel: "alert",
    text: bookerUnstaffedAlert("120") },

  // --- the warehouse mirror ---------------------------------------------------
  { key: "snowflake_healthcheck", state: "self-check failing", channel: "alert",
    text: snowflakeHealthcheckAlert("390100 SQL compilation error") },
  { key: "snowflake_healthcheck", state: "passing again", channel: "recovery",
    text: snowflakeHealthcheckRecovery() },
  // #1230: the drift page reads completely differently per cause, and the reason
  // sentence comes from evaluateRecon, so it is CALLED here rather than retyped.
  // The stranded fixture is the real 2026-08-03 page (an OOO audit backfill
  // inserted behind the export watermark) that the old copy blamed on a lagging
  // lane.
  // The real 2026-08-03 numbers: 278 audit rows in Supabase, 27 in the warehouse,
  // 277 of them already behind the cursor.
  { key: "snowflake_reconcile_drift", state: "rows stranded behind the export watermark", channel: "alert",
    text: snowflakeDriftAlert(
      evaluateRecon(
        [{ table: "audit_log", supabase: 278, snowflake: 27, drift: 251, behindCursor: 277 }],
        [],
        [{ table: "audit_log", cursorTs: "2026-08-03T05:59:00.000Z", newestTs: "2026-08-03T05:59:00.000Z", oldestPendingTs: "2026-08-03T05:59:00.000Z", lagMs: 0, backlog: 0 }],
      ).reasons,
    ) },
  // #1231: a small stranding the total-count tolerance would never have reported.
  { key: "snowflake_reconcile_drift", state: "a single row stranded, under the drift tolerance", channel: "alert",
    text: snowflakeDriftAlert(
      evaluateRecon(
        [{ table: "booking_events", supabase: 1086, snowflake: 1084, drift: 2, behindCursor: 1085 }],
        [],
        [{ table: "booking_events", cursorTs: "2026-08-03T14:11:47.000Z", newestTs: "2026-08-03T14:11:47.000Z", oldestPendingTs: "2026-08-03T14:11:47.000Z", lagMs: 0, backlog: 0 }],
      ).reasons,
    ) },
  { key: "snowflake_reconcile_drift", state: "the export lane is behind", channel: "alert",
    text: snowflakeDriftAlert(
      evaluateRecon(
        [{ table: "bookings", supabase: 10412, snowflake: 9880, drift: 532, behindCursor: 9880 }],
        [],
        [{ table: "bookings", cursorTs: "2026-08-03T03:00:00.000Z", newestTs: "2026-08-03T06:00:00.000Z", oldestPendingTs: "2026-08-03T03:00:01.000Z", lagMs: 3 * 60 * 60_000, backlog: 540 }],
      ).reasons,
    ) },
  { key: "snowflake_reconcile_drift", state: "the cause could not be measured", channel: "alert",
    text: snowflakeDriftAlert(
      evaluateRecon([{ table: "bookings", supabase: 10412, snowflake: 9880, drift: 532, behindCursor: 9880 }], []).reasons,
    ) },
  { key: "snowflake_reconcile_drift", state: "the warehouse count cannot be trusted", channel: "alert",
    text: snowflakeDriftAlert(
      evaluateRecon(
        [{ table: "routing_decisions", supabase: 51002, snowflake: 51002, drift: 0, behindCursor: 51001 }],
        [{ table: "routing_decisions", id: "rd_4f21c8", foundInSnowflake: false }],
      ).reasons,
    ) },
  { key: "snowflake_reconcile_drift", state: "back in step", channel: "recovery",
    text: snowflakeDriftRecovery() },
  { key: "snowflake_erasure_residual", state: "one real booking", channel: "alert",
    text: erasureResidualAlert(
      ["bookings: 1 row still holds contact data for an erased booking"],
      ["7dc86c04-bb42-4db9-8c08-7bbd408ccd25"],
    ) },
  // The truncation state is previewed because it is the one a large erasure batch
  // produces, and an untruncated list of uuids is unreadable on a phone (#1195).
  { key: "snowflake_erasure_residual", state: "a batch too large to name in full", channel: "alert",
    text: erasureResidualAlert(
      ["bookings: 9 rows still hold contact data for erased bookings"],
      ["bk-1", "bk-2", "bk-3", "bk-4", "bk-5", "bk-6", "bk-7", "bk-8", "bk-9"],
    ) },
  // The class could not be read, so everything was treated as real. Previewed
  // because the reader has to be able to tell a measured "real" from a fallback.
  { key: "snowflake_erasure_residual", state: "class unreadable, treated as real", channel: "alert",
    text: erasureResidualAlert(
      ["booking_events: 1 row still holds contact data for an erased booking"],
      ["bk-1"],
    ) + erasureClassificationUnreadable("the bookings read failed, so no id could be classified") },
  { key: "snowflake_erasure_residual_test", state: "a test fixture's erasure is unfinished", channel: "info",
    text: erasureResidualTestNotice(
      ["booking_outbox: 1 row still holds contact data for an erased booking"],
      ["7dc86c04-bb42-4db9-8c08-7bbd408ccd25"],
    ) },
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
  // #2097. Each of the five refusals reads differently, and the two that matter most
  // are shown: a deployment that never had the secrets, which is the one whose
  // symptoms all look healthy, and an ordinary Twilio outage.
  { key: "twilio_sync_failures", state: "the deployment has no Twilio credentials", channel: "alert",
    text: twilioSyncFailureAlert(
      "Twilio is not configured on this deployment: TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET and TWILIO_WORKSPACE_SID must all be set (see DEPLOY.md).",
    ) },
  { key: "twilio_sync_failures", state: "Twilio refused the key", channel: "alert",
    text: twilioSyncFailureAlert("Twilio refused the credentials (401). The API key has to be TaskRouter scoped.") },
  { key: "twilio_sync_failures", state: "reading Twilio again", channel: "recovery",
    text: twilioSyncRecovery() },
  // #2114: the half AFTER the read. Each count is previewed on its own as well as
  // together, because each one sends a reader somewhere different and the combined
  // message is the only place their ordering can be read.
  { key: "twilio_write_failures", state: "a flip keeps throwing", channel: "alert",
    text: twilioWriteFailureAlert({ flips: 2, sweeps: 0, attributes: 0 }) },
  { key: "twilio_write_failures", state: "a coverage move could not be queued", channel: "alert",
    text: twilioWriteFailureAlert({ flips: 0, sweeps: 1, attributes: 0 }) },
  { key: "twilio_write_failures", state: "a routing attribute write would not land", channel: "alert",
    text: twilioWriteFailureAlert({ flips: 0, sweeps: 0, attributes: 4 }) },
  { key: "twilio_write_failures", state: "all three at once", channel: "alert",
    text: twilioWriteFailureAlert({ flips: 1, sweeps: 2, attributes: 3 }) },
  { key: "twilio_write_failures", state: "the writes are landing again", channel: "recovery",
    text: twilioWriteFailureRecovery() },
  { key: "twilio_marked_no_worker", state: "one agent", channel: "alert",
    text: twilioOrphanedMarkAlert(1) },
  { key: "twilio_marked_no_worker", state: "several agents", channel: "alert",
    text: twilioOrphanedMarkAlert(3) },
  { key: "twilio_marked_no_worker", state: "every mark has a worker again", channel: "recovery",
    text: twilioOrphanedMarkRecovery() },
  // Each shape alone, then all three together, because the sentence is assembled
  // from parts and a reader has to be able to see each one read on its own.
  { key: "salesforce_user_id_conflicts", state: "one stored id disagrees", channel: "alert",
    text: salesforceUserIdConflictAlert(1, 0, 0) },
  { key: "salesforce_user_id_conflicts", state: "one email is shared in Salesforce", channel: "alert",
    text: salesforceUserIdConflictAlert(0, 1, 0) },
  { key: "salesforce_user_id_conflicts", state: "one id is already held by another row", channel: "alert",
    text: salesforceUserIdConflictAlert(0, 0, 1) },
  { key: "salesforce_user_id_conflicts", state: "several of each at once", channel: "alert",
    text: salesforceUserIdConflictAlert(3, 2, 4) },
  { key: "salesforce_user_id_conflicts", state: "the roster agrees again", channel: "recovery",
    text: salesforceUserIdConflictRecovery() },
  // #1653. One duplicated name over a whole team is the shape this really takes
  // (a manager carries roughly 15 reps), so the singular and the plural are both
  // rendered: they read very differently on a phone.
  { key: "salesforce_manager_ambiguous", state: "one name, one person affected", channel: "alert",
    text: salesforceManagerAmbiguousAlert(1, 1) },
  { key: "salesforce_manager_ambiguous", state: "one name, a whole team affected", channel: "alert",
    text: salesforceManagerAmbiguousAlert(15, 1) },
  { key: "salesforce_manager_ambiguous", state: "several duplicated names", channel: "alert",
    text: salesforceManagerAmbiguousAlert(31, 2) },
  { key: "salesforce_manager_ambiguous", state: "every manager name is unique again", channel: "recovery",
    text: salesforceManagerAmbiguousRecovery() },
  // #1833. The singular is the shape this really takes: one agent whose balance
  // tiers were cleared for leave. The plural is what a narrowed roster query
  // looks like, which is a very different morning.
  { key: "salesforce_roster_divergence", state: "one bookable agent", channel: "alert",
    text: salesforceRosterDivergenceAlert(1) },
  { key: "salesforce_roster_divergence", state: "several bookable agents", channel: "alert",
    text: salesforceRosterDivergenceAlert(7) },
  { key: "salesforce_roster_divergence", state: "every bookable agent is confirmed again", channel: "recovery",
    text: salesforceRosterDivergenceRecovery() },
  { key: "recompute_headroom", state: "falling behind its budget", channel: "alert",
    text: recomputeHeadroomAlert(18, 64, 60, 98, RECOMPUTE_BEHIND_CYCLES) },
  { key: "recompute_headroom", state: "caught up", channel: "recovery",
    text: recomputeHeadroomRecovery(RECOMPUTE_REARM_CYCLES) },
  { key: "bucket_slots_stale", state: "rows stale after a pass", channel: "alert",
    text: bucketSlotsStaleAlert(9, 12, ["411", "412", "511", "512", "611"]) },
  // #1304: the same staleness with nothing able to EXPLAIN it. Distinct wording,
  // because the ordinary page's claim about the writers was never measured here.
  { key: "bucket_slots_stale", state: "stale, and the invalidation marker cannot be read", channel: "alert",
    text: bucketSlotsStaleUnreadableMarkerAlert(62, 12, ["411", "412", "511", "512", "611"], 3) },
  { key: "bucket_slots_stale", state: "nothing stale", channel: "recovery",
    text: bucketSlotsStaleRecovery() },

  // --- reaching people ---------------------------------------------------------
  { key: "ooo-digest-unreachable:*", state: "a manager unreachable for days", channel: "alert",
    text: digestUnreachableAlert("Priya Raman (priya.raman@trypennie.com)", 2) },
  { key: "ooo-digest-unreachable:*", state: "reached again", channel: "recovery",
    text: digestUnreachableRecovery("Priya Raman (priya.raman@trypennie.com)") },
  { key: "ooo-digest-unrouted-unreachable", state: "the no-approver post failing for days", channel: "alert",
    text: digestUnroutedUnreachableAlert(3, 2) },
  { key: "ooo-digest-unrouted-unreachable", state: "one request, so the sentence reads singular", channel: "alert",
    text: digestUnroutedUnreachableAlert(1, 2) },
  { key: "ooo-digest-unrouted-unreachable", state: "posting again", channel: "recovery",
    text: digestUnroutedUnreachableRecovery() },
  { key: "stale_phone_invite:*", state: "a corrected number the invite did not take", channel: "alert",
    text: stalePhoneInviteAlert("dana.whitfield@trypennie.com", "b7f1c2e4-9a3d-4c88-b0f2-15ac7d9e6431") },
  { key: "webhook_dead:*", state: "an endpoint dead-lettering", channel: "alert",
    text: webhookDeadAlert("https://hooks.regal.io/slate/bookings", "booking.created", 5, "502 Bad Gateway",
      { intermediary: false }) },
  { key: "webhook_dead:*", state: "a firewall in front of the subscriber answering with a block page", channel: "alert",
    text: webhookDeadAlert("https://hooks.regal.io/slate/bookings", "booking.created", 5,
      "403 intermediary HTML page, cf-ray 8f2c1a9b4d5e6f70-EWR", { intermediary: true }) },
  { key: "webhook_dead:*", state: "a reply carrying no body at all", channel: "alert",
    text: webhookDeadAlert("https://hooks.regal.io/slate/bookings", "booking.created", 5, "204 no reply body",
      { intermediary: false }) },
  { key: "webhook_dead:*", state: "delivering again", channel: "recovery",
    text: webhookDeadRecovery("https://hooks.regal.io/slate/bookings") },

  // --- the rest ----------------------------------------------------------------
  { key: "watch_lapse", state: "renewal healthy again", channel: "recovery", text: watchLapseRecovery() },
  { key: "retention_skipped:*", state: "deleting again", channel: "recovery",
    text: retentionResumedText("prune-bookings-pii") },
  { key: "bookable_blocked:*", state: "calendar definitively gone", channel: "alert",
    text: bookableBlockedAlert("dana.whitfield@trypennie.com") },
  { key: "bookable_blocked:*", state: "the account was never signed up for Calendar", channel: "alert",
    text: bookableNotProvisionedAlert("ariel.nwosu@trypennie.com") },
  { key: "bookable_blocked:*", state: "the calendar answered and could not be read", channel: "alert",
    text: bookableUnhydratedAlert("ariel.nwosu@trypennie.com", 0, 1) },
  { key: "bookable_blocked:*", state: "several calendars, none of them readable", channel: "alert",
    text: bookableUnhydratedAlert("kit.alvarez@trypennie.com", 0, 3) },
  { key: "bookable_blocked:*", state: "one of several calendars could not be read", channel: "alert",
    // Its own state because the counts change where the reader should look: one of
    // four points at a particular calendar, none of one points at the account.
    text: bookableUnhydratedAlert("dana.whitfield@trypennie.com", 3, 4) },
  { key: "bookable_blocked:*", state: "Google returned no calendar at all", channel: "alert",
    text: bookableUnhydratedAlert("sam.okafor@trypennie.com", 0, 0) },
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
  // #1974: a page that failed to RENDER, which is a different event from a 500
  // and reads differently: nobody got a status code, somebody got a screen.
  // Three states, because the SCOPE sentence is what decides whether the reader
  // gets up, and the three are the three different things Slate can know: how
  // many, that a break is repeating but the figure is missing, and that the
  // counter itself could not answer.
  { key: "boundary_error:*", state: "a page showed its error screen, counted", channel: "alert",
    text: boundaryCatchAlert("/admin", "digest 3847221905", {
      count: 11, measured: true, windowMinutes: 30 }) },
  { key: "boundary_error:*", state: "a page showed its error screen, the figure unreadable", channel: "alert",
    text: boundaryCatchAlert("/admin", "digest 3847221905", {
      count: null, measured: true, windowMinutes: 30 }) },
  { key: "boundary_error:*", state: "a page showed its error screen, uncounted", channel: "alert",
    text: boundaryCatchAlert("/admin", "digest 3847221905", {
      count: null, measured: false, windowMinutes: 30 }) },
  // Three states, because the reader's next move differs. The database rejecting
  // the row points at the CALLER (#1220, and #1223 for the copy); a grant or schema
  // break and a thrown client point at the trail itself.
  { key: "audit_write_failed", state: "the database rejected the row", channel: "alert",
    text: auditWriteFailedAlert(
      "ooo.approve",
      'insert or update on table "audit_log" violates foreign key constraint…',
      "audit_log_target_id_fkey",
    ) },
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
  // #1557: the two answers a ceiling can give a caller it cannot identify. They read
  // differently on purpose: the reader has to know whether anything was turned away.
  { key: "rate_limit_unidentified:*", state: "a ceiling that served the request anyway",
    channel: "alert", text: unidentifiedCallerAlert(BOOKING_LIMITER) },
  { key: "rate_limit_unidentified:*", state: "a ceiling that refused the request",
    channel: "alert", text: unidentifiedCallerAlert(CLIENT_ERROR_ADDRESS_POLICY) },
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
  // #1470: the ending this one never had. It names no request id, for the same
  // reason as the cal.com all-clear below: the key covers every approval relying
  // on a fallback, and by the time this sends there are none.
  { key: "ooo_busy_block_fallback", state: "nothing is relying on the fallback any more",
    channel: "recovery", text: formatFallbackClearedRecovery() },
  { key: "ooo_calcom", state: "the override failed at approval", channel: "alert",
    text: oooCalcomAlert("req_9f2", "409 conflict") },
  // #1280: the ending it never had. It names no request id on purpose: the page is
  // one key covering every failing approval, and by the time this sends there are
  // none, so quoting one would suggest the others were left.
  { key: "ooo_calcom", state: "the retry sweep landed every override", channel: "recovery",
    text: formatOverrideRecovery() },
  { key: "ooo_agent_dm", state: "the decision DM did not land", channel: "alert",
    text: oooAgentDmAlert("dana.whitfield@trypennie.com", "req_9f2") },
  { key: "ooo_undo", state: "undoing the manager event failed", channel: "alert",
    text: oooUndoManagerAlert("req_9f2", "404 notFound") },
  { key: "ooo_undo", state: "undoing the agent event failed", channel: "alert",
    text: oooUndoAgentAlert("req_9f2", "404 notFound") },
  { key: "ooo_coverage_stop", state: "the sweep could not be stopped after the request was closed",
    channel: "alert", text: oooCoverageStopAlert("req_9f2", "count failed [cancel-pending-coverage-items]") },
];

/**
 * The booking handoff NOTICES (#2367), rendered by the same builder the monitor lane
 * posts with. They are not alerts: each is posted once to the handoff channel for the
 * sales side and has no cooldown or all-clear, so they are not catalog keys. They are
 * here so the words a salesperson acts on can be read before they ship, exactly like
 * the pages above, and the coverage guard holds every kind to having one.
 */
export interface HandoffNoticePreview {
  kind: HandoffKind;
  state: string;
  text: string;
}

const PREVIEW_BOOKING: HandoffNoticeBooking = {
  startsAt: "2026-09-17T15:30:00.000Z",
  agentName: "Dana Whitfield",
  agentEmail: "dana.whitfield@trypennie.com",
  attendeeName: "Jordan Lee",
};
const PREVIEW_BOOKING_URL = "https://slate.trypennie.app/admin/bookings/5b0c7a8e-2f41-4d7e-9a61-0c3f1e2d4b5a";

export const HANDOFF_NOTICE_PREVIEWS: HandoffNoticePreview[] = [
  {
    kind: "duplicate-unresolved",
    state: "no other call found for the lead",
    text: formatHandoffNotice(
      { kind: "duplicate-unresolved", detail: { finding: "no-other-call", weakerMatch: null, laterBookingStartsAt: null } },
      PREVIEW_BOOKING,
      PREVIEW_BOOKING_URL,
    ),
  },
  {
    kind: "duplicate-unresolved",
    state: "no strong match, a phone only match, and the later start the caller sent",
    text: formatHandoffNotice(
      {
        kind: "duplicate-unresolved",
        detail: { finding: "no-other-call", weakerMatch: "phone-only", laterBookingStartsAt: "2026-09-18T18:00:00.000Z" },
      },
      PREVIEW_BOOKING,
      PREVIEW_BOOKING_URL,
    ),
  },
  {
    kind: "duplicate-unresolved",
    state: "the named call is the newest one",
    text: formatHandoffNotice(
      { kind: "duplicate-unresolved", detail: { finding: "named-is-newest", weakerMatch: null, laterBookingStartsAt: null } },
      PREVIEW_BOOKING,
      PREVIEW_BOOKING_URL,
    ),
  },
  {
    kind: "duplicate-unresolved",
    state: "two calls share email and phone under different Salesforce ids",
    text: formatHandoffNotice(
      { kind: "duplicate-unresolved", detail: { finding: "identity-conflict", weakerMatch: null, laterBookingStartsAt: null } },
      PREVIEW_BOOKING,
      PREVIEW_BOOKING_URL,
    ),
  },
  {
    kind: "duplicate-unresolved",
    state: "a redacted lead and a detail this code cannot read",
    text: formatHandoffNotice(
      { kind: "duplicate-unresolved", detail: {} },
      { ...PREVIEW_BOOKING, attendeeName: null },
      PREVIEW_BOOKING_URL,
    ),
  },
  {
    kind: "owner-reassign-refused",
    state: "the owner is not taking bookings",
    text: formatHandoffNotice(
      {
        kind: "owner-reassign-refused",
        detail: { refusal: "owner-not-bookable", requestedOwnerUserId: "u-1", requestedOwnerEmail: "sam.ortiz@trypennie.com" },
      },
      PREVIEW_BOOKING,
      PREVIEW_BOOKING_URL,
    ),
  },
  {
    kind: "owner-reassign-refused",
    state: "the owner has approved time off during the call",
    text: formatHandoffNotice(
      {
        kind: "owner-reassign-refused",
        detail: { refusal: "owner-on-time-off", requestedOwnerUserId: "u-1", requestedOwnerEmail: "sam.ortiz@trypennie.com" },
      },
      PREVIEW_BOOKING,
      PREVIEW_BOOKING_URL,
    ),
  },
  {
    kind: "owner-reassign-refused",
    state: "Slate has no account for the owner",
    text: formatHandoffNotice(
      {
        kind: "owner-reassign-refused",
        detail: { refusal: "owner-not-found", requestedOwnerUserId: null, requestedOwnerEmail: "former.owner@trypennie.com" },
      },
      PREVIEW_BOOKING,
      PREVIEW_BOOKING_URL,
    ),
  },
];

/**
 * The owner reassign NOTICE (#2372), rendered by the same builder the reassign
 * outbox step posts with.
 *
 * Like the handoff notices above it is not a catalog key: it goes to the handoff
 * channel once per reassign, with no cooldown and no all-clear. It is here for the
 * same reason they are, and for one of its own: the whole point of the copy is that
 * a lead's call time is given in TWO clocks, and whether the second one is worth
 * saying is a judgement about a rendered sentence, which only a rendered sentence
 * can settle.
 */
export interface OwnerNoticePreview {
  state: string;
  text: string;
}

const PREVIEW_OWNER_NOTICE = {
  advisorName: "Dana Whitfield",
  advisorEmail: "dana.whitfield@trypennie.com",
  advisorTimezone: "America/Denver",
  startsAt: "2026-09-17T15:30:00.000Z",
  leadName: "Jordan Lee",
  bookingUrl: PREVIEW_BOOKING_URL,
};

export const OWNER_NOTICE_PREVIEWS: OwnerNoticePreview[] = [
  {
    state: "the advisor keeps another clock than the sales side",
    text: formatOwnerReassignNotice(PREVIEW_OWNER_NOTICE),
  },
  {
    // 27 of the roster are in Phoenix, which is an hour behind Denver for eight
    // months of the year and level with it for the other four (#2117).
    state: "an advisor in Phoenix, where the gap changes with the season",
    text: formatOwnerReassignNotice({ ...PREVIEW_OWNER_NOTICE, advisorTimezone: "America/Phoenix" }),
  },
  {
    state: "the advisor is already on the sales side's clock, so it is said once",
    text: formatOwnerReassignNotice({ ...PREVIEW_OWNER_NOTICE, advisorTimezone: "America/New_York" }),
  },
  {
    state: "Slate holds no working hours for the advisor, so it claims no local time",
    text: formatOwnerReassignNotice({ ...PREVIEW_OWNER_NOTICE, advisorTimezone: null }),
  },
  {
    state: "the advisor's own day is the next one",
    text: formatOwnerReassignNotice({ ...PREVIEW_OWNER_NOTICE, advisorTimezone: "Asia/Tokyo" }),
  },
  {
    state: "a redacted lead, and an advisor Slate holds only an address for",
    text: formatOwnerReassignNotice({
      ...PREVIEW_OWNER_NOTICE,
      leadName: null,
      advisorName: null,
    }),
  },
  {
    state: "a start time this could not read",
    text: formatOwnerReassignNotice({ ...PREVIEW_OWNER_NOTICE, startsAt: "" }),
  },
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
