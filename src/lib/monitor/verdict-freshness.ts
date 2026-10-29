/**
 * Has this detector ever actually concluded anything? (#1394)
 *
 * Slate's monitoring detectors are deliberately fail safe: a calendar Google
 * refuses is scored `unverified`, a window with too few attempts is
 * `insufficient`, a bucket offering no times is `skipped`. That is the right
 * choice, because guessing turns every upstream blip into a page. The cost is
 * that "nothing to report" and "could not check anything" render identically, in
 * the logs and in the silence.
 *
 * The availability truth probe (#1315) lived in that second state for its whole
 * life and looked exactly like the first. Every tick since deploy skipped with
 * `why="bucket is offering no times to check"`, because the roster is dark
 * before cutover and the rotation excluded the two test buckets that do have
 * slots. Establishing that took a day of log archaeology (#1377).
 *
 * The lane heartbeats cannot see this: they prove the lane EXECUTED, and this
 * lane executed faithfully every five minutes for weeks. What it never did was
 * CONCLUDE. So these detectors get a second, differently shaped stamp, written
 * only on a measured verdict and watched against its own bound.
 *
 * PURE, so scripts/test-verdict-freshness.ts drives every branch node natively.
 * Every import here is a type. A park's un-park window is DERIVED from the window
 * the check judges rather than restated beside it (L63); when a park needs one,
 * import that check's shipped thresholds for it, as the failure rate park did
 * (#2499, removed in #2513).
 */
import type { LaneWatchdogOutcome } from "@/lib/monitor/health";
import type { TruthResult } from "@/lib/monitor/availability-truth";
import type { FailureRateResult } from "@/lib/monitor/booking-failure-rate";
import type { LowVolumeResult } from "@/lib/monitor/booking-volume";
import type { OooProtectionResult } from "@/lib/monitor/ooo-protection";
import type { BelowLeadTierResult } from "@/lib/monitor/below-lead-tier";
import type { CrossSystemBookingsResult } from "@/lib/monitor/cross-system-bookings";
import type { RegalCallResult } from "@/lib/monitor/regal-calls";
import type { RosterCoverageVerdict } from "@/lib/monitor/roster-coverage";
import type { AvailabilityScanResult } from "@/lib/monitor/availability-scan";
import type { CalendarWindowResult } from "@/lib/monitor/calendar-window-coverage";
import type { BusyDriftResult } from "@/lib/monitor/busy-drift-sampler";
import type { OffsiteOriginResult } from "@/lib/monitor/offsite-origin";
import type { AuthSignInSurfaceHealth } from "@/lib/monitor/auth-sign-in-surface";
import type { AuthUnexpectedSignInResult } from "@/lib/monitor/auth-unexpected-sign-ins";
import type { AwaitingActivationResult } from "@/lib/monitor/awaiting-activation";
import type { StrandedHiresResult } from "@/lib/monitor/stranded-hires";
import type { AuditChainResult } from "@/lib/monitor/audit-chain";
import type { RegalFeedQuietResult, RegalFeedUnreadableResult } from "@/lib/monitor/regal-call-feed";
import type { RegalCallOutcomesResult } from "@/lib/monitor/regal-call-outcomes";
import type { OfferedNobodyFreeResult } from "@/lib/monitor/offered-nobody-free";
import type { BufferBreachResult } from "@/lib/monitor/buffer-breach";
import type { monitorSetupGates } from "@/lib/monitor/setup-gates";

/**
 * The lane names these detectors stamp, namespaced away from the cron lane
 * heartbeats they sit beside in `lane_heartbeats`.
 *
 * They share the table on purpose. The lane watchdog already reads every row in
 * ONE query every minute, so watching four more costs nothing on the subrequest
 * budget four cron lanes share, and both stamps answer the same shape of
 * question ("when did this last happen"). The `verdict:` prefix is what keeps
 * the two meanings apart: a row under it records the last time the detector
 * reached a MEASURED verdict, never the last time it ran.
 */
export const AVAILABILITY_TRUTH_VERDICT_LANE = "verdict:availability-truth";
export const FAILURE_RATE_VERDICT_LANE = "verdict:booking-failure-rate";
export const LOW_VOLUME_VERDICT_LANE = "verdict:low-booking-volume";
export const OOO_PROTECTION_VERDICT_LANE = "verdict:ooo-protection";
export const TWILIO_ROSTER_VERDICT_LANE = "verdict:twilio-roster";
export const LANE_WATCHDOG_VERDICT_LANE = "verdict:lane-watchdog";
/**
 * The debt tier staffing alarm (#2505).
 *
 * It needs this stamp more than any of its siblings, because it is SILENT ON A
 * HEALTHY DAY AND SILENT ON A BROKEN ONE. Measured 2026-09-17, every debt tier is
 * staffed and offering times, so the alarm ships having never fired and will very
 * likely never fire, which is exactly the state that reads as a working detector
 * and as a dead one (#1394, L557). The lane heartbeat cannot see it: the tick runs
 * fine, and what it fails to do is CONCLUDE.
 */
export const TIER_STAFFING_VERDICT_LANE = "verdict:tier-staffing";
/**
 * The proof that the burst counter answers (#2392), and the first member of this
 * family stamped from OUTSIDE the Worker.
 *
 * `pnpm verify:burst-counter` (#1564) is the only thing that can see a counter which
 * is bound and does not answer: the monitor lane resolves the namespace as a property
 * read and stops, deliberately, because calling the object would create it and hand
 * the cron lane an alarm to clean up on every tick forever. The command was hand run,
 * and AGENTS.md asked in words for it to be re-run after any change to the burst path
 * or the binding. Nothing enforced that, the path moved five times with no run
 * recorded, and a check that has never once concluded is measuring nothing (L27, L557).
 *
 * So `.github/workflows/burst-counter.yml` runs it daily and stamps this lane through
 * the same key authed heartbeat endpoint the canary and the parity sweep use, only on
 * a run that MEASURED whether the counter answers and counts. Which endings those are
 * is decided in `scripts/lib/burst-counter-run-outcome.ts`, beside the command's own
 * exit table, rather than being re-derived here from a code number.
 */
