import { readAllHeartbeatMs } from "@/lib/monitor/heartbeat";
import { readCloudflareCronStatus } from "@/lib/monitor/cloudflare-status";
import {
  backupAlertText,
  backupRecoveryText,
  coreLanesAlertText,
  coreLanesRecoveryText,
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
  findStaleLanes,
  BACKUP_STALE_BOUNDS_MS,
  LANE_STALE_BOUNDS_MS,
  CANARY_STALE_BOUNDS_MS,
  LOG_SHIPPING_STALE_BOUNDS_MS,
  MIRROR_STALE_BOUNDS_MS,
  POOL_GROUPING_STALE_BOUNDS_MS,
  RETENTION_STALE_BOUNDS_MS,
  TIME_OFF_STALE_BOUNDS_MS,
  UPTIME_STALE_BOUNDS_MS,
  VERDICT_STALE_BOUNDS_MS,
  retentionAlertText,
  neverStampedVerdict,
  LANE_WATCHDOG_UNJUDGED,
  type LaneWatchdogOutcome,
  type StaleLane,
} from "@/lib/monitor/health";
import { detectorParkState, parkedDetector, unconfiguredDetector } from "@/lib/monitor/verdict-freshness";
import {
  sendThrottledAlert,
  sendThrottledInfo,
  resolveAlert,
  existingAlertStateKeys,
  firingKey,
} from "@/lib/notify/dispatch";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { CALCOM_HEARTBEAT_LANES, loadCalcomRetiredCached, withoutRetiredCalcomLanes } from "@/lib/calcom/retirement";
import { parseStampMs } from "@/lib/date/stamp";
import { CONDITION_REPEAT_MS } from "@/lib/notify/repeat-policy";
import {
  MINUTE_LANE_PATHS,
  TRIGGER_READING_WINDOW_MS,
  minuteTriggerReading,
  readRecentLaneClaims,
  type LaneClaimQuery,
  type MinuteTriggerReading,
} from "@/lib/monitor/minute-lane-claims";
import { laneFieldName } from "@/lib/monitor/lane-timing";

/** The heartbeat lanes that run on the every minute trigger: its routes, plus the reroute
 *  hold sweep, which runs inside selfheal and stamps its own heartbeat. */
const MINUTE_TRIGGER_LANES: ReadonlySet<string> = new Set([
  ...MINUTE_LANE_PATHS.map((p) => laneFieldName(p)),
  "reroute-hold-sweep",
]);

/**
 * Whether Cloudflare is delivering the every minute trigger, for the lanes page
 * (2026-10-29). Read only when a quiet lane is on that trigger, like the status page, so a
 * healthy tick costs nothing. A failed read is `unknown`, which claims nothing either way:
 * the page then says what it said before this existed.
 */
async function readMinuteTrigger(stale: StaleLane[], now: number): Promise<MinuteTriggerReading> {
  if (!stale.some((l) => MINUTE_TRIGGER_LANES.has(l.lane))) return { kind: "unknown" };
  try {
    const { rows, truncated } = await readRecentLaneClaims(
      supabaseAdmin().from("lane_runs") as unknown as LaneClaimQuery,
      new Date(now - TRIGGER_READING_WINDOW_MS).toISOString(),
    );
    return minuteTriggerReading(rows, now, { truncated });
  } catch (err) {
    log.error("lane-watchdog", { msg: "lane_runs could not be read, so the page says nothing about the minute trigger" }, err);
    return { kind: "unknown" };
  }
}

/** Per lane, so one dead lane can't throttle away the first alert for another. */
const staleLaneAlertKey = (lane: string) => `cron_lane_stale:${lane}`;

/**
 * The ONE key for every quiet Worker cron lane (2026-10-26). Those lanes share a
 * Worker and a schedule, so they stop together, and a key per lane posted one cause
 * as five pages. The other families keep a key per lane: each is its own system.
 */
export const CORE_LANES_ALERT_KEY = "cron_lanes_stale";

/**
 * A dead lane stays dead, so it is said again once a day while unchanged (#3801),
 * not hourly. Every stale lane page names its lanes as its subjects, so the
 * "has not run for N minutes" in the copy, which grows on every tick, can never read
 * as a change; a lane newly going quiet is a new subject, or its own key, and posts at once.
 */
