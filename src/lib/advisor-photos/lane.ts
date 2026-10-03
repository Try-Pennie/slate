/**
 * The advisor photo lane (#3027): one refresh with its lock, alerts and verdict
 * stamp, shared by the daily cron route and the admin's manual trigger so the
 * two cannot drift. The per agent refresh uses `refreshOnePhoto` below, which
 * takes the same lock and never touches the daily alerts or the verdict.
 */
import { logResolveFailure } from "../notify/send-failure.ts";
import { acquireLock, releaseLock } from "@/lib/locks";
import { log } from "@/lib/log";
import { directoryAdminSubject } from "@/lib/env";
import { readHeartbeatMsStrict } from "@/lib/monitor/heartbeat";
import { recordDetectorVerdict } from "@/lib/monitor/verdict-store";
import { ADVISOR_PHOTOS_VERDICT_LANE } from "@/lib/monitor/verdict-freshness";
import { loadMonitorCooldowns } from "@/lib/monitor/settings";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { recordingAlerts } from "@/lib/notify/alert-recording";
import { getDirectoryPhoto, listDirectoryAccounts } from "@/lib/advisor-photos/google";
import { listPhotoSubjects, listStoredPhotoStates, photoWrites } from "@/lib/advisor-photos/store";
import { needsAttention, runPhotoRefresh, type RefreshDeps, type RefreshOutcome } from "@/lib/advisor-photos/refresh";
import {
  photosDeadlineAlert,
  photosHeldAlert,
  photosHeldRecovery,
  photosUnreadAlert,
  photosUnreadRecovery,
} from "@/lib/advisor-photos/copy";

export const ADVISOR_PHOTOS_LOCK = "cron_advisor_photos";
/**
 * How long one run may keep STARTING reads. A full run is about 130 reads and
 * takes well under a minute on a good day; a slow Google (every read timing out
 * and retrying) could otherwise run for far longer than the lock, letting a second
 * run start beside it. At the deadline the run writes what it finished, reports
 * how many it never reached, and stamps no verdict.
 */
export const ADVISOR_PHOTOS_RUN_DEADLINE_MS = 10 * 60_000;
/**
 * Longer than the deadline by more than one read's worst case (three attempts at
 * a 15 second timeout plus backoff, about a minute), so a read still in flight at
 * the deadline finishes under the lock.
 */
export const ADVISOR_PHOTOS_LOCK_TTL_MS = 15 * 60_000;
const LOCK_TTL_MS = ADVISOR_PHOTOS_LOCK_TTL_MS;

/** The real collaborators. `apply: false` is the verify command's dry run. */
export function liveRefreshDeps(apply: boolean): RefreshDeps {
  return {
    subject: directoryAdminSubject(),
    listUsers: listPhotoSubjects,
    listRows: listStoredPhotoStates,
    listDirectory: listDirectoryAccounts,
    getPhoto: getDirectoryPhoto,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowMs: () => Date.now(),
    writes: apply ? photoWrites() : null,
    deadlineMs: Date.now() + ADVISOR_PHOTOS_RUN_DEADLINE_MS,
  };
}

export type LaneResult =
  | { status: "skipped"; why: "overlapping-run" | "already-measured-today" }
  | RefreshOutcome
  /** `alerted`: the alerts raised ABOUT this failure and nothing else, so the cron
   *  route can tell the dispatcher the lane already spoke (one failure, one message). */
  | { status: "failed"; detail: string; alerted: string[] };