export const BURST_COUNTER_VERDICT_LANE = "verdict:burst-counter";
/**
 * The nightly proof that public booking can still be stopped (#2493), and the
 * second member of this family stamped from OUTSIDE the Worker.
 *
 * `pnpm verify:kill-switch` (#2365) is the only thing that can see the fault that
 * matters most about the kill switch: the gate fails CLOSED on purpose, so a booker
 * that cannot read its own flag refuses EVERY lead, and nothing else would say so
 * until the booking failure rate window fired after real people had been turned
 * away. The command had run exactly once, in the session that wrote it.
 *
 * It could not simply copy the burst counter's daily morning slot, because running
 * it STOPS public booking for about two seconds, so
 * `.github/workflows/kill-switch.yml` runs it outside the hours the org advertises
 * and stamps this lane through the same key authed heartbeat endpoint the canary and
 * the parity sweep use, only on a run that MEASURED whether the gate refuses and
 * releases. Which endings those are is decided in
 * `scripts/lib/kill-switch-run-outcome.ts`, beside the command's own exit table,
 * rather than being re-derived here from a code number.
 */
export const KILL_SWITCH_VERDICT_LANE = "verdict:kill-switch";
/**
 * The daily proof that the shared confirm line answers (#3340), the third member of this
 * family stamped from OUTSIDE the Worker, by its own step of the burst counter's workflow.
 *
 * The confirm path falls back to the isolate's own line whenever the shared one cannot be
 * used (#3325), so a `CONFIRM_LINE` object that is bound and does not answer reads as
 * healthy until a crowd for one slot arrives, which is the load run the shared line was
 * built after. `pnpm verify:confirm-line` drives the confirm path's own client against the
 * live object; this lane is stamped only on a run where the object was asked and answered.
 * Which endings those are is decided in `scripts/lib/confirm-line-run-outcome.ts`.
 */
export const CONFIRM_LINE_VERDICT_LANE = "verdict:confirm-line";
/**
 * The daily reroute drill (#3615), the fourth member of this family stamped from OUTSIDE the
 * Worker, by its own steps of the burst counter's workflow.
 *
 * The automatic reroute on ineligibility acts only when Twilio narrows somebody, so a pipeline
 * that had stopped would look exactly like a quiet month (L557). `pnpm verify:reroute-on-ineligibility`
 * books a test call on the DRILL bucket, demotes its test advisor and requires the real decision,
 * sweep, drain and move back to do their work; this lane is stamped only on a run where that
 * pipeline was exercised. Which endings those are is decided in `scripts/lib/reroute-drill-run-outcome.ts`.
 */
export const REROUTE_DRILL_VERDICT_LANE = "verdict:reroute-drill";
/**
 * The booking below the lead's Salesforce tier check (#2593).
 *
 * Silent on a healthy day AND on a broken one, like the tier staffing alarm: two
 * bookings in twelve hundred is the incident rate, so almost every tick finds
 * nothing, and a Salesforce read that stopped working would find nothing too.
 */
export const BELOW_LEAD_TIER_VERDICT_LANE = "verdict:below-lead-tier";

/**
 * The cross system double booking check (#2933): a lead holding a live booking in
 * both Slate and cal.com.
 *
 * Silent on a healthy hour AND on a broken one. Two leads in about twelve hundred
 * was the measured rate on 2026-10-01, so almost every run finds nothing, and a
 * cal.com listing that had started refusing would find nothing too.
 */
export const CROSS_SYSTEM_BOOKINGS_VERDICT_LANE = "verdict:cross-system-bookings";

/**
 * The Regal call detector (#2090): somebody placing calls in Regal while Slate
 * will not route to them.
 *
 * It needs this stamp for the reason the whole family exists: "nobody in that
 * state" and "no calls reached Slate at all" are the same silence. Regal's
 * reporting webhook has pointed at Slate since 2026-09-24 (#2695), so a lapsed
 * stamp now means the feed stopped arriving, and the watch pages on it.
 */
export const REGAL_CALLS_VERDICT_LANE = "verdict:regal-calls";

/**
 * The roster coverage alarm (#1941): advertised hours no bookable agent is
 * rostered for (#1454).
 *
 * Once #1456 arms it, a fully covered week is silent, and so is every tick that
 * could not read the roster, was skipped by its setup gate, or had no week to
 * hold the roster against. This stamp is what tells those apart.
 */
export const ROSTER_COVERAGE_VERDICT_LANE = "verdict:roster-coverage";

/**
 * Five lanes for the gated checks the #1941 registry found swallowing a failed
 * read (#2798). Each check answers a read that failed with a status of its own
 * (`unreadable`, `unmeasured`, or a scan whose every verify came back null) that
 * pages nothing and throws nothing, so `monitor_step_failing` cannot see it and
 * a read broken for a week looked exactly like a quiet, healthy week.
 *
 * The two Regal feed checks share ONE lane, `verdict:regal-call-feed`, stamped
 * only when BOTH concluded. They read the same RPC (`regal_call_reason_counts`)
 * on the same tick, so the fault a lane exists for, that read failing over and
 * over, takes both out at once, and two lanes would page twice about one broken
 * read (L333). Requiring both keeps each one's own blindness visible: the quiet
 * check can go unmeasured on its own (no whole business day to judge), and an OR
 * would let the other check's verdicts hide that.
 */