const STALE_LANE_COOLDOWN_MS = CONDITION_REPEAT_MS;

/**
 * A blind detector (#1394) re-pages DAILY, not hourly.
 *
 * It stays blind until a person changes something, and before cutover that can
 * legitimately be days: the availability truth probe cannot conclude while the
 * roster is dark (#1272), and that is a true statement about a missing safety
 * net rather than a fault to fix this morning. An hourly repeat of a condition
 * nobody can clear today is how an alert trains people to ignore it (L36).
 */
const BLIND_DETECTOR_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * A quiet DAILY lane re-pages once a day, not hourly (#2543, #3076, #3801).
 *
 * The time off lanes and the database dump run once a day, so the proof that a fix
 * worked is the next day's run: there is nothing a reader can do that would clear
 * this inside an hour, and repeating the same page twenty four times before anything
 * could change is how an alert trains people to ignore it (L36). It was half the
 * cadence, to reach a morning and an evening reader, until #3801 made a day the
 * repeat for every unchanged condition.
 */
const DAILY_LANE_COOLDOWN_MS = CONDITION_REPEAT_MS;

/**
 * How often the parked detectors say they are parked (#1561).
 *
 * Weekly, deliberately. This is a whisper about a safety net that is off ON
 * PURPOSE, so it must never read as an incident, and the only useful response is
 * to ask whether the reason still holds. Daily would be the noise the park was
 * created to stop; never would be the invisibility #1394 exists to catch.
 */
const PARKED_DETECTOR_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

/**
 * A parked detector that has started concluding stays that way until somebody
 * edits the registry, so this repeats daily rather than every minute.
 */
const UNPARK_DETECTOR_COOLDOWN_MS = 24 * 60 * 60_000;

/** Per detector, so one lane's un-park page cannot throttle away another's. */
const unparkAlertKey = (lane: string) => `detector_unpark:${lane}`;

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * The cron dead-man's switch (#803): alert on every lane that has gone quiet.
 *
 * Before the #760 CPU fix, roughly 400 every-minute invocations were killed by
 * the CPU ceiling. Whichever lanes had not finished simply did not run, and
 * nobody noticed for days; it was found by accident. The lanes are idempotent
 * and self-heal on the next tick, so the impact was low, but the SILENCE is the
 * real defect, and the risk returns as the roster grows toward 200 agents.
 *
 * Detection is by ABSENCE, deliberately. A killed invocation cannot report its
 * own death (it is killed), so the only in-band signal is a lane that stopped
 * stamping. That also makes this cause-agnostic: a CPU kill, a crash, a stuck
 * lock and a bad deploy all surface identically. The alternative, querying
 * Cloudflare's observability API for non-`ok` outcomes, would need a new API
 * token in the Worker and would rest on the very query semantics that have twice
 * produced a confident wrong answer here (#708, #801). A zero from a subtly
 * wrong query reads exactly like "no kills".
 *
 * Called from the sync lane (every minute) AND the monitor lane (every 5 min) so
 * the two watch each other: whichever survives an invocation reports the other.
 * The per-lane cooldown dedupes the overlap. If BOTH die, nothing in-Worker can
 * see it, which is what the external uptime check on /api/health is for (#749).
 *
 * Never throws. It runs inside a cron lane, and a watchdog that takes down the
 * sync tick would be worse than the silence it replaces.
 */
export async function alertOnStaleLanes(): Promise<LaneWatchdogOutcome> {
  let heartbeats: Record<string, number | null>;
  try {
    heartbeats = await readAllHeartbeatMs();
  } catch (err) {
    // A failed read is NOT evidence that every lane is fine, and it is not
    // evidence they are all dead either. Say so, and alarm on nothing.
    //
    // #2382: it also says JUDGED: FALSE, which used to be missing. This returned
    // a bare empty list, and an empty list is exactly what a healthy fleet
    // returns, so the caller could not tell "every lane is stamping" from
    // "nothing was looked at" (L215). The monitor lane now hangs the
    // `verdict:lane-watchdog` stamp off this flag, so a watchdog that keeps
    // failing to read goes stale rather than reading as a run of clean ticks.
    log.error(
      "lane-watchdog",
      { msg: "heartbeat read failed, lane staleness unknown this tick" },
      err,
    );
    return LANE_WATCHDOG_UNJUDGED;
  }
  const now = Date.now();
  // #2875: once cal.com is marked retired its two comparison lanes stop stamping
  // by construction, so they leave the canary family rather than paging "went
  // quiet" every cooldown about a system nobody books through. A read that failed
  // or threw keeps them watched: silencing a live lane on a failed read would be a
  // detector nobody can see is off, while the opposite mistake costs one page.
  let calcomRetired: boolean | null;
  try {
    calcomRetired = await loadCalcomRetiredCached(now);
  } catch (err) {
    log.error("lane-watchdog", { msg: "cal.com retired read threw; its lanes stay watched" }, err instanceof Error ? err : undefined);
    calcomRetired = null;
  }
  const canaryBounds = withoutRetiredCalcomLanes(CANARY_STALE_BOUNDS_MS, calcomRetired);
  const stale = findStaleLanes(heartbeats, now);
  // The external booking-smoke canary (#525) is judged against its OWN bound and
  // alerts with its OWN copy: it is a scheduled GitHub Actions workflow, not a
  // Worker cron lane, so a CPU-kill message would be wrong and it must never touch
  // the external /api/health signal.
  const canaryStale = findStaleLanes(heartbeats, now, canaryBounds);
  // The Snowflake mirror export lane (#1101) is judged against its OWN bound and,
  // like the canary, alerts to Slack only: a stale mirror means the analytics
  // warehouse is going stale, not that the app is down, so it must never touch
  // the external /api/health signal.
  const mirrorStale = findStaleLanes(heartbeats, now, MIRROR_STALE_BOUNDS_MS);
  // The three daily retention lanes (#1102), judged against their own 28h bound.
  // `neverIsStale` is ON for these: a lane that throws on its first run never
  // stamps, and these lanes destroy customer data, so silent-forever is the worse
  // failure. Slack only, like the mirror: stalled retention is a compliance and
  // storage problem, not an app outage, so it must not touch /api/health.
  const retentionStale = findStaleLanes(heartbeats, now, RETENTION_STALE_BOUNDS_MS, true);
  // The two daily time off lanes (#2543), judged against bounds derived from their
  // own schedules (the pending digest is weekday only, so its legitimate silence is
  // the weekend). `neverIsStale` is ON for the retention lanes' reason: these run
  // once a day, so a lane that throws on its first run would otherwise stay
  // invisible for ever. Slack only: a morning report that did not go out is a
  // missing safety net, not an outage, so it must not touch /api/health.
  const timeOffStale = findStaleLanes(heartbeats, now, TIME_OFF_STALE_BOUNDS_MS, true);
  // noodge's two keyed checks of Slate (#1228), the watcher of the watcher. Judged
  // with `neverIsStale` ON: a deployment with no heartbeat key, or a check nobody
  // registered, never stamps, and that is exactly the silence this exists to end.
  // Slack only: a paused monitor is not an outage, and flipping /api/health would
  // have noodge report its own pause as one.
  const uptimeStale = findStaleLanes(heartbeats, now, UPTIME_STALE_BOUNDS_MS, true);
  // The daily off platform database dump (#3076). `neverIsStale` is ON: a dump that
  // has never landed is a database with no copy outside Supabase, and silent for
  // ever is the worse failure. Slack only: a missing backup is not an outage.
  const backupStale = findStaleLanes(heartbeats, now, BACKUP_STALE_BOUNDS_MS, true);
  // The log shipping receipt (#3182): the tail worker hands one over each time Better
  // Stack accepts a cron tick's records. `neverIsStale` is ON: a tail worker that has
  // never sent one is the fault, not a fresh deploy. Slack only: log history stopping
  // is a missing record, not an outage.
  const logShippingStale = findStaleLanes(heartbeats, now, LOG_SHIPPING_STALE_BOUNDS_MS, true);
  // #3460: the pool grouping publish, stamped by the recompute lane once the directory
  // holds it. `neverIsStale` is ON with the grace window: a publish that never once landed
  // leaves every cold server on its code's own line, which is the state this watches for.
  const poolGroupingStale = findStaleLanes(heartbeats, now, POOL_GROUPING_STALE_BOUNDS_MS, true);
  // The detector verdict stamps (#1394): not "did this lane run" but "did this
  // detector CONCLUDE anything". `neverIsStale` is ON for a sharper reason than
  // the retention lanes': a detector that has never once reached a verdict is the
  // exact state this family exists to notice, and the default leniency would make
  // it structurally unable to see it. Slack only, like the mirror lanes: a blind
  // detector is a missing safety net, not an outage.
  const verdictStale = findStaleLanes(heartbeats, now, VERDICT_STALE_BOUNDS_MS, true);
  // #1561: two of those detectors cannot conclude at all before cutover, so the
  // blind page named an action nobody could take and repeated every 24 hours.
  // They are PARKED: quiet about being blind, loud about being parked, and loud
  // again the moment one of them concludes anyway, which is what cutover looks
  // like. Derived from the same heartbeat read, so it costs no extra query.
  // Judged against each park's OWN `unparkWithinMs`, not the blindness bound the
  // same record supplies below (#1562): the bound asks "has this stopped", which a
  // verdict from three days ago still satisfies, and reading that as "this is
  // concluding" let one accidental canary-driven verdict hold a daily page open.
  const parkStates = Object.keys(VERDICT_STALE_BOUNDS_MS).map((lane) => ({
    lane,
    state: detectorParkState(lane, heartbeats[lane], now),
  }));
  const parkedLanes = parkStates.filter((p) => p.state === "parked").map((p) => p.lane);
  const unparkLanes = parkStates.filter((p) => p.state === "unpark").map((p) => p.lane);
  // A parked lane is excluded from the blind page, and ONLY from that: it is
  // still judged, still logged, and still all-cleared by the recovery pass below
  // if it starts stamping.
  //
  // #3141: a detector whose optional secret is unset is excused the same way, and only while it
  // is unset (`unconfiguredDetector`); it reports its own unset state on its own channel.
  const armedVerdictStale = verdictStale.filter(
    (l) => !parkedDetector(l.lane) && unconfiguredDetector(l.lane, process.env) === null,
  );

  // #1134: NO early return on the all-healthy tick. There used to be one here, and
  // it would have made the recovery notice below unreachable on the single path
  // that matters: a fleet that has healed produces an empty stale list by
  // definition. The loops below are no-ops on empty lists, so the healthy tick
  // costs only the one bulk firing-marker read that `resolveRecoveredLanes` does.

  if (stale.length > 0) {
    log.warn("lane-watchdog", {
      msg: "stale lanes",
      count: stale.length,
      lanes: stale.map((l) => `${l.lane}=${minutes(l.ageMs)}m`).join(","),
    });
    // ONE page for every quiet core lane (2026-10-26), its lanes as its subjects so a
    // lane joining it posts at once (#3801). Cloudflare's status page is read only now,
    // never on a healthy tick.
    const fresh = Object.entries(LANE_STALE_BOUNDS_MS).some(([name, bound]) => {
      const at = heartbeats[name];
      return at !== null && at !== undefined && now - at <= bound;
    });
    const cloudflare = await readCloudflareCronStatus();
    const minuteTrigger = await readMinuteTrigger(stale, now);
    // A publish that has never landed is in this list under its grace window, and is not "stopped".
    const poolGroupingStopped = poolGroupingStale.some((l) => Number.isFinite(l.ageMs));
    // alert-key: cron_lanes_stale
    await sendThrottledAlert(
      CORE_LANES_ALERT_KEY,
      STALE_LANE_COOLDOWN_MS,
      coreLanesAlertText({ stale, othersRunning: fresh, poolGroupingStopped, cloudflare, minuteTrigger }),
      // The pool grouping is a subject too: its own page waits on this one (ALERT_FOLDS),
      // so its stopping after this page posted must read as a change and post at once.
      { subjects: [...stale.map((l) => l.lane), ...(poolGroupingStopped ? ["pool-grouping"] : [])] },
    ).catch((err) => {
      // A failed Slack post must not throw into the lane that called the watchdog.
      log.error("lane-watchdog", { msg: "alert failed", lanes: stale.length }, err);
    });
  }

  for (const lane of canaryStale) {
    log.warn("lane-watchdog", {
      msg: "canary stale",
      lane: lane.lane,
      age_min: minutes(lane.ageMs),
    });
    await sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      canaryAlertText(lane, minutes(lane.maxStaleMs)),
      { subjects: [lane.lane] },
    ).catch((err) => {
      log.error("lane-watchdog", { msg: "alert failed", lane: lane.lane }, err);
    });
  }

  for (const lane of mirrorStale) {
    log.warn("lane-watchdog", { msg: "mirror lane stale", lane: lane.lane, age_min: minutes(lane.ageMs) });
    await sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      mirrorAlertText(lane, minutes(lane.maxStaleMs)),
      { subjects: [lane.lane] },
    ).catch((err) => {
      log.error("lane-watchdog", { msg: "alert failed", lane: lane.lane }, err);
    });
  }

  await pageWithGraceWindow(retentionStale, now, "retention lane", (lane) =>
    sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      retentionAlertText(lane.lane, lane.ageMs, minutes(lane.maxStaleMs), lane.unreadable),
      { subjects: [lane.lane] },
    ),
  );

  await pageWithGraceWindow(timeOffStale, now, "time off lane", (lane) =>
    sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      DAILY_LANE_COOLDOWN_MS,
      timeOffLaneAlertText(lane),
      { subjects: [lane.lane] },
    ),
  );

  await pageWithGraceWindow(uptimeStale, now, "uptime check", (lane) =>
    sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      uptimeAlertText(lane),
      { subjects: [lane.lane] },
    ),
  );

  await pageWithGraceWindow(backupStale, now, "database backup", (lane) =>
    sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      DAILY_LANE_COOLDOWN_MS,
      backupAlertText(lane),
      { subjects: [lane.lane] },
    ),
  );

  await pageWithGraceWindow(logShippingStale, now, "log shipping receipt", (lane) =>
    sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      logShippingAlertText(lane),
      { subjects: [lane.lane] },
    ),
  );

  await pageWithGraceWindow(poolGroupingStale, now, "pool grouping publish", (lane) =>
    sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      poolGroupingAlertText(lane),
      { subjects: [lane.lane] },
    ),
  );

  await pageWithGraceWindow(armedVerdictStale, now, "detector", (lane) =>
    sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      BLIND_DETECTOR_COOLDOWN_MS,
      verdictBlindAlertText(lane),
      { subjects: [lane.lane] },
    ),
  );

  if (parkedLanes.length > 0) {
    log.info("lane-watchdog", {
      msg: "detectors parked, not paging on their blindness",
      lanes: parkedLanes.join(","),
    });
    // alert-key: detector_parked
    await sendThrottledInfo(
      "detector_parked",
      PARKED_DETECTOR_COOLDOWN_MS,
      verdictParkedInfoText(parkedLanes),
    ).catch((err) => {
      log.error("lane-watchdog", { msg: "parked whisper failed" }, err);
    });
  }

  for (const lane of unparkLanes) {
    log.warn("lane-watchdog", { msg: "parked detector reached a verdict", lane });
    // alert-key: detector_unpark:*
    await sendThrottledAlert(
      unparkAlertKey(lane),
      UNPARK_DETECTOR_COOLDOWN_MS,
      verdictUnparkAlertText(lane),
    ).catch((err) => {
      log.error("lane-watchdog", { msg: "un-park alert failed", lane }, err);
    });
  }

  await resolveRecoveredLanes(
    heartbeats,
    now,
    new Set(
      [
        ...stale,
        ...canaryStale,
        ...mirrorStale,
        ...retentionStale,
        ...timeOffStale,
        ...uptimeStale,
        ...backupStale,
        ...logShippingStale,
        ...poolGroupingStale,
        ...armedVerdictStale,
      ].map((l) => l.lane),
    ),
    // The un-park page's two endings, both folded into the recovery pass's single
    // alert_state read rather than adding one. A detector that is now ARMED had its
    // registry entry deleted, which is the ending the page asked for. A detector
    // back in PARKED concluded once and then stopped, so nobody armed anything and
    // the park still stands: distinct causes, distinct messages (L11), because the
    // armed wording asserts three things that are all false on a lapse. A lane is
    // exactly one of the three states, so these can never both name one key, and a
    // lane whose page never fired sends nothing either way.
    [
      ...parkStates.flatMap((p) => {
        const key = unparkAlertKey(p.lane);
        if (p.state === "armed") return [{ key, text: verdictUnparkRecoveryText(p.lane) }];
        if (p.state === "parked") return [{ key, text: verdictUnparkLapsedText(p.lane) }];
        return [];
      }),
      // #2875: a cal.com lane page already open when cal.com was retired ends HERE,
      // saying it was retired. Its heartbeat will never come back, so the recovery
      // pass below could never end it, and "running again" would be false.
      ...(calcomRetired === true
        ? CALCOM_HEARTBEAT_LANES.map((lane) => ({ key: staleLaneAlertKey(lane), text: calcomLaneRetiredText(lane) }))
        : []),
      // The core lanes' page ends only when NO core lane is quiet, measured by this
      // successful read; one lane coming back while another is still quiet ends nothing.
      ...(stale.length === 0 ? [{ key: CORE_LANES_ALERT_KEY, text: coreLanesRecoveryText() }] : []),
    ],
    canaryBounds,
  );

  return {
    judged: true,
    stale: [
      ...stale,
      ...canaryStale,
      ...mirrorStale,
      ...retentionStale,
      ...timeOffStale,
      ...uptimeStale,
      ...backupStale,
      ...logShippingStale,
      ...poolGroupingStale,
      ...armedVerdictStale,
    ],
  };
}


