/**
 * The advisor photo lane (#3027): one refresh with its lock, alerts and verdict
 * stamp, shared by the daily cron route and the admin's manual trigger so the
 * two cannot drift. The per agent refresh uses `refreshOnePhoto` below, which
 * takes the same lock and never touches the daily alerts or the verdict.
 */
import { acquireLock, releaseLock } from "@/lib/locks";
import { log } from "@/lib/log";
import { directoryAdminSubject } from "@/lib/env";
import { readHeartbeatMsStrict } from "@/lib/monitor/heartbeat";
import { recordDetectorVerdict } from "@/lib/monitor/verdict-store";
import { ADVISOR_PHOTOS_VERDICT_LANE } from "@/lib/monitor/verdict-freshness";
import { loadMonitorCooldowns } from "@/lib/monitor/settings";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { getDirectoryPhoto, listDirectoryAccounts } from "@/lib/advisor-photos/google";
import { listPhotoSubjects, listStoredPhotoStates, photoWrites } from "@/lib/advisor-photos/store";
import { needsAttention, runPhotoRefresh, type RefreshDeps, type RefreshOutcome } from "@/lib/advisor-photos/refresh";
import {
  photosHeldAlert,
  photosHeldRecovery,
  photosUnreadAlert,
  photosUnreadRecovery,
} from "@/lib/advisor-photos/copy";

export const ADVISOR_PHOTOS_LOCK = "cron_advisor_photos";
/** A full run is about 130 reads; this is several times what it takes. */
const LOCK_TTL_MS = 10 * 60_000;

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
  };
}

export type LaneResult =
  | { status: "skipped"; why: "overlapping-run" | "already-measured-today" }
  | RefreshOutcome
  | { status: "failed"; detail: string };

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
      await page("advisor_photos_unread", photosUnreadAlert("write-failed", detail));
      return { status: "failed", detail };
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
    if (outcome.why !== "unknown-user") await page("advisor_photos_unread", photosUnreadAlert(outcome.why, outcome.detail));
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
  if (outcome.verdict) {
    await resolveAlert("advisor_photos_unread", photosUnreadRecovery()).catch(() => false);
  }
  if (needsAttention(outcome.plan)) {
    await page("advisor_photos_held", photosHeldAlert(outcome.plan));
  } else if (outcome.verdict) {
    await resolveAlert("advisor_photos_held", photosHeldRecovery()).catch(() => false);
  }
  await recordDetectorVerdict(ADVISOR_PHOTOS_VERDICT_LANE, outcome.verdict);
}

/** Refresh one person, for the agent page's "Refresh from Google". */
export async function refreshOnePhoto(userId: string): Promise<LaneResult> {
  const lock = await acquireLock(ADVISOR_PHOTOS_LOCK, LOCK_TTL_MS);
  if (!lock) return { status: "skipped", why: "overlapping-run" };
  try {
    return await runPhotoRefresh(liveRefreshDeps(true), { only: userId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error("advisor-photos", { msg: "saving one photo failed" }, err);
    return { status: "failed", detail };
  } finally {
    await releaseLock(ADVISOR_PHOTOS_LOCK, lock);
  }
}