export const AVAILABILITY_SCAN_VERDICT_LANE = "verdict:availability-scan";
export const CALENDAR_WINDOW_VERDICT_LANE = "verdict:calendar-window";
export const OFFSITE_ORIGIN_VERDICT_LANE = "verdict:offsite-origin";
/**
 * The auth sign in settings check (#3082). Once the hosted Email provider is off it is
 * silent on every healthy tick, and it is equally silent on a tick whose settings read
 * failed, stalled or answered a shape it would not judge. The stamp is what tells a
 * project where Google is the only way in from a detector that stopped reading.
 */
export const AUTH_SIGN_IN_VERDICT_LANE = "verdict:auth-sign-in";
/**
 * The unexpected sign in check (#4379). Silent while nothing got past the sign in
 * controls AND while its reads keep failing (the sign in method claims, the account
 * listing, the roster), so only a tick that measured at least one half stamps.
 */
export const AUTH_UNEXPECTED_SIGN_IN_VERDICT_LANE = "verdict:auth-unexpected-sign-in";
export const AWAITING_ACTIVATION_VERDICT_LANE = "verdict:awaiting-activation";
/**
 * The stranded hire check (#2481). Silent on a healthy roster AND on a broken
 * read, and the shape it looks for is rare by construction, so the stamp is the
 * only thing that can tell a working detector from a blind one.
 */
export const STRANDED_HIRES_VERDICT_LANE = "verdict:stranded-hires";
/**
 * The audit log hash chain walk (#3090). Silent on an untouched trail AND on a
 * walk that cannot read it, and a broken chain should never happen at all, so a
 * walk that has quietly stopped would read exactly like an audit log nobody has
 * touched. This stamp is what tells the two apart.
 */
export const AUDIT_CHAIN_VERDICT_LANE = "verdict:audit-chain";
export const REGAL_CALL_FEED_VERDICT_LANE = "verdict:regal-call-feed";
/**
 * The call outcome ratio (#2944): outcome rows written against completed calls
 * received. Its own lane, not the feed pair's, because it reads a second count
 * (`regal_call_outcomes`) whose failure is a different fault. It concludes only
 * on a window with enough calls to judge, so like the Regal call detector its
 * longest legitimate silence is a weekend.
 */
export const REGAL_CALL_OUTCOMES_VERDICT_LANE = "verdict:regal-call-outcomes";
/**
 * The smoke canary's availability latency reading (#1700), the third member of this
 * family stamped from OUTSIDE the Worker.
 *
 * The latency check reports "not measured" and exits 0 when it gets no usable samples,
 * deliberately, because a canary that could not reach the endpoint already fails on the
 * availability check and failing twice for one cause stops an alert naming its cause.
 * The cost was that nothing watched for that outcome repeating: a check that has
 * stopped measuring and a read that keeps being fast looked the same every 30 minutes.
 *
 * So `.github/workflows/smoke-canary.yml` stamps this lane whenever the check read a
 * REAL median, pass or fail. Which runs those are is decided beside the check itself,
 * in `measureLatency` (`scripts/lib/latency-slo.ts`), since that script runs on bare
 * node and cannot import this file.
 */
export const AVAILABILITY_LATENCY_VERDICT_LANE = "verdict:availability-latency";

/**
 * The daily advisor photo refresh (#3027): a run that read the directory and at
 * least one photo, and did not trip the guard against a wave of lost photos.
 *
 * It needs this stamp because its failures are quiet. A refresh that stops
 * reaching anybody leaves every page showing yesterday's photo, which looks
 * exactly like a day on which nobody changed theirs.
 */
export const ADVISOR_PHOTOS_VERDICT_LANE = "verdict:advisor-photos";

/**
 * The daily busy minute check (#3124): a run that counted BOTH halves of the week's
 * routed bookings (Slate's, and cal.com's until it is marked retired) and judged them
 * against the load run's bar.
 *
 * It needs this stamp because it is silent on a healthy week and, if it stopped
 * counting, silent on a broken one: the bar would quietly stop being ten times over
 * real traffic with nothing saying so. The stamp is also the lane's only heartbeat, so
 * a schedule that stopped firing goes stale here too.
 */
export const BUSY_MINUTES_VERDICT_LANE = "verdict:busy-minutes";

/**
 * The busy drift sampler (#1591). It shipped observe only and exempt from this
 * family, because going blind silenced nothing. Armed, it pages on drift that
 * persists, so a sampler whose live or cached read keeps failing would silence
 * that page while reading exactly like a cache that agrees with Google.
 */
export const BUSY_DRIFT_VERDICT_LANE = "verdict:busy-drift";

/**
 * The hourly cron CPU check (#3141), stamped by `/api/cron/cron-budget` only when it read a
 * whole day of Cloudflare's CPU figures (`cronCpuReachedVerdict`). A refused token, a schema
 * error and an empty answer all page nothing, so without this stamp a check that can no longer
 * read would look exactly like a day under the line.
 */
export const CRON_BUDGET_VERDICT_LANE = "verdict:cron-budget";

/**
 * The served versus confirm check (#3381): is the booker offering a time the confirm's
 * own candidate read refuses? Silent on a healthy day and silent on a broken one, like
 * the tier staffing alarm, so the stamp is the only thing that tells a working check
 * from one that has stopped judging anything.
 */
export const OFFERED_NOBODY_FREE_VERDICT_LANE = "verdict:offered-nobody-free";

/**
 * The buffer breach check (#3040): are two active calls on one advisor closer than the
 * call type's buffers? Silent on a healthy day, and silent when its read returns nothing
 * it can judge, so the stamp is what tells a check holding real bookings against the
 * buffers from one that has stopped reading any.
 */