/** Midnight UTC of the day `nowMs` falls in. */
export function startOfUtcDay(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whether the scheduled retry should stand down: today's run already reached a
 * verdict. A failed read of the stamp runs the refresh anyway, because the safe
 * side of a doubt here is doing the work (one extra read of Google).
 */
async function alreadyMeasuredToday(nowMs: number): Promise<boolean> {
  try {
    const last = await readHeartbeatMsStrict(ADVISOR_PHOTOS_VERDICT_LANE);
    return last !== null && last >= startOfUtcDay(nowMs);
  } catch (err) {
    log.warn("advisor-photos", { msg: "verdict stamp unreadable, running the refresh anyway" }, err);
    return false;
  }
}

/**
 * Run the daily refresh. `trigger: "cron"` stands down when today already has a
 * verdict, which is what lets the second daily cron be the automatic re attempt
 * (L533) without doubling a healthy day's reads. The manual trigger always runs.
 */
export async function runAdvisorPhotoLane(trigger: "cron" | "manual"): Promise<LaneResult> {
  if (trigger === "cron" && (await alreadyMeasuredToday(Date.now()))) {
    return { status: "skipped", why: "already-measured-today" };
  }
  // lock-overlap: the run deadline plus the slowest read in flight fits inside the TTL
  // by construction (see ADVISOR_PHOTOS_RUN_DEADLINE_MS), so the key is released before
  // another run can take it.
  const lock = await acquireLock(ADVISOR_PHOTOS_LOCK, LOCK_TTL_MS);
  if (!lock) return { status: "skipped", why: "overlapping-run" };
  try {
    let outcome: RefreshOutcome;
    try {
      outcome = await runPhotoRefresh(liveRefreshDeps(true));
    } catch (err) {
      // Only a write can throw out of the refresh: every read failure is an outcome.
      const detail = err instanceof Error ? err.message : String(err);
      log.error("advisor-photos", { msg: "saving the refresh failed" }, err);
      // Recorded around THIS page alone: an alert the run raised earlier for another
      // reason must not stand the generic lane page down for this failure.
      const raised = await recordingAlerts(() =>
        page("advisor_photos_unread", photosUnreadAlert("write-failed", detail)),
      );
      if (!raised.ok) {
        // The page itself threw (its cooldown read, say) before sending anything.
        // Logged rather than swallowed, and it names only what it noted before the
        // throw, so with nothing raised the generic lane page is this failure's one
        // message.
        log.error(
          "advisor-photos",
          { msg: "the page about a failed save threw", alerted: raised.keys.join(",") },
          raised.error,
        );
      }
      return { status: "failed", detail, alerted: raised.keys };
    }
    await report(outcome);
    return outcome;
  } finally {
    await releaseLock(ADVISOR_PHOTOS_LOCK, lock);
  }
}

async function page(key: "advisor_photos_unread" | "advisor_photos_held", text: string): Promise<void> {
  const cooldowns = await loadMonitorCooldowns("advisor-photos");
  const failed = (err: unknown) => log.error("advisor-photos", { msg: "alert send failed", key }, err);
  // alert-text-ok: every message is built in copy.ts from sentences this code wrote;
  // a write failure's detail is the store's own short "read failed [context]" line.
  if (key === "advisor_photos_unread") {
    await sendThrottledAlert("advisor_photos_unread", cooldowns.advisor_photos_unread, text).catch(failed);
  } else {
    // alert-text-ok: as above, built in copy.ts.
    await sendThrottledAlert("advisor_photos_held", cooldowns.advisor_photos_held, text).catch(failed);
  }
}

/** Alerts and the verdict stamp for one full run. */
async function report(outcome: RefreshOutcome): Promise<void> {
  if (outcome.status === "refused") {
    log.warn("advisor-photos", { msg: "refresh refused", why: outcome.why });
    if (outcome.why !== "unknown-user") {
      await page("advisor_photos_unread", photosUnreadAlert(outcome.why, outcome.detail, outcome.notReached ?? 0));
    }
    return;
  }
  const c = outcome.plan.counts;
  log.info("advisor-photos", {
    msg: "cycle",
    attempted: c.attempted,
    photo: c.photo,
    none: c.none,
    placeholder: c.placeholder,
    gained: c.gained,
    changed: c.changed,
    lost: c.lost,
    failed: c.failed,
    not_in_directory: c.notInDirectory,
    deleted: c.deleted,
    flip_guard: outcome.plan.flipGuardTripped,
    repeated: outcome.plan.repeated.length,
  });
  // all-clear-proof: src/lib/advisor-photos/lane.test.ts drives the refused,
  // write failed and guard tripped runs and asserts neither all clear is sent.
  //
  // Both all clears hang off the MEASURED run (#1134, #1152): a refusal returned
  // above and a failed write never reach this line.
  if (outcome.deadlineReached) {
    // A run cut short measured some people and not others: still the page, never
    // its all clear, and never a verdict.
    await page("advisor_photos_unread", photosDeadlineAlert(c.attempted, outcome.notReached));
  } else if (outcome.verdict) {
    await resolveAlert("advisor_photos_unread", photosUnreadRecovery()).catch(logResolveFailure("advisor_photos_unread"));
  }
  if (needsAttention(outcome.plan)) {
    await page("advisor_photos_held", photosHeldAlert(outcome.plan));
  } else if (outcome.verdict) {
    await resolveAlert("advisor_photos_held", photosHeldRecovery()).catch(logResolveFailure("advisor_photos_held"));
  }
  await recordDetectorVerdict(ADVISOR_PHOTOS_VERDICT_LANE, outcome.verdict);
}

/** Refresh one person, for the agent page's "Refresh from Google". */
export async function refreshOnePhoto(userId: string): Promise<LaneResult> {
  // lock-overlap: the single person refresh shares the lane key and is bounded by one
  // read's timeout, far inside the TTL, so no lane run can take the key while it works.
  const lock = await acquireLock(ADVISOR_PHOTOS_LOCK, LOCK_TTL_MS);
  if (!lock) return { status: "skipped", why: "overlapping-run" };
  try {
    return await runPhotoRefresh(liveRefreshDeps(true), { only: userId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error("advisor-photos", { msg: "saving one photo failed" }, err);
    // The manual one person refresh pages nothing; its caller shows the failure.
    return { status: "failed", detail, alerted: [] };
  } finally {
    await releaseLock(ADVISOR_PHOTOS_LOCK, lock);
  }
}
