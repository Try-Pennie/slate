/**
 * Pure health-status decision for the unauthenticated /api/health endpoint
 * (#595, extended to a multi-lane dead-man's switch in #685).
 *
 * PURE: node-native-testable, no imports. The route (health/route.ts) does the DB
 * ping + heartbeat reads, then hands the raw per-lane ages here to decide 200 vs
 * 503.
 *
 * A never-stamped lane (ageMs === null, no heartbeat row yet, e.g. a fresh
 * deploy before that lane's first tick) must NOT fail health, matching
 * isHeartbeatStale's "do not alert on an uninitialized lane" rule.
 */

const MIN = 60_000;

/**
 * Per-lane staleness bounds for the multi-lane dead-man's switch (#685). Each
 * covered cron lane stamps a heartbeat on a successful tick (recordHeartbeat);
 * health flips to 503 when a lane's heartbeat is older than its OWN bound here.
 *
 * Bounds are generous multiples of each lane's cadence so ordinary Cloudflare
 * cron jitter or a single slow tick can't trip a false 503; only a lane that
 * has genuinely stopped does. Cadences come from worker/cron-routes.ts:
 *   every minute : sync, recompute, outbox, selfheal          -> 10 min bound
 *   every 5 min  : complete, watch, monitor, bulk-reassign     -> 20 min bound
 *
 * `bulk-reassign` (#973) belongs here rather than in the Slack-only maps, and was
 * missing entirely until #1123: it stamped a heartbeat that no bounds map read. It
 * is a Worker cron lane doing app-critical work (draining coverage reassignments
 * moves real bookings and their calendar events), which is the line the Slack-only
 * maps draw: the canary is not a Worker lane at all, and the mirror lanes feed
 * analytics rather than the app. Since #3693 each lane runs as its own placed
 * invocation, so a lane goes quiet on its own (a deploy cancelling its run, a run far
 * from the database, its own lock held, its own route erroring) rather than with its
 * co-scheduled siblings, and this bound is what says so for bulk-reassign (#4168).
 *
 * The hourly `agents` lane is intentionally NOT covered: at a 60-min cadence a
 * heartbeat bound is noisy, and a stalled roster sync is already surfaced by its
 * own alert path. It does not stamp a heartbeat at all, so there is nothing here to
 * exempt. Acceptance for #685 scopes coverage to the 1-min and 5-min lanes only.
 */
/**
 * Every lane this page watches, in the order it reads them (#1872).
 *
 * A named tuple rather than the keys of the bounds map, so `LANE_STALE_BOUNDS_MS`
 * and `LANE_NOTES` are both `Record<LaneName, ...>` and tsc requires an entry in
 * each for every lane. A lane could otherwise be added with a bound and no
 * description, and would render on the Health page as a bare identifier, which is
 * the state #1872 exists to remove.
 */
export const LANE_NAMES = [
  "sync",
  "recompute",
  "outbox",
  "selfheal",
  "complete",
  "watch",
  "monitor",
  "bulk-reassign",
  "hydrate-calendars",
  "booking-reminders",
  "reroute-hold-sweep",
  "capacity-history",
  "capacity-fill",
] as const;

export type LaneName = (typeof LANE_NAMES)[number];

export const LANE_STALE_BOUNDS_MS: Record<LaneName, number> = {
  sync: 10 * MIN,
  recompute: 10 * MIN,
  outbox: 10 * MIN,
  selfheal: 10 * MIN,
  complete: 20 * MIN,
  watch: 20 * MIN,
  monitor: 20 * MIN,
  "bulk-reassign": 20 * MIN,
  // #1261: the calendar hydration rotation, every 15 minutes. 45 minutes is three cadences,
  // so ordinary jitter cannot page while a lane that has genuinely stopped does. It needs a
  // bound at all because hydration is LOAD-BEARING once anything filters or prunes the
  // cache by window: a stamp no bound watches looks like monitoring while nothing watches
  // (#1123), and a silently stopped rotation means coverage quietly expiring everywhere.
  "hydrate-calendars": 45 * MIN,
  // #2359, #4298: every enabled stored reminder email, every 5 minutes. 20 minutes is four
  // cadences, matching the other five minute lanes, so ordinary jitter cannot page
  // while a lane that has genuinely stopped does. It needs a bound because nothing
  // else would ever say the reminders had stopped: an empty send count is the
  // NORMAL state on a quiet hour, so silence and a broken read look identical
  // (L98), and the lead who is not reminded never tells anybody.
  "booking-reminders": 20 * MIN,
  // #3248: the expiry sweep for reroute hold blocks, every minute on the self heal
  // lane, stamped only when the sweep itself succeeded. Ten minutes like its lane.
  // It needs its own bound because a sweep failing every tick leaves the self heal
  // stamp fresh while a held advisor's expired time stays off the offer, and a
  // quiet sweep (nothing expired) and a broken one would otherwise look the same.
  "reroute-hold-sweep": 10 * MIN,
  // #3940: Team capacity history, every half hour. 90 minutes is three cadences. It needs a
  // bound because a stopped lane leaves a hole in the history nothing can fill later (past
  // busy time is pruned), and the page would show those days with nobody's room saved.
  "capacity-history": 90 * MIN,
  // #4102: booking pace readings, every half hour. 90 minutes is three cadences. A stopped lane
  // leaves readings missing that nothing can fill later, and the pace (#4103) reads its gap.
  "capacity-fill": 90 * MIN,
};

/**
 * What each lane DOES, and how often it should run (#1872).
 *
 * Nine lane names rendered on the Health page were internal identifiers rather
 * than words: `sync`, `selfheal`, `hydrate-calendars`. And "sync, just now" tells
 * a reader nothing about whether "just now" is good, because the bound is the
 * missing half: `hydrate-calendars` at 14 minutes is healthy on a 45 minute bound
 * while `sync` at 14 minutes is stale on a 10 minute one, and the page drew both
 * the same way.
 *
 * HERE, BESIDE THE BOUNDS, rather than in the component. The cadence and the
 * bound are two halves of one fact, and a second set of descriptions written next
 * to the page would drift from the numbers they describe (L41). The "late after"
 * phrase is DERIVED from `LANE_STALE_BOUNDS_MS` by `laneNote` below, so it cannot
 * disagree with the bound the watchdog actually uses.
 */
export const LANE_NOTES: Record<LaneName, { does: string; cadence: string }> = {
  sync: { does: "pulls each agent's calendar so cached busy time stays true", cadence: "every minute" },
  recompute: { does: "rebuilds the bookable times a lead is offered", cadence: "every minute" },
  outbox: { does: "finishes a booking's side effects: the invite, the webhook, the notice", cadence: "every minute" },
  selfheal: { does: "finds bookings whose side effects never completed and retries them", cadence: "every minute" },
  complete: { does: "marks past bookings finished so they stop counting as upcoming", cadence: "every 5 minutes" },
  watch: { does: "renews the Google subscriptions that tell Slate a calendar changed", cadence: "every 5 minutes" },
  monitor: { does: "runs the health checks that raise the Slack alerts", cadence: "every 5 minutes" },
  "bulk-reassign": { does: "moves the bookings a coverage sweep queued onto their new advisor", cadence: "every 5 minutes" },
  "booking-reminders": { does: "emails each lead its reminder emails", cadence: "every 5 minutes" },
  "hydrate-calendars": { does: "fills in cached busy time for agents whose window is running out", cadence: "every 15 minutes" },
  "reroute-hold-sweep": { does: "puts an advisor's time back on offer once a bucket correction hold expires", cadence: "every minute" },
  "capacity-history": { does: "saves each advisor's unbooked calls as they pass, for Team capacity's past days", cadence: "every 30 minutes" },
  "capacity-fill": { does: "saves each coming day's calls open and how many were booked since the last reading, for its booking pace", cadence: "every 30 minutes" },
};

