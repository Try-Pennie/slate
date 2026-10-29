import { NextResponse, type NextRequest } from "next/server";
import { leaseHeldThroughout } from "@/lib/monitor/lease-heartbeat";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLease, acquireLock, releaseLock } from "@/lib/locks";
import {
  sendThrottledAlert,
  sendThrottledInfo,
  isAlertDue,
  resolveAlert,
  resolveRecovered,
  settleAlertsSilently,
  firingFamilyMembers,
  existingAlertStateKeys,
} from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import { CHANGE_ONLY_HOLD_MS, CONDITION_REPEAT_MS } from "@/lib/notify/repeat-policy";
import {
  runRegalCallCheck,
  REGAL_CALL_ALERT_PREFIX,
  type RegalCaller,
  type RegalCandidate,
  type RegalIgnore,
} from "@/lib/monitor/regal-calls";
import {
  runRegalFeedQuietCheck,
  runRegalFeedUnreadableCheck,
  countsFromRows,
  type RegalReasonCounts,
} from "@/lib/monitor/regal-call-feed";
import {
  runRegalCallOutcomesCheck,
  REGAL_CALL_OUTCOMES_STREAK_KEY,
  REGAL_CALL_OUTCOMES_STREAK_WINDOW_S,
} from "@/lib/monitor/regal-call-outcomes";
import { eligibleAgentIdsCached } from "@/lib/availability/eligible-cache";
import { getBucketSlots } from "@/lib/availability/service";
import { loadAllWorkingHours } from "@/lib/availability/working-hours-load";
import { slotCacheKey } from "@/lib/availability/cache-key";
import { recomputeBucketSlotsForToday } from "@/lib/availability/slot-cache";
import { readBookingHorizonDays, readPlaceholderBookingEnabled } from "@/lib/booking/settings";
import { readOfferedOpenDays } from "@/lib/booking/days-offered-load";
import { recordFailureStreak, clearFailureStreak, trackConsecutiveStreak } from "@/lib/notify/streak";
import { runPlaceholderCallCheck, PLACEHOLDER_CALL_ALERT_PREFIX } from "@/lib/monitor/placeholder-calls";
import {
  loadPlaceholderCallCandidates,
  loadPlaceholderBookingsById,
  loadPlaceholderCalls,
  loadCallFeedNewestReceivedMs,
} from "@/lib/monitor/placeholder-calls-store";
import { runReminderOwedCheck, REMINDER_OWED_ALERT_PREFIX } from "@/lib/monitor/reminder-owed";
import { loadOwedBookings, loadOwedEmails } from "@/lib/monitor/reminder-owed-store";
import {
  runPlaceholderSeatCheck,
  PLACEHOLDER_SEAT_STREAK_KEY,
  PLACEHOLDER_SEAT_STREAK_WINDOW_S,
} from "@/lib/monitor/placeholder-seat";
import {
  loadRealPlaceholders,
  countFutureCallsOnPlaceholders,
  probePlaceholderCalendar,
  probePlaceholderGmail,
  probePlaceholderAutoReply,
} from "@/lib/monitor/placeholder-seat-store";
import {
  runEmptyReasonCheck,
  EMPTY_REASON_STREAK_KEY,
  EMPTY_REASON_STREAK_WINDOW_S,
} from "@/lib/monitor/empty-reason-health";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { slotHealthByCode, type SlotHealthRow } from "@/lib/monitor/slot-health";
import { slotHealthForTick, availabilityScanReport } from "@/lib/monitor/availability-tick";
import { monitorSetupGates } from "@/lib/monitor/setup-gates";
import {
  runCalendarWindowCheck,
  calendarWindowRow,
  CALENDAR_WINDOW_COLUMNS,
  type CalendarWindowResult,
  type CalendarWindowRow,
  type CalendarWindowSourceRow,
} from "@/lib/monitor/calendar-window-coverage";
import {
  runDbSaturationCheck,
  fetchDbSaturationMetrics,
  type DbSaturationResult,
} from "@/lib/monitor/db-saturation";
import {
  runBusyDriftSample,
  reportBusyDrift,
  sampleForTick,
  type BusyDriftResult,
  type DriftInterval,
} from "@/lib/monitor/busy-drift-sampler";

/** Agents the busy drift sampler reads per tick: under freeBusy's 20 calendar cap. */
const BUSY_DRIFT_BATCH = 18;
import { readAgentBusyRange } from "@/lib/monitor/availability-truth-store";
import { coverageForRange, runRosterCoverageCheck } from "@/lib/monitor/roster-coverage";
import {
  runBookingPauseCheck,
  BOOKING_PAUSE_UNREADABLE,
  PAUSE_NOTICE_AFTER_MS,
  type BookingPauseVerdict,
} from "@/lib/monitor/booking-pause";
import { readPublicBookingPauseState } from "@/lib/booking/settings";
import {
  runSharedLineLeftOffCheck,
  SHARED_LINE_LEFT_OFF_UNREADABLE,
  SHARED_LINE_OFF_NOTICE_AFTER_MS,
  type SharedLineLeftOffVerdict,
} from "@/lib/monitor/shared-line-left-off";
import { readSharedLineSwitchHistory } from "@/lib/booking/shared-line-switch";
import {
  planTierAlerts,
  settleTierRecovery,
  tierStaffingKey,
  tierUnstaffedMessage,
} from "@/lib/monitor/tier-staffing";
import {
  clearTierHolds,
  DEBT_TIERS,
  loadTierAgentIds,
  loadTierAlertState,
  loadTierCauseReads,
  startTierHolds,
  tierAgentCounts,
  tierReadings,
  tierWindows,
} from "@/lib/monitor/tier-staffing-load";
import { tierCauseAgents, tierNoSlotsPageText, type TierCauseInput } from "@/lib/monitor/tier-cause";
import { closedExceptionDates } from "@/lib/booking/business-hours";
import { loadCoverageAgents } from "@/lib/booking/business-hours-coverage-load";
import { loadBusinessHours, loadBusinessHoursExceptions, type BusinessHours } from "@/lib/booking/business-hours-load";
import { tierLadder } from "@/lib/routing/tiers";
import { bucketSpecForXbc } from "@/lib/xbc";
import { type WorkingRule } from "@/lib/monitor/availability-health";
import { runAvailabilityScan } from "@/lib/monitor/availability-scan";
import {
  runLowVolumeCheck,
  isBusinessHours,
  type LowVolumeResult,
} from "@/lib/monitor/booking-volume";
import { floorsFor, judgedFloors } from "@/lib/monitor/volume-floors";
import {
  runVolumeVerdictGapCheck,
  type VolumeVerdictGapResult,
} from "@/lib/monitor/volume-verdict-gap";
import {
  countCustomerBookingsSince,
  firstTierBookingsSince,
  customerBookingFromSourcesSince,
  listCustomerBookingSourcesSince,
} from "@/lib/monitor/customer-bookings";
import { listBookingStampsBetween } from "@/lib/monitor/volume-learning-bookings";
import { runVolumeRelearn } from "@/lib/monitor/volume-relearn";
import { LOW_TIER } from "@/lib/monitor/volume-tiers";
import { REAL_ANCHOR_SOURCE } from "@/lib/monitor/carried-share";
import { calcomBookingByUid, calcomTierBookingCounts, calcomUpcomingBookings } from "@/lib/calcom/client";
import {
  runCrossSystemBookingsCheck,
  CROSS_SYSTEM_BOOKING_KEY,
  type CrossSystemBookingsResult,
} from "@/lib/monitor/cross-system-bookings";
import { loadSlateUpcomingBookings } from "@/lib/monitor/cross-system-bookings-store";
import { BUFFER_BREACH_KEY, runBufferBreachCheck, type BufferBreachResult } from "@/lib/monitor/buffer-breach";
import { loadBookingsForBufferCheck } from "@/lib/monitor/buffer-breach-store";
import { runPilotOfferSampleLive } from "@/lib/monitor/pilot-offers-live";
import { runPilotSettingsSampleLive } from "@/lib/monitor/pilot-settings-samples-live";
import { runTierVolumeChecks } from "@/lib/monitor/tier-volume";
import { MEASURED_VOLUME_BASELINE } from "@/lib/monitor/volume-baseline";
import { runPageVolumeCheck, type PageVolumeResult } from "@/lib/monitor/page-volume";
import { MEASURED_PAGE_BASELINES } from "@/lib/monitor/page-volume-baseline";
import {
  runBookingFailureRateCheck,
  type FailureRateResult,
  type RateThresholds,
} from "@/lib/monitor/booking-failure-rate";
import {
  SHIPPED_FAILURE_RATE_RECENT,
  SHIPPED_FAILURE_RATE_THRESHOLDS,
  SHIPPED_FAILURE_VOLUME,
} from "@/lib/monitor/failure-rate-thresholds";
import {
  catchallVerdict,
  catchallPageText,
  catchallClearText,
  CATCHALL_RATE_ALERT_KEY,
} from "@/lib/monitor/catchall-rate";
import { readCatchallWindow, CATCHALL_WINDOW_HOURS } from "@/lib/monitor/catchall-rate-store";
import { runSloBudgetCheck } from "@/lib/monitor/slo-budget";
import { readMonthToDate } from "@/lib/monitor/slo-budget-store";
import { checkTopTierPlacements, TOP_TIER_PLACEMENT_LOOKBACK_HOURS } from "@/lib/monitor/top-tier-placement";
import { loadPlacementAdvisors, loadTopTierCascades } from "@/lib/monitor/top-tier-placement-store";
import {
  raceContentionNoticeText,
  judgeRaceContention,
  RACE_CONTENTION_NOTICE_KEY,
  RACE_CONTENTION_COOLDOWN_MS,
} from "@/lib/monitor/race-contention";
import {
  raceThresholdDayCache,
  readRaceContentionWindow,
  readRaceRateBookings,
} from "@/lib/monitor/race-contention-store";
import {
  loadRateState,
  saveRateState,
  readTodayMix,
  outcomeReadingOf,
  readRefusedPeople,
  type TodayMix,
} from "@/lib/monitor/booking-failure-rate-store";
import {
  runFollowUpDrainCheck,
  FOLLOW_UP_DRAIN_THRESHOLDS,
  type FollowUpDrainResult,
} from "@/lib/monitor/follow-up-drain-rate";
import { loadFollowUpState, saveFollowUpState, followUpReadingOf } from "@/lib/monitor/follow-up-drain-rate-store";
import {
  runDuplicateCancelCheck,
  DUPLICATE_CANCEL_THRESHOLDS,
  type DuplicateCancelResult,
} from "@/lib/monitor/duplicate-cancel-rate";
import {
  duplicateCancelReadingOf,
  loadDuplicateCancelState,
  saveDuplicateCancelState,
} from "@/lib/monitor/duplicate-cancel-rate-store";
import {
  runAvailabilityTruthCheck,
  type TruthResult,
  type TruthThresholds,
} from "@/lib/monitor/availability-truth";
import {
  nextTruthBucket,
  offeredSlots,
  eligibleEmailsForBucket,
  verifyWindowsLive,
  driftAlertContext,
  markBucketDrifting,
} from "@/lib/monitor/availability-truth-store";
import { runOfferedNobodyFreeCheck, type OfferedNobodyFreeResult } from "@/lib/monitor/offered-nobody-free";
import {
  loadRealPools,
  readOfferedSuspects,
  markOfferedSuspect,
  clearOfferedSuspect,
  judgeOfferedTime,
} from "@/lib/monitor/offered-nobody-free-live";
import { recordHeartbeat, readHeartbeatMs, readHeartbeatMsStrict } from "@/lib/monitor/heartbeat";
import { recordDetectorVerdict } from "@/lib/monitor/verdict-store";
import {
  AVAILABILITY_TRUTH_VERDICT_LANE,
  TIER_STAFFING_VERDICT_LANE,
  tierStaffingReachedVerdict,
  BELOW_LEAD_TIER_VERDICT_LANE,
  belowLeadTierReachedVerdict,
  CROSS_SYSTEM_BOOKINGS_VERDICT_LANE,
  crossSystemBookingsReachedVerdict,
  REGAL_CALLS_VERDICT_LANE,
  regalCallsReachedVerdict,
  ROSTER_COVERAGE_VERDICT_LANE,
  rosterCoverageReachedVerdict,
  AVAILABILITY_SCAN_VERDICT_LANE,
  availabilityScanReachedVerdict,
  CALENDAR_WINDOW_VERDICT_LANE,
  calendarWindowReachedVerdict,
  BUSY_DRIFT_VERDICT_LANE,
  busyDriftReachedVerdict,
  OFFERED_NOBODY_FREE_VERDICT_LANE,
  offeredNobodyFreeReachedVerdict,
  BUFFER_BREACH_VERDICT_LANE,
  bufferBreachReachedVerdict,
  OFFSITE_ORIGIN_VERDICT_LANE,
  offsiteOriginReachedVerdict,
  AUTH_SIGN_IN_VERDICT_LANE,
  authSignInReachedVerdict,
  AWAITING_ACTIVATION_VERDICT_LANE,
  awaitingActivationReachedVerdict,
  STRANDED_HIRES_VERDICT_LANE,
  strandedHiresReachedVerdict,
  AUDIT_CHAIN_VERDICT_LANE,
  auditChainReachedVerdict,
  REGAL_CALL_FEED_VERDICT_LANE,
  regalCallFeedReachedVerdict,
  REGAL_CALL_OUTCOMES_VERDICT_LANE,
  regalCallOutcomesReachedVerdict,
  FAILURE_RATE_VERDICT_LANE,
  LOW_VOLUME_VERDICT_LANE,
  OOO_PROTECTION_VERDICT_LANE,
  LANE_WATCHDOG_VERDICT_LANE,
  truthReachedVerdict,
  failureRateReachedVerdict,
  lowVolumeReachedVerdict,
  oooProtectionReachedVerdict,
  laneWatchdogReachedVerdict,
} from "@/lib/monitor/verdict-freshness";
import { LANE_WATCHDOG_UNJUDGED } from "@/lib/monitor/health";
import { createStepRunner } from "@/lib/monitor/step-runner";
import {
  judgeMonitorSteps,
  checksGatedByStep,
  monitorStepFailingAlert,
  monitorStepRecoveryText,
  stepFailingAlertKey,
  MONITOR_STEP_ALERT_COOLDOWN_MS,
  stepFailingRuns,
  stepRearmRuns,
} from "@/lib/monitor/step-failure";
import { recordConsecutiveStreak } from "@/lib/notify/streak";
import { shortErrorReason } from "@/lib/notify/error-text";
import { alertOnStaleLanes } from "@/lib/monitor/lane-watchdog";
import { loadCalcomRetiredCached } from "@/lib/calcom/retirement";
import {
  runCanaryGapFills,
  postWorkflowDispatch,
  countActiveWorkflowRuns,
} from "@/lib/monitor/canary-trigger";
import {
  fetchMainTip,
  fetchRecentRuns,
  fetchRunJobs,
  fetchTipRuns,
  runCiHealthCheck,
} from "@/lib/monitor/github-ci-health";
import { BUILD_COMMIT } from "@/lib/build-info";
import { githubCanaryToken, appUrl, publicSupabaseUrl, publicSupabasePublishableKey } from "@/lib/env";
import {
  runMigrationDriftCheck,
  readAppliedMigrationVersions,
} from "@/lib/monitor/migration-drift";
import {
  CEILING_ALERT_KEY,
  CREDENTIAL_ALERT_KEY,
  LIST_ALERT_KEY,
  judgeRefusalSignals,
  refusalAllClear,
  refusalSignalCopy,
  samplesFromWindow,
  type CeilingLimits,
  type RefusalThresholds,
  embedTripsInWindow,
  judgeEmbedRefusalSignals,
  lockoutReadsNeeded,
  planEmbedRefusalAlerts,
  SHIPPED_REFUSAL_THRESHOLDS,
  type EmbedCapLimits,
} from "@/lib/monitor/api-refusal-signals";
import { SHIPPED_CEILING_LIMITS, SHIPPED_EMBED_CAP_LIMITS } from "@/lib/monitor/refusal-limits";
import { SHIPPED_EMBED_REFUSAL_THRESHOLDS } from "@/lib/monitor/embed-refusal-thresholds";
import { countLockedOutKeys } from "@/lib/monitor/embed-lockouts-store";
import {
  BOOKING_CONTACT_HOURLY_RATE_RULES,
  BOOKING_HOURLY_RATE_RULES,
} from "@/lib/rate-limit-core";
import { SHIPPED_MIGRATION_VERSION } from "@/lib/db/migration-version";
import { runWebhookSubscriberCheck } from "@/lib/monitor/webhook-subscriber-coverage";
import { runHandoffCheck } from "@/lib/handoffs/check";
import { runOwnerNoticeWithheldReport } from "@/lib/monitor/owner-notice-withheld-report";
import { countWithheldOwnerNotices } from "@/lib/monitor/owner-notice-withheld-store";
import { OWNER_ALERT_SKIP_THRESHOLDS, runOwnerAlertSkipsCheck } from "@/lib/monitor/owner-alert-skips";
import { loadRecentOwnerAlerts } from "@/lib/monitor/owner-alert-skips-store";
import {
  loadHandoffBookings,
  loadHandoffChannel,
  loadOpenHandoffs,
  markHandoffNotified,
  recordHandoffNotifyFailure,
  resolveHandoffs,
} from "@/lib/handoffs/store";
import { postSlack } from "@/lib/notify/slack";
import { bookingDetailHref } from "@/lib/booking/detail";
import { runEdgeLimiterCheck } from "@/lib/monitor/edge-limiter-health";
import { runDefinerGrantsCheck, type DefinerFunctionRow } from "@/lib/monitor/definer-grants";
import { runLaneClaimHealthCheck } from "@/lib/monitor/lane-claim-health";
import type { LaneClaim } from "@/lib/monitor/lane-claim";
import { runAuthSignInSurfaceCheck, readAuthSettings } from "@/lib/monitor/auth-sign-in-surface";
import { runAuditChainCheck, type AuditChainRow } from "@/lib/monitor/audit-chain";
import { EDGE_LIMITER_BINDINGS } from "@/lib/rate-limit-core";
import { BURST_LIMITER_BINDING } from "@/lib/rate-limit-burst";
import { isWorkersRuntime, workersRuntimeMarker } from "@/lib/platform/runtime";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { WEBHOOK_EVENTS, deliberatelyUnsubscribedReason } from "@/lib/webhooks/events";
import {
  codedCooldownMs,
  codedTierRecovery,
  codedPoolNearlyFullShare,
  lastKnownMonitorSettings,
  loadMonitorSettings,
  type ResolvedMonitorSettings,
} from "@/lib/monitor/settings";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";
import type { TierDepth } from "@/lib/routing/staffing-depth";
import { runPoolFullnessCheck } from "@/lib/monitor/bucket-fullness";
import { bucketSupplyReport, type CachedSlotRow } from "@/lib/admin/bucket-supply";
import { loadBookedTimes, supplyDepthMap } from "@/lib/admin/bucket-supply-load";
import { runThinTierStaffingCheck } from "@/lib/monitor/thin-tier";
import {
  agentEmailForRetry,
  runCalcomOverrideSweep,
  isRemovalResolved,
  type RemovalCandidate,
  toCandidates,
  type OverrideCandidate,
} from "@/lib/monitor/calcom-override-sweep";
import { syncCalcomOverrides } from "@/lib/ooo/calcom-sync";
import { EFFECTS } from "@/lib/ooo/orchestration";
import {
  missingScheduleAgents,
  runScheduleCoverageCheck,
  usableScheduleUserIds,
  type ScheduleLessAgent,
} from "@/lib/monitor/schedule-coverage";
import {
  runAttributeCoverageCheck,
  findUnroutableAgents,
  type UnroutableAgent,
} from "@/lib/monitor/attribute-coverage";
import { ensureDefaultSchedules } from "@/lib/schedule";
import {
  runSyncStalenessCheck,
  syncRotationCandidates,
  type SyncAgentStaleness,
} from "@/lib/monitor/sync-staleness";
import {
  DEMOTED_AGENT_BOOKINGS_KEY,
  demotedHolders,
  demotedAgentsFrom,
  demotedAgentBookingsSend,
  formatDemotedAgentBookingsAlert,
  formatDemotedAgentBookingsRecovery,
  inactiveHoldersFromBookings,
  runInactiveAgentBookingsCheck,
  sweepHeldBookingIds,
  SWEEP_HELD_ITEM_STATUSES,
  type DemotedAgent,
  type OutOfPoolAgent,
} from "@/lib/monitor/inactive-agent-bookings";
import { redistributeSweepPending } from "@/lib/twilio/roster-plan";
import { demotionSweepPending, storedDemotionStamp } from "@/lib/booking/demotion-plan";
import { criteriaMapOrThrow, type DemotionCandidateRow } from "@/lib/booking/demotion-snapshot";
import {
  countStranded,
  demotionCallsToAsk,
  COVERAGE_PAGE_LEAD_MS,
  decodeSweepCause,
  loadTimeOffWindows,
  runCoverageNeedsHumanCheck,
  strandedHolderNow,
  strandedHoldersFromItems,
  strandedItemReads,
  type CoverageOutAgent,
  type StrandedItemRead,
  type StrandedRead,
} from "@/lib/monitor/coverage-needs-human";
import { selectRetryableUnplaceable } from "@/lib/booking/coverage-retry";
import { POOL_STATE_COLUMNS, type PoolStateRow } from "@/lib/bookable/left-pool";
import { runOooProtectionCheck } from "@/lib/monitor/ooo-protection";
import { primaryMirroredHorizons, runOooEventMismatchCheck } from "@/lib/monitor/ooo-event-mismatch";
import { alertStateNoticeStore, slackMismatchMessenger } from "@/lib/monitor/ooo-mismatch-notices";
import {
  runOooCoverageGapCheck,
  oooCoverageHolders,
  type CoverageGapAgent,
} from "@/lib/monitor/ooo-coverage-gap";
import { ACTIONABLE_ITEM_STATUSES } from "@/lib/booking/bulk-reassign";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import { countHumanOutcomesSince, type OutcomeCountDb } from "@/lib/monitor/regal-call-outcomes-store";
import { ACTIVE_BOOKING_STATUSES, pinnedDemotionBookingIds, readCallsTakenAgain } from "@/lib/booking/bulk-reassign-store";
import { loadOooCoverageBookings, loadSnapshottedBookingIds } from "@/lib/monitor/ooo-coverage-bookings";
import { inIdChunks } from "@/lib/db/id-batch";
import { selectAllPages } from "@/lib/supabase/paginate";
import { REAL_ADVISOR_COLUMNS, realAdvisorsOnly } from "@/lib/advisors/real-advisor";
import type { Attributes, Bucket, BulkReassignJob, Criteria, OooStatus, Role } from "@/lib/db/types";
import { log } from "@/lib/log";
import { groupRulesBySchedule, runUnsetHoursCheck, type UnsetHoursAgent, type HoursSource } from "@/lib/monitor/unset-hours";
import {
  runAwaitingActivationCheck,
  type AwaitingActivationRow,
} from "@/lib/monitor/awaiting-activation";
import { runStrandedHiresCheck, type StrandedHireRow } from "@/lib/monitor/stranded-hires";
import { runLadderDroppedCheck } from "@/lib/monitor/ladder-dropped-advisors";
import { readLadderDroppedLive } from "@/lib/monitor/ladder-dropped-advisors-live";
import { runBelowLeadTierCheck, BELOW_LEAD_TIER_KEY, type BelowLeadTierResult } from "@/lib/monitor/below-lead-tier";
import {
  loadUpcomingBookingsInBuckets,
  loadRoutingContextByBooking,
} from "@/lib/monitor/below-lead-tier-store";
import { runOffsiteOriginCheck, OFFSITE_ORIGIN_LOOKBACK_MS } from "@/lib/monitor/offsite-origin";
import { loadRecentBookingsInBuckets } from "@/lib/monitor/offsite-origin-store";
import { readLeadScores, readRecentSubmissionScores, type LeadXbcRecord } from "@/lib/salesforce/lead-xbc";
import { querySoqlAll, sfToken } from "@/lib/salesforce/rest";
import { pilotSettingsCache } from "@/lib/salesforce/pilot-settings";
import type { OrgDefaults } from "@/lib/schedule-core";

export const dynamic = "force-dynamic";

// Own lock so the monitor lane can't be starved by, or starve, the other lanes
// sharing the every-5-min trigger. Short TTL: the probe is a quick DB-only scan.
const MONITOR_LOCK_TTL_MS = 2 * 60_000;
// Bound the per-bucket eligible-agent reads (matches the Cloudflare connection
// bound used by the other lanes); a hard deadline so a slow scan can't overrun.
const PROBE_CONCURRENCY = 6;
// A bucket_slots row only counts as a real (computed) empty within this window;
// a stale/missing row is the recompute lane's concern, not a booker fault.
const FRESH_WINDOW_MS = 6 * 60_000;
// The urgent data-anomaly page (a dead-end whose cache disagrees with the real
// calendars, or could not be verified) and its all-clear now live together in
// availability-health.ts, which owns DATA_ANOMALY_ALERT_KEY. Cooldowns are
// UI-tunable (#571) via loadMonitorSettings(); the keys stay in code (they are
// alert_state row keys).
// #573: on a data anomaly the monitor rewrites the fresh row so the booker recovers
// at once, but only ONCE per bucket per this window (a DB lock we deliberately do
// NOT release), so a persistent fault keeps paging instead of being silently
// re-masked on every tick.
const ANOMALY_SELFHEAL_WINDOW_MS = 15 * 60_000;

// #1167: a suspected anomaly is re-checked this many more times before it pages,
// so a momentary disagreement (a read landing mid-write) does not wake anyone.
// Two extra checks two seconds apart adds ~4s to a tick that found something, and
// nothing at all to the ordinary healthy tick. Kept well inside the 2-minute lock
// TTL, and the verifier stops at the scan deadline regardless.
const ANOMALY_VERIFY_ATTEMPTS = 2;
const ANOMALY_VERIFY_DELAY_MS = 2_000;
// Above this, skip re-verification and page now: a wide anomaly is an outage
// rather than a blip, and re-reading every bucket would spend a subrequest budget
// this lane shares with three others (complete, watch, bulk-reassign).
const ANOMALY_VERIFY_MAX_BUCKETS = 8;

// --- Customers failing to complete a booking (#1313) ---
// The rolling window and the two gates live in `failure-rate-thresholds.ts`, with
// the measurement they were fitted to (#2484), so the offline suite asserts the
// SHIPPED numbers rather than a copy of them (L63).
const FAILURE_RATE_THRESHOLDS: RateThresholds = SHIPPED_FAILURE_RATE_THRESHOLDS;

// --- The booking API turning its own caller away (#1442, #1450, #1709) ---
//
// Three refusals Slate makes to its own integration, all deliberately OUTSIDE the
// failure share above (counting them there would put a noisy caller's volume in
// the denominator a real outage has to move), and until now visible only as a log
// line with seven days of retention and no alerting on it.
//
// These ship ARMED, unlike the two checks either side of them, and the reason is
// their floors rather than confidence in the numbers. A share check on a quiet
// endpoint is noisy, which is why the failure rate ships disarmed; each of these
// instead needs volume or PERSISTENCE that a quiet endpoint cannot produce: 20
// ceiling refusals at over a tenth of everything sent, or a refusal in three
// separate five-minute intervals. With no traffic they cannot fire.
//
// Shipping them disarmed would mean the notify path never executed even once
// before the day it matters (L535), on checks whose whole purpose is to speak
// where nothing else does. The smoke canary exercises the endpoint with a valid
// key every 30 minutes, so the measured-clear path gets real exercise either way.
//
// The limits the ceiling page names are DERIVED from the rules that actually refuse
// (`refusal-limits.ts`, L41), and the thresholds live beside the judge
// (`SHIPPED_REFUSAL_THRESHOLDS`) so the live verification (#1726) judges with the
// same numbers rather than a copy of them.
const CEILING_LIMITS: CeilingLimits = SHIPPED_CEILING_LIMITS;

// --- The embed booker turning real leads away by its own limits (#1727) ---
//
// The same window and the same rules as the three above, on the surface real leads
// arrive on. The floors are DERIVED from a recorded production measurement
// (`embed-refusal-thresholds.ts`, none of these tripped once in the 167 hours read),
// and the limits each page names are read off the rules that actually refuse (L41).
const EMBED_CAP_LIMITS: EmbedCapLimits = SHIPPED_EMBED_CAP_LIMITS;

const REFUSAL_THRESHOLDS: RefusalThresholds = SHIPPED_REFUSAL_THRESHOLDS;

// --- Are the times we offer actually free (#1315) ---
// One bucket per tick on a rotating cursor, so the whole ladder is covered a few
// times a day while the probe costs about one Google call per tick: a slot is
// offered because SOME eligible agent was believed free, so finding one really
// free agent settles it in the first batched read.
//
// `leadMs` skips the very next slots: those are minutes from being verified on
// book anyway, and a booking landing on one mid-probe would read as drift.
// `minVerified` is what stops a tick that could only read two calendars from
// reaching a verdict at all.
//
// As with #1313, these are a starting point rather than a calibration (there is
// no real customer traffic yet to fit them to), which is why the probe ships
// DISARMED and logs its measured share; #1371 arms it once a real cycle has
// been read.
/**
 * What a step's result is when the step itself failed (#1281).
 *
 * Each one is an EXISTING "could not measure" state rather than a zero, because a
 * contained failure must not present as a measurement: `volume: 0` reads as no
 * bookings and `staleCount: 0` reads as every calendar fresh, which is the exact
 * shape of the false-healthy defect the containment is meant not to introduce.
 */
const UNMEASURED_VOLUME: LowVolumeResult = { status: "unverified" };
const UNMEASURED_PAGE_VOLUME: PageVolumeResult = { status: "unverified" };

const TRUTH_THRESHOLDS: TruthThresholds = {
  leadMs: 10 * 60_000,
  // Not a sample size (#1381). The calendars are read ONCE over the whole horizon
  // whatever this is, and each offered time then costs a local interval
  // comparison, so this is only a runaway guard. Measured 2026-08-11 against 20
  // real agents over 4 days: one Google call, 342 busy intervals back, and 16ms
  // of CPU to judge all 96 offered times (0.16ms each). Re-measured 2026-09-25 at
  // roster scale (#1397): the largest pool is 79 calendars, 4 Google calls and
  // 1123 busy intervals over the 4 day horizon. The read costs one call per 20
  // calendars, so it passes the old shape's 5 only above 100 calendars in one
  // bucket; each read logs `google_calls` so that is visible. 1000 is therefore far
  // above any realistic horizon, and the tick logs `offered` beside `checked` so
  // a truncation is visible rather than reading as full coverage.
  maxSlots: 1000,
  minVerified: 3,
  driftPct: 40,
};