export const BUFFER_BREACH_VERDICT_LANE = "verdict:buffer-breach";

/**
 * Verdict lanes whose detector needs an OPTIONAL secret to run at all, by the secret's name.
 *
 * Unset, such a detector cannot conclude by construction, and it says so in its own quiet state
 * (for the cron CPU check, a daily info line). Calling it blind as well would page every day
 * about a decision nobody has made yet, which is how a page stops being read (L36). So the
 * watchdog stands down on these lanes while, and ONLY while, the named secret is unset: once it
 * is set the lane is judged like any other, and a token that stops working goes stale and pages.
 * The stand down is no broader than its reason (L324).
 */
export const DETECTOR_REQUIRED_SETTING: Partial<Record<string, string>> = {
  [CRON_BUDGET_VERDICT_LANE]: "CF_ANALYTICS_TOKEN",
};

/** The secret `lane` needs and this deployment lacks, or null when the lane is watched as usual. */
export function unconfiguredDetector(
  lane: string,
  env: Record<string, string | undefined>,
  registry: Partial<Record<string, string>> = DETECTOR_REQUIRED_SETTING,
): string | null {
  const setting = registry[lane];
  if (!setting) return null;
  return (env[setting] ?? "").trim() === "" ? setting : null;
}

export type DetectorVerdictLane =
  | typeof TIER_STAFFING_VERDICT_LANE
  | typeof AVAILABILITY_TRUTH_VERDICT_LANE
  | typeof FAILURE_RATE_VERDICT_LANE
  | typeof LOW_VOLUME_VERDICT_LANE
  | typeof OOO_PROTECTION_VERDICT_LANE
  | typeof TWILIO_ROSTER_VERDICT_LANE
  | typeof LANE_WATCHDOG_VERDICT_LANE
  | typeof BURST_COUNTER_VERDICT_LANE
  | typeof KILL_SWITCH_VERDICT_LANE
  | typeof CONFIRM_LINE_VERDICT_LANE
  | typeof REROUTE_DRILL_VERDICT_LANE
  | typeof BELOW_LEAD_TIER_VERDICT_LANE
  | typeof CROSS_SYSTEM_BOOKINGS_VERDICT_LANE
  | typeof REGAL_CALLS_VERDICT_LANE
  | typeof ROSTER_COVERAGE_VERDICT_LANE
  | typeof AVAILABILITY_SCAN_VERDICT_LANE
  | typeof CALENDAR_WINDOW_VERDICT_LANE
  | typeof OFFSITE_ORIGIN_VERDICT_LANE
  | typeof AUTH_SIGN_IN_VERDICT_LANE
  | typeof AUTH_UNEXPECTED_SIGN_IN_VERDICT_LANE
  | typeof AWAITING_ACTIVATION_VERDICT_LANE
  | typeof STRANDED_HIRES_VERDICT_LANE
  | typeof AUDIT_CHAIN_VERDICT_LANE
  | typeof REGAL_CALL_FEED_VERDICT_LANE
  | typeof REGAL_CALL_OUTCOMES_VERDICT_LANE
  | typeof ADVISOR_PHOTOS_VERDICT_LANE
  | typeof BUSY_MINUTES_VERDICT_LANE
  | typeof AVAILABILITY_LATENCY_VERDICT_LANE
  | typeof BUSY_DRIFT_VERDICT_LANE
  | typeof CRON_BUDGET_VERDICT_LANE
  | typeof OFFERED_NOBODY_FREE_VERDICT_LANE
  | typeof BUFFER_BREACH_VERDICT_LANE;

/**
 * Did this availability truth tick compare real calendars and decide?
 *
 * `checked` alone is not enough. A tick reports `checked` even when the sample
 * was too small to judge (`verdict.status === "unverified"`, which is what
 * `minVerified` exists to produce), and stamping on that would let a probe that
 * can only ever read two calendars look like one that keeps confirming the cache
 * is honest. That is the same substitution the issue is named after, one level in.
 */
export function truthReachedVerdict(result: TruthResult | { status: "errored" }): boolean {
  return result.status === "checked" && result.verdict.status !== "unverified";
}

/**
 * Did this failure rate tick judge a real window?
 *
 * `insufficient` is excluded for the reason it exists: below `minAttempts` there
 * is no honest rate to quote. On a dark roster that is EVERY tick, so counting
 * it would report the detector healthy for exactly as long as it is blind.
 */
export function failureRateReachedVerdict(
  // "skipped" is a tick whose settings could not be read (#2773): it measured nothing.
  result: FailureRateResult | { status: "errored" } | { status: "skipped"; why: string },
): boolean {
  return result.status === "checked" && result.verdict.status !== "insufficient";
}

/**
 * Did this low volume tick read the counts and judge them?
 *
 * `outside-hours` is a legitimate non answer twelve hours a day and all weekend,
 * which is why this detector's bound is measured in days rather than hours.
 * `count-unreadable` is the false zero #1158 removed, and must never stamp.
 */
export function lowVolumeReachedVerdict(result: LowVolumeResult): boolean {
  return result.status === "checked";
}

/**
 * Did this time off protection tick actually read the approved requests? (#1467)
 *
 * Unlike its three siblings there is no "measured but not enough to judge" state
 * here: a successful read answers the question outright, including when it finds
 * no approved time off at all, because nothing approved can then be unprotected.
 * The one outcome that must never stamp is `unreadable`, which is precisely the
 * state that would otherwise be indistinguishable from a run of clean ticks.
 */
export function oooProtectionReachedVerdict(result: OooProtectionResult): boolean {
  return result.status !== "unreadable";
}