/**
 * Where each lane runs, and the lock it takes there, or none (#3468).
 *
 * `route` is the cron route the lane's work happens in, which is also the name its
 * fields carry on the dispatcher's `lane timings` line (`laneFieldName`). A sub step
 * lane such as `reroute-hold-sweep` runs inside another lane's route and is timed as
 * that lane. `lock` is the name the route passes to `acquireLock` or `acquireLease`,
 * or null when the lane takes none of its own.
 *
 * Recorded rather than built from the lane name, which the stale lane page used to do:
 * it named `cron_bulk-reassign` (the route takes `cron_bulk_reassign`) and locks for
 * lanes that take none, and a reader who finds no such row reads it as "the lock is
 * fine". `scripts/test-lane-lock-registry.ts` reads each route and holds the two
 * together in both directions.
 */
export const LANE_RUNS: Record<LaneName, { route: string; lock: string | null }> = {
  sync: { route: "/api/cron/sync", lock: "cron_sync" },
  recompute: { route: "/api/cron/recompute", lock: "cron_recompute" },
  outbox: { route: "/api/cron/outbox", lock: "cron_outbox" },
  selfheal: { route: "/api/cron/selfheal", lock: "cron_selfheal" },
  complete: { route: "/api/cron/complete", lock: "cron_complete" },
  watch: { route: "/api/cron/watch", lock: "cron_watch" },
  monitor: { route: "/api/cron/monitor", lock: "cron_monitor" },
  "bulk-reassign": { route: "/api/cron/bulk-reassign", lock: "cron_bulk_reassign" },
  "hydrate-calendars": { route: "/api/cron/hydrate-calendars", lock: "cron_hydrate_calendars" },
  "booking-reminders": { route: "/api/cron/booking-reminders", lock: null },
  "reroute-hold-sweep": { route: "/api/cron/selfheal", lock: null },
  "capacity-history": { route: "/api/cron/capacity-history", lock: "cron_capacity_history" },
  "capacity-fill": { route: "/api/cron/capacity-fill", lock: "cron_capacity_fill" },
};

/** The registry entry for a lane the watchdog names by string, or a route of its own
 *  and no lock for one the registry does not know, so nothing is invented. */
export function laneRun(lane: string): { route: string; lock: string | null } {
  return (LANE_RUNS as Record<string, { route: string; lock: string | null }>)[lane] ?? {
    route: `/api/cron/${lane}`,
    lock: null,
  };
}

/**
 * One lane, as a sentence: what it does, how often, and when it counts as late.
 *
 * The cadence is capitalised on the way in rather than stored capitalised,
 * because it is the start of the second sentence here and could be mid sentence
 * in another reader. Storing it either way makes one of the two wrong.
 */
export function laneNote(lane: LaneName): string {
  const note = LANE_NOTES[lane];
  const minutes = Math.round(LANE_STALE_BOUNDS_MS[lane] / MIN);
  // Both halves are capitalised on the way OUT rather than stored capitalised.
  // Each is the start of a sentence here and could be mid sentence in another
  // reader (an alert, a tooltip, a log line), and storing them either way makes
  // one of the two wrong.
  const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  return `${sentence(note.does)}. ${sentence(note.cadence)}, late after ${minutes} minutes.`;
}

/**
 * What the Cron lanes row covers, and where the rest are watched (#1872).
 *
 * "All 9 lanes ran on time" is literally true and gives a reader no way to know a
 * TENTH exists, so the page looks like it is watching the cron system when it is
 * watching most of it. `worker/cron-routes.ts` also schedules the hourly roster
 * sync, the two time off jobs and the Snowflake export, and their absence here is
 * deliberate and documented above: an hourly cadence makes a heartbeat bound
 * noisy, a stalled roster sync has its own alert path, and the mirror lanes feed
 * analytics rather than the app. That is a reading gap rather than a coverage gap,
 * and it costs one sentence to close.
 *
 * The count is derived, so a tenth watched lane cannot leave this sentence
 * claiming nine.
 *
 * Since #2543 the two time off jobs ARE watched, by `TIME_OFF_STALE_BOUNDS_MS` and
 * the Slack lane watchdog. They stay out of THIS map because it drives the external
 * /api/health 503, and a morning report that did not go out is a missing safety net
 * rather than the site being down. So the sentence says these bounds do not apply
 * to them rather than that a heartbeat would mean nothing, which stopped being true.
 */
export function cronLanesNote(): string {
  return (
    `The ${LANE_NAMES.length} lanes that run every minute or every few minutes, each stamping ` +
    `a heartbeat when a tick succeeds. The hourly roster sync, the two time off jobs and the ` +
    `Snowflake export are not here: they run too seldom for these bounds to mean anything, and ` +
    `each raises its own alert instead.`
  );
}

/**
 * Staleness bound for the external booking-smoke canary (#525), kept SEPARATE
 * from LANE_STALE_BOUNDS_MS on purpose. The canary is a scheduled GitHub Actions
 * workflow, not a Worker cron lane: a stopped canary means the safety net went
 * quiet, NOT that the app is down, so it must never flip the external /api/health
 * 503 (that pages external uptime as if the site were broken). Only the internal
 * lane-watchdog consults this, alerting to Slack.
 *
 * The canary stamps `smoke-canary` on every successful run (the half hourly
 * side-effect-free dry tick and the hourly full pass both stamp). The bound is 3x the
 * frequent cadence so ordinary GitHub scheduling jitter (scheduled runs are often
 * delayed several minutes) can't trip a false alert; only a schedule that has
 * genuinely stopped, or is failing before it can stamp, does.
 *
 * `smoke-canary-full` is tracked SEPARATELY (#982). The dry tick and the full pass
 * used to share the one `smoke-canary` stamp, so the 30-min dry tick kept it fresh
 * and a silently-dropped full run (the only automated proof a booking can
 * actually be created, rescheduled, and cancelled) never went stale and never
 * paged. The full pass now stamps its own heartbeat, judged against a 3h bound:
 * above the hourly cadence (#1493, was 6h with an 8h bound) and past the 90m
 * gap-fill trigger plus its 30m cooldown and a whole run, so the Worker gap-filler
 * normally re-runs the full pass before this backstop pages, and only a full pass
 * that both GitHub AND the gap-filler have failed to complete trips it.
 * `scripts/test-canary-trigger.ts` holds that relation.
 */
export const CANARY_STALE_BOUNDS_MS: Record<string, number> = {
  "smoke-canary": 90 * MIN,
  "smoke-canary-full": 3 * 60 * MIN,
  // The daily cal.com parity sweep (#2031), which is a scheduled workflow like the
  // two above and belongs to the same family for the same reason: a stopped sweep
  // means a comparison went quiet, never that Slate is down, so it must not reach
  // the external /api/health 503.
  //
  // 30 hours, not the 3x cadence the 30 minute canary uses. On a daily schedule
  // GitHub's jitter is minutes and a genuinely missed run is a whole day, so a
  // multiple of the cadence would take two days to notice one.
  //
  // It is a BACKSTOP now rather than the recovery path (#2414). The monitor lane
  // re fires this workflow once the heartbeat passes `PARITY_TRIGGER_STALE_MS`
  // (27h30m: the cadence, plus the worst GitHub lateness this repo has measured,
  // plus the job's own timeout). So the bound is derived from the worst case that
  // re attempt can take rather than from the cadence alone: the threshold, plus one
  // `PARITY_DISPATCH_COOLDOWN_MS` retry of a refused dispatch, plus one full 25
  // minute run, is about 29 hours. 30 clears that by an hour, so this pages only
  // once GitHub AND the gap filler have both failed to complete a sweep.
  //
  // `scripts/test-canary-trigger.ts` asserts that relation with the cadence and the
  // timeout read out of the workflow file, so shortening either number makes the
  // build fail rather than quietly letting the page beat its own remedy.
  "schedule-parity": 30 * 60 * MIN,
  // The weekly router replay (#2263), the only measurement of Slate's ROUTING
  // that exists before cutover. Same family and the same reason: a stopped replay
  // means a comparison went quiet, never that Slate is down.
  //
  // 9 days, not a multiple of the weekly cadence. A week plus two days pages
  // within a couple of days of a run that did not happen, while leaving room for
  // one deliberately re-run week; a 3x bound would take three weeks to notice a
  // schedule that had stopped, by which point the thing it watches has drifted
  // through every roster change in between.
  //
  // A BACKSTOP since #2466, like the parity bound above. The monitor lane re fires
  // the replay once its heartbeat passes `REPLAY_TRIGGER_STALE_MS` (7d4h: the
  // weekly cadence, the worst measured GitHub lateness and the job's 45 minute
  // timeout), and retries a refused dispatch a `REPLAY_DISPATCH_COOLDOWN_MS` (a
  // day) later. Threshold, one retry and one full run come to under 8 days 5
  // hours, so this pages only once GitHub AND the re fire have both failed to
  // conclude a replay. `scripts/test-canary-trigger.ts` asserts that relation.
  "router-replay": 9 * 24 * 60 * MIN,
};