/**
 * Page every stale lane in a `neverIsStale` family, honouring the grace window a
 * lane that has NEVER stamped is owed (#1102, generalized for #1394).
 *
 * Both families that opt out of the never-stamped leniency need identical
 * handling of it, and they got it by copy the first time. The window is anchored
 * on when we FIRST noticed the lane missing rather than on a deploy time we do
 * not record, so a newly deployed lane has its whole bound to produce a first
 * stamp and a lane that genuinely never runs still pages, one bound later.
 *
 * `what` names the family in the log line only. The alert copy comes from `send`,
 * because the two families say different things for different readers.
 */
async function pageWithGraceWindow(
  lanes: StaleLane[],
  now: number,
  what: string,
  send: (lane: StaleLane) => Promise<void>,
): Promise<void> {
  for (const lane of lanes) {
    if (!Number.isFinite(lane.ageMs)) {
      const verdict = neverStampedVerdict(await readFirstSeenMissingMs(lane.lane), now, lane.maxStaleMs);
      if (verdict === "record-first-sighting") {
        await recordFirstSeenMissing(lane.lane);
        log.info("lane-watchdog", {
          msg: `${what} not yet seen; starting its grace window`,
          lane: lane.lane,
        });
        continue;
      }
      if (verdict === "wait") continue;
    } else {
      // It has stamped, so any earlier sighting is history: clear it so a future
      // disappearance starts a fresh window rather than paging instantly.
      await clearFirstSeenMissing(lane.lane);
    }
    log.warn("lane-watchdog", {
      msg: `${what} stale`,
      lane: lane.lane,
      age_min: Number.isFinite(lane.ageMs) ? minutes(lane.ageMs) : -1,
    });
    await send(lane).catch((err) => {
      // One lane's failed Slack post must not skip the remaining lanes.
      log.error("lane-watchdog", { msg: "alert failed", lane: lane.lane }, err);
    });
  }
}