/**
 * Did the debt tier alarm judge ANY tier this tick? (#2505)
 *
 * `measuredAny` and nothing else. A tick where the roster read or the cached slot
 * rows failed reports every tier `unmeasured`, which is the honest outcome and is
 * NOT a verdict: stamping it would keep the freshness looking healthy for as long
 * as the read stayed broken, which is the blindness this family exists to notice.
 *
 * A null result is a tick that skipped or threw, which concluded nothing either.
 */
export function tierStaffingReachedVerdict(
  result: { measuredAny: boolean } | null,
): boolean {
  return result?.measuredAny === true;
}

/**
 * Did the below-tier check COMPARE at least one booking this tick? (#2593)
 *
 * `compared > 0` and nothing less. A run where either read failed is
 * `unreadable`; a run that read both sides and could judge nobody (no upcoming
 * real bookings, or only bookings whose lead has no readable XBC) measured
 * nothing either, and stamping it would let a detector that has never once held
 * a lead's tier against a pool read as one that keeps finding them in agreement
 * (L98). A null result is a step that skipped or threw.
 */
export function belowLeadTierReachedVerdict(result: BelowLeadTierResult | null): boolean {
  return result?.status === "measured" && result.compared > 0;
}

/**
 * Did the cross system double booking check compare real bookings this run? (#2933)
 *
 * `measured` with at least one real Slate booking compared, which means both reads
 * succeeded in full. Comparing zero is never a verdict (L98), and neither is a run
 * that was not due, could not read a side, or has no cal.com key.
 *
 * `retired` IS one, and it is the single exception, stated rather than implied: a
 * stored "cal.com is retired" is a settled answer that there is nothing left to
 * compare, set by a person on the alerts page and audited there (#2875). Without it,
 * cutover would turn this lane into a permanent page about a comparison that was
 * switched off on purpose. An UNREADABLE switch is not retired, and compares as today.
 */
export function crossSystemBookingsReachedVerdict(result: CrossSystemBookingsResult | null): boolean {
  if (result?.status === "retired") return true;
  return result?.status === "measured" && result.slateCompared > 0;
}

/**
 * Did the Regal call detector judge a real call this tick? (#2090)
 *
 * Only `checked`, which means every read succeeded AND at least one call from a
 * Slate user arrived in the window. `no-calls` is excluded because a feed nobody
 * posts to produces exactly it, and `unreadable` because it measured nothing. A
 * tick whose only callers were exempt IS a verdict: it read a real call and
 * decided about it.
 */
export function regalCallsReachedVerdict(result: RegalCallResult | null): boolean {
  return result?.status === "checked";
}

/**
 * Did the roster coverage alarm hold a real roster against a real week? (#1941)
 *
 * `gaps` and `covered` both stamp, and the second is the one that matters: an
 * empty gap list is a genuine finding of full coverage, where `skipped` (the
 * roster could not be read, so `coverageForWeek` answered `{ ok: false }`) is an
 * absence of one. Both end a tick with nothing paged, so this predicate is the
 * only place the difference survives. A disarmed tick that found gaps still
 * stamps: the switch decides whether it pages, not whether it looked.
 *
 * Null is a step the setup gate refused, a tick with no business hours, or a step
 * that threw; none of them measured anything.
 */
export function rosterCoverageReachedVerdict(result: RosterCoverageVerdict | null): boolean {
  return result?.status === "gaps" || result?.status === "covered";
}

/**
 * Did the availability scan conclude anything about the buckets this tick? (#2798)
 *
 * The scan recomputes each dead end live to learn WHY it is empty, and that
 * recompute swallows its own failure to null (`recomputeSlots(code).catch(() =>
 * null)`), so a recompute failing on every tick leaves every dead end
 * `unverified`. Those do page, as `availability_data_anomaly`, but the tick
 * concluded nothing about any of them, and a scan that can never verify a dead
 * end is not the detector anybody believes is running.
 *
 * So a tick stamps when it verified at least one dead end (the recompute
 * answered, whether it found times or found the bucket booked solid), or when it
 * saw every bucket and found no dead end at all. It does NOT stamp when every
 * dead end came back unverified, when a scan cut short by its deadline found
 * nothing (`availabilityAlertVerdict` calls that `unknown` for the same reason),
 * or when it scanned zero buckets, which measured nothing (L98). Null is a step
 * the setup gate refused or that threw.
 */
export function availabilityScanReachedVerdict(scan: AvailabilityScanResult | null): boolean {
  if (!scan || scan.bucketsScanned === 0) return false;
  if (scan.page.length > 0) return scan.cause.unverified.length < scan.page.length;
  return !scan.truncated;
}

/**
 * Did the calendar window check judge at least one calendar? (#2798)
 *
 * `uncovered` and `clear` both stamp, since "every calendar is hydrated to the
 * booking horizon" is an answer. `unreadable` does not, and neither does a
 * `clear` that judged nobody: an empty roster, or one where every calendar joined
 * too recently to judge (#2300), reads as clear and measured nothing (L98).
 */
export function calendarWindowReachedVerdict(result: CalendarWindowResult | null): boolean {
  if (!result) return false;
  if (result.status === "uncovered") return true;
  return result.status === "clear" && result.judged > 0;
}

/**
 * Did the busy drift sampler compare a real calendar against the cache? (#1591)
 *
 * A tick that read both sides for at least one agent concluded, whether it found
 * drift or not. An unreadable side, a sample where every agent's calendar errored,
 * and a skipped or thrown step measured nothing (L98).
 */
export function busyDriftReachedVerdict(result: BusyDriftResult | null): boolean {
  return result !== null && result.status === "observed" && result.agentsChecked > 0;
}