/**
 * How noodge runs its two keyed checks of Slate (#1228): the mirror of
 * `monitors/slate.sql` in Try-Pennie/noodge, whose own verifier pins the same
 * numbers. The bound below is derived from these, so a change on either side that
 * is not made on the other turns the bound into a claim about a monitor that does
 * not exist; `scripts/test-uptime-heartbeat-bounds.ts` pins them here.
 */
export const NOODGE_SLATE_CHECK = {
  /** `interval_min`: a run every 5 minutes. */
  intervalMin: 5,
  /** `alert_after`: noodge alerts on the 2nd consecutive failed run. */
  alertAfter: 2,
  /** `max_attempts`: a failed attempt is retried once inside the run. */
  maxAttempts: 2,
  /** `timeout_ms`: each attempt gives up after 20 seconds. */
  timeoutMs: 20_000,
  /** noodge's cron leases due checks once a minute, so a run can start a minute late. */
  schedulerTickMs: MIN,
} as const;

/**
 * The uptime checks' own dead man's switch (#1228): how long noodge's keyed check
 * of each endpoint may go without reaching Slate before the watchdog pages.
 *
 * Slack only, like the canary family, and for the sharpest version of that reason:
 * these lanes watch the thing that pages about /api/health, so a stale one flipping
 * /api/health would have noodge report its own pause as a Slate outage.
 *
 * THE BOUND IS DERIVED. A stamp means a keyed request reached the endpoint, so the
 * question is the longest gap a RUNNING noodge leaves without saying anything
 * itself. After a stamped run, the next `alertAfter - 1` runs can all fail to reach
 * Slate (a transport blip noodge retries quietly); the run after that either stamps
 * or makes noodge alert, so from there on the silence belongs to noodge's own page.
 * Each run can start one scheduler tick late and last every attempt's timeout:
 *
 *   longest quiet = alertAfter x interval + tick + maxAttempts x timeout
 *                 = 2 x 5m + 1m + 2 x 20s = 11m40s
 *
 * The bound adds one more full interval of slack on top: 16m40s. So a page from here
 * with no alert from noodge means noodge is not checking, and a check that was
 * deleted, paused or stopped firing pages within about seventeen minutes.
 *
 * `neverIsStale` is ON with the grace window, like the retention lanes: a deployment
 * with no UPTIME_HEARTBEAT_KEY, or a check nobody registered, never stamps at all,
 * and invisible for ever is the failure this exists to end.
 *
 * One residual, accepted rather than missed: after an outage longer than the bound,
 * this runs again the moment the Worker does and can page once before noodge's next
 * run stamps, then all-clear minutes later. noodge will already have alerted about
 * the outage itself, so the pair reads as the tail of that incident.
 */
const UPTIME_BOUND_MS =
  NOODGE_SLATE_CHECK.alertAfter * NOODGE_SLATE_CHECK.intervalMin * MIN +
  NOODGE_SLATE_CHECK.schedulerTickMs +
  NOODGE_SLATE_CHECK.maxAttempts * NOODGE_SLATE_CHECK.timeoutMs +
  NOODGE_SLATE_CHECK.intervalMin * MIN;

export const UPTIME_STALE_BOUNDS_MS: Record<string, number> = {
  "uptime:api-health": UPTIME_BOUND_MS,
  "uptime:availability-canary": UPTIME_BOUND_MS,
};

/**
 * Staleness bounds for the Snowflake archival-mirror lanes (#1101), kept SEPARATE
 * from LANE_STALE_BOUNDS_MS on purpose (like the canary). A stopped mirror lane
 * means the analytics warehouse is going stale, or a compliance safety net has gone
 * quiet, NOT that the app is down, so none of these may flip the external
 * /api/health 503 (that would page uptime as if the site were broken). Only the
 * internal lane-watchdog consults this map, and it alerts to Slack.
 *
 * - `snowflake-export` (every 30 min since #4349) is the mirror feed. Bound is 3x
 *   cadence, so ordinary cron jitter or one slow tick can't trip a false alert.
 * - `snowflake-reconcile` and `erasure-audit` (both every 6h, co-scheduled) are the
 *   two checks ON that mirror: reconcile counts Supabase vs Snowflake per table,
 *   and the audit proves an erased booking's PII is really gone from the warehouse.
 *   Both were previously UNWATCHED (#1123). Reconcile stamped a heartbeat that no
 *   bounds map read, and the erasure audit had no stamp at all while two comments
 *   claimed reconcile's switch covered it. An 8h bound (cadence + ~2h of slack,
 *   matching how `smoke-canary-full` is judged against its own 6h cadence) pages
 *   within a couple of hours of one missed or failing run, which is prompt enough
 *   for a 6h compliance check and loose enough that cron jitter is never the cause.
 */
export const MIRROR_STALE_BOUNDS_MS: Record<string, number> = {
  "snowflake-export": 90 * MIN,
  "snowflake-reconcile": 8 * 60 * MIN,
  "erasure-audit": 8 * 60 * MIN,
  // `snowflake-check` (#1144) is the live warehouse self-check, run at the tail of
  // the 6h reconcile lane. It stamps ONLY when the probe comes back healthy, which
  // is why it needs its own bound rather than hiding behind `snowflake-reconcile`:
  // a probe that keeps failing goes stale here and pages even when the thing that
  // is broken is the alerting path itself. Same 8h bound as its two siblings.
  // An unconfigured mirror never stamps, and this map does not page a never-stamped
  // lane, so a non-mirror environment stays quiet.
  "snowflake-check": 8 * 60 * MIN,
};

/**
 * The three retention lanes (#1102). Until now these were watched by nothing at
 * all: no heartbeat, no bounds entry, no alert. A lane that threw returned 500
 * into `log.error` and stopped there, and Cloudflare logs are 7-day retention
 * with no alerting, so the first permanent deletion of customer data in Slate was
 * about to run with no one watching it.
 *
 * They fire daily at 03:05 UTC, so the bound is the cadence plus 4h of slack: one
 * missed or failing run pages, and cron jitter never causes it.
 *
 * These lanes stamp on a SKIP as well as on real work, because "the cron fired"
 * and "the cron did something" are different questions and only the first belongs
 * to a dead-man's switch. The persistent-skip case gets its own alert from inside
 * the lane instead (a not-ready mirror silently stops PII retention).
 */
export const RETENTION_STALE_BOUNDS_MS: Record<string, number> = {
  "prune-routing": 28 * 60 * MIN,
  "prune-webhook-payloads": 28 * 60 * MIN,
  "prune-bookings-pii": 28 * 60 * MIN,
  "prune-busy-blocks": 28 * 60 * MIN,
  // #1180. Same daily cadence and the same reasoning as its siblings: one missed
  // or failing run pages, and cron jitter never causes it.
  "prune-warehouse-pii": 28 * 60 * MIN,
  // #2090. Same daily cadence and the same reasoning as its siblings.
  "prune-regal-calls": 28 * 60 * MIN,
  // #2726. Same daily cadence and the same reasoning as its siblings.
  "prune-booking-alert-state": 28 * 60 * MIN,
};

