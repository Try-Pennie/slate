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
import { DateTime } from "luxon";
import { EmailSendError } from "@/lib/notify/email-errors";
import { shortErrorReason } from "@/lib/notify/error-text";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";
import { ALERT_CATALOG, type AlertKind } from "@/lib/notify/alert-catalog";
import { formatRetiredKeyAlert } from "@/lib/booking/retired-keys";
import { formatCallMeNowFailedAlert } from "@/lib/salesforce/call-me-now";
import { PARTNER_BUCKET_CODE, PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { noEligibleAgentsAlert } from "@/lib/availability/bucket-coverage";
import {
  tierUnstaffedMessage,
  tierNoSlotsMessage,
  tierRecoveredMessage,
} from "@/lib/monitor/tier-staffing";
import type { DayTally, TierCauseReading } from "@/lib/monitor/tier-cause";
import { RECOMPUTE_BEHIND_CYCLES, RECOMPUTE_REARM_CYCLES } from "@/lib/availability/recompute-alert";
import {
  formatWatchLapseAlert,
  formatSyncFailureAlert,
  formatSyncRecoveryNotice,
  type FailingAgent,
} from "@/lib/notify/alerts";
import {
  retentionAlertText,
  BACKUP_STALE_BOUNDS_MS,
  LANE_STALE_BOUNDS_MS,
  LOG_SHIPPING_LANE,
  LOG_SHIPPING_STALE_BOUNDS_MS,
  POOL_GROUPING_LANE,
  POOL_GROUPING_STALE_BOUNDS_MS,
  TIME_OFF_STALE_BOUNDS_MS,
  UPTIME_STALE_BOUNDS_MS,
  VERDICT_STALE_BOUNDS_MS,
} from "@/lib/monitor/health";
import { FAILURE_RATE_VERDICT_LANE, PARKED_VERDICT_DETECTORS } from "@/lib/monitor/verdict-freshness";
import {
  checksGatedByStep,
  monitorStepFailingAlert,
  monitorStepRecoveryText,
  MONITOR_STEP_FAILING_TICKS,
  MONITOR_STEP_REARM_TICKS,
  stepFailingRuns,
  stepRearmRuns,
} from "@/lib/monitor/step-failure";
import { ACTIVATION_BUDGET_MS } from "@/lib/bookable/activation-allowance";
import { REFUSED_POOL_EXIT_AFTER_MS } from "@/lib/bookable/refused-pool-exit-rule";
import { formatUnsetHoursAlert, formatUnsetHoursRecovery } from "@/lib/monitor/unset-hours";
import {
  formatBelowLeadTierAlert,
  submissionAgreement,
  teamAtTime,
  type BelowFinding,
  type LeadTierOffer,
  type PageFacts,
  type SubmissionHistory,
} from "@/lib/monitor/below-lead-tier";
import { formatOffsiteOriginAlert, type OffsiteFinding } from "@/lib/monitor/offsite-origin";
import {
  formatOfferedNobodyFreeAlert,
  formatOfferedNobodyFreeAllClear,
  type OfferedFinding,
} from "@/lib/monitor/offered-nobody-free";
import { BUDGET_WARN_SHARE, judgeBudgets, sloBudgetClearText, sloBudgetPageText } from "@/lib/monitor/slo-budget";
import {
  findCrossSystemBookings,
  formatCrossSystemBookingAlert,
  formatCrossSystemBookingRecovery,
  formatCrossSystemBookingRetired,
  type CrossSystemPair,
  type SlateUpcomingBooking,
} from "@/lib/monitor/cross-system-bookings";
import type { CalcomUpcomingBooking } from "@/lib/calcom/upcoming-bookings";
import { PARTNER_KEYS } from "@/lib/booking/partner-keys";

/**
 * #2933: the 2026-10-01 duplicate's SHAPE on synthetic ids, an invented advisor and
 * host, and an address on a reserved domain. Every preview pair is produced by the
 * real judge from these inputs rather than written out by hand, so a state can only
 * claim to have matched on what its inputs actually carry.
 */
const PREVIEW_CROSS_SYSTEM_NOW = Date.parse("2026-10-01T13:00:00.000Z"); // parse-ok: a literal
const PREVIEW_CROSS_SYSTEM_SUB = "a04PREVIEW0000001A";
const PREVIEW_CROSS_SYSTEM_EMAIL = "preview.lead@example.invalid";
const PREVIEW_CROSS_SYSTEM_SLATE: SlateUpcomingBooking = {
  id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  starts_at: "2026-10-02T20:00:00.000Z",
  salesforce_id: "00QPREVIEW00000001",
  external_id: null,
  agent_name: "Dana Whitfield",
  agent_email: "dana.whitfield@trypennie.com",
  attendee_email: PREVIEW_CROSS_SYSTEM_EMAIL,
  prefill: { [PARTNER_KEYS.submissionId]: PREVIEW_CROSS_SYSTEM_SUB },
  referrer_origin: "https://www.trypennie.com",
};
const PREVIEW_CROSS_SYSTEM_CAL: CalcomUpcomingBooking = {
  id: 90000001,
  uid: "PreviewUid0000000000A1",
  start: "2026-10-01T22:00:00.000Z",
  status: "accepted",
  host: "sam-host",
  submissionId: PREVIEW_CROSS_SYSTEM_SUB,
  attendeeEmails: [PREVIEW_CROSS_SYSTEM_EMAIL],
};
const PREVIEW_CROSS_SYSTEM_URL = `https://slate.trypennie.app/admin/bookings/${PREVIEW_CROSS_SYSTEM_SLATE.id}`;

/** A convergence result with only the named counts set, for the #2459 preview. */
function previewConvergence(over: Partial<SessionConvergenceResult>): SessionConvergenceResult {
  return {
    departed: 13, alreadyRevoked: 12, revoked: 0, revokeFailed: 0, restored: 0, restoreFailed: 0,
    foreignBans: 0, deferred: 0, unlisted: 0, listingComplete: true, ...over,
  };
}

/** The one pair the real judge finds in these inputs; throws if it finds anything else. */
function previewCrossSystemPair(slate: SlateUpcomingBooking, cal: CalcomUpcomingBooking): CrossSystemPair {
  const pairs = findCrossSystemBookings([slate], [cal], PREVIEW_CROSS_SYSTEM_NOW);
  if (pairs.length !== 1) throw new Error(`cross system preview: the judge found ${pairs.length} pairs, not 1`);
  return pairs[0];
}
import {
  formatAwaitingActivationAlert,
  formatAwaitingActivationRecovery,
} from "@/lib/monitor/awaiting-activation";
import { formatStrandedHiresAlert, formatStrandedHiresRecovery } from "@/lib/monitor/stranded-hires";
import { formatLadderDroppedAlert, formatLadderDroppedRecovery } from "@/lib/monitor/ladder-dropped-advisors";
import {
  formatSessionConvergenceAlert,
  formatSessionConvergenceRecovery,
  type SessionConvergenceResult,
} from "@/lib/offboarding/session-convergence-alert";
import {
  judgeRegalCallers,
  formatRegalCallAlert,
  formatRegalCallEnding,
  type RegalCaller,
} from "@/lib/monitor/regal-calls";
import {
  formatRegalFeedQuietAlert,
  formatRegalFeedQuietRecovery,
  formatRegalFeedUnreadableAlert,
  formatRegalFeedUnreadableRecovery,
} from "@/lib/monitor/regal-call-feed";
import {
  formatRegalCallOutcomesAlert,
  formatRegalCallOutcomesRecovery,
} from "@/lib/monitor/regal-call-outcomes";
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
  formatRosterCoverageLiveAlert,
  formatRosterCoverageLiveRecovery,
  formatRosterCoverageUpcomingAlert,
  formatRosterCoverageUpcomingRecovery,
  type DatedCoverageGap,
} from "@/lib/monitor/roster-coverage";
import { formatThinTierNotice } from "@/lib/monitor/thin-tier";
import { formatPoolNearlyFullNotice } from "@/lib/monitor/bucket-fullness";
import { fillBand, formatRosterFillAlert, formatRosterFillRecovery, type RosterFillReading } from "@/lib/monitor/roster-fill";
import { formatBusyDriftAlert, formatBusyDriftRecovery } from "@/lib/monitor/busy-drift-sampler";
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
import { formatFollowUpDrainPage, formatFollowUpDrainAllClear } from "@/lib/monitor/follow-up-drain-rate";
import { formatOwnerNoticeWithheldReport } from "@/lib/monitor/owner-notice-withheld-report";
import { formatOwnerAlertSkipsPage, formatOwnerAlertSkipsAllClear } from "@/lib/monitor/owner-alert-skips";
import {
  formatDuplicateCancelRefusedAllClear,
  formatDuplicateCancelRefusedPage,
  formatDuplicateCancelUnavailableAllClear,
  formatDuplicateCancelUnavailablePage,
} from "@/lib/monitor/duplicate-cancel-rate";
import {
  formatFailureBurstEnded,
  formatFailureRateAlert,
  formatFailureRateAllClear,
  formatFailureVolumeAlert,
  formatFailureVolumeAllClear,
} from "@/lib/monitor/booking-failure-rate";

/**
 * #3275: instants for the booking failure copy, fixed so the render never reads the
 * clock. 2026-10-14 is EDT, four hours behind UTC, so these read as the times the
 * 6:00am page carried: failures recorded from 3:05am to 5:05am ET.
 */
const PREVIEW_BURST = { firstMs: Date.UTC(2026, 9, 14, 7, 5), newestMs: Date.UTC(2026, 9, 14, 9, 5) };
/** A wave still under way: failures from 4:10pm to 5:55pm ET. */
const PREVIEW_WAVE = { firstMs: Date.UTC(2026, 9, 14, 20, 10), newestMs: Date.UTC(2026, 9, 14, 21, 55) };
/** When a previewed condition was first posted, for the #3801 reminder states. */
const PREVIEW_REMINDER_OPENED_MS = Date.UTC(2026, 9, 15, 4, 15);
import {
  embedRefusalAllClear,
  embedRefusalCopy,
  refusalAllClear,
  refusalSignalCopy,
} from "@/lib/monitor/api-refusal-signals";
/** The same figures the lane passes (one shared module since #1726), read from the
 *  rules that actually refuse, so the preview shows the sentence that really ships
 *  rather than a lookalike. */
import {
  SHIPPED_CEILING_LIMITS as PREVIEW_CEILING_LIMITS,
  SHIPPED_EMBED_CAP_LIMITS as PREVIEW_EMBED_CAP_LIMITS,
} from "@/lib/monitor/refusal-limits";
import {
  formatVolumeCountUnreadableAlert,
  formatVolumeCountReadableNotice,
  formatLowVolumeAlert,
  formatLowVolumeRecoveryNotice,
  formatTierVolumeAlert,
  formatTierVolumeRecoveryNotice,
  formatTierVolumeCountUnreadableAlert,
  formatTierVolumeCountReadableNotice,
  formatTierVolumeCheckFailedAlert,
  formatTierVolumeCheckRanNotice,
  formatVolumeVerdictGapRecoveryNotice,
} from "@/lib/monitor/booking-volume";
import { tierLabel } from "@/lib/monitor/volume-tiers";
import { formatVolumeVerdictGapAlert } from "@/lib/monitor/volume-verdict-gap";
import { judgedFloors, type FloorsNow } from "@/lib/monitor/volume-floors";
import {
  LOW_PAGES_ON_SLATE,
  formatPageUnseenAlert,
  formatPageVolumeAlert,
  formatPageVolumeRecoveryNotice,
  formatPilotReadNotice,
  formatPilotUnreadableAlert,
} from "@/lib/monitor/page-volume";

/** A Tuesday 2pm tick, measured, and the same tick with the long floor overridden (#1956). */
const TUESDAY_2PM: FloorsNow = {
  floor30: 3,
  floor120: 12,
  measured30: 3,
  measured120: 12,
  weekday: 2,
  hour: 14,
  override30: null,
  override120: null,
};
const MEASURED_TUESDAY_2PM = judgedFloors(TUESDAY_2PM);
const STORED_TUESDAY_2PM = judgedFloors({ ...TUESDAY_2PM, override120: "stored" });
const ENV_TUESDAY_2PM = judgedFloors({ ...TUESDAY_2PM, override120: "env" });
import {
  formatAvailabilityDriftAlert,
  formatAvailabilityDriftAllClear,
  formatAvailabilityDriftAggregateAlert,
  formatAvailabilityDriftAggregateAllClear,
} from "@/lib/monitor/availability-truth";
import { tierFallbackAlert } from "@/lib/routing/tier-alert";
import {
  topTierCascadeNoticeText,
  topTierCascadeVerdict,
  TOP_TIER_CASCADE_WINDOW_HOURS,
  type TopTierCascadeWindow,
} from "@/lib/monitor/top-tier-cascade";
import {
  raceBoundHitPageText,
  raceContentionNoticeText,
  raceContentionVerdict,
  measuredRaceThreshold,
  type RaceContentionWindow,
  type RaceThreshold,
} from "@/lib/monitor/race-contention";
import { bookerUnstaffedAlert,
  bookingWindowExtendedAlert } from "@/lib/booking/alert-copy";
import {
  formatPublicBookingStoppedAlert,
  formatPublicBookingRunningRecovery,
  PAUSE_NOTICE_AFTER_MS,
} from "@/lib/monitor/booking-pause";
import {
  formatSharedLineLeftOffAlert,
  formatSharedLineBackOnRecovery,
  SHARED_LINE_OFF_NOTICE_AFTER_MS,
} from "@/lib/monitor/shared-line-left-off";
import {
  sharedLineSwitchUnreadableAlert,
  SWITCH_READ_PAGE_AFTER,
  SWITCH_READ_PAGE_WINDOW_MS,
} from "@/lib/booking/shared-line-switch-alert";
import {
  formatCiRefusedAlert,
  formatCiStartedRecovery,
  formatDeployLiveRecovery,
  formatDeployNotLiveAlert,
} from "@/lib/monitor/github-ci-health";
import {
  oooAgentCalendarAlert,
  oooAgentDmAlert,
  oooBusyBlockFallbackAlert,
  oooEventMismatchAlert,
  oooEventMismatchRecovery,
  oooNarrowCalendarAlert,
  oooNarrowHoldAlert,
  oooCalcomAlert,
  oooCalcomStaleUnrecordedAlert,
  oooCalendarCreateAlert,
  oooCalendarCreateBothFailedAlert,
  oooManagerCalendarAlert,
  oooUndoAgentAlert,
  oooCoverageStopAlert,
  oooUndoManagerAlert,
  oooUndoUnrecordedAlert,
  type OooEventMismatch,
} from "@/lib/ooo/alert-copy";
import {
  auditWriteFailedAlert,
  bookableBlockedAlert,
  bookableNotProvisionedAlert,
  bookableUnverifiedAlert,
  bookableUnhydratedAlert,
  bookableTimedOutAlert,
  bookableContendedAlert,
  bookableTraitUnrecordedAlert,
  googleAccountMismatchAlert,
  refusedAdvisorLeftPoolAlert,
  boundaryCatchAlert,
  embedOriginMismatchAlert,
  testBucketClientErrorInfo,
  internalErrorAlert,
  cspViolationAlert,
  unexpectedFaultAlert,
  misrouteAlert,
  oooApprovalsDigestAlert,
  retentionResumedText,
  retentionSkippedText,
  unknownReasonCodeNotice,
  unrecognisedPageReports,
  opaqueScriptErrorBurstAlert,
  watchLapseRecovery,
  googleBreakerClosedAlert,
  googleBreakerOpenAlert,
} from "@/lib/notify/misc-alert-copy";
import { OPAQUE_BURST_THRESHOLD } from "@/lib/api/boundary-count";
import {
  friendlyRateArea,
  limiterBlockedAlert,
  limiterFailOpenAlert,
  unidentifiedCallerAlert,
  BOOKING_LIMITER,
  CLIENT_ERROR_ADDRESS_POLICY,
  refundFailedAlert,
  LIMITER_FAIL_OPEN_PAGE_AFTER,
  LIMITER_FAIL_OPEN_WINDOW_MS,
} from "@/lib/rate-limit-core";
import { confirmLineUnreachableAlert, confirmLineAlertFor } from "@/lib/booking/confirm-line-alert";
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
  credentialSweepAlert,
  CREDENTIAL_SWEEP_RECOVERY,
} from "@/lib/snowflake/alert-copy";
import {
  agentSyncFailureAlert,
  twilioSyncFailureAlert,
  twilioSyncRecovery,
  twilioWriteFailureAlert,
  twilioWriteFailureRecovery,
  twilioOrphanedMarkAlert,
  twilioOrphanedMarkRecovery,
  demotionTriggerFailureAlert,
  demotionTriggerFailureRecovery,
  demotionRerouteOutcomeInfo,
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
  backupAlertText,
  backupRecoveryText,
  coreLaneAlertText,
  canaryAlertText,
  canaryRecoveryText,
  calcomLaneRetiredText,
  laneRecoveryText,
  logShippingAlertText,
  logShippingRecoveryText,
  poolGroupingAlertText,
  poolGroupingRecoveryText,
  mirrorAlertText,
  mirrorRecoveryText,
  retentionRecoveryText,
  timeOffLaneAlertText,
  timeOffRecoveryText,
  uptimeAlertText,
  uptimeRecoveryText,
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
  formatDemotedAgentBookingsAlert,
  formatDemotedAgentBookingsRecovery,
} from "@/lib/monitor/inactive-agent-bookings";
import {
  formatBufferBreachAlert,
  formatBufferBreachRecovery,
  judgeBufferBreaches,
  type BufferedBooking,
} from "@/lib/monitor/buffer-breach";
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
  formatDbSaturationAlert,
  formatDbSaturationRecovery,
  formatDbSaturationWarn,
  judgeDbSaturation,
} from "@/lib/monitor/db-saturation";
import {
  formatOooCoverageGapAlert,
  formatOooCoverageGapRecovery,
  formatOooCoverageGapWhisper,
} from "@/lib/monitor/ooo-coverage-gap";
import {
  formatUnprotectedAlert,
  formatOverrideRecovery,
  formatUnprotectedRecovery,
  formatCalcomRetiredSweepEnding,
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
  formatSweepFailureAlert,
  formatSweepFailureRecovery,
  COMPLETION_SWEEP_FAILING_KEY,
  WEBHOOK_RETRY_SWEEP_FAILING_KEY,
  DEMO_AUTO_CANCEL_FAILING_KEY,
  SWEEP_FAILURE_ALERT_AFTER_RUNS,
  OUTBOX_DRAIN_FAILING_KEY,
  RESERVATION_DRAIN_FAILING_KEY,
  RESCHEDULE_PIN_SWEEP_FAILING_KEY,
  REASSIGN_INTENT_SWEEP_FAILING_KEY,
  COVERAGE_RETRY_SWEEP_FAILING_KEY,
  sweepFailureAfterRuns,
} from "@/lib/monitor/sweep-failure";
import { formatLaneFailureAlert } from "@/lib/monitor/lane-failure";
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
  pendingDeletionRefusedAlert,
  refusedDeletionNotices,
  type CalendarOwnerForAlert,
  type RefusedDeletionForAlert,
  reassignIntentDroppedAlert,
  reconcileFreedAlert,
  reconcileRecreatedAlert,
  reschedulePinDroppedAlert,
  reservationCreatedOwedAlert,
  reservationCreatedOwedRecovery,
  reservationDrainRecovery,
  reservationDrainStuckAlert,
  unfairOrderingAlert,
  verifyOutageAlert,
  dependencyTimeoutAlert,
  rescheduleLockOutageAlert,
  reservationRollbackAlert,
  verifyReadFailedAlert,
  stalePhoneInviteAlert,
  phoneCorrectionUnsentAlert,
} from "@/lib/booking/alert-copy";
import { shortFailureReason } from "@/lib/notify/error-text";
import {
  formatUnsubscribedEventsAlert,
  formatUnsubscribedEventsRecovery,
} from "@/lib/monitor/webhook-subscriber-coverage";
import {
  formatEdgeLimiterUnusableAlert,
  formatEdgeLimiterRecovery,
} from "@/lib/monitor/edge-limiter-health";
import {
  formatDefinerGrantsExposedAlert,
  formatDefinerGrantsClearedAlert,
} from "@/lib/monitor/definer-grants";
import { formatAuditChainBrokenAlert, formatAuditChainRecovery } from "@/lib/monitor/audit-chain";
import { formatCronCpuAlert, formatCronCpuNotConfigured, formatCronCpuRecovery } from "@/lib/monitor/cron-budget";
import {
  formatAuthSignInOpenAlert,
  formatAuthSignInClearedAlert,
} from "@/lib/monitor/auth-sign-in-surface";
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
import { reminderFailedAlert, reminderFoldedAlert } from "@/lib/booking/reminder-send";
import {
  photosDeadlineAlert,
  photosHeldAlert,
  photosHeldRecovery,
  photosUnreadAlert,
  photosUnreadRecovery,
} from "@/lib/advisor-photos/copy";
import type { RefreshPlan } from "@/lib/advisor-photos/core";
import {
  loadBarOutgrownAlert,
  loadBarOutgrownRecovery,
  loadBarUnreadAlert,
  loadBarUnreadRecovery,
} from "@/lib/monitor/busy-minutes-copy";
import {
  busyWindow,
  judgeBusyMinutes,
  slateMinutesFrom,
  type BusyVerdict,
  type CalcomHalf,
  type UnmeasuredReason,
} from "@/lib/monitor/busy-minutes";
import { LOAD_RUN_BOOKINGS_PER_MINUTE } from "@/lib/load-bar";
import {
  formatReminderFailureRateAlert,
  formatReminderFailureRateAllClear,
} from "@/lib/booking/reminder-rate";
import type { HandoffKind } from "@/lib/handoffs/kinds";
import { formatReminder } from "@/lib/notify/repeat-policy";
import { marciaFailureAlert, marciaGatewayRefusedAlert, marciaTokenRefusedAlert } from "@/lib/mcp-booking/alert-copy";
import { formatSmokeCanaryRecovery } from "@/lib/monitor/smoke-canary-failure";
// The canary's failure message is built by its bare node alerter, which may import
// nothing outside scripts/ (#1598), so the preview reaches into scripts/ for it rather
// than holding a copy of the wording (L41).
import { buildSmokeFailureMessage } from "../../../scripts/lib/smoke-failure-message";
import {
  advisorLeftDm,
  advisorRevertedDm,
  inviteCheckFailedAlert,
  inviteLaunchSweepAlert,
  inviteMoveFoundOnFullReadAlert,
  inviteMoveLeftAlert,
  inviteResizedAlert,
  inviteRevertRefusedAlert,
  inviteRevertedAdvisorUntoldAlert,
  managerLeftDm,
  strandedInviteAlert,
  type InviteMoveFacts,
  type StrandedInviteFacts,
} from "@/lib/google/invite-move-copy";

/** #3919: the measured booking, 4:05 to 4:25 PM ET, moved five minutes earlier. */
const INVITE_MOVE_FACTS: InviteMoveFacts = {
  bookingId: "774521f6-0c1d-4b8e-9f3a-2d5e6a7b8c9d",
  advisorName: "Dana Whitfield",
  advisorEmail: "dana.whitfield@trypennie.com",
  bookedStartsAt: "2026-10-19T20:05:00.000Z",
  bookedEndsAt: "2026-10-19T20:25:00.000Z",
  eventStartsAt: "2026-10-19T20:00:00.000Z",
  eventEndsAt: "2026-10-19T20:20:00.000Z",
  bookingUrl: "https://slate.trypennie.app/admin/bookings/774521f6-0c1d-4b8e-9f3a-2d5e6a7b8c9d",
};
/** The same call moved to the next morning, so the moved time names its day. */
const INVITE_MOVE_FACTS_OTHER_DAY: InviteMoveFacts = {
  ...INVITE_MOVE_FACTS,
  bookingId: "1c9e5a3b-7d2f-4e18-a6b0-93f4c2d1e8a7",
  advisorName: "Marcus Bell",
  advisorEmail: "marcus.bell@trypennie.com",
  eventStartsAt: "2026-10-20T14:00:00.000Z",
  eventEndsAt: "2026-10-20T14:20:00.000Z",
  bookingUrl: "https://slate.trypennie.app/admin/bookings/1c9e5a3b-7d2f-4e18-a6b0-93f4c2d1e8a7",
};

/** #3924: the same call, whose crashed reschedule had moved its invite to the next morning. */
const STRANDED_INVITE: StrandedInviteFacts = {
  advisorEmail: INVITE_MOVE_FACTS.advisorEmail,
  bookedStartsAt: INVITE_MOVE_FACTS.bookedStartsAt,
  targetStartsAt: "2026-10-20T14:00:00.000Z",
  inviteStartsAt: "2026-10-20T14:00:00.000Z",
  reason: "refused",
  detail: "403 forbiddenForNonOrganizer",
  bookingUrl: INVITE_MOVE_FACTS.bookingUrl,
};

/**
 * The Slack DMs about a moved invite (#3919). Not alerts: each goes once to one
 * person. Here so the words an advisor and a manager read can be read before they
 * ship, from the same builders the handler sends with.
 */
export interface InviteMoveDmPreview {
  to: "advisor" | "manager";
  state: string;
  text: string;
}

export const INVITE_MOVE_DM_PREVIEWS: InviteMoveDmPreview[] = [
  { to: "advisor", state: "their move was put back", text: advisorRevertedDm(INVITE_MOVE_FACTS) },
  { to: "advisor", state: "their move was put back, to a time on another day", text: advisorRevertedDm(INVITE_MOVE_FACTS_OTHER_DAY) },
  { to: "advisor", state: "a second move, left, their manager told", text: advisorLeftDm(INVITE_MOVE_FACTS, "second-move", true) },
  { to: "advisor", state: "a move inside 30 minutes, left, their manager told", text: advisorLeftDm(INVITE_MOVE_FACTS, "near-start", true) },
  { to: "advisor", state: "a second move, left, no manager could be told", text: advisorLeftDm(INVITE_MOVE_FACTS, "second-move", false) },
  { to: "manager", state: "their advisor's second move", text: managerLeftDm(INVITE_MOVE_FACTS, "second-move") },
  { to: "manager", state: "their advisor's move inside 30 minutes", text: managerLeftDm(INVITE_MOVE_FACTS, "near-start") },
  { to: "manager", state: "an advisor Slate holds only an address for", text: managerLeftDm({ ...INVITE_MOVE_FACTS, advisorName: null }, "second-move") },
];