/**
 * Did the served versus confirm check JUDGE at least one served time? (#3381)
 *
 * `judged > 0` and nothing less. An unreadable pool list or marker set, a tick whose
 * every candidate read failed, and a tick with nothing served to judge all measured
 * nothing, and stamping them would let a check that never once held a served time
 * against the confirm read as one that keeps finding them agree (L98). A null result
 * is a step that skipped or threw.
 */
export function offeredNobodyFreeReachedVerdict(result: OfferedNobodyFreeResult | null): boolean {
  return result?.status === "measured" && result.judged > 0;
}

/**
 * Did the buffer breach check judge at least one upcoming booking? (#3040)
 *
 * At least one booking WITH an advisor, and nothing less: an unassigned booking is
 * counted in `examined` but pairs with nothing, so it judged nothing. Production holds hundreds of upcoming bookings, so
 * a read that keeps returning none is a filter or a window gone wrong, and stamping it
 * would let a check that never once held a booking against the buffers read as one
 * that keeps finding them clear (L98). A null result is a step that skipped or threw.
 */
export function bufferBreachReachedVerdict(result: BufferBreachResult | null): boolean {
  return result?.status === "measured" && result.examined - result.unassigned > 0;
}

/**
 * Did the off site origin check read the recent bookings? (#2798)
 *
 * Like the time off protection check, a successful read answers the question
 * outright, including when it finds no recent booking at all: nothing booked
 * cannot have been booked from somewhere else. Before cutover that is the
 * ordinary tick, and it is still a read that worked. Only `unreadable` and a
 * refused or thrown step stamp nothing.
 */
export function offsiteOriginReachedVerdict(result: OffsiteOriginResult | null): boolean {
  return result?.status === "checked";
}

/**
 * Did the auth sign in settings check read the hosted settings and judge them? (#3082)
 *
 * Healthy and open are both answers. Unmeasured (a failed, stalled or unreadable
 * read) and a thrown step stamp nothing, so a check that has stopped reading goes
 * stale and pages instead of looking like a project where Google is the only way in.
 */
export function authSignInReachedVerdict(result: AuthSignInSurfaceHealth | null): boolean {
  return result !== null && result.status !== "unmeasured";
}

/**
 * Did the unexpected sign in check measure anything? (#4379) A tick it was not due on,
 * and one where neither half could be read, stamp nothing, so a check that has gone
 * blind ages and pages instead of reading as nobody signing in another way.
 */
export function authUnexpectedSignInReachedVerdict(result: AuthUnexpectedSignInResult | null): boolean {
  if (result === null || result.status === "not-due") return false;
  return result.logins.status === "measured" || result.accounts.status === "measured";
}

/**
 * Did the waiting to become bookable check read the roster? (#2798)
 *
 * `clear` is the ordinary answer, since the read selects only the rows carrying
 * `bookable_pending_since` and nobody waiting is a finding. `waiting` stamps too,
 * armed or not: the switch decides whether it pages, not whether it looked.
 */
export function awaitingActivationReachedVerdict(result: AwaitingActivationResult | null): boolean {
  return result !== null && result.status !== "unreadable";
}

/**
 * Did the stranded hire check read the roster and judge it? (#2481)
 *
 * `clear` is the ordinary answer and stamps; `stranded` stamps too. Only an
 * unreadable read, or a step that threw, is no verdict.
 */
export function strandedHiresReachedVerdict(result: StrandedHiresResult | null): boolean {
  return result !== null && result.status !== "unreadable";
}

/**
 * Did the audit chain walk read rows and judge them? (#3090)
 *
 * A tick part way through a walk stamps: it verified the rows it read, which is
 * the work. So does a break, and a complete walk. Only an unmeasured tick (a read
 * or write that failed, or a row it could not hash), or a step that threw, is no
 * verdict.
 */
export function auditChainReachedVerdict(result: AuditChainResult | null): boolean {
  return result !== null && result.status !== "unmeasured";
}

/**
 * Did BOTH Regal feed checks read the reason counts and judge them? (#2798)
 *
 * One lane for the two, stamped only when both concluded (the lane's own comment
 * says why one lane and not two). `quiet` is a verdict: a day with no call from a
 * Slate user was measured, and that is what the quiet page is about.
 * `unmeasured` is not, whether the RPC failed or there was no whole business day
 * to judge.
 */
export function regalCallFeedReachedVerdict(
  quiet: RegalFeedQuietResult | null,
  unreadable: RegalFeedUnreadableResult | null,
): boolean {
  if (!quiet || !unreadable) return false;
  return quiet.status !== "unmeasured" && unreadable.status !== "unmeasured";
}

/**
 * Did the call outcome ratio read both counts and JUDGE a rate? (#2944)
 *
 * Healthy and short are verdicts. "No calls" and "too few" are not: nothing was
 * judged, and stamping on them would let a check whose outcome count had stopped
 * mattering look exactly like one confirming the table fills.
 */
export function regalCallOutcomesReachedVerdict(result: RegalCallOutcomesResult | null): boolean {
  return result !== null && (result.status === "healthy" || result.status === "short");
}

/**
 * Did this roster sync actually read Twilio and judge the roster? (#2114)
 *
 * The Twilio half either returns a result or refuses by name, so there is no
 * "measured but not enough to judge" state to exclude here. What this stamp adds
 * is the thing nothing else watches: the hourly roster job has NO lane heartbeat
 * of its own, so a run that stops happening altogether says nothing, and the
 * failure alert only fires when a run happens and fails. A job that is simply not
 * running produces neither, and reads exactly like a healthy quiet roster (#1394).
 *
 * A refused read stamps nothing, deliberately: that is already paged by
 * `twilio_sync_failures`, and stamping there would report the detector as
 * concluding while it is blind, which is the whole substitution this family exists
 * to stop.
 */