/**
 * The two daily time off lanes (#2543). Until now neither appeared in any bounds
 * map, so a lane that stopped firing was watched by nothing at all.
 *
 * Slack only, like the mirror and retention families and for the same reason: a
 * morning report that did not go out is a missing safety net, never an app
 * outage, so none of these may flip the external /api/health 503.
 *
 * FOUR stamps for two lanes, because "the cron fired" and "the work happened" are
 * different questions with different remedies (L11). The pair of them is what
 * tells a reader whether to look at the schedule or at the route:
 *
 *   ooo-approvals          the cron reached the route, stamped even on the tick
 *                          the 7am ET gate no-ops, so it means the dispatcher is
 *                          firing and nothing more
 *   ooo-approvals-report   yesterday's approvals were actually reported, or there
 *                          were genuinely none to report. This one is ALSO the
 *                          catch-up watermark: the run reads it to decide how far
 *                          back to reach, so a stale stamp and a widening report
 *                          are the same fact seen twice
 *   ooo-digest             the same, for the 9am ET pending nudge
 *   ooo-digest-nudge       every manager with a pending request was nudged, or the
 *                          queue was genuinely empty
 *
 * `neverIsStale` is ON, as for the retention lanes: a lane that throws on its
 * first run never stamps, and invisible forever is the worse failure for work that
 * only happens once a day. The grace window in `pageWithGraceWindow` is what stops
 * that paging on the deploy that introduces these stamps.
 *
 * THE BOUNDS ARE DERIVED, not chosen. The approvals lane fires daily, so its
 * longest legitimate silence is a day; the pending digest fires Mon to Fri, so its
 * longest legitimate silence is the WEEKEND, about three days (Friday 13:00 UTC to
 * Monday 14:00 UTC across a clock change is 73h for the nudge, 71h for the
 * attempt), and a bound reasoned from "daily plus slack" would page every Sunday
 * for ever. Until #2814 the schedule really ran Sunday to Thursday (Cloudflare
 * counts weekday 1 as Sunday), so the gap it cleared was Thursday to Sunday; the
 * length was the same, which is why 76h did not have to move.
 * `scripts/test-time-off-lane-bounds.ts` re-derives both from the shipped cron
 * expressions and the shipped time gates and fails on a bound that is under the gap
 * or more than 12 hours over it, so neither number can be edited into one that
 * cries wolf or one that notices nothing.
 */
export const TIME_OFF_STALE_BOUNDS_MS: Record<string, number> = {
  "ooo-approvals": 28 * 60 * MIN,
  "ooo-approvals-report": 28 * 60 * MIN,
  "ooo-digest": 76 * 60 * MIN,
  "ooo-digest-nudge": 76 * 60 * MIN,
};

/**
 * How old the newest off platform database dump may be (#3076).
 *
 * `.github/workflows/db-backup.yml` takes a full logical dump once a day, uploads it
 * to R2, and stamps `db-backup` only after the uploaded object has been read back at
 * the size that was written. It is the only copy of the tables the Snowflake mirror
 * does not carry (advisors, pools, hours, settings, time off) that lives outside the
 * Supabase account, so a dump that stopped is the 24 hour RPO in docs/dr-runbook.md
 * quietly becoming an unbounded one.
 *
 * 26 hours: the daily cadence plus two hours for GitHub's scheduled run lateness and
 * the job's own timeout. `scripts/test-db-backup-workflow.ts` reads the cron and the
 * timeout out of the workflow and fails on a bound that one late but successful run
 * would cross.
 *
 * Judged with `neverIsStale` ON and the grace window, for the retention lanes'
 * reason and a sharper one: a dump that has never once landed is a database with no
 * off platform copy at all, and the default leniency would keep that silent for
 * ever. Slack only: a missing backup is a missing safety net, not an outage, so it
 * must not reach the external /api/health 503.
 */
export const BACKUP_STALE_BOUNDS_MS: Record<string, number> = {
  "db-backup": 26 * 60 * MIN,
};

/** The heartbeat the log shipping receipt stamps (#3182). One constant, read by the
 *  route that stamps it and the bound that watches it, so the two cannot drift. */
export const LOG_SHIPPING_LANE = "log-shipping";

/**
 * How long Slate's logs may go unconfirmed in Better Stack (#3182).
 *
 * The tail worker hands Slate a receipt each time Better Stack accepts a cron tick's
 * records, so a healthy pipe stamps this every minute
 * (`src/lib/log-shipping/receipt.ts` has the design). Fifteen minutes is the window
 * the issue asked for: fifteen missed ticks is no blip, and the history lost before
 * anybody looks is a quarter of an hour rather than the week Cloudflare's own copy
 * would quietly age out.
 *
 * Judged with `neverIsStale` ON and the grace window: a tail worker that has never
 * sent a receipt (deployed without the `SLATE` binding, or its secret never put) is
 * the fault itself, not a fresh deploy. Slack only: log history stopping is a
 * missing record, never the site being down, so it must not reach /api/health.
 */
export const LOG_SHIPPING_STALE_BOUNDS_MS: Record<string, number> = {
  [LOG_SHIPPING_LANE]: 15 * MIN,
};

/**
 * The heartbeat the recompute lane stamps once the pool grouping directory holds the
 * grouping it published (#3460). One constant, read by the lane that stamps it and the
 * bound that watches it, so the two cannot drift.
 */
export const POOL_GROUPING_LANE = "pool-grouping";

/**
 * How long the pool grouping may go unpublished (#3460).
 *
 * The every minute recompute lane publishes the grouping it already reads, before its
 * lock, to a reserved instance of the confirm line object, so a server holding no fresh
 * grouping of its own keys its confirm line from it. Every way that can fail falls back
 * to the code's own line, which is the behaviour before #3460, so a publisher that
 * stopped would be invisible: bursts on sibling codes would quietly split across lines
 * again, each electing its own leader (load run 37566700055). Hence a bound (L551, L13).
 *
 * Ten minutes, the recompute lane's own bound, since the publish rides that lane's
 * every tick. `neverIsStale` is ON with the grace window, like the log shipping receipt:
 * a publish that has never once landed is the exact state this exists to notice.
 *
 * Slack only, never the external /api/health 503: confirms still book, they only
 * contend in more lines, so a stopped publish is lost capacity, never the site down.
 */
export const POOL_GROUPING_STALE_BOUNDS_MS: Record<string, number> = {
  [POOL_GROUPING_LANE]: 10 * MIN,
};

/**
 * How long a DETECTOR may go without reaching a measured verdict (#1394).
 *
 * A fifth family, kept apart from the four above because it answers a different
 * question. Those bounds ask whether a cron lane RAN; these ask whether a
 * detector CONCLUDED anything. The availability truth probe ran faithfully every
 * five minutes for its whole life while concluding nothing at all (#1377), which
 * every existing bound here scored as perfect health.
 *
 * Judged with `neverIsStale` ON, like the retention lanes and for a sharper
 * reason: "has never once reached a verdict" is the exact state this feature was
 * written to notice, and the default leniency (never stamped means fresh deploy,
 * stay quiet) would make it structurally unable to see it.
 *
 * Slack only. A blind detector is a missing safety net, not an outage, so none
 * of these may flip the external /api/health 503.
 *
 * The bounds are set by the longest stretch of LEGITIMATE silence each detector
 * has, plus slack:
 *
 *  - `verdict:availability-truth` checks one bucket per 5 minute tick, so a full
 *    pass of roughly 60 buckets takes about 5 hours. 24h is nearly five passes:
 *    long enough that ordinary gaps (a quiet bucket, a bad minute at Google)
 *    cannot trip it, short enough to catch a probe that is simply not working.
 *  - `verdict:booking-failure-rate` needs a floor of booking attempts inside its
 *    rolling window before it will judge at all, and
 *    `verdict:low-booking-volume` only judges while the org is open, by the
 *    stored `business_hours` (Monday to SATURDAY since #1298; this used to say
 *    Mon to Fri). Both are legitimately silent over the closed stretch of a
 *    weekend, and a public holiday Monday stretches that to about 60 hours. 4
 *    days clears both, so a weekend is never the cause.
 *
 *    A flat bound that clears a weekend cannot see ONE open day with no verdict,
 *    so the volume alarm is ALSO judged in open business minutes on the monitor
 *    lane itself (`volume-verdict-gap.ts`, #2049), which pages after one open
 *    hour. This bound stays as the backstop that shares no hours predicate.
 *
 *    The floor and the window themselves are deliberately NOT quoted here. They
 *    live in `failure-rate-thresholds.ts`, fitted to real lead volume, and this
 *    sentence carried the pre #2484 pair for three weeks after they moved: a
 *    restatement is a second copy nothing compares (L63). What sets the bound is
 *    the weekend below the floor, whatever the floor is.
 */