/**
 * The ten lane families and the all-clear each one speaks (#1134, #1394, #2543, #1228, #3182, #3460).
 *
 * Kept alongside the per family alert-text functions rather than collapsed into one
 * generic "recovered": these lanes fail for different reasons, are recovered by
 * different people doing different things, and #1123 already had to unpick one
 * shared message that pointed responders at the wrong lane and lock. An all-clear
 * that names the wrong thing is the same defect facing the other way.
 */
function laneFamilies(canaryBounds: Record<string, number>): {
  bounds: Record<string, number>;
  recovery: (lane: string) => string;
  /** This family is judged with `neverIsStale`, so a recovered lane may still be
   *  carrying a first-sighting marker that has to be dropped (see below). */
  graceWindow?: true;
}[] {
  return [
    // The core lanes page under CORE_LANES_ALERT_KEY since 2026-10-26. Kept so a per lane
    // page a deploy before that sent still gets its all-clear; it costs nothing, as these
    // keys ride the same bulk read.
    { bounds: LANE_STALE_BOUNDS_MS, recovery: laneRecoveryText },
    // #2875: the SAME canary bounds the staleness pass judged against, so a retired
    // cal.com lane is settled once, by its retirement text, never also as recovered.
    { bounds: canaryBounds, recovery: canaryRecoveryText },
    { bounds: MIRROR_STALE_BOUNDS_MS, recovery: mirrorRecoveryText },
    { bounds: RETENTION_STALE_BOUNDS_MS, recovery: retentionRecoveryText, graceWindow: true },
    { bounds: TIME_OFF_STALE_BOUNDS_MS, recovery: timeOffRecoveryText, graceWindow: true },
    { bounds: UPTIME_STALE_BOUNDS_MS, recovery: uptimeRecoveryText, graceWindow: true },
    { bounds: BACKUP_STALE_BOUNDS_MS, recovery: backupRecoveryText, graceWindow: true },
    { bounds: LOG_SHIPPING_STALE_BOUNDS_MS, recovery: logShippingRecoveryText, graceWindow: true },
    { bounds: POOL_GROUPING_STALE_BOUNDS_MS, recovery: poolGroupingRecoveryText, graceWindow: true },
    { bounds: VERDICT_STALE_BOUNDS_MS, recovery: verdictRecoveryText, graceWindow: true },
  ];
}