export function twilioRosterReachedVerdict(twilio: { ok: boolean }): boolean {
  return twilio.ok;
}

/**
 * Did this tick's lane watchdog actually judge the lanes? (#2382)
 *
 * The sixth member of the family and the one that watches the watchman. The
 * dead man's switch is itself a contained step on the monitor lane, so a
 * watchdog throwing every five minutes was caught, logged into a seven day log
 * nobody is paged from, and left the monitor heartbeat stamped fresh. From that
 * moment no stale lane anywhere could page.
 *
 * Two states stamp nothing, and they arrive by different routes. A step that
 * THREW hands back `LANE_WATCHDOG_UNJUDGED` from the runner. A step that RAN and
 * could not read the heartbeats returns `judged: false` from inside itself, and
 * that one matters more than it looks: it used to return an empty stale list,
 * which is exactly what a healthy fleet returns.
 */
export function laneWatchdogReachedVerdict(outcome: LaneWatchdogOutcome): boolean {
  return outcome.judged;
}

/**
 * A detector that CANNOT reach a verdict yet, and is deliberately not paging (#1561).
 *
 * The verdict watch above pages a detector that has stopped concluding, which is
 * right, and before cutover two of them had never been able to conclude at all
 * (the availability truth probe now can, and was unparked in #1831). The page
 * named no action anybody could take this morning (L111) and repeated every 24
 * hours, which is how a channel gets ignored (L36).
 *
 * Parking is deliberately a hand written registry rather than something derived
 * from a live signal. "The roster is dark" is not a fact any single query returns
 * honestly, and a park that switched itself off on a misread would take a real
 * safety net down silently. An entry here is a person saying, in the repo, that
 * they know this net is off and which issue turns it back on.
 *
 * Three rules make the park safe, all enforced by scripts/test-detector-park.ts:
 * every entry names the issue that arms it again, every entry declares how fresh
 * a verdict has to be to count as concluding (`unparkWithinMs`, and it must be
 * tighter than the lane's blindness bound), and the watchdog PAGES when a parked
 * detector reaches a verdict anyway. The last is what stops the park outliving its
 * reason: cutover looks exactly like a parked detector starting to conclude, and
 * nobody has to remember anything for it to be noticed.
 */
export interface ParkedDetector {
  /** Why it cannot conclude, in the terms a reader of the whisper needs. */
  reason: string;
  /** The issue that takes it back out. Required: a park with no issue is a note to nobody. */
  issue: number;
  /**
   * How fresh a verdict has to be to mean "this detector is concluding NOW" (#1562).
   *
   * Required, and deliberately TIGHTER than the lane's blindness bound. Reusing
   * that bound is the defect this field replaces: for the failure rate check it
   * asked "has it concluded at any point in the last four days", and production
   * answered yes off a two minute coincidence. One full smoke canary pass records
   * exactly 16 booking attempts against a floor of 20 in a rolling hour, so a
   * single pass never concludes, but the canary runs four or five times a day and
   * two landing inside one hour clear the floor between them. That happened once,
   * at 2026-08-29T01:25Z, and then nothing for two and a half days while a daily
   * page asked for a blind detector to be armed.
   *
   * So the question this window asks is the one that actually separates cutover
   * from an accident in the test harness: real traffic keeps the stamp fresh on
   * essentially every tick, where a burst keeps it fresh once and then lets it
   * lapse. It does not make a burst silent, and it is not claimed to: it bounds
   * the page to the span the detector was genuinely concluding in, and the lapse
   * ends it.
   */
  unparkWithinMs: number;
}

export const PARKED_VERDICT_DETECTORS: Partial<Record<DetectorVerdictLane, ParkedDetector>> = {
  // The availability truth probe's park was REMOVED here on 2026-09-07 (#1831),
  // which is the park working rather than the park being abandoned. Its reason was
  // that the roster was dark, so the bucket the probe picks each tick offered no
  // times to check, and the 2026-09-02 roster flip (#1739) ended that: 57 of the 60
  // non test buckets are offering times, and the probe stamped a verdict on two
  // consecutive monitor ticks. The daily un-park page is what said so, unprompted,
  // for four days. Note this arms the WATCH on the probe concluding, not the drift
  // page itself, which is a separate switch and still off (#1371).
  //
  // The failure rate park was removed on 2026-09-16 (#2484), PUT BACK on
  // 2026-09-17 (#2499), and removed for good on 2026-10-01 (#2513). It was parked
  // because the smoke canary can never reach the check's floor: the outcome mix
  // read passes `p_include_test: false` (#1637), so only real leads count, and
  // before the Low pilot there were none. The pilot went live on 2026-09-29, 82
  // real leads booked through the production site on 2026-10-01, and the detector
  // stamped a verdict on the monitor tick of 2026-10-01 13:51 UTC. This arms the
  // WATCH on the check concluding; the failing bookings page itself is a separate
  // switch on /admin/alerts (#1367).
  // The below lead tier watch (#2593) was parked here until 2026-09-30 (#2696):
  // no real lead had an upcoming booking to compare. The Low pilot went live on
  // 2026-09-29 and the lane concluded on the monitor tick of 2026-09-30 18:33 UTC,
  // so the un-park page said so and the entry came out.
};

/**
 * The park entry for a lane, or null when it is armed.
 *
 * `registry` is injectable for ONE reason and it is not convenience: the shipped
 * registry is currently EMPTY (#2513 armed the last entry), so without a seam the
 * park mechanism has nothing to drive it and its whole suite would have to be
 * deleted rather than kept. A mechanism that ships with no exercised test is one
 * that breaks silently the next time somebody parks a detector (L535).
 */