export const VERDICT_STALE_BOUNDS_MS: Record<string, number> = {
  "verdict:availability-truth": 24 * 60 * MIN,
  "verdict:booking-failure-rate": 4 * 24 * 60 * MIN,
  "verdict:low-booking-volume": 4 * 24 * 60 * MIN,
  // The time off protection check (#1467) has no legitimate silence at all: it
  // concludes on every 5 minute tick the database is readable, including ticks
  // where nobody has time off booked, because "nothing approved can be
  // unprotected" is an answer. So the only thing this bound can catch is the read
  // failing over and over, and 6 hours is a long maintenance window rather than a
  // measure of anything the detector does.
  "verdict:ooo-protection": 6 * 60 * MIN,
  // The debt tier staffing alarm (#2505). Like the time off check above, it has
  // NO legitimate silence: it concludes on every 5 minute tick where the roster
  // and the cached slot rows are readable, including ticks where every tier is
  // healthy, because "all five tiers are offering times" is an answer. Six hours
  // is therefore a maintenance window rather than a measure of the cadence, and
  // matching the sibling above keeps two bounds that mean the same thing from
  // being two different numbers nobody can re-derive.
  "verdict:tier-staffing": 6 * 60 * MIN,
  // The served versus confirm check (#3381). It concludes on every 5 minute tick that
  // has any served time to judge and can read it, which is every tick while any bucket
  // offers a time, so this bound is a maintenance window rather than a measure of the
  // cadence, the same six hours as the tier staffing alarm beside it.
  "verdict:offered-nobody-free": 6 * 60 * MIN,
  // The buffer breach check (#3040). It concludes on every 5 minute tick that judges
  // at least one upcoming booking with an assigned advisor, which is every tick while
  // anybody is booked, so the bound is the same six hour maintenance window as the
  // two checks above.
  "verdict:buffer-breach": 6 * 60 * MIN,
  // The Twilio half of the hourly roster sync (#2114). Six missed runs.
  //
  // It is the only thing watching that job at all: the hourly roster sync has no
  // entry in LANE_NAMES, so nothing stamps a heartbeat for it, and
  // `twilio_sync_failures` only fires on a run that HAPPENED and failed. A job
  // that has stopped being dispatched produces neither, and reads exactly like a
  // healthy roster nobody is changing.
  //
  // Six hours rather than two, for the same reason the ooo-protection bound is
  // six: it is a maintenance window, not a measure of the cadence. A scheduled job
  // can be delayed by hours under platform load (L386), and a bound that pages on
  // ordinary jitter is one nobody reads by the second week.
  "verdict:twilio-roster": 6 * 60 * MIN,
  // The dead man's switch itself (#2382). It is one of the monitor lane's own
  // contained steps, so from #1281 until now a watchdog that threw on every tick
  // was caught, logged, and left the lane heartbeat stamped fresh: the switch
  // watching every other lane was dead behind a live heartbeat, and sync,
  // recompute and outbox could all have stopped with nothing saying so (L71).
  //
  // This stamp is the second half of that fix, and it answers a question the
  // step failure page cannot: a watchdog that RAN, did not throw, and could not
  // read the heartbeats judged nothing, which used to render as an empty stale
  // list and therefore as a healthy fleet.
  //
  // Six hours, and it is a maintenance window rather than a measure of the
  // cadence, exactly as for `verdict:ooo-protection` above: the watchdog
  // concludes on every five minute tick the heartbeat table is readable,
  // including ticks where every lane is fine, so the only thing this bound can
  // catch is that read failing over and over.
  //
  // What it cannot catch, stated rather than implied: a total database outage
  // takes the stamp AND the reader out together, so nothing in-Worker sees it.
  // That case belongs to the external uptime check on /api/health (#749).
  "verdict:lane-watchdog": 6 * 60 * MIN,
  // The Regal call detector (#2090). Four days, the same as the two traffic fed
  // checks, and for the same reason: it concludes only when a human agent's call
  // arrives, and the quietest stretch of an ordinary week (Saturday afternoon to
  // Monday morning, when Sunday carries about a fifth of a weekday's calls) is its
  // longest legitimate silence. Watched since Regal was pointed at Slate (#2695).
  "verdict:regal-calls": 4 * 24 * 60 * MIN,
  // The daily proof that the burst counter answers (#2392), and the only member of
  // this family stamped by a GitHub workflow rather than by the monitor lane, which
  // is what makes its bound a different arithmetic from every entry above.
  //
  // 52 hours, and every part of it is derived rather than chosen (L614):
  //
  //   24h    the workflow's own cadence, read off its cron.
  //   x2     so ONE dropped run does not page. GitHub's scheduler drops runs under
  //          load, and on a daily cadence a drop costs the whole day. The canary and
  //          the parity sweep answer that with a gap filler on the monitor lane; this
  //          lane has none (a fourth entry in the #2414 dispatch table is #2466's
  //          question, not this change's), so the bound has to survive a drop or it
  //          pages for a cause nobody can fix, which is how a channel stops being read.
  //   +3h    the worst GitHub scheduling LATENESS this repo has measured, so the run
  //          after a dropped one being merely late is not a second page.
  //   +30m   the job's own `timeout-minutes` (20 since #3615 added the reroute drill to
  //          the same job, 30 since #4180 let the drill wait for the smoke canary), because
  //          the stamp lands at the END of a run rather than at its start.
  //
  // That is 51h30m, and 52 clears it by under an hour. `scripts/test-burst-counter-schedule.ts`
  // re-derives all of it FROM the workflow file, so editing the cron or the timeout
  // without revisiting this fails the build, and it also refuses a bound with days of
  // slack in it: a bound that cannot be wrong is one that notices nothing.
  "verdict:burst-counter": 52 * 60 * MIN,
  // The nightly proof that public booking can still be stopped (#2493). The same
  // arithmetic as the burst counter above and for the same reasons, because it is the
  // same shape of thing: a daily GitHub workflow, stamped at the end of a run, with no
  // gap filler.
  //
  //   24h    the workflow's own cadence, read off its cron.
  //   x2     so ONE dropped run does not page.
  //   +9h30m the worst GitHub scheduling LATENESS measured on this workflow (#3920: 262
  //          to 570 minutes over its last 32 runs; it read 3h when #2493 wrote this).
  //   +10m   the job's own `timeout-minutes`, because the stamp lands at the END of a run.
  //
  // That is 57h40m, and 58 clears it by under an hour. A night the clock check skips
  // (#3920, inside business hours) stamps nothing either, so three skipped nights in a
  // row are past this and page, which is how a schedule that drifted back into the
  // working day is noticed rather than read as a quiet detector.
  // `scripts/test-kill-switch-schedule.ts` re-derives all of it FROM the workflow file,
  // so editing the cron or the timeout without revisiting this fails the build, and it
  // also refuses a bound with days of slack in it.
  "verdict:kill-switch": 58 * 60 * MIN,
  // The daily proof that the shared confirm line answers (#3340). It runs as its own step
  // of the burst counter's workflow, so it shares that workflow's cron and timeout and the
  // same arithmetic: 24h of cadence, doubled so one dropped run does not page, plus the 3h
  // worst lateness measured here, plus the job's 30 minute timeout (#3615, #4180). That is 51h30m,
  // and 52 clears it by under an hour. `scripts/test-confirm-line-schedule.ts` re-derives it FROM
  // the workflow file.
  "verdict:confirm-line": 52 * 60 * MIN,
  // The daily reroute drill (#3615), its own steps of the same workflow, so the same arithmetic:
  // 24h of cadence, doubled so one dropped run does not page, plus the 3h worst lateness measured
  // here, plus the job's 30 minute timeout (raised from 10 to leave the drill room, then to 30 for
  // its wait on the smoke canary, #4180). That is 51h30m, and 52 clears it. `scripts/test-reroute-drill-schedule.ts` re-derives it FROM the
  // workflow file.
  "verdict:reroute-drill": 52 * 60 * MIN,
  // The smoke canary's latency reading (#1700), stamped by the 30 minute canary
  // workflow whenever the check read a real median.
  //
  // 6 hours, which is four times the canary's OWN 90 minute bound, and that ratio is
  // the point. A canary that is not running at all leaves this unstamped too, and it
  // must page under its own name first (`smoke-canary`, which the monitor lane also
  // refires), so this page means one thing: the canary IS running and the latency
  // step specifically has stopped measuring. The longest measured-reading gap in 590
  // runs (2026-09-11 to 2026-09-26) was three hours, and it was exactly that case, a
  // canary whose jobs failed before any step started.
  "verdict:availability-latency": 6 * 60 * MIN,
  // The booking below the lead's Salesforce tier check (#2593). It concludes on
  // every 5 minute tick that compares at least one upcoming booking, and once
  // real leads book there is always one: calls are booked days ahead, so Friday
  // night still holds Monday's. Its only legitimate silence is a roster with no
  // upcoming real booking at all, which is the dark roster before cutover and is
  // what its park is for. A day is a maintenance window over a Salesforce outage,
  // not a measure of the cadence.
  "verdict:below-lead-tier": 24 * 60 * MIN,
  // The cross system double booking check (#2933). It runs once an hour, on the
  // monitor tick in the first five minutes of it, and concludes whenever both reads
  // succeed and Slate holds at least one upcoming real booking, which during the
  // split is every hour (calls are booked days ahead). So a lapse here is six hourly
  // runs in a row that could not read cal.com or Slate, or six dropped ticks, and
  // either means a double booking made in that time went unseen. Retired cal.com
  // stamps it too, so cutover does not turn it into a standing page.
  "verdict:cross-system-bookings": 6 * 60 * MIN,
  // The roster coverage alarm (#1941). It runs on every 5 minute monitor tick
  // with no time window of its own (not business hours, not traffic), and it
  // concludes whenever the week and the roster are readable, including a week
  // with no gap at all, because "every advertised hour is covered" is an answer.
  // So its longest legitimate silence is zero ticks, and the bound is purely a
  // maintenance window over a failed read. That is the same arithmetic as the
  // time off protection and tier staffing checks above, so it takes their six
  // hours rather than the truth probe's day: the day there is five passes of a
  // bucket rotation this check does not have.
  "verdict:roster-coverage": 6 * 60 * MIN,
  // The five below (#2798) are the gated checks the #1941 registry found
  // swallowing a failed read. Every one runs on every 5 minute monitor tick and
  // none has a time window, a traffic floor or a sample size of its own, so each
  // concludes on every tick its read works, and its longest legitimate silence is
  // a handful of ticks, not hours. Each bound is therefore the same six hour
  // maintenance window as the roster coverage, time off protection and tier
  // staffing checks above, for the same reason and so that bounds meaning the
  // same thing stay one number. Per check, what could otherwise be a legitimate
  // silence and why it is not one:
  //
  // The availability scan concludes on a tick that saw every bucket with no dead
  // end, or that verified at least one dead end. A scan cut short by its deadline
  // is the occasional busy tick, not a state that lasts; a run of them for six
  // hours is the scan being blind, which is what this is for.
  "verdict:availability-scan": 6 * 60 * MIN,
  // The calendar window check concludes whenever the calendar rows read and at
  // least one calendar is past its first run, which on a live roster is always.
  "verdict:calendar-window": 6 * 60 * MIN,
  // The off site origin check concludes on every tick the bookings read works,
  // including ticks with no recent booking at all, so it needs no traffic.
  "verdict:offsite-origin": 6 * 60 * MIN,
  // The auth sign in settings check (#3082) reads the hosted /auth/v1/settings on every
  // 5 minute tick and needs no traffic: Google only and open are both answers. So, like
  // the checks above, it has no legitimate silence, and six hours is a maintenance
  // window (about seventy failed reads in a row) rather than a measure of the cadence.
  "verdict:auth-sign-in": 6 * 60 * MIN,
  // #4379: the unexpected sign in check reads once an hour and stamps whenever either
  // half measured; the accounts half measures on every hourly run the listing and the
  // roster read, so a quiet week of sign ins alone never ages it. Three days rather than
  // its cadence, so a weekend of failed reads is not a page but a broken detector is.
  "verdict:auth-unexpected-sign-in": 3 * 24 * 60 * MIN,
  // Waiting to become bookable concludes on every tick the roster reads, and an
  // empty queue is its ordinary answer.
  "verdict:awaiting-activation": 6 * 60 * MIN,
  // The stranded hire check concludes on every tick the roster reads, and nobody
  // stranded is its ordinary answer, so six hours of silence is six hours blind.
  "verdict:stranded-hires": 6 * 60 * MIN,
  // The audit chain walk (#3090) concludes on every tick the trail reads, whether
  // part way through a walk or at its end, so six hours of silence is six hours in
  // which nobody would know the audit log had been changed.
  "verdict:audit-chain": 6 * 60 * MIN,
  // The Regal feed pair concludes whenever the reason count RPC answers for both,
  // and a quiet day is itself a verdict, so a weekend with no calls does not make
  // it silent the way it makes the Regal call detector silent. The one real gap
  // is an org with no open day in two weeks, which the quiet check cannot judge.
  "verdict:regal-call-feed": 6 * 60 * MIN,
  // The call outcome ratio (#2944) judges only a two hour window holding enough
  // completed calls, so it is traffic fed like the Regal call detector and its
  // longest legitimate silence is the same weekend: four days, the same bound.
  "verdict:regal-call-outcomes": 4 * 24 * 60 * MIN,
  // The daily advisor photo refresh (#3027). Derived from its two crons
  // (worker/cron-routes.ts): it runs at 04:17 UTC and, only when that run reached
  // no verdict, again at 10:17. Its longest LEGITIMATE gap is therefore a day
  // whose verdict came at 04:17 followed by one whose verdict came at the 10:17
  // retry, 30 hours, and two hours of cron lateness on top makes 32. A whole day
  // with no verdict at either slot passes the bound and pages, which is the point.
  "verdict:advisor-photos": 32 * 60 * MIN,
  // The daily busy minute check (#3124). Derived from its two crons the same way: it
  // runs at 05:41 UTC and, only when that run reached no verdict, again at 09:41. Its
  // longest LEGITIMATE gap is a verdict at 05:41 followed by the next day's at 09:41,
  // 28 hours, and two hours of cron lateness on top makes 30. A whole day with no
  // verdict at either slot passes the bound and pages, as does a schedule that stopped
  // firing, since this stamp is the lane's only heartbeat. Kept out of
  // LANE_STALE_BOUNDS_MS on purpose: that map drives the external /api/health 503, and
  // a capacity check that did not run is not the site being down.
  "verdict:busy-minutes": 30 * 60 * MIN,
  // The busy drift sampler (#1591) concludes on every 5 minute tick whose live and
  // cached reads both work for at least one agent: no time window, no traffic
  // floor, and a clean sample is an answer. So, like the calendar window check it
  // sits beside, its longest legitimate silence is a handful of ticks, and six
  // hours is the same maintenance window over a failed read.
  "verdict:busy-drift": 6 * 60 * MIN,
  // The hourly cron CPU check (#3141), stamped on every hour whose analytics read measured a
  // day, so its longest legitimate silence is one hour plus a late tick. Six hours is the same
  // maintenance window as its siblings above, over an analytics API having a bad afternoon.
  // While CF_ANALYTICS_TOKEN is unset it cannot conclude by construction, and the watchdog
  // does not call it blind (`unconfiguredDetector`, verdict-freshness.ts).
  "verdict:cron-budget": 6 * 60 * MIN,
};