/**
 * Announce that a lane which was paged is stamping again (#1134).
 *
 * Recovery needs POSITIVE evidence, not merely the absence of a staleness verdict.
 * A lane qualifies only if it has a heartbeat AND that heartbeat is inside its own
 * bound. A lane missing from the table entirely has not recovered, it has never
 * been seen, and `findStaleLanes` skips it silently for every family except
 * retention, so "not in the stale list" alone would quietly all-clear it.
 *
 * Reached only after a SUCCESSFUL heartbeat read: the caller returns early when
 * that read throws, because a failed query is not evidence that any lane is fine.
 * That is the #1149 lesson, and this lane is where conflating the two would be
 * worst, since it would declare the whole cron fleet healthy at once.
 *
 * One bulk read decides which pages are outstanding, because the watchdog runs on
 * the every-minute lane against roughly fifteen lanes and a read per lane would be
 * fifteen queries a minute on the shared cron budget. On the ordinary healthy tick
 * nothing is firing, so this costs exactly one read and sends nothing.
 */
async function resolveRecoveredLanes(
  heartbeats: Record<string, number | null>,
  now: number,
  staleLanes: Set<string>,
  /**
   * Extra keys to settle in the SAME read (#1561): conditions whose end is not a
   * heartbeat coming back but a person changing something, so nothing above can
   * derive them. Folded in here because the alternative is a second
   * `alert_state` read every minute on the budget four cron lanes share.
   */
  alsoSettle: { key: string; text: string }[] = [],
  canaryBounds: Record<string, number> = CANARY_STALE_BOUNDS_MS,
): Promise<void> {
  const recovered: { key: string; lane: string; text: string; graceWindow: boolean }[] = [];
  for (const s of alsoSettle) {
    recovered.push({ key: s.key, lane: s.key, text: s.text, graceWindow: false });
  }
  for (const { bounds, recovery, graceWindow } of laneFamilies(canaryBounds)) {
    for (const [lane, maxStaleMs] of Object.entries(bounds)) {
      if (staleLanes.has(lane)) continue;
      const lastRanAtMs = heartbeats[lane];
      if (lastRanAtMs === null || lastRanAtMs === undefined) continue;
      if (now - lastRanAtMs > maxStaleMs) continue;
      recovered.push({
        key: staleLaneAlertKey(lane),
        lane,
        text: recovery(lane),
        graceWindow: graceWindow === true,
      });
    }
  }
  if (recovered.length === 0) return;

  // Both questions this tick has about `alert_state` in ONE read: which lane pages
  // are outstanding, and which recovered retention lanes still carry a stale
  // first-sighting marker. Asking separately, or blind-deleting the markers, would
  // add a query or a write per lane per minute to the shared cron budget for
  // rows that almost never exist.
  const present = await existingAlertStateKeys([
    ...recovered.map((r) => firingKey(r.key)),
    ...recovered.filter((r) => r.graceWindow).map((r) => firstSeenKey(r.lane)),
  ]).catch((err) => {
    log.warn("lane-watchdog", { msg: "alert-state read failed; recovery deferred" });
    void err;
    return new Set<string>();
  });

  for (const r of recovered) {
    // A recovered retention lane drops its "first noticed missing" marker (#1102).
    // That was only cleared for a lane still in the stale list, so a lane that
    // never stamped and then came good kept a marker dated to its original
    // sighting; if it ever vanished again its grace window would already be spent
    // and it would page instantly instead of waiting out a fresh one.
    if (r.graceWindow && present.has(firstSeenKey(r.lane))) {
      await clearFirstSeenMissing(r.lane);
    }
    if (!present.has(firingKey(r.key))) continue;
    // alert-key: cron_lane_stale:*
    // alert-key: cron_lanes_stale
    // alert-key: detector_unpark:*
    const sent = await resolveAlert(r.key, r.text).catch((err) => {
      // One lane's failed notice must not skip the rest, and the firing marker
      // survives, so the next tick retries.
      log.error("lane-watchdog", { msg: "recovery notice failed", lane: r.lane }, err);
      return false;
    });
    if (sent) log.info("lane-watchdog", { msg: "lane-stale alert cleared", lane: r.lane });
  }
}