/** Default zone for an agent with no schedule row, matching how the availability
 *  compute treats a scheduleless agent (America/New_York, no working rules). */
const DEFAULT_ZONE = "America/New_York";

// --- Low booking volume (#370) ---
// Outside the org's opening hours low volume is normal, so the alarm stays silent
// (the availability probe above still runs 24/7). The window is the org's OWN
// stored hours, read once at the top of this handler: it used to be a second
// hardcoded copy here, weekdays 1 to 5, and the org is open on SATURDAY, so the
// alarm was blind for a whole open day every week (#1298).
// Expected-minimum booking counts per window are UI-tunable (#571), resolved by
// loadMonitorSettings() with precedence store > env (BOOKING_VOLUME_FLOOR_*) >
// coded default. Arming is now UI-tunable too (#575): loadMonitorSettings resolves
// `lowVolumeArmed` with precedence store > env (BOOKING_VOLUME_ALERT_ARMED) >
// disarmed default, so the cutover flip no longer needs a redeploy.

// The count itself lives in @/lib/monitor/customer-bookings, with its own test:
// it excludes the smoke canary's bookings (#1258), which is the difference between
// measuring customer demand and measuring Slate booking against itself.

/**
 * Every approved absence that has not ended, or null when the read failed (which the
 * sweep treats as unmeasured rather than as nothing to do). The sweep itself decides
 * which of them still need an attempt, in tested code rather than in this query.
 *
 * Bounded by "has not ended" rather than by the outcome, which is what lets a row
 * with NO recorded outcome be seen at all (#1275): nine such absences were approved
 * before the dual-write existed, so they are neither failures nor done, and a query
 * keyed on either word skipped them while those agents stayed bookable in cal.com.
 * Never keyed on `calcom_synced`: 631 approved requests carry no outcome and are long
 * past, so the flag alone selects hundreds of pointless writes. On prod 2026-08-04
 * this predicate returned 44 rows, 35 of them already done.
 */
/**
 * Ceiling on candidates the cal.com override sweep considers per tick.
 *
 * A plain ROW limit, whose constraint is the sweep's own subrequest and CPU share
 * of the 5-minute lane, and deliberately a local number rather than the shared id
 * batching constant it used to borrow (#1321). Nothing here puts ids in a URL, so
 * tying this to the request-URL budget only invited the two to be tuned against
 * each other.
 */
const OVERRIDE_CANDIDATE_ROWS = 200;

async function loadFailedOverrideCandidates(
  db: ReturnType<typeof supabaseAdmin>,
): Promise<OverrideCandidate[] | null> {
  const { data, error } = await db
    .from("ooo_requests")
    .select("id, user_id, starts_at, ends_at, side_effects")
    .eq("status", "approved")
    .gt("ends_at", new Date().toISOString())
    .limit(OVERRIDE_CANDIDATE_ROWS);
  if (error) {
    log.error("calcom-sweep", { msg: "candidate read failed" }, error);
    return null;
  }
  const rows = (data ?? []) as {
    id: string;
    user_id: string;
    starts_at: string;
    ends_at: string;
    side_effects: Record<string, string> | null;
  }[];
  if (rows.length === 0) return [];

  // The agent's email, which is what the override is keyed on in cal.com and what
  // the alert has to name. A separate bounded read rather than an embed, matching
  // the two-reads-joined-in-code convention used elsewhere in this codebase.
  //
  // ACTIVE agents only. Someone who has left cannot be booked by anyone, so an
  // override for them protects nothing and paging to ask for one would be asking for
  // work with no purpose in it. `toCandidates` drops any request whose agent is
  // missing from this map, so the filter here is what decides.
  const { data: users, error: userErr } = await db
    .from("users")
    .select("id, email")
    .in("id", rows.map((r) => r.user_id))
    .is("deactivated_at", null);
  if (userErr) {
    log.error("calcom-sweep", { msg: "candidate email read failed" }, userErr);
    return null;
  }
  const emailById = new Map(
    ((users ?? []) as { id: string; email: string }[]).map((u) => [u.id, u.email]),
  );
  return toCandidates(
    rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      effect: r.side_effects?.[EFFECTS.calcom] ?? "",
    })),
    emailById,
  );
}

/**
 * Re-attempt one request's cal.com override and record what happened, returning the
 * new outcome. Writing the outcome back is what makes the sweep self-clearing: an
 * "ok" or "skipped" no longer matches the failure predicate, so the row leaves the
 * candidate set without any extra bookkeeping.
 *
 * `calcom_synced` is set only on "ok", because it means "an override exists that a
 * cancellation must undo" and a skip wrote nothing.
 */
async function retryOverrideForRequest(
  db: ReturnType<typeof supabaseAdmin>,
  requestId: string,
): Promise<string> {
  const { data, error } = await db
    .from("ooo_requests")
    .select("id, user_id, starts_at, ends_at, side_effects")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !data) return "failed: could not re-read the request";
  const row = data as {
    user_id: string;
    starts_at: string;
    ends_at: string;
    side_effects: Record<string, string> | null;
  };
  // #2383: the read error gets its own outcome, matching the request re-read four
  // lines up. A swallowed `data` here is null, which fell through to "agent has no
  // email", a claim about the agent that nothing measured (L11): it is written
  // into `side_effects` and quoted in the Slack line, sending somebody to fix a
  // roster row that is perfectly fine. The two are told apart by
  // `agentEmailForRetry`, which is where both are proved to stay failures rather
  // than skips, so the row stays in the candidate set and the next tick retries.
  const userRes = await db
    .from("users")
    .select("email")
    .eq("id", row.user_id)
    .maybeSingle();
  const resolved = agentEmailForRetry(
    userRes as { data: { email?: string } | null; error: { message: string } | null },
  );
  if ("outcome" in resolved) return resolved.outcome;
  const email = resolved.email;

  // #2417: the same derivation the approval path uses. A retry that rebuilt the
  // override from this one request alone would reopen the day for an agent whose
  // date carries a second approved absence, which is exactly the population a
  // retry sweep reaches.
  const outcome = await syncCalcomOverrides({
    mode: "add",
    requestId,
    agentUserId: row.user_id,
    agentEmail: email,
    startIso: row.starts_at,
    endIso: row.ends_at,
  });
  const { error: writeErr } = await db
    .from("ooo_requests")
    .update({
      side_effects: { ...(row.side_effects ?? {}), [EFFECTS.calcom]: outcome },
      ...(outcome === "ok" ? { calcom_synced: true } : {}),
    })
    .eq("id", requestId);
  if (writeErr) {
    // The override may well have landed; what failed is recording it. Say so,
    // rather than reporting the cal.com outcome as if it were persisted.
    log.error("calcom-sweep", { msg: "outcome write failed", request_id: requestId }, writeErr);
    return "failed: outcome not recorded";
  }
  return outcome;
}

/**
 * Ceiling on stale cal.com blocks the sweep reads per tick (#2890). A row limit
 * like `OVERRIDE_CANDIDATE_ROWS`; the per tick cap on writes is what bounds the cost.
 */
const STALE_REMOVAL_ROWS = 200;

/**
 * The blocks left in cal.com when time off was cancelled or changed while cal.com
 * was retired (#2890), unresolved and not ended, or null when the read failed (which
 * the sweep reports as unmeasured rather than as none). Oldest window first, so the
 * nearest days are freed first.
 */
async function loadStaleCalcomRemovals(
  db: ReturnType<typeof supabaseAdmin>,
  nowMs: number,
): Promise<RemovalCandidate[] | null> {
  const { data, error } = await db
    .from("calcom_override_removals")
    .select("id, starts_at, ends_at")
    .is("resolved_at", null)
    .gt("ends_at", new Date(nowMs).toISOString())
    .order("starts_at")
    .limit(STALE_REMOVAL_ROWS);
  if (error) {
    log.error("calcom-sweep", { msg: "stale block read failed" }, error);
    return null;
  }
  return ((data ?? []) as { id: string; starts_at: string; ends_at: string }[]).map((r) => ({
    id: r.id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  }));
}

/**
 * Take one stale block out of cal.com and record what happened (#2890), returning
 * the outcome. The dates are rewritten from the agent's CURRENT approved time off,
 * through the same derivation every writer uses (#2417), so a window narrowed while
 * cal.com was retired keeps the days the new window still covers.
 */
async function removeStaleCalcomBlock(
  db: ReturnType<typeof supabaseAdmin>,
  removalId: string,
  nowMs: number,
): Promise<string> {
  const { data, error } = await db
    .from("calcom_override_removals")
    .select("id, user_id, starts_at, ends_at")
    .eq("id", removalId)
    .maybeSingle();
  if (error || !data) return "failed: could not re-read the stale cal.com block";
  const row = data as { user_id: string; starts_at: string; ends_at: string };
  const userRes = await db.from("users").select("email").eq("id", row.user_id).maybeSingle();
  const resolved = agentEmailForRetry(
    userRes as { data: { email?: string } | null; error: { message: string } | null },
  );
  const outcome =
    "outcome" in resolved
      ? resolved.outcome
      : await syncCalcomOverrides({
          mode: "remove",
          // The removal's own id, which names no request, so the read of the
          // agent's other approved time off excludes nothing: every absence that is
          // approved NOW is kept, including this request's new window if it was
          // changed and approved again.
          requestId: removalId,
          agentUserId: row.user_id,
          agentEmail: resolved.email,
          startIso: row.starts_at,
          endIso: row.ends_at,
        });
  const { error: writeErr } = await db
    .from("calcom_override_removals")
    .update({
      last_outcome: outcome,
      resolved_at: isRemovalResolved(outcome) ? new Date(nowMs).toISOString() : null,
    })
    .eq("id", removalId);
  if (writeErr) {
    log.error("calcom-sweep", { msg: "stale block outcome write failed", removal_id: removalId }, writeErr);
    return "failed: outcome not recorded";
  }
  return outcome;
}