/**
 * The epoch-ms a heartbeat reader stores for a stamp that EXISTS but cannot be
 * parsed (#1169). Epoch 0 is never a real heartbeat, and it is chosen so the
 * lane fails closed: infinitely old reads as stale and pages, where a null would
 * have read as "never stamped" and stayed quiet forever.
 *
 * Defined once, here, next to the code that interprets it. The readers import it
 * rather than writing a bare `0`, so the sentinel and its meaning cannot drift.
 */
export const UNREADABLE_STAMP_MS = 0;

/** True when a stamp is the unreadable sentinel rather than a real heartbeat. */
export function isUnreadableStamp(ms: number | null | undefined): boolean {
  return ms === UNREADABLE_STAMP_MS;
}

export interface StaleLane {
  lane: string;
  /** How long this lane has been quiet (ms). Meaningless when `unreadable`. */
  ageMs: number;
  /** The bound it blew through. */
  maxStaleMs: number;
  /**
   * The stored stamp could not be READ, so this lane's `ageMs` is arithmetic on
   * the epoch-0 sentinel, not a measured age (#1172). The verdict (stale) is
   * still right; the number is not, and copy must say the record is unreadable
   * rather than quote roughly 29.8 million minutes to someone woken at 3am.
   */
  unreadable: boolean;
}