/**
 * The "first noticed missing" marker for a never-stamped lane (#1102).
 *
 * Stored in `alert_state`, which is already a generic key-to-timestamp table with
 * deny-all RLS, so this needs no migration. The key is namespaced away from the
 * alert cooldown keys (`cron_lane_stale:*`) so the two cannot collide.
 *
 * All three helpers are best-effort and never throw: they run inside a cron lane,
 * and a watchdog that takes down the sync tick is worse than a late alert. A failed
 * READ returns null, which means "record a first sighting", so the worst case is a
 * page deferred by one bound rather than a false page.
 */
const firstSeenKey = (lane: string) => `lane_never_seen:${lane}`;

async function readFirstSeenMissingMs(lane: string): Promise<number | null> {
  try {
    // error-ok: a read failure defers the page by one bound; it never causes a
    // false page, and the next tick retries.
    const { data } = await supabaseAdmin()
      .from("alert_state")
      .select("last_sent_at")
      .eq("key", firstSeenKey(lane))
      .maybeSingle();
    const at = (data as { last_sent_at: string } | null)?.last_sent_at;
    if (!at) return null;
    // #1169: fail closed. An unparseable sighting used to become NaN, which
    // neverStampedVerdict compared false against forever ("wait" on every tick),
    // so the lane could never page. Unreadable reads as ancient (page), never as
    // a pending grace window.
    return parseStampMs(at) ?? 0;
  } catch (err) {
    log.warn("lane-watchdog", { msg: "first-sighting read failed", lane });
    void err;
    return null;
  }
}

async function recordFirstSeenMissing(lane: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from("alert_state")
      .upsert({ key: firstSeenKey(lane), last_sent_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) log.warn("lane-watchdog", { msg: "first-sighting write failed", lane, error: error.message });
  } catch (err) {
    log.warn("lane-watchdog", { msg: "first-sighting write threw", lane });
    void err;
  }
}

async function clearFirstSeenMissing(lane: string): Promise<void> {
  try {
    // write-ok: a refused clear leaves the first sighting stamp, so a lane that recovers is judged from an older sighting. The next clean pass clears it again.
    await supabaseAdmin().from("alert_state").delete().eq("key", firstSeenKey(lane));
  } catch (err) {
    log.warn("lane-watchdog", { msg: "first-sighting clear failed", lane });
    void err;
  }
}