export function parkedDetector(
  lane: string,
  registry: Partial<Record<string, ParkedDetector>> = PARKED_VERDICT_DETECTORS,
): ParkedDetector | null {
  return registry[lane] ?? null;
}

/**
 * What the watchdog should do about one verdict lane this tick.
 *
 *  - `armed`  the ordinary path: judge it against its bound and page if blind.
 *  - `parked` known blind, deliberately quiet, and reported as parked so the
 *             missing net is visible rather than merely silent.
 *  - `unpark` parked, and yet it has just concluded, judged against the park's own
 *             `unparkWithinMs` rather than the wider blindness bound. The reason
 *             for the park has stopped being true, so this pages: it is the
 *             arrival of the very traffic the park was waiting for. A detector
 *             that lapses back to `parked` ends that page with its own wording,
 *             because nobody armed it and an all-clear saying otherwise would be
 *             a claim the watchdog never measured.
 *
 * An UNREADABLE stamp (the epoch-0 sentinel, #1172) is not a verdict. Reading it
 * as one would arm a detector off a corrupt record, which is the opposite of what
 * every other reader of that sentinel does.
 */
export type DetectorParkState = "armed" | "parked" | "unpark";

export function detectorParkState(
  lane: string,
  lastVerdictMs: number | null | undefined,
  nowMs: number,
  registry: Partial<Record<string, ParkedDetector>> = PARKED_VERDICT_DETECTORS,
): DetectorParkState {
  const parked = parkedDetector(lane, registry);
  if (!parked) return "armed";
  if (lastVerdictMs === null || lastVerdictMs === undefined) return "parked";
  if (!Number.isFinite(lastVerdictMs) || lastVerdictMs <= 0) return "parked";
  // The park's OWN window, not the blindness bound it sits inside (#1562). The
  // bound answers "has this stopped concluding", which is a far older verdict than
  // "is this concluding", and using it here made a single accidental verdict read
  // as the arrival of real traffic for the next four days.
  return nowMs - lastVerdictMs < parked.unparkWithinMs ? "unpark" : "parked";
}

/**
 * Which verdict lane watches each gated monitor check (#1941).
 *
 * The lane list above is hand written, so until this table a new fail safe
 * detector was exempt from the watch by default, and roster coverage shipped
 * exactly that way (L96). This table is keyed on what `monitorSetupGates`
 * RETURNS, so `tsc` names a newly gated check with no entry, and
 * scripts/test-detector-verdict-registry.ts enumerates the same keys at runtime
 * and refuses an entry that names an unbound lane or carries no reason.
 *
 * Three kinds of entry, and only the first is coverage:
 *
 *  - `lane`    stamped on a measured verdict and watched against its bound.
 *  - `exempt`  deliberately unwatched, with the reason a lane would be wrong.
 *  - `pending` a lane is wanted and does not exist yet: named, with the issue that
 *              adds it, so the gap reads as a known debt rather than as coverage
 *              (L65). Delete the entry in the change that adds the lane.
 */
export type DetectorVerdictCoverage =
  | { lane: DetectorVerdictLane }
  | { exempt: string }
  | { pending: string; issue: number };

export type MonitorGatedCheck = keyof ReturnType<typeof monitorSetupGates>;

export const GATED_CHECK_VERDICT_COVERAGE: Record<MonitorGatedCheck, DetectorVerdictCoverage> = {
  availabilityTruth: { lane: AVAILABILITY_TRUTH_VERDICT_LANE },
  lowVolume: { lane: LOW_VOLUME_VERDICT_LANE },
  rosterCoverage: { lane: ROSTER_COVERAGE_VERDICT_LANE },
  tierStaffing: { lane: TIER_STAFFING_VERDICT_LANE },
  belowLeadTier: { lane: BELOW_LEAD_TIER_VERDICT_LANE },
  failureRate: { lane: FAILURE_RATE_VERDICT_LANE },
  regalCalls: { lane: REGAL_CALLS_VERDICT_LANE },
  // #1591: armed report only, so going blind silences a page.
  busyDrift: { lane: BUSY_DRIFT_VERDICT_LANE },
  poolFullness: {
    exempt:
      "an info whisper that never pages (#1256): going blind silences a nudge, not a page, " +
      "and the supply page (#1254) it reads from shows the same numbers to anyone looking",
  },
  // #2798: the five below each swallowed a failed read into a status that pages
  // nothing and throws nothing, so neither `monitor_step_failing` nor any lane saw
  // it held. The predicates that decide each stamp are above.
  availabilityScan: { lane: AVAILABILITY_SCAN_VERDICT_LANE },
  calendarWindow: { lane: CALENDAR_WINDOW_VERDICT_LANE },
  offsiteOrigin: { lane: OFFSITE_ORIGIN_VERDICT_LANE },
  awaitingActivation: { lane: AWAITING_ACTIVATION_VERDICT_LANE },
  // One lane for both: they read one RPC on one tick, so its failure is one fault.
  regalCallsQuiet: { lane: REGAL_CALL_FEED_VERDICT_LANE },
  regalCallsUnreadable: { lane: REGAL_CALL_FEED_VERDICT_LANE },
  regalCallOutcomes: { lane: REGAL_CALL_OUTCOMES_VERDICT_LANE },
  offeredNobodyFree: { lane: OFFERED_NOBODY_FREE_VERDICT_LANE },
  bufferBreach: { lane: BUFFER_BREACH_VERDICT_LANE },
  placeholderCalls: {
    exempt:
      "every way it can stop concluding already pages (#4206): an unreadable read is thrown out of its " +
      "step, so `monitor_step_failing:placeholder_calls` pages a sustained one, and its only gate is the " +
      "bucket list, whose own failing read pages as `monitor_step_failing:setup_buckets`",
  },
};