/**
 * What one run of the lane watchdog concluded (#2382).
 *
 * It used to return the stale list alone, so an empty array meant two opposite
 * things: every lane is healthy, and the heartbeat read failed so nothing was
 * looked at (L215). The caller could not tell them apart, which is precisely the
 * state the dead man's switch exists to notice about OTHER lanes and could not
 * notice about itself.
 */
export interface LaneWatchdogOutcome {
  /**
   * The heartbeats were read, so `stale` is a measurement rather than a silence.
   * False means nothing was judged this run and nothing downstream may treat the
   * empty list as an all clear.
   */
  judged: boolean;
  stale: StaleLane[];
}

/**
 * The value the step runner hands back when the watchdog step THREW (#2382).
 *
 * Named rather than written inline at the call site, so the fallback and the
 * predicate that reads it cannot drift: a fallback of `{ judged: true }` would
 * stamp a verdict for a run that never happened, which is the whole fault.
 */
export const LANE_WATCHDOG_UNJUDGED: LaneWatchdogOutcome = { judged: false, stale: [] };

/**
 * Every covered lane that has gone quiet, worst offender first (#803).
 *
 * A cron invocation killed mid-run (`exceededCpu`) CANNOT report its own death,
 * so absence is the only in-band signal: the lanes that had not finished simply
 * never stamp. That is what this detects, and it is cause-agnostic: a CPU kill,
 * a crash, a stuck lock and a bad deploy all surface the same way.
 *
 * Judges each lane against its OWN cadence bound (a 5-min lane quiet for 12 min
 * is fine; a 1-min lane quiet for 12 min is not), and by default never alarms on
 * a lane that has never stamped: that is a fresh deploy before its first tick,
 * not a death. Alerting there would page on every deploy and train people to
 * ignore it. Pass `neverIsStale` to opt a bounds map out of that leniency, which
 * the daily retention lanes do (#1102): a lane that throws on its first run never
 * stamps, and for a lane whose job is destroying data, invisible-forever is worse
 * than a noisy deploy.
 *
 * PURE, so it is node-testable (scripts/test-stale-lanes.ts). Where
 * computeHealthStatus reports only the single worst lane (it drives one 200/503),
 * an alert wants EVERY quiet lane, since one cause (a deploy cancelling a tick, a
 * Cloudflare incident) can take out several at once.
 */
export function findStaleLanes(
  lastRanAtMsByLane: Record<string, number | null | undefined>,
  nowMs: number,
  bounds: Record<string, number> = LANE_STALE_BOUNDS_MS,
  /**
   * Treat a lane that has NEVER stamped as stale rather than skipping it (#1102).
   *
   * Off by default, because for a fresh deploy before its first tick a "never
   * stamped" lane is normal and alerting would page on every deploy. But it hides
   * a real failure mode: a lane that throws on its very first run never stamps,
   * so it stays invisible forever. That is tolerable for a lane firing every
   * minute (it stamps within a minute or it is genuinely broken and other signals
   * fire) and NOT tolerable for a daily lane whose whole job is destroying data.
   */
  neverIsStale = false,
): StaleLane[] {
  const stale: StaleLane[] = [];
  for (const [lane, maxStaleMs] of Object.entries(bounds)) {
    const lastRanAtMs = lastRanAtMsByLane[lane];
    if (lastRanAtMs === null || lastRanAtMs === undefined) {
      // Never stamped is a THIRD state, distinct from both a real age and an
      // unreadable record, and it has its own copy.
      if (neverIsStale) stale.push({ lane, ageMs: Infinity, maxStaleMs, unreadable: false });
      continue;
    }
    const ageMs = nowMs - lastRanAtMs;
    if (ageMs > maxStaleMs) {
      stale.push({ lane, ageMs, maxStaleMs, unreadable: isUnreadableStamp(lastRanAtMs) });
    }
  }
  // Most-overdue first, so the alert leads with the worst offender.
  return stale.sort((a, b) => b.ageMs - b.maxStaleMs - (a.ageMs - a.maxStaleMs));
}

/** How close together lanes must have stopped to have stopped "together". */
export const STOPPED_TOGETHER_MS = 60_000;

/**
 * Whether several quiet lanes stopped within a minute of each other (2026-10-26).
 *
 * That evening five every minute lanes stamped their last run inside one second and
 * the five minute lanes kept going: the shared schedule had stopped firing, which no
 * single lane's failure produces. Said on the page only because it is measured here,
 * from the stamps themselves. An unreadable stamp cannot be placed in time, so a list
 * holding one is never judged together.
 */
export function stoppedTogether(stale: StaleLane[]): boolean {
  if (stale.length < 2) return false;
  if (stale.some((l) => l.unreadable || !Number.isFinite(l.ageMs))) return false;
  const ages = stale.map((l) => l.ageMs);
  return Math.max(...ages) - Math.min(...ages) <= STOPPED_TOGETHER_MS;
}

/**
 * The one clause every stale-lane alert uses to say how it knows (#1172).
 *
 * Mid-incident the reader needs the fact the check actually established. When
 * the stored stamp cannot be read, that fact is "the last-run record is
 * unreadable", NOT "quiet for 29,800,000 minutes", which is arithmetic on the
 * epoch-0 sentinel and reads as a broken alert rather than a broken lane (L11: a
 * message may claim only what its check measured).
 *
 * One implementation, because four copy paths render this and they were four
 * separate template strings a change would have to find all of.
 */
export function laneQuietClause(opts: {
  ageMs: number;
  boundMin: number;
  unreadable: boolean;
  /** "run" for a cron lane, "completed" for the daily retention lanes. */
  verb?: "run" | "completed";
}): string {
  const verb = opts.verb ?? "run";
  if (opts.unreadable) {
    return (
      `has a last-${verb === "completed" ? "completion" : "run"} record that cannot be read, ` +
      `so it is being treated as stale (bound ${opts.boundMin}m)`
    );
  }
  return `has not ${verb} for ${Math.round(opts.ageMs / 60_000)} minutes (bound ${opts.boundMin}m)`;
}

/**
 * A duration in the largest unit that still reads honestly (#1394).
 *
 * `laneQuietClause` quotes minutes, which is right for lanes whose bounds are
 * 10 to 28 minutes wide. The detector verdict bounds are 24 hours and 4 days, and
 * "has not reached a verdict for 5,760 minutes (bound 5,760m)" is arithmetic
 * shown to somebody reading a phone. Rounds to the unit, so it is a description
 * rather than a measurement; the exact figure belongs in the logs.
 */