/** Slate's production address, for copy that links to a page. */
const PREVIEW_APP_URL = "https://slate.trypennie.app";

/** A roster 88% booked over two days, against the 85% line production holds (#2590). */
const PREVIEW_ROSTER_FILL: Extract<RosterFillReading, { status: "measured" }> = {
  status: "measured",
  days: ["2026-10-22", "2026-10-23"],
  linePct: 85,
  open: 39,
  capacity: 330,
  bookedPct: 88,
  notCounted: 0,
  tiers: [
    { tier: "1", label: "Low", open: 8, capacity: 120, bookedPct: 93 },
    { tier: "3", label: "High", open: 9, capacity: 80, bookedPct: 88 },
    { tier: "2", label: "Medium", open: 14, capacity: 90, bookedPct: 84 },
    { tier: "5", label: "Ultra High", open: 8, capacity: 40, bookedPct: 80 },
  ],
  over: true,
  band: fillBand(88, 85),
};

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

/** #3037: the Ultra High tier's first offered time as of 2026-10-02, past the Friday,
 *  Saturday and Monday the booker shows (#3559): Tuesday Oct 6 at 11:30am ET. */
const PREVIEW_TIER_FIRST_SLOT = Date.parse("2026-10-06T15:30:00.000Z"); // parse-ok: a literal
/** #3559: the days a tier page was judged over, the booker's strip on Friday 2026-10-02. */
const PREVIEW_TIER_DAYS = ["2026-10-02", "2026-10-03", "2026-10-05"];
/** The Very High tier page several previews share: 19 agents and no time in the window. */
const PREVIEW_VERY_HIGH_PAGE = { tier: "4", label: "Very High", agents: 19, firstSlotMs: PREVIEW_TIER_FIRST_SLOT, days: PREVIEW_TIER_DAYS };

/**
 * #1630: who the refused calendars in the previews below belong to. Two people who
 * have left (the first at the 2026-10-05 incident's moment) and one active new hire,
 * keyed the way the drain keys them, by normalised address.
 */
const PREVIEW_REFUSED_OWNERS = new Map<string, CalendarOwnerForAlert>([
  ["left.agent@trypennie.com", { name: "Jordan Avery", deactivatedAt: "2026-10-05T14:43:27.000Z" }],
  ["moved.on@trypennie.com", { name: "Sam Okafor", deactivatedAt: "2026-10-02T19:10:00.000Z" }],
  ["new.hire@trypennie.com", { name: "Casey Lin", deactivatedAt: null }],
]);

/** `n` refused rows on one calendar, each call moved (true), kept (false) or unread (null). */
function previewRefusedRows(
  email: string,
  prefix: string,
  moved: (boolean | null)[],
  kind: RefusedDeletionForAlert["kind"] = "not-provisioned",
): RefusedDeletionForAlert[] {
  return moved.map((m, i) => ({ calendarEmail: email, eventId: `evt_${prefix}${i + 1}`, kind, movedToAnotherAdvisor: m }));
}

/** The 2026-10-05 shape: one advisor left, four calls moved, plus an active new hire refused in the same pass. */
const PREVIEW_REFUSED_MIX = refusedDeletionNotices(
  [
    ...previewRefusedRows("left.agent@trypennie.com", "7a", [true, true, true, true]),
    ...previewRefusedRows("new.hire@trypennie.com", "4c", [null]),
  ],
  PREVIEW_REFUSED_OWNERS,
);

/** A measured tier cause for the preview, from its day tallies. */
function previewTierCause(
  syncStopped: number,
  days: Omit<DayTally, "isoDate">[],
): TierCauseReading {
  const total = syncStopped + (days[0] ? days[0].off + days[0].slate + days[0].outside + days[0].open : 0);
  return {
    measured: true,
    cause: { total, syncStopped, days: days.map((d, i) => ({ ...d, isoDate: PREVIEW_TIER_DAYS[i] ?? "2026-10-05" })) },
  };
}

/** #2593: one booking below its lead's tier, the 2026-09-21 incident's shape. */
const PREVIEW_BELOW_TIER: BelowFinding = {
  kind: "below",
  booking: {
    id: "5b0c7a8e-2f41-4d7e-9a61-0c3f1e2d4b5a",
    bucket_id: "b-100",
    starts_at: "2026-07-30T18:30:00.000Z",
    salesforce_id: "00QUi00000zhEUPMA2",
    external_id: null,
    agent_name: "Dana Whitfield",
    agent_email: "dana.whitfield@trypennie.com",
    prefill: { parentOrigin: "https://www.trypennie.com" },
    referrer_origin: "https://www.trypennie.com",
  },
  bucket: { id: "b-100", code: "100", name: "Low | None | No Legal Param", criteria: { debt_team: "low" } },
  pool: { rank: 1, label: "Low" },
  lead: { kind: "tier", rank: 5, key: "ultra_high", label: "Ultra High", code: "512" },
};
const PREVIEW_BELOW_TIER_URL = "https://slate.trypennie.app/admin/bookings/5b0c7a8e-2f41-4d7e-9a61-0c3f1e2d4b5a";

/** #3665: the states above hold the lead's team as free and their history steady,
 *  so each reads as the routing sentence it is about. */
const PREVIEW_TEAM_FREE: PageFacts = { team: { kind: "free" }, history: { kind: "steady" } };

/** #3665: the 2026-10-13 shape, booking 899afc25: a High lead (XBC 312) booked with
 *  the Medium team at 3:00pm ET from a 212 submission, ten submissions alternating
 *  212 and 312, and the 312 pool offering no 3:00pm. */
const PREVIEW_FLIPPING: BelowFinding = {
  kind: "below",
  booking: {
    ...PREVIEW_BELOW_TIER.booking,
    id: "899afc25-6d1e-4b8a-9f0c-2e7a5b3c1d40",
    bucket_id: "b-212",
    starts_at: "2026-10-13T19:00:00.000Z",
  },
  bucket: { id: "b-212", code: "212", name: "Medium | Both | Non-Legal", criteria: { debt_team: "medium" } },
  pool: { rank: 2, label: "Medium" },
  lead: { kind: "tier", rank: 3, key: "high", label: "High", code: "312" },
};
const PREVIEW_FLIPPING_URL = "https://slate.trypennie.app/admin/bookings/899afc25-6d1e-4b8a-9f0c-2e7a5b3c1d40";
const PREVIEW_FLIPPING_ROUTING = { catchall: false, requestedCode: "212", tierFallback: false, rungsDropped: 0 };
const PREVIEW_FLIPPING_HISTORY = submissionAgreement(["312", "212", "312", "212", "312", "212", "312", "212", "312", "312"]);
/** The 312 pool's offer as the lane's shared slot rows give it: 1:00pm and 4:30pm
 *  that day, and the next morning, computed at 8:10am ET. */
const PREVIEW_FLIPPING_OFFER: LeadTierOffer = {
  offeredMs: [Date.UTC(2026, 9, 13, 17, 0), Date.UTC(2026, 9, 13, 20, 30), Date.UTC(2026, 9, 14, 15, 0)],
  computedAtMs: Date.UTC(2026, 9, 13, 12, 10),
  minNoticeMin: 120,
};
const PREVIEW_FLIPPING_NOW = Date.UTC(2026, 9, 13, 12, 20);
/** The 899afc25 page for one offer and one history, through the real judge and copy. */
function previewFlipping(offer: LeadTierOffer | "unreadable", history: SubmissionHistory): string {
  return formatBelowLeadTierAlert(PREVIEW_FLIPPING, PREVIEW_FLIPPING_ROUTING, PREVIEW_FLIPPING_URL, {
    team: teamAtTime(offer, PREVIEW_FLIPPING.booking.starts_at, PREVIEW_FLIPPING_NOW),
    history,
  });
}

/** #2594: the same lead booked correctly on XBC 422 into the Very High pool, then
 *  re-scored to 512 four minutes later. #3501: the score came from the submission
 *  the booking was made under, which is what lets the page call it a re-score. */
const PREVIEW_RESCORED_SUBMISSION = "a04Ui00000NLKZZIA5";
const PREVIEW_RESCORED: BelowFinding = {
  ...PREVIEW_BELOW_TIER,
  booking: {
    ...PREVIEW_BELOW_TIER.booking,
    bucket_id: "b-422",
    prefill: { ...PREVIEW_BELOW_TIER.booking.prefill, [PARTNER_KEYS.submissionId]: PREVIEW_RESCORED_SUBMISSION },
  },
  bucket: { id: "b-422", code: "422", name: "Very High | Both | Non-Legal", criteria: { debt_team: "very_high" } },
  pool: { rank: 4, label: "Very High" },
  score: { code: "512", source: "submission", submissionId: PREVIEW_RESCORED_SUBMISSION },
};

/** #3501: the lead came back and submitted again after booking, scoring higher. */
const PREVIEW_RESUBMITTED: BelowFinding = {
  ...PREVIEW_RESCORED,
  score: { code: "512", source: "submission", submissionId: "a04Ui00000NXcm1IAD" },
};

/** #3501: the Lead score was edited after the submission, so the edit wins. */
const PREVIEW_LEAD_EDIT: BelowFinding = {
  ...PREVIEW_RESCORED,
  score: { code: "512", source: "lead-edit", submissionId: PREVIEW_RESCORED_SUBMISSION },
};

/** #3501: a booking that recorded no submission, so a re-score and a newer
 *  submission cannot be told apart. */
const PREVIEW_RISE_UNATTRIBUTED: BelowFinding = {
  ...PREVIEW_RESCORED,
  booking: { ...PREVIEW_RESCORED.booking, prefill: PREVIEW_BELOW_TIER.booking.prefill },
};

// #2715. The 2026-09-25 shape: a partner testing from localhost onto a real Low
// advisor at 13:00 UTC.
const PREVIEW_OFFSITE: OffsiteFinding = {
  booking: {
    id: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
    bucket_id: "b-100",
    starts_at: "2026-09-25T13:00:00.000Z",
    agent_name: "Dana Whitfield",
    agent_email: "dana.whitfield@trypennie.com",
    prefill: { parentOrigin: "http://localhost:3000" },
    referrer_origin: "http://localhost:3000",
  },
  bucket: { id: "b-100", code: "100", name: "Low | None | No Legal Param", is_test: false },
  verdict: {
    kind: "offsite",
    declared: { kind: "offsite", origin: "http://localhost:3000" },
    framedBy: { kind: "offsite", origin: "http://localhost:3000" },
  },
};
const PREVIEW_OFFSITE_URL = "https://slate.trypennie.app/admin/bookings/7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
/** #2090: an invented agent for the Regal call previews (L155). */
const REGAL_PREVIEW_CALLER: RegalCaller = {
  id: "u-ada",
  name: "Ada Example",
  email: "ada.example@trypennie.com",
  role: "agent",
  bookable: false,
  deactivated_at: null,
  is_test: false,
  attributes: null,
};

/** #2090: one call from the preview agent, four minutes ago. */
const REGAL_PREVIEW_ONE_CALL = [
  { agent_email: REGAL_PREVIEW_CALLER.email, occurred_at: new Date(NOW_MS - 4 * 60_000).toISOString() },
];

/** #2090: the last whole business day, the seeded 8am to 8pm ET. */
const REGAL_PREVIEW_DAY = {
  isoDate: "2026-07-28",
  openMs: Date.UTC(2026, 6, 28, 12, 0, 0),
  closeMs: Date.UTC(2026, 6, 29, 0, 0, 0),
};

/**
 * One rendered top tier cascade report (#2843). It goes through the real verdict
 * rather than calling the copy builder straight, so a preview can only ever show a
 * message the lane could really send: a window the lane would refuse to report on
 * throws here rather than rendering a sentence nobody will see.
 */
function topTierCascadeReportPreview(w: Omit<TopTierCascadeWindow, "windowHours">): string {
  const verdict = topTierCascadeVerdict({ ...w, windowHours: TOP_TIER_CASCADE_WINDOW_HOURS });
  if (verdict.kind !== "report") {
    throw new Error(`top tier cascade preview fixture is not a reportable window (${verdict.kind})`);
  }
  return topTierCascadeNoticeText(verdict, TOP_TIER_CASCADE_WINDOW_HOURS);
}

/**
 * A race threshold (#2877) through the real measurement: `perHour` bookings in
 * each of `hours` whole hours of one bucket code before `NOW_MS`. Too few hours
 * gives the fallback, worded by the measurement itself rather than here.
 */
function raceThresholdPreview(code: string, perHour: number, hours: number): RaceThreshold {
  const hourMs = 3_600_000;
  const current = Math.floor(NOW_MS / hourMs) * hourMs;
  const rows = Array.from({ length: hours * perHour }, (_, i) => ({
    createdMs: current - (Math.floor(i / perHour) + 1) * hourMs,
    bucketCode: code,
  }));
  return measuredRaceThreshold(rows, NOW_MS);
}

/**
 * One rendered race contention whisper (#2838), through the real verdict for the
 * same reason as the two above: a window the lane would not report on throws here
 * rather than rendering a sentence nobody will see.
 */
function raceContentionReportPreview(
  w: Omit<RaceContentionWindow, "day" | "reassignedMoves" | "retriedForBudget"> & { reassignedMoves?: number; retriedForBudget?: number },
  threshold: RaceThreshold = raceThresholdPreview("111", 9, 9),
): string {
  const verdict = raceContentionVerdict({ reassignedMoves: 0, retriedForBudget: 0, ...w, day: "2026-07-28" }, threshold);
  if (verdict.kind !== "report") {
    throw new Error(`race contention preview fixture is not a reportable window (${verdict.kind})`);
  }
  return raceContentionNoticeText(verdict);
}

/** A roster coverage gap fixture (#1936). Data only: the words come from the
 *  builders the previews call. Partial and mid day unless the fixture says not. */
function coverageGap(
  g: Pick<DatedCoverageGap, "dateIso" | "weekday" | "startMinute" | "endMinute" | "range"> &
    Partial<Pick<DatedCoverageGap, "wholeDay" | "opensUncovered">>,
): DatedCoverageGap {
  return { wholeDay: false, opensUncovered: false, ...g };
}

/** The dates the roster coverage check judges between two dates inclusive (#2810),
 *  for production's week: open Monday to Saturday, Sunday shut, and Saturday never
 *  judged, so Monday to Friday. Data only, like `coverageGap`. */
function rosterCheckedDates(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const last = DateTime.fromISO(toIso, { zone: "UTC" });
  for (let d = DateTime.fromISO(fromIso, { zone: "UTC" }); d <= last; d = d.plus({ days: 1 })) {
    if (d.weekday <= 5) out.push(d.toISODate() ?? "");
  }
  return out;
}

/** Production's evening tail: the org advertises until 20:00, the roster ends at 17:00. */
const EVENING_TAIL = { startMinute: 1020, endMinute: 1200 };

/** The same uncovered stretch on each of the given dates (#2810), one gap per date
 *  with its weekday read off the date. Data only, like `coverageGap`. */
function recurringCoverageGaps(
  dates: string[],
  shape: { startMinute: number; endMinute: number; opensUncovered?: boolean },
  range: DatedCoverageGap["range"],
): DatedCoverageGap[] {
  return dates.map((dateIso) =>
    coverageGap({ dateIso, weekday: DateTime.fromISO(dateIso, { zone: "UTC" }).weekday, range, ...shape }),
  );
}

/** A fixed send time for the roster coverage page, in the org's zone, so the
 *  preview never reads the clock and renders the same text on every run. */
function rosterSentAt(localIso: string): { nowMs: number; zone: string } {
  const zone = "America/New_York";
  return { nowMs: DateTime.fromISO(localIso, { zone }).toMillis(), zone };
}

/** A measured photo refresh for the preview, nothing held unless an override says so (#3027). */
function previewPhotoPlan(over: Partial<RefreshPlan>): RefreshPlan {
  return {
    full: [],
    touch: [],
    failed: [],
    failedNeverRead: [],
    deleteIds: [],
    flipGuardTripped: false,
    heldNone: [],
    repeated: [],
    notInDirectory: [],
    streaks: [],
    counts: {
      attempted: 129, photo: 124, none: 5, placeholder: 0, notInDirectory: 0, failed: 0,
      gained: 0, lost: 0, changed: 0, unchanged: 129, deleted: 0,
    },
    ...over,
  };
}

/**
 * A busy minute verdict from the real judge (#3124), over a fixed week, so the preview
 * shows only what the check would send. `slate` is [ISO minute, bookings]; `calcom` is
 * [ISO stamp, routed responses at it]. Throws when the fixture does not land where the
 * caller says, so a preview can never show a message the check would not send.
 */
function previewBusyVerdict(
  slate: [string, number][],
  calcom: [string, number][] | CalcomHalf,
  want: "measured",
): Extract<BusyVerdict, { kind: "measured" }>;
function previewBusyVerdict(slate: [string, number][] | null, calcom: [string, number][] | CalcomHalf, want: "unmeasured"): UnmeasuredReason[];
function previewBusyVerdict(
  slate: [string, number][] | null,
  calcom: [string, number][] | CalcomHalf,
  want: "measured" | "unmeasured",
): Extract<BusyVerdict, { kind: "measured" }> | UnmeasuredReason[] {
  const ms = (iso: string): number => Date.parse(iso); // parse-ok: fixed ISO literals in this file, and the judge refuses anything outside its window
  const window = busyWindow(ms("2026-10-20T05:41:00Z"));
  const slateHalf = slate === null
    ? ({ ok: false } as const)
    : slateMinutesFrom(slate.map(([iso, n]) => [Math.floor(ms(iso) / 60_000), n]), window);
  let id = 0;
  const calHalf: CalcomHalf = Array.isArray(calcom)
    ? { kind: "read", routed: calcom.flatMap(([iso, n]) => Array.from({ length: n }, () => ({ id: String(id++), createdAt: iso }))) }
    : calcom;
  const v = judgeBusyMinutes({ barPerMinute: LOAD_RUN_BOOKINGS_PER_MINUTE, window, slate: slateHalf, calcom: calHalf });
  if (v.kind !== want) throw new Error(`busy minute preview fixture judged ${v.kind}, not ${want}`);
  return v.kind === "measured" ? v : v.reasons;
}

/** A budget spend from the real judge, for the #3179 previews. Throws if the fixture
 *  is not actually half spent, so a preview can never show a page the check would not send. */
function previewBudgetSpend(
  name: "success" | "availability",
  counts: { requests: number; errors: number; serverFaults: number; errorCodes: { code: string; count: number }[] },
) {
  const v = judgeBudgets({ month: "2026-10", ...counts })[name];
  if (v.kind !== "half-spent" || v.spend.share < BUDGET_WARN_SHARE) {
    throw new Error(`preview fixture for booking_budget:${name} is not half spent`);
  }
  return v.spend;
}

// #3360: the 2026-10-06 shape, an all day request whose event was edited to begin at
// 11:30 AM MT, and a second request whose event is gone. The edit was the true one that
// day, so every page built from these asks for the two to agree rather than for the
// event to be put back.
const MISMATCH_SHORTENED: OooEventMismatch = {
  requestId: "req_9f2", startsAt: "2026-10-07T06:00:00.000Z", endsAt: "2026-10-08T05:59:00.000Z",
  displayTzId: "America/Denver", displayTzLabel: "MT",
  coverage: { kind: "uncovered", spans: [{ startMs: 1791352800000, endMs: 1791394200000 }] },
};
const MISMATCH_GONE: OooEventMismatch = {
  requestId: "req_a41", startsAt: "2026-10-09T06:00:00.000Z", endsAt: "2026-10-10T05:59:00.000Z",
  displayTzId: "America/Denver", displayTzLabel: "MT", coverage: { kind: "not-blocking", unmeasured: null },
};

/** The served versus confirm check's fixture (#3381): 4:30 PM ET in bucket 112, first
 *  seen five minutes before the page, on a row the recompute lane wrote two minutes
 *  before that. Fixed instants, so the render never reads the clock. */
const OFFERED_NOW_MS = Date.UTC(2026, 9, 14, 8, 51);
const OFFERED_112: OfferedFinding = {
  code: "112",
  startMs: Date.UTC(2026, 9, 14, 20, 30),
  firstSeenMs: Date.UTC(2026, 9, 14, 8, 46),
  members: 74,
  rowComputedAt: "2026-10-14T08:44:39.000Z",
  writtenBy: "lane",
};

/** One agent's alerts channel page, as the preview renders every one of them. */
const mismatchPage = (
  found: OooEventMismatch[],
  escalation: Parameters<typeof oooEventMismatchAlert>[3],
): string => oooEventMismatchAlert("Heather McLellen", found, "https://slate.trypennie.app", escalation);

/** A 10 and 10 buffered call for the buffer breach previews (#3040). */
function previewCall(id: string, advisorId: string, advisorName: string, startsAt: string, durationMin: number): BufferedBooking {
  // parse-ok: a literal timestamp written in this file, never stored data.
  const startsMs = Date.parse(startsAt);
  return {
    id,
    advisorId,
    advisorName,
    startsMs,
    endsMs: startsMs + durationMin * 60_000,
    bufferBeforeMin: 10,
    bufferAfterMin: 10,
    inTestBucket: false,
    allowDoubleBook: false,
  };
}