/**
 * Availability-health probe (#371). DB-only: for every bucket with an eligible
 * agent ON SHIFT now whose cached slot set is freshly computed yet empty, fire a
 * throttled Slack alert. Catches "agents working but the booker shows no times"
 * (wedged sync, broken schedules, empty cache) — distinct from #327 (zero
 * eligible agents) and the recompute lane's staleness alarm. The on-shift gate is
 * per agent, in the agent's own timezone, so a bucket that is legitimately closed
 * (nobody working) stays silent and non-Eastern shifts are honored.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => NextResponse.json({ error: "unauthorized" }, { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once. The
  // claim is kept, because this lane's own claim is what the `lane_claim_health` step
  // below judges claiming by: the one alert for every lane (lane-claim-health.ts).
  const ownClaim: { claim: LaneClaim | null } = { claim: null };
  const claimed = await claimLaneTick(req.headers, "/api/cron/monitor", (c) => (ownClaim.claim = c));
  if (claimed) return claimed;
  const now = Date.now();

  // lock-overlap: fenced. Two overlapping ticks would post the same booking handoff
  // (it posts, then stamps) and overwrite each other's learned settings. The lease
  // renews before each step, and once another tick holds the key the remaining
  // steps are skipped and named on the cycle line (#3120).
  const lease = await acquireLease("cron_monitor", MONITOR_LOCK_TTL_MS);
  if (!lease) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    // Every check below runs inside its OWN boundary and is timed on its own
    // (#1281 + #1277). Thirteen checks used to share one try block with four
    // catches between them, so an unexpected throw in any unguarded step skipped
    // every step under it: a broken migration check disabled the availability
    // probe and the cal.com override sweep, both of which exist to catch
    // customer-visible problems. And no step recorded its cost, so a degrading
    // shared budget surfaced in whichever check was most sensitive rather than in
    // the one spending it (#1245 took three days to notice for that reason).
    // Knowing which step failed and knowing what each cost want the same
    // structure, so there is one runner.
    //
    // #2382: the runner CONTAINS a throw, and until now that was the end of it.
    // The name went into a seven day log nobody is paged from, the heartbeat was
    // stamped anyway, and a check that threw on every tick for a month reported
    // nothing while the lane looked healthy. So the reason is kept here as well,
    // already shortened for a phone (#1135), and the streak below decides when a
    // step that keeps failing gets to speak.
    const stepFailureReasons = new Map<string, string>();
    const steps = createStepRunner({
      now: () => performance.now(),
      stillHeld: lease.stillHeld,
      onError: (name, err) => {
        stepFailureReasons.set(name, shortErrorReason(err));
        log.error("monitor", { msg: "step failed", step: name }, err);
      },
    });
    const db = supabaseAdmin();
    // UI-tunable cooldowns, arming switches and low volume floors (#571). A setup
    // read like the ones below, and contained the same way (#2773). The read throws
    // rather than resolving to the defaults, because every switch defaults to OFF and
    // that fallback silently disarmed half this lane. On a failure the step falls
    // back to the LAST KNOWN settings in this isolate, and still records a failure,
    // so a sustained outage pages through `monitor_step_failing:setup_settings`
    // while the last known value carries the tick. With nothing known it is null,
    // and `monitorSetupGates` stands down every check whose decision to page rests
    // on a switch or a floor.
    const settings = await steps.run<ResolvedMonitorSettings | null>("setup_settings", lastKnownMonitorSettings(), () => loadMonitorSettings(),
    );
    // The one exception, and why: a cooldown only paces an alarm that has already
    // decided to fire, so no value of it can disarm anything. A check that needs
    // only a cooldown keeps running on the coded ones rather than going dark.
    const cooldownMs = settings?.cooldownMs ?? codedCooldownMs();

    // --- The shared setup reads, each in its OWN boundary (#1395) -------------
    // These five used to sit above every boundary, so a throw in any one of them
    // ended the tick before a single check ran. Each is contained now, and each
    // failure resolves to NULL rather than to an empty or default value, because
    // the fallback is the whole risk here: zero buckets, an empty week, or a
    // guessed horizon would each let a check judge and be confidently wrong, where
    // null makes only its dependents skip and say so. monitorSetupGates owns which
    // check depends on what.
    const buckets = await steps.run<Bucket[] | null>("setup_buckets", null, async () =>
      // unwrap, not `.data ?? []`: an empty bucket list reads as a fleet with no
      // buckets at all, so a failed read here used to make the whole ladder look
      // like a dead end and page for it (#277's shape).
      unwrap(await db.from("buckets").select("*"), "monitor buckets") as Bucket[],
    );

    // bucket_slots health in one scan: slot count + freshness per code.
    // One read serves both the slot health checks and the nearly full pool report,
    // so its row type is both of theirs: a change to either shape fails to compile
    // here rather than being read as missing fields.
    const slotRows = await steps.run<(SlotHealthRow & CachedSlotRow)[] | null>("setup_slot_rows", null, async () =>
      unwrap(
        await db.from("bucket_slots").select("bucket_code, payload, computed_at"),
        "monitor bucket_slots",
      ) as (SlotHealthRow & CachedSlotRow)[],
    );
    // #1169: fail closed. An unparseable computed_at reads as epoch 0 (stale,
    // canary alerts), never NaN (reads as fresh, canary silent). Extracted in
    // #1171 so that direction is pinned by scripts/test-monitor-slot-health.ts
    // instead of living untested inside the route.
    // #1296: count what the booker SERVES, not what is stored. The read path
    // filters cached slots to the org's current hours, so for up to one recompute
    // cycle the stored payload holds slots no lead is being offered; counting those
    // would be measuring a list nobody sees. An unreadable week is not something to
    // guess at either, so the availability scan sits this tick out entirely (below)
    // rather than judging with the wrong window.
    const businessHours = await steps.run<BusinessHours | null>(
      "setup_business_hours",
      null,
      () => loadBusinessHours(),
    );
    // null means DO NOT SCAN. Deliberately not an empty map: that would read as
    // zero slots for every bucket and page the whole ladder off a failed config read.
    const slotByCode = slotRows === null ? null : slotHealthForTick(slotRows, businessHours);

    // Per-agent working hours, for the on-shift gate. Two whole-table reads
    // joined in JS; both are paged past PostgREST's 1,000-row cap (#828): the
    // rules table alone crosses 1,000 at full roster, and a truncated read would
    // silently mis-judge who is on shift.
    const workingHours = await steps.run("setup_hours", null, () => loadAllWorkingHours(db));
    const scheduleByUser = new Map(
      (workingHours?.schedules ?? []).map((s) => [s.user_id, { id: s.id, timezone: s.timezone }]),
    );
    const rulesBySchedule = new Map<string, WorkingRule[]>();
    for (const r of workingHours?.rules ?? []) {
      const list = rulesBySchedule.get(r.schedule_id) ?? [];
      list.push({ weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute });
      rulesBySchedule.set(r.schedule_id, list);
    }
    // Only ever called from the availability scan, which the gate below stops from
    // running at all when `workingHours` is null. So this can never hand out the
    // "no rules" default on the strength of a failed read, which would make every
    // agent look off shift and every bucket read as a dead end.
    const shiftFor = (userId: string) => {
      const s = scheduleByUser.get(userId);
      return {
        timezone: s?.timezone ?? DEFAULT_ZONE,
        rules: s ? rulesBySchedule.get(s.id) ?? [] : [],
      };
    };

    // The scan orchestration (probe, classify, recompute-verify, self-heal, page /
    // whisper / all-clear) lives in runAvailabilityScan (#1158), tested directly in
    // scripts/test-monitor-availability-scan.ts. The route only wires the IO.
    // Probe the SAME window the rows are computed over (#216): comparing a 4-day
    // probe against a 7-day row would flag a false data anomaly. Loaded once and
    // reused by the self-heal.
    // `readBookingHorizonDays`, not `loadBookingHorizonDays` (#1654). The gate
    // below could never fire while this read swallowed its own error and returned
    // the coded default: the step never failed, `horizonDays` was never null, and
    // the lane was already measuring against a guessed horizon while reading as
    // if it refused to (L109). The step boundary stays, because the read can
    // still throw for reasons the reader does not catch.
    const horizonDays = await steps.run<number | null>("setup_horizon", null, () =>
      readBookingHorizonDays(),
    );
    // #3922: how many open days a lead is offered, a stored setting now. Read at
    // most once a tick and only by the two checks that judge the offered window
    // (tier staffing and the nearly full whisper), inside their own step
    // boundaries. The honest read: it resolves to null on a failed read, never to
    // a default, and each check then judges nothing rather than judging over a
    // guessed window (L215). It never rejects, so sharing the promise cannot carry
    // one step's failure into the other.
    let offeredDaysOnce: Promise<number | null> | null = null;
    const offeredDaysForTick = () => (offeredDaysOnce ??= readOfferedOpenDays());
    const bucketByCode = new Map((buckets ?? []).map((b) => [b.code, b]));

    // Which checks this tick is entitled to run, given what came back. Decided in
    // one pure place so the dependency lists sit beside each other rather than as
    // five conditionals spread down the handler.
    const gates = monitorSetupGates({
      buckets: buckets !== null,
      slotHealth: slotByCode !== null,
      businessHours: businessHours !== null,
      workingHours: workingHours !== null,
      horizonDays: horizonDays !== null,
      settings: settings !== null,
    });
    if (!gates.availabilityScan.run) {
      log.warn("monitor", { msg: "availability scan skipped", why: gates.availabilityScan.why });
    }
    if (!gates.availabilityTruth.run) {
      log.warn("monitor", { msg: "availability truth skipped", why: gates.availabilityTruth.why });
    }
    // --- Can the booker still say WHY a week is empty (#1420)? When it cannot, the
    // lead is shown "We could not work out what is available right now", which is
    // honest and is exactly why the fault was invisible: nothing paged and the
    // funnel simply got quieter. Measured HERE rather than on the availability read,
    // because that would only conclude when a lead is present, and before cutover
    // there are none, so the detector would have shipped blind and looked identical
    // to one finding nothing wrong (#1394).
    //
    // Deliberately NOT behind `gates`: every other consumer of these two reads skips
    // when they fail, because judging on a guessed week is worse than not judging.
    // Here the reads ARE the subject, so an unreadable one is the finding, and a gate
    // would silence the check in exactly the state it exists to notice. ---
    const emptyReasonHealth = await steps.run("empty_reason", null, () =>
      runEmptyReasonCheck({
        // #2158: null, not zero. This check asks whether the classifier can still
        // work out a reason from the WEEK, and has no bucket in hand; a zero here
        // would make it assert that nobody works anywhere, on no measurement at all.
        inputs: { hours: businessHours, horizonDays, nowMs: now, pooledAgents: null },
        streak: () =>
          recordFailureStreak(EMPTY_REASON_STREAK_KEY, EMPTY_REASON_STREAK_WINDOW_S),
        clearStreak: () => clearFailureStreak(EMPTY_REASON_STREAK_KEY),
        // alert-key: booker_empty_reason
        notify: sendThrottledAlert,
        // alert-key: booker_empty_reason
        // all-clear-proof: scripts/test-monitor-empty-reason.ts - a tick that could
        // not read its inputs clears nothing, in either direction.
        resolve: resolveAlert,
        cooldownMs: cooldownMs.booker_empty_reason,
        log: (m) => log.warn("empty-reason", { msg: m }),
      }),
    );

    // --- Does anyone actually work the hours we advertise (#1454)? The org says it
    // is open 08:00 to 20:00 Monday to Saturday and every roster runs 08:00 to 17:00
    // Monday to Friday, so a quarter of the advertised week, and the whole of
    // Saturday, is offered to leads with nobody able to take the call. Nothing
    // noticed, because `emptyReason` calls an open day that produced no times
    // "busy", which conflates "genuinely full" with "nobody rostered": opposite
    // problems arriving as the same word.
    //
    // Coverage is computed by the SAME loader and predicate the business hours
    // editor renders from, so the screen and the alarm cannot disagree about who
    // covers what (L107). Gated on the business-hours read: with no advertised week
    // there is nothing to hold the roster against. The roster read throws rather
    // than degrading, and steps.run turns that into a failed step, so an unreadable
    // pool skips instead of reporting the whole week uncovered.
    //
    // The range is today through the booking horizon plus a week (#1936), not the
    // calendar week it happens to be: a Monday to Sunday window gave hours of
    // warning on a Saturday and could never see the next Saturday at all. A gap a
    // lead can reach now raises the live key; one past the horizon raises the
    // upcoming key, which says there is still time. Each clears off its own range.
    // Armed by `roster_coverage_armed` (#1456). ---
    const rosterCoverage = await steps.run("roster_coverage", null, async (step) => {
      if (!gates.rosterCoverage.run || !businessHours) return step.unmeasured(null);
      const agents = await loadCoverageAgents(db);
      return runRosterCoverageCheck({
        coverage: coverageForRange({ hours: businessHours, agents, horizonDays, nowMs: now }),
        armed: settings!.rosterCoverageArmed,
        // alert-key: roster_coverage_gap
        // alert-key: roster_coverage_upcoming_gap
        notify: sendThrottledAlert,
        // alert-key: roster_coverage_gap
        // alert-key: roster_coverage_upcoming_gap
        // all-clear-proof: scripts/test-roster-coverage-horizon.ts - a tick that could
        // not read the roster, the hours or the horizon neither pages nor clears.
        resolve: resolveAlert,
        cooldownMs: {
          live: cooldownMs.roster_coverage_gap,
          upcoming: cooldownMs.roster_coverage_upcoming_gap,
        },
        log: (m) => log.warn("roster-coverage", { msg: m }),
      });
    });
    if (!gates.rosterCoverage.run) {
      log.warn("monitor", { msg: "roster coverage skipped", why: gates.rosterCoverage.why });
    }

    // --- Has somebody stopped public booking and left it that way (#2366)? ---
    //
    // #2297 made the kill switch visible on the admin Overview, which helps whoever
    // looks. This is the half that raises a hand at whoever does not: bookings
    // stopped at 2am to contain a problem, the problem fixed, the switch forgotten.
    // Every other signal reads healthy meanwhile, because everything else IS healthy,
    // and the thing that eventually notices is the low booking volume alarm, which
    // reports a drought and sends the reader after a funnel problem that is not there.
    //
    // The elapsed time comes from `public_booking_paused_at`, stamped by the database
    // at the transition (migration 0132), never from when this lane first noticed: a
    // deploy or a lane restart would otherwise reset the count and the notice would
    // never fire.
    //
    // The read THROWS rather than answering null, so the step boundary reports it
    // under `monitor_step_failing` and the fallback below renders `unreadable`: a run
    // that could not measure must not look like one that measured and found the
    // switch off. Its own boundary like every other check, so an unreadable settings
    // row cannot cancel the checks after it (L73). ---
    const bookingPause = await steps.run<BookingPauseVerdict>(
      "booking_pause",
      BOOKING_PAUSE_UNREADABLE,
      async () =>
        runBookingPauseCheck({
          reading: await readPublicBookingPauseState(),
          nowMs: now,
          // Null when the week could not be read, and the check errs toward speaking
          // on it: the hours decide WHEN to say a stopped switch has stood too long,
          // never whether there is anything to say. Judged through the same predicate
          // the volume alarm uses, so the two cannot disagree about whether the org
          // is open (L41).
          open: businessHours
            ? isBusinessHours(now, {
                zone: businessHours.zone,
                rules: businessHours.rules,
                exceptions: businessHours.exceptions,
              })
            : null,
          thresholdMs: PAUSE_NOTICE_AFTER_MS,
          // alert-key: public_booking_stopped
          // The key is passed by the pure check rather than written here, so it is
          // declared instead of being read off this call.
          // alert-text-ok: our own copy from booking-pause.ts, built from a measured
          // span; no error text can reach it.
          notify: (key, cooldownMs, text, repeat) => sendThrottledAlert(key, cooldownMs, text, repeat),
          // alert-key: public_booking_stopped
          // all-clear-proof: scripts/test-monitor-booking-pause.ts - a tick that is
          // itself reporting the stopped switch, and a tick holding under the
          // threshold, each clear NOTHING; only a tick that READ the flag as false
          // does, and a tick whose read threw never reaches the check at all.
          resolve: (key, text) => resolveAlert(key, text),
          cooldownMs: cooldownMs.public_booking_stopped,
          log: (m) => log.warn("booking-pause", { msg: m }),
        }),
    );

    // --- Was the shared confirm line switched on, and then left OFF (#3339)? ---
    //
    // The same shape as the kill switch above, on the other switch the admin Hours page
    // holds. Once the shared line is on, turning it off is the lever for containing a line
    // problem, and the failure is forgetting to turn it back: every server keeps its own
    // line again and the next crowd for one time swamps the database, with everything
    // else reading healthy. Until the line has EVER been switched on, off is the expected
    // state and says nothing; when it was activated comes from the audit trail the admin
    // action writes, read inside the loader.
    //
    // The read THROWS rather than answering "never switched on", so the step boundary
    // reports it under `monitor_step_failing` (which is also the lane's measure of a
    // switch nobody can read) and the fallback renders `unreadable`. ---
    const sharedLineLeftOff = await steps.run<SharedLineLeftOffVerdict>(
      "shared_line_left_off",
      SHARED_LINE_LEFT_OFF_UNREADABLE,
      async () =>
        runSharedLineLeftOffCheck({
          reading: await readSharedLineSwitchHistory(),
          nowMs: now,
          // Judged through the same predicate as the kill switch above, so the two never
          // disagree about whether the org is open (L41); null errs toward speaking.
          open: businessHours
            ? isBusinessHours(now, {
                zone: businessHours.zone,
                rules: businessHours.rules,
                exceptions: businessHours.exceptions,
              })
            : null,
          thresholdMs: SHARED_LINE_OFF_NOTICE_AFTER_MS,
          // alert-key: shared_confirm_line_left_off
          // alert-text-ok: our own copy from shared-line-left-off.ts, built from a measured
          // span; no error text can reach it.
          notify: (key, cooldownMs, text, repeat) => sendThrottledAlert(key, cooldownMs, text, repeat),
          // alert-key: shared_confirm_line_left_off
          // all-clear-proof: scripts/test-monitor-shared-line-left-off.ts - a tick reporting
          // the switch off, one holding under the threshold, and one that has never seen it
          // switched on each clear NOTHING; only a tick that READ it on does.
          resolve: (key, text) => resolveAlert(key, text),
          cooldownMs: cooldownMs.shared_confirm_line_left_off,
          log: (m) => log.warn("shared-line-left-off", { msg: m }),
        }),
    );

    // --- Can a lead in each DEBT TIER actually get a time? (#2505) ---
    //
    // The unit is the debt tier, not the bucket. Dan, 2026-09-17: "I only want to
    // be paged if there are literally no (for example) ultra high agents staffed.
    // or no medium agents, etc." A bucket or a backend with nobody in it is not a
    // customer problem while the rest of its tier can take the lead, and since
    // #2486 the ladder tries every bucket in the tier before dropping one.
    //
    // And the trigger is SLOTS, not rostered hours, which is the other half of the
    // same call: "maybe it doesn't matter if nobody is staffed at a specific point
    // because we just don't offer that time slot." If nobody works Saturday, Slate
    // offers no Saturday and the lead books Monday. Nothing is broken, so nothing
    // pages. What the alarm asks is whether the tier is offering a time inside the
    // days the booker SHOWS a lead (#3559): `offeredWindowFor` over the tier pool's
    // own notice, read off its cached row, so a closed Sunday and the 6pm cutoff
    // apply here exactly as they do on the strip.
    //
    // Asked per tier and NEVER through the ladder. After #2486 a lead whose tier is
    // dry falls to a lower one, so "can this lead book" is almost always yes, and a
    // ladder aware question would mute exactly the Ultra High case this exists to
    // report.
    //
    // The roster read is inside this boundary rather than a shared setup read,
    // because nothing else needs it: a throw here fails this step alone, stamps no
    // verdict, and the freshness watch is what says so. ---
    const tierStaffing = await steps.run("tier_staffing", null, async (step) => {
      if (!gates.tierStaffing.run) return step.unmeasured(null);
      const tierAgentIds = await loadTierAgentIds();
      // Non-null inside here: the gate refuses to run without the week or the
      // slot rows. A tier whose window cannot be worked out (no cached row, an
      // unreadable notice, no open day ahead) is unmeasured on its own, rather
      // than judged against a guessed window (L215).
      const windows = tierWindows({
        rows: slotRows!,
        hours: businessHours!,
        nowMs: now,
        offeredOpenDays: await offeredDaysForTick(),
      });
      const readings = tierReadings({
        agentCounts: tierAgentCounts(tierAgentIds),
        slotByCode: slotByCode!,
        windows,
      });
      const plan = planTierAlerts(readings);
      log.info("monitor", {
        msg: "tier staffing",
        paged: plan.page.length,
        recovered: plan.recovered.length,
        unmeasured: plan.unmeasured.length,
        windows: [...windows]
          .map(([tier, w]) => `${tier}:${w.measured ? w.days.join("+") : "unmeasured"}`)
          .join(","),
      });
      // Why a tier has no times (#3037), worked out per agent from three reads.
      // `tierNoSlotsPageText` asks the cooldown FIRST, so the reads run only on a
      // tick whose page will actually go out (they spend a budget four cron lanes
      // share), and turns any failure into the old wording plus a clause saying
      // the cause could not be read: never silence, never a guessed cause (L215,
      // L11). The failure itself is logged with its error.
      const loadCauseInput = async (t: { tier: string; windowEndMs: number; days: string[] }): Promise<TierCauseInput> => {
        if (workingHours === null) throw new Error("the agents' working hours could not be read");
        if (buckets === null) throw new Error("the bucket list could not be read");
        const { tier, windowEndMs, days } = t;
        const agentIds = tierAgentIds.get(tier) ?? [];
        const reads = await loadTierCauseReads({ tier, agentIds, buckets, nowMs: now, windowEndMs });
        const hours = businessHours!;
        return {
          agents: tierCauseAgents({ agentIds, shiftFor, calendars: reads.calendars, busy: reads.busy }),
          slot: {
            durationMin: reads.eventType.duration_min,
            bufferBeforeMin: reads.eventType.buffer_before_min,
            bufferAfterMin: reads.eventType.buffer_after_min,
            minNoticeMin: reads.eventType.min_notice_min,
            dailyCap: reads.eventType.daily_cap,
            businessHours: hours,
          },
          slotIntervalMin: reads.eventType.slot_interval_min,
          businessHours: hours,
          nowMs: now,
          windowEndMs,
          days,
        };
      };
      for (const t of plan.page) {
        const key = tierStaffingKey(t.tier);
        const text =
          t.kind === "unstaffed"
            ? tierUnstaffedMessage(t)
            : await tierNoSlotsPageText(t, {
                isDue: () => isAlertDue(key, cooldownMs.empty_tier, now),
                loadCauseInput: () => loadCauseInput(t),
                onCauseError: (err) => log.warn("monitor", { msg: "tier cause unreadable", tier: t.tier }, err),
              });
        // Inside its cooldown: the send would drop it, so it was never built.
        if (text === null) continue;
        // alert-text-ok: our own copy from tier-staffing.ts, built from measured
        // counts and the diagnosis's own tallies; no error text can reach it.
        // alert-key: empty_tier:*
        await sendThrottledAlert(key, cooldownMs.empty_tier, text).catch(logAlertSendFailure(key));
      }
      // When a page may END (#3227). A tier offering one time is not recovered: on
      // 2026-10-04 one cancelled Low call cleared the page, and since an all clear
      // resets the cooldown, the next booking of that time paged again at once.
      // So the all clear waits until the tier offers the recovered count inside
      // the window AND has held it for the hold, both set on /admin/alerts.
      //
      // Driven by the MEASURED healthy tiers, never by "we did not page this one":
      // a tier whose reads failed is in no list, and an unreadable alert state
      // concludes nothing for any tier, so a recovery is never announced, and a
      // hold never started or reset, off a tick that did not look (#1134, #1152).
      const recoveryPolicy = settings?.tierRecovery ?? codedTierRecovery();
      const { recovery } = await settleTierRecovery(plan, recoveryPolicy, now, {
        loadState: () => loadTierAlertState(DEBT_TIERS),
        startHolds: startTierHolds,
        clearHolds: clearTierHolds,
        // alert-key: empty_tier:*
        // all-clear-proof: scripts/test-tier-staffing.ts drives planTierAlerts,
        // planTierRecovery and settleTierRecovery with each read failed in turn and
        // pins that nothing clears.
        resolve: (key, text) => resolveAlert(key, text),
        warn: (msg, err) => log.warn("monitor", { msg }, err),
      });
      log.info("monitor", {
        msg: "tier recovery",
        holding: recovery.holding.map((h) => `${h.tier}:${h.openTimes}:${Math.round(h.heldMs / 60_000)}m`).join(",") || null,
        short: recovery.short.map((h) => `${h.tier}:${h.openTimes}`).join(",") || null,
        all_clear: recovery.allClear.map((t) => t.tier).join(",") || null,
        min_open_times: recoveryPolicy.minOpenTimes,
        hold_min: recoveryPolicy.holdMs / 60_000,
      });
      return plan;
    });
    if (!gates.tierStaffing.run) {
      log.warn("monitor", { msg: "tier staffing skipped", why: gates.tierStaffing.why });
    }

    // Skipped entirely when the week could not be read (#1296). An empty slot map
    // would make every bucket read as zero and page the whole ladder, and clearing
    // an alert off a tick that measured nothing is the #1152 defect: a run that
    // could not read its signal must conclude nothing, in either direction.
    const scan = await steps.run("avail_scan", null, async (step) =>
      !gates.availabilityScan.run
        ? step.unmeasured(null)
        : runAvailabilityScan({
          nowMs: now,
          freshWindowMs: FRESH_WINDOW_MS,
          probeConcurrency: PROBE_CONCURRENCY,
          deadlineMs: now + MONITOR_LOCK_TTL_MS,
          // Non-null inside here: the gate above refuses to run this scan unless
          // every one of its five setup reads came back.
          buckets: buckets!.map((b) => ({ code: b.code, isTest: b.is_test ?? false })),
          slotByCode: slotByCode!,
          ladder: tierLadder,
          nameOf: (code) => bucketSpecForXbc(code)?.name ?? code,
          eligibleIds: async (code) => {
            const bucket = bucketByCode.get(code);
            if (!bucket) return [];
            const { ids } = await eligibleAgentIdsCached(bucket);
            return ids;
          },
          shiftFor,
          // #1296: an agent rostered past the org's close is not "should be showing
          // times". Without this, closing the org would page as if the cache were
          // wedged. Non-null here because the scan is skipped when the week is unreadable.
          businessHours: { timezone: businessHours!.zone, rules: businessHours!.rules },
          // Live recompute from the DB (busy_blocks/bookings/schedules, no Google);
          // a falsy result or a throw is null (unverified), never a fake zero.
          recomputeSlots: async (code) => {
            const { fromIso, toIso } = slotCacheKey(code, new Date(now).toISOString(), horizonDays!);
            const res = await getBucketSlots(code, fromIso, toIso);
            return res ? res.slots.length : null;
          },
          // #1167: re-check a suspected anomaly before paging. `cachedSlots` must be a
          // FRESH single-row read, not the slotByCode map above: that map is the side
          // of the comparison suspected of being wrong, so re-reading it would just
          // repeat the same answer. Routed through slotHealthByCode so an unreadable
          // computed_at fails the same way here as in the scan (#1171).
          verify: {
            attempts: ANOMALY_VERIFY_ATTEMPTS,
            delayMs: ANOMALY_VERIFY_DELAY_MS,
            maxBuckets: ANOMALY_VERIFY_MAX_BUCKETS,
            cachedSlots: async (code) => {
              // cap-safe: bucket_code is unique in bucket_slots, so this is one row.
              const { data, error } = await db
                .from("bucket_slots")
                .select("bucket_code, payload, computed_at")
                .eq("bucket_code", code)
                .maybeSingle();
              // A read we could not do must read as unknown, never as a healthy zero:
              // the verifier treats null as inconclusive and keeps the finding.
              if (error) return null;
              if (!data) return 0;
              // businessHours is non-null here: the scan only runs when it read (below).
              return slotHealthByCode([data as SlotHealthRow], businessHours!).get(code)?.slotCount ?? null;
            },
            wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          },
          claimHeal: async (code) =>
            // lock-overlap: deliberately never released: it is a once per bucket
            // cooldown, and the heal it gates writes slots through the compute start
            // compare and swap, so a heal after the window cannot overwrite fresher
            // slots.
            (await acquireLock(`anomaly_selfheal:${code}`, ANOMALY_SELFHEAL_WINDOW_MS)) !== null,
          heal: (code) => recomputeBucketSlotsForToday(code, "monitor-heal", true, undefined, horizonDays!),
          onHealError: (code, err) =>
            log.error("monitor", { msg: "anomaly self-heal failed", bucket: code }, err),
          // alert-key: availability_data_anomaly
          // alert-key: availability_booked_solid
          notify: sendThrottledAlert,
          // alert-key: fallback_covered_availability
          info: sendThrottledInfo,
          // alert-key: availability_data_anomaly
          // alert-key: availability_booked_solid
          // all-clear-proof: scripts/test-monitor-availability-scan.ts - a truncated
          // scan sends no all-clear for EITHER condition, and a paging tick does not
          // also all-clear the page it is sending.
          resolve: resolveAlert,
          cooldownMs: {
            dataAnomaly: cooldownMs.availability_data_anomaly,
            bookedSolid: cooldownMs.availability_booked_solid,
            fallbackCovered: cooldownMs.fallback_covered_availability,
          },
          log: (fields) => log.info("monitor", { msg: "availability scan", ...fields }),
        }),
    );
    if (scan?.cleared) log.info("monitor", { msg: "availability anomaly alert cleared" });
    const page = scan?.page ?? [];
    const covered = scan?.covered ?? [];
    const truncated = scan?.truncated ?? false;

    // --- Low booking volume (#370): only during business hours; disarmed until
    // cutover (counts + logs but does not alert) so the ramp can't cry wolf.
    // Extracted and tested (#1158): a failed count read reports unverified
    // rather than paging a false zero. ---
    const volume: LowVolumeResult = !gates.lowVolume.run
      ? UNMEASURED_VOLUME
      : await steps.run("volume", UNMEASURED_VOLUME, (step) =>
      runLowVolumeCheck({
        nowMs: now,
        // Non-null by the gate above: the check does not run without this read.
        businessHours: {
          zone: businessHours!.zone,
          rules: businessHours!.rules,
          // #1363: so a holiday closure reads as shut here too, rather than as a
          // day the funnel mysteriously stopped delivering.
          exceptions: businessHours!.exceptions,
        },
        // #2874: Low's own bookings, the tier these floors describe, so another tier
        // joining the pilot can never hold this count up.
        countSince: (sinceIso) => countCustomerBookingsSince(db, sinceIso, LOW_TIER),
        // #1956: the measured floors for THIS weekday and hour, each carrying where
        // it came from so a page can say whether it is the measurement or an override.
        floors: judgedFloors(floorsFor(settings!.floors, now)),
        armed: settings!.lowVolumeArmed,
        cooldownMs: cooldownMs.low_booking_volume,
        // alert-key: low_booking_volume
        // The key is passed by the pure check, not written here, so the coverage
        // scanner cannot read it off this call: it is declared instead (#1390).
        // alert-text-ok: our own copy from booking-volume.ts, built from measured
        // counts; no error text can reach it.
        notify: (key, cooldownMs, text, repeat) => sendThrottledAlert(key, cooldownMs, text, repeat),
        notifyCountUnreadable: (key, cooldownMs, text) => {
          // alert-key: volume_count_unreadable
          // alert-text-ok: our own copy from booking-volume.ts, with no error
          // interpolated: the detail belongs in the lane's logs.
          return sendThrottledAlert(key, cooldownMs, text);
        },
        // alert-key: volume_count_unreadable
        // alert-key: low_booking_volume
        // alert-key: low_volume_verdict_gap
        // all-clear-proof: scripts/test-monitor-booking-volume.ts - pins that a tick
        // which could not read the count, a tick outside business hours that read
        // nothing at all, and a tick that is itself PAGING a breach each clear
        // NOTHING about volume.
        resolveRecovered: (recovered) => resolveRecovered(recovered),
        log: (fields) => log.info("monitor", { msg: "booking volume", ...fields }),
      }).then((r) => (r.status === "outside-hours" ? step.unmeasured(r) : r)),
    );

    // --- The volume alarm's verdict gap (#2049): an hour of OPEN business time
    // with no verdict pages, which the flat 4 day verdict bound cannot see. Runs
    // under the same gate as the check (a stood down check is named by the step
    // streak instead), and reads the stamp only on a tick that did not conclude
    // while the org is open, so the healthy tick costs nothing. ---
    const volumeVerdictGap: VolumeVerdictGapResult | null = !gates.lowVolume.run
      ? null
      : await steps.run("volume_verdict_gap", null, (step) =>
      runVolumeVerdictGapCheck({
        nowMs: now,
        // Non-null by the gate above, as for the check itself.
        businessHours: {
          zone: businessHours!.zone,
          rules: businessHours!.rules,
          exceptions: businessHours!.exceptions,
        },
        volume,
        // Strict: a failed read throws into this step's boundary and its streak
        // pages, rather than reading as a lane that has never stamped.
        readLastVerdictMs: () => readHeartbeatMsStrict(LOW_VOLUME_VERDICT_LANE),
        // alert-key: low_volume_verdict_gap
        // alert-text-ok: our own copy from volume-verdict-gap.ts, built from a
        // count of minutes and a stamp; no error text can reach it.
        notify: (key, cooldownMs, text, repeat) => sendThrottledAlert(key, cooldownMs, text, repeat),
        log: (fields) => log.info("monitor", { msg: "volume verdict gap", ...fields }),
      }).then((r) => (r.status === "closed" ? step.unmeasured(r) : r)),
    );
    if (volumeVerdictGap?.status === "gap") {
      log.warn("monitor", { msg: "volume verdict gap paged", open_minutes: volumeVerdictGap.openMinutes });
    }

    // --- Low booking volume for every OTHER tier Slate carries (#2874) ---
    // Which tiers those are is derived from the bookings Slate takes, and each is
    // judged only once its own bookings have been learned (`resolveTierBaselines`),
    // so widening the pilot to a new tier needs no code change and no refit by hand:
    // four weeks after that tier's first real booking it is judged here on its own
    // key. Same hours gate, arming switch and cooldown as Low. A tier carried and not
    // yet learned is not in the list, and /admin/alerts says it is not judged.
    if (gates.lowVolume.run) {
      await steps.run("tier_volume", null, (step) =>
        runTierVolumeChecks({
          nowMs: now,
          // Non-null by the gate above: the check does not run without this read.
          businessHours: {
            zone: businessHours!.zone,
            rules: businessHours!.rules,
            exceptions: businessHours!.exceptions,
          },
          baselines: settings!.tierBaselines,
          countSince: (tier, sinceIso) => countCustomerBookingsSince(db, sinceIso, tier),
          armed: settings!.lowVolumeArmed,
          cooldownMs: cooldownMs.low_booking_volume,
          // alert-key: low_tier_volume:*
          // alert-key: tier_volume_check_failed:*
          // alert-text-ok: our own copy from booking-volume.ts, built from measured
          // counts and the tier's own name; no error text can reach it (a tier's
          // thrown error goes to the log through logError below).
          notify: (key, cooldownMs, text, repeat) => sendThrottledAlert(key, cooldownMs, text, repeat),
          notifyCountUnreadable: (key, cooldownMs, text) => {
            // alert-key: volume_count_unreadable:*
            // alert-text-ok: our own copy from booking-volume.ts, with no error
            // interpolated: the detail belongs in the lane's logs.
            return sendThrottledAlert(key, cooldownMs, text);
          },
          // alert-key: volume_count_unreadable:*
          // alert-key: low_tier_volume:*
          // alert-key: tier_volume_check_failed:*
          // all-clear-proof: scripts/test-monitor-booking-volume.ts - pins that a
          // tier's reading clears only that tier's own page, and nothing of Low's.
          resolveRecovered: (recovered) => resolveRecovered(recovered),
          log: (fields) => log.info("monitor", { msg: "tier booking volume", ...fields }),
          logError: (fields, err) => log.error("monitor", fields, err instanceof Error ? err : undefined),
        }).then((byTier) =>
          // No tier judged (the org is closed, or none is learned yet) measured nothing.
          Object.values(byTier).every((r) => r?.status === "outside-hours") ? step.unmeasured(byTier) : byTier,
        ),
      );
    }

    // --- Low booking volume PER LANDING PAGE (#2738): one page breaking while the
    // others keep booking, which the tier total above cannot see. Same hours gate,
    // same arming switch and cooldown; each page's floors are measured for that
    // page, an hour it cannot be judged in is reported unmeasured, and while the
    // tier alarm is itself low the pages hold rather than repeat it. ---
    const pageVolume: PageVolumeResult = !gates.lowVolume.run
      ? UNMEASURED_PAGE_VOLUME
      : await steps.run("page_volume", UNMEASURED_PAGE_VOLUME, (step) =>
      runPageVolumeCheck({
        nowMs: now,
        // Non-null by the gate above: the check does not run without this read.
        businessHours: {
          zone: businessHours!.zone,
          rules: businessHours!.rules,
          exceptions: businessHours!.exceptions,
        },
        baselines: MEASURED_PAGE_BASELINES,
        // Those floors are cal.com's for the whole of each page, so the pages are judged
        // only while the pilot switch in Salesforce sends Slate every Low lead. Kept per
        // isolate for a few minutes, so a tick costs a Salesforce read only now and then.
        readPilot: () => pilotSettingsCache.read(now),
        // #2874: the pages' floors are Low's, so the pages count Low's bookings only.
        readSources: (sinceIso) => listCustomerBookingSourcesSince(db, sinceIso, LOW_TIER),
        pageSeenSince: (sources, sinceIso) => customerBookingFromSourcesSince(db, sources, sinceIso, LOW_TIER),
        tierLow: volume.status === "checked" ? volume.breaches.length > 0 : null,
        armed: settings!.lowVolumeArmed,
        cooldownMs: cooldownMs.low_booking_volume,
        // alert-key: low_page_volume:*
        // alert-key: page_volume_share_unknown
        // alert-text-ok: our own copy from page-volume.ts, built from measured
        // counts and the page's own names; no error text can reach it.
        notify: (key, cooldownMs, text, repeat) => sendThrottledAlert(key, cooldownMs, text, repeat),
        // alert-key: low_page_volume:*
        // alert-key: page_volume_share_unknown
        // all-clear-proof: scripts/test-page-volume.ts - pins that an unmeasured
        // hour, a low page, a tick outside business hours and a read that threw
        // each clear NOTHING about that page.
        resolveRecovered: (recovered) => resolveRecovered(recovered),
        log: (fields) => log.info("monitor", { msg: "page booking volume", ...fields }),
      }).then((r) => (r.status === "outside-hours" ? step.unmeasured(r) : r)),
    );
    if (pageVolume.status === "not-judged" && pageVolume.pilot.state === "unreadable") {
      log.warn("monitor", { msg: "page volume not judged", pilot: pageVolume.pilot.state });
    }

    // --- Relearning the low volume floors from Slate's own bookings (#2739), per
    // debt tier (#2874) ---
    // At most once a day it asks each tier for its first real booking, which is
    // what says the tier is carried and starts its ramp, then fits every carried
    // tier from its own bookings and stores the result, which the NEXT tick's
    // settings read puts in force. A declared ramp end on /admin/alerts can only
    // start a tier later. Deliberately outside the business hours gate, since a refit reads
    // history rather than the minutes just gone. Every failure throws, so this
    // boundary logs it and the step streak pages `monitor_step_failing:volume_learning`;
    // nothing is written on the way, so the floors in force stay exactly as they
    // were, and a refit that did not land is due again on the next tick.
    await steps.run("volume_learning", null, () =>
      runVolumeRelearn({
        nowMs: now,
        // #2893: each tier's cal.com measurements, thinned to the share Slate carries.
        anchors: REAL_ANCHOR_SOURCE,
        zone: MEASURED_VOLUME_BASELINE.zone,
        readConfig: async () => {
          // Its own read rather than `settings`, whose step falls back to the last
          // known value: here an unreadable row must throw, not read as the ramp
          // state of some earlier tick.
          const row = unwrap(
            await db
              .from("monitor_alert_config")
              .select("volume_ramp_end_on, volume_learning, calcom_retired_at")
              .eq("id", 1)
              .maybeSingle(),
            "volume learning config",
          ) as { volume_ramp_end_on: string | null; volume_learning: unknown; calcom_retired_at: string | null } | null;
          // #3896: when cal.com was marked retired, which retires the cal.com anchor
          // under the learned floors ANCHOR_OVERLAP_WEEKS later.
          return {
            rampEndOn: row?.volume_ramp_end_on ?? null,
            learning: row?.volume_learning ?? null,
            calcomRetiredAt: row?.calcom_retired_at ?? null,
          };
        },
        readFirstBookings: (sinceIso) => firstTierBookingsSince(db, sinceIso),
        readBookings: (sinceIso, untilIso) => listBookingStampsBetween(db, sinceIso, untilIso),
        // #2764: the org's closed days over the horizon, through the loader the
        // availability gate uses, so a holiday is never learned as a quiet day. It
        // throws on a failed read, and so does this step: nothing is written.
        readClosedDates: async (fromIsoDate) => closedExceptionDates(await loadBusinessHoursExceptions(fromIsoDate)),
        // #2893: cal.com's bookings per tier over the same day as Slate's, about ten
        // paced requests once a day. Throws on a failed read, and so does this step.
        readCalcomTierCounts: (fromIso, toIso) => calcomTierBookingCounts(fromIso, toIso),
        save: async (state) => {
          // An UPDATE of the two machine columns only, never an upsert: it must not
          // touch the settings a person saved, nor the updated_at and updated_by the
          // page reports as the last human change.
          const written = unwrap(
            await db.from("monitor_alert_config").update({ volume_learning: state }).eq("id", 1).select("id"),
            "volume learning write",
          ) as { id: number }[] | null;
          if (!written || written.length === 0) {
            throw new Error("volume learning: the settings row was not there to write the refit to");
          }
        },
        log: (fields) => log.info("monitor", { msg: "volume learning", ...fields }),
      }),
    );

    // --- What each booker offers during the pilot split (#2927) ---
    // A booking rate gap between the Slate and cal.com halves can come from what
    // each system OFFERED, so every quarter hour this asks both, read only, what a
    // Low lead would be offered and stores one row each. cal.com is asked through
    // its routing form, the same one the split pages route Low leads through;
    // Slate through its booker's own read of the bucket, filtered by the same
    // notice the availability route applies. A failed read is stored as a failure
    // with its reason, never as zero times; only a refused insert throws, and the
    // step streak pages on that.
    await steps.run("pilot_offers", null, () => runPilotOfferSampleLive(db, now));

    // --- What the pilot split settings were (#3641) ---
    // Salesforce keeps no history of the three split fields, so the comparison could
    // only assume the split held. Every quarter hour this stores what Salesforce held,
    // when it was read and when the record was last edited, through the same per
    // isolate cache the per page alarm reads above, so in business hours it usually
    // costs no Salesforce call of its own. A failed read is stored as a failure, never
    // as a split; only a refused insert throws, and the step streak pages on that.
    await steps.run("pilot_settings", null, () => runPilotSettingsSampleLive(db, now));

    // Today's counted tally, read at most ONCE a tick and shared by the failure share
    // below and the follow up drain share (#3267), on a subrequest budget four cron
    // lanes share. Not awaited here: each step awaits it inside its own boundary, so a
    // failed read fails both steps and neither reads it as an empty day.
    let todayMixRead: Promise<TodayMix> | null = null;
    const todayMix = () => (todayMixRead ??= readTodayMix(now));

    // --- Customers failing to complete a booking (#1313) ---
    // The lagging half of the pair with #1315: this one sees customers already
    // being turned away. On 2026-08-06 cal.com refused 50+ confirms in about two
    // hours and reported nothing; the only detector was a complaint monitor.
    //
    // Slate counts every attempt (#418) but the tally is bucketed by DAY, where a
    // wave of fifty is invisible. This diffs consecutive reads of that daily
    // counter into a rolling window, so the lane's 5-minute cadence gives
    // 5-minute resolution without re-keying the table.
    //
    // Its own failure boundary (L73): thirteen checks share this handler, and an
    // unguarded throw here would silently cancel every check below it.
    // all-clear-proof: scripts/test-monitor-booking-failure-rate.ts - pins that an
    // unreadable tally, an unreadable state row, and a window too small to judge
    // each send NOTHING, in either direction. The all-clear hangs only off a
    // measured clean run in the last 30 minutes (#3275), never off the window's
    // share dipping, and a half hour too quiet to judge clears nothing.
    const failureRate = await steps.run<
      FailureRateResult | { status: "errored" } | { status: "skipped"; why: string }
    >(
      "failure_rate",
      { status: "errored" },
      async (step) =>
        // #2773: its arming switch comes from the settings, so with none readable
        // and none known it stands down rather than run disarmed by default.
        !gates.failureRate.run
          ? step.unmeasured({ status: "skipped", why: gates.failureRate.why })
          : runBookingFailureRateCheck({
          nowMs: now,
          loadState: loadRateState,
          saveState: saveRateState,
          readToday: async () => outcomeReadingOf(await todayMix()),
          readRefusedPeople: (sinceMs) => readRefusedPeople(sinceMs, now),
          thresholds: FAILURE_RATE_THRESHOLDS,
          recent: SHIPPED_FAILURE_RATE_RECENT,
          // #3276: ten failed attempts in half an hour page beside the share.
          volume: SHIPPED_FAILURE_VOLUME,
          armed: settings!.failureRateArmed,
          cooldownMs: cooldownMs.booking_failure_rate,
          notify: (key, cooldownMs, text) => {
            // alert-key: booking_failure_rate
            // alert-key: booking_failure_burst_ended
            // alert-key: booking_failure_volume
            // alert-text-ok: our own copy from booking-failure-rate.ts, built from
            // measured counts; no error text can reach it.
            return sendThrottledAlert(key, cooldownMs, text);
          },
          // alert-key: booking_failure_rate
          // alert-key: booking_failure_volume
          resolve: (key, text) => resolveAlert(key, text),
          log: (fields) => log.info("monitor", { ...fields }),
          onError: (context, err) =>
            log.error("monitor", { msg: "booking failure rate step failed", step: context }, err),
        }),
    );

    // --- Confirms leaving the work after their save to the drain (#3267) ---
    //
    // A confirm whose work after the booking committed is cut off still answers the
    // booking (#3263), and the reservation drain finishes the rest. One is the drain
    // doing its job; a wave is the confirm path failing every lead it answers, which
    // nothing else reports (L77). The routes count each beside its created row, and
    // this judges the share over the last hour, off the tally read the failure share
    // above already made.
    //
    // Its own failure boundary (L73). A read or a write that fails throws, so the
    // tick pages nothing and clears nothing (#3267).
    // all-clear-proof: scripts/test-follow-up-drain-rate.ts - pins that a failed tally
    // read, a failed state read and a failed state write each send NOTHING in either
    // direction, that a first reading or a day rollover sends nothing, and that the
    // all clear hangs only off a measured clean half hour, never off the hour's share
    // dipping, so a quiet half hour clears nothing.
    await steps.run<FollowUpDrainResult | null>("follow_up_drain_rate", null, () =>
      runFollowUpDrainCheck({
        nowMs: now,
        readToday: async () => followUpReadingOf(await todayMix()),
        loadState: loadFollowUpState,
        saveState: saveFollowUpState,
        thresholds: FOLLOW_UP_DRAIN_THRESHOLDS,
        cooldownMs: cooldownMs.booking_follow_up_left_to_drain,
        notify: (key, ms, text) => {
          // alert-key: booking_follow_up_left_to_drain
          // alert-text-ok: our own copy from follow-up-drain-rate.ts, built from
          // measured counts (#3267); no error text can reach it.
          return sendThrottledAlert(key, ms, text);
        },
        // alert-key: booking_follow_up_left_to_drain
        resolve: (key, text) => resolveAlert(key, text),
      }).then((result) => {
        log.info("monitor", {
          msg: "follow up drain rate",
          status: result.status,
          ...("verdict" in result
            ? { verdict: result.verdict.status, confirms: result.verdict.confirms, left: result.verdict.left }
            : { rebased: result.rebased }),
        });
        return result;
      }),
    );

    // --- Duplicate cancels failing or refused in volume (#2377) ---
    //
    // POST /api/bookings/cancel-duplicate counts every answer in the daily tally,
    // outside the failure share. This judges, off the tally read the failure share
    // above already made, the day's share answered 503 and the day's share refused for
    // a person, each against its own line, behind a 40 call floor today's volume (about
    // five a day) does not reach. Its own failure boundary (L73).
    // all-clear-proof: scripts/test-duplicate-cancel-rate.ts - pins that a failed tally
    // read sends NOTHING in either direction, that a first reading or a day rollover
    // sends nothing, and that a day too quiet to judge clears nothing; each all clear
    // hangs only off a measured clean six hours.
    await steps.run<DuplicateCancelResult | null>("duplicate_cancel_rate", null, () =>
      runDuplicateCancelCheck({
        nowMs: now,
        readToday: async () => duplicateCancelReadingOf(await todayMix()),
        loadState: loadDuplicateCancelState,
        saveState: saveDuplicateCancelState,
        thresholds: DUPLICATE_CANCEL_THRESHOLDS,
        cooldownMs: {
          unavailable: cooldownMs.duplicate_cancel_unavailable,
          refused: cooldownMs.duplicate_cancel_refused,
        },
        notify: (key, ms, text) => {
          // alert-key: duplicate_cancel_unavailable
          // alert-key: duplicate_cancel_refused
          // alert-text-ok: our own copy from duplicate-cancel-rate.ts, built from
          // measured counts and fixed stage and refusal words; no error text reaches it.
          return sendThrottledAlert(key, ms, text);
        },
        // alert-key: duplicate_cancel_unavailable
        // alert-key: duplicate_cancel_refused
        resolve: (key, text) => resolveAlert(key, text),
      }).then((result) => {
        log.info("monitor", {
          msg: "duplicate cancel rate",
          status: result.status,
          ...(result.status === "judged"
            ? {
                verdict: result.verdict.status,
                calls: result.verdict.calls,
                paged: result.paged.join(",") || "none",
                cleared: result.cleared.join(",") || "none",
              }
            : { rebased: result.rebased }),
        });
        return result;
      }),
    );

    // --- Is half a month's booking error budget spent (#3179)? ---
    //
    // The same population as the hourly page above, judged over the calendar month
    // against the targets in docs/slo.md. One aggregate read per tick. Its own
    // failure boundary (L73): a read that fails throws here and clears nothing, and
    // a reading that cannot be right is unmeasured and sends nothing either way.
    await steps.run("booking_budget", null, () =>
      runSloBudgetCheck({
        read: () => readMonthToDate(now),
        cooldownMs: cooldownMs.booking_budget,
        notify: (key, ms, text) => {
          // alert-key: booking_budget:*
          // alert-text-ok: our own copy from slo-budget.ts, built from measured
          // counts; no error text can reach it.
          return sendThrottledAlert(key, ms, text);
        },
        // alert-key: booking_budget:*
        // all-clear-proof: scripts/test-slo-budget.ts - pins that a failed read and an
        // impossible reading each clear nothing.
        resolveRecovered: (recovered) => resolveRecovered(recovered),
        log: (fields) => log.info("monitor", { msg: "booking budget", ...fields }),
      }),
    );

    // --- Are leads arriving with no usable routing code (#1908)? ---
    //
    // A blank or unreadable `xbc` is routed to the Low pool rather than refused,
    // which is right, and is also a defect absorber: every rescue is an upstream
    // page that stopped sending a code. cal.com has been doing exactly this
    // silently and turned out to be carrying roughly 2 percent of all bookings
    // through it. Shipping the rescue without this count would reproduce the very
    // condition it was written to end.
    //
    // Its own failure boundary (L73), like its neighbours. A tick that cannot
    // COUNT sends nothing in either direction: an unreadable count is not a
    // healthy rate, and an all clear hung off it would be a claim nobody measured
    // (#1134, #1152). That is why the verdict has an `unmeasured` state, and why
    // the store throws rather than letting a failed count arrive as zero.
    await steps.run("catchall_rate", null, async () => {
      const window = await readCatchallWindow(now);
      const verdict = catchallVerdict(window);
      log.info("monitor", {
        msg: "catchall rate",
        catchall: window.catchall,
        total: window.total,
        window_h: CATCHALL_WINDOW_HOURS,
        verdict: verdict.kind,
      });
      if (verdict.kind === "unmeasured") return;
      if (verdict.kind === "page") {
        // alert-key: catchall_rate
        // alert-text-ok: our own copy from catchall-rate.ts, built from measured
        // counts; no error text can reach it.
        await sendThrottledAlert(
          CATCHALL_RATE_ALERT_KEY,
          cooldownMs.catchall_rate,
          catchallPageText(verdict, CATCHALL_WINDOW_HOURS),
        );
        return;
      }
      // Hung off the MEASURED healthy verdict, never off "we did not page this
      // run": a tick that skipped or could not read has cleared nothing.
      // alert-key: catchall_rate
      await resolveAlert(CATCHALL_RATE_ALERT_KEY, catchallClearText(verdict.share, CATCHALL_WINDOW_HOURS));
    });

    // --- A top tier lead booked where the routing rule forbids (#2842) ---
    //
    // Sales ops let Ultra High and Very High leads cascade, no lower than Medium and
    // never to an advisor who also carries Low. A cascade inside that rule posts
    // nothing (Dan, 2026-10-29, who removed the daily count of them,
    // `top_tier_cascade_rate`); a booking outside it pages once, as an incident.
    // Reads the day's booked top tier cascades every tick, and a failed read throws
    // here, so the step is recorded as failing rather than as nothing wrong.
    await steps.run("top_tier_forbidden_placement", null, () =>
      checkTopTierPlacements({
        loadPlacements: () => loadTopTierCascades(now),
        loadAdvisors: loadPlacementAdvisors,
        bookingUrl: (id) => `${appUrl()}${bookingDetailHref(id)}`,
        // alert-key: top_tier_forbidden_placement:*
        // alert-text-ok: our own copy from top-tier-placement.ts, built from the
        // routing record's codes and the advisor's name; no error text can reach it.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat).catch(logAlertSendFailure(key)),
      }).then((result) => {
        log.info("monitor", {
          msg: "top tier placements",
          lookback_h: TOP_TIER_PLACEMENT_LOOKBACK_HOURS,
          allowed: result.allowed,
          forbidden: result.forbidden,
          paged: result.paged,
          unmeasured_no_booking_id: result.unmeasured["no-booking-id"],
          unmeasured_code_unreadable: result.unmeasured["code-unreadable"],
          unmeasured_advisor_unread: result.unmeasured["advisor-unread"],
        });
      }),
    );

    // --- Are confirms losing the overlap race (#2838)? ---
    //
    // Since #2281 a confirm that loses the race is handed to the next free advisor
    // in the same rung (and since #3338 on down the tier ladder when nobody after
    // it there is free), and the loss was recorded only in a trace field and a log
    // line nobody reads. This counts both halves (handed on, and refused) from the
    // day's outcome tally and whispers once a day when the share of confirms that
    // lost one is above what the busiest measured traffic could produce, a
    // threshold derived in race-contention.ts rather than typed.
    //
    // Info only, and it never resolves: there is no condition to end, and a day
    // back under the share is not news. A lead refused at the reassign BOUND is
    // paged from the confirm path at the moment it happens instead, because a
    // daily counter cannot page on one event without either holding a second
    // day's page back or re-paging the same lead all day.
    //
    // On this lane rather than a daily one because it is ONE cap safe RPC and the
    // 24 hour cooldown, not the cadence, decides how often it speaks; a tick that
    // cannot read the tally throws inside its own boundary (L73) and sends nothing,
    // since an unreadable tally is not a day with no races.
    await steps.run("booking_race_contention", null, async () => {
      const window = await readRaceContentionWindow(now);
      // #2877: the busiest tier's rate, read only when the day can turn on it,
      // and (PR #2883) only while the whisper could still go out, asked of the
      // same cooldown read the send makes.
      const judged = await judgeRaceContention(window, now, {
        readBookings: () => readRaceRateBookings(now),
        whisperDue: () => isAlertDue(RACE_CONTENTION_NOTICE_KEY, RACE_CONTENTION_COOLDOWN_MS, now),
        // One measurement per Eastern day: a quiet qualifying day never sends,
        // so the cooldown alone would not stop the read.
        cache: raceThresholdDayCache,
      });
      if (judged.kind === "cooling-down") {
        log.info("monitor", {
          msg: "booking race contention",
          day: window.day,
          verdict: "not judged",
          why: "the whisper's cooldown is still running, so it could not send whatever the verdict",
        });
        return;
      }
      const { threshold, verdict } = judged;
      log.info("monitor", {
        msg: "booking race contention",
        day: window.day,
        created: window.created,
        reassigned: window.reassigned,
        reassigned_moves: window.reassignedMoves,
        refused: window.refused,
        refused_at_bound: window.refusedAtBound,
        retried_for_budget: window.retriedForBudget,
        verdict: verdict.kind,
        threshold_source: threshold.basis.source,
        threshold_per_hour: threshold.perHour,
        ...(threshold.basis.source === "measured"
          ? { threshold_tier: threshold.basis.tier, threshold_hours: threshold.basis.activeHours }
          : { threshold_why: threshold.basis.reason }),
        ...(verdict.kind === "unmeasured" ? { why: verdict.reason } : {}),
      });
      if (verdict.kind !== "report") return;
      // alert-key: booking_race_contention
      // alert-text-ok: our own copy from race-contention.ts, built from measured
      // counts; no error text can reach it.
      await sendThrottledInfo(
        RACE_CONTENTION_NOTICE_KEY,
        RACE_CONTENTION_COOLDOWN_MS,
        raceContentionNoticeText(verdict),
      );
    });

    // --- Is the booking API refusing its own caller (#1442, #1450, #1709)? ---
    //
    // Three refusals kept OUT of the failure share above, judged against their own
    // totals instead. Reuses the window that step just advanced and PERSISTED,
    // rather than reading the row again: four cron lanes share one invocation's
    // subrequest budget, and a second read would spend it to learn nothing. It
    // also removes any chance of the two checks judging different windows (L53).
    //
    // Its own failure boundary (L73), like its two neighbours.
    //
    // A tick that could not measure sends NOTHING in either direction. That is the
    // whole reason the judge has an `unmeasured` status distinct from `clear`: an
    // empty window has not found the ceiling healthy, it has failed to look, and
    // an all-clear hung off it would be a claim nobody measured (#1134, #1152).
    await steps.run("api_refusals", null, async () => {
      if (failureRate.status !== "checked") {
        log.warn("monitor", {
          msg: "api refusal signals skipped",
          why:
            failureRate.status === "unverified" || failureRate.status === "skipped"
              ? failureRate.why
              : "failure rate step errored",
        });
        return null;
      }
      const verdicts = judgeRefusalSignals(
        samplesFromWindow(failureRate.state.samples),
        now,
        REFUSAL_THRESHOLDS,
      );
      log.info("monitor", {
        msg: "api refusals",
        ceiling: verdicts.ceiling.status,
        ceiling_pct: verdicts.ceiling.status === "paging" ? verdicts.ceiling.pct : null,
        credential: verdicts.credential.status,
        credential_cause:
          verdicts.credential.status === "paging" ? verdicts.credential.cause : null,
        list: verdicts.list.status,
        samples: failureRate.state.samples.length,
      });

      const cooldown = cooldownMs.booking_failure_rate;
      // Each signal pages and clears on its OWN key, so one condition ending
      // cannot clear another and a reader can always tell what stopped.
      const ceilingText = refusalSignalCopy.ceiling(
        verdicts.ceiling,
        REFUSAL_THRESHOLDS.windowMs,
        CEILING_LIMITS,
      );
      if (ceilingText) {
        // alert-key: booking_api_ceiling
        // alert-text-ok: our own copy, built from measured counts; no error text
        // can reach it.
        await sendThrottledAlert(CEILING_ALERT_KEY, cooldown, ceilingText);
      } else if (verdicts.ceiling.status === "clear") {
        // alert-key: booking_api_ceiling
        await resolveAlert(CEILING_ALERT_KEY, refusalAllClear.ceiling);
      }

      const credentialText = refusalSignalCopy.credential(
        verdicts.credential,
        REFUSAL_THRESHOLDS.windowMs,
      );
      if (credentialText) {
        // alert-key: booking_api_credential
        // alert-text-ok: our own copy, built from measured counts.
        await sendThrottledAlert(CREDENTIAL_ALERT_KEY, cooldown, credentialText);
      } else if (verdicts.credential.status === "clear") {
        // alert-key: booking_api_credential
        await resolveAlert(CREDENTIAL_ALERT_KEY, refusalAllClear.credential);
      }

      const listText = refusalSignalCopy.list(verdicts.list, REFUSAL_THRESHOLDS.windowMs);
      if (listText) {
        // alert-key: booking_api_list_read
        // alert-text-ok: our own copy, built from measured counts.
        await sendThrottledAlert(LIST_ALERT_KEY, cooldown, listText);
      } else if (verdicts.list.status === "clear") {
        // alert-key: booking_api_list_read
        await resolveAlert(LIST_ALERT_KEY, refusalAllClear.list);
      }
      return null;
    });

    // --- Is the embed booker turning leads away by its own limits (#1727)? ---
    //
    // The same window again, so no second read of the state row (L53). Its OWN
    // boundary rather than a branch of the step above, because it can make up to
    // two reads of the limiter's rows that the API signals do not need, and a throw
    // in one must not take the other's judgement with it (L73). A read that fails
    // throws inside this step, which the step failure streak reports (#2382); it
    // never reaches the judge as zero, which would clear a page about people still
    // locked out.
    //
    // The reads happen only when the window recorded a trip on that cap, so the
    // quiet tick, which is nearly every tick, costs no subrequest at all.
    await steps.run("embed_refusals", null, async () => {
      if (failureRate.status !== "checked") {
        log.warn("monitor", {
          msg: "embed refusal signals skipped",
          why:
            failureRate.status === "unverified" || failureRate.status === "skipped"
              ? failureRate.why
              : "failure rate step errored",
        });
        return null;
      }
      const t = SHIPPED_EMBED_REFUSAL_THRESHOLDS;
      const samples = samplesFromWindow(failureRate.state.samples);
      const needed = lockoutReadsNeeded(embedTripsInWindow(samples, now, t.windowMs));
      const lockouts = {
        addresses: needed.addresses ? await countLockedOutKeys(BOOKING_HOURLY_RATE_RULES[0], now) : null,
        contactKeys: needed.contactKeys ? await countLockedOutKeys(BOOKING_CONTACT_HOURLY_RATE_RULES[0], now) : null,
      };
      const verdicts = judgeEmbedRefusalSignals(samples, now, t, lockouts);
      log.info("monitor", {
        msg: "embed refusals",
        ip_cap: verdicts.ipCap.status,
        ip_locked_out: lockouts.addresses,
        contact_cap: verdicts.contactCap.status,
        contact_locked_out: lockouts.contactKeys,
        honeypot: verdicts.honeypot.status,
        honeypot_trips: verdicts.honeypot.status === "unmeasured" ? null : verdicts.honeypot.trips,
      });

      // Each signal pages and clears on its OWN key. The all-clears are settled in one
      // batch, which reads alert_state once for all three rather than once each, on
      // the subrequest budget four cron lanes share.
      const plan = planEmbedRefusalAlerts(verdicts, t.windowMs, EMBED_CAP_LIMITS);
      for (const page of plan.pages) {
        // alert-key: booking_embed_ip_cap
        // alert-key: booking_embed_contact_cap
        // alert-key: booking_embed_honeypot
        // alert-text-ok: our own copy from api-refusal-signals.ts, built from measured
        // counts; no error text can reach it.
        await sendThrottledAlert(page.key, cooldownMs.booking_failure_rate, page.text);
      }
      // alert-key: booking_embed_ip_cap
      // alert-key: booking_embed_contact_cap
      // alert-key: booking_embed_honeypot
      // all-clear-proof: scripts/test-embed-refusal-signals.ts (an empty window, a
      // needed lockout read that is missing, and one that came back unreadable each
      // plan no all-clear at all)
      await resolveRecovered(plan.recovered);
      return null;
    });

    // --- Are the times we offer actually free (#1315) ---
    // The LEADING half of the pair with #1313. That one sees customers already
    // being turned away; this one asks whether the availability we publish is
    // true before anyone books into it.
    //
    // Nothing measured that before. The data-anomaly probe above compares the
    // cached slot ROW against a live recompute, and the recompute reads
    // busy_blocks too, so it can only catch the row lagging the index, never the
    // index having drifted from Google.
    //
    // Its own failure boundary (L73), like its sibling.
    const availabilityTruth = await steps.run<TruthResult | { status: "errored" }>(
      "avail_truth",
      { status: "errored" },
      async (step) =>
        // The probe needs one setup read, the horizon, because that is the window it
        // asks the slot cache for. It deliberately does NOT need the bucket list, the
        // shift gate or the org's week, so none of those failing may silence it: that
        // coupling is what #1395 removed.
        !gates.availabilityTruth.run
          ? step.unmeasured({ status: "skipped", why: gates.availabilityTruth.why })
          : runAvailabilityTruthCheck({
          nowMs: now,
          thresholds: TRUTH_THRESHOLDS,
          nextBucket: nextTruthBucket,
          cachedSlots: (code) =>
            offeredSlots(
              code,
              new Date(now).toISOString(),
              new Date(now + horizonDays! * 24 * 60 * 60_000).toISOString(),
            ),
          eligibleEmails: eligibleEmailsForBucket,
          verifyWindows: verifyWindowsLive,
          alertContext: () => driftAlertContext(),
          markDrifting: markBucketDrifting,
          settleSilently: settleAlertsSilently,
          armed: settings!.availabilityDriftArmed,
          cooldownMs: cooldownMs.availability_drift,
          notify: (key, cooldownMs, text) => {
            // alert-key: availability_drift:*
            // alert-text-ok: our own copy from availability-truth.ts, built from
            // measured counts; no error text can reach it.
            return sendThrottledAlert(key, cooldownMs, text);
          },
          // alert-key: availability_drift:*
          // all-clear-proof: scripts/test-monitor-availability-truth.ts - pins that a
          // skipped tick, an unreadable slot payload, an unstaffed bucket, a Google
          // failure and a sample too small to judge each send NOTHING. The all-clear
          // hangs only off a sample that was measured clean.
          resolve: (key, text) => resolveAlert(key, text),
          log: (fields) => log.info("monitor", { ...fields }),
          onError: (context, err) =>
            log.error("monitor", { msg: "availability truth step failed", step: context }, err),
        }),
    );

    // --- Is the booker serving a time the confirm refuses (#3381)? ---
    // The truth probe above asks Google about a fresh compute; this asks the confirm's
    // own candidate read about what the booker is SERVING, which is the disagreement
    // the 2026-10-06 and 2026-10-14 refusals were. A handful of times a tick (one ladder
    // request each, see offered-nobody-free.ts for the measured cost), a
    // time found once is remembered, and it pages only if it is still served with
    // nobody free a freshness window later. Its own boundary, gated on the two setup
    // reads it consumes: the stored rows ARE what is served, and the org's week filters
    // them.
    if (!gates.offeredNobodyFree.run) {
      log.warn("monitor", { msg: "offered nobody free skipped", why: gates.offeredNobodyFree.why });
    }
    const offeredNobodyFree = await steps.run<OfferedNobodyFreeResult | null>("offered_nobody_free", null, async (step) =>
      !gates.offeredNobodyFree.run
        ? step.unmeasured(null)
        : runOfferedNobodyFreeCheck({
        nowMs: now,
        rows: slotRows!,
        hours: businessHours!,
        loadPools: loadRealPools,
        readSuspects: readOfferedSuspects,
        judge: judgeOfferedTime,
        markSuspect: markOfferedSuspect,
        clearSuspect: clearOfferedSuspect,
        cooldownMs: cooldownMs.offered_nobody_free,
        notify: (key, cooldown, text) => {
          // alert-key: offered_nobody_free
          // alert-text-ok: our own copy from offered-nobody-free.ts, built from bucket
          // codes, instants and counts; no error text can reach it.
          return sendThrottledAlert(key, cooldown, text);
        },
        // alert-key: offered_nobody_free
        // all-clear-proof: scripts/test-offered-nobody-free.ts - pins that an unreadable
        // pool list or marker set, a candidate read that cannot answer, a remembered time
        // left unexamined, a first sighting and a tick with nothing served each send NO
        // all clear. It hangs only off a tick that judged and found every time free.
        resolve: (key, text) => resolveAlert(key, text),
        log: (fields) => log.info("monitor", { ...fields }),
      }),
    );

    // --- Thin-tier staffing early warning (#569): a slow, low-priority whisper
    // of tiers resting on 1-2 bookable agents, reusing the #584 depth helper
    // (fallback-blind, so a configured fallback can't mask a thin tier), so
    // staffing can add coverage before a thin tier saturates and trips the
    // reactive availability signals above. depth-0 dead-ends are those signals'
    // job and are excluded; the info-channel post self-throttles to ~daily. ---
    // One staffing depth read per tick, shared by the thin tier whisper and the
    // nearly full pool whisper (#1256), so the second costs no extra subrequests.
    // A rejected read is shared too: each step contains it in its own boundary.
    let tierDepthsOnce: Promise<TierDepth[]> | null = null;
    const tierDepthsForTick = () =>
      (tierDepthsOnce ??= loadTierDepths(db, undefined, new Date(now)));
    const thinTierCount = await steps.run("thin_tier", null, () =>
      runThinTierStaffingCheck({
        loadDepths: tierDepthsForTick,
        // alert-key: thin_tier_staffing
        notify: sendThrottledInfo,
        cooldownMs: cooldownMs.thin_tier_staffing,
        log: (m) => log.info("thin-tier", { msg: m }),
      }),
    );

    // --- A debt tier nearly full (#1256, #3637): a quiet whisper when fewer than the
    // set share (10% by default) of a debt tier's possible starts across the days
    // the booker shows are still open (#3559), well before the booked solid page
    // (#1412) fires at zero. Judged per tier, never per Beyond, Achieve or legal
    // pool, because a lead whose own pool is full is served by the rest of the
    // tier. The measurement is the supply report's own (#1254), built from the
    // setup reads this tick already holds (the slot rows, the week, the horizon,
    // the bucket list) plus the shared depth read above, so the only new
    // subrequests are the paginated read of today's window of bookings. A tier any
    // of whose codes the scan just paged as booked solid is left to that page;
    // with the scan's answer unknown or cut short, a tier with nothing open is
    // held back for the same reason. ---
    await steps.run("pool_fullness", null, async (step) => {
      if (!gates.poolFullness.run) {
        log.warn("monitor", { msg: "nearly full pool check skipped", why: gates.poolFullness.why });
        return step.unmeasured(null);
      }
      const hours = businessHours!;
      return runPoolFullnessCheck({
        loadReport: async () => {
          // The booked times and the depths each fail to an explicit unknown, as on
          // the supply page: a share computed over a failed read would be believed.
          const [booked, depths, offeredOpenDays] = await Promise.all([
            loadBookedTimes(db, undefined, hours, horizonDays as number, new Date(now)).catch((err) => {
              log.error("monitor", { msg: "nearly full pool booked times unreadable" }, err);
              return null;
            }),
            tierDepthsForTick().catch((err) => {
              log.error("monitor", { msg: "nearly full pool depths unreadable" }, err);
              return null;
            }),
            // Null on a failed read, which makes the report unmeasurable (#3922).
            offeredDaysForTick(),
          ]);
          return bucketSupplyReport({
            hours,
            horizonDays: horizonDays as number,
            offeredOpenDays,
            nowMs: now,
            buckets:
              buckets === null
                ? null
                : buckets.filter((b) => !b.is_test).map((b) => ({ code: b.code, name: b.name })),
            depthByCode: depths === null ? null : supplyDepthMap(depths),
            cacheRows: slotRows,
            bookedByCodeAndDate: booked,
          });
        },
        bookedSolidCodes: scan && !scan.truncated ? scan.cause.bookedSolid : null,
        // The line only decides whether a quiet notice is worth sending, so with no
        // settings reading at all the coded 10% is a safe stand in.
        openShare: settings?.poolNearlyFullOpenShare ?? codedPoolNearlyFullShare(),
        // alert-key: pool_nearly_full
        notify: sendThrottledInfo,
        cooldownMs: cooldownMs.pool_nearly_full,
        log: (fields) => log.info("monitor", { msg: "nearly full pool", ...fields }),
      });
    });

    // --- Schedule coverage (#838): a bookable agent with no working hours silently
    // shows zero availability and takes no bookings. They should have some
    // (ensureDefaultSchedules fills them on roster sync), so first try to
    // self-heal the benign case (a new agent between syncs), then whisper ONLY for
    // the ones the fill could not create. Every read is paged past PostgREST's
    // 1,000-row cap; they are re-run after the heal so the recheck sees what the
    // fill actually created.
    //
    // #1670 widened what counts as covered. A schedule ROW is not working hours:
    // `isWithinWorkingHours` reads its RULES, and an empty rule set rejects every
    // instant, so an agent with a row and no rules is exactly as unbookable as one
    // with no row, and this check could not see them. ---
    const loadMissingAgents = async (): Promise<ScheduleLessAgent[]> => {
      const [agents, scheds, ruleRows] = await Promise.all([
        selectAllPages<ScheduleLessAgent>(
          "monitor schedule-coverage bookable agents",
          "id",
          () =>
            realAdvisorsOnly(
              db.from("users").select("id, name, email, org_id").eq("bookable", true).is("deactivated_at", null),
            ),
        ),
        selectAllPages<{ id: string; user_id: string }>(
          "monitor schedule-coverage schedules",
          "id",
          () => db.from("availability_schedules").select("id, user_id"),
        ),
        selectAllPages<{ schedule_id: string }>(
          "monitor schedule-coverage rules",
          "id",
          () => db.from("availability_rules").select("id, schedule_id"),
        ),
      ]);
      return missingScheduleAgents(
        agents,
        usableScheduleUserIds(scheds, new Set(ruleRows.map((r) => r.schedule_id))),
      );
    };
    const scheduleCoverage = await steps.run("schedule_coverage", null, () =>
      runScheduleCoverageCheck({
        loadMissingAgents,
        heal: async (orgIds) => {
          // Per-org so one org's failed fill can't skip the others; a throw is
          // logged and left for the recheck to surface as the alert.
          for (const orgId of orgIds) {
            await ensureDefaultSchedules(orgId).catch(() =>
              log.warn("schedule-coverage", { msg: "self-heal fill failed", org_id: orgId }),
            );
          }
        },
        // alert-key: agents_without_schedule
        notify: sendThrottledInfo,
        cooldownMs: cooldownMs.agents_without_schedule,
        log: (m) => log.info("schedule-coverage", { msg: m }),
      }),
    );

    // --- Hours nobody set (#1753): a bookable agent still on the seeded week is
    // offered times that are right only by coincidence, and a stored week is a
    // valid week whether or not the agent keeps it. The stamp (`hours_source`,
    // migration 0117) decides for rows written since it existed; for the rows
    // before it, a week still shaped exactly like the org default was never
    // touched. It waits two days before naming anybody (UNSET_HOURS_GRACE_MS),
    // because every new hire is seeded with the default week and ordinary
    // onboarding clears it; `verify:parallel-run-readiness` deliberately keeps no
    // such patience. Its own reads, in its own boundary, like schedule_coverage
    // above: it does not consume the shared setup state, so it is not gated on it. ---
    await steps.run("unset_hours", null, () =>
      runUnsetHoursCheck({
        load: async () => {
          const [agents, scheds, rules, orgRow] = await Promise.all([
            selectAllPages<UnsetHoursAgent>("monitor unset-hours bookable agents", "id", () =>
              realAdvisorsOnly(
                db.from("users").select("id, name, email").eq("bookable", true).is("deactivated_at", null),
              ),
            ),
            selectAllPages<{
              id: string;
              user_id: string;
              timezone: string;
              hours_source: HoursSource | null;
              hours_set_at: string | null;
              created_at: string;
            }>("monitor unset-hours schedules", "id", () =>
              db
                .from("availability_schedules")
                .select("id, user_id, timezone, hours_source, hours_set_at, created_at"),
            ),
            selectAllPages<{ schedule_id: string; weekday: number; start_minute: number; end_minute: number }>(
              "monitor unset-hours rules",
              "id",
              () =>
                db.from("availability_rules").select("id, schedule_id, weekday, start_minute, end_minute"),
            ),
            db
              .from("organizations")
              .select("default_timezone, default_start_minute, default_end_minute, default_weekdays")
              .limit(1)
              .maybeSingle(),
          ]);
          const org = unwrap(orgRow, "monitor unset-hours org defaults") as OrgDefaults | null;
          if (!org) throw new Error("no organization row");
          const rulesBySchedule = groupRulesBySchedule(rules);
          return {
            org,
            agents,
            schedules: scheds.map((sc) => ({
              user_id: sc.user_id,
              timezone: sc.timezone,
              hours_source: sc.hours_source,
              hours_set_at: sc.hours_set_at,
              created_at: sc.created_at,
              rules: rulesBySchedule.get(sc.id) ?? [],
            })),
          };
        },
        // alert-key: agents_on_unset_hours
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: agents_on_unset_hours
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: cooldownMs.agents_on_unset_hours,
        nowMs: Date.now(),
        // #2875: once cal.com is retired the page stops offering the cal.com import.
        calcomRetired: () => loadCalcomRetiredCached(now),
      }),
    );

    // --- Waiting to become bookable (#2318): somebody the roster counts as
    // working has carried `bookable_pending_since` for longer than the grace, so
    // the hourly roster sync has retried their activation and been refused (or
    // deferred it past its shared allowance, which produces no alert at all). The
    // per agent refusal alert cannot see the deferred case and nothing else
    // watches the queue, so from outside a stuck hire is indistinguishable from a
    // healthy one. One column on a roster bounded table, in its own boundary: it
    // consumes no shared setup state beyond its arming switch (below).
    //
    // Disarmed until somebody has watched a few ordinary days (migration 0131); it
    // measures and logs either way, and clears nothing on a read that failed. ---
    // #2773: its arming switch comes from the settings, so with none readable and
    // none known it stands down rather than run disarmed by default.
    const awaitingActivation = await steps.run("awaiting_activation", null, async (step) =>
      !gates.awaitingActivation.run
        ? step.unmeasured(null)
        : runAwaitingActivationCheck({
        load: () =>
          selectAllPages<AwaitingActivationRow>("monitor awaiting-activation roster", "id", () =>
            realAdvisorsOnly(
              db
                .from("users")
                .select("id, name, email, bookable, deactivated_at, bookable_pending_since")
                .not("bookable_pending_since", "is", null),
            ),
          ),
        armed: settings!.awaitingActivationArmed,
        // alert-key: agents_awaiting_activation
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: agents_awaiting_activation
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: cooldownMs.agents_awaiting_activation,
        nowMs: Date.now(),
      }),
    );
    // #2798: the line the verdict lane's page sends a reader to. An unreadable
    // roster used to leave no trace here at all, which is how it read as quiet.
    if (awaitingActivation) {
      log.info("monitor", {
        msg: "awaiting activation",
        status: awaitingActivation.status,
        ...(awaitingActivation.status === "unreadable" ? { error: awaitingActivation.error } : {}),
        ...(awaitingActivation.status === "waiting" ? { waiting: awaitingActivation.agents.length } : {}),
        ...(awaitingActivation.status === "clear" ? { measured: awaitingActivation.measured } : {}),
      });
    }

    // --- A hire stranded outside the pool (#2481): on Sales, signed in, a calendar
    // that syncs, not bookable, no pending mark and no recorded hold. The waiting
    // check above reads the mark, so it cannot see somebody whose mark a roster
    // write erased (#2381). Its own reads, in its own boundary, and not gated: it
    // has no arming switch and consumes no shared setup state. On an ordinary tick
    // it is one read of the few non bookable rows; the calendar and audit reads run
    // only when a candidate exists. ---
    const strandedHires = await steps.run("stranded_hires", null, () =>
      runStrandedHiresCheck({
        loadCandidates: () =>
          selectAllPages<StrandedHireRow>("monitor stranded-hires roster", "id", () =>
            realAdvisorsOnly(
              db
                .from("users")
                .select("id, name, email, attributes, bookable, deactivated_at, bookable_pending_since, auth_user_id")
                .eq("bookable", false)
                .is("deactivated_at", null)
                .not("auth_user_id", "is", null),
            ),
          ),
        loadSyncedCalendarUserIds: async (ids) => {
          const rows = await selectAllPages<{ user_id: string }>("monitor stranded-hires calendars", "id", () =>
            db
              .from("agent_calendars")
              .select("id, user_id")
              .in("user_id", ids)
              .not("last_success_at", "is", null),
          );
          return new Set(rows.map((r) => r.user_id));
        },
        loadDecidedUserIds: async (ids) => {
          const rows = await selectAllPages<{ target_id: string }>("monitor stranded-hires audit", "id", () =>
            db
              .from("audit_log")
              .select("id, target_id")
              .eq("action", "agent.bookable")
              .in("target_id", ids)
              .not("actor_id", "is", null),
          );
          return new Set(rows.map((r) => r.target_id));
        },
        // alert-key: agents_stranded_outside_pool
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: agents_stranded_outside_pool
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: cooldownMs.agents_stranded_outside_pool,
      }),
    );
    if (strandedHires) {
      log.info("monitor", {
        msg: "stranded hires",
        status: strandedHires.status,
        ...(strandedHires.status === "unreadable" ? { error: strandedHires.error } : {}),
        ...(strandedHires.status === "stranded" ? { stranded: strandedHires.agents.length } : {}),
        ...(strandedHires.status === "clear" ? { measured: strandedHires.measured } : {}),
      });
    }

    // --- A bookable advisor the confirm's ladder read leaves out (#3530): a row of
    // theirs it cannot read drops them from every confirm (never just the row, which
    // could make them look free), and nothing else on any screen says so. It asks the
    // confirm's own reader, through the same request, one request a pass. Its own reads,
    // in its own boundary, and not gated: it consumes no shared setup state. A read that
    // fails fails the step, so a check that has stopped pages as one. ---
    const ladderDropped = await steps.run("ladder_dropped_advisors", null, () =>
      runLadderDroppedCheck({
        read: () => readLadderDroppedLive(now),
        // alert-key: ladder_advisor_unreadable
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: ladder_advisor_unreadable
        // all-clear-proof: scripts/test-ladder-dropped-advisors.ts - pins that a read that
        // fails sends no all clear and that only a read that answered and left nobody out
        // ends it.
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: cooldownMs.ladder_advisor_unreadable,
      }),
    );
    if (ladderDropped) {
      log.info("monitor", {
        msg: "ladder dropped advisors",
        status: ladderDropped.status,
        ...(ladderDropped.status === "dropped" ? { dropped: ladderDropped.advisors.length } : {}),
      });
    }

    // --- A booking below the lead's Salesforce tier (#2593): an Ultra High lead
    // booked with the Low team. A rate cannot see it (two bookings in twelve
    // hundred was the incident), and the cal.com Slack workflow that covers it
    // today stops at cutover. Every upcoming real booking's pool tier is held
    // against the lead's CURRENT score, so a lead re-scored after booking is
    // caught by the same comparison. Since #3501 that is the score on the lead's
    // current submission, or the Lead's own XBC__c where it was edited after that
    // submission (`readLeadScores`), never a stale copy.
    //
    // Cost on this lane: nothing at all while no real booking is upcoming (no
    // Salesforce call is made for an empty set). Otherwise one bookings read, one
    // token exchange and one SOQL query per ~450 distinct leads, since the lead
    // ids are batched into one IN list per URI budget, plus as many again for the
    // submissions those leads name (#3501), which is one per lead at most, plus a
    // LeadHistory query per ~450 leads whose submission and Lead scores disagree
    // (4 of 1,838 current submissions, measured 2026-10-07), so usually none. At a cutover roster of a
    // few thousand upcoming calls that is about 2 to 8 Salesforce calls every
    // five minutes, against a daily API allowance measured in the hundreds of
    // thousands, and this lane has its own invocation rather than the one the
    // four minute lanes share.
    //
    // #3665 adds at most one more Salesforce query per ~450 leads, and only on an
    // ARMED tick with a booking to page: the newest submissions of just those leads,
    // to say when their score keeps flipping between tiers. Whether the lead's own
    // team is free at the call's time costs nothing, being read off the slot rows
    // and org hours this lane already holds.
    //
    // Gated on the shared bucket list, which says both each pool's tier and which
    // buckets are real. Disarmed until somebody has watched it on real traffic
    // (migration 0136); it measures and logs either way, and a failed read on
    // either side clears nothing and stamps no verdict. ---
    const belowLeadTier = await steps.run<BelowLeadTierResult | null>("below_lead_tier", null, async (step) => {
      if (!gates.belowLeadTier.run) return step.unmeasured(null);
      const realBuckets = buckets!.filter((b) => !b.is_test);
      let session: Promise<{ token: string; instanceUrl: string }> | null = null;
      // #3665: each code's minimum notice, indexed once per tick rather than scanned
      // per finding.
      const noticeByCode = new Map<string, number>();
      for (const r of slotRows ?? []) {
        const notice = r.payload?.eventType?.min_notice_min;
        if (typeof notice === "number") noticeByCode.set(r.bucket_code, notice);
      }
      return runBelowLeadTierCheck({
        loadBookings: () =>
          loadUpcomingBookingsInBuckets(
            db,
            // in-chunk-ok: the real buckets are the routing matrix, sixty codes at the
            // design target, about 2,300 bytes of uuids against the 10,000 budget.
            realBuckets.map((b) => b.id),
            new Date(now).toISOString(),
          ),
        buckets: realBuckets,
        // #3501: the score on each lead's current submission, not the Lead's copy.
        readLeadScores: (ids) =>
          readLeadScores(ids, async (soql) => {
            // One token per tick, fetched only once there is something to ask.
            session ??= sfToken();
            const { token, instanceUrl } = await session;
            return querySoqlAll<LeadXbcRecord>(instanceUrl, token, soql);
          }),
        // #2594: the arrival code, so a lead re-scored after booking is paged as one.
        loadRoutingContext: (ids) => loadRoutingContextByBooking(db, ids),
        listFiring: async () => new Set(await firingFamilyMembers(BELOW_LEAD_TIER_KEY)),
        bookingUrl: (id) => `${appUrl()}${bookingDetailHref(id)}`,
        armed: settings!.belowLeadTierArmed,
        // alert-key: booking_below_lead_tier:*
        // alert-text-ok: our own copy from below-lead-tier.ts, built from measured
        // tiers and the booking row; no error text can reach it.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // No all clear is posted (Dan, 2026-10-07); the state is dropped silently.
        // scripts/test-below-lead-tier.ts proves a failed bookings, Salesforce or
        // firing read settles NOTHING, and an unmeasurable booking keeps its page.
        settle: settleAlertsSilently,
        // No cooldown is passed (2026-10-26): the page posts once per booking and never
        // again (`belowLeadTierRepeat`).
        nowMs: now,
        // #3665: is anybody on the lead's own team free at the call's time? Asked of
        // the served list the lane already holds (`slotByCode`, the stored rows
        // through the org's current hours), so it costs no read and agrees with the
        // availability checks. Either setup read failing is "unreadable", which the
        // page says it could not check, never "nobody is free".
        leadTierOffer: (code) => {
          if (slotByCode === null || slotRows === null) return "unreadable";
          const health = slotByCode.get(code);
          if (health === undefined) return null;
          return {
            offeredMs: health.offeredMs,
            computedAtMs: health.computedAtMs,
            minNoticeMin: noticeByCode.get(code) ?? null,
          };
        },
        // #3665: the lead's newest submissions, asked only for leads about to be
        // paged, on the same token as the score read.
        readSubmissionHistory: (ids) =>
          readRecentSubmissionScores(ids, async (soql) => {
            session ??= sfToken();
            const { token, instanceUrl } = await session;
            return querySoqlAll<LeadXbcRecord>(instanceUrl, token, soql);
          }),
      }).then((result) => {
        if (result.status === "unreadable") {
          log.warn("monitor", { msg: "below lead tier unreadable", stage: result.stage, error: result.error });
        } else {
          log.info("monitor", {
            msg: "below lead tier",
            compared: result.compared,
            test_source: result.testSource,
            below: result.below.length,
            explained_by_tier_drop: result.explainedByTierDrop.length,
            paged: result.paged,
            cleared: result.cleared,
            team_free: result.teamAtTime.free,
            team_not_free: result.teamAtTime["not-free"],
            team_unchecked: result.teamAtTime.unchecked,
            submissions_disagree: result.submissionsDisagree,
            ...Object.fromEntries(
              Object.entries(result.unmeasured).map(([k, v]) => [`unmeasured_${k.replace(/-/g, "_")}`, v]),
            ),
          });
        }
        return result;
      });
    });
    if (!gates.belowLeadTier.run) {
      log.warn("monitor", { msg: "below lead tier skipped", why: gates.belowLeadTier.why });
    }

    // --- A lead booked in BOTH Slate and cal.com (#2933). During the pilot split a
    // lead can reach both bookers, and on 2026-10-01 one did: two live calls, one
    // Submission, and Slate's one call per lead check reads only Slate. Every
    // upcoming real Slate booking is held against every upcoming cal.com booking,
    // matched on the Salesforce Submission id or the attendee address, and each
    // Slate booking with a live cal.com twin pages once, naming both booking ids.
    //
    // Cost on this lane: nothing at all on eleven ticks in twelve. On the tick in
    // the first five minutes of each hour, one Slate read and about six paced
    // cal.com requests (1,252 upcoming bookings measured 2026-10-01, 250 a page),
    // plus one direct read per outstanding page whose twin the listing no longer
    // shows. The whole run is held to CROSS_SYSTEM_BUDGET_MS (45s), so a slow
    // cal.com cannot hold this awaited step. Not gated on the shared setup reads:
    // it reads its own buckets, so a failed shared read cannot blind it. A failed
    // or partial read on either side clears nothing and stamps no verdict. ---
    const crossSystemBookings = await steps.run<CrossSystemBookingsResult | null>("cross_system_bookings", null, (step) =>
      runCrossSystemBookingsCheck({
        nowMs: now,
        clock: Date.now,
        calcomRetired: () => loadCalcomRetiredCached(now),
        loadSlate: () => loadSlateUpcomingBookings(db, new Date(now).toISOString()),
        readCalcom: (afterIso, deadlineAtMs) => calcomUpcomingBookings(afterIso, deadlineAtMs),
        readCalcomByUid: (uid, deadlineAtMs) => calcomBookingByUid(uid, deadlineAtMs),
        listFiring: async () => new Set(await firingFamilyMembers(CROSS_SYSTEM_BOOKING_KEY)),
        bookingUrl: (id) => `${appUrl()}${bookingDetailHref(id)}`,
        // alert-key: cross_system_booking:*
        // alert-text-ok: our own copy from cross-system-bookings.ts, built from booking
        // ids and times; no error text can reach it.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: cross_system_booking:*
        // all-clear-proof: scripts/test-cross-system-bookings.ts - a refused, unreadable
        // or partial cal.com read and a failed Slate read each clear NOTHING, and a
        // booking excluded as a test keeps whatever page it has.
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: cooldownMs.cross_system_booking,
      }).then((result) => {
        if (result.status === "unreadable") {
          log.warn("monitor", { msg: "cross system bookings unreadable", stage: result.stage, error: result.error });
        } else if (result.status === "measured") {
          log.info("monitor", {
            msg: "cross system bookings",
            slate_compared: result.slateCompared,
            calcom_compared: result.calcomCompared,
            test_source: result.testSource,
            pairs: result.pairs.length,
            cleared: result.cleared,
            still_live: result.stillLive,
            unconfirmed: result.unconfirmed,
          });
        } else if (result.status !== "not-due") {
          log.info("monitor", { msg: "cross system bookings skipped", why: result.status });
        }
        // #3955: eleven ticks an hour this check is not due and reads nothing. Recorded
        // as healthy runs they broke every failure streak it built, so a check throwing
        // on every hourly run never paged; it is counted in its own runs instead.
        return result.status === "not-due" ? step.unmeasured(result) : result;
      }),
    );

    // --- A real booking from a host page that is not the production site (#2715).
    // Reads the real buckets' active bookings created inside the lookback and pages
    // once per booking whose recorded `prefill.parentOrigin` or framing page
    // (`referrer_origin`, #2728) is not one of PRODUCTION_ORIGINS. Test buckets are skipped by name, a booking with no origin
    // is counted and never paged, and a failed read pages nothing and is logged as
    // unreadable rather than as zero off site. Once per booking: keys already
    // stamped in alert_state are skipped, and the cooldown outlasts the lookback.
    // Gated on the shared bucket list, which is what says which buckets are real. ---
    const offsiteOrigin = await steps.run("offsite_origin", null, async (step) => {
      if (!gates.offsiteOrigin.run) {
        log.warn("monitor", { msg: "offsite origin skipped", why: gates.offsiteOrigin.why });
        return step.unmeasured(null);
      }
      return runOffsiteOriginCheck({
        loadBookings: () =>
          loadRecentBookingsInBuckets(
            db,
            // in-chunk-ok: the real buckets are the routing matrix, sixty codes at the
            // design target, about 2,300 bytes of uuids against the 10,000 budget.
            buckets!.filter((b) => !b.is_test).map((b) => b.id),
            new Date(now - OFFSITE_ORIGIN_LOOKBACK_MS).toISOString(),
          ),
        buckets: buckets!,
        alreadyPaged: (keys) => existingAlertStateKeys(keys),
        // alert-key: booking_offsite_origin:*
        // alert-text-ok: our own copy from offsite-origin.ts, built from the booking
        // row and a parsed origin; no error text and no raw host value can reach it.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        bookingUrl: (id) => `${appUrl()}${bookingDetailHref(id)}`,
      }).then((result) => {
        if (result.status === "unreadable") {
          log.warn("monitor", { msg: "offsite origin unreadable", error: result.error });
        } else {
          log.info("monitor", {
            msg: "offsite origin",
            checked: result.checked,
            production: result.production,
            no_origin: result.noOrigin,
            test_bucket: result.testBucket,
            unknown_bucket: result.unknownBucket,
            offsite: result.offsite,
            paged: result.paged,
            already_paged: result.alreadyPaged,
            send_failed: result.sendFailed,
            dedupe_unread: result.dedupeUnread,
          });
        }
        return result;
      });
    });

    // --- Calling in Regal while Slate will not route to them (#2090). Regal posts
    // every completed call to /api/regal/calls, and the edge keeps a row per event
    // under the reason it was kept or dropped. This reads the last half hour of
    // CANDIDATE calls (a human on our domain who is a Slate user), the roster, the
    // ignore list and the pages already open in the family, and pages once per
    // agent per cooldown for anybody not routable and not exempt. Every read is in
    // this boundary, and the only shared setup state it consumes is its arming
    // switch. A read that fails measures nothing, pages nobody and clears nothing.
    //
    // Armed by the `regal_calls_armed` setting (#2695, migration 0138); while it
    // is off it measures and logs every tick and sends nothing. ---
    const loadRegalCounts = async (sinceIso: string): Promise<RegalReasonCounts> =>
      countsFromRows(
        unwrap(
          await db.rpc("regal_call_reason_counts", { p_since: sinceIso }),
          "monitor regal call reason counts",
        ) ?? [],
      );
    // #2773: armed by the settings, so it stands down with none readable and none
    // known, rather than run disarmed by default.
    const regalCalls = await steps.run("regal_calls", null, async (step) =>
      !gates.regalCalls.run
        ? step.unmeasured(null)
        : runRegalCallCheck({
        loadCandidates: (sinceIso) =>
          selectAllPages<RegalCandidate>("monitor regal call candidates", "id", () =>
            db
              .from("regal_call_events")
              .select("id, agent_email, occurred_at")
              .eq("reason", "candidate")
              .gte("received_at", sinceIso),
          ),
        loadUsers: () =>
          selectAllPages<RegalCaller>("monitor regal call roster", "id", () =>
            db
              .from("users")
              .select(`id, name, email, role, bookable, deactivated_at, attributes, ${REAL_ADVISOR_COLUMNS}`),
          ),
        loadIgnores: () =>
          selectAllPages<RegalIgnore>("monitor regal call ignore list", "user_id", () =>
            db.from("regal_call_ignores").select("user_id, reason"),
          ),
        loadFiringUserIds: () => firingFamilyMembers(REGAL_CALL_ALERT_PREFIX),
        armed: settings!.regalCallsArmed,
        // alert-key: regal_call_unroutable:*
        // alert-text-ok: our own copy from regal-calls.ts, built from roster fields and a
        // formatted time; no error text can reach it.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: regal_call_unroutable:*
        // all-clear-proof: scripts/test-regal-call-detector.ts pins that a failed read of
        // the events, the roster, the ignore list or the open pages clears nothing, and that
        // a disarmed tick clears nothing.
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: cooldownMs.regal_call_unroutable,
        nowMs: now,
      }),
    );
    if (regalCalls) {
      log.info("monitor", {
        msg: "regal calls",
        status: regalCalls.status,
        ...(regalCalls.status === "checked"
          ? {
              callers: regalCalls.callers,
              flagged: regalCalls.flagged.length,
              flagged_emails: regalCalls.flagged.map((v) => v.email).join(","),
              exempt: JSON.stringify(regalCalls.exempt),
              paged: regalCalls.paged,
            }
          : {}),
        ...(regalCalls.status === "unreadable" ? { error: regalCalls.error } : {}),
        ...(regalCalls.status !== "unreadable" ? { settled: regalCalls.settled.join(",") } : {}),
      });
    }

    // --- The Regal feed itself (#2090): did anything from a Slate user arrive
    // during the last whole business day, and did anything arrive that the edge
    // could not read. Two conditions, each in its own boundary, each from one
    // per reason count, and each silent in both directions when that count cannot
    // be read. The quiet one needs the org's week to know which day was the last
    // whole one, so it is gated on it; the unreadable one is not. Same switch as
    // the detector above, so both are gated on the settings too (#2773). ---
    const regalQuiet = await steps.run("regal_calls_quiet", null, async (step) =>
      !gates.regalCallsQuiet.run || !businessHours
        ? step.unmeasured(null)
        : runRegalFeedQuietCheck({
            hours: { zone: businessHours.zone, rules: businessHours.rules, exceptions: businessHours.exceptions },
            loadCounts: loadRegalCounts,
            armed: settings!.regalCallsArmed,
            // alert-key: regal_calls_quiet
            notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
            // alert-key: regal_calls_quiet
            // all-clear-proof: scripts/test-regal-call-feed.ts pins that unreadable counts and
            // a disarmed tick clear nothing, and that only a measured call from a Slate user does.
            resolve: (key, text) => resolveAlert(key, text),
            cooldownMs: cooldownMs.regal_calls_quiet,
            nowMs: now,
          }),
    );
    if (!gates.regalCallsQuiet.run) {
      log.warn("monitor", { msg: "regal calls quiet check skipped", why: gates.regalCallsQuiet.why });
    } else if (regalQuiet) {
      log.info("monitor", {
        msg: "regal calls quiet",
        status: regalQuiet.status,
        // #2798: the reason is what tells a failed RPC from an org with no whole
        // business day to judge, and the verdict lane's page sends a reader here.
        ...(regalQuiet.status === "unmeasured" ? { why: regalQuiet.why } : {}),
      });
    }
    const regalUnreadable = await steps.run("regal_calls_unreadable", null, async (step) =>
      !gates.regalCallsUnreadable.run
        ? step.unmeasured(null)
        : runRegalFeedUnreadableCheck({
        loadCounts: loadRegalCounts,
        armed: settings!.regalCallsArmed,
        // alert-key: regal_calls_unreadable
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: regal_calls_unreadable
        // all-clear-proof: scripts/test-regal-call-feed.ts pins that unreadable counts and
        // a disarmed tick clear nothing, and that only a measured clean day does.
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: cooldownMs.regal_calls_unreadable,
        nowMs: now,
      }),
    );
    if (regalUnreadable) {
      log.info("monitor", {
        msg: "regal calls unreadable",
        status: regalUnreadable.status,
        ...(regalUnreadable.status === "unmeasured" ? { why: regalUnreadable.why } : {}),
      });
    }

    // --- Call outcomes (#2944): is a regal_call_outcomes row being written for each
    // completed advisor call Regal posts? The show rate in the Slate vs cal.com split
    // is computed from that table, which fills in silence. Advisor calls received
    // (human reasons only, #2950) come from the detector's per reason counts (a different writer from the one
    // judged), outcome rows from a server side count, both over the last two hours.
    // Under 80% on two consecutive checks pages; only a measured healthy ratio
    // clears; a window with no calls decides nothing. Same Regal arming switch. ---
    const regalOutcomes = await steps.run("regal_call_outcomes", null, async (step) =>
      !gates.regalCallOutcomes.run
        ? step.unmeasured(null)
        : runRegalCallOutcomesCheck({
            loadReasonCounts: loadRegalCounts,
            // Human rows only, the population the received side counts (#2950).
            countOutcomes: (sinceIso) => countHumanOutcomesSince(db as unknown as OutcomeCountDb, sinceIso),
            // The oldest stored row, so a freshly created table is judged only over
            // the time it has existed. One indexed row, never a list.
            firstOutcomeAtMs: async () => {
              const row = unwrap(
                await db
                  .from("regal_call_outcomes")
                  .select("received_at")
                  .order("received_at", { ascending: true })
                  .limit(1)
                  .maybeSingle(),
                "monitor regal call outcome first row",
              ) as { received_at: string } | null;
              if (row === null) return null;
              const ms = parseStampMs(row.received_at);
              if (ms === null) throw new Error("regal_call_outcomes first received_at is unreadable");
              return ms;
            },
            streak: () => recordFailureStreak(REGAL_CALL_OUTCOMES_STREAK_KEY, REGAL_CALL_OUTCOMES_STREAK_WINDOW_S),
            clearStreak: () => clearFailureStreak(REGAL_CALL_OUTCOMES_STREAK_KEY),
            armed: settings!.regalCallsArmed,
            // alert-key: regal_call_outcomes_short
            notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
            // alert-key: regal_call_outcomes_short
            // all-clear-proof: scripts/test-regal-call-outcomes-monitor.ts pins that a failed
            // read of either count, a window with no calls, too few calls and a disarmed tick
            // clear nothing, and that only a measured ratio at or above 80% does.
            resolve: (key, text) => resolveAlert(key, text),
            cooldownMs: cooldownMs.regal_call_outcomes_short,
            nowMs: now,
          }),
    );
    if (regalOutcomes) {
      log.info("monitor", {
        msg: "regal call outcomes",
        status: regalOutcomes.status,
        ...("received" in regalOutcomes ? { received: regalOutcomes.received, written: regalOutcomes.written } : {}),
        ...(regalOutcomes.status === "short" ? { paged: regalOutcomes.paged, ...(regalOutcomes.pageError ? { page_error: regalOutcomes.pageError } : {}) } : {}),
        ...(regalOutcomes.status === "unmeasured" ? { why: regalOutcomes.why } : {}),
        ...(regalOutcomes.status === "healthy" && regalOutcomes.resolveError ? { resolve_error: regalOutcomes.resolveError } : {}),
      });
    }

    // --- A placeholder call past its time with no Regal call to the customer (#4206).
    // Nobody dials as the placeholder: Regal sends the call to the pool at its time,
    // so the one way the customer is left waiting is Regal never calling at all. This
    // reads the day's placeholder calls in the REAL buckets, the pages already open,
    // the calls to those customers' Leads and the feed's newest arrival (its positive
    // control), and pages per booking. Gated on the shared bucket list, which is what
    // keeps a test bucket's drill call off the page. A failed read measures nothing,
    // pages nobody and clears nothing. ---
    const placeholderCalls = await steps.run("placeholder_calls", null, async (step) => {
      if (!gates.placeholderCalls.run) {
        log.warn("monitor", { msg: "placeholder calls skipped", why: gates.placeholderCalls.why });
        return step.unmeasured(null);
      }
      return runPlaceholderCallCheck({
        loadCandidates: (sinceIso, untilIso) =>
          loadPlaceholderCallCandidates(
            db,
            // in-chunk-ok: the real buckets are the routing matrix, sixty codes at the
            // design target, about 2,300 bytes of uuids against the 10,000 budget.
            buckets!.filter((b) => !b.is_test).map((b) => b.id),
            sinceIso,
            untilIso,
          ),
        loadFiringIds: () => firingFamilyMembers(PLACEHOLDER_CALL_ALERT_PREFIX),
        loadBookingsById: (ids) => loadPlaceholderBookingsById(db, ids),
        loadCalls: (leadKeys, sinceIso) => loadPlaceholderCalls(db, leadKeys, sinceIso),
        feedNewestReceivedMs: () => loadCallFeedNewestReceivedMs(db),
        bookingUrl: (id) => `${appUrl()}${bookingDetailHref(id)}`,
        // alert-key: placeholder_call_unserved:*
        // alert-text-ok: our own copy from placeholder-calls.ts, built from the booking
        // row, a Lead id and formatted times; no error text can reach it.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: placeholder_call_unserved:*
        // all-clear-proof: scripts/test-placeholder-calls.ts pins that a failed read of the
        // bookings, the open pages, the calls or the feed clears nothing, that a feed behind
        // the due time clears nothing, and that only a call found is worded as a recovery.
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: CONDITION_REPEAT_MS,
        nowMs: now,
      }).then((result) => {
        // Thrown, so the step's failing streak pages a read that stays broken: the
        // check is silent on a healthy day, and an unreadable tick must not look like one.
        if (result.status === "unreadable") throw new Error(`placeholder calls unreadable: ${result.error}`);
        return result;
      });
    });
    if (placeholderCalls) {
      log.info("monitor", {
        msg: "placeholder calls",
        status: placeholderCalls.status,
        ...(placeholderCalls.status === "checked"
          ? {
              judged: placeholderCalls.judged,
              not_due: placeholderCalls.notDue,
              served: placeholderCalls.served,
              feed_behind: placeholderCalls.feedBehind,
              no_lead_id: placeholderCalls.noLeadId.join(","),
              unserved: placeholderCalls.unserved.join(","),
              settled: placeholderCalls.settled.join(","),
            }
          : {}),
      });
    }

    // --- A reminder email owed to a lead whose call is still ahead, and not recorded
    // (#4300). For every switched on email, the live calls in REAL buckets whose time
    // for it came over 15 minutes ago with no send, skip or failure on record, or a claim
    // over 15 minutes old that never settled, judged by its own reading of the rules and
    // never the lane's `reminderDecision` (L721). It does every read itself (the emails,
    // the bookings joined to their bucket's test flag, the open pages), so it consumes no
    // setup read and is not gated. A failed read measures nothing, pages nobody, clears
    // nothing, and is thrown so this step's failing streak pages a read that stays broken. ---
    const reminderOwed = await steps.run("reminder_owed", null, async () =>
      runReminderOwedCheck({
        loadEmails: () => loadOwedEmails(db),
        loadBookings: (windowEndIso) => loadOwedBookings(db, new Date(now).toISOString(), windowEndIso),
        loadFiringSlugs: () => firingFamilyMembers(REMINDER_OWED_ALERT_PREFIX),
        // alert-key: reminder_email_owed:*
        // alert-text-ok: our own copy from reminder-owed.ts, built from the email's stored
        // name and booking ids; no error text can reach it.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: reminder_email_owed:*
        // all-clear-proof: scripts/test-reminder-owed.ts pins that a failed read of the
        // emails, the bookings or the open pages clears nothing, that an email still owed
        // clears nothing, and that an email switched off or removed stands down in its own
        // words rather than the recovery's.
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: CONDITION_REPEAT_MS,
        nowMs: now,
      }).then((result) => {
        if (result.status === "unreadable") throw new Error(`reminder owed unreadable: ${result.error}`);
        return result;
      }),
    );
    if (reminderOwed) {
      log.info("monitor", {
        msg: "reminder owed",
        status: reminderOwed.status,
        ...(reminderOwed.status === "checked"
          ? {
              judged: reminderOwed.judged,
              owed: Object.entries(reminderOwed.owed)
                .map(([slug, o]) => `${slug}:unrecorded=${o.unrecorded},stale_claims=${o.staleClaims}`)
                .join(";"),
              unreadable: reminderOwed.unreadable,
              paged: reminderOwed.paged.join(","),
              cleared: reminderOwed.cleared.join(","),
            }
          : {}),
      });
    }

    // --- The placeholder advisor's Google seat (#4206). Its invites and reminders go
    // out from its own Calendar and Gmail, and every advisor health path skips it on
    // purpose (it is never bookable), so this probes both, and its standing Gmail auto
    // reply (#4265), read only, while the seat is
    // in use (the switch is on, or a call still sits on it), and pages on a definitive
    // failure over two ticks or a transient one over four. Also pages when the switch is
    // on and no usable placeholder exists. Consumes no setup read, so it is not gated. ---
    const placeholderSeat = await steps.run("placeholder_seat", null, async () =>
      runPlaceholderSeatCheck({
        readSwitch: () => readPlaceholderBookingEnabled(),
        loadPlaceholders: () => loadRealPlaceholders(db),
        countFutureCalls: (ids) => countFutureCallsOnPlaceholders(db, ids, new Date(now).toISOString()),
        probeCalendar: probePlaceholderCalendar,
        probeGmail: probePlaceholderGmail,
        // #4265: the seat's standing auto reply, under its own gmail.settings.basic token;
        // a refusal for want of that permission reads as not granted, never as failing.
        probeAutoReply: (email) => probePlaceholderAutoReply(email, now),
        bumpStreak: (alertAt) => trackConsecutiveStreak(PLACEHOLDER_SEAT_STREAK_KEY, PLACEHOLDER_SEAT_STREAK_WINDOW_S, alertAt),
        clearStreak: () => clearFailureStreak(PLACEHOLDER_SEAT_STREAK_KEY),
        // alert-key: placeholder_seat_failing
        // alert-key: placeholder_missing
        // alert-text-ok: our own copy from placeholder-seat.ts, built from the seat's address
        // and the failure KIND; no error text can reach it.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: placeholder_seat_failing
        // alert-key: placeholder_missing
        // all-clear-proof: scripts/test-placeholder-seat.ts pins that an unreadable switch,
        // placeholder read or call count clears nothing, that a seat with nothing to probe
        // clears nothing, and that only both probes answering is worded as a recovery.
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: CONDITION_REPEAT_MS,
      }).then((result) => {
        // Thrown for the same reason: a seat nobody can read about is not a healthy seat.
        if (result.status === "unreadable") throw new Error(`placeholder seat unreadable: ${result.error}`);
        return result;
      }),
    );
    if (placeholderSeat) {
      log.info("monitor", {
        msg: "placeholder seat",
        status: placeholderSeat.status,
        ...(placeholderSeat.status === "checked"
          ? {
              switch_on: placeholderSeat.switchOn,
              future_calls: placeholderSeat.futureCalls,
              missing: placeholderSeat.missing,
              seat: placeholderSeat.seat,
              failures: placeholderSeat.failures.map((f) => `${f.surface}:${"problem" in f ? f.problem : f.kind}`).join(","),
              // #4265: said every tick while the read permission is not granted, so the
              // day it is granted is visible as this going empty.
              auto_reply_unchecked: placeholderSeat.autoReplyUnchecked.join(","),
              paged: placeholderSeat.paged,
            }
          : {}),
      });
    }

    // --- Routing-attribute coverage (#226): a bookable agent with no routing
    // attributes matches no bucket criteria, so unless someone added them as a
    // manual member they are never routed a booking. There is no self-heal
    // (attributes can't be invented), so this only whispers the list. Both reads
    // page past the 1,000-row cap. ---
    const loadUnroutableAgents = async (): Promise<UnroutableAgent[]> => {
      const [agents, members] = await Promise.all([
        selectAllPages<{
          id: string;
          name: string | null;
          email: string | null;
          attributes: Attributes | null;
        }>(
          "monitor attribute-coverage bookable agents",
          "id",
          () =>
            realAdvisorsOnly(
              db.from("users").select("id, name, email, attributes").eq("bookable", true).is("deactivated_at", null),
            ),
        ),
        selectAllPages<{ user_id: string }>(
          "monitor attribute-coverage manual members",
          "id",
          () =>
            db.from("bucket_members").select("id, user_id").eq("active", true),
        ),
      ]);
      return findUnroutableAgents(agents, new Set(members.map((m) => m.user_id)));
    };
    const attributeCoverage = await steps.run("attribute_coverage", null, () =>
      runAttributeCoverageCheck({
        loadUnroutableAgents,
        // alert-key: agents_without_routing
        notify: sendThrottledInfo,
        cooldownMs: cooldownMs.agents_without_routing,
        log: (m) => log.info("attribute-coverage", { msg: m }),
      }),
    );

    // --- Appointments held by an agent who has left the pool (#1215): a customer
    // booked with a departed advisor. Deactivating and reassigning are independent
    // actions, and the Salesforce roster sync deactivates with no admin present at
    // all, so this is the backstop for both paths. Two reads: the out-of-pool
    // roster, then ONE bulk booking query over those ids (a count per agent would
    // spend the subrequest budget this lane shares with three others). Both go
    // through `unwrap`, because a read that failed comes back empty and an empty
    // result here is indistinguishable from "nobody is holding anything", which
    // would post an all-clear over a real gap. ---
    const loadInactiveHolders = async () => {
      // cap-safe: `users` is roster-bounded (a fixed 100-200 agent target), so the
      // out-of-pool subset can never fill a PostgREST page.
      const agents = (unwrap(
        // #4201: real advisors only. The placeholder is never bookable and holds every
        // stacked call, so it would page here for each one.
        await realAdvisorsOnly(
          db
            .from("users")
            .select("id, name, email, deactivated_at, attributes")
            .or("bookable.eq.false,deactivated_at.not.is.null"),
        ),
        "monitor inactive-agent roster",
      ) ?? []) as {
        id: string;
        name: string | null;
        email: string | null;
        deactivated_at: string | null;
        attributes: Attributes | null;
      }[];
      if (agents.length === 0) return [];
      const nowIso = new Date(now).toISOString();
      const outOfPool: OutOfPoolAgent[] = agents.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        deactivated: a.deactivated_at !== null,
        // #3599: an agent mid debounced-redistribute-sweep holds their calls by design
        // for one sync; the automatic sweep is what moves them, so do not page on it.
        coveredByPendingSweep: redistributeSweepPending(a.attributes, nowIso),
      }));
      // Every page: an offboarding backlog can hold more than 1,000 upcoming
      // bookings between them, and a truncated page would under-report the gap.
      const bookings = await selectAllPages<{ id: string; assigned_user_id: string | null }>(
        "monitor inactive-agent bookings",
        "id",
        () =>
          db
            // agent-link-ok: an upcoming call held by somebody who has left needs
            // a person however it was booked, including through their own link (#2073).
            // test-data-ok: scoped to outOfPool, which are real advisors (realAdvisorsOnly on
            // the users read above), so no test fixtures can be counted.
            .from("bookings")
            .select("id, assigned_user_id")
            .in("assigned_user_id", outOfPool.map((a) => a.id))
            .in("status", ACTIVE_BOOKING_STATUSES)
            .gte("starts_at", new Date(now).toISOString()),
      );
      if (bookings.length === 0) return [];
      // The calls a coverage sweep already holds are left to it: it retries them hourly and
      // `coverage_needs_human` pages for any it cannot place before they start. Paging here
      // too sent a person to rerun a sweep that had already failed (2026-10-12). Only the
      // held statuses are read, so the healthy case stays one small read per chunk, and
      // split across requests because an offboarding backlog can exceed the `in` URL budget
      // (#2388). It THROWS on failure like the reads above: an unread held set would count
      // every held call and re-page, which is noisy, but treating it as "all held" would
      // silence a real gap, so the check reports unreadable rather than guess either way.
      const heldItems = (
        await inIdChunks("monitor inactive-agent sweep items", bookings.map((b) => b.id), (batch) =>
          selectAllPages<{
            id: string;
            booking_id: string;
            status: string;
            bulk_reassign_jobs: { out_user_id: string } | null;
          }>("monitor inactive-agent sweep items", "id", () =>
            db
              .from("bulk_reassign_items")
              .select("id, booking_id, status, bulk_reassign_jobs!inner(out_user_id)")
              .in("booking_id", batch)
              .in("status", SWEEP_HELD_ITEM_STATUSES),
          ),
        )
      ).flat();
      const heldBySweep = sweepHeldBookingIds(
        new Map(bookings.map((b) => [b.id, b.assigned_user_id])),
        heldItems.flatMap((it) =>
          it.bulk_reassign_jobs
            ? [{ booking_id: it.booking_id, status: it.status, out_user_id: it.bulk_reassign_jobs.out_user_id }]
            : [],
        ),
      );
      return inactiveHoldersFromBookings(outOfPool, bookings, heldBySweep);
    };
    // #3582: the demotion backstop. A BOOKABLE agent a Twilio tier/backend change took off a pool
    // the bookings they hold need is invisible to the pool-exit read above (they are still in the
    // pool), so an un-rerouted held booking (the sweep failed, or found no eligible advisor) would
    // go uncaught. Only agents carrying a demotion mark are read (so this is inert until the
    // reroute feature is armed and stamps appear), and only those past the sweep's debounce window.
    const loadDemotedHolders = async (): Promise<DemotedAgent[]> => {
      const nowIso = new Date(now).toISOString();
      // cap-safe: users is roster-bounded (100-200 agent target), so the bookable subset fits a page.
      const bookable = (unwrap(
        await realAdvisorsOnly(
          db.from("users").select("id, name, email, attributes").eq("bookable", true).is("deactivated_at", null),
        ),
        "monitor demoted-agent roster",
      ) ?? []) as { id: string; name: string | null; email: string | null; attributes: Attributes | null }[];
      // Only marked agents past the debounce window; a pending sweep holds its calls by design.
      const stamped = bookable.filter(
        (a) => storedDemotionStamp(a.attributes) !== null && !demotionSweepPending(a.attributes, nowIso),
      );
      if (stamped.length === 0) return [];
      const stampedIds = stamped.map((a) => a.id);
      // One bulk bookings read over the marked agents, not one per agent, so the shared monitor
      // budget is spent once (the sync lane this backstop watches is the budget-tight one).
      const rows = await selectAllPages<DemotionCandidateRow & { assigned_user_id: string | null }>(
        "monitor demoted-agent bookings",
        "id",
        () =>
          db
            // agent-link-ok: all kinds are read; the demotion snapshot (unservedBookingIds) drops
            // agent_link bookings itself, exactly as the reroute does, so the query need not.
            // test-data-ok: scoped to stampedIds, which are real advisors (realAdvisorsOnly on the
            // users read above), so no test fixtures can be counted.
            // in-chunk-ok: stampedIds is a SUBSET of the bookable roster (design ceiling 200, the
            // in() URL id limit), and in practice a small transient set of currently-marked agents.
            .from("bookings")
            .select("id, starts_at, ends_at, attendee_name, bucket_id, kind, assigned_user_id")
            .in("assigned_user_id", stampedIds)
            .in("status", ACTIVE_BOOKING_STATUSES)
            .gte("starts_at", nowIso),
      );
      const bucketIds = [...new Set(rows.map((r) => r.bucket_id))];
      const criteriaByBucket =
        bucketIds.length === 0
          ? new Map<string, Criteria | null>()
          : criteriaMapOrThrow(
              bucketIds,
              unwrap(
                // cap-safe: a primary-key `in` over the distinct buckets of the marked agents' bookings.
                // in-chunk-ok: bucketIds is the DISTINCT buckets of those bookings, bounded by the
                // roster's ~60 buckets, so the filter can never exceed the URL id ceiling.
                await db.from("buckets").select("id, criteria").in("id", bucketIds),
                "monitor demoted-agent bucket criteria",
              ) as { id: string; criteria: Criteria | null }[],
            );
      const memberRows = (unwrap(
        // cap-safe: bucket_members for a bounded set of marked agents.
        // in-chunk-ok: stampedIds is a subset of the bookable roster (design ceiling 200, the in()
        // URL id limit), so the filter cannot exceed it.
        await db.from("bucket_members").select("bucket_id, user_id").in("user_id", stampedIds).eq("active", true),
        "monitor demoted-agent memberships",
      ) ?? []) as { bucket_id: string; user_id: string }[];
      const membersByUser = new Map<string, Set<string>>();
      for (const m of memberRows) {
        const set = membersByUser.get(m.user_id) ?? new Set<string>();
        set.add(m.bucket_id);
        membersByUser.set(m.user_id, set);
      }
      // #3615: the calls an admin moved back to these agents are theirs by decision, so the
      // backstop does not count them. One read over every marked agent.
      const pinnedByUser = await pinnedDemotionBookingIds(stampedIds);
      return demotedAgentsFrom({ stamped, rows, criteriaByBucket, membersByUser, pinnedByUser });
    };
    const inactiveBookings = await steps.run("inactive_bookings", null, () =>
      runInactiveAgentBookingsCheck({
        loadHolders: loadInactiveHolders,
        cooldownMs: cooldownMs.inactive_agent_bookings,
        log: (fields) => log.info("inactive-agent-bookings", { msg: "tick", ...fields }),
      }),
    );
    // #3582: the demotion backstop, in its OWN step so a failed demotion read makes only this
    // check unreadable and never blinds the #1215 departed-agent check above (L71). Its own alert
    // key, streak and copy, because the cause and remediation differ (a demoted agent is still
    // bookable; their held booking needs rerouting, which the automatic reroute should have done).
    const demotedBookings = await steps.run("demoted_bookings", null, () =>
      runInactiveAgentBookingsCheck({
        loadHolders: async () => demotedHolders(await loadDemotedHolders()),
        // Change only (`CHANGE_ONLY_KEYS`, Dan 2026-10-26): each call is posted once and never
        // as a reminder, so no setting paces it and the hold is the change only one.
        cooldownMs: CHANGE_ONLY_HOLD_MS,
        key: DEMOTED_AGENT_BOOKINGS_KEY,
        formatAlert: formatDemotedAgentBookingsAlert,
        formatRecovery: formatDemotedAgentBookingsRecovery,
        sendOptions: (holders) => demotedAgentBookingsSend(holders, Date.now()),
        log: (fields) => log.info("demoted-agent-bookings", { msg: "tick", ...fields }),
      }),
    );

    // --- Two active calls on one advisor closer than the call type's buffers (#3040).
    // Every offer and confirm judges the buffered window, so this measures the RESULT:
    // a forced reassign (allow_double_book) stacks calls on purpose and is counted as
    // `forced` in the result and the log line, never paged; anything else pages on
    // booking_buffer_breach naming the pairs. A failed read throws, so the step fails
    // and returns null rather than reading as no breaches; the all clear hangs only
    // off a measured read. Gated on the horizon, which is the window it judges. ---
    const bufferBreach = await steps.run<BufferBreachResult | null>("buffer_breach", null, async (step) => {
      if (!gates.bufferBreach.run) {
        log.warn("monitor", { msg: "buffer breach check skipped", why: gates.bufferBreach.why });
        return step.unmeasured(null);
      }
      return runBufferBreachCheck({
        load: () =>
          loadBookingsForBufferCheck(
            db,
            new Date(now).toISOString(),
            new Date(now + (horizonDays as number) * 24 * 60 * 60_000).toISOString(),
          ),
        // alert-key: booking_buffer_breach
        // alert-text-ok: our own copy from buffer-breach.ts, built from booking ids,
        // advisor names and times; no error text can reach it.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // alert-key: booking_buffer_breach
        // all-clear-proof: scripts/test-buffer-breach.ts - a failed read throws out of
        // the check and settles nothing, and only a measured read with no breach resolves.
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: CONDITION_REPEAT_MS,
        bookingUrl: (id) => `${appUrl()}${bookingDetailHref(id)}`,
      }).then((result) => {
        log.info("monitor", {
          msg: "buffer breaches",
          key: BUFFER_BREACH_KEY,
          examined: result.examined,
          unassigned: result.unassigned,
          breaches: result.breaches,
          forced: result.forced,
        });
        return result;
      });
    });

    // --- Appointments a coverage sweep GAVE UP on (#1242). The complement of the
    // check above: that one measures agents out of the pool, this one measures the
    // sweep's own terminal outcomes, so it covers every origin (admin panel, an
    // approved absence, offboarding) including agents who are still active. Both
    // reads go through `unwrap`, because an unread worklist comes back empty and an
    // empty result here is indistinguishable from "nothing is stranded", which
    // would post an all-clear over a real gap.
    //
    // #3303: what counts is decided by `countStranded` (a finished sweep's give
    // ups, one per booking, only while the booking is still with the sweep's out
    // agent), so this reads the facts it needs and nothing more. ---
    const loadStrandedHolders = async (): Promise<StrandedRead> => {
      // Taken BEFORE the first read, never after: a sweep that finishes while these
      // reads run is left for the next tick, where it reads as news and re-pages,
      // rather than landing on this page with a stamp after its measurement time.
      const asOfMs = Date.now();
      // #3485: the deployment base url, so the page can link the booking and the agent.
      const appBaseUrl = appUrl();
      const nothing: StrandedRead = { holders: [], waiting: 0, newestCountableMs: null, asOfMs, appBaseUrl };
      const items = await selectAllPages<{
        booking_id: string;
        status: string;
        job_id: string;
        updated_at: string;
      }>("monitor stranded coverage items", "id", () =>
        db
          .from("bulk_reassign_items")
          .select("id, booking_id, status, job_id, updated_at")
          .in("status", ACTIONABLE_ITEM_STATUSES),
      );
      // #3485 part C: pending items are coverage work still in flight: a fresh sweep's items
      // before the drain, or a stranded call the hourly retry just re-armed. The ones for an
      // active, UPCOMING booking count as `waiting`, so an empty actionable read mid-retry is
      // not read as "all placed" and does not send a false all-clear (#1152). Scoped to
      // upcoming below (via the shared booking read), so an orphaned pending row for a passed
      // booking, or one a dead drain abandoned on a past call, can never keep the alert from
      // clearing for ever.
      const pendingItems = await selectAllPages<{ id: string; job_id: string; booking_id: string }>(
        "monitor in-flight coverage items",
        "id",
        () => db.from("bulk_reassign_items").select("id, job_id, booking_id").eq("status", "pending"),
      );
      if (items.length === 0 && pendingItems.length === 0) return nothing;
      // Only an UPCOMING appointment needs a person: a stranded one that has passed
      // is history, and paging about it would never clear.
      //
      // Split across requests (#2388). `items` comes from `selectAllPages`, so it is
      // unbounded by construction, and one `in` filter of every booking id is refused
      // by PostgREST past roughly 266 uuids. A refusal here reads as "nothing is
      // upcoming" only because the throw takes the whole check with it, which is the
      // quiet direction: the stranded appointments stay stranded and unreported.
      const bookingPages = await inIdChunks(
        "monitor stranded coverage bookings",
        // Deduped: two sweeps over one day name the same booking twice (#3303). Covers the
        // pending items too (#3485 part C), so their bookings are judged active+upcoming here.
        [...new Set([...items, ...pendingItems].map((it) => it.booking_id))],
        async (batch) =>
          (unwrap(
            await db
              // agent-link-ok: a stranded coverage item is a real call waiting for
              // a person, whatever kind of booking it is (#2073).
              .from("bookings")
              // cap-safe: primary-key lookup, already split to the URL budget.
              // #3597: also read the holder's pool state, so a call whose agent is back in
              // the pool (a cleared Redistribute flap) is no longer counted stranded,
              // judged by the same hasLeftPool rule the sweep uses so a departed agent is
              // not mistaken for a covered one.
              // #3485 part C: also read starts_at, so the page can hold until the call is
              // within the lead window (it is already filtered on below).
              .select(`id, assigned_user_id, starts_at, users!bookings_assigned_user_id_fkey(${POOL_STATE_COLUMNS})`)
              .in("id", batch)
              .in("status", ACTIVE_BOOKING_STATUSES)
              .gte("starts_at", new Date(now).toISOString()),
            "monitor stranded coverage bookings",
          ) ?? []) as {
            id: string;
            assigned_user_id: string | null;
            starts_at: string;
            users: PoolStateRow | null;
          }[],
      );
      // Who holds each active, upcoming booking NOW (#3303): `countStranded` keeps
      // a give up only while that is still the sweep's out agent. Also whether that
      // holder is back in the pool (#3597): a missing user row reads as NOT in the pool,
      // the safe direction (the call stays stranded and reported). And when it starts
      // (#3485 part C), for the paging lead window.
      // #3595: built by the helper the agent page's standing list also uses, so both
      // judge "back in the pool" by one rule.
      const holderByBooking = new Map(bookingPages.flat().map((b) => [b.id, strandedHolderNow(b)]));
      const live = items.filter((it) => holderByBooking.has(it.booking_id));
      // Pending coverage items for an active, upcoming booking: candidate in-flight work.
      const livePending = pendingItems.filter((p) => holderByBooking.has(p.booking_id));
      // The out agent lives on the job, so resolve the jobs behind BOTH the actionable and
      // the pending items in one read, so the shared "still stranded" predicate can judge
      // each. Split across requests (#2388): `bulk_reassign_jobs` accumulates over time, so
      // the distinct job ids behind these items are bounded by nothing in particular, unlike
      // the AGENT ids below, which the roster bounds.
      const jobPages = await inIdChunks(
        "monitor stranded coverage jobs",
        [...new Set([...live, ...livePending].map((it) => it.job_id))],
        async (batch) =>
          (unwrap(
            await db
              .from("bulk_reassign_jobs")
              // cap-safe: primary-key lookup, already split to the URL budget.
              // #3597: redistribute_marked_at tells a Redistribute sweep from an OOO one,
              // so the in-pool exclusion applies only to the former.
              // #3485: the cause columns say WHY the out agent will not be there, so the
              // page can state the reason rather than only naming the agent.
              .select(
                "id, out_user_id, status, updated_at, redistribute_marked_at, ooo_request_id, offboarding_deactivated_at, demotion_marked_at, created_by",
              )
              .in("id", batch),
            "monitor stranded coverage jobs",
          ) ?? []) as Pick<
            BulkReassignJob,
            | "id"
            | "out_user_id"
            | "status"
            | "updated_at"
            | "redistribute_marked_at"
            | "ooo_request_id"
            | "offboarding_deactivated_at"
            | "demotion_marked_at"
            | "created_by"
          >[],
      );
      const jobById = new Map(jobPages.flat().map((j) => [j.id, j]));
      // In-flight = distinct bookings among the pending items that are STILL stranded by the
      // SAME predicate the stranded page uses (#3485 part C, L342): on the sweep's out agent,
      // active+upcoming, and not a Redistribute flap whose agent is back. So a pending item
      // for a call already moved off, or a covered Redistribute one, does not keep the
      // all-clear from firing; a dead drain's genuinely-stranded pending item does (correctly,
      // there is unresolved work), and the drain's own lane watchdog pages for the dead drain.
      const retryablePendingIds = new Set(
        selectRetryableUnplaceable({
          items: livePending,
          holderByBooking: new Map(
            [...holderByBooking].map(([id, h]) => [id, { assignedUserId: h.userId, inPool: h.inPool }]),
          ),
          jobById: new Map(
            [...jobById].map(([id, j]) => [
              id,
              { status: j.status, outUserId: j.out_user_id, fromRedistribute: j.redistribute_marked_at != null },
            ]),
          ),
        }).map((r) => r.itemId),
      );
      const inFlight = new Set(
        livePending.filter((p) => retryablePendingIds.has(p.id)).map((p) => p.booking_id),
      ).size;
      if (live.length === 0) return { ...nothing, waiting: inFlight };
      // #3485: for every sweep triggered by approved time off, read that request's
      // absence window in its OWN display zone, so the page can say "on approved time
      // off, Mon Oct 13 ..." without touching the agent's free-text reason. Bounded by
      // the distinct ooo-triggered jobs behind the stranded items, so split like the rest.
      const oooIds = [
        ...new Set(
          jobPages.flat().flatMap((j) => (j.ooo_request_id ? [j.ooo_request_id] : [])),
        ),
      ];
      // BEST-EFFORT, and the degrade is enforced in `loadTimeOffWindows`: this read only
      // ENRICHES the page with the absence window, so a failure returns an empty map
      // rather than throwing out of the loader and taking the whole check to `unreadable`
      // (review finding, 2026-10-11). The load-bearing reads above (items, bookings,
      // jobs, agents) still throw, as they must.
      const oooById = await loadTimeOffWindows(
        oooIds,
        async (ids) =>
          (
            await inIdChunks(
              "monitor stranded coverage time off",
              ids,
              async (batch) =>
                (unwrap(
                  await db
                    .from("ooo_requests")
                    // cap-safe: primary-key lookup, already split to the URL budget.
                    .select("id, starts_at, ends_at, display_tz_id, display_tz_label")
                    .in("id", batch),
                  "monitor stranded coverage time off",
                ) ?? []) as {
                  id: string;
                  starts_at: string;
                  ends_at: string;
                  display_tz_id: string | null;
                  display_tz_label: string | null;
                }[],
            )
          )
            .flat()
            .map((o) => ({
              id: o.id,
              startsAt: o.starts_at,
              endsAt: o.ends_at,
              tzId: o.display_tz_id,
              tzLabel: o.display_tz_label,
            })),
        (err) =>
          log.warn(
            "coverage-needs-human",
            { msg: "time off window read failed; page will omit the window" },
            err instanceof Error ? err : undefined,
          ),
      );
      // #4052: a demoted advisor whose tier came back can take their calls again, so those are
      // not waiting for a person. Read only while a demotion sweep's call is still with its
      // advisor; an unreadable advisor answers nothing and their calls stay counted.
      const askTakenAgain = demotionCallsToAsk(live, holderByBooking, jobById);
      const takenAgain = askTakenAgain.length === 0 ? new Set<string>() : await readCallsTakenAgain(askTakenAgain);
      // #3595: assembled by the helper the agent page's standing list also uses, so the
      // page and the alert hand `countStranded` the same facts.
      const reads: StrandedItemRead[] = strandedItemReads(
        live,
        holderByBooking,
        jobById,
        // #3485: why this agent will not be there, from the job's own columns.
        (job) => decodeSweepCause(job, job.ooo_request_id ? oooById.get(job.ooo_request_id) ?? null : null),
        takenAgain,
      );
      // #3485 part C: page only once a call is within the lead window; before that it is
      // held (waiting), the hourly bulk-reassign-retry lane re-attempts it.
      const counted = countStranded(reads, asOfMs, COVERAGE_PAGE_LEAD_MS);
      // Fold in the in-flight pending items (#3485 part C): a tick that can clear must see
      // no stranded holders AND no coverage work in progress, or a retry mid-flight reads
      // as resolved and clears a real page.
      const found = {
        waiting: counted.waiting + inFlight,
        newestCountableMs: counted.newestCountableMs,
        asOfMs,
        appBaseUrl,
      };
      const stranded = counted.appointments;
      if (stranded.length === 0) return { ...found, holders: [] };
      const agents = (unwrap(
        await db
          .from("users")
          // cap-safe: primary-key lookup of the affected out agents.
          .select("id, name, email")
          // in-chunk-ok: DEDUPED agent ids, so this is bounded by the roster and not
          // by the stranded items it was derived from. At the 200 agent design target
          // that is 7,520 bytes against a 10,000 byte budget and the 14,878 smallest
          // size measured refused, so roughly 266 ids fit.
          .in("id", [...new Set(stranded.map((s) => s.outUserId))]),
        "monitor stranded coverage agents",
      ) ?? []) as CoverageOutAgent[];
      return { ...found, holders: strandedHoldersFromItems(stranded, agents) };
    };
    const strandedCoverage = await steps.run("stranded_coverage", null, () =>
      runCoverageNeedsHumanCheck({
        loadStranded: loadStrandedHolders,
        cooldownMs: cooldownMs.coverage_needs_human,
        log: (fields) => log.info("coverage-needs-human", { msg: "tick", ...fields }),
      }),
    );

    // --- Approved time off that has stopped blocking anything (#1467). The mirror
    // of the availability truth probe: that one asks whether the times Slate
    // OFFERS are really free, this one asks whether the times it promised to
    // protect are really blocked. Both reads go through `unwrap`, because an
    // unread list comes back empty and an empty result here is indistinguishable
    // from "every time off is protected", which would post an all-clear over a
    // window a lead can be booked into. ---
    // ONE read serves two checks (#3360): this one, and whether the calendar still
    // agrees with each approved window. Memoised for the tick, so the second check
    // costs no subrequest on the budget four lanes share; a failed read fails both,
    // which is the right answer for both (neither may page or clear off it).
    type ApprovedTimeOffAgent = {
      id: string;
      name: string | null;
      email: string | null;
      bookable: boolean;
      deactivated_at: string | null;
    };
    type ApprovedTimeOffBlock = {
      user_id: string;
      starts_at: string;
      ends_at: string;
      source: string;
      gcal_event_id: string | null;
      booking_id: string | null;
    };
    let approvedTimeOffRead: ReturnType<typeof readApprovedTimeOff> | null = null;
    const readApprovedTimeOff = async () => {
      const requests = await selectAllPages<{
        id: string;
        user_id: string;
        starts_at: string;
        ends_at: string;
        display_tz_id: string;
        display_tz_label: string | null;
        agent_event_id: string | null;
        side_effects: Record<string, string> | null;
      }>("monitor approved time off", "id", () =>
        db
          .from("ooo_requests")
          .select(
            "id, user_id, starts_at, ends_at, display_tz_id, display_tz_label, agent_event_id, side_effects",
          )
          .eq("status", "approved")
          .gte("ends_at", new Date(now).toISOString()),
      );
      if (requests.length === 0) {
        return {
          requests,
          byId: new Map<string, ApprovedTimeOffAgent>(),
          blocks: [] as ApprovedTimeOffBlock[],
        };
      }
      // DEDUPED agent ids, so every filter below is bounded by the roster rather than
      // by the unbounded request list they came from: at the 200 agent design target
      // that is 7,520 bytes against a 10,000 byte budget and the 14,878 smallest size
      // measured refused, so roughly 266 ids fit (#2388).
      const userIds = [...new Set(requests.map((r) => r.user_id))];
      const agents = (unwrap(
        await db
          .from("users")
          // cap-safe: primary-key lookup of the (few) agents with approved time off.
          .select("id, name, email, bookable, deactivated_at")
          // in-chunk-ok: bounded by the roster, see the note on userIds above.
          .in("id", userIds),
        "monitor approved time off agents",
      ) ?? []) as ApprovedTimeOffAgent[];
      const byId = new Map(agents.map((a) => [a.id, a]));
      // The whole cached window for those agents, from now to the last time off
      // end, so coverage is judged against every row that could contribute to it.
      const lastEnd = requests
        .map((r) => r.ends_at)
        .sort()
        .slice(-1)[0] as string;
      const blocks = await selectAllPages<ApprovedTimeOffBlock>("monitor time off busy blocks", "id", () =>
        db
          .from("busy_blocks")
          .select("id, user_id, starts_at, ends_at, source, gcal_event_id, booking_id")
          // in-chunk-ok: bounded by the roster, see the note on userIds above.
          .in("user_id", userIds)
          .gte("ends_at", new Date(now).toISOString())
          .lte("starts_at", lastEnd),
      );
      return { requests, byId, blocks };
    };
    const approvedTimeOff = () => (approvedTimeOffRead ??= readApprovedTimeOff());
    const loadOooProtection = async () => {
      const { requests, byId, blocks } = await approvedTimeOff();
      return {
        requests: requests.map((r) => ({
          id: r.id,
          userId: r.user_id,
          agentName: byId.get(r.user_id)?.name ?? null,
          agentEmail: byId.get(r.user_id)?.email ?? null,
          startsAt: r.starts_at,
          endsAt: r.ends_at,
          displayTzId: r.display_tz_id,
          displayTzLabel: r.display_tz_label,
          agentEventId: r.agent_event_id,
          busyBlockEffect: r.side_effects?.busy_block ?? null,
          agentEventEffect: r.side_effects?.agent_event ?? null,
        })),
        blocks: blocks.map((b) => ({
          userId: b.user_id,
          startsAt: b.starts_at,
          endsAt: b.ends_at,
        })),
      };
    };
    // The mirror rows are the gcal rows the sync wrote for each request's own event.
    // A mirror lying wholly outside [now, last end] is not read, and is judged as the
    // calendar blocking nothing inside the approved window, which is what it is.
    //
    // #3655: the mirrors answer only up to each calendar's mirrored horizon, because
    // the sync deletes rather than updates the mirror of an event that changes while
    // it starts past its write window. So the primary calendar's `sync_window_to` (the
    // calendar Slate writes the time off event on, whose id is the agent's address)
    // rides along, and the judge treats the part of a window past it as unmeasured.
    // One read, and only on a tick with approved time off ahead; the ooo_protection
    // check above does not need it, so it is not added to the shared read.
    const loadOooEventMismatch = async () => {
      const { requests, byId, blocks } = await approvedTimeOff();
      const userIds = [...byId.keys()];
      // Paged: the roster bounds the AGENTS, but each has a row per selectable
      // calendar, so the row count is not bounded by one page, and a truncated read
      // would drop some agents' primary row and quietly blind the lane for them.
      const calendars =
        userIds.length === 0
          ? []
          : await selectAllPages<{ user_id: string; calendar_id: string; sync_window_to: string | null }>(
              "monitor time off mirrored horizon",
              "id",
              () =>
                db
                  .from("agent_calendars")
                  .select("id, user_id, calendar_id, sync_window_to")
                  // in-chunk-ok: bounded by the roster, the agents with approved time off ahead.
                  .in("user_id", userIds),
            );
      const primaryHorizon = primaryMirroredHorizons(calendars, byId);
      return {
        requests: requests.map((r) => {
          const agent = byId.get(r.user_id);
          return {
            id: r.id,
            userId: r.user_id,
            agentName: agent?.name ?? null,
            agentEmail: agent?.email ?? null,
            startsAt: r.starts_at,
            endsAt: r.ends_at,
            displayTzId: r.display_tz_id,
            displayTzLabel: r.display_tz_label,
            agentEventId: r.agent_event_id,
            inPool: agent !== undefined && agent.bookable && agent.deactivated_at === null,
            departed: agent !== undefined && agent.deactivated_at !== null,
            // No primary row is "nothing mirrored ahead", never the default window.
            mirroredUntil: primaryHorizon.get(r.user_id) ?? null,
          };
        }),
        mirrors: blocks
          .filter((b) => b.source === "gcal" && b.gcal_event_id !== null)
          .map((b) => ({
            userId: b.user_id,
            gcalEventId: b.gcal_event_id as string,
            startsAt: b.starts_at,
            endsAt: b.ends_at,
          })),
        // The calls a Slate booking wrote through, which speed the escalation up when
        // one falls in the open hours (#3372). Same read, no subrequest of its own.
        calls: blocks
          .filter((b) => b.source === "slate" && b.booking_id !== null)
          .map((b) => ({ userId: b.user_id, startsAt: b.starts_at, endsAt: b.ends_at })),
      };
    };
    const oooProtection = await steps.run(
      "ooo_protection",
      {
        status: "unreadable",
        scanned: 0,
        unprotected: 0,
        notHandled: 0,
        reachedVerdict: false,
      } as const,
      () =>
        runOooProtectionCheck({
          load: loadOooProtection,
          nowMs: now,
          appBaseUrl: appUrl(),
          cooldownMs: cooldownMs.ooo_protection_lost,
          log: (fields) => log.info("ooo-protection", { msg: "tick", ...fields }),
        }),
    );

    // --- An approved time off whose calendar event no longer covers it (#3360).
    // Slate holds the approved window whatever the event says, so this is a record
    // and a calendar disagreeing rather than hours left open; it asks a person to
    // make them agree. The sync tells the agent about a shortened event at once; this
    // finds what the sync cannot see (a deleted event) after two ticks, climbs the
    // ladder (agent, then manager, then the alerts channel, #3372), and is the only
    // place an all-clear is decided. Shares the read above, so it costs one subrequest of
    // its own (the calendars' mirrored horizon, #3655) on a tick with approved time
    // off ahead, plus one when a page has to end for an agent no longer in the
    // approved set. ---
    await steps.run("ooo_event_mismatch", null, () =>
      runOooEventMismatchCheck({
        load: loadOooEventMismatch,
        loadAgentNames: async (ids) => {
          const rows = (unwrap(
            await db
              .from("users")
              // cap-safe: primary-key lookup of the few agents whose page is ending.
              .select("id, name, email")
              // in-chunk-ok: bounded by the roster, these are agents with an open page.
              .in("id", ids),
            "monitor time off mismatch names",
          ) ?? []) as { id: string; name: string | null; email: string | null }[];
          return new Map(rows.map((u) => [u.id, u.name?.trim() || u.email || u.id]));
        },
        nowMs: now,
        appBaseUrl: appUrl(),
        log: (fields) => log.info("ooo-event-mismatch", { msg: "tick", ...fields }),
        notices: alertStateNoticeStore(),
        messenger: slackMismatchMessenger(),
        loadPeople: async (ids) => {
          const rows = (unwrap(
            await db
              .from("users")
              // cap-safe: primary-key lookup of agents with a mismatch and their managers.
              .select("id, name, email, role, deactivated_at, manager_id")
              // in-chunk-ok: bounded by the roster, agents told about a mismatch and their managers.
              .in("id", ids),
            "monitor time off mismatch people",
          ) ?? []) as {
            id: string;
            name: string | null;
            email: string | null;
            role: Role;
            deactivated_at: string | null;
            manager_id: string | null;
          }[];
          return new Map(
            rows.map((u) => [
              u.id,
              { id: u.id, name: u.name, email: u.email, role: u.role, deactivatedAt: u.deactivated_at, managerId: u.manager_id },
            ]),
          );
        },
        loadRequests: async (ids) => {
          const rows = (unwrap(
            await db
              .from("ooo_requests")
              .select("id, status, starts_at, ends_at, display_tz_id, display_tz_label")
              // in-chunk-ok: bounded by the told records, one per request somebody was told about.
              .in("id", ids),
            "monitor time off mismatch requests",
          ) ?? []) as {
            id: string;
            status: OooStatus;
            starts_at: string;
            ends_at: string;
            display_tz_id: string;
            display_tz_label: string | null;
          }[];
          return new Map(
            rows.map((r) => [
              r.id,
              { status: r.status, startsAt: r.starts_at, endsAt: r.ends_at, displayTzId: r.display_tz_id, displayTzLabel: r.display_tz_label },
            ]),
          );
        },
      }),
    );

    // --- An approved absence still holding an appointment NO sweep ever saw (#1238).
    // The third member of the coverage family, and the boundary between them is what
    // keeps them from disagreeing: #1215 measures agents out of the POOL, #1242
    // measures the sweep's own recorded give-ups, and this measures the appointments
    // with no `bulk_reassign_items` row at all. That is the set nothing else can see:
    // an approval whose sweep never ran, a retroactive approval, a booking made into
    // an already-approved window, and the straddler that begins before the window.
    //
    // Cost: ONE read on an ordinary tick. Approved absences overlapping the next few
    // days are rare, and every read after the first is skipped when there are none,
    // which matters because this lane shares its invocation with three others. When
    // there ARE absences it is four bounded reads regardless of how many, because
    // each is one batched `in()` rather than a query per agent.
    //
    // Every read goes through `unwrap` / `selectAllPages`, because a read that failed
    // comes back empty and an empty result here is indistinguishable from "every
    // absence is covered", which would post an all-clear over a real gap. ---
    const loadOooCoverageGaps = async () => {
      const nowIso = new Date(now).toISOString();
      // Approved and not cancelled, still running: an absence whose end has passed can
      // no longer strand anybody.
      const absences = await selectAllPages<{
        id: string;
        user_id: string;
        starts_at: string;
        ends_at: string;
      }>("monitor ooo coverage absences", "id", () =>
        db
          .from("ooo_requests")
          .select("id, user_id, starts_at, ends_at")
          .eq("status", "approved")
          .is("cancelled_at", null)
          .gte("ends_at", nowIso),
      );
      if (absences.length === 0) return [];
      // DEDUPED agent ids, so every filter below is bounded by the roster rather than
      // by the unbounded absence list they came from: at the 200 agent design target
      // that is 7,520 bytes against a 10,000 byte budget and the 14,878 smallest size
      // measured refused, so roughly 266 ids fit (#2388).
      const userIds = [...new Set(absences.map((r) => r.user_id))];
      // Lifted into its own module by #2369, because it filtered `bookings` on an
      // `is_test` column that table does not have, so this check had never run and
      // nothing inline in a handler this size could be tested.
      const bookings = await loadOooCoverageBookings(db, userIds, nowIso);
      if (bookings.length === 0) return [];
      // Which of those already have a sweep row. Lifted out beside the read above by
      // #2388: it put every booking id into ONE `in` filter, which PostgREST refuses
      // past roughly 266 uuids, so the whole check threw on every tick at the count
      // this roster already reaches.
      const hasRow = await loadSnapshottedBookingIds(db, bookings.map((b) => b.id));
      // An ACTIVE job is the pending-count signal: the engine flips a job to done only
      // once nothing is pending, so while one is active that agent's sweep is working.
      // Paginated rather than annotated cap-safe: a truncated page would drop an
      // agent whose sweep IS working, and this read's only job is to keep the check
      // quiet about them. Getting that wrong pages about a healthy sweep, which is
      // precisely the false alarm the suppression exists to prevent.
      const activeJobs = await selectAllPages<{ out_user_id: string }>(
        "monitor ooo coverage active jobs",
        "id",
        () =>
          db
            .from("bulk_reassign_jobs")
            .select("id, out_user_id")
            .eq("status", "active")
            // in-chunk-ok: bounded by the roster, see the note on userIds above.
            .in("out_user_id", userIds),
      );
      const agents = (unwrap(
        await db
          .from("users")
          // cap-safe: primary-key lookup of the (few) agents with approved time off.
          .select("id, name, email")
          // in-chunk-ok: bounded by the roster, see the note on userIds above.
          .in("id", userIds),
        "monitor ooo coverage agents",
      ) ?? []) as CoverageGapAgent[];
      return oooCoverageHolders({
        absences: absences.map((r) => ({
          requestId: r.id,
          userId: r.user_id,
          startIso: r.starts_at,
          endIso: r.ends_at,
        })),
        bookings: bookings.map((b) => ({
          bookingId: b.id,
          assignedUserId: b.assigned_user_id,
          startsAtIso: b.starts_at,
          endsAtIso: b.ends_at,
          snapshotted: hasRow.has(b.id),
        })),
        agents,
        sweepingUserIds: activeJobs.map((j) => j.out_user_id),
        nowIso,
      });
    };
    const oooCoverageGap = await steps.run("ooo_coverage_gap", null, () =>
      runOooCoverageGapCheck({
        loadHolders: loadOooCoverageGaps,
        cooldownMs: cooldownMs.ooo_coverage_gap,
        log: (fields) => log.info("ooo-coverage-gap", { msg: "tick", ...fields }),
      }),
    );

    // --- Is every bookable agent's calendar hydrated past the booking window
    // (#1262)? Availability is served from the busy cache, so a calendar whose
    // hydrated window has fallen behind the horizon is one whose far days the
    // booker offers blind. The lane watchdog covers the rotation dying outright;
    // this covers one calendar quietly starving while the rotation stays green.
    // Includes the smoke test agents deliberately: they are the only bookable
    // agents before cutover, and a check with no subjects is a detector that has
    // never once concluded (#1394). ---
    const loadCalendarWindowRows = async (): Promise<CalendarWindowRow[]> => {
      // test-data-ok: the smoke agents are deliberately IN this check's subject
      // pool. Their calendars are hydrated by the same rotation, the canary books
      // against them, and before cutover they are the only bookable agents, so
      // excluding them would leave the detector with no subjects at all (#1394).
      const { data: pool, error: poolErr } = await db
        // test-data-ok: the smoke agents belong in this subject pool: the same
        // rotation hydrates their calendars, the canary books against them, and
        // before cutover they are the only bookable agents, so excluding them
        // would leave the detector with no subjects at all (#1394).
        // any-advisor-ok: the smoke agents belong, as above, and `bookable` already keeps
        // the placeholder out (a CHECK makes it never bookable, #4200).
        .from("users")
        .select("id, name, email")
        .eq("bookable", true)
        .is("deactivated_at", null);
      if (poolErr) throw new Error(`calendar window pool read failed: ${poolErr.message}`);
      const users = (pool ?? []) as { id: string; name: string | null; email: string | null }[];
      if (users.length === 0) return [];
      // The whole table rather than an `in` filter: agent_calendars is roster
      // bounded (SAFE_TABLES), and a roster-sized id list rides in the URL, which
      // PostgREST refuses outright past a few hundred ids (#1267's lesson).
      // #2300: created_at and the failure columns ride along, because a calendar
      // inside its first hydration cadence has not yet been given a chance, and a
      // recorded failure is what ends that patience.
      const { data: cals, error: calErr } = await db
        .from("agent_calendars")
        .select(CALENDAR_WINDOW_COLUMNS);
      if (calErr) throw new Error(`calendar window read failed: ${calErr.message}`);
      const byId = new Map(users.map((u) => [u.id, u]));
      return ((cals ?? []) as CalendarWindowSourceRow[])
        .filter((c) => byId.has(c.user_id))
        .map((c) => calendarWindowRow(c, byId.get(c.user_id)));
    };
    const calendarWindow = await steps.run<CalendarWindowResult | null>(
      "calendar_window",
      null,
      async (step) => {
        if (!gates.calendarWindow.run) {
          log.warn("monitor", { msg: "calendar window check skipped", why: gates.calendarWindow.why });
          return step.unmeasured(null);
        }
        return runCalendarWindowCheck({
          loadRows: loadCalendarWindowRows,
          horizonDays: horizonDays as number,
          nowIso: new Date(now).toISOString(),
          cooldownMs: cooldownMs.calendar_window_uncovered,
          logTick: (fields) => log.info("calendar-window", { msg: "tick", ...fields }),
        });
      },
    );

    // --- Is the database itself memory pressured (#3588)? Read its committed memory and
    // swap straight from Supabase's privileged metrics endpoint, so this class pages
    // early rather than surfacing as the availability latency a lead already felt. The
    // metrics fetch is an external HTTP call, so it lives inside this step's own boundary:
    // a throw here cannot take out the checks around it. It reads with the Supabase secret
    // key the server already holds, so there is no inert "not configured" state: a read
    // that fails or a body that cannot be parsed (a wrong key's 4xx, a renamed metric) is a
    // configured blind spot that THROWS, which a sustained one pages through
    // monitor_step_failing:db_saturation rather than reading healthy. No shared setup read,
    // so no setup gate. ---
    const dbSaturation = await steps.run<DbSaturationResult | null>("db_saturation", null, async () =>
      runDbSaturationCheck({
        loadMetrics: fetchDbSaturationMetrics,
        cooldownMs: {
          page: cooldownMs.db_saturation,
          warn: cooldownMs.db_saturation_warn,
        },
        logTick: (fields) => log.info("db-saturation", { msg: "tick", ...fields }),
      }),
    );

    // --- Does the cached busy index agree with Google (#1262)? A rotating sample's
    // cached blocks are compared against a live freeBusy for the same window, and
    // every difference is LOGGED (tag=busy-drift). Since #1591 a difference that
    // persists past one revisit of the agent PAGES, report only: nothing here
    // writes busy time. The union includes slate-source blocks,
    // because freeBusy merges anonymously and Slate deliberately never mirrors
    // its own bookings as gcal events (#166/#586): a google-only union would
    // flag every Slate booking as a gap.
    // Cost: one freeBusy call per 20 sampled calendars per tick, on the same
    // budget the truth probe already draws from. ---
    // Ticks for the rotation to visit every agent, set by the sampler step from the
    // roster it read; the report step needs it to know how often an agent recurs.
    let busyDriftRotationTicks = 1;
    const busyDrift = await steps.run<BusyDriftResult | null>("busy_drift", null, async (step) => {
      if (!gates.busyDrift.run) {
        log.warn("monitor", { msg: "busy drift sampler skipped", why: gates.busyDrift.why });
        return step.unmeasured(null);
      }
      const { data: pool, error: poolErr } = await db
        // test-data-ok: the smoke agents are the only bookable agents before
        // cutover; without them the sampler ships blind (#1394), and their cache
        // is maintained by the same lanes as everyone else's.
        // any-advisor-ok: the smoke agents belong, as above, and `bookable` already keeps
        // the placeholder out (a CHECK makes it never bookable, #4200).
        .from("users")
        .select("id, email")
        .eq("bookable", true)
        .is("deactivated_at", null)
        .order("id");
      if (poolErr) throw new Error(`busy drift pool read failed: ${poolErr.message}`);
      const agents = ((pool ?? []) as { id: string; email: string }[]).map((u) => ({
        userId: u.id,
        email: u.email,
      }));
      // Stateless rotation: the 5-minute tick index walks the roster in batches
      // sized under freeBusy's 20-calendar cap, so a 120-agent roster is fully
      // sampled roughly every 35 minutes with no stored cursor.
      busyDriftRotationTicks = Math.max(1, Math.ceil(agents.length / BUSY_DRIFT_BATCH));
      const sample = sampleForTick(agents, Math.floor(now / (5 * 60_000)), BUSY_DRIFT_BATCH);
      const fromIso = new Date(now).toISOString();
      const toIso = new Date(now + (horizonDays as number) * 24 * 60 * 60_000).toISOString();
      return runBusyDriftSample({
        sample,
        fromIso,
        toIso,
        readLive: readAgentBusyRange,
        loadCachedBlocks: async (userIds, from, to) => {
          const rows = await selectAllPages<{
            user_id: string;
            starts_at: string;
            ends_at: string;
          }>("busy drift cached blocks", "id", () =>
            db
              .from("busy_blocks")
              .select("id, user_id, starts_at, ends_at")
              .in("user_id", userIds)
              .lt("starts_at", to)
              .gt("ends_at", from),
          );
          const byUser = new Map<string, DriftInterval[]>();
          for (const r of rows) {
            const list = byUser.get(r.user_id) ?? [];
            list.push({ startIso: r.starts_at, endIso: r.ends_at });
            byUser.set(r.user_id, list);
          }
          return byUser;
        },
        logTick: (fields) => log.info("busy-drift", { msg: "tick", ...fields }),
      });
    });
    // #1591: armed REPORT ONLY (Dan, 2026-10-02). Pages on drift that persisted
    // past one revisit of the agent; never writes busy time, so the sync stays the
    // cache's one writer. Its own step, so a failed streak write or post cannot
    // take the sample's result (and its verdict stamp) down with it. Cost: one
    // streak RPC per drifting agent (at most two per tick in the calibration week)
    // or one for the clean run, plus a resolve once per full rotation.
    const busyDriftReport = await steps.run("busy_drift_report", null, (step) =>
      reportBusyDrift({
        result: busyDrift,
        rotationTicks: busyDriftRotationTicks,
        tickMs: 5 * 60_000,
        cooldownMs: cooldownMs.busy_cache_drift,
        hit: recordConsecutiveStreak,
        clearStreak: clearFailureStreak,
        // alert-key: busy_cache_drift
        notify: sendThrottledAlert,
        // alert-key: busy_cache_drift
        // all-clear-proof: src/lib/monitor/busy-drift-sampler.test.ts - a skipped,
        // unreadable or empty tick never resolves, nor a clean tick that could not
        // read every sampled agent.
        resolve: resolveAlert,
      }).then((report) => (report.verdict === "unmeasured" ? step.unmeasured(report) : report)),
    );
    log.info("busy-drift", {
      msg: "report",
      verdict: busyDriftReport?.verdict ?? null,
      sustained: busyDriftReport?.sustained.length ?? null,
    });

    // Schema behind the deployed code (#516). Deploys do not apply migrations, so
    // code can go live expecting a column, table, or function the database lacks;
    // the failure is usually silent (0055 left the dead-man's switch dormant for a
    // whole session). CI guards merge time, this guards PROD. Cheap: one RPC.
    // A read that fails pages as "unverified" rather than passing as healthy.
    const migrationStatus = await steps.run("migration_drift", "unknown" as const, () =>
      runMigrationDriftCheck({
        shippedVersion: SHIPPED_MIGRATION_VERSION,
        readAppliedVersions: readAppliedMigrationVersions,
        // alert-key: migration_version_lag
        notify: sendThrottledAlert,
        // #1134: say so when the schema catches up. This page is cleared by a human
        // running a migration, so silence afterwards is ambiguous: it looks the same
        // as the cooldown still running.
        // alert-key: migration_version_lag
        // all-clear-proof: scripts/test-migration-drift.ts - an unreadable applied
        // set is classified unverified and never announces recovery.
        resolve: resolveAlert,
        cooldownMs: cooldownMs.migration_version_lag,
        log: (msg, status, applied) =>
          log.info("migration-drift", {
            msg,
            status,
            shipped: SHIPPED_MIGRATION_VERSION,
            // A full set of ~70+ versions per tick is log noise; the count is enough
            // for forensics and the alert itself names any missing versions.
            appliedCount: applied?.length ?? null,
          }),
      }),
    );

    // A webhook event with no subscriber (#1459). `emitWebhook` delivers only to
    // endpoints whose stored `events` array contains the event, so a value added to
    // the WebhookEvent union ships INERT: the delivery row is written, nobody is
    // sent anything, and it looks exactly like a delivered event. The subscription
    // lives in a database column that no code change touches.
    //
    // It sits beside migration_drift because it is the same kind of thing: code
    // shipped ahead of the database state it needs. The build guard
    // (scripts/test-webhook-event-subscribers.ts) covers the migration DEFAULT,
    // which is what a NEW endpoint gets; only this can see that the endpoint which
    // already exists was never updated, and the one live Regal endpoint predates
    // every event added from here on.
    //
    // One read of a roster-bounded table (a single row today). An unreadable read
    // reports measured:false, which neither pages nor clears.
    const webhookSubscribers = await steps.run("webhook_subscribers", null, () =>
      runWebhookSubscriberCheck({
        events: WEBHOOK_EVENTS,
        loadEndpoints: async () => {
          // cap-safe: webhook_endpoints is roster-bounded config (one row in prod),
          // so it can never fill a PostgREST page.
          const { data, error } = await db
            .from("webhook_endpoints")
            .select("url, events")
            .eq("active", true);
          // Null, never [], on a read error: an empty list would say every event
          // reaches nobody and page falsely, while "no findings" would say
          // everything is subscribed and go blind. Both are wrong; unmeasured is
          // the honest third answer.
          if (error) {
            log.warn("webhook-subscribers", { msg: "endpoints read failed" }, error);
            return null;
          }
          return (data ?? []) as { url: string; events: string[] }[];
        },
        unsubscribedReason: deliberatelyUnsubscribedReason,
        // alert-key: webhook_event_no_subscriber
        // alert-text-ok: our own copy from webhook-subscriber-coverage.ts, never a raw error.
        notify: sendThrottledAlert,
        // A condition, not an incident: it stays true until somebody updates the
        // subscription, so it has to be able to end.
        // alert-key: webhook_event_no_subscriber
        // all-clear-proof: scripts/test-webhook-subscriber-coverage.ts - an
        // unreadable or throwing endpoint read clears nothing, because it measured
        // nothing.
        resolve: resolveAlert,
        cooldownMs: cooldownMs.webhook_event_no_subscriber,
        log: (msg) => log.info("webhook-subscribers", { msg }),
      }),
    );

    // Booking handoffs: a booking waiting on a person in sales (#2367). Delivers each
    // open handoff to the handoff channel, resolves the ones whose booking has since
    // settled, and pages the alerts channel when handoffs are not getting through.
    //
    // Its cost on the invocation this lane shares: one bounded read of the open rows,
    // one primary key read of their bookings, one config read, at most one resolve
    // write per reason, and at most HANDOFF_POSTS_PER_TICK Slack posts each with its
    // stamp write. The counts are in the step's own tick line (tag=booking-handoffs),
    // beside this step's time in the cycle line.
    const handoffs = await steps.run("booking_handoffs", null, () =>
      runHandoffCheck({
        nowMs: now,
        loadOpen: (limit) => loadOpenHandoffs(db, limit),
        loadBookings: (ids) => loadHandoffBookings(db, ids),
        loadChannel: () => loadHandoffChannel(db),
        resolve: (ids, reason, atIso) => resolveHandoffs(db, ids, reason, atIso),
        // postSlack never throws and answers not-ok for an unconfigured bot, a refused
        // channel or a timeout, each of which the check records on the row.
        post: (channel, text) => postSlack({ channel, text }),
        markNotified: (id, atIso) => markHandoffNotified(db, id, atIso),
        recordNotifyFailure: (id, attempts, reason) => recordHandoffNotifyFailure(db, id, attempts, reason),
        bookingUrl: (bookingId) => `${appUrl()}${bookingDetailHref(bookingId)}`,
        settingsUrl: `${appUrl()}/admin/alerts`,
        // alert-key: handoff_channel_unset
        // alert-key: handoff_undelivered
        // alert-text-ok: our own copy from src/lib/handoffs/copy.ts, which shortens any stored error.
        notify: sendThrottledAlert,
        // Both are conditions: each stays true until a channel is set or the posts land.
        // alert-key: handoff_channel_unset
        // alert-key: handoff_undelivered
        // all-clear-proof: scripts/test-booking-handoffs.ts - an unreadable open handoff
        // read clears nothing, an unreadable channel setting neither pages nor clears the
        // unset page, and a truncated read never clears the undelivered page.
        clearAlert: resolveAlert,
        cooldownMs: {
          channelUnset: cooldownMs.handoff_channel_unset,
          undelivered: cooldownMs.handoff_undelivered,
        },
        log: (fields) => log.info("booking-handoffs", fields),
        warn: (fields) => log.warn("booking-handoffs", fields),
      }),
    );

    // Owner reassign notices that never reached the sales side (#2440). The notice
    // step records `withheld` on itself when no handoff channel is set; this counts
    // the last week of those and whispers the number once a week on the info channel.
    // Info, never a page and never an all clear: the reassigns happened, and a handoff
    // somebody must act on already pages while the channel is unset (#2367). One
    // server side count on the shared invocation. A failed count throws, so this
    // boundary records it and sends nothing.
    await steps.run("owner_notice_withheld", null, () =>
      runOwnerNoticeWithheldReport({
        nowMs: now,
        countWithheld: (sinceIso) => countWithheldOwnerNotices(db, sinceIso),
        // alert-key: owner_notice_withheld
        // alert-text-ok: our own copy from owner-notice-withheld-report.ts, built from a
        // measured count; no error text can reach it.
        notify: (key, ms, text, repeat) => sendThrottledInfo(key, ms, text, repeat),
        settingsUrl: `${appUrl()}/admin/alerts`,
      }).then((result) => {
        log.info("monitor", { msg: "owner notices withheld", status: result.status, count: result.count });
        return result;
      }),
    );

    // Owner alerts skipped for an unreachable calendar (#2436). Each skip is right on
    // its own row (the step records the reason and stops retrying), and one advisor
    // without Calendar is normal; what nothing saw was MANY advisors skipping. This
    // judges the share of the last week's owner alerts carrying a skip_reason, across
    // at least three advisors, and pages on it. One bounded read on the shared
    // invocation. A failed read throws, so this boundary records it and nothing is
    // paged or cleared.
    // all-clear-proof: scripts/test-owner-alert-skips.ts - pins that a failed read, a
    // read that filled its bound and a week below the alert floor each send NOTHING in
    // either direction, and that the all clear hangs only off a measured week.
    await steps.run("owner_alert_skips", null, () =>
      runOwnerAlertSkipsCheck({
        nowMs: now,
        loadRecent: (sinceIso, limit) => loadRecentOwnerAlerts(db, sinceIso, limit),
        thresholds: OWNER_ALERT_SKIP_THRESHOLDS,
        cooldownMs: cooldownMs.owner_alert_skips,
        notify: (key, ms, text) => {
          // alert-key: owner_alert_skips
          // alert-text-ok: our own copy from owner-alert-skips.ts, built from measured
          // counts and the two skip kinds; no error text can reach it.
          return sendThrottledAlert(key, ms, text);
        },
        // alert-key: owner_alert_skips
        resolve: (key, text) => resolveAlert(key, text),
      }).then((result) => {
        log.info("monitor", {
          msg: "owner alert skips",
          status: result.status,
          ...("verdict" in result
            ? { alerts: result.verdict.alerts, skipped: result.verdict.skipped }
            : "read" in result
              ? { read: result.read }
              : { alerts: result.alerts, skipped: result.skipped }),
        });
        return result;
      }),
    );

    // Are the request rate limits actually usable in the running deployment? (#1529)
    //
    // The hot path already reports a fail-open per request, but it can only ever speak
    // when something failed, and its silence is produced by a cooldown, a deliberately
    // swallowed alert, and an absence of traffic all at once. So a recovered limiter and a
    // permanently broken one read identically, which is what #1525 cost an afternoon to
    // establish by hand. This measures the same predicate from inside the deployed Worker
    // and owns the CONDITION, so the state can end.
    //
    // Costs no DB read and no subrequest: resolving the bindings is a property read off the
    // request env, and the one real call goes to the in-datacenter limiter rather than over
    // the network. It matters because every lane on this cron's schedule shares ONE invocation
    // budget, the same property that made the every-minute lanes' cost worth watching (#1246).
    // Which schedule that is lives in `worker/cron-routes.ts` and is deliberately not restated
    // here: a cadence written into a comment is a number that drifts the next time it moves.
    const edgeLimiters = await steps.run("edge_limiters", null, () =>
      runEdgeLimiterCheck({
        expected: EDGE_LIMITER_BINDINGS,
        read: async () => {
          const onWorkersRuntime = isWorkersRuntime();
          const runtime = workersRuntimeMarker();
          // Off the platform there are no bindings to look for, and saying so is the
          // difference between this lane skipping and it clearing a live page.
          if (!onWorkersRuntime) {
            return {
              onWorkersRuntime,
              runtime,
              presentBindings: null,
              serviceAnswered: null,
              burstNamespacePresent: null,
            };
          }
          let env: Record<string, unknown> | null = null;
          try {
            env = getCloudflareContext().env as unknown as Record<string, unknown>;
          } catch {
            // ON the platform, inside a request handler: an unreadable context is the
            // fault itself, not a failure to measure. presentBindings stays null and the
            // verdict reports it as its own cause. The burst binding stays null rather than
            // false: nothing looked for it, and "we could not look" is a different finding
            // from "it is not there", with a different remedy (#1558).
            return {
              onWorkersRuntime,
              runtime,
              presentBindings: null,
              serviceAnswered: null,
              burstNamespacePresent: null,
            };
          }
          const presentBindings = EDGE_LIMITER_BINDINGS.filter((name) => Boolean(env?.[name]));
          // Presence is free, but only a real call proves the SERVICE answers, so exactly
          // one binding is called: the public availability lookup, the one endpoint anybody
          // on the internet can reach. A refusal counts as answering, because a limiter
          // that turns a call away is a limiter that works. The key is the monitor's own,
          // so it can never spend a real visitor's budget, and one call a minute is far
          // inside a 30-per-minute window.
          const probe = env?.["AVAIL_RATE_LIMITER"] as
            | { limit?: (opts: { key: string }) => Promise<{ success: boolean }> }
            | undefined;
          const serviceAnswered = probe?.limit
            ? await probe
                .limit({ key: "slate-monitor-edge-limiter-probe" })
                .then(() => true)
                .catch(() => false)
            : null;
          // #1558: the burst ceiling behind every limiter above is a Durable Object binding
          // rather than a rate-limit binding, so it was outside the walk and could vanish
          // from a deploy with nothing to say so. A PRESENCE read only: resolving the
          // namespace is a property lookup that creates no object and spends no subrequest,
          // whereas asking the object whether it answers would create it and give it an
          // alarm to clean up, on every tick forever, out of the invocation this lane
          // shares with the others on its schedule. So this reports that the counter is
          // BOUND, and the copy is careful not to claim it answers.
          const burstNamespacePresent = Boolean(env?.[BURST_LIMITER_BINDING]);
          return {
            onWorkersRuntime,
            runtime,
            presentBindings,
            serviceAnswered,
            burstNamespacePresent,
          };
        },
        // alert-key: edge_limiter_unusable
        // alert-text-ok: our own copy from edge-limiter-health.ts, never a raw error.
        notify: sendThrottledAlert,
        // A condition: it stays true until a deploy puts the ceilings back, so it has to be
        // able to end. This is the all-clear #1529 asked for.
        // alert-key: edge_limiter_unusable
        // all-clear-proof: scripts/test-edge-limiter-health.ts - an unmeasured tick (off
        // the Workers runtime, or a read that threw) clears nothing, because it measured
        // nothing.
        resolve: resolveAlert,
        cooldownMs: cooldownMs.edge_limiter_unusable,
        log: (msg) => log.info("edge-limiter", { msg }),
      }),
    );

    // Can the cron lanes claim their ticks? (#4222 follow up) A lane whose claim cannot be
    // read runs anyway (Dan, 2026-10-26), and the ONE alert about it is raised here, from
    // this lane's own claim at the top of the handler: one judge per five minutes under
    // the lease, never 28 lanes each paging. No read of its own: the claim was the read.
    await steps.run("lane_claim_health", null, () =>
      runLaneClaimHealthCheck({
        claim: ownClaim.claim,
        // alert-key: lane_claim_unreadable
        // alert-text-ok: our own copy from lane-claim-health.ts, never a raw error.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // A condition: it ends on a claim this lane actually wrote.
        // alert-key: lane_claim_unreadable
        // all-clear-proof: scripts/test-lane-claim-health.ts (a hand run, a duplicate and
        // no claim each report unmeasured and clear nothing)
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: cooldownMs.lane_claim_unreadable,
        log: (msg) => log.info("monitor", { msg: `lane claim health: ${msg}` }),
      }),
    );

    // Which privileged database functions can the web roles execute? (#2447)
    //
    // `scripts/test-migration-grants.ts` answers this from the REPOSITORY, which leaves it
    // blind to a grant made by hand against the live database and to a definer function
    // defined in no migration at all. Production holds one of the second kind already. Only
    // a connection can see either, so the read lives here and the judging lives in a pure
    // module beside it.
    //
    // One RPC per tick, on a lane whose invocation budget is shared with every other lane on
    // its schedule (#1246). It is a catalogue read with no table scan behind it, and the
    // alternative (learning about a grant when somebody exploits it) has no budget at all.
    const definerGrants = await steps.run("definer_grants", null, () =>
      runDefinerGrantsCheck({
        read: async () => {
          // unwrap, not a swallowed read: an empty answer here is indistinguishable from a
          // healthy database, so the throw is what keeps this from clearing a live page on a
          // query that never ran (#277, #1134).
          const rows = unwrap(await supabaseAdmin().rpc("definer_function_web_grants", {}), "definer function web grants");
          if (!Array.isArray(rows)) return null;
          return (rows as Record<string, unknown>[]).map(
            (r): DefinerFunctionRow => ({
              name: String(r.name ?? ""),
              args: String(r.args ?? ""),
              returns: String(r.returns ?? ""),
              anonExecute: r.anon_execute === true,
              authenticatedExecute: r.authenticated_execute === true,
            }),
          );
        },
        // alert-key: definer_grants_to_web_roles
        // alert-text-ok: our own copy from definer-grants.ts, never a raw error.
        notify: sendThrottledAlert,
        // A condition: it stays true until somebody revokes the grant, so it has to be able
        // to end.
        // alert-key: definer_grants_to_web_roles
        // all-clear-proof: scripts/test-definer-grants.ts - a read that failed, and a read
        // that came back empty, both report unmeasured and clear nothing.
        resolve: resolveAlert,
        cooldownMs: cooldownMs.definer_grants_to_web_roles,
        log: (msg) => log.info("definer-grants", { msg }),
      }),
    );

    // Is Supabase Auth open beyond Google in production (#3082)? The Email provider and
    // any other provider that can create an account are dashboard settings no deploy
    // touches, and supabase/config.toml describes only the local stack, so the hosted
    // project's own settings endpoint is the only witness. It answers with the public key.
    //
    // One subrequest per tick on the invocation this lane shares (#1246), a GET with no
    // database behind it. A failed or unreadable read is unmeasured and clears nothing.
    const authSignIn = await steps.run("auth_sign_in_surface", null, () =>
      runAuthSignInSurfaceCheck({
        // Bounded by AUTH_SETTINGS_TIMEOUT_MS: a stall is unmeasured, never a hung lane.
        read: () =>
          readAuthSettings({
            url: publicSupabaseUrl(),
            key: publicSupabasePublishableKey(),
            // The error itself goes through, so the log line carries the real cause.
            log: (msg, fields, err) => log.warn("auth-sign-in", { msg, ...fields }, err),
          }),
        // alert-key: auth_sign_in_beyond_google
        // alert-text-ok: our own copy from auth-sign-in-surface.ts, never a raw error.
        notify: sendThrottledAlert,
        // A condition: it stays true until somebody turns the provider off in the
        // dashboard, so it has to be able to end.
        // alert-key: auth_sign_in_beyond_google
        // all-clear-proof: scripts/test-auth-sign-in-surface.ts - a read that threw, or
        // answered nothing readable, is unmeasured and clears nothing.
        resolve: resolveAlert,
        cooldownMs: cooldownMs.auth_sign_in_beyond_google,
        log: (msg) => log.info("auth-sign-in", { msg }),
      }),
    );
    // Has the audit log been changed after it was written? (#3090)
    //
    // Migration 0160 chains every audit_log row to the one before it by hash. This walks
    // that chain a page at a time from the first row to the last, then from the first
    // again, so an edit made a month ago is found as surely as one made today. The hash
    // is recomputed HERE rather than by a database function, because a role able to
    // switch off the append only trigger could replace a verifying function too.
    //
    // Three subrequests a tick on the budget four cron lanes share: the position, one
    // page of rows (`details::text`, because the hash is over Postgres's own rendering of
    // the jsonb), and the position written back. A broken tick skips the write.
    const auditChain = await steps.run("audit_chain", null, () =>
      runAuditChainCheck({
        loadPosition: async () => {
          const row = unwrap(
            await db
              .from("audit_log_chain_verify")
              .select("pass_seq, pass_hash, anchor_seq, anchor_hash")
              .maybeSingle(),
            "audit chain position",
          );
          return row
            ? {
                passSeq: Number(row.pass_seq),
                passHash: String(row.pass_hash),
                anchorSeq: Number(row.anchor_seq),
                anchorHash: String(row.anchor_hash),
              }
            : null;
        },
        loadRows: async (afterSeq, limit) =>
          unwrap(
            await db
              .from("audit_log")
              .select("id, org_id, actor_id, action, target_id, details::text, created_at, chain_seq, chain_hash")
              .gt("chain_seq", afterSeq)
              .order("chain_seq", { ascending: true })
              .limit(limit),
            "audit chain rows",
          ) as unknown as AuditChainRow[],
        savePosition: async (p) => {
          const at = new Date(now).toISOString();
          unwrap(
            await db.from("audit_log_chain_verify").upsert({
              singleton: true,
              pass_seq: p.passSeq,
              pass_hash: p.passHash,
              anchor_seq: p.anchorSeq,
              anchor_hash: p.anchorHash,
              // A walk always restarts from 0 when it completes, and a walk part way
              // through is always past 0, so 0 here means a complete walk just ended.
              ...(p.passSeq === 0 ? { last_full_pass_at: at } : {}),
              updated_at: at,
            }),
            "audit chain position write",
          );
        },
        // alert-key: audit_log_chain_broken
        // alert-text-ok: our own copy from audit-chain.ts, never a raw error.
        notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
        // A condition: it ends on a complete walk that finds nothing wrong.
        // alert-key: audit_log_chain_broken
        // all-clear-proof: scripts/test-audit-chain.ts - a failed read, a failed write and
        // an unreadable row each report unmeasured and clear nothing.
        resolve: (key, text) => resolveAlert(key, text),
        cooldownMs: cooldownMs.audit_log_chain_broken,
      }),
    );
    if (auditChain) {
      log.info("monitor", {
        msg: "audit chain",
        status: auditChain.status,
        ...(auditChain.status === "unmeasured" ? { why: auditChain.why } : {}),
        ...(auditChain.status === "broken" ? { kind: auditChain.break.kind, checked: auditChain.checked } : {}),
        ...(auditChain.status === "progressing" ? { checked: auditChain.checked, pass_seq: auditChain.passSeq } : {}),
        ...(auditChain.status === "intact" ? { checked: auditChain.checked, through_seq: auditChain.throughSeq } : {}),
      });
    }

    // Watch the other lanes (#803). The sync lane does this too; running it from
    // BOTH means the every-minute lanes and the 5-minute lanes watch each other,
    // so whichever survives a killed invocation reports the one that didn't. The
    // per-lane alert cooldown dedupes the overlap. Never throws.
    //
    // #2382: the fallback is LANE_WATCHDOG_UNJUDGED, not undefined, and the
    // difference is the point. This step is the dead man's switch for every
    // other lane, so a throw here used to leave that switch dead behind a live
    // heartbeat. The verdict stamp at the foot of this handler is written only
    // when the watchdog really judged the lanes, so a watchdog that threw, or
    // that ran and could not read the heartbeats, goes stale like any other
    // detector that has stopped concluding (#1394).
    const laneWatchdog = await steps.run("lane_watchdog", LANE_WATCHDOG_UNJUDGED, () =>
      alertOnStaleLanes(),
    );

    // AFTER the lane watchdog, deliberately (2026-10-29): a stopped sync lane makes every
    // advisor stale by construction, so this page waits while the lanes' page is firing
    // and names sync (ALERT_FOLDS). Both cross on the same tick when the lanes stop
    // together, and judged first this posted three seconds before the page that explains
    // it. `scripts/test-alert-folds.ts` holds the order.
    // --- Sync-staleness gauge (#241): after #238 the backstop sync rotates
    // least-recently-synced first, so nothing surfaced an agent silently dropping
    // out of the rotation (roster too large for a tick, or a stuck agent). Load the
    // bookable agents that ARE in the rotation (a calendar row exists; a bookable
    // agent with none is the schedule/watch-onboarding lane's concern) and alert if
    // any is stale. markAgentsSynced stamps even errored agents, so a stale
    // last_synced_at means "not picked up", the residual gap the health probe /
    // heartbeat / anomaly checks don't cover. Both reads page past the 1,000 cap. ---
    const loadStaleCandidates = async (): Promise<SyncAgentStaleness[]> => {
      const [agents, cals] = await Promise.all([
        selectAllPages<{ id: string; name: string | null; email: string | null; last_synced_at: string | null }>(
          "monitor sync-staleness agents",
          "id",
          () =>
            realAdvisorsOnly(
              db.from("users").select("id, name, email, last_synced_at").eq("bookable", true).is("deactivated_at", null),
            ),
        ),
        // #2299: created_at and the sync failure columns come back with the row,
        // because the first-run grace is judged on when the calendar joined the
        // rotation and cancelled by a failure the rotation has already recorded.
        selectAllPages<{
          user_id: string;
          created_at: string | null;
          consecutive_failures: number | null;
          last_sync_error: string | null;
        }>(
          "monitor sync-staleness calendars",
          "id",
          () =>
            db
              .from("agent_calendars")
              .select("id, user_id, created_at, consecutive_failures, last_sync_error"),
        ),
      ]);
      return syncRotationCandidates(agents, cals);
    };
    const syncStaleness = await steps.run("sync_staleness", null, () =>
      runSyncStalenessCheck({
        loadAgents: loadStaleCandidates,
        nowMs: now,
        // alert-key: sync_staleness
        notify: sendThrottledAlert,
        // alert-key: sync_staleness
        // #1400: the gauge pages that agents' calendars have gone stale and could
        // never say it ended, so a reader had no way to tell a recovered fleet from
        // a cooldown still running. Hung off a MEASURED healthy reading.
        // all-clear-proof: scripts/test-sync-staleness.ts - a roster read
        // that failed reports unverified and clears nothing.
        resolve: resolveAlert,
        cooldownMs: cooldownMs.sync_staleness,
        log: (m) => log.info("sync-staleness", { msg: m }),
      }),
    );

    // Reliable trigger for the booking smoke canary (#525 follow-up). GitHub
    // scheduled runs are best-effort and get dropped under load (2-3h gaps against
    // the 30-min cadence), so the canary heartbeat aged past its 90m bound and the
    // watchdog above paged even though the booking path was healthy. This reliable
    // lane fills the gap: only when the heartbeat is stale does it fire the workflow
    // via GitHub's API, throttled by a NOT-released dispatch lock so it can't
    // double-fire. GitHub's own schedule stays on as a backup (the smoke-canary
    // concurrency group dedupes overlap). Quiet no-op until GITHUB_CANARY_TOKEN is
    // set. Never throws.
    // All FOUR gap-fills (#525 dry, #982 full, #2414 parity, #2466 weekly router
    // replay) in one tested helper:
    // each fires its workflow pass only when its OWN heartbeat is stale (GitHub
    // dropped that run), throttled by its own NOT-released dispatch lock so it
    // can't double-fire. The full pass creates real bookings on the SMOKE test
    // agents (webhooks are suppressed for is_test), the same side effect as the
    // scheduled hourly run; the parity pass corrects drifted hours from cal.com and
    // sweeps, the same side effect as the scheduled daily run, and its 27h30m
    // threshold is what keeps a merely late daily run from being re-fired, as the
    // replay's 7d4h one does for its weekly run. The
    // lane-watchdog backstop still pages if both GitHub AND the gap-fill fail one.
    // Quiet no-op until GITHUB_CANARY_TOKEN is set. Never throws.
    const canaryToken = githubCanaryToken();
    await steps.run("canary_gapfill", undefined, () =>
      runCanaryGapFills({
        now,
        token: canaryToken,
        readHeartbeatMs,
        // lock-overlap: the canary and parity dispatch cooldowns, deliberately held for
        // their TTL; dispatching again once a cooldown expires is the designed
        // behaviour.
        acquireLock: async (name, ttl) => (await acquireLock(name, ttl)) !== null,
        dispatch: (pass) => postWorkflowDispatch(canaryToken, pass),
        // #4009: wait on a run GitHub already holds rather than dispatching behind it.
        activeRuns: (pass) => countActiveWorkflowRuns(canaryToken, pass),
        // #2875: a cal.com lane is not re fired once cal.com is marked retired.
        // The same cached read the watchdog step above made, so no second query.
        calcomRetired: () => loadCalcomRetiredCached(now),
        onInfo: (msg) => log.info("canary-trigger", { msg }),
        onError: (msg, err) => log.error("canary-trigger", { msg }, err),
      }),
    );

    // Two things about GitHub Actions that nothing inside Slate could see, from ONE
    // listing of recent runs (#2476, #2229).
    //
    // It lives HERE rather than in a workflow because an Actions workflow cannot
    // report on Actions being unavailable: the run that would carry the report is
    // the run that did not happen. This lane keeps running when GitHub does not.
    //
    // Cost on the invocation four cron lanes share: TWO subrequests per five minute
    // tick (the runs listing, and main's tip, which #3648 reads from the branch so
    // "live" is judged against the commit main really points at), plus one more only
    // when the newest completed run failed, and one more only when the served commit
    // is not the tip and the listing does not hold the tip's run. Quiet no-op until
    // GITHUB_CANARY_TOKEN is set, like the gap filler above it. Never throws.
    const ciHealth = await steps.run("ci_health", null, () =>
      runCiHealthCheck({
        nowMs: now,
        servedCommit: BUILD_COMMIT,
        token: canaryToken,
        readRuns: (token) => fetchRecentRuns(token),
        readJobs: (token, runId) => fetchRunJobs(token, runId),
        readMainTip: (token) => fetchMainTip(token),
        readTipRuns: (token, sha) => fetchTipRuns(token, sha),
        cooldownMs: {
          deploy: cooldownMs.main_not_deployed,
          refusal: cooldownMs.ci_runs_refused,
        },
        // alert-key: main_not_deployed
        // alert-key: ci_runs_refused
        // alert-text-ok: our own copy from github-ci-health.ts, never a raw error.
        notify: sendThrottledAlert,
        // Both are conditions: each stays true until somebody deploys or until the
        // account can run jobs again, and this lane re-measures both every tick.
        // alert-key: main_not_deployed
        // alert-key: ci_runs_refused
        // all-clear-proof: scripts/test-github-ci-health.ts - an unreadable or
        // throwing runs listing clears neither key, because it measured neither.
        resolve: resolveAlert,
        log: (msg, fields) => log.info("ci-health", { msg, ...fields }),
        onError: (msg, err) => log.error("ci-health", { msg }, err),
      }),
    );

    // --- cal.com override sweep (#1253) -------------------------------------
    //
    // Retry an approved absence whose cal.com override FAILED, while it still
    // matters, and page once the absence is actually under way with no block in
    // place (from that moment a real customer can book someone who is away).
    //
    // Keyed on a recorded failure, never on `calcom_synced`: 631 approved requests
    // predate the dual-write and carry no cal.com outcome, so a flag-keyed sweep
    // would fire hundreds of writes for absences long past.
    //
    // It lives on this lane rather than a new one because this lane already both
    // heals and alerts (it recomputes caches and fills missing schedules), and
    // because the every-minute invocation is short of CPU headroom (#1245).
    const overrideSweep = await steps.run("override_sweep", null, () =>
      runCalcomOverrideSweep({
        nowMs: now,
        loadCandidates: () => loadFailedOverrideCandidates(db),
        retry: (requestId) => retryOverrideForRequest(db, requestId),
        // #2890: blocks left in cal.com by time off cancelled or changed while it
        // was retired, taken out once it is live, out of the same per tick cap.
        loadRemovals: () => loadStaleCalcomRemovals(db, now),
        removeStale: (removalId) => removeStaleCalcomBlock(db, removalId, now),
        // #2875: retired, nothing is retried and both pages end saying so. The
        // retry itself also refuses on a FRESH read inside `syncCalcomOverrides`.
        calcomRetired: () => loadCalcomRetiredCached(now),
        alert: async (key, text) => {
          // alert-key: ooo_calcom_unprotected
          // alert-text-ok: our own copy from calcom-override-sweep.ts, never a raw error.
          await sendThrottledAlert(key, cooldownMs.ooo_calcom_unprotected, text);
        },
        // alert-key: ooo_calcom_unprotected
        // alert-key: ooo_calcom
        // #1280: the sweep is where BOTH conditions are re-measured, so it is where
        // both end. The per approval page had no ending at all until now.
        // all-clear-proof: scripts/test-calcom-override-sweep.ts - an unreadable
        // candidate set clears neither key, and a row past the per tick cap keeps
        // the per approval page open because this tick never attempted it.
        resolve: (key, text) => resolveAlert(key, text),
        log: (msg) => log.info("calcom-sweep", { msg }),
      }),
    );

    // One line per tick carrying every step's own cost and, when something broke,
    // WHICH steps did not run (#1281 + #1277). Named rather than only counted: "two
    // checks failed" sends the reader to the logs, "override_sweep,migration_drift
    // failed" tells them which customer-visible checks were skipped this tick.
    log.info("monitor", { msg: "cycle", ...steps.fields() });

    // --- a step that keeps failing gets to speak (#2382) ---------------------
    //
    // Everything above this line is CONTAINED. The line above is the whole report
    // a broken check used to get: a field in a Cloudflare log with seven day
    // retention and no alerting on top of it. Before #1281 the same throw killed
    // the tick, the heartbeat lapsed, and the watchdog paged one `monitor` bound
    // later, so containment removed the only signal without adding a replacement.
    //
    // Deliberately NOT inside `steps.run`. This is the thing that reports the
    // runner's failures, so containing it would put the reporter behind the fault
    // it reports, which is the defect one level up. Its own sends are caught (one
    // failed Slack post must not skip the rest) and the streak store is quiet by
    // contract when it cannot track, so the only way out of here is a fault
    // nobody predicted, and that one belongs OUTSIDE the heartbeat stamp below:
    // the tick then dies loudly, exactly as it did before containment.
    //
    // It also sits ahead of the heartbeat for a second reason: judging steps is
    // part of this tick's work, and a tick that stamped and then failed would
    // claim more than it did.
    const stepVerdict = await judgeMonitorSteps(steps.outcomes(), {
      bump: recordConsecutiveStreak,
      clear: clearFailureStreak,
    });
    for (const { step } of stepVerdict.page) {
      // alert-key: monitor_step_failing:*
      // alert-text-ok: shortErrorReason already collapsed the error to one clause.
      await sendThrottledAlert(
        stepFailingAlertKey(step),
        MONITOR_STEP_ALERT_COOLDOWN_MS,
        monitorStepFailingAlert({
          step,
          ticks: stepFailingRuns(step),
          reason: stepFailureReasons.get(step) ?? null,
          gated: checksGatedByStep(step),
        }),
      ).catch((err) => {
        log.error("monitor", { msg: "step-failure alert failed", step }, err);
      });
    }
    if (stepVerdict.recovered.length > 0) {
      // A condition, so it ends, and it ends on a MEASURED healthy result: only a
      // step this tick actually RAN and completed is in this list, and only after
      // it has done so for a whole re-arm window. A step the tick never reached
      // measured nothing and appears in neither list.
      const stepAllClears = stepVerdict.recovered.map((step) => ({
        key: stepFailingAlertKey(step),
        text: monitorStepRecoveryText(step, stepRearmRuns(step)),
      }));
      // alert-key: monitor_step_failing:*
      // all-clear-proof: scripts/test-monitor-step-failure.ts - a step absent from
      // the tick, and a tick whose streak store could not be read, each clear
      // nothing, because neither measured the step working.
      const cleared = await resolveRecovered(stepAllClears).catch((err) => {
        log.error("monitor", { msg: "step-failure all-clear failed" }, err);
        return [] as string[];
      });
      if (cleared.length) log.info("monitor", { msg: "step alerts cleared", keys: cleared.join(",") });
    }

    // Stamp the dead-man's switch (#420): proves this lane ran this tick.
    // Best-effort, and must never affect the monitor's own response.
    // #3120: withheld when the lease was lost part way, so the gap pages.
    if (leaseHeldThroughout(lease, "monitor")) await recordHeartbeat("monitor").catch(() => {});

    // The SECOND kind of stamp (#1394): proves these detectors CONCLUDED
    // something this tick, which the heartbeat above cannot tell you. The
    // availability truth probe passed that heartbeat every five minutes for its
    // whole life while never once comparing a real calendar (#1377).
    //
    // Each predicate lives in verdict-freshness.ts and is node tested there, so
    // the question "does this outcome count" is answered in one place rather than
    // re-decided here. A tick that measured nothing writes nothing: the ABSENCE is
    // the signal the lane watchdog reads.
    await Promise.all([
      recordDetectorVerdict(AVAILABILITY_TRUTH_VERDICT_LANE, truthReachedVerdict(availabilityTruth)),
      // #3381: only a tick that judged at least one served time stamps.
      recordDetectorVerdict(OFFERED_NOBODY_FREE_VERDICT_LANE, offeredNobodyFreeReachedVerdict(offeredNobodyFree)),
      // #3040: only a tick that judged at least one booking with an assigned advisor stamps.
      recordDetectorVerdict(BUFFER_BREACH_VERDICT_LANE, bufferBreachReachedVerdict(bufferBreach)),
      recordDetectorVerdict(FAILURE_RATE_VERDICT_LANE, failureRateReachedVerdict(failureRate)),
      recordDetectorVerdict(LOW_VOLUME_VERDICT_LANE, lowVolumeReachedVerdict(volume)),
      recordDetectorVerdict(
        OOO_PROTECTION_VERDICT_LANE,
        oooProtectionReachedVerdict(oooProtection),
      ),
      // #2382: the dead man's switch's own verdict. The four above watch a
      // detector that runs and concludes nothing; this one watches the thing that
      // would otherwise have to notice that about itself. A watchdog that threw
      // gets LANE_WATCHDOG_UNJUDGED from the runner, and one that ran and could
      // not read the heartbeats returns judged:false from inside itself, which
      // used to be indistinguishable from a fleet where every lane was healthy.
      recordDetectorVerdict(
        LANE_WATCHDOG_VERDICT_LANE,
        laneWatchdogReachedVerdict(laneWatchdog),
      ),
      // #2505: the alarm that is silent on a healthy day AND on a broken one.
      // Every debt tier is staffed today, so it ships having never fired; the
      // absence of this stamp is the only thing that can tell a working detector
      // from a dead one.
      recordDetectorVerdict(
        TIER_STAFFING_VERDICT_LANE,
        tierStaffingReachedVerdict(tierStaffing),
      ),
      // #2593: stamped only when at least one booking was COMPARED. Parked until
      // real leads book (verdict-freshness.ts), and the first real booking unparks it.
      recordDetectorVerdict(
        BELOW_LEAD_TIER_VERDICT_LANE,
        belowLeadTierReachedVerdict(belowLeadTier),
      ),
      // #2933: stamped only when both reads succeeded in full and at least one real
      // Slate booking was compared, or when cal.com is marked retired.
      recordDetectorVerdict(
        CROSS_SYSTEM_BOOKINGS_VERDICT_LANE,
        crossSystemBookingsReachedVerdict(crossSystemBookings),
      ),
      // #2090: "nobody calling while not routable" and "no call reached Slate"
      // are the same silence, so only a tick that judged a real call stamps.
      recordDetectorVerdict(REGAL_CALLS_VERDICT_LANE, regalCallsReachedVerdict(regalCalls)),
      // #1941: a covered week is a verdict, an unreadable roster is not, and the
      // two are equally silent once #1456 arms the page.
      recordDetectorVerdict(
        ROSTER_COVERAGE_VERDICT_LANE,
        rosterCoverageReachedVerdict(rosterCoverage),
      ),
      // #2798: five gated checks that answered a failed read with a status of
      // their own, paging nothing and throwing nothing. Each stamps only on a
      // measured answer; the Regal pair shares one lane because they read one RPC.
      recordDetectorVerdict(AVAILABILITY_SCAN_VERDICT_LANE, availabilityScanReachedVerdict(scan)),
      recordDetectorVerdict(CALENDAR_WINDOW_VERDICT_LANE, calendarWindowReachedVerdict(calendarWindow)),
      recordDetectorVerdict(BUSY_DRIFT_VERDICT_LANE, busyDriftReachedVerdict(busyDrift)),
      recordDetectorVerdict(OFFSITE_ORIGIN_VERDICT_LANE, offsiteOriginReachedVerdict(offsiteOrigin)),
      // #3082: the auth settings check is silent while Google is the only way in AND
      // while its read keeps failing, so only a measured reading stamps.
      recordDetectorVerdict(AUTH_SIGN_IN_VERDICT_LANE, authSignInReachedVerdict(authSignIn)),
      recordDetectorVerdict(
        AWAITING_ACTIVATION_VERDICT_LANE,
        awaitingActivationReachedVerdict(awaitingActivation),
      ),
      // #2481: the stranded hire check, stamped on any read that concluded.
      recordDetectorVerdict(STRANDED_HIRES_VERDICT_LANE, strandedHiresReachedVerdict(strandedHires)),
      // #3090: the audit chain walk, stamped on every tick that read and judged rows.
      recordDetectorVerdict(AUDIT_CHAIN_VERDICT_LANE, auditChainReachedVerdict(auditChain)),
      recordDetectorVerdict(
        REGAL_CALL_FEED_VERDICT_LANE,
        regalCallFeedReachedVerdict(regalQuiet, regalUnreadable),
      ),
      // #2944: stamped only on a JUDGED ratio, never on "no calls" or too few.
      recordDetectorVerdict(REGAL_CALL_OUTCOMES_VERDICT_LANE, regalCallOutcomesReachedVerdict(regalOutcomes)),
    ]).catch((err) =>
      // recordHeartbeat already swallows its own DB errors, so reaching here means
      // something unexpected. It must not fail the monitor tick, but a stamp that
      // silently never lands would make these detectors page as blind while they
      // are in fact concluding, so it says so.
      log.warn("monitor", { msg: "detector verdict stamp failed" }, err),
    );

    return NextResponse.json({
      // null, never 0: an unreadable bucket list is not a fleet with no buckets,
      // and the smoke check reads this number (#1395).
      buckets: buckets === null ? null : buckets.length,
      // A skipped scan must not read like a clean one (#1296): it reports null and
      // names itself, rather than the `failing: 0` that means "checked, all well".
      ...availabilityScanReport(scan),
      codes: page,
      fallbackCovered: covered,
      thinTiers: thinTierCount,
      scheduleCoverage,
      attributeCoverage,
      // null, never a zeroed shape: `stale: 0` reads as every calendar fresh, which
      // is exactly the false-healthy reading a contained failure must not produce.
      syncStaleness:
        syncStaleness === null
          ? null
          : {
              stale: syncStaleness.staleCount,
              worstNeverSynced: syncStaleness.worstNeverSynced,
              worstAgeMs: syncStaleness.worstAgeMs,
            },
      // null, never a "healthy" shape: the step failing is not the booker being able
      // to explain itself, and the two must not render the same (#1420).
      emptyReason: emptyReasonHealth,
      // null when the step failed or its gate stood it down, never a covered-looking
      // shape: "could not check" and "everyone's hours cover the week" are the two
      // this check exists to keep apart (#1454).
      rosterCoverage,
      // status "unreadable" when the settings read threw, never a running-looking
      // shape: "could not read the switch" and "bookings are being taken" are the two
      // this check exists to keep apart (#2366).
      bookingPause,
      // status "unreadable" when the read threw, and "never-activated" while nobody has
      // switched the line on: neither is "on", and neither may render as it (#3339).
      sharedLineLeftOff,
      overrideSweep,
      // null when the step failed, and "not-measured" inside when GitHub could not
      // be read: "main's tip is live" and "nothing could say" must not render the
      // same (#2476, #2229).
      ciHealth,
      inactiveBookings,
      demotedBookings,
      // null when the step failed or its gate stood it down, never a zero: "could not
      // read the bookings" must not read as "no advisor holds calls too close" (#3040).
      // `forced` counts pairs a forced reassign stacked on purpose, which never page.
      bufferBreach,
      strandedCoverage,
      // null when the step failed, never a clear-looking zero: this check's whole
      // subject is a gap nothing else records, so "could not look" must not read as
      // "every approved absence is covered" (#1238).
      oooCoverageGap,
      // null when the step failed or its gate stood it down; status "unreadable"
      // inside when the roster read failed: "could not check coverage" must not
      // render as "every calendar is covered" (#1262).
      calendarWindow,
      // Database memory pressure (#3588). null when the step threw (a metrics read that
      // failed or a body that could not be parsed): "could not measure the database" is a
      // thrown blind spot (monitor_step_failing), never rendered as "the database is healthy".
      dbSaturation,
      // Findings are in the logs (tag=busy-drift), and drift that persists pages
      // (#1591). null when the step failed or its gate stood it down; status
      // "unreadable" when a side could not be read.
      busyDrift,
      migration: { status: migrationStatus, shipped: SHIPPED_MIGRATION_VERSION },
      // null when the step failed, and measured:false inside when the endpoint read
      // failed: "no event is unsubscribed" and "could not tell" must not render the
      // same, since the second is the state this check exists to notice (#1459).
      webhookSubscribers,
      // null when the step failed, and measured:false inside when the open handoffs
      // could not be read: "nothing waiting" and "could not look" must not read alike.
      handoffs,
      // null when the step failed; status "unmeasured" inside when the tick could not
      // look. Carries the runtime marker it observed on the HEALTHY path too, which is
      // the only place the assumption behind the hot path's runtime gate can be read
      // back off production rather than off Cloudflare's documentation (L82).
      edgeLimiters,
      // null when the step failed; status "unmeasured" inside when the read did not work
      // or came back empty. On the healthy path it carries how many definer functions were
      // read and which were excused by name, so "nothing is exposed" can be told apart from
      // "nothing was read" by anybody looking at a tick (#2447).
      definerGrants,
      // null when the step failed; status "unmeasured" inside when the settings could not
      // be read. Carries every provider the hosted project reports on (#3082).
      authSignIn,
      truncated,
      volume,
      pageVolume,
      failureRate,
      availabilityTruth,
      // Which steps failed, so a caller (and the smoke check) sees a degraded tick
      // rather than a 200 that looks identical to a clean one.
      steps: steps.outcomes().filter((o) => !o.ok).map((o) => o.name),
    });
  } finally {
    await releaseLock("cron_monitor", lease.token());
  }
}