export function describeGap(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // Days only past 48h: rounding 30 hours to "1 day" would hide most of a gap
  // that is already past a 24h bound, and the point of the number is the size.
  if (ms >= 48 * 60 * MIN) return unit(Math.round(ms / (24 * 60 * MIN)), "day");
  if (ms >= 60 * MIN) return unit(Math.round(ms / (60 * MIN)), "hour");
  return unit(Math.max(1, Math.round(ms / MIN)), "minute");
}

export type LaneHealthState = "ok" | "stale" | "never";

export interface LaneHealthRow {
  lane: string;
  /** Age (ms) since this lane last stamped, or null if it has never stamped. */
  ageMs: number | null;
  /** ok = stamped within its bound; stale = overdue; never = no heartbeat yet. */
  state: LaneHealthState;
  /** The lane's own staleness bound (ms). */
  maxStaleMs: number;
}

/**
 * Per-lane health rows for the in-app admin strip (#288), in a fixed canonical
 * order (bounds order) so the operator learns each lane's position. Reuses the
 * SAME bounds as the dead-man's switch (findStaleLanes / computeHealthStatus), so
 * the admin view and the pager can never disagree about what "stale" means. A
 * heartbeat is stamped only on a SUCCESSFUL tick, so `state` is the in-app
 * outcome: ok = ran fine recently, stale = wedged/erroring/not firing, never = no
 * tick since deploy (benign, matches the watchdog's "don't alarm on uninitialized").
 * PURE, so it is node-testable.
 */
export function classifyLaneHealth(
  lastRanAtMsByLane: Record<string, number | null | undefined>,
  nowMs: number,
  bounds: Record<string, number> = LANE_STALE_BOUNDS_MS,
): LaneHealthRow[] {
  return Object.entries(bounds).map(([lane, maxStaleMs]) => {
    const lastRanAtMs = lastRanAtMsByLane[lane];
    if (lastRanAtMs === null || lastRanAtMs === undefined) {
      return { lane, ageMs: null, state: "never", maxStaleMs };
    }
    const ageMs = nowMs - lastRanAtMs;
    return { lane, ageMs, state: ageMs > maxStaleMs ? "stale" : "ok", maxStaleMs };
  });
}

export interface LaneObservation {
  lane: string;
  /** Age (ms) since this lane last stamped, or null if it has never stamped. */
  ageMs: number | null;
  /** This lane is stale (unhealthy) when ageMs > maxStaleMs (strict >). */
  maxStaleMs: number;
  /**
   * This lane's stored stamp could not be READ (#1172), so `ageMs` is arithmetic
   * on the epoch-0 sentinel rather than a measured age. The lane is still
   * unhealthy; the endpoint just must not publish the number as if it meant
   * something.
   */
  stampUnreadable?: boolean;
}

export interface HealthInput {
  /** Did the cheap DB liveness query succeed? */
  dbOk: boolean;
  /** One entry per covered lane, with its own staleness bound. */
  lanes: LaneObservation[];
}

export type HealthReason = "ok" | "db_unreachable" | "heartbeat_stale";

export interface HealthResult {
  healthy: boolean;
  httpStatus: 200 | 503;
  reason: HealthReason;
  /** The offending lane when reason === "heartbeat_stale", else null. */
  staleLane: string | null;
  /**
   * That lane's age (ms) when reason === "heartbeat_stale", else null. Also null
   * when the stamp could not be read: no age was measured, so none is reported
   * (#1172). Read it together with `staleStampUnreadable`.
   */
  staleAgeMs: number | null;
  /** The offending lane's stored stamp could not be read (#1172). */
  staleStampUnreadable: boolean;
}

export function computeHealthStatus(input: HealthInput): HealthResult {
  if (!input.dbOk) {
    return {
      healthy: false,
      httpStatus: 503,
      reason: "db_unreachable",
      staleLane: null,
      staleAgeMs: null,
      staleStampUnreadable: false,
    };
  }

  // A lane is stale when it has stamped at least once (ageMs !== null) AND its
  // age exceeds its own bound (strict >). Never-stamped lanes don't alarm. When
  // several lanes are stale, report the one MOST over its bound: with
  // heterogeneous bounds that is the most-broken lane, not merely the oldest.
  let worst: { lane: string; ageMs: number; over: number; unreadable: boolean } | null = null;
  for (const l of input.lanes) {
    if (l.ageMs === null) continue;
    const over = l.ageMs - l.maxStaleMs;
    if (over > 0 && (worst === null || over > worst.over)) {
      worst = { lane: l.lane, ageMs: l.ageMs, over, unreadable: l.stampUnreadable === true };
    }
  }

  if (worst) {
    return {
      healthy: false,
      httpStatus: 503,
      reason: "heartbeat_stale",
      staleLane: worst.lane,
      // #1172: an unreadable stamp measured no age, so the body reports none
      // rather than publishing arithmetic on the epoch-0 sentinel as a duration.
      staleAgeMs: worst.unreadable ? null : worst.ageMs,
      staleStampUnreadable: worst.unreadable,
    };
  }

  return {
    healthy: true,
    httpStatus: 200,
    reason: "ok",
    staleLane: null,
    staleAgeMs: null,
    staleStampUnreadable: false,
  };
}

/**
 * Retention alert copy (#1102). These lanes destroy customer data, so the message
 * says what stopped in terms of consequence, not just which cron is quiet. The
 * never-ran case gets its own wording, because "quiet for Infinity minutes" is
 * useless and the cause is different (it has failed every run since deploy, or it
 * was never scheduled).
 */
export function retentionAlertText(
  lane: string,
  ageMs: number,
  boundMin: number,
  unreadable = false,
): string {
  const what =
    lane === "prune-bookings-pii"
      ? "consumer contact data past the 24 month window is not being redacted, and delivered outbox rows (which can carry the same PII) are not being pruned"
      : lane === "prune-webhook-payloads"
        ? "webhook payloads past the 90 day window are keeping full attendee PII"
        : "routing decisions past the 12 month window are not being pruned";
  if (!Number.isFinite(ageMs)) {
    return `The ${lane} retention lane has NEVER completed a run, so ${what}. It has either failed every run since it was deployed or is not being scheduled. Check the Worker logs for tag=${lane} and the cron_${lane.replace(/-/g, "_")} lock.`;
  }
  return `The ${lane} retention lane ${laneQuietClause({ ageMs, boundMin, unreadable, verb: "completed" })}, so ${what}. Check the Worker logs for tag=${lane}.`;
}

/**
 * What to do about a lane that has NEVER stamped, under a `neverIsStale` bounds map.
 *
 * Why this exists. Turning `neverIsStale` on for the daily retention lanes (#1102)
 * paged all three the moment the heartbeat code deployed: those lanes run at 03:05
 * UTC, so between shipping the code and their first scheduled run they had
 * legitimately never stamped, and the alert claimed they had "failed every run or
 * are not being scheduled". Both false. That is exactly the cry-wolf failure the
 * default leniency prevents, and L36's rule that an alert needs a window longer
 * than the thing it measures.
 *
 * So strict mode gets its own window, anchored on when we FIRST noticed the lane
 * missing rather than on a deploy time we do not record:
 *
 *   record-first-sighting  never seen missing before: remember it, say nothing
 *   wait                   missing, but for less than its own bound
 *   page                   still missing after a full bound has elapsed
 *
 * A newly deployed daily lane therefore has its whole bound (cadence plus slack) to
 * produce a first stamp, and a lane that genuinely never runs still pages, just one
 * bound later than before. PURE, so it is node-testable.
 */
export type NeverStampedVerdict = "record-first-sighting" | "wait" | "page";

export function neverStampedVerdict(
  firstSeenMissingMs: number | null,
  nowMs: number,
  boundMs: number,
): NeverStampedVerdict {
  if (firstSeenMissingMs === null) return "record-first-sighting";
  // Strict `>`, matching findStaleLanes: exactly at the bound is not yet stale.
  return nowMs - firstSeenMissingMs > boundMs ? "page" : "wait";
}