const previewBookingUrl = (id: string) => `https://slate.trypennie.app/admin/bookings/${id}`;

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
    // #3381. The 2026-10-14 shape: one time in bucket 112, a stored row two minutes old,
    // none of the pool's 74 advisors free, and the row's writer named.
    key: "offered_nobody_free",
    state: "one served time nobody in its pool is free for, past the freshness window",
    channel: "alert",
    text: formatOfferedNobodyFreeAlert([OFFERED_112], OFFERED_NOW_MS),
  },
  {
    // A pool with nobody in it, a row from before writers were recorded, and more
    // findings than the page lists, so the truncation has to say so.
    key: "offered_nobody_free",
    state: "several served times nobody is free for, one in an empty pool, more than the page lists",
    channel: "alert",
    text: formatOfferedNobodyFreeAlert(
      [
        OFFERED_112,
        { ...OFFERED_112, code: "211", members: 0, writtenBy: null },
        ...["311", "312", "411", "412"].map((code) => ({ ...OFFERED_112, code, members: 9, writtenBy: "booking+push+refusal" })),
      ],
      OFFERED_NOW_MS,
    ),
  },
  {
    key: "offered_nobody_free",
    state: "every remembered time taken off or found free",
    channel: "recovery",
    text: formatOfferedNobodyFreeAllClear(6),
  },
  {
    // #370, previewable and classified since #1390. The fixture is a real drought
    // shape: the 30 minute window empty while the 2 hour window is merely thin, so
    // the message has to carry both numbers rather than one headline.
    key: "low_booking_volume",
    state: "bookings have dried up",
    channel: "alert",
    text: formatLowVolumeAlert([
      { label: "30 min", count: 0, floor: 3, basis: MEASURED_TUESDAY_2PM.basis30 },
      { label: "120 min", count: 4, floor: 12, basis: MEASURED_TUESDAY_2PM.basis120 },
    ]),
  },
  {
    // #1956: the floor a page quotes is either the measured one for that hour or a
    // number somebody set, and the page says which, because the two send the
    // reader to different places.
    key: "low_booking_volume",
    state: "below a floor set on the settings page in place of the measurement",
    channel: "alert",
    text: formatLowVolumeAlert([
      { label: "120 min", count: 4, floor: 12, basis: STORED_TUESDAY_2PM.basis120 },
    ]),
  },
  {
    key: "low_booking_volume",
    state: "below a floor set in the deployment in place of the measurement",
    channel: "alert",
    text: formatLowVolumeAlert([{ label: "120 min", count: 4, floor: 12, basis: ENV_TUESDAY_2PM.basis120 }]),
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
    // #2874. A tier judged beside Low, against floors learned from its own bookings.
    // It names the tier, because one tier going quiet while the others book points
    // at that tier's pages or pool rather than at the booker every tier shares.
    key: "low_tier_volume:*",
    state: "a tier beside Low has gone quiet",
    channel: "alert",
    text: formatTierVolumeAlert(tierLabel("2"), [
      { label: "30 min", count: 0, floor: 2, basis: MEASURED_TUESDAY_2PM.basis30 },
      { label: "120 min", count: 3, floor: 9, basis: MEASURED_TUESDAY_2PM.basis120 },
    ]),
  },
  {
    // One tier's count failing is that tier's own page, never Low's (#2874).
    key: "volume_count_unreadable:*",
    state: "one tier's count cannot be read",
    channel: "alert",
    text: formatTierVolumeCountUnreadableAlert(tierLabel("2")),
  },
  {
    key: "volume_count_unreadable:*",
    state: "the tier's count reads again",
    channel: "recovery",
    text: formatTierVolumeCountReadableNotice(tierLabel("2")),
  },
  {
    // One tier's check could not run; the others were still judged (#2874).
    key: "tier_volume_check_failed:*",
    state: "one tier's check could not run",
    channel: "alert",
    text: formatTierVolumeCheckFailedAlert(tierLabel("3")),
  },
  {
    key: "tier_volume_check_failed:*",
    state: "the tier is judged again",
    channel: "recovery",
    text: formatTierVolumeCheckRanNotice(tierLabel("3")),
  },
  {
    key: "low_tier_volume:*",
    state: "the tier is booking again",
    channel: "recovery",
    text: formatTierVolumeRecoveryNotice(tierLabel("2"), [
      { label: "30 min", count: 3, floor: 2 },
      { label: "120 min", count: 11, floor: 9 },
    ]),
  },
  {
    // #2738. One page gone quiet while the tier is above its floor: the page names
    // the page and its URLs, because the repair is on that page, not the booker.
    key: "low_page_volume:*",
    state: "one page has stopped booking and the tier is fine",
    channel: "alert",
    text: formatPageVolumeAlert(
      LOW_PAGES_ON_SLATE[0]!,
      [{ label: "120 min", count: 0, floor: 2, basis: MEASURED_TUESDAY_2PM.basis120 }],
      true,
    ),
  },
  {
    // The tier alarm could not judge this tick, so the page claims nothing about it.
    key: "low_page_volume:*",
    state: "one page has stopped booking and the tier was not judged",
    channel: "alert",
    text: formatPageVolumeAlert(
      LOW_PAGES_ON_SLATE[1]!,
      [
        { label: "30 min", count: 0, floor: 1, basis: MEASURED_TUESDAY_2PM.basis30 },
        { label: "120 min", count: 1, floor: 5, basis: MEASURED_TUESDAY_2PM.basis120 },
      ],
      false,
    ),
  },
  {
    // Nothing recorded from the page all week: either it is not sending leads to
    // Slate or its link carries no source, and the page cannot tell which.
    key: "low_page_volume:*",
    state: "the page has recorded no booking in the lookback",
    channel: "alert",
    text: formatPageUnseenAlert(LOW_PAGES_ON_SLATE[1]!, [
      { label: "120 min", count: 0, floor: 1, basis: MEASURED_TUESDAY_2PM.basis120 },
    ]),
  },
  {
    key: "low_page_volume:*",
    state: "the page is booking again",
    channel: "recovery",
    text: formatPageVolumeRecoveryNotice(LOW_PAGES_ON_SLATE[0]!, [
      { label: "30 min", count: 1, floor: 0 },
      { label: "120 min", count: 6, floor: 2 },
    ]),
  },
  {
    // The per page alarm stands down silently during a split; the one stand down that
    // speaks is a pilot switch it cannot read, because somebody has to look at it.
    key: "page_volume_share_unknown",
    state: "the pilot settings in Salesforce cannot be read",
    channel: "alert",
    text: formatPilotUnreadableAlert(),
  },
  {
    // The all-clear says what the switch reads now, so each state it can find is shown.
    key: "page_volume_share_unknown",
    state: "the settings are read again, and the pilot splits Low",
    channel: "recovery",
    text: formatPilotReadNotice({ state: "split", percent: 50 }),
  },
  {
    key: "page_volume_share_unknown",
    state: "the settings are read again, and every Low lead goes to Slate",
    channel: "recovery",
    text: formatPilotReadNotice({ state: "whole" }),
  },
  {
    key: "page_volume_share_unknown",
    state: "the settings are read again, and no Low lead goes to Slate",
    channel: "recovery",
    text: formatPilotReadNotice({ state: "off" }),
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
  {
    // #2049. Said in OPEN minutes, and the last verdict named with its weekday in
    // the org's zone, because a wall clock age across a closed Sunday is what misled.
    key: "low_volume_verdict_gap",
    state: "an hour of open time with no verdict",
    channel: "alert",
    text: formatVolumeVerdictGapAlert(69, 1789775760000 /* 2026-09-18T23:56:00Z */, "America/New_York"),
  },
  {
    key: "low_volume_verdict_gap",
    state: "a whole open day with no verdict",
    channel: "alert",
    text: formatVolumeVerdictGapAlert(725, 1788652570000 /* 2026-09-05T23:56:10Z */, "America/New_York"),
  },
  {
    key: "low_volume_verdict_gap",
    state: "the last verdict cannot be read",
    channel: "alert",
    text: formatVolumeVerdictGapAlert(10080, 0, "America/New_York"),
  },
  {
    key: "low_volume_verdict_gap",
    state: "the alarm concludes again",
    channel: "recovery",
    text: formatVolumeVerdictGapRecoveryNotice(),
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
  // #3718: one state per step a press can fail at, plus the failed check that hides the
  // button, which reads differently because nobody pressed anything.
  {
    key: "call_me_now_failed",
    state: "Salesforce failed while marking the lead for a call",
    channel: "alert",
    text: formatCallMeNowFailedAlert({ stage: "write", leadId: "00QUi000010889ZMAQ", error: new Error("SF update failed: 503 Service Unavailable") }),
  },
  {
    key: "call_me_now_failed",
    state: "Salesforce failed while reading the lead",
    channel: "alert",
    text: formatCallMeNowFailedAlert({ stage: "lead-read", leadId: "00QUi000010889ZMAQ", error: new Error("SF query failed: 500 Internal Server Error") }),
  },
  {
    key: "call_me_now_hidden",
    state: "Salesforce failed while reading the switch, so the button was hidden",
    channel: "alert",
    text: formatCallMeNowFailedAlert({ stage: "switch-read", leadId: "00QUi000010889ZMAQ", error: new Error("SF query failed: 503 Service Unavailable"), when: "check" }),
  },
  // #2879: one state per kind of host, since each names the caller differently, plus a
  // second retired key from the same host kind, which pages on its own key.
  {
    key: "retired_booking_key:*",
    state: "the retired shared key, from the production site",
    channel: "alert",
    text: formatRetiredKeyAlert({ label: "shared", host: { kind: "production", origin: "https://www.trypennie.com" }, route: "GET /api/bookings" }),
  },
  {
    key: "retired_booking_key:*",
    state: "the retired shared key, from a call that named no host",
    channel: "alert",
    text: formatRetiredKeyAlert({ label: "shared", host: { kind: "unstated", origin: null }, route: "POST /api/bookings" }),
  },
  {
    key: "retired_booking_key:*",
    state: "a retired key from a preview host",
    channel: "alert",
    text: formatRetiredKeyAlert({ label: "regal-2026-09", host: { kind: "other-host", origin: "https://tp-git-x.vercel.app" }, route: "POST /api/bookings/cancel" }),
  },
  {
    key: "retired_booking_key:*",
    state: "a second retired key from the production site, paging on its own key",
    channel: "alert",
    text: formatRetiredKeyAlert({ label: "regal-2026-09", host: { kind: "production", origin: "https://www.trypennie.com" }, route: "POST /api/bookings" }),
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
  // #1727. The embed booker's own refusals. The limits are read off the real rules,
  // exactly as the monitor lane passes them, so the preview names the shipped figures.
  {
    key: "booking_embed_ip_cap",
    state: "the hourly address limit is refusing several addresses at once",
    channel: "alert",
    text: embedRefusalCopy.ipCap({ status: "paging", trips: 17, lockedOut: 4, floor: 3 }, 60 * 60_000, PREVIEW_EMBED_CAP_LIMITS)!,
  },
  {
    key: "booking_embed_ip_cap",
    state: "fewer addresses than the floor are locked out",
    channel: "recovery",
    text: embedRefusalAllClear.ipCap,
  },
  {
    key: "booking_embed_contact_cap",
    state: "the per contact limit is locking out several people at once",
    channel: "alert",
    text: embedRefusalCopy.contactCap({ status: "paging", trips: 9, lockedOut: 3, floor: 3 }, 60 * 60_000, PREVIEW_EMBED_CAP_LIMITS)!,
  },
  {
    key: "booking_embed_contact_cap",
    state: "only one email or phone is locked out",
    channel: "recovery",
    text: embedRefusalAllClear.contactCap,
  },
  {
    key: "booking_embed_honeypot",
    state: "the hidden bot trap is filled across many intervals",
    channel: "alert",
    text: embedRefusalCopy.honeypot({ status: "paging", trips: 14, intervals: 6, attempts: 38 }, 60 * 60_000)!,
  },
  {
    key: "booking_embed_honeypot",
    state: "the trap is quiet again",
    channel: "recovery",
    text: embedRefusalAllClear.honeypot,
  },
  {
    // #3267. A slow save cutting several confirms off in one hour: measured healthy
    // is zero of the 2,933 bookings in the week before this shipped.
    key: "booking_follow_up_left_to_drain",
    state: "a cluster of confirms left their work to the drain, over the share",
    channel: "alert",
    text: formatFollowUpDrainPage({ confirms: 22, left: 5, pct: 23 }, 60),
  },
  {
    // The saturation trigger: under the confirm floor, most of a quiet hour's
    // confirms leaving their work behind still reaches somebody (L139).
    key: "booking_follow_up_left_to_drain",
    state: "most of a quiet hour's confirms left their work to the drain",
    channel: "alert",
    text: formatFollowUpDrainPage({ confirms: 4, left: 3, pct: 75 }, 60),
  },
  {
    key: "booking_follow_up_left_to_drain",
    state: "a measured clean half hour, none left behind",
    channel: "recovery",
    text: formatFollowUpDrainAllClear({ attempts: 9, failures: 0 }, 30),
  },
  {
    key: "booking_follow_up_left_to_drain",
    state: "a measured clean half hour with one straggler",
    channel: "recovery",
    text: formatFollowUpDrainAllClear({ attempts: 24, failures: 1 }, 30),
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
    // #1313. The fixture is the 2026-08-06 cal.com shape: a wave of attempts
    // refused on times that were offered to them.
    key: "booking_failure_rate",
    state: "a wave of attempts refused, still failing",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 82,
      failures: 38,
      pct: 46,
      windowMinutes: 180,
      topCodes: [
        { code: "slot_unavailable", count: 35 },
        { code: "internal", count: 3 },
      ],
      recentMinutes: 30,
      recent: { attempts: 14, failures: 9 },
      span: PREVIEW_WAVE,
    }),
  },
  {
    // #3633, the 2026-10-12 shape: two leads retrying two dead times, ten refusals.
    // With the refused people counted, the page leads with people.
    key: "booking_failure_rate",
    state: "refusals traced to the people behind them",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 49,
      failures: 10,
      pct: 20,
      windowMinutes: 180,
      topCodes: [{ code: "slot_unavailable", count: 10 }],
      refused: { people: 2, refusals: 10, withoutLead: 0 },
      recentMinutes: 30,
      recent: { attempts: 7, failures: 4 },
      span: PREVIEW_WAVE,
    }),
  },
  {
    // #3797: stale offers paging, with the proven lost races of the same window counted
    // apart beside the count. A window of races alone never pages, so it has no state
    // here; scripts/test-monitor-booking-failure-rate.ts pins that it sends nothing.
    key: "booking_failure_rate",
    state: "stale offers paging, lost races counted apart beside them",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 49,
      failures: 11,
      pct: 22,
      windowMinutes: 180,
      topCodes: [{ code: "slot_unavailable", count: 11 }],
      refused: { people: 4, refusals: 11, withoutLead: 0, races: 6 },
      recentMinutes: 30,
      recent: { attempts: 7, failures: 4 },
      span: PREVIEW_WAVE,
    }),
  },
  {
    key: "booking_failure_rate",
    state: "some refusals carry no lead id, so the people count is a floor",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 82,
      failures: 38,
      pct: 46,
      windowMinutes: 180,
      topCodes: [{ code: "slot_unavailable", count: 35 }],
      refused: { people: 4, refusals: 35, withoutLead: 2 },
      recentMinutes: 30,
      recent: { attempts: 14, failures: 9 },
      span: PREVIEW_WAVE,
    }),
  },
  {
    // #3275: the singular forms, a quiet half hour whose one attempt failed and a
    // window whose failures were all recorded by one tick.
    key: "booking_failure_rate",
    state: "the only recent attempt failed, every failure recorded at one time",
    channel: "alert",
    text: formatFailureRateAlert({
      attempts: 24,
      failures: 5,
      pct: 21,
      windowMinutes: 180,
      topCodes: [{ code: "internal", count: 5 }],
      recentMinutes: 30,
      recent: { attempts: 1, failures: 1 },
      span: { firstMs: PREVIEW_WAVE.newestMs, newestMs: PREVIEW_WAVE.newestMs },
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
      windowMinutes: 180,
      topCodes: [
        { code: "internal", count: 28 },
        { code: "no_eligible_agents", count: 2 },
      ],
      recentMinutes: 30,
      recent: { attempts: 10, failures: 6 },
      span: PREVIEW_WAVE,
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
      windowMinutes: 180,
      topCodes: [{ code: "API_KEY_REJECTED", count: 29 }],
      recentMinutes: 30,
      recent: { attempts: 6, failures: 6 },
      span: PREVIEW_WAVE,
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
      windowMinutes: 180,
      topCodes: [{ code: "API_NOT_CONFIGURED", count: 18 }],
      recentMinutes: 30,
      recent: { attempts: 5, failures: 5 },
      span: PREVIEW_WAVE,
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
      windowMinutes: 180,
      topCodes: [],
      recentMinutes: 30,
      recent: { attempts: 8, failures: 4 },
      span: PREVIEW_WAVE,
    }),
  },
  {
    // #3275: the all-clear stands on a measured clean run of recent attempts and
    // quotes nothing else, never the window's share.
    key: "booking_failure_rate",
    state: "bookings completing again, nothing failed since",
    channel: "recovery",
    text: formatFailureRateAllClear({ recentMinutes: 30, recent: { attempts: 6, failures: 0 }, newestFailureMs: PREVIEW_WAVE.newestMs }),
  },
  {
    key: "booking_failure_rate",
    state: "bookings completing again, one ordinary failure in a busy half hour",
    channel: "recovery",
    text: formatFailureRateAllClear({ recentMinutes: 30, recent: { attempts: 24, failures: 1 }, newestFailureMs: PREVIEW_WAVE.newestMs }),
  },
  {
    key: "booking_failure_rate",
    state: "bookings completing again, no failure left in the window",
    channel: "recovery",
    text: formatFailureRateAllClear({ recentMinutes: 30, recent: { attempts: 9, failures: 0 }, newestFailureMs: null }),
  },
  {
    // #3275, the 2026-10-14 6:00am shape: the window crossed the line an hour after
    // its last failure. Reported once, as past, on its own key, so no all-clear
    // follows it five minutes later.
    key: "booking_failure_burst_ended",
    state: "a burst that stopped, with a clean run since",
    channel: "alert",
    text: formatFailureBurstEnded({
      attempts: 38,
      failures: 8,
      pct: 21,
      windowMinutes: 180,
      topCodes: [
        { code: "slot_unavailable", count: 6 },
        { code: "internal", count: 2 },
      ],
      recentMinutes: 30,
      recent: { attempts: 6, failures: 0 },
      span: PREVIEW_BURST,
      minRecentAttempts: 5,
    }),
  },
  {
    key: "booking_failure_burst_ended",
    state: "people counted, with a clean run since",
    channel: "alert",
    text: formatFailureBurstEnded({
      attempts: 38,
      failures: 8,
      pct: 21,
      windowMinutes: 180,
      topCodes: [{ code: "slot_unavailable", count: 8 }],
      refused: { people: 3, refusals: 5, withoutLead: 0 },
      recentMinutes: 30,
      recent: { attempts: 6, failures: 0 },
      span: PREVIEW_BURST,
      minRecentAttempts: 5,
    }),
  },
  {
    key: "booking_failure_burst_ended",
    state: "too few attempts since to say bookings are completing",
    channel: "alert",
    text: formatFailureBurstEnded({
      attempts: 38,
      failures: 8,
      pct: 21,
      windowMinutes: 180,
      topCodes: [{ code: "slot_unavailable", count: 8 }],
      recentMinutes: 30,
      recent: { attempts: 2, failures: 0 },
      span: PREVIEW_BURST,
      minRecentAttempts: 5,
    }),
  },
  {
    key: "booking_failure_burst_ended",
    state: "nobody has tried to book since",
    channel: "alert",
    text: formatFailureBurstEnded({
      attempts: 38,
      failures: 8,
      pct: 21,
      windowMinutes: 180,
      topCodes: [{ code: "internal", count: 8 }],
      recentMinutes: 30,
      recent: { attempts: 0, failures: 0 },
      span: { firstMs: PREVIEW_BURST.newestMs, newestMs: PREVIEW_BURST.newestMs },
      minRecentAttempts: 5,
    }),
  },
  {
    // #3276, the 2026-10-04 shape at the 7:50pm tick: ten refusals in the last six
    // ticks, every one a time refused at confirm.
    key: "booking_failure_volume",
    state: "ten refused times in half an hour, people counted as a floor",
    channel: "alert",
    text: formatFailureVolumeAlert({
      volume: { attempts: 17, failures: 10, byCode: { slot_unavailable: 10 }, firing: true },
      volumeMinutes: 30,
      refused: { people: 7, refusals: 10, withoutLead: 0, times: 6 },
    }),
  },
  {
    key: "booking_failure_volume",
    state: "Slate erroring rather than a sell out, people not readable",
    channel: "alert",
    text: formatFailureVolumeAlert({
      volume: { attempts: 41, failures: 14, byCode: { internal: 8, verify_unavailable: 4, slot_unavailable: 2 }, firing: true },
      volumeMinutes: 30,
      refused: null,
    }),
  },
  {
    key: "booking_failure_volume",
    state: "errors only, nobody refused a time",
    channel: "alert",
    text: formatFailureVolumeAlert({
      volume: { attempts: 12, failures: 11, byCode: { API_KEY_REJECTED: 11 }, firing: true },
      volumeMinutes: 30,
      refused: { people: 0, refusals: 0, withoutLead: 0 },
    }),
  },
  {
    // #3797: the proven lost races of the same half hour are not in the ten, and said so.
    key: "booking_failure_volume",
    state: "stale offers in volume, one lost race counted apart",
    channel: "alert",
    text: formatFailureVolumeAlert({
      volume: { attempts: 16, failures: 10, byCode: { slot_unavailable: 10 }, firing: true },
      volumeMinutes: 30,
      refused: { people: 5, refusals: 10, withoutLead: 0, times: 3, races: 1 },
    }),
  },
  {
    key: "booking_failure_volume",
    state: "refusals recorded with no lead id",
    channel: "alert",
    text: formatFailureVolumeAlert({
      volume: { attempts: 15, failures: 10, byCode: { slot_unavailable: 10 }, firing: true },
      volumeMinutes: 30,
      refused: { people: 0, refusals: 6, withoutLead: 6, times: 2 },
    }),
  },
  {
    key: "booking_failure_volume",
    state: "failures stopped piling up, nothing failed since",
    channel: "recovery",
    text: formatFailureVolumeAllClear({ recentMinutes: 30, recent: { attempts: 6, failures: 0 }, newestFailureMs: PREVIEW_WAVE.newestMs }),
  },
  {
    key: "booking_failure_volume",
    state: "failures stopped piling up, one ordinary failure in a busy half hour",
    channel: "recovery",
    text: formatFailureVolumeAllClear({ recentMinutes: 30, recent: { attempts: 24, failures: 1 }, newestFailureMs: PREVIEW_WAVE.newestMs }),
  },
  // #3179. Spends judged by the real judge against the documented projection, so the
  // budget figures in the copy are the ones docs/slo.md quotes.
  {
    key: "booking_budget:*",
    // #3374: the counts and the error mix of the page that fired on 2026-10-06.
    state: "half the month's booking success budget spent, mostly on times another lead took first",
    channel: "alert",
    text: sloBudgetPageText(
      previewBudgetSpend("success", {
        requests: 2577,
        errors: 102,
        serverFaults: 0,
        errorCodes: [
          { code: "slot_unavailable", count: 78 },
          { code: "invalid_request", count: 14 },
          { code: "no_eligible_agents", count: 5 },
          { code: "invalid_contact", count: 3 },
          { code: "reschedule_slot_taken", count: 2 },
        ],
      }),
      "2026-10",
    ),
  },
  {
    key: "booking_budget:*",
    state: "half the booking success budget spent, none of it on taken times",
    channel: "alert",
    text: sloBudgetPageText(
      previewBudgetSpend("success", {
        requests: 6200,
        errors: 104,
        serverFaults: 0,
        errorCodes: [
          { code: "invalid_request", count: 70 },
          { code: "no_eligible_agents", count: 34 },
        ],
      }),
      "2026-10",
    ),
  },
  {
    key: "booking_budget:*",
    state: "half the booking success budget spent, and the codes could not be read to split it",
    channel: "alert",
    text: sloBudgetPageText(
      previewBudgetSpend("success", { requests: 2577, errors: 102, serverFaults: 0, errorCodes: [] }),
      "2026-10",
    ),
  },
  {
    key: "booking_budget:*",
    state: "server faults have spent half the availability budget",
    channel: "alert",
    text: sloBudgetPageText(
      previewBudgetSpend("availability", {
        requests: 6200,
        errors: 41,
        serverFaults: 35,
        errorCodes: [
          { code: "internal", count: 30 },
          { code: "slot_unavailable", count: 6 },
          { code: "verify_unavailable", count: 5 },
        ],
      }),
      "2026-10",
    ),
  },
  {
    key: "booking_budget:*",
    state: "a new month, the booking success budget back under half",
    channel: "recovery",
    text: sloBudgetClearText("success", "2026-11"),
  },
  {
    key: "booking_budget:*",
    state: "a new month, the availability budget back under half",
    channel: "recovery",
    text: sloBudgetClearText("availability", "2026-11"),
  },
  // #2593. The 2026-09-21 incident's shape: an Ultra High lead (XBC 512) with a
  // Low only agent. One state per catch-all reading, because each sends the reader
  // to a different upstream place, and both all clears.
  {
    key: "booking_below_lead_tier:*",
    state: "the catch-all chose the Low pool for an Ultra High lead",
    channel: "alert",
    text: formatBelowLeadTierAlert(PREVIEW_BELOW_TIER, { catchall: true, requestedCode: "", tierFallback: false, rungsDropped: 0 }, PREVIEW_BELOW_TIER_URL, PREVIEW_TEAM_FREE),
  },
  // #2594: the arrival code tells a re-score after booking apart from a routing
  // fault, so each gets its own state, plus the one where the code cannot say.
  {
    key: "booking_below_lead_tier:*",
    state: "arrived on a lower code than the submission they booked from now scores",
    channel: "alert",
    text: formatBelowLeadTierAlert(PREVIEW_RESCORED, { catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 }, PREVIEW_BELOW_TIER_URL, PREVIEW_TEAM_FREE),
  },
  // #3501, #3508: a rise is named by what was measured: a Lead edit after the
  // latest submission, a newer submission than the one booked from, or (when the
  // booked submission is the latest) both possible causes, since its score keeps no
  // history; and an unattributed rise says the check could not tell.
  {
    key: "booking_below_lead_tier:*",
    state: "arrived on a lower code, and their latest submission is a newer one",
    channel: "alert",
    text: formatBelowLeadTierAlert(PREVIEW_RESUBMITTED, { catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 }, PREVIEW_BELOW_TIER_URL, PREVIEW_TEAM_FREE),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "arrived on a lower code, and the Lead score was edited after the submission",
    channel: "alert",
    text: formatBelowLeadTierAlert(PREVIEW_LEAD_EDIT, { catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 }, PREVIEW_BELOW_TIER_URL, PREVIEW_TEAM_FREE),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "arrived on a lower code, and the booking recorded no submission to tell why",
    channel: "alert",
    text: formatBelowLeadTierAlert(PREVIEW_RISE_UNATTRIBUTED, { catchall: false, requestedCode: "422", tierFallback: false, rungsDropped: 0 }, PREVIEW_BELOW_TIER_URL, PREVIEW_TEAM_FREE),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "arrived on today's code, and the routing placed it lower",
    channel: "alert",
    text: formatBelowLeadTierAlert(PREVIEW_BELOW_TIER, { catchall: false, requestedCode: "512", tierFallback: false, rungsDropped: 0 }, PREVIEW_BELOW_TIER_URL, PREVIEW_TEAM_FREE),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "routed on its own code, and the arrival code is not recorded",
    channel: "alert",
    text: formatBelowLeadTierAlert(PREVIEW_BELOW_TIER, { catchall: false, requestedCode: null, tierFallback: false, rungsDropped: 0 }, PREVIEW_BELOW_TIER_URL, PREVIEW_TEAM_FREE),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "no routing record for the booking",
    channel: "alert",
    text: formatBelowLeadTierAlert(PREVIEW_BELOW_TIER, null, PREVIEW_BELOW_TIER_URL, PREVIEW_TEAM_FREE),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "the routing record could not be read",
    channel: "alert",
    text: formatBelowLeadTierAlert(PREVIEW_BELOW_TIER, "unreadable", PREVIEW_BELOW_TIER_URL, PREVIEW_TEAM_FREE),
  },
  // #3665: what the lead's own team offers at the call's time, judged by the real
  // `teamAtTime` from an offer shaped like the lane's slot rows, and whether the
  // lead's submissions agree on the tier, by the real `submissionAgreement`.
  {
    key: "booking_below_lead_tier:*",
    state: "the lead's team is not free at the call's time, a later time that day is, and the submissions flip between tiers",
    channel: "alert",
    text: previewFlipping(PREVIEW_FLIPPING_OFFER, PREVIEW_FLIPPING_HISTORY),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "the lead's team has no free time at all on the call's day",
    channel: "alert",
    text: previewFlipping({ ...PREVIEW_FLIPPING_OFFER, offeredMs: [Date.UTC(2026, 9, 14, 15, 0)] }, { kind: "steady" }),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "the lead's team is free at the call's time",
    channel: "alert",
    text: previewFlipping({ ...PREVIEW_FLIPPING_OFFER, offeredMs: [Date.UTC(2026, 9, 13, 19, 0)] }, { kind: "steady" }),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "the lead's team could not be checked, because the shared slot read failed",
    channel: "alert",
    text: previewFlipping("unreadable", { kind: "steady" }),
  },
  {
    key: "booking_below_lead_tier:*",
    state: "the lead's submission history could not be read",
    channel: "alert",
    text: previewFlipping(PREVIEW_FLIPPING_OFFER, { kind: "unreadable" }),
  },
  // #2933: one state per way the two bookings can match, since each sends the reader
  // to check a different thing, plus a Slate booking with no lead id. Each pair is
  // the judge's own output for inputs that carry exactly what the state names.
  {
    key: "cross_system_booking:*",
    state: "the same Submission and address in both systems",
    channel: "alert",
    text: formatCrossSystemBookingAlert(
      previewCrossSystemPair(PREVIEW_CROSS_SYSTEM_SLATE, PREVIEW_CROSS_SYSTEM_CAL),
      PREVIEW_CROSS_SYSTEM_URL,
    ),
  },
  {
    key: "cross_system_booking:*",
    state: "the same Submission only",
    channel: "alert",
    text: formatCrossSystemBookingAlert(
      previewCrossSystemPair(PREVIEW_CROSS_SYSTEM_SLATE, { ...PREVIEW_CROSS_SYSTEM_CAL, attendeeEmails: ["another.address@example.invalid"] }),
      PREVIEW_CROSS_SYSTEM_URL,
    ),
  },
  {
    key: "cross_system_booking:*",
    state: "a cal.com booking with no Submission, matched by address",
    channel: "alert",
    text: formatCrossSystemBookingAlert(
      previewCrossSystemPair(PREVIEW_CROSS_SYSTEM_SLATE, { ...PREVIEW_CROSS_SYSTEM_CAL, submissionId: null }),
      PREVIEW_CROSS_SYSTEM_URL,
    ),
  },
  {
    key: "cross_system_booking:*",
    state: "the Slate booking carries no lead id",
    channel: "alert",
    text: formatCrossSystemBookingAlert(
      previewCrossSystemPair({ ...PREVIEW_CROSS_SYSTEM_SLATE, salesforce_id: null }, PREVIEW_CROSS_SYSTEM_CAL),
      PREVIEW_CROSS_SYSTEM_URL,
    ),
  },
  {
    key: "cross_system_booking:*",
    state: "the Slate booking was cancelled or passed",
    channel: "recovery",
    text: formatCrossSystemBookingRecovery(
      PREVIEW_CROSS_SYSTEM_SLATE.id,
      PREVIEW_CROSS_SYSTEM_CAL.uid,
      "slate-gone",
      PREVIEW_CROSS_SYSTEM_URL,
    ),
  },
  {
    key: "cross_system_booking:*",
    state: "a direct read says the cal.com booking was cancelled or came",
    channel: "recovery",
    text: formatCrossSystemBookingRecovery(
      PREVIEW_CROSS_SYSTEM_SLATE.id,
      PREVIEW_CROSS_SYSTEM_CAL.uid,
      "calcom-gone",
      PREVIEW_CROSS_SYSTEM_URL,
    ),
  },
  {
    key: "cross_system_booking:*",
    state: "cal.com was marked retired",
    channel: "recovery",
    text: formatCrossSystemBookingRetired(PREVIEW_CROSS_SYSTEM_SLATE.id),
  },
  // #2715: one state per thing the origin can be, since the second cannot name it.
  {
    key: "booking_offsite_origin:*",
    state: "a real booking from a localhost host page",
    channel: "alert",
    text: formatOffsiteOriginAlert(PREVIEW_OFFSITE, PREVIEW_OFFSITE_URL),
  },
  {
    key: "booking_offsite_origin:*",
    state: "a real booking whose host page address could not be read",
    channel: "alert",
    text: formatOffsiteOriginAlert(
      { ...PREVIEW_OFFSITE, verdict: { kind: "offsite", declared: { kind: "unreadable" }, framedBy: { kind: "none" } } },
      PREVIEW_OFFSITE_URL,
    ),
  },
  // #2728: the framing page is the only off site reading, the case the issue opened on.
  {
    key: "booking_offsite_origin:*",
    state: "framed off site by a page that declared no origin",
    channel: "alert",
    text: formatOffsiteOriginAlert(
      {
        ...PREVIEW_OFFSITE,
        verdict: { kind: "offsite", declared: { kind: "none" }, framedBy: { kind: "offsite", origin: "https://partner.example" } },
      },
      PREVIEW_OFFSITE_URL,
    ),
  },
  {
    key: "booking_offsite_origin:*",
    state: "declared the production site while framed off site",
    channel: "alert",
    text: formatOffsiteOriginAlert(
      {
        ...PREVIEW_OFFSITE,
        verdict: {
          kind: "offsite",
          declared: { kind: "production", origin: "https://trypennie.com" },
          framedBy: { kind: "offsite", origin: "https://dev.trypennie.com" },
        },
      },
      PREVIEW_OFFSITE_URL,
    ),
  },
  {
    key: "booking_offsite_origin:*",
    state: "declared an off site page while framed by the production site",
    channel: "alert",
    text: formatOffsiteOriginAlert(
      {
        ...PREVIEW_OFFSITE,
        verdict: {
          kind: "offsite",
          declared: { kind: "offsite", origin: "http://localhost:3000" },
          framedBy: { kind: "production", origin: "https://www.trypennie.com" },
        },
      },
      PREVIEW_OFFSITE_URL,
    ),
  },
  {
    key: "booking_offsite_origin:*",
    state: "declared one off site page and framed by another",
    channel: "alert",
    text: formatOffsiteOriginAlert(
      {
        ...PREVIEW_OFFSITE,
        verdict: {
          kind: "offsite",
          declared: { kind: "offsite", origin: "http://localhost:3000" },
          framedBy: { kind: "offsite", origin: "https://partner.example" },
        },
      },
      PREVIEW_OFFSITE_URL,
    ),
  },
  {
    key: "empty_tier:*",
    state: "nobody is assigned to the tier at all",
    channel: "alert",
    text: tierUnstaffedMessage({ tier: "5", label: "Ultra High" }),
  },
  // #3037: the no-slots page names the cause, from a diagnosis the lane makes only
  // on a tick about to page; since #3559 in one clause over the days the booker
  // shows. One state per cause, the mixed 2026-10-02 shape, and the fallback when
  // the diagnosis could not be read.
  {
    key: "empty_tier:*",
    state: "booked or off over Friday, Saturday and Monday (the 2026-10-02 shape)",
    channel: "alert",
    text: tierNoSlotsMessage(
      { tier: "5", label: "Ultra High", agents: 10, firstSlotMs: PREVIEW_TIER_FIRST_SLOT, days: PREVIEW_TIER_DAYS },
      previewTierCause(0, [
        { off: 3, slate: 6, outside: 1, open: 0 },
        { off: 9, slate: 1, outside: 0, open: 0 },
        { off: 0, slate: 9, outside: 1, open: 0 },
      ]),
    ),
  },
  {
    key: "empty_tier:*",
    state: "nobody on the tier works in the window",
    channel: "alert",
    text: tierNoSlotsMessage(
      PREVIEW_VERY_HIGH_PAGE,
      previewTierCause(0, [{ off: 19, slate: 0, outside: 0, open: 0 }]),
    ),
  },
  {
    key: "empty_tier:*",
    state: "everybody works and every one is held by outside meetings or time off",
    channel: "alert",
    text: tierNoSlotsMessage(
      PREVIEW_VERY_HIGH_PAGE,
      previewTierCause(0, [{ off: 0, slate: 0, outside: 19, open: 0 }]),
    ),
  },
  {
    key: "empty_tier:*",
    state: "the tier rests on one agent and they are fully booked",
    channel: "alert",
    text: tierNoSlotsMessage(
      { tier: "5", label: "Ultra High", agents: 1, firstSlotMs: PREVIEW_TIER_FIRST_SLOT, days: PREVIEW_TIER_DAYS },
      previewTierCause(0, [{ off: 0, slate: 1, outside: 0, open: 0 }]),
    ),
  },
  {
    key: "empty_tier:*",
    state: "the calendar sync has stopped for some agents and the rest are booked",
    channel: "alert",
    text: tierNoSlotsMessage(
      { tier: "3", label: "High", agents: 5, firstSlotMs: PREVIEW_TIER_FIRST_SLOT, days: PREVIEW_TIER_DAYS },
      previewTierCause(2, [{ off: 1, slate: 2, outside: 0, open: 0 }]),
    ),
  },
  {
    key: "empty_tier:*",
    state: "the calendar sync has stopped for every agent on the tier",
    channel: "alert",
    text: tierNoSlotsMessage(
      { tier: "5", label: "Ultra High", agents: 3, firstSlotMs: null, days: PREVIEW_TIER_DAYS },
      previewTierCause(3, [{ off: 0, slate: 0, outside: 0, open: 0 }]),
    ),
  },
  {
    key: "empty_tier:*",
    state: "an agent shows an opening the cached times do not have yet",
    channel: "alert",
    text: tierNoSlotsMessage(
      { tier: "4", label: "Very High", agents: 4, firstSlotMs: PREVIEW_TIER_FIRST_SLOT, days: PREVIEW_TIER_DAYS },
      previewTierCause(0, [{ off: 1, slate: 2, outside: 0, open: 1 }]),
    ),
  },
  {
    key: "empty_tier:*",
    state: "the cause could not be read, so the three possibilities stay",
    channel: "alert",
    text: tierNoSlotsMessage(
      PREVIEW_VERY_HIGH_PAGE,
      { measured: false },
    ),
  },
  {
    key: "empty_tier:*",
    state: "one agent, the cause could not be read, and nothing is offered at all",
    channel: "alert",
    text: tierNoSlotsMessage(
      { tier: "5", label: "Ultra High", agents: 1, firstSlotMs: null, days: PREVIEW_TIER_DAYS },
      { measured: false },
    ),
  },
  {
    key: "empty_tier:*",
    state: "the tier is offering times again",
    channel: "recovery",
    text: tierRecoveredMessage({ tier: "5", label: "Ultra High" }),
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

  // --- appointments a demotion took off the pool, un-rerouted (#3582) --------
  // The sibling of the pool-exit page above, a separate alert: a still-bookable agent moved off
  // a pool a booking they hold needs, whose automatic reroute did not move it.
  {
    key: "demoted_agent_bookings",
    state: "one demoted agent holding one appointment",
    channel: "alert",
    text: formatDemotedAgentBookingsAlert([
      { userId: "u1", name: "Dana Ruiz", email: "dana.ruiz@example.com", reason: "demoted", bookingCount: 1 },
    ]),
  },
  {
    key: "demoted_agent_bookings",
    state: "several demoted agents",
    channel: "alert",
    text: formatDemotedAgentBookingsAlert([
      { userId: "u1", name: "Dana Ruiz", email: "dana.ruiz@example.com", reason: "demoted", bookingCount: 4 },
      { userId: "u2", name: null, email: "sam.okafor@example.com", reason: "demoted", bookingCount: 2 },
    ]),
  },
  {
    key: "demoted_agent_bookings",
    state: "every appointment rerouted or reassigned",
    channel: "recovery",
    text: formatDemotedAgentBookingsRecovery(),
  },

  // --- two calls on one advisor inside the call type's buffer (#3040) --------
  // Three shapes: back to back under a 10 minute buffer (what production held), an
  // outright overlap beside a short gap, and the all clear.
  {
    key: "booking_buffer_breach",
    state: "one pair back to back",
    channel: "alert",
    text: formatBufferBreachAlert(
      judgeBufferBreaches([
        previewCall("3f1c9a2e-0b7d-4c55-9e61-2a8d4f0c7b11", "u1", "Dana Ruiz", "2026-10-23T16:00:00.000Z", 20),
        previewCall("8b2e4d70-61af-4f3c-b0d2-95c7e1a3f604", "u1", "Dana Ruiz", "2026-10-23T16:20:00.000Z", 20),
      ]).breaches,
      previewBookingUrl,
    ),
  },
  {
    key: "booking_buffer_breach",
    state: "an overlap and a short gap on two advisors",
    channel: "alert",
    text: formatBufferBreachAlert(
      judgeBufferBreaches([
        previewCall("35b17a5c-9d0e-4f21-8a6b-1c2d3e4f5a60", "u1", "Dana Ruiz", "2026-10-23T18:00:00.000Z", 20),
        previewCall("3acd0bac-7e1f-4a32-9b4c-5d6e7f8a9b01", "u1", "Dana Ruiz", "2026-10-23T18:10:00.000Z", 20),
        previewCall("d7489fff-2a3b-4c4d-8e5f-6a7b8c9d0e12", "u2", "Sam Okafor", "2026-10-24T14:00:00.000Z", 20),
        previewCall("fb1949ee-3b4c-4d5e-9f6a-7b8c9d0e1f23", "u2", "Sam Okafor", "2026-10-24T14:25:00.000Z", 20),
      ]).breaches,
      previewBookingUrl,
    ),
  },
  {
    key: "booking_buffer_breach",
    state: "every pair moved, cancelled or passed",
    channel: "recovery",
    text: formatBufferBreachRecovery(),
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
    // #2875: ended by retiring cal.com, with no block put in place.
    key: "ooo_calcom_unprotected",
    state: "cal.com was retired",
    channel: "recovery",
    text: formatCalcomRetiredSweepEnding(),
  },
  {
    // #3485: why the advisor will not be there (time off, with its window), advisor linked,
    // no booking-id wall (readability, 2026-10-11). The common real case, David Shearer's.
    key: "coverage_needs_human",
    state: "one appointment, advisor on time off (linked)",
    channel: "alert",
    text: formatCoverageNeedsHumanAlert(
      [
        {
          userId: "u1",
          name: "Dana Ruiz",
          email: "dana.ruiz@example.com",
          unplaceable: 1,
          failed: 0,
          firstStartsAt: "2026-10-13T16:00:00Z",
          cause: {
            kind: "time-off",
            timeOff: {
              startsAt: "2026-10-13T14:30:00Z",
              endsAt: "2026-10-13T20:00:00Z",
              tzId: "America/Chicago",
              tzLabel: "CT",
            },
          },
        },
      ],
      "https://slate.example.com",
    ),
  },
  {
    // #3485: two different causes across agents, and the links, at production shape.
    key: "coverage_needs_human",
    state: "both outcomes, several agents, mixed causes",
    channel: "alert",
    text: formatCoverageNeedsHumanAlert(
      [
        {
          userId: "u1",
          name: "Dana Ruiz",
          email: "dana.ruiz@example.com",
          unplaceable: 4,
          failed: 2,
          firstStartsAt: "2026-10-13T16:30:00Z",
          cause: {
            kind: "time-off",
            timeOff: {
              startsAt: "2026-10-13T14:30:00Z",
              endsAt: "2026-10-13T20:00:00Z",
              tzId: "America/Chicago",
              tzLabel: "CT",
            },
          },
        },
        { userId: "u2", name: "Sam Okafor", email: "sam.okafor@example.com", unplaceable: 0, failed: 1, cause: { kind: "offboarded" }, firstStartsAt: "2026-10-13T16:10:00Z" },
        { userId: "u3", name: null, email: "kim.ito@example.com", unplaceable: 1, failed: 0 },
      ],
      "https://slate.example.com",
    ),
  },
  {
    key: "coverage_needs_human",
    state: "more agents than the list cap",
    channel: "alert",
    text: formatCoverageNeedsHumanAlert(
      Array.from({ length: 11 }, (_, i) => {
        const unplaceable = 11 - i;
        const failed = i % 3 === 0 ? 1 : 0;
        return {
          userId: `u${i}`,
          name: `Agent ${i}`,
          email: `agent${i}@example.com`,
          unplaceable,
          failed,
        };
      }),
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

  // --- the database running low on memory (#3588) ------------------------------
  {
    key: "db_saturation",
    state: "committed memory critically high with swap in use",
    channel: "alert",
    text: formatDbSaturationAlert(
      judgeDbSaturation({
        committedBytes: 1.55 * 1024 ** 3,
        limitBytes: 1.69 * 1024 ** 3,
        swapTotalBytes: 1 * 1024 ** 3,
        swapFreeBytes: 0.6 * 1024 ** 3,
      }),
    ),
  },
  {
    key: "db_saturation",
    state: "committed memory fully back under the 80% warning line",
    channel: "recovery",
    text: formatDbSaturationRecovery(),
  },
  {
    key: "db_saturation_warn",
    state: "memory elevated but not yet critical",
    channel: "info",
    text: formatDbSaturationWarn(
      judgeDbSaturation({
        committedBytes: 0.85 * 1024 ** 3,
        limitBytes: 1 * 1024 ** 3,
        swapTotalBytes: 1 * 1024 ** 3,
        swapFreeBytes: 0.95 * 1024 ** 3,
      }),
    ),
  },

  // --- busy time on a calendar the cache has not picked up (#1591) -------------
  {
    key: "busy_cache_drift",
    state: "one agent's busy time missing for half an hour",
    channel: "alert",
    text: formatBusyDriftAlert([
      {
        email: "dana.ruiz@example.com",
        userId: "u1",
        gaps: 1,
        gapMinutes: 20,
        firstGapStartIso: "2026-10-02T18:30:00.000Z",
      },
    ]),
  },
  {
    key: "busy_cache_drift",
    state: "two agents, one with several stretches missing",
    channel: "alert",
    text: formatBusyDriftAlert([
      {
        email: "dana.ruiz@example.com",
        userId: "u1",
        gaps: 1,
        gapMinutes: 20,
        firstGapStartIso: "2026-10-02T18:30:00.000Z",
      },
      {
        email: "sam.okafor@example.com",
        userId: "u2",
        gaps: 3,
        gapMinutes: 95,
        firstGapStartIso: "2026-10-03T14:00:00.000Z",
      },
    ]),
  },
  {
    key: "busy_cache_drift",
    state: "a full pass of the roster matches again",
    channel: "recovery",
    text: formatBusyDriftRecovery(),
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
  // --- a sweep that is not running at all, rather than falling behind (#2544) ---
  {
    key: COMPLETION_SWEEP_FAILING_KEY,
    state: "throwing on consecutive runs",
    channel: "alert",
    text: formatSweepFailureAlert(COMPLETION_SWEEP_FAILING_KEY, SWEEP_FAILURE_ALERT_AFTER_RUNS),
  },
  {
    key: COMPLETION_SWEEP_FAILING_KEY,
    state: "running again",
    channel: "recovery",
    text: formatSweepFailureRecovery(COMPLETION_SWEEP_FAILING_KEY),
  },
  {
    key: WEBHOOK_RETRY_SWEEP_FAILING_KEY,
    state: "throwing on consecutive runs",
    channel: "alert",
    text: formatSweepFailureAlert(WEBHOOK_RETRY_SWEEP_FAILING_KEY, SWEEP_FAILURE_ALERT_AFTER_RUNS),
  },
  {
    key: WEBHOOK_RETRY_SWEEP_FAILING_KEY,
    state: "running again",
    channel: "recovery",
    text: formatSweepFailureRecovery(WEBHOOK_RETRY_SWEEP_FAILING_KEY),
  },
  {
    key: DEMO_AUTO_CANCEL_FAILING_KEY,
    state: "throwing on consecutive runs",
    channel: "alert",
    text: formatSweepFailureAlert(DEMO_AUTO_CANCEL_FAILING_KEY, SWEEP_FAILURE_ALERT_AFTER_RUNS),
  },
  {
    key: DEMO_AUTO_CANCEL_FAILING_KEY,
    state: "running again",
    channel: "recovery",
    text: formatSweepFailureRecovery(DEMO_AUTO_CANCEL_FAILING_KEY),
  },
  // --- the same on the outbox lane: its drain (#3846) and its three secondary jobs (#3077) ---
  ...[
    OUTBOX_DRAIN_FAILING_KEY,
    RESERVATION_DRAIN_FAILING_KEY,
    RESCHEDULE_PIN_SWEEP_FAILING_KEY,
    REASSIGN_INTENT_SWEEP_FAILING_KEY,
    COVERAGE_RETRY_SWEEP_FAILING_KEY,
  ].flatMap((key) => [
    {
      key,
      state: "throwing on consecutive runs",
      channel: "alert" as const,
      text: formatSweepFailureAlert(key, sweepFailureAfterRuns(key)),
    },
    {
      key,
      state: "running again",
      channel: "recovery" as const,
      text: formatSweepFailureRecovery(key),
    },
  ]),
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
    // The live page (#1936) at its smallest: one day inside the booking horizon
    // whose first hour nobody covers. It must carry the "opens with nobody on"
    // emphasis, since a lead arriving at opening finds the business looking shut.
    // Sent the evening before, as the page #3054 was filed about was: the gap is
    // twelve hours off and nothing is happening yet, so it must not read as if it is.
    // A Tuesday, because Saturday gaps never page (Dan, 2026-10-02).
    key: "roster_coverage_gap",
    state: "one day inside the horizon opens with nobody on, twelve hours from now",
    channel: "alert",
    text: formatRosterCoverageLiveAlert(
      [coverageGap({ dateIso: "2026-10-06", weekday: 2, startMinute: 480, endMinute: 540, range: "live", opensUncovered: true })],
      rosterSentAt("2026-10-05T20:10"),
      rosterCheckedDates("2026-10-05", "2026-10-09"),
    ),
  },
  {
    // The one state allowed to say the gap is happening: it had already started
    // when the page was sent (#3054).
    key: "roster_coverage_gap",
    state: "an evening gap already running when the page is sent",
    channel: "alert",
    text: formatRosterCoverageLiveAlert(
      [coverageGap({ dateIso: "2026-10-02", weekday: 5, startMinute: 1020, endMinute: 1200, range: "live" })],
      rosterSentAt("2026-10-02T18:10"),
      rosterCheckedDates("2026-10-02", "2026-10-08"),
    ),
  },
  {
    // Several findings at once: a whole uncovered day plus an evening tail on three
    // dates. Grouped so the whole day comes first and the tail is stated once with
    // its dates. The opening sentence names the EARLIEST start, the one that
    // matters first. The whole day is a Monday holiday opening nobody covers, since
    // Saturday gaps never page (Dan, 2026-10-02).
    key: "roster_coverage_gap",
    state: "a whole day and an evening tail inside the horizon",
    channel: "alert",
    text: formatRosterCoverageLiveAlert(
      [
        coverageGap({ dateIso: "2026-10-05", weekday: 1, startMinute: 480, endMinute: 1200, wholeDay: true, range: "live", opensUncovered: true }),
        ...["2026-10-02", "2026-10-06", "2026-10-07"].map((dateIso, i) =>
          coverageGap({ dateIso, weekday: [5, 2, 3][i], startMinute: 1020, endMinute: 1200, range: "live" }),
        ),
      ],
      rosterSentAt("2026-10-02T10:00"),
      rosterCheckedDates("2026-10-02", "2026-10-08"),
    ),
  },
  {
    // #2810: the shape that used to list eleven dates. Production's roster ends at
    // 17:00 while the org advertises until 20:00, so the same tail recurs on every
    // checked day of a long horizon, and it is stated once as a range. Saturdays
    // fall inside it and are never judged, so the range sets them aside by name.
    key: "roster_coverage_gap",
    state: "the same evening tail on every open day of a two week horizon",
    channel: "alert",
    text: formatRosterCoverageLiveAlert(
      recurringCoverageGaps(rosterCheckedDates("2026-09-28", "2026-10-09"), EVENING_TAIL, "live"),
      rosterSentAt("2026-09-28T07:00"),
      rosterCheckedDates("2026-09-28", "2026-10-09"),
    ),
  },
  {
    // #2810: one checked day IS covered for those hours, so the run splits around
    // it rather than a range claiming it. The two days before it are named, since
    // a range of two says less than the dates.
    key: "roster_coverage_gap",
    state: "a recurring evening tail broken by one covered day",
    channel: "alert",
    text: formatRosterCoverageLiveAlert(
      recurringCoverageGaps(
        rosterCheckedDates("2026-09-28", "2026-10-09").filter((dateIso) => dateIso !== "2026-09-30"),
        EVENING_TAIL,
        "live",
      ),
      rosterSentAt("2026-09-28T07:00"),
      rosterCheckedDates("2026-09-28", "2026-10-09"),
    ),
  },
  {
    // #2810: every checked day opens with nobody on. The emphasis rides along with
    // the range rather than being lost in the collapse.
    key: "roster_coverage_gap",
    state: "every open day of the horizon opens with nobody on",
    channel: "alert",
    text: formatRosterCoverageLiveAlert(
      recurringCoverageGaps(
        rosterCheckedDates("2026-09-28", "2026-10-09"),
        { startMinute: 480, endMinute: 540, opensUncovered: true },
        "live",
      ),
      rosterSentAt("2026-09-28T07:00"),
      rosterCheckedDates("2026-09-28", "2026-10-09"),
    ),
  },
  {
    key: "roster_coverage_gap",
    state: "the horizon is covered again and nothing further out is open",
    channel: "recovery",
    text: formatRosterCoverageLiveRecovery(false),
  },
  {
    // The live all-clear while the far notice still stands, so "covered" is never
    // read as the week ahead being settled too.
    key: "roster_coverage_gap",
    state: "the horizon is covered again and a gap further out still stands",
    channel: "recovery",
    text: formatRosterCoverageLiveRecovery(true),
  },
  {
    // The shape #1936 was filed about: next week's day opens with nobody on.
    // Nothing is broken yet, and the wording has to say so. A Friday, because
    // Saturday gaps never page (Dan, 2026-10-02).
    key: "roster_coverage_upcoming_gap",
    state: "next Friday opens with nobody on",
    channel: "alert",
    text: formatRosterCoverageUpcomingAlert(
      [
        coverageGap({ dateIso: "2026-10-02", weekday: 5, startMinute: 480, endMinute: 540, range: "upcoming", opensUncovered: true }),
      ],
      rosterCheckedDates("2026-09-28", "2026-10-02"),
    ),
  },
  {
    key: "roster_coverage_upcoming_gap",
    state: "a midday hour on several days past the horizon",
    channel: "alert",
    text: formatRosterCoverageUpcomingAlert(
      ["2026-10-01", "2026-10-02", "2026-10-05"].map((dateIso, i) =>
        coverageGap({ dateIso, weekday: [4, 5, 1][i], startMinute: 720, endMinute: 780, range: "upcoming" }),
      ),
      // Thursday, Friday and Monday are consecutive CHECKED days (the weekend
      // between them is not judged), so the three collapse into a range (#2810),
      // while Tuesday and Wednesday before them are checked and covered.
      rosterCheckedDates("2026-09-29", "2026-10-05"),
    ),
  },
  {
    // #2810: the week past the horizon, the same tail on every checked day, stated
    // as one range. No Saturday falls inside it, so nothing is set aside.
    key: "roster_coverage_upcoming_gap",
    state: "the same evening tail on every open day of the week past the horizon",
    channel: "alert",
    text: formatRosterCoverageUpcomingAlert(
      recurringCoverageGaps(rosterCheckedDates("2026-10-12", "2026-10-16"), EVENING_TAIL, "upcoming"),
      rosterCheckedDates("2026-10-10", "2026-10-16"),
    ),
  },
  {
    key: "roster_coverage_upcoming_gap",
    state: "the week past the horizon is covered and nothing nearer is open",
    channel: "recovery",
    text: formatRosterCoverageUpcomingRecovery(false),
  },
  {
    // The far gap has slid inside the horizon: this key clears and the live one
    // takes it over, so the all-clear must not read as the gap having been filled.
    key: "roster_coverage_upcoming_gap",
    state: "the week past the horizon is covered while a nearer gap still stands",
    channel: "recovery",
    text: formatRosterCoverageUpcomingRecovery(true),
  },
  // #2366: the kill switch left on. Three states, because the reader gets a
  // different amount of help in each and the difference is worth seeing side by side.
  {
    // The threshold exactly, which is the earliest this can ever be read. It has to
    // read as a reasonable first thing to say rather than as an alarm.
    key: "public_booking_stopped",
    state: "just past the threshold, on a morning somebody forgot overnight",
    channel: "alert",
    text: formatPublicBookingStoppedAlert(PAUSE_NOTICE_AFTER_MS),
  },
  {
    // The case the issue was filed about, read at the far end: stopped at 2am and
    // first spoken about when the org opens.
    key: "public_booking_stopped",
    state: "stopped overnight and still stopped when the day starts",
    channel: "alert",
    text: formatPublicBookingStoppedAlert(6 * 60 * 60_000),
  },
  {
    // No stamp at all, which is a row paused by hand SQL or one that predates
    // migration 0132. It must not quote a span it never measured.
    key: "public_booking_stopped",
    state: "stopped with nothing recording when",
    channel: "alert",
    text: formatPublicBookingStoppedAlert(null),
  },
  {
    key: "public_booking_stopped",
    state: "somebody started booking again",
    channel: "recovery",
    text: formatPublicBookingRunningRecovery(),
  },
  // #3339: the shared confirm line switched on and then left off. A switch never turned
  // on says nothing, so it has no state here.
  {
    key: "shared_confirm_line_left_off",
    state: "off for just over a day after it had been switched on",
    channel: "alert",
    text: formatSharedLineLeftOffAlert(SHARED_LINE_OFF_NOTICE_AFTER_MS + 3 * 60 * 60_000),
  },
  {
    // Switched off by hand SQL, or an audit write that failed: no span to quote.
    key: "shared_confirm_line_left_off",
    state: "off with nothing recording when",
    channel: "alert",
    text: formatSharedLineLeftOffAlert(null),
  },
  {
    key: "shared_confirm_line_left_off",
    state: "somebody switched the line back on",
    channel: "recovery",
    text: formatSharedLineBackOnRecovery(),
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
    // #2875: once cal.com is retired the page stops offering the cal.com import.
    key: "agents_on_unset_hours",
    state: "one agent past the grace, after cal.com was retired",
    channel: "alert",
    text: formatUnsetHoursAlert(
      [{ id: "u1", email: "cfrank@trypennie.com", name: "C Frank", unsetSinceMs: NOW_MS - 6 * 24 * 60 * 60_000 }],
      NOW_MS,
      { calcomRetired: true },
    ),
  },
  {
    key: "agents_on_unset_hours",
    state: "nobody past the grace",
    channel: "recovery",
    text: formatUnsetHoursRecovery(),
  },
  {
    // #2318. Past the four hour grace, which is the only state that reaches Slack:
    // somebody marked this morning is silent, so a fixture inside the window would
    // render a message the lane never sends.
    key: "agents_awaiting_activation",
    state: "agents stuck outside the pool past the grace",
    channel: "alert",
    text: formatAwaitingActivationAlert(
      [
        { id: "u1", email: "cfrank@trypennie.com", name: "C Frank", waitingSinceMs: NOW_MS - 9 * 60 * 60_000 },
        { id: "u2", email: "jsaminu@trypennie.com", name: null, waitingSinceMs: NOW_MS - 6 * 24 * 60 * 60_000 },
      ],
      NOW_MS,
    ),
  },
  {
    // The stamp nothing can read, which is reported rather than spared. It renders
    // its own words, so a broken date can never arrive as "NaN hours".
    key: "agents_awaiting_activation",
    state: "one whose mark cannot be read",
    channel: "alert",
    text: formatAwaitingActivationAlert(
      [{ id: "u3", email: "dpatel@trypennie.com", name: "D Patel", waitingSinceMs: null }],
      NOW_MS,
    ),
  },
  {
    key: "agents_awaiting_activation",
    state: "nobody past the grace",
    channel: "recovery",
    text: formatAwaitingActivationRecovery(),
  },
  // #2481. Invented people (L155). One and several read differently, and past
  // eight the names are capped, so each is its own state.
  {
    key: "agents_stranded_outside_pool",
    state: "one hire stranded",
    channel: "alert",
    text: formatStrandedHiresAlert([{ id: "u1", name: "Robin Example", email: "rexample@trypennie.com" }]),
  },
  {
    key: "agents_stranded_outside_pool",
    state: "more hires stranded than the message names",
    channel: "alert",
    text: formatStrandedHiresAlert(
      Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, name: null, email: `hire${i}@trypennie.com` })),
    ),
  },
  {
    key: "agents_stranded_outside_pool",
    state: "nobody stranded",
    channel: "recovery",
    text: formatStrandedHiresRecovery(),
  },
  // #3530. Invented people (L155). One and several read differently, an advisor with
  // no roster row is named by id, and past eight the names are capped.
  {
    key: "ladder_advisor_unreadable",
    state: "one advisor left out",
    channel: "alert",
    text: formatLadderDroppedAlert([{ id: "u1", name: "Robin Example", why: ["agents: no readable org, attributes or email"] }]),
  },
  {
    key: "ladder_advisor_unreadable",
    state: "several, one with no roster row",
    channel: "alert",
    text: formatLadderDroppedAlert([
      { id: "u1", name: "Robin Example", why: ["schedules: no readable id, zone or rules"] },
      { id: "0f9c2b1e-4d1a-4c3e-9a55-2b6f1e0c7d10", name: null, why: ["busy: no readable bounds or source", "holds: no readable booking or window"] },
    ]),
  },
  {
    key: "ladder_advisor_unreadable",
    state: "more left out than the message names",
    channel: "alert",
    text: formatLadderDroppedAlert(Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}`, why: ["day_counts: no readable day or count"] }))),
  },
  {
    key: "ladder_advisor_unreadable",
    state: "nobody left out",
    channel: "recovery",
    text: formatLadderDroppedRecovery(),
  },
  // #2090. Invented people, never real agents (L155). The two axes read differently
  // because the remedies do: a switch somebody turned off, or somebody who left.
  {
    key: "regal_call_unroutable:*",
    state: "an agent whose bookable switch is off placed calls",
    channel: "alert",
    text: formatRegalCallAlert(
      judgeRegalCallers(
        [
          { agent_email: "ada.example@trypennie.com", occurred_at: new Date(NOW_MS - 40 * 60_000).toISOString() },
          { agent_email: "ada.example@trypennie.com", occurred_at: new Date(NOW_MS - 4 * 60_000).toISOString() },
        ],
        [REGAL_PREVIEW_CALLER],
        [],
      )[0],
    ),
  },
  {
    key: "regal_call_unroutable:*",
    state: "a deactivated agent placed a call",
    channel: "alert",
    text: formatRegalCallAlert(
      judgeRegalCallers(
        REGAL_PREVIEW_ONE_CALL,
        [{ ...REGAL_PREVIEW_CALLER, deactivated_at: "2026-07-20T00:00:00Z" }],
        [],
      )[0],
    ),
  },
  {
    // #2735: tagged Redistribute, and the roster sync found no Twilio worker for
    // them, so the tag no longer exempts them and the page says why.
    key: "regal_call_unroutable:*",
    state: "a Redistribute agent whose Twilio worker is gone placed a call",
    channel: "alert",
    text: formatRegalCallAlert(
      judgeRegalCallers(
        REGAL_PREVIEW_ONE_CALL,
        [
          {
            ...REGAL_PREVIEW_CALLER,
            attributes: { redistribute_tagged: "Y", twilio_worker_missing_since: "2026-07-26T14:00:00.000Z" },
          },
        ],
        [],
      )[0],
    ),
  },
  {
    key: "regal_call_unroutable:*",
    state: "they are bookable again",
    channel: "recovery",
    text: formatRegalCallEnding({ userId: "u-ada", ending: "routable", user: REGAL_PREVIEW_CALLER, ignoreReason: null }),
  },
  {
    // A suppression, not a recovery, and it must say so (L11).
    key: "regal_call_unroutable:*",
    state: "they were added to the ignore list",
    channel: "recovery",
    text: formatRegalCallEnding({
      userId: "u-ada",
      ending: "ignored",
      user: REGAL_PREVIEW_CALLER,
      ignoreReason: "works outbound campaigns only, never booked calls",
    }),
  },
  {
    key: "regal_call_unroutable:*",
    state: "their role changed away from agent",
    channel: "recovery",
    text: formatRegalCallEnding({ userId: "u-ada", ending: "exempt-role", user: REGAL_PREVIEW_CALLER, ignoreReason: null }),
  },
  {
    key: "regal_call_unroutable:*",
    state: "they were marked as a test user",
    channel: "recovery",
    text: formatRegalCallEnding({ userId: "u-ada", ending: "exempt-test", user: REGAL_PREVIEW_CALLER, ignoreReason: null }),
  },
  {
    // #2724: a suppression like the ignore list's, never recovery wording (L11).
    key: "regal_call_unroutable:*",
    state: "they carry the Redistribute tag in Twilio",
    channel: "recovery",
    text: formatRegalCallEnding({
      userId: "u-ada",
      ending: "exempt-redistribute",
      user: REGAL_PREVIEW_CALLER,
      ignoreReason: null,
    }),
  },
  {
    key: "regal_call_unroutable:*",
    state: "the user no longer exists",
    channel: "recovery",
    text: formatRegalCallEnding({ userId: "4b1e0c55-0000-4000-8000-000000000000", ending: "gone", user: null, ignoreReason: null }),
  },
  {
    key: "regal_calls_quiet",
    state: "nothing at all arrived",
    channel: "alert",
    text: formatRegalFeedQuietAlert(REGAL_PREVIEW_DAY, {}),
  },
  {
    key: "regal_calls_quiet",
    state: "plenty arrived and none from a Slate user",
    channel: "alert",
    text: formatRegalFeedQuietAlert(REGAL_PREVIEW_DAY, {
      ai_agent: 4120,
      agent_email_null: 1788,
      no_slate_user: 3,
      foreign_domain: 12,
    }),
  },
  {
    key: "regal_calls_quiet",
    state: "calls from Slate users are arriving",
    channel: "recovery",
    text: formatRegalFeedQuietRecovery(212),
  },
  {
    key: "regal_calls_unreadable",
    state: "Regal changed a field",
    channel: "alert",
    text: formatRegalFeedUnreadableAlert({ candidate: 380, ai_agent: 2900, ai_flag_unreadable: 1411, timestamp_unreadable: 1 }),
  },
  {
    key: "regal_calls_unreadable",
    state: "a day of readable events",
    channel: "recovery",
    text: formatRegalFeedUnreadableRecovery(),
  },
  {
    key: "regal_call_outcomes_short",
    state: "outcomes stopped being stored",
    channel: "alert",
    text: formatRegalCallOutcomesAlert({ received: 1040, written: 612, windowMinutes: 120 }),
  },
  {
    key: "regal_call_outcomes_short",
    state: "not one outcome stored",
    channel: "alert",
    text: formatRegalCallOutcomesAlert({ received: 25, written: 0, windowMinutes: 15 }),
  },
  {
    key: "regal_call_outcomes_short",
    state: "outcomes stored again",
    channel: "recovery",
    text: formatRegalCallOutcomesRecovery({ received: 1040, written: 1031, windowMinutes: 120 }),
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
    // #3963: every count on the page at ONE, because "1 agent were corrected" is
    // what shipped on 2026-10-20 and only a singular fixture can show it.
    key: "schedule_parity_drift",
    state: "one agent corrected, one left differing and one unread",
    channel: "alert",
    text: buildScheduleParityAlert(
      classifyParitySweep({
        total: 102,
        compared: 99,
        runUrl: "https://github.com/Try-Pennie/slate/actions/runs/1",
        findings: [
          { verdict: "hours-differ", count: 1, agents: ["jsullivan@"] },
          { verdict: "calcom-unreachable", count: 1, agents: ["fcaruso@"] },
        ],
        corrected: { count: 1, agents: ["radeyemo@"] },
      }),
    ),
  },
  {
    // #3963: bookable in Slate with no attribute any pool matches, so neither
    // system offers them. It used to read as somebody "Slate offers", which was
    // false and pointed at cal.com for a fix that is made in Twilio.
    key: "schedule_parity_drift",
    state: "a bookable agent is in no routing pool",
    channel: "alert",
    text: buildScheduleParityAlert(
      classifyParitySweep({
        total: 102,
        compared: 100,
        runUrl: "https://github.com/Try-Pennie/slate/actions/runs/1",
        findings: [{ verdict: "bookable-in-no-pool", count: 1, agents: ["asmith@"] }],
        corrected: { count: 0, agents: [] },
      }),
    ),
  },
  {
    // #3963: the other direction. cal.com routes them leads and no Slate pool
    // reaches them, so at cutover they would get none. This read as agreement.
    key: "schedule_parity_drift",
    state: "agents cal.com routes are in no Slate routing pool",
    channel: "alert",
    text: buildScheduleParityAlert(
      classifyParitySweep({
        total: 102,
        compared: 100,
        runUrl: "https://github.com/Try-Pennie/slate/actions/runs/1",
        findings: [{ verdict: "in-no-pool-still-routed", count: 2, agents: ["bjones@", "ckim@"] }],
        corrected: { count: 0, agents: [] },
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
    key: "schedule_parity_drift",
    state: "they agree again after the lane corrected one, with one standing",
    channel: "recovery",
    text: buildScheduleParityAllClear(
      classifyParitySweep({
        total: 102,
        compared: 101,
        runUrl: "https://github.com/x/y",
        findings: [{ verdict: "no-calcom-schedule", count: 1, agents: ["jsaminu@"] }],
        corrected: { count: 1, agents: ["dshearer@"] },
      }),
    ),
  },
  {
    // The ordinary morning, at the counts of 2026-10-21: every bookable agent
    // compared, some keeping their own hours, and staff and an outside host
    // expected to differ. It read "95 of 160 compared" and called all 21 standing
    // agents weekless; each group is now said for what it is.
    key: "schedule_parity_drift",
    state: "they agree again with own hours and expected hosts standing",
    channel: "recovery",
    text: buildScheduleParityAllClear(
      classifyParitySweep({
        total: 160,
        compared: 95,
        runUrl: "https://github.com/x/y",
        findings: [
          { verdict: "hours-set-by-agent", count: 10, agents: ["jsullivan@"] },
          { verdict: "staff-not-bookable", count: 10, agents: ["cfrank@"] },
          { verdict: "known-not-in-slate", count: 1, agents: ["ops@"] },
        ],
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
  // #2476: main merged and not live. The three endings read differently on purpose:
  // one names a run to re-run, one sends the reader to a deploy job that reported
  // success, and the third admits it does not recognise the ending.
  {
    key: "main_not_deployed",
    state: "the last merge of a burst was cancelled and nothing followed it",
    channel: "alert",
    text: formatDeployNotLiveAlert({
      reason: "cancelled",
      tipSha: "56f16b8b1c2d3e4f5061728394a5b6c7d8e9f001",
      servedCommit: "d5ca0d1e4f60",
      behindMs: 95 * 60_000,
      runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000001",
    }),
  },
  {
    key: "main_not_deployed",
    state: "the run reported success and the commit still is not being served",
    channel: "alert",
    text: formatDeployNotLiveAlert({
      reason: "succeeded",
      tipSha: "56f16b8b1c2d3e4f5061728394a5b6c7d8e9f001",
      servedCommit: "d5ca0d1e4f60",
      behindMs: 40 * 60_000,
      runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000002",
    }),
  },
  {
    key: "main_not_deployed",
    state: "an ending this check does not recognise",
    channel: "alert",
    text: formatDeployNotLiveAlert({
      reason: "unknown",
      tipSha: "56f16b8b1c2d3e4f5061728394a5b6c7d8e9f001",
      servedCommit: "d5ca0d1e4f60",
      behindMs: 6 * 60 * 60_000,
      runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000003",
    }),
  },
  // #3648: a merge GitHub never started a CI run for, so there is no run to link.
  {
    key: "main_not_deployed",
    state: "GitHub never started a CI run for main's tip",
    channel: "alert",
    text: formatDeployNotLiveAlert({
      reason: "no-run",
      tipSha: "56f16b8b1c2d3e4f5061728394a5b6c7d8e9f001",
      servedCommit: "d5ca0d1e4f60",
      behindMs: 50 * 60_000,
      runUrl: null,
    }),
  },
  {
    key: "main_not_deployed",
    state: "the tip is live again",
    channel: "recovery",
    text: formatDeployLiveRecovery("56f16b8b1c2d3e4f5061728394a5b6c7d8e9f001"),
  },
  // #2229: a run GitHub refused to start. One state, because the reader's next move
  // is the same whatever refused it, and the message says so rather than naming a
  // cause the check never measured. Since #3802 it also names the smoke canary lanes it
  // explains (from `ALERT_FOLDS`), whose own pages wait while it is open, and the
  // all-clear says each gets its own bound before it may page.
  {
    key: "ci_runs_refused",
    state: "the newest run's jobs executed nothing",
    channel: "alert",
    text: formatCiRefusedAlert({
      runName: "CI",
      runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000004",
    }),
  },
  {
    key: "ci_runs_refused",
    state: "jobs are starting again",
    channel: "recovery",
    text: formatCiStartedRecovery(),
  },
  // #3801: an unchanged condition is said again once a day (hourly when urgent) under
  // a first line saying it is a reminder and how long it has lasted, so it can be told
  // from a new problem. Shown on the alert the issue measured repeating ten times in
  // one night, and once with an unknown start, which says "at least".
  {
    key: "ci_runs_refused",
    state: "the 24 hour reminder, nothing changed",
    channel: "alert",
    text: formatReminder(
      formatCiRefusedAlert({ runName: "CI", runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000071" }),
      { sinceMs: PREVIEW_REMINDER_OPENED_MS, atLeast: false },
      PREVIEW_REMINDER_OPENED_MS + 24 * 60 * 60_000,
    ),
  },
  {
    key: "coverage_needs_human",
    state: "the reminder for a condition open before #3801 (its start unknown)",
    channel: "alert",
    text: formatReminder(
      formatCoverageNeedsHumanAlert([
        { userId: "u1", name: "Dana Ruiz", email: "dana.ruiz@example.com", unplaceable: 1, failed: 0 },
      ]),
      { sinceMs: PREVIEW_REMINDER_OPENED_MS, atLeast: true },
      PREVIEW_REMINDER_OPENED_MS + 3 * 24 * 60 * 60_000,
    ),
  },
  // #3801: the smoke canary's failure, now posted by the Worker on the workflow's
  // behalf through the alert throttle. Built by the alerter's own builder, so this is
  // exactly what either the Worker or the workflow's direct fallback posts.
  {
    key: "smoke_canary_failed:*",
    state: "the health check failed one check",
    channel: "alert",
    text: buildSmokeFailureMessage({
      mode: "dry",
      runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000090",
      failures: {
        kind: "failures",
        lines: ["FAIL: availability read median 4210ms, over the 2000ms budget"],
      },
    }),
  },
  {
    key: "smoke_canary_failed:*",
    state: "the full pass recorded nothing at all",
    channel: "alert",
    text: buildSmokeFailureMessage({
      mode: "full",
      runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000091",
      failures: { kind: "none" },
    }),
  },
  // #4062: a crash is recorded, with the checks that passed before it, so the alert
  // no longer claims a run that crashed midway never started (run 39694932888).
  {
    key: "smoke_canary_failed:*",
    state: "the full pass crashed after some checks passed",
    channel: "alert",
    text: buildSmokeFailureMessage({
      mode: "full",
      runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000092",
      failures: {
        kind: "crashed",
        passed: 4,
        crashes: [{ where: "The reschedule smoke", reason: "the connection timed out", passedBefore: 4 }],
      },
    }),
  },
  {
    key: "smoke_canary_failed:*",
    state: "the full pass crashed and left a booking behind",
    channel: "alert",
    text: buildSmokeFailureMessage({
      mode: "full",
      runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000093",
      failures: {
        kind: "failures",
        lines: ["teardown: booking 98c0e697 left active, cancel it by hand (the connection timed out)"],
        passed: 5,
        crashes: [{ where: "The reschedule smoke", reason: "the connection timed out", passedBefore: 5 }],
      },
    }),
  },
  {
    key: "smoke_canary_failed:*",
    state: "the full pass stopped after passing checks, recording no failure",
    channel: "alert",
    text: buildSmokeFailureMessage({
      mode: "full",
      runUrl: "https://github.com/Try-Pennie/slate/actions/runs/35200000094",
      failures: { kind: "stopped", passed: 12 },
    }),
  },
  {
    key: "smoke_canary_failed:*",
    state: "the health check is passing again",
    channel: "recovery",
    text: formatSmokeCanaryRecovery("dry"),
  },
  {
    key: "smoke_canary_failed:*",
    state: "the full pass is passing again",
    channel: "recovery",
    text: formatSmokeCanaryRecovery("full"),
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
    key: "cron_budget_headroom",
    state: "the every minute schedule had a tick past half its CPU ceiling",
    channel: "alert",
    text: formatCronCpuAlert({
      status: "over",
      over: [{ cron: "* * * * *", invocations: 1440, maxCpuMs: 64_250, p99CpuMs: 41_800 }],
      crons: [
        { cron: "* * * * *", invocations: 1440, maxCpuMs: 64_250, p99CpuMs: 41_800 },
        { cron: "*/5 * * * *", invocations: 288, maxCpuMs: 21_400, p99CpuMs: 18_000 },
      ],
      invocations: 1728,
      unreadable: 0,
      sampled: false,
    }),
  },
  {
    key: "cron_budget_headroom",
    state: "two schedules past the line, and one tick with no readable CPU",
    channel: "alert",
    // Read this one for the plural grammar and for how an unreadable row is named rather
    // than scored as a cheap tick.
    text: formatCronCpuAlert({
      status: "over",
      over: [
        { cron: "* * * * *", invocations: 1440, maxCpuMs: 64_250, p99CpuMs: 41_800 },
        { cron: "*/5 * * * *", invocations: 288, maxCpuMs: 61_000, p99CpuMs: 30_500 },
      ],
      crons: [
        { cron: "* * * * *", invocations: 1440, maxCpuMs: 64_250, p99CpuMs: 41_800 },
        { cron: "*/5 * * * *", invocations: 288, maxCpuMs: 61_000, p99CpuMs: 30_500 },
      ],
      invocations: 1729,
      unreadable: 1,
      sampled: false,
    }),
  },
  {
    key: "cron_budget_headroom",
    state: "a measured day with every schedule under the line",
    channel: "recovery",
    text: formatCronCpuRecovery({
      status: "within",
      crons: [
        { cron: "* * * * *", invocations: 1440, maxCpuMs: 44_700, p99CpuMs: 30_100 },
        { cron: "*/5 * * * *", invocations: 288, maxCpuMs: 21_400, p99CpuMs: 18_000 },
      ],
      invocations: 1728,
      sampled: false,
    }),
  },
  {
    key: "cron_budget_headroom",
    state: "a measured day under the line, which the logs sampled",
    channel: "recovery",
    text: formatCronCpuRecovery({
      status: "within",
      crons: [
        { cron: "0 * * * *", invocations: 24, maxCpuMs: 523, p99CpuMs: 523 },
        { cron: "* * * * *", invocations: 1438, maxCpuMs: 268, p99CpuMs: 8 },
      ],
      invocations: 1462,
      sampled: true,
    }),
  },
  {
    key: "cron_cpu_not_configured",
    state: "the Worker has no CF_ANALYTICS_TOKEN",
    channel: "info",
    text: formatCronCpuNotConfigured(),
  },
  {
    key: "definer_grants_to_web_roles",
    state: "one privileged function is open to an unauthenticated caller",
    channel: "alert",
    text: formatDefinerGrantsExposedAlert({
      status: "exposed",
      scanned: 13,
      exposed: [
        { name: "erase_booking_pii", args: "target_email text", returns: "jsonb", roles: ["anon"] },
      ],
      exempted: ["rls_auto_enable"],
      unusedExemptions: [],
    }),
  },
  {
    key: "definer_grants_to_web_roles",
    state: "several, and one of them is open to both web roles",
    channel: "alert",
    // Read this one for the plural grammar and for whether a list of function signatures
    // still scans on a phone.
    text: formatDefinerGrantsExposedAlert({
      status: "exposed",
      scanned: 13,
      exposed: [
        { name: "erase_booking_pii", args: "target_email text", returns: "jsonb", roles: ["anon", "authenticated"] },
        { name: "reassign_booking_swap", args: "p_booking_id uuid, p_user_id uuid", returns: "record", roles: ["authenticated"] },
      ],
      exempted: ["rls_auto_enable"],
      unusedExemptions: [],
    }),
  },
  {
    key: "definer_grants_to_web_roles",
    state: "cleared",
    channel: "recovery",
    text: formatDefinerGrantsClearedAlert({
      status: "healthy",
      scanned: 13,
      exempted: ["rls_auto_enable"],
      unusedExemptions: [],
    }),
  },
  {
    key: "auth_sign_in_beyond_google",
    state: "email sign in is on, as production stood on 2026-10-03",
    channel: "alert",
    text: formatAuthSignInOpenAlert({
      status: "open",
      emailOn: true,
      signupProviders: [],
      samlSignup: false,
      providersOn: ["email", "google"],
    }),
  },
  {
    key: "auth_sign_in_beyond_google",
    state: "email, two other providers and SAML at once",
    channel: "alert",
    // Read this one for the list grammar and for whether four lines still scan on a phone.
    text: formatAuthSignInOpenAlert({
      status: "open",
      emailOn: true,
      signupProviders: ["anonymous_users", "phone"],
      samlSignup: true,
      providersOn: ["anonymous_users", "email", "google", "phone"],
    }),
  },
  {
    key: "auth_sign_in_beyond_google",
    state: "cleared",
    channel: "recovery",
    text: formatAuthSignInClearedAlert({ status: "healthy", providersOn: ["google"] }),
  },
  {
    key: "audit_log_chain_broken",
    state: "a row's content was edited",
    channel: "alert",
    text: formatAuditChainBrokenAlert({ kind: "altered", seq: 4812, id: "5b1d0c3e-8f2a-4c6b-9d7e-1a2b3c4d5e6f" }),
  },
  {
    key: "audit_log_chain_broken",
    state: "a row was deleted from the middle",
    channel: "alert",
    text: formatAuditChainBrokenAlert({ kind: "missing", expectedSeq: 4812, foundSeq: 4813, id: "5b1d0c3e-8f2a-4c6b-9d7e-1a2b3c4d5e6f" }),
  },
  {
    key: "audit_log_chain_broken",
    state: "an edit with every later hash recomputed",
    channel: "alert",
    text: formatAuditChainBrokenAlert({ kind: "rewritten", seq: 5120, id: "5b1d0c3e-8f2a-4c6b-9d7e-1a2b3c4d5e6f" }),
  },
  {
    key: "audit_log_chain_broken",
    state: "rows cut off the end",
    channel: "alert",
    text: formatAuditChainBrokenAlert({ kind: "truncated", anchorSeq: 5120, lastSeq: 5098 }),
  },
  {
    key: "audit_log_chain_broken",
    state: "cleared",
    channel: "recovery",
    text: formatAuditChainRecovery(5120),
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
  // --- the whole roster filling up against the Team capacity line (#2590)
  {
    key: "roster_filling_up",
    state: "88% booked over the next two days against an 85% line",
    channel: "alert",
    text: formatRosterFillAlert(PREVIEW_ROSTER_FILL, PREVIEW_APP_URL),
  },
  {
    key: "roster_filling_up",
    state: "the tiers could not be read, two advisors not syncing",
    channel: "alert",
    text: formatRosterFillAlert({ ...PREVIEW_ROSTER_FILL, tiers: null, notCounted: 2 }, PREVIEW_APP_URL),
  },
  {
    key: "roster_filling_up",
    state: "back under the line",
    channel: "recovery",
    text: formatRosterFillRecovery({ ...PREVIEW_ROSTER_FILL, open: 66, bookedPct: 80, over: false, band: 0 }, PREVIEW_APP_URL),
  },
  // --- a debt tier nearly full over the days the booker shows (#1256, #3559, #3637)
  {
    key: "pool_nearly_full",
    state: "one debt tier with five starts left across the three days",
    channel: "info",
    text: formatPoolNearlyFullNotice(
      [{ label: "Low", codes: ["111", "112", "120", "130"], open: 5, capacity: 148, days: PREVIEW_TIER_DAYS }],
      0.1,
    ),
  },
  {
    key: "pool_nearly_full",
    state: "two debt tiers, one full, at a 20% line",
    channel: "info",
    text: formatPoolNearlyFullNotice(
      [
        { label: "Very High", codes: ["411", "421", "431"], open: 0, capacity: 18, days: PREVIEW_TIER_DAYS },
        { label: "Medium", codes: ["211", "221", "231"], open: 1, capacity: 14, days: PREVIEW_TIER_DAYS },
      ],
      0.2,
    ),
  },
  {
    key: "thin_tier_staffing",
    state: "a tier is resting on one agent",
    channel: "info",
    // #2505: a DEBT TIER, not a pool and not a code. A thin pool inside a staffed
    // tier strands nobody, so the whisper counts the five tiers and the per pool
    // depth stays on /admin/tiers.
    text: formatThinTierNotice([
      {
        tier: "5",
        name: "Ultra High",
        depth: 1,
        effectiveDepth: 1,
        outCount: 0,
        soleAgentName: "Jordan Reyes",
        flag: "spof" as const,
        effectiveFlag: "spof" as const,
      },
      {
        tier: "3",
        name: "High",
        depth: 2,
        effectiveDepth: 1,
        outCount: 1,
        soleAgentName: null,
        flag: "thin" as const,
        effectiveFlag: "spof" as const,
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
  // --- a lane that ran and failed on its tick (#3133) -------------------------
  {
    key: "cron_lane_failed:*",
    state: "the lane threw",
    channel: "alert",
    text: formatLaneFailureAlert(
      { lane: "outbox", status: null, reason: "Worker exceeded CPU time limit" },
      "0f1e2d3c4b5a6978",
    ),
  },
  {
    key: "cron_lane_failed:*",
    state: "the lane answered non-ok",
    channel: "alert",
    text: formatLaneFailureAlert(
      { lane: "sync", status: 500, reason: "answered 500" },
      "0f1e2d3c4b5a6978",
    ),
  },
  {
    key: "cron_lane_failed:*",
    state: "no tick id reached the route",
    channel: "alert",
    text: formatLaneFailureAlert({ lane: "bulk_reassign", status: 503, reason: "answered 503" }, null),
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
      { lane: "smoke-canary-full", ageMs: 4 * 60 * 60_000, maxStaleMs: 3 * 60 * 60_000, unreadable: false },
      180,
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
    // #2875: not a recovery. The lane will never stamp again, so the page ends by
    // saying cal.com was retired, never that the comparison is running again.
    key: "cron_lane_stale:*",
    state: "the daily cal.com comparison ended because cal.com was retired",
    channel: "recovery",
    text: calcomLaneRetiredText("schedule-parity"),
  },
  {
    key: "cron_lane_stale:*",
    state: "the weekly routing replay ended because cal.com was retired",
    channel: "recovery",
    text: calcomLaneRetiredText("router-replay"),
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
  // #2543: the same key again, for the two daily time off lanes. Four stamps, and
  // the pair per lane is the point: a reader has to be able to tell the cron not
  // firing from the route firing and throwing, because those send them to two
  // different places.
  {
    key: "cron_lane_stale:*",
    state: "the time off approvals cron has stopped firing",
    channel: "alert",
    text: timeOffLaneAlertText({
      lane: "ooo-approvals",
      ageMs: 40 * 60 * 60_000,
      maxStaleMs: TIME_OFF_STALE_BOUNDS_MS["ooo-approvals"]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "the approvals report itself has not gone out",
    channel: "alert",
    text: timeOffLaneAlertText({
      lane: "ooo-approvals-report",
      ageMs: 55 * 60 * 60_000,
      maxStaleMs: TIME_OFF_STALE_BOUNDS_MS["ooo-approvals-report"]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "no manager has been nudged since the weekend",
    channel: "alert",
    text: timeOffLaneAlertText({
      lane: "ooo-digest-nudge",
      ageMs: 5 * 24 * 60 * 60_000,
      maxStaleMs: TIME_OFF_STALE_BOUNDS_MS["ooo-digest-nudge"]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "a time off lane has never once run",
    channel: "alert",
    text: timeOffLaneAlertText({
      lane: "ooo-digest",
      ageMs: Infinity,
      maxStaleMs: TIME_OFF_STALE_BOUNDS_MS["ooo-digest"]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "a time off lane's last-run record cannot be read",
    channel: "alert",
    text: timeOffLaneAlertText({
      lane: "ooo-approvals-report",
      ageMs: NOW_MS,
      maxStaleMs: TIME_OFF_STALE_BOUNDS_MS["ooo-approvals-report"]!,
      unreadable: true,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "a time off lane recovered",
    channel: "recovery",
    text: timeOffRecoveryText("ooo-approvals-report"),
  },
  // #1228: the same key again, for noodge's keyed checks of Slate. Three pages,
  // because each sends the reader somewhere different: a check that stopped, a
  // check that never once arrived (which is also what a deployment with no key
  // looks like), and a record that cannot be read.
  {
    key: "cron_lane_stale:*",
    state: "noodge's /api/health check has stopped reaching Slate",
    channel: "alert",
    text: uptimeAlertText({
      lane: "uptime:api-health",
      ageMs: 40 * 60_000,
      maxStaleMs: UPTIME_STALE_BOUNDS_MS["uptime:api-health"]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "noodge's availability check has never reached Slate with the key",
    channel: "alert",
    text: uptimeAlertText({
      lane: "uptime:availability-canary",
      ageMs: Infinity,
      maxStaleMs: UPTIME_STALE_BOUNDS_MS["uptime:availability-canary"]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "an uptime check's last heartbeat record cannot be read",
    channel: "alert",
    text: uptimeAlertText({
      lane: "uptime:api-health",
      ageMs: NOW_MS,
      maxStaleMs: UPTIME_STALE_BOUNDS_MS["uptime:api-health"]!,
      unreadable: true,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "noodge's check is reaching Slate again",
    channel: "recovery",
    text: uptimeRecoveryText("uptime:availability-canary"),
  },
  // #3076: the same key again, for the daily off platform database dump. Three
  // pages, because each sends the reader somewhere different: a dump that stopped,
  // one that has never landed (which is also what missing R2 secrets look like),
  // and a record that cannot be read.
  {
    key: "cron_lane_stale:*",
    state: "the newest off platform database backup is too old",
    channel: "alert",
    text: backupAlertText({
      lane: "db-backup",
      ageMs: 30 * 60 * 60_000,
      maxStaleMs: BACKUP_STALE_BOUNDS_MS["db-backup"]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "no off platform database backup has ever landed",
    channel: "alert",
    text: backupAlertText({
      lane: "db-backup",
      ageMs: Infinity,
      maxStaleMs: BACKUP_STALE_BOUNDS_MS["db-backup"]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "the database backup's last-run record cannot be read",
    channel: "alert",
    text: backupAlertText({
      lane: "db-backup",
      ageMs: NOW_MS,
      maxStaleMs: BACKUP_STALE_BOUNDS_MS["db-backup"]!,
      unreadable: true,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "a fresh database backup landed again",
    channel: "recovery",
    text: backupRecoveryText("db-backup"),
  },
  // #3182: the same key again, for the log shipping receipt. Three pages, because a
  // pipe that stopped, one that never started (which is also what a tail worker not
  // redeployed with its binding looks like) and an unreadable record each send the
  // reader somewhere different.
  {
    key: "cron_lane_stale:*",
    state: "logs have stopped being confirmed in Better Stack",
    channel: "alert",
    text: logShippingAlertText({
      lane: LOG_SHIPPING_LANE,
      ageMs: 40 * 60_000,
      maxStaleMs: LOG_SHIPPING_STALE_BOUNDS_MS[LOG_SHIPPING_LANE]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "logs have never been confirmed in Better Stack",
    channel: "alert",
    text: logShippingAlertText({
      lane: LOG_SHIPPING_LANE,
      ageMs: Infinity,
      maxStaleMs: LOG_SHIPPING_STALE_BOUNDS_MS[LOG_SHIPPING_LANE]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "the log shipping receipt's record cannot be read",
    channel: "alert",
    text: logShippingAlertText({
      lane: LOG_SHIPPING_LANE,
      ageMs: NOW_MS,
      maxStaleMs: LOG_SHIPPING_STALE_BOUNDS_MS[LOG_SHIPPING_LANE]!,
      unreadable: true,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "logs are reaching Better Stack again",
    channel: "recovery",
    text: logShippingRecoveryText(LOG_SHIPPING_LANE),
  },
  // #3460: the same key, for the pool grouping publish. A publish that stopped, one that
  // never landed, and an unreadable record each send the reader somewhere different.
  {
    key: "cron_lane_stale:*",
    state: "the pool grouping has stopped being published",
    channel: "alert",
    text: poolGroupingAlertText({
      lane: POOL_GROUPING_LANE,
      ageMs: 25 * 60_000,
      maxStaleMs: POOL_GROUPING_STALE_BOUNDS_MS[POOL_GROUPING_LANE]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "the pool grouping has never been published",
    channel: "alert",
    text: poolGroupingAlertText({
      lane: POOL_GROUPING_LANE,
      ageMs: Infinity,
      maxStaleMs: POOL_GROUPING_STALE_BOUNDS_MS[POOL_GROUPING_LANE]!,
      unreadable: false,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "the pool grouping publish record cannot be read",
    channel: "alert",
    text: poolGroupingAlertText({
      lane: POOL_GROUPING_LANE,
      ageMs: NOW_MS,
      maxStaleMs: POOL_GROUPING_STALE_BOUNDS_MS[POOL_GROUPING_LANE]!,
      unreadable: true,
    }),
  },
  {
    key: "cron_lane_stale:*",
    state: "the pool grouping is being published again",
    channel: "recovery",
    text: poolGroupingRecoveryText(POOL_GROUPING_LANE),
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
  // #2382: the dead man's switch's own blindness. It is a contained step on the
  // monitor lane, so a watchdog that threw used to leave a fresh heartbeat behind it.
  {
    key: "cron_lane_stale:*",
    state: "the lane watchdog has stopped judging the lanes",
    channel: "alert",
    text: verdictBlindAlertText({
      lane: "verdict:lane-watchdog",
      ageMs: 9 * 60 * 60_000,
      maxStaleMs: VERDICT_STALE_BOUNDS_MS["verdict:lane-watchdog"],
      unreadable: false,
    }),
  },
  // #2392: the burst counter proof, the one detector in this family whose verdict
  // is stamped by a GitHub workflow rather than by the monitor lane, so its page has
  // to send the reader somewhere none of the others do.
  {
    key: "cron_lane_stale:*",
    state: "the burst counter proof has stopped concluding",
    channel: "alert",
    text: verdictBlindAlertText({
      lane: "verdict:burst-counter",
      ageMs: 3 * 24 * 60 * 60_000,
      maxStaleMs: VERDICT_STALE_BOUNDS_MS["verdict:burst-counter"],
      unreadable: false,
    }),
  },
  // #2493: the kill switch proof, the second detector stamped by a GitHub workflow.
  // Previewed in the NEVER concluded state rather than the merely stale one, because
  // that is the state the issue describes: the command had run exactly once, by hand.
  {
    key: "cron_lane_stale:*",
    state: "the kill switch proof has never once concluded",
    channel: "alert",
    text: verdictBlindAlertText({
      lane: "verdict:kill-switch",
      ageMs: Infinity,
      maxStaleMs: VERDICT_STALE_BOUNDS_MS["verdict:kill-switch"],
      unreadable: false,
    }),
  },
  // #3340: the shared confirm line proof, stamped by its own step of the burst counter's
  // workflow. Previewed never concluded, the state it ships in until its first daily run.
  {
    key: "cron_lane_stale:*",
    state: "the shared confirm line proof has never once concluded",
    channel: "alert",
    text: verdictBlindAlertText({
      lane: "verdict:confirm-line",
      ageMs: Infinity,
      maxStaleMs: VERDICT_STALE_BOUNDS_MS["verdict:confirm-line"],
      unreadable: false,
    }),
  },
  // #1700: the canary's latency check, the third detector stamped by a GitHub workflow.
  {
    key: "cron_lane_stale:*",
    state: "the canary latency check has stopped measuring",
    channel: "alert",
    text: verdictBlindAlertText({
      lane: "verdict:availability-latency",
      ageMs: 8 * 60 * 60_000,
      maxStaleMs: VERDICT_STALE_BOUNDS_MS["verdict:availability-latency"],
      unreadable: false,
    }),
  },
  // #2798: the five gated checks that answered a failed read with a status of
  // their own. Each gets its own page because each sends a reader to a different
  // log line, and the whole point is that the page names what went blind.
  ...(
    [
      ["verdict:availability-scan", "the availability scan has stopped concluding"],
      ["verdict:calendar-window", "the calendar window check has stopped concluding"],
      ["verdict:busy-drift", "the busy drift sampler has stopped concluding"],
      ["verdict:offsite-origin", "the off site origin check has stopped concluding"],
      ["verdict:auth-sign-in", "the auth sign in settings check has stopped concluding"],
      ["verdict:awaiting-activation", "the waiting to become bookable check has stopped concluding"],
      ["verdict:regal-call-feed", "the Regal feed checks have stopped concluding"],
      ["verdict:regal-call-outcomes", "the Regal call outcome check has stopped concluding"],
    ] as const
  ).map(([lane, state]) => ({
    key: "cron_lane_stale:*",
    state,
    channel: "alert" as const,
    text: verdictBlindAlertText({
      lane,
      ageMs: 7 * 60 * 60_000,
      maxStaleMs: VERDICT_STALE_BOUNDS_MS[lane],
      unreadable: false,
    }),
  })),
  // --- a contained monitor step that keeps failing (#2382) -------------------
  //
  // Two states, because the wider half of the fault is what a failed SETUP read
  // takes down with it, and that sentence only appears on those five steps.
  {
    key: "monitor_step_failing:*",
    state: "an ordinary check has thrown on every tick",
    channel: "alert",
    text: monitorStepFailingAlert({
      step: "inactive_bookings",
      ticks: MONITOR_STEP_FAILING_TICKS,
      reason: "column bookings.agent_id does not exist",
      gated: [],
    }),
  },
  {
    key: "monitor_step_failing:*",
    state: "a shared setup read has thrown on every tick, standing other checks down",
    channel: "alert",
    text: monitorStepFailingAlert({
      step: "setup_business_hours",
      ticks: MONITOR_STEP_FAILING_TICKS,
      reason: "503 upstream connect error",
      gated: checksGatedByStep("setup_business_hours"),
    }),
  },
  {
    key: "monitor_step_failing:*",
    state: "the tick recorded no reason for the failure",
    channel: "alert",
    text: monitorStepFailingAlert({
      step: "lane_watchdog",
      ticks: MONITOR_STEP_FAILING_TICKS,
      reason: null,
      gated: [],
    }),
  },
  {
    key: "monitor_step_failing:*",
    state: "the step is completing again",
    channel: "recovery",
    text: monitorStepRecoveryText("inactive_bookings", MONITOR_STEP_REARM_TICKS),
  },
  // #3955: a step that works once an hour is counted in its own runs, so its page
  // and all clear say runs and hours rather than five minute ticks.
  {
    key: "monitor_step_failing:*",
    state: "an hourly check has thrown on every one of its runs",
    channel: "alert",
    text: monitorStepFailingAlert({
      step: "cross_system_bookings",
      ticks: stepFailingRuns("cross_system_bookings"),
      reason: "Invalid time value",
      gated: [],
    }),
  },
  {
    key: "monitor_step_failing:*",
    state: "an hourly check is completing again",
    channel: "recovery",
    text: monitorStepRecoveryText("cross_system_bookings", stepRearmRuns("cross_system_bookings")),
  },
  // #1561: the third thing that can be true of a detector. Not blind by fault and
  // not measuring, but deliberately switched off, which needs its own voice: the
  // whisper must not read as an incident, and the page must not read as a fault.
  {
    key: "detector_parked",
    state: "the checks that cannot conclude before cutover",
    channel: "info",
    // Rendered from the shipped registry while anything is parked. Since #2513
    // nothing is, and the watchdog sends no whisper for an empty list, so the
    // preview shows the shape a park takes through an example entry rather than
    // rendering "0 monitoring checks are parked", a message nobody can receive.
    text:
      Object.keys(PARKED_VERDICT_DETECTORS).length > 0
        ? verdictParkedInfoText(Object.keys(PARKED_VERDICT_DETECTORS))
        : verdictParkedInfoText([FAILURE_RATE_VERDICT_LANE], {
            [FAILURE_RATE_VERDICT_LANE]: {
              reason: "no real lead has booked yet, so it never sees enough attempts to judge",
              issue: 2513,
              unparkWithinMs: 4 * 60 * 60_000,
            },
          }),
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
  // The REAL builder and the REAL short reason, fed the errors `sendGmailEmail`
  // throws, never a copy of either's wording (L41): a preview showing text that is
  // not what ships would be worse than no preview. One state per disposition, since
  // each says something different about whether the lead will still be reminded
  // (2026-10-05), and the two that depend on the outcome once per outcome, since a
  // rate limited send reached Gmail and must never read as "nothing reached Gmail".
  // A send that did not go out with the call far enough away pages nobody, so it has
  // no state here.
  ...([
    {
      state: "too late to try again: the token mint timed out and the call is within the hour",
      disposition: "too_late",
      err: new EmailSendError("google token mint did not answer within 8000ms", {
        outcome: "never_sent",
        stage: "token",
        transient: true,
        cause: new DeadlineExceededError("google token mint", 8000),
      }),
    },
    {
      state: "too late to try again: Gmail rate limited it and the call is within the hour",
      disposition: "too_late",
      err: new EmailSendError("Gmail send failed: 429 rateLimitExceeded", {
        outcome: "refused",
        stage: "post",
        status: 429,
        transient: true,
      }),
    },
    {
      state: "refused, and not resent until the mailbox delegation is repaired",
      disposition: "refused",
      err: new EmailSendError("Gmail token unavailable: 401 unauthorized_client", {
        outcome: "never_sent",
        stage: "token",
        status: 401,
        reason: "unauthorized_client",
        transient: false,
      }),
    },
    {
      state: "Slate could not build the message, so Google never saw it",
      disposition: "not_built",
      err: new EmailSendError("MIME build failed: attachment content is not base64", {
        outcome: "never_sent",
        stage: "compose",
        transient: false,
      }),
    },
    {
      state: "may have gone out, so it is not resent",
      disposition: "unknown",
      err: new EmailSendError('Gmail send failed: 503 {"error":{"errors":[{"reason":"backendError"}]}}', {
        outcome: "unknown",
        stage: "post",
        status: 503,
        transient: true,
      }),
    },
    {
      state: "a retry was due after a mint timeout and the hand back could not be confirmed",
      disposition: "not_released",
      err: new EmailSendError("google token mint did not answer within 8000ms", {
        outcome: "never_sent",
        stage: "token",
        transient: true,
        cause: new DeadlineExceededError("google token mint", 8000),
      }),
    },
    {
      state: "a retry was due after a rate limit and the hand back could not be confirmed",
      disposition: "not_released",
      err: new EmailSendError("Gmail send failed: 429 rateLimitExceeded", {
        outcome: "refused",
        stage: "post",
        status: 429,
        transient: true,
      }),
    },
  ] as const).map(({ state, disposition, err }) => ({
    key: "booking_reminder_failed:*",
    state,
    channel: "alert" as const,
    text: reminderFailedAlert("b7f1c2e4-9a3d-4c88-b0f2-15ac7d9e6431", disposition, shortErrorReason(err), err.outcome),
  })),
  {
    key: "booking_reminder_failed:*",
    state: "more lost reminders in one run than are paged by name",
    channel: "alert",
    text: reminderFoldedAlert([
      "c2d8e1f0-4b7a-4e19-9c3d-7f1a2b6e8d40",
      "e9a4b7c1-2f6d-4a83-b5e0-3c8d1f7a9b62",
    ]),
  },
  // #2496. The one above and the three below are the whole point of the issue: they
  // are the same fault at two very different sizes, and they have to READ that way
  // side by side or the second says nothing the first did not.
  {
    key: "booking_reminders_failing",
    state: "every reminder in the window failing, with a repair to name",
    channel: "alert",
    text: formatReminderFailureRateAlert({
      attempts: 24,
      failures: 24,
      pct: 100,
      windowMinutes: 240,
      topCodes: [{ code: "not_authorised", count: 24 }],
    }),
  },
  {
    key: "booking_reminders_failing",
    state: "most of the failures did not go out and were handed back to be retried",
    channel: "alert",
    text: formatReminderFailureRateAlert({
      attempts: 30,
      failures: 15,
      retrying: 12,
      pct: 50,
      windowMinutes: 240,
      topCodes: [
        { code: "token_unavailable", count: 12 },
        { code: "provider_unavailable", count: 3 },
      ],
    }),
  },
  {
    key: "booking_reminders_failing",
    state: "a share of them failing, on a code with no canned advice",
    channel: "alert",
    text: formatReminderFailureRateAlert({
      attempts: 31,
      failures: 9,
      pct: 29,
      windowMinutes: 240,
      topCodes: [
        { code: "unclassified", count: 6 },
        { code: "provider_unavailable", count: 3 },
      ],
    }),
  },
  {
    key: "booking_reminders_failing",
    state: "the wave is over",
    channel: "recovery",
    text: formatReminderFailureRateAllClear({
      attempts: 46,
      failures: 0,
      pct: 0,
      windowMinutes: 240,
    }),
  },
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
    state: "a move refused because the confirm's budget was already spent",
    channel: "alert",
    text: busyBlockWriteThroughAlert(
      "move",
      "bk_8f21c4",
      shortFailureReason(
        "DeadlineExceededError: supabase did not answer within 0ms, when the booking confirm ran out of its 12000ms",
      ) ?? "no detail",
    ),
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
    key: "pending_event_deletions_refused",
    state: "one deletion ended, the account never given Calendar",
    channel: "alert",
    text: pendingDeletionRefusedAlert([
      { calendarEmail: "new.hire@trypennie.com", eventId: "evt_4c1", kind: "not-provisioned" },
    ]),
  },
  {
    key: "pending_event_deletions_refused",
    state: "several deletions ended across both kinds, one calendar over the id cap",
    channel: "alert",
    text: pendingDeletionRefusedAlert([
      { calendarEmail: "new.hire@trypennie.com", eventId: "evt_4c1", kind: "not-provisioned" },
      { calendarEmail: "left.agent@trypennie.com", eventId: "evt_4d2", kind: "gone" },
      { calendarEmail: "left.agent@trypennie.com", eventId: "evt_4d3", kind: "gone" },
      { calendarEmail: "left.agent@trypennie.com", eventId: "evt_4d4", kind: "gone" },
      { calendarEmail: "left.agent@trypennie.com", eventId: "evt_4d5", kind: "gone" },
      { calendarEmail: "revoked@trypennie.com", eventId: "evt_4e6", kind: "gone" },
    ]),
  },
  {
    key: "pending_event_deletions_refused",
    state: "a pass refusing one departed and one active calendar: the page names only the active one",
    channel: "alert",
    text: PREVIEW_REFUSED_MIX.page ?? "",
  },
  {
    key: "pending_event_deletions_refused",
    state: "who owns the calendar could not be read, so a departed advisor's refusal still pages",
    channel: "alert",
    text:
      refusedDeletionNotices(
        previewRefusedRows("left.agent@trypennie.com", "7a", [null, null]),
        null,
      ).page ?? "",
  },
  {
    key: "pending_event_deletions_departed",
    state: "one advisor left, one old invite, its call moved",
    channel: "info",
    text:
      refusedDeletionNotices(previewRefusedRows("left.agent@trypennie.com", "7a", [true]), PREVIEW_REFUSED_OWNERS)
        .departed ?? "",
  },
  {
    key: "pending_event_deletions_departed",
    state: "a pass refusing one departed and one active calendar: the departure half, four calls moved, over the id cap",
    channel: "info",
    text: PREVIEW_REFUSED_MIX.departed ?? "",
  },
  {
    key: "pending_event_deletions_departed",
    state: "one advisor left, some calls moved and one not",
    channel: "info",
    text:
      refusedDeletionNotices(
        previewRefusedRows("left.agent@trypennie.com", "7a", [true, true, false]),
        PREVIEW_REFUSED_OWNERS,
      ).departed ?? "",
  },
  {
    key: "pending_event_deletions_departed",
    state: "one advisor left and where the calls went could not be read, so no move is claimed",
    channel: "info",
    text:
      refusedDeletionNotices(
        previewRefusedRows("left.agent@trypennie.com", "7a", [null, null], "gone"),
        PREVIEW_REFUSED_OWNERS,
      ).departed ?? "",
  },
  {
    key: "pending_event_deletions_departed",
    state: "two advisors who left, in one pass",
    channel: "info",
    text:
      refusedDeletionNotices(
        [
          ...previewRefusedRows("left.agent@trypennie.com", "7a", [true, true]),
          ...previewRefusedRows("moved.on@trypennie.com", "8b", [false]),
        ],
        PREVIEW_REFUSED_OWNERS,
      ).departed ?? "",
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
    key: "reservation_created_owed",
    state: "committed bookings still owed booking.created past a day",
    channel: "alert",
    text: reservationCreatedOwedAlert(2, "rs_7, rs_8"),
  },
  {
    key: "reservation_created_owed",
    state: "every kept reservation was sent or removed",
    channel: "recovery",
    text: reservationCreatedOwedRecovery(),
  },
  {
    key: "reschedule_pin_dropped",
    state: "a move that never happened",
    channel: "alert",
    text: reschedulePinDroppedAlert(2),
  },
  {
    key: "reschedule_pin_dropped",
    state: "a move that never happened, its lead invite already moved and put back",
    channel: "alert",
    text: reschedulePinDroppedAlert(2, 1),
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
    key: "verify_on_book_outage",
    state: "a lost race's reservation rollback was refused (#3859)",
    channel: "alert",
    text: reservationRollbackAlert(),
  },
  {
    key: "verify_on_book_outage",
    state: "a dependency did not answer inside its deadline",
    channel: "alert",
    text: dependencyTimeoutAlert({ dependency: "google events.insert", timeoutMs: 8000, budget: null }),
  },
  {
    key: "verify_on_book_outage",
    state: "the request's budget ran out while a dependency was running",
    channel: "alert",
    text: dependencyTimeoutAlert({
      dependency: "supabase",
      timeoutMs: 3000,
      budget: { label: "the booking confirm", totalMs: 12_000 },
    }),
  },
  {
    key: "verify_on_book_outage",
    state: "the request's budget was spent before a dependency could start",
    channel: "alert",
    text: dependencyTimeoutAlert({
      dependency: "supabase",
      timeoutMs: 0,
      budget: { label: "the booking confirm", totalMs: 12_000 },
    }),
  },
  // #3663: the booking API's timeout path knows how far the request got, so a dry
  // run and a request whose body was never read are not worded as a lead's booking.
  {
    key: "verify_on_book_outage",
    state: "a real caller's dry run timed out on a dependency (#3663)",
    channel: "alert",
    text: dependencyTimeoutAlert({ dependency: "google token mint", timeoutMs: 8000, budget: null, reach: "dry-run" }),
  },
  {
    key: "verify_on_book_outage",
    state: "a request timed out before Slate read its body, budget spent (#3663)",
    channel: "alert",
    text: dependencyTimeoutAlert({
      dependency: "supabase",
      timeoutMs: 0,
      budget: { label: "the booking confirm", totalMs: 12_000 },
      reach: "before-body",
    }),
  },
  {
    key: "verify_on_book_outage",
    state: "too little budget left to write the booking, so nothing was started (#3338)",
    channel: "alert",
    text: dependencyTimeoutAlert({
      dependency: "writing the booking and its calendar event",
      timeoutMs: 3_900,
      budget: null,
      neededMs: 5_100,
    }),
  },
  {
    key: "verify_on_book_outage",
    state: "no budget left at all to write the booking (#3338)",
    channel: "alert",
    text: dependencyTimeoutAlert({
      dependency: "writing the booking and its calendar event",
      timeoutMs: 0,
      budget: null,
      neededMs: 5_100,
    }),
  },
  {
    key: "verify_on_book_outage",
    state: "a lost race left too little time to walk down the ladder (#3338)",
    channel: "alert",
    text: dependencyTimeoutAlert({
      dependency: "the tier below a lost race",
      timeoutMs: 3_900,
      budget: null,
      neededMs: 8_100,
    }),
  },
  {
    key: "reschedule_lock_outage",
    state: "the lock claim hit a DB error",
    channel: "alert",
    text: rescheduleLockOutageAlert(),
  },
  // #2377. Each signal's page and its all clear with and without a straggler. The
  // page states use the stage and refusal mixes a broken journey would produce.
  {
    key: "duplicate_cancel_unavailable",
    state: "a share of duplicate cancels answered 503, mostly at the check",
    channel: "alert",
    text: formatDuplicateCancelUnavailablePage(
      {
        calls: 64,
        count: 22,
        pct: 34,
        byName: { duplicate_cancel_unavailable_rpc: 19, duplicate_cancel_unavailable_handoff: 3 },
      },
      24,
    ),
  },
  {
    key: "duplicate_cancel_unavailable",
    state: "six measured hours with none failing",
    channel: "recovery",
    text: formatDuplicateCancelUnavailableAllClear({ calls: 18, count: 0 }, 6),
  },
  {
    key: "duplicate_cancel_unavailable",
    state: "six measured hours with one failing",
    channel: "recovery",
    text: formatDuplicateCancelUnavailableAllClear({ calls: 40, count: 1 }, 6),
  },
  {
    key: "duplicate_cancel_refused",
    state: "a share of duplicate cancels refused for a person",
    channel: "alert",
    text: formatDuplicateCancelRefusedPage(
      {
        calls: 52,
        count: 21,
        pct: 40,
        byName: {
          duplicate_cancel_no_other_call: 14,
          duplicate_cancel_identity_conflict: 5,
          duplicate_cancel_named_is_newest: 2,
        },
      },
      24,
    ),
  },
  {
    key: "duplicate_cancel_refused",
    state: "six measured hours at an ordinary share",
    channel: "recovery",
    text: formatDuplicateCancelRefusedAllClear({ calls: 30, count: 2 }, 6),
  },
  {
    key: "duplicate_cancel_refused",
    state: "six measured hours with none refused",
    channel: "recovery",
    text: formatDuplicateCancelRefusedAllClear({ calls: 12, count: 0 }, 6),
  },
  // #2436. The rate trigger, the saturation trigger under the alert floor, and the
  // all clear with and without a straggler. Measured healthy is zero skips in 205.
  {
    key: "owner_alert_skips",
    state: "several advisors' owner alerts skipped, over the share",
    channel: "alert",
    text: formatOwnerAlertSkipsPage(
      { skipped: 14, alerts: 58, advisors: 5, pct: 24, byReason: { "not-provisioned": 9, gone: 5 } },
      7,
    ),
  },
  {
    key: "owner_alert_skips",
    state: "most of a quiet week's owner alerts skipped",
    channel: "alert",
    text: formatOwnerAlertSkipsPage({ skipped: 5, alerts: 7, advisors: 3, pct: 71, byReason: { gone: 5 } }, 7),
  },
  {
    key: "owner_alert_skips",
    state: "a measured week with none skipped",
    channel: "recovery",
    text: formatOwnerAlertSkipsAllClear({ skipped: 0, alerts: 54 }, 7),
  },
  {
    key: "owner_alert_skips",
    state: "a measured week with one skipped",
    channel: "recovery",
    text: formatOwnerAlertSkipsAllClear({ skipped: 1, alerts: 54 }, 7),
  },
  // #2440. Two states because the sentence's verb agrees with the count.
  {
    key: "owner_notice_withheld",
    state: "several owner reassign notices withheld this week",
    channel: "info",
    text: formatOwnerNoticeWithheldReport({
      count: 6,
      windowDays: 7,
      settingsUrl: "https://slate.trypennie.app/admin/alerts",
    }),
  },
  {
    key: "owner_notice_withheld",
    state: "one owner reassign notice withheld this week",
    channel: "info",
    text: formatOwnerNoticeWithheldReport({
      count: 1,
      windowDays: 7,
      settingsUrl: "https://slate.trypennie.app/admin/alerts",
    }),
  },
  {
    key: "top_tier_cascade_rate",
    state: "both top tiers cascaded",
    channel: "info",
    text: topTierCascadeReportPreview({ ultraBooked: 8, ultraCascaded: 3, veryHighBooked: 1, veryHighCascaded: 1 }),
  },
  {
    key: "top_tier_cascade_rate",
    state: "only Very High was booked",
    channel: "info",
    text: topTierCascadeReportPreview({ ultraBooked: 0, ultraCascaded: 0, veryHighBooked: 5, veryHighCascaded: 2 }),
  },
  // #2838. Three states, because the second sentence reads differently in each: a
  // day where every loser was booked with somebody else, one where some were
  // refused below the bound, and a saturated thin day where some hit the bound.
  {
    key: "booking_race_contention",
    state: "over the share, every loser handed on and booked",
    channel: "info",
    text: raceContentionReportPreview({ created: 180, reassigned: 6, refused: 0, refusedAtBound: 0 }),
  },
  {
    key: "booking_race_contention",
    state: "over the share, some refused, one at the bound",
    channel: "info",
    text: raceContentionReportPreview({ created: 200, reassigned: 4, refused: 1, refusedAtBound: 1 }),
  },
  {
    key: "booking_race_contention",
    state: "over the share, some told to try again with too little time to walk down the tiers (#3442)",
    channel: "info",
    text: raceContentionReportPreview({ created: 200, reassigned: 3, refused: 1, refusedAtBound: 0, retriedForBudget: 2 }),
  },
  {
    key: "booking_race_contention",
    state: "saturated on a thin day",
    channel: "info",
    text: raceContentionReportPreview({ created: 5, reassigned: 3, refused: 2, refusedAtBound: 0 }),
  },
  {
    key: "booking_race_contention",
    state: "judged against the busiest tier Slate measured, rescued moves among the losers",
    channel: "info",
    text: raceContentionReportPreview(
      { created: 400, reassigned: 3, reassignedMoves: 2, refused: 1, refusedAtBound: 0 },
      raceThresholdPreview("111", 6, 30),
    ),
  },
  {
    key: "booking_race_bound_hit",
    state: "a lead refused after every advisor handed on was taken",
    channel: "alert",
    text: raceBoundHitPageText({ requestedCode: "311", bucketCode: "311", startIso: "2026-07-28T18:00:00.000Z", lostRaces: 4 }),
  },
  {
    key: "booking_race_bound_hit",
    state: "refused on a tier below, after walking down the ladder (#3338)",
    channel: "alert",
    text: raceBoundHitPageText({ requestedCode: "411", bucketCode: "311", startIso: "2026-07-28T18:00:00.000Z", lostRaces: 4 }),
  },
  // A High lead and below: an Ultra High or Very High cascade is counted daily
  // above instead (#2843), and a single tier drop is counted on /admin/routing
  // (2026-10-02), so a drop of two or more tiers is the only one that pages.
  {
    key: "tier_fallback_deep:*",
    state: "a booking fell back several debt tiers",
    channel: "alert",
    text: tierFallbackAlert({ requestedCode: "311", effectiveCode: "111" })?.text ?? "",
  },
  { key: "booking_window_extended:*", state: "a customer was offered a day past the window", channel: "alert",
    text: bookingWindowExtendedAlert("511", 3) },
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
  // #2564. Both credentials shown at once, because the reader's question is what a
  // warehouse account can currently DO, and the answer is the union of them.
  { key: "snowflake_credential_residual", state: "a credential survived the sweep", channel: "alert",
    text: credentialSweepAlert([
      "bookings.manage_token: 1 row still holds the credential after the sweep",
      "webhook_deliveries.payload:manage_url: 17 rows still hold the credential after the sweep",
    ]) },
  { key: "snowflake_credential_residual", state: "the count could not be read", channel: "alert",
    text: credentialSweepAlert([
      "bookings.manage_token: could not read the residual count, so the sweep is unverified",
    ]) },
  { key: "snowflake_credential_residual", state: "the mirror is clean", channel: "recovery",
    text: CREDENTIAL_SWEEP_RECOVERY },

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
  // #3027. Each refusal names its own cause and remedy, so every one is shown.
  { key: "advisor_photos_unread", state: "no directory subject set", channel: "alert",
    text: photosUnreadAlert("no-subject", "DIRECTORY_ADMIN_SUBJECT is not set") },
  { key: "advisor_photos_unread", state: "Google refused the subject", channel: "alert",
    text: photosUnreadAlert("subject-refused", "the directory listing answered 403") },
  { key: "advisor_photos_unread", state: "the directory listing did not answer", channel: "alert",
    text: photosUnreadAlert("directory-unreadable", "the directory listing answered 503") },
  { key: "advisor_photos_unread", state: "every photo read failed", channel: "alert",
    text: photosUnreadAlert("nothing-read", "129 photo reads failed, the first with: answered 429") },
  { key: "advisor_photos_unread", state: "Slate could not read its own tables", channel: "alert",
    text: photosUnreadAlert("slate-unreadable", "read failed [advisor photo states]: relation does not exist") },
  { key: "advisor_photos_unread", state: "Google was read and the save failed", channel: "alert",
    text: photosUnreadAlert("write-failed", "read failed [advisor photo write]: canceling statement due to statement timeout") },
  { key: "advisor_photos_unread", state: "every read failed and the run hit its time limit", channel: "alert",
    text: photosUnreadAlert("nothing-read", "38 photo reads failed, the first with: no answer: timeout", 91) },
  { key: "advisor_photos_unread", state: "the run stopped at its time limit", channel: "alert",
    text: photosDeadlineAlert(89, 40) },
  { key: "advisor_photos_unread", state: "refreshing again", channel: "recovery",
    text: photosUnreadRecovery() },
  // #3124: the daily busy minute check against the load run's bar. Every fixture goes
  // through the real judge over a fixed week, so a state here is one the check sends.
  { key: "load_bar_outgrown", state: "busy minutes on 3 of 7 days, cal.com and Slate added", channel: "alert",
    text: loadBarOutgrownAlert(previewBusyVerdict(
      [["2026-10-14T14:20:00Z", 4], ["2026-10-15T15:30:00Z", 9], ["2026-10-17T13:23:00Z", 3], ["2026-10-16T14:05:00Z", 2]],
      [["2026-10-14T14:20:30Z", 5], ["2026-10-17T13:23:10Z", 5], ["2026-10-16T14:05:40Z", 3]],
      "measured",
    )) },
  { key: "load_bar_outgrown", state: "after cutover, counting Slate alone", channel: "alert",
    text: loadBarOutgrownAlert(previewBusyVerdict(
      [["2026-10-13T14:00:00Z", 8], ["2026-10-15T15:30:00Z", 11], ["2026-10-16T13:10:00Z", 9], ["2026-10-19T14:40:00Z", 8]],
      { kind: "retired" },
      "measured",
    )) },
  { key: "load_bar_outgrown", state: "a week with fewer busy days", channel: "recovery",
    text: loadBarOutgrownRecovery(previewBusyVerdict(
      [["2026-10-14T14:20:00Z", 4], ["2026-10-15T15:30:00Z", 5]],
      [["2026-10-14T14:20:30Z", 4], ["2026-10-16T13:00:00Z", 6]],
      "measured",
    )) },
  { key: "load_bar_unread", state: "cal.com refused a page part way", channel: "alert",
    text: loadBarUnreadAlert(previewBusyVerdict([["2026-10-15T15:30:00Z", 5]], { kind: "unreadable", status: 429, formName: "Debt Relief Main" }, "unmeasured")) },
  { key: "load_bar_unread", state: "cal.com never answered", channel: "alert",
    text: loadBarUnreadAlert(previewBusyVerdict([["2026-10-15T15:30:00Z", 5]], { kind: "unreadable", status: 0 }, "unmeasured")) },
  { key: "load_bar_unread", state: "Slate's read failed and cal.com's was partial", channel: "alert",
    text: loadBarUnreadAlert(previewBusyVerdict(null, { kind: "unreadable", status: 503, formName: "Debt Relief Main" }, "unmeasured")) },
  { key: "load_bar_unread", state: "cal.com empty while not marked retired", channel: "alert",
    text: loadBarUnreadAlert(previewBusyVerdict([["2026-10-15T15:30:00Z", 5]], [], "unmeasured")) },
  { key: "load_bar_unread", state: "no cal.com key while cal.com is live", channel: "alert",
    text: loadBarUnreadAlert(previewBusyVerdict([["2026-10-15T15:30:00Z", 5]], { kind: "not-configured" }, "unmeasured")) },
  { key: "load_bar_unread", state: "the retired switch unreadable", channel: "alert",
    text: loadBarUnreadAlert(previewBusyVerdict([["2026-10-15T15:30:00Z", 5]], { kind: "retired-unknown" }, "unmeasured")) },
  { key: "load_bar_unread", state: "a routed cal.com response with no readable time", channel: "alert",
    text: loadBarUnreadAlert(previewBusyVerdict([["2026-10-15T15:30:00Z", 5]], { kind: "read", routed: [{ id: "1", createdAt: "not a time" }] }, "unmeasured")) },
  { key: "load_bar_unread", state: "no routed booking anywhere after cutover", channel: "alert",
    text: loadBarUnreadAlert(previewBusyVerdict([], { kind: "retired" }, "unmeasured")) },
  { key: "load_bar_unread", state: "counting again", channel: "recovery",
    text: loadBarUnreadRecovery() },
  { key: "advisor_photos_held", state: "a wave of lost photos refused", channel: "alert",
    text: photosHeldAlert(previewPhotoPlan({ flipGuardTripped: true, heldNone: ["ada@trypennie.com", "ben@trypennie.com", "cy@trypennie.com", "dee@trypennie.com"] })) },
  { key: "advisor_photos_held", state: "one image held by three people", channel: "alert",
    text: photosHeldAlert(previewPhotoPlan({ repeated: [{ sha256: "a".repeat(64), holders: ["ada@trypennie.com", "ben@trypennie.com", "cy@trypennie.com"], held: ["cy@trypennie.com"] }] })) },
  // #3959: when nobody holds the image stored, the image page would not load, so
  // the page says where else to look.
  { key: "advisor_photos_held", state: "one image held by three people, stored for none", channel: "alert",
    text: photosHeldAlert(previewPhotoPlan({ repeated: [{ sha256: "a".repeat(64), holders: ["ada@trypennie.com", "ben@trypennie.com", "cy@trypennie.com"], held: ["ada@trypennie.com", "ben@trypennie.com", "cy@trypennie.com"] }] })) },
  { key: "advisor_photos_held", state: "one person unreadable for three days", channel: "alert",
    text: photosHeldAlert(previewPhotoPlan({ streaks: [{ email: "ada@trypennie.com", failingSince: "2026-10-01T04:20:00.000Z", reason: "answered 503" }] })) },
  { key: "advisor_photos_held", state: "somebody never read whose read failed", channel: "alert",
    text: photosHeldAlert(previewPhotoPlan({ failedNeverRead: [{ email: "newhire@trypennie.com", reason: "answered 503" }] })) },
  { key: "advisor_photos_held", state: "people missing from the directory", channel: "alert",
    text: photosHeldAlert(previewPhotoPlan({ notInDirectory: ["ada@trypennie.com", "ben@trypennie.com"] })) },
  { key: "advisor_photos_held", state: "everything at once", channel: "alert",
    text: photosHeldAlert(previewPhotoPlan({
      flipGuardTripped: true,
      heldNone: ["ada@trypennie.com", "ben@trypennie.com", "cy@trypennie.com", "dee@trypennie.com"],
      repeated: [{ sha256: "a".repeat(64), holders: ["eve@trypennie.com", "fay@trypennie.com", "gus@trypennie.com"], held: ["gus@trypennie.com"] }],
      streaks: [{ email: "hal@trypennie.com", failingSince: "2026-10-01T04:20:00.000Z", reason: "answered 503" }],
      failedNeverRead: [{ email: "jo@trypennie.com", reason: "answered 429" }],
      notInDirectory: ["ivy@trypennie.com"],
    })) },
  { key: "advisor_photos_held", state: "nothing left to look at", channel: "recovery",
    text: photosHeldRecovery() },
  // #2114: the half AFTER the read. Each count is previewed on its own as well as
  // together, because each one sends a reader somewhere different and the combined
  // message is the only place their ordering can be read.
  // #2459. Each unhealthy shape reads differently, worst first: somebody active
  // locked out, then a ban that would not land, then a list that could not be read.
  { key: "departed_sessions_unconverged", state: "the account list could not be read", channel: "alert",
    text: formatSessionConvergenceAlert({ ok: false, reason: "could not list auth users: 503 Service Unavailable" }) },
  { key: "departed_sessions_unconverged", state: "somebody active is locked out", channel: "alert",
    text: formatSessionConvergenceAlert({ ok: true, result: previewConvergence({ restoreFailed: 1 }) }) },
  { key: "departed_sessions_unconverged", state: "bans refused and the list partial", channel: "alert",
    text: formatSessionConvergenceAlert({ ok: true, result: previewConvergence({ revokeFailed: 3, listingComplete: false }) }) },
  { key: "departed_sessions_unconverged", state: "converging cleanly again", channel: "recovery",
    text: formatSessionConvergenceRecovery() },
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
  // #3615. Each part alone, then all four, because the sentence is assembled from parts.
  { key: "demotion_trigger_failures", state: "the switch could not be read", channel: "alert",
    text: demotionTriggerFailureAlert({ switchUnreadable: true, evals: 0, sweeps: 0, writes: 0 }) },
  { key: "demotion_trigger_failures", state: "a changed agent could not be checked", channel: "alert",
    text: demotionTriggerFailureAlert({ switchUnreadable: false, evals: 1, sweeps: 0, writes: 0 }) },
  { key: "demotion_trigger_failures", state: "a move could not be queued", channel: "alert",
    text: demotionTriggerFailureAlert({ switchUnreadable: false, evals: 0, sweeps: 2, writes: 0 }) },
  { key: "demotion_trigger_failures", state: "a demotion record would not save", channel: "alert",
    text: demotionTriggerFailureAlert({ switchUnreadable: false, evals: 0, sweeps: 0, writes: 3 }) },
  { key: "demotion_trigger_failures", state: "all four at once", channel: "alert",
    text: demotionTriggerFailureAlert({ switchUnreadable: true, evals: 1, sweeps: 2, writes: 3 }) },
  { key: "demotion_trigger_failures", state: "the reroute is running cleanly again", channel: "recovery",
    text: demotionTriggerFailureRecovery() },
  { key: "demotion_reroute_moved:*", state: "nobody else was free, the call stayed", channel: "info",
    text: demotionRerouteOutcomeInfo({
      email: "advisor@trypennie.com",
      change: { from: { debtTeam: ["medium", "low"], backendService: ["achieve"] }, to: { debtTeam: ["medium"], backendService: ["achieve"] } },
      counts: { moved: 0, unplaceable: 1, failed: 0, skipped: 0, cancelled: 0 },
      url: "https://slate.trypennie.app/admin/agents/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b?job=0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
    }) },
  { key: "demotion_reroute_moved:*", state: "every call moved", channel: "info",
    text: demotionRerouteOutcomeInfo({
      email: "advisor@trypennie.com",
      change: { from: { debtTeam: ["ultra_high", "high"], backendService: [] }, to: { debtTeam: ["high"], backendService: [] } },
      counts: { moved: 3, unplaceable: 0, failed: 0, skipped: 0, cancelled: 0 },
      url: "https://slate.trypennie.app/admin/agents/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b?job=0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
    }) },
  { key: "demotion_reroute_moved:*", state: "mixed, change not recorded", channel: "info",
    text: demotionRerouteOutcomeInfo({
      email: "advisor@trypennie.com",
      change: null,
      counts: { moved: 2, unplaceable: 1, failed: 1, skipped: 1, cancelled: 0 },
      url: "https://slate.trypennie.app/admin/agents/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b?job=0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
    }) },
  // Each shape alone, then all three together, because the sentence is assembled
  // from parts and a reader has to be able to see each one read on its own.
  { key: "salesforce_user_id_conflicts", state: "one stored id disagrees", channel: "alert",
    text: salesforceUserIdConflictAlert(1, 0, 0, 0) },
  { key: "salesforce_user_id_conflicts", state: "one email is shared in Salesforce", channel: "alert",
    text: salesforceUserIdConflictAlert(0, 1, 0, 0) },
  { key: "salesforce_user_id_conflicts", state: "one id is already held by another row", channel: "alert",
    text: salesforceUserIdConflictAlert(0, 0, 1, 0) },
  // #2387, the state this key gains: nobody was deactivated, and saying nothing
  // would make that read as a quiet hour.
  { key: "salesforce_user_id_conflicts", state: "one deactivation was refused on a shared address", channel: "alert",
    text: salesforceUserIdConflictAlert(0, 0, 0, 1) },
  { key: "salesforce_user_id_conflicts", state: "several deactivations were refused", channel: "alert",
    text: salesforceUserIdConflictAlert(0, 0, 0, 3) },
  { key: "salesforce_user_id_conflicts", state: "several of each at once", channel: "alert",
    text: salesforceUserIdConflictAlert(3, 2, 4, 2) },
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
    text: bucketSlotsStaleAlert(3, 6, ["530", "531", "532"]) },
  { key: "bucket_slots_stale", state: "one bucket stale", channel: "alert",
    text: bucketSlotsStaleAlert(1, 6, ["530"]) },
  { key: "bucket_slots_stale", state: "more stale than the five named", channel: "alert",
    text: bucketSlotsStaleAlert(9, 6, ["411", "412", "511", "512", "611"]) },
  // #1304: the same staleness with nothing able to EXPLAIN it. Distinct wording,
  // because the ordinary page's claim about the refresh job was never measured here.
  { key: "bucket_slots_stale", state: "stale, and the invalidation marker cannot be read", channel: "alert",
    text: bucketSlotsStaleUnreadableMarkerAlert(62, 6, ["411", "412", "511", "512", "611"], 3) },
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
  { key: "phone_correction_unsent:*", state: "a corrected number Regal was never told about", channel: "alert",
    text: phoneCorrectionUnsentAlert("b7f1c2e4-9a3d-4c88-b0f2-15ac7d9e6431") },
  // #3919: a booking's invite moved by its advisor in Google Calendar.
  { key: "booking_invite_moved:*", state: "a second move, left, advisor and manager both messaged", channel: "alert",
    text: inviteMoveLeftAlert(INVITE_MOVE_FACTS, "second-move", { advisor: true, manager: "told" }) },
  { key: "booking_invite_moved:*", state: "a move inside 30 minutes of the call, no manager of record", channel: "alert",
    text: inviteMoveLeftAlert(INVITE_MOVE_FACTS, "near-start", { advisor: true, manager: "none" }) },
  { key: "booking_invite_moved:*", state: "a second move, left, the manager lookup failed", channel: "alert",
    text: inviteMoveLeftAlert(INVITE_MOVE_FACTS, "second-move", { advisor: true, manager: "unread" }) },
  { key: "booking_invite_moved:*", state: "a left move whose messages reached nobody", channel: "alert",
    text: inviteMoveLeftAlert(INVITE_MOVE_FACTS_OTHER_DAY, "second-move", { advisor: false, manager: "unreachable" }) },
  { key: "booking_invite_moved:*", state: "Google refused putting the invite back", channel: "alert",
    text: inviteRevertRefusedAlert(INVITE_MOVE_FACTS, { kind: "refused", reason: "403 forbiddenForNonOrganizer" }) },
  { key: "booking_invite_moved:*", state: "the invite was gone when Slate went to put it back", channel: "alert",
    text: inviteRevertRefusedAlert(INVITE_MOVE_FACTS, { kind: "gone" }) },
  // #3925: a first move found on a full read of the calendar, reported and not put back.
  { key: "booking_invite_moved:*", state: "a move found on a full read of the calendar, reported", channel: "alert",
    text: inviteMoveFoundOnFullReadAlert(INVITE_MOVE_FACTS_OTHER_DAY) },
  { key: "booking_invite_moved:*", state: "put back, but the advisor could not be messaged", channel: "alert",
    text: inviteRevertedAdvisorUntoldAlert(INVITE_MOVE_FACTS) },
  // #3924: a crashed in place reschedule's invite the abandoned pin sweep could not put back.
  { key: "reschedule_invite_stranded:*", state: "Google refused putting the invite back", channel: "alert",
    text: strandedInviteAlert(STRANDED_INVITE) },
  { key: "reschedule_invite_stranded:*", state: "the invite was gone when Slate went to put it back", channel: "alert",
    text: strandedInviteAlert({ ...STRANDED_INVITE, reason: "gone", detail: null }) },
  { key: "reschedule_invite_stranded:*", state: "the invite could not be read", channel: "alert",
    text: strandedInviteAlert({ ...STRANDED_INVITE, reason: "invite-unreadable", inviteStartsAt: null,
      detail: shortErrorReason(new Error("events.get failed: 503 backendError")) }) },
  { key: "reschedule_invite_stranded:*", state: "the booking could not be read", channel: "alert",
    text: strandedInviteAlert({ ...STRANDED_INVITE, reason: "booking-unreadable", inviteStartsAt: null,
      detail: shortErrorReason(new Error("abandoned pin booking: canceling statement due to statement timeout")) }) },
  { key: "reschedule_invite_stranded:*", state: "the invite at a third time", channel: "alert",
    text: strandedInviteAlert({ ...STRANDED_INVITE, reason: "elsewhere", inviteStartsAt: "2026-10-20T15:30:00.000Z", detail: null }) },
  { key: "booking_invite_check_failed:*", state: "the record of earlier moves could not be read", channel: "alert",
    text: inviteCheckFailedAlert(INVITE_MOVE_FACTS.advisorEmail, INVITE_MOVE_FACTS.bookingUrl,
      shortErrorReason(new Error("booking invite changes read failed: canceling statement due to statement timeout"))) },
  { key: "booking_invite_resized:*", state: "the call lengthened in Google Calendar", channel: "alert",
    text: inviteResizedAlert({ ...INVITE_MOVE_FACTS, eventStartsAt: INVITE_MOVE_FACTS.bookedStartsAt, eventEndsAt: "2026-10-19T20:45:00.000Z" }) },
  { key: "booking_invite_resized:*", state: "the call shortened in Google Calendar", channel: "alert",
    text: inviteResizedAlert({ ...INVITE_MOVE_FACTS, eventStartsAt: INVITE_MOVE_FACTS.bookedStartsAt, eventEndsAt: "2026-10-19T20:15:00.000Z" }) },
  { key: "booking_invite_launch_sweep", state: "two invites already out of step at launch", channel: "alert",
    text: inviteLaunchSweepAlert([
      { ...INVITE_MOVE_FACTS, step: "moved" },
      { ...INVITE_MOVE_FACTS_OTHER_DAY, advisorName: null, step: "moved" },
    ]) },
  { key: "booking_invite_launch_sweep", state: "one invite out of step at launch, only its end", channel: "alert",
    text: inviteLaunchSweepAlert([
      { ...INVITE_MOVE_FACTS, eventStartsAt: INVITE_MOVE_FACTS.bookedStartsAt, eventEndsAt: "2026-10-19T20:45:00.000Z", step: "resized" },
    ]) },
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
  { key: "google_calendar_breaker_open", state: "Google stopped answering", channel: "alert",
    text: googleBreakerOpenAlert(5, "503 from google freeBusy", 30_000) },
  { key: "google_calendar_breaker_open", state: "the last failure carried no detail", channel: "alert",
    text: googleBreakerOpenAlert(5, null, 30_000) },
  { key: "google_calendar_breaker_open", state: "answering again after a short outage", channel: "recovery",
    text: googleBreakerClosedAlert(40_000) },
  { key: "google_calendar_breaker_open", state: "answering again after a long outage", channel: "recovery",
    text: googleBreakerClosedAlert(47 * 60_000) },
  { key: "retention_skipped:*", state: "deleting again", channel: "recovery",
    text: retentionResumedText("prune-bookings-pii") },
  { key: "bookable_trait_unrecorded:*", state: "an agent taken out of the pool and Regal not told", channel: "alert",
    text: bookableTraitUnrecordedAlert("dana.whitfield@trypennie.com", false) },
  { key: "bookable_trait_unrecorded:*", state: "an agent made bookable and Regal not told", channel: "alert",
    text: bookableTraitUnrecordedAlert("ariel.nwosu@trypennie.com", true) },
  // #3526. Each reason has its own wording, because the two send the reader to
  // different places: a person to identify, or a sign in path to repair.
  { key: "sign_in_google_account_mismatch:*", state: "a different Google account on a known address", channel: "alert",
    text: googleAccountMismatchAlert("dana.whitfield@trypennie.com", "different-account") },
  { key: "sign_in_google_account_mismatch:*", state: "a sign in carrying no Google account id", channel: "alert",
    text: googleAccountMismatchAlert("ariel.nwosu@trypennie.com", "no-account-id") },
  { key: "sign_in_google_account_mismatch:*", state: "two Google accounts on one sign in", channel: "alert",
    text: googleAccountMismatchAlert("dana.whitfield@trypennie.com", "several-accounts") },
  // #3700. The constant is imported rather than spelled, so the preview cannot claim
  // a period the sync lane does not wait.
  { key: "refused_advisor_left_pool:*", state: "an archived account, other advisors still in its pools", channel: "alert",
    text: refusedAdvisorLeftPoolAlert({ name: "Dana Whitfield", email: "dana.whitfield@trypennie.com",
      managerName: "Morgan Lee", failure: "not-provisioned", refusedForMs: REFUSED_POOL_EXIT_AFTER_MS, poolsLeftEmpty: [] }) },
  { key: "refused_advisor_left_pool:*", state: "a deleted account, the last advisor in two pools", channel: "alert",
    text: refusedAdvisorLeftPoolAlert({ name: "Sam Okafor", email: "sam.okafor@trypennie.com",
      managerName: null, failure: "gone", refusedForMs: REFUSED_POOL_EXIT_AFTER_MS,
      poolsLeftEmpty: ["Low Beyond", "Medium Beyond"] }) },
  { key: "refused_advisor_left_pool:*", state: "the pool check could not be made, no name on the row", channel: "alert",
    text: refusedAdvisorLeftPoolAlert({ name: null, email: "kit.alvarez@trypennie.com",
      managerName: "Morgan Lee", failure: "not-provisioned", refusedForMs: REFUSED_POOL_EXIT_AFTER_MS, poolsLeftEmpty: null }) },
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
  { key: "bookable_blocked:*", state: "the gate ran out of its own budget", channel: "alert",
    // #2317. Its own state because it is the one refusal that says nothing about
    // the account: sending this reader to the sync lane would send them to read
    // errors nobody recorded.
    text: bookableTimedOutAlert("sam.okafor@trypennie.com", ACTIVATION_BUDGET_MS) },
  { key: "bookable_blocked:*", state: "another lane was loading one calendar", channel: "alert",
    // #2705. Its own state for the same reason as the budget: it says nothing is
    // wrong with the account, so it must not send the reader to the sync lane.
    text: bookableContendedAlert("kit.alvarez@trypennie.com", 1) },
  { key: "bookable_blocked:*", state: "another lane was loading several calendars", channel: "alert",
    text: bookableContendedAlert("dana.whitfield@trypennie.com", 2) },
  { key: "bookable_unverified:*", state: "transient error persisted", channel: "alert",
    text: bookableUnverifiedAlert("dana.whitfield@trypennie.com") },
  { key: "ooo_approvals_digest", state: "one approval, one recipient", channel: "alert",
    text: oooApprovalsDigestAlert(1, 1, "530 authentication required") },
  { key: "ooo_approvals_digest", state: "several of each", channel: "alert",
    text: oooApprovalsDigestAlert(6, 3, "530 authentication required") },
  { key: "misroute:*", state: "a booking that matched no criteria", channel: "alert",
    text: misrouteAlert("bk_8f21c4", "411", "usr_22") },
  { key: "internal_error:*", state: "an unexpected 500", channel: "alert",
    text: internalErrorAlert("POST /api/bookings", "503 backendError") },
  // #2788: a browser report rides the same key family and the same chokepoint,
  // and nothing returned a 500 for it, so it reads as a report from a page.
  // Rendered through the dispatcher the chokepoint itself calls, so the preview
  // shows what ships rather than what one builder would say (L41).
  // #2575: a refusal under the enforced content security policy. One state per
  // shape of what was blocked, since each reads differently, plus a page Slate does
  // not serve and a directive the report named in a way Slate does not recognise.
  { key: "csp_violation:*", state: "a script from another site refused on the booker", channel: "alert",
    text: cspViolationAlert({ directive: "script-src", surface: "book", blocked: { kind: "origin", origin: "https://cdn.example.com" } }) },
  { key: "csp_violation:*", state: "inline code refused on an admin page", channel: "alert",
    text: cspViolationAlert({ directive: "script-src", surface: "admin", blocked: { kind: "keyword", keyword: "inline" } }) },
  { key: "csp_violation:*", state: "an image refused on the manage page", channel: "alert",
    text: cspViolationAlert({ directive: "img-src", surface: "booking", blocked: { kind: "origin", origin: "https://lh4.googleusercontent.com" } }) },
  { key: "csp_violation:*", state: "a data address refused on the home page", channel: "alert",
    text: cspViolationAlert({ directive: "media-src", surface: "root", blocked: { kind: "scheme", scheme: "data" } }) },
  { key: "csp_violation:*", state: "string evaluation refused on the sign in page, the report naming no script", channel: "alert",
    text: cspViolationAlert({ directive: "script-src", surface: "login", blocked: { kind: "keyword", keyword: "eval" } }) },
  { key: "csp_violation:*", state: "string evaluation refused on the manage page, the report naming the script", channel: "alert",
    text: cspViolationAlert({ directive: "script-src", surface: "booking", blocked: { kind: "keyword", keyword: "eval" }, sourceNamed: true }) },
  { key: "csp_violation:*", state: "inline styling refused on the booker", channel: "alert",
    text: cspViolationAlert({ directive: "style-src", surface: "book", blocked: { kind: "keyword", keyword: "inline" } }) },
  { key: "csp_violation:*", state: "an unreadable address under an unrecognised rule, from a page Slate does not serve", channel: "alert",
    text: cspViolationAlert({ directive: "other", surface: "other", blocked: { kind: "unreadable" } }) },
  { key: "internal_error:*", state: "a browser reported an error on the booker", channel: "alert",
    text: unexpectedFaultAlert("client_error:book",
      "error on /book/411: TypeError: slots.map is not a function (booker.js:1:4821)") },
  { key: "internal_error:*", state: "a browser reported an error on the home page", channel: "alert",
    text: unexpectedFaultAlert("client_error:root", "unhandledrejection on /: Failed to fetch") },
  // #2755: every page Slate does not serve shares one key, so the size of the
  // storm leads the detail. Two states: counted, and the counter unreadable.
  { key: "internal_error:*", state: "browser reports from pages Slate does not serve, counted", channel: "alert",
    text: unexpectedFaultAlert("client_error:other",
      `${unrecognisedPageReports({ count: 40, measured: true, windowMinutes: 30 })} error on /wp-login.php: Loading chunk 412 failed`) },
  { key: "internal_error:*", state: "browser reports from pages Slate does not serve, uncounted", channel: "alert",
    text: unexpectedFaultAlert("client_error:other",
      `${unrecognisedPageReports({ count: null, measured: false, windowMinutes: 30 })} error on /wp-login.php: Loading chunk 412 failed`) },
  // #3323: a single opaque cross origin script error never pages; a burst across
  // different addresses does. Two states: the figure read back, and the figure
  // unreadable, when the copy says only what the increment itself decided.
  { key: "opaque_script_errors:*", state: "a burst of detail free script errors on the booker, counted", channel: "alert",
    text: opaqueScriptErrorBurstAlert({ surface: "book", addresses: 5, threshold: OPAQUE_BURST_THRESHOLD, windowMinutes: 15 }) },
  { key: "opaque_script_errors:*", state: "a burst of detail free script errors on the booker, the figure unreadable", channel: "alert",
    text: opaqueScriptErrorBurstAlert({ surface: "book", addresses: null, threshold: OPAQUE_BURST_THRESHOLD, windowMinutes: 15 }) },
  // #1974: a page that failed to RENDER, which is a different event from a 500
  // and reads differently: nobody got a status code, somebody got a screen.
  // Three states, because the SCOPE sentence is what decides whether the reader
  // gets up, and the three are the three different things Slate can know: how
  // many, that a break is repeating but the figure is missing, and that the
  // counter itself could not answer.
  // #2641: an embedding host that named the wrong origin for itself.
  { key: "embed_origin_mismatch", state: "a host declared another origin", channel: "info",
    text: embedOriginMismatchAlert("https://trypennie.com", "https://www.trypennie.com") },
  // #2660: a partner's page threw while on the public test bucket.
  { key: "client_error_test_bucket", state: "a page on a test bucket reported an error", channel: "info",
    text: testBucketClientErrorInfo("/book", PUBLIC_TEST_BUCKET_CODES[0]) },
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
  // #3543: Marcia's booking endpoint.
  { key: "marcia_booking_failed:*", state: "an expected refusal on a write (slot taken)", channel: "alert",
    text: marciaFailureAlert({ operation: "book", code: "slot_taken", class: "expected", salesforceId: "00Q5f00000AbCdEFGH", bucketCode: "411", test: false }) },
  { key: "marcia_booking_failed:*", state: "an unexpected failure, on a test lead", channel: "alert",
    text: marciaFailureAlert({ operation: "cancel", code: "internal", class: "unexpected", salesforceId: "00Q5f00000AbCdEFGH", bucketCode: PARTNER_BUCKET_CODE, test: true }) },
  { key: "marcia_token_refused:*", state: "a token missing a claim", channel: "alert",
    text: marciaTokenRefusedAlert({ code: "token_claim_missing", claim: "test" }) },
  { key: "marcia_token_refused:*", state: "a token with a foreign signature", channel: "alert",
    text: marciaTokenRefusedAlert({ code: "token_signature_invalid" }) },
  { key: "marcia_gateway_refused", state: "no secret on the deployment", channel: "alert",
    text: marciaGatewayRefusedAlert("unconfigured") },
  { key: "marcia_gateway_refused", state: "a call without the secret", channel: "alert",
    text: marciaGatewayRefusedAlert("mismatch") },
  { key: "reassign-unknown-reason-code", state: "an unrecognised code", channel: "info",
    text: unknownReasonCodeNotice("owner_switch") },
  // The area label MUST be a value the code really produces (friendlyRateArea, or
  // a `friendly` from the rule table): every one is a bare noun with no article,
  // and the copy supplies the article itself. An invented "the public booker"
  // rendered "The the public booker rate limit" here, which is the fixture lying
  // about the shape of its own input (L48).
  { key: "rate_limit_blocked:*", state: "a caller throttled", channel: "alert",
    text: limiterBlockedAlert(friendlyRateArea("book"), "203.0.113.9", 30, 60) },
  // #3670: these page only on a sustained run, so the count is the threshold or more, and a
  // flood that outgrew what one server keeps is a floor ("At least").
  { key: "rate_limit_broken:*", state: "a sustained run of fail opens", channel: "alert",
    text: limiterFailOpenAlert(friendlyRateArea("landing:h"), {
      count: LIMITER_FAIL_OPEN_PAGE_AFTER, windowMs: LIMITER_FAIL_OPEN_WINDOW_MS, atLeast: false }) },
  { key: "rate_limit_broken:*", state: "a flood of fail opens past what one server keeps", channel: "alert",
    text: limiterFailOpenAlert(friendlyRateArea("bookapi"), {
      count: 1000, windowMs: LIMITER_FAIL_OPEN_WINDOW_MS, atLeast: true }) },
  // #1557: the two answers a ceiling can give a caller it cannot identify. They read
  // differently on purpose: the reader has to know whether anything was turned away.
  { key: "rate_limit_unidentified:*", state: "a ceiling that served the request anyway",
    channel: "alert", text: unidentifiedCallerAlert(BOOKING_LIMITER) },
  { key: "rate_limit_unidentified:*", state: "a ceiling that refused the request",
    channel: "alert", text: unidentifiedCallerAlert(CLIENT_ERROR_ADDRESS_POLICY) },
  // #3325: the two ways a switched on shared confirm line goes unused, each in its own words.
  { key: "confirm_line_unreachable", state: "confirms cannot reach the shared line", channel: "alert",
    text: confirmLineUnreachableAlert("reach-timeout") },
  { key: "confirm_line_unreachable", state: "switched on with no binding", channel: "alert",
    text: confirmLineUnreachableAlert("unbound") },
  { key: "confirm_line_unreachable", state: "answers the client cannot read", channel: "alert",
    text: confirmLineUnreachableAlert("bad-answer") },
  { key: "confirm_line_unreachable", state: "a line object older than the app (#3560)", channel: "alert",
    text: confirmLineUnreachableAlert("version") },
  { key: "confirm_line_unreachable", state: "a mix of failures in one window", channel: "alert",
    text: confirmLineAlertFor(["reach-timeout", "reach-timeout", "bad-answer"]) },
  // #3339: a run of failed reads of the shared line switch on one server, by what the
  // deployment default says, since that is what those confirms were answered with.
  // #3339: production's default is on, and a server on it errs the other way, so it reads differently.
  { key: "shared_line_switch_unreadable", state: "a run of failed reads, default on (production)", channel: "alert",
    text: sharedLineSwitchUnreadableAlert({ count: SWITCH_READ_PAGE_AFTER, windowMs: SWITCH_READ_PAGE_WINDOW_MS, atLeast: false }, "on") },
  { key: "shared_line_switch_unreadable", state: "a run of failed reads, default off", channel: "alert",
    text: sharedLineSwitchUnreadableAlert({ count: SWITCH_READ_PAGE_AFTER, windowMs: SWITCH_READ_PAGE_WINDOW_MS, atLeast: false }, "off") },
  { key: "shared_line_switch_unreadable", state: "a run of failed reads, default unset", channel: "alert",
    text: sharedLineSwitchUnreadableAlert({ count: SWITCH_READ_PAGE_AFTER, windowMs: SWITCH_READ_PAGE_WINDOW_MS, atLeast: false }, undefined) },
  { key: "rate_limit_refund_broken:*", state: "a sustained run of failed refunds", channel: "alert",
    text: refundFailedAlert(friendlyRateArea("book"), {
      count: LIMITER_FAIL_OPEN_PAGE_AFTER, windowMs: LIMITER_FAIL_OPEN_WINDOW_MS, atLeast: false }) },

  // --- time off ----------------------------------------------------------------
  { key: "ooo_manager_calendar", state: "manager calendar unreachable", channel: "alert",
    text: oooManagerCalendarAlert("req_9f2", "403 forbidden") },
  { key: "ooo_calendar_create", state: "failed on the main calendar", channel: "alert",
    text: oooCalendarCreateAlert("req_9f2", "503 backendError") },
  { key: "ooo_calendar_create", state: "failed on both calendars", channel: "alert",
    text: oooCalendarCreateBothFailedAlert("req_9f2", "503 backendError") },
  { key: "ooo_agent_calendar", state: "agent calendar event failed", channel: "alert",
    text: oooAgentCalendarAlert("req_9f2", "503 backendError") },
  // #3365: a shortened request whose events could not be moved, and whose held block
  // could not be narrowed. Both leave the earlier, wider window blocked.
  { key: "ooo_agent_calendar", state: "a shortened request's event could not be moved", channel: "alert",
    text: oooNarrowCalendarAlert("req_9f2", "agent", "503 backendError") },
  { key: "ooo_manager_calendar", state: "a shortened request's manager copy could not be moved", channel: "alert",
    text: oooNarrowCalendarAlert("req_9f2", "manager", "503 backendError") },
  { key: "busy_block_write_through", state: "a shortened request's held block could not be narrowed", channel: "alert",
    text: oooNarrowHoldAlert("req_9f2") },
  { key: "ooo_busy_block_fallback", state: "fell back to a native block", channel: "alert",
    text: oooBusyBlockFallbackAlert("req_9f2") },
  // #1470: the ending this one never had. It names no request id, for the same
  // reason as the cal.com all-clear below: the key covers every approval relying
  // on a fallback, and by the time this sends there are none.
  { key: "ooo_busy_block_fallback", state: "nothing is relying on the fallback any more",
    channel: "recovery", text: formatFallbackClearedRecovery() },
  // #3360: the 2026-10-06 shape, an all day request whose event was edited to begin
  // at 11:30 AM MT. The edit was the true one that day, so the page must ask for
  // the two to agree rather than for the event to be put back.
  { key: "ooo_event_mismatch:*", state: "the event was shortened, and neither the agent nor the manager fixed it", channel: "alert",
    text: mismatchPage([MISMATCH_SHORTENED], { agent: "told", manager: "told" }) },
  { key: "ooo_event_mismatch:*", state: "two requests, one event gone, no manager of record", channel: "alert",
    text: mismatchPage([MISMATCH_SHORTENED, MISMATCH_GONE], { agent: "told", manager: "none" }) },
  // #3655: a request straddling the calendar's mirrored horizon whose event is gone.
  // Only the part inside the horizon was checked, so the sentence names only that.
  { key: "ooo_event_mismatch:*", state: "the event is gone, part of the window too far ahead to check, neither message delivered", channel: "alert",
    text: mismatchPage([
      { requestId: "req_c07", startsAt: "2026-10-26T06:00:00.000Z", endsAt: "2026-10-30T06:00:00.000Z",
        displayTzId: "America/Denver", displayTzLabel: "MT",
        coverage: { kind: "not-blocking", unmeasured: { startMs: 1793178000000, endMs: 1793340000000 } } },
    ], { agent: "unreachable", manager: "unreachable" }) },
  { key: "ooo_event_mismatch:*", state: "the agent's message never arrived, and the manager did not fix it", channel: "alert",
    text: mismatchPage([MISMATCH_SHORTENED], { agent: "unreachable", manager: "told" }) },
  // #3372: two requests that reached the channel for different reasons, each on its line.
  { key: "ooo_event_mismatch:*", state: "two requests, each with its own reason", channel: "alert",
    text: mismatchPage([MISMATCH_SHORTENED, MISMATCH_GONE], [{ agent: "told", manager: "told" }, { agent: "told", manager: "none" }]) },
  { key: "ooo_event_mismatch:*", state: "the calendar and the request agree again", channel: "recovery",
    text: oooEventMismatchRecovery("Heather McLellen", { kind: "agreed", compared: 2 }) },
  { key: "ooo_event_mismatch:*", state: "nothing approved is ahead any more", channel: "recovery",
    text: oooEventMismatchRecovery("Heather McLellen", { kind: "nothing-ahead" }) },
  { key: "ooo_calcom", state: "the override failed at approval", channel: "alert",
    text: oooCalcomAlert("req_9f2", "409 conflict") },
  // #2890: a block left in cal.com while it was retired, whose record failed.
  { key: "ooo_calcom_stale_unrecorded:*", state: "a block left while cal.com was retired could not be recorded", channel: "alert",
    text: oooCalcomStaleUnrecordedAlert("req_9f2", "dana.whitfield@trypennie.com", "permission denied") },
  // #1280: the ending it never had. It names no request id on purpose: the page is
  // one key covering every failing approval, and by the time this sends there are
  // none, so quoting one would suggest the others were left.
  { key: "ooo_calcom", state: "the retry sweep landed every override", channel: "recovery",
    text: formatOverrideRecovery() },
  // #2875: the same ending the unprotected page gets once cal.com is retired.
  { key: "ooo_calcom", state: "cal.com was retired", channel: "recovery",
    text: formatCalcomRetiredSweepEnding() },
  { key: "ooo_agent_dm", state: "the decision DM did not land", channel: "alert",
    text: oooAgentDmAlert("dana.whitfield@trypennie.com", "req_9f2") },
  { key: "ooo_undo", state: "undoing the manager event failed", channel: "alert",
    text: oooUndoManagerAlert("req_9f2", "404 notFound") },
  { key: "ooo_undo", state: "undoing the agent event failed", channel: "alert",
    text: oooUndoAgentAlert("req_9f2", "404 notFound") },
  { key: "ooo_undo_unchecked:*", state: "an untracked manager event could not be checked for", channel: "alert",
    text: oooUndoUnrecordedAlert("req_9f2", [{ whose: "manager", reason: "503 backendError" }]) },
  { key: "ooo_undo_unchecked:*", state: "an untracked agent event could not be checked for", channel: "alert",
    text: oooUndoUnrecordedAlert("req_9f2", [{ whose: "agent", reason: "503 backendError" }]) },
  { key: "ooo_undo_unchecked:*", state: "neither calendar could be checked, in one page", channel: "alert",
    text: oooUndoUnrecordedAlert("req_9f2", [
      { whose: "manager", reason: "its manager could not be read: PostgREST 500" },
      { whose: "agent", reason: "503 backendError" },
    ]) },
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
