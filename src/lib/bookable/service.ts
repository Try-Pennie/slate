import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { planBookableChange } from "@/lib/bookable/plan";
import { classifyCalendarReachability } from "@/lib/google/reachability";
import type { Reachability } from "@/lib/google/reachability-classify";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { cleanupOnPoolExit } from "@/lib/google/sync";
import { onboardIntoPool, type PoolEntryResult } from "@/lib/google/pool-entry";
import { log } from "@/lib/log";
import {
  bookableBlockedAlert,
  bookableNotProvisionedAlert,
  bookableUnverifiedAlert,
  bookableUnhydratedAlert,
} from "@/lib/notify/misc-alert-copy";
import { isDefinitiveFailure } from "@/lib/google/sync-health";

/**
 * Keyed per agent (`bookable_blocked:<userId>`) so a single agent stuck with a
 * broken calendar can't throttle away the first alert for a different agent.
 * 30 min mirrors the watch-lapse cadence: a persistently-failing activation
 * pages once, not on every retry.
 */
export const BOOKABLE_BLOCKED_COOLDOWN_MS = 30 * 60 * 1000;

/** google_unreachable = a definitive "account gone" failure; google_unverified
 *  = a transient failure that persisted through one retry (couldn't confirm). */
export type BlockedReason =
  | "google_unreachable"
  /** #1396: the account exists but has never been given Calendar. Definitive like
   *  google_unreachable, and refused for the same reason, but its own value so the
   *  admin screen and the alert can name the fix (a Workspace admin, not a re-auth). */
  | "google_not_provisioned"
  | "google_unverified"
  /**
   * #2302: the account was reachable and Slate still could not load its events
   * into the availability cache. Refused for the same reason as the three above,
   * and named separately because it sends the reader to the calendar sync lane
   * rather than to the credentials or to a Workspace admin.
   *
   * Dan's rule, 2026-09-14: "we don't want someone without a read calendar to be
   * bookable." An agent in the pool with no cached busy time is offered as free
   * for every hour their working hours allow, and verify on book only catches
   * that at the last moment, after the lead has been shown the slot.
   */
  | "calendar_unhydrated";

export type BookableResult =
  | { status: "not_found" }
  | { status: "noop"; userId: string; bookable: boolean }
  | { status: "applied"; userId: string; bookable: boolean }
  | { status: "blocked"; userId: string; reason: BlockedReason };

export interface BookableDeps {
  /** Live Google reachability probe (injected in tests). */
  checkReachable: (email: string) => Promise<Reachability>;
  /** Throttled named alert (injected in tests). */
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  /** Pool-exit cleanup on deactivation: stop watches + prune busy_blocks (#239/#248). */
  cleanupOnPoolExit: (userId: string) => Promise<void>;
  /**
   * Pool-ENTRY onboarding on activation (#2302): discover the agent's calendars,
   * bootstrap each one out to the booking horizon, and stamp the agent as synced,
   * so being bookable and having a calendar Slate can read are one event rather
   * than half an hour apart.
   */
  onboardIntoPool: (userId: string) => Promise<PoolEntryResult>;
}

/**
 * Exported so a batch caller can flip somebody WITHOUT the inline onboarding
 * (#2302), by spreading these and replacing `onboardIntoPool`. The Salesforce
 * sync is the one such caller: it can flip a whole licence upgrade at once, and
 * each onboarding is a handful of Google calls out of one shared invocation
 * budget.
 */
export const defaultBookableDeps: BookableDeps = {
  checkReachable: classifyCalendarReachability,
  // Best-effort: a flaky Slack must never fail the flip (the write already
  // didn't happen on a block; the alert is the only side effect left).
  // alert-key: bookable_blocked:*
  // alert-key: bookable_unverified:*
  notify: (key, cooldownMs, text) => sendThrottledAlert(key, cooldownMs, text).catch(() => {}),
  // Best-effort: the flip already succeeded, so a cleanup failure must not fail
  // it. The self-heal reconcile backstop retries any leftover watch/blocks.
  cleanupOnPoolExit: (userId) => cleanupOnPoolExit(userId).then(() => {}),
  onboardIntoPool,
};

/**
 * Run the EXIT transition's side effect without letting it fail the flip that has
 * already been written.
 *
 * Only the exit. Entering the pool is a GATE since #2302 (see below), so its
 * failure is the whole point rather than something to swallow.
 *
 * At the CALL SITE rather than in the default wiring, because that is the difference
 * between a guarantee and a habit: containment in the default wiring is lost by any
 * caller that injects its own collaborator, and the property here is not optional.
 * The write has committed either way, so throwing would report a flip that happened
 * as one that did not, and the caller would have no correct response to it.
 *
 * The self-heal reconcile backstop retries a leftover watch or block on the way out,
 * and the sync and hydration rotations converge on the way in. On the entry side the
 * failure also records itself on the calendar row, which is what cancels the
 * monitors' first-run patience (#2299, #2300), so a bootstrap that really is broken
 * pages at once rather than after fifteen quiet minutes.
 */
async function settleTransition(
  what: "pool-exit cleanup",
  userId: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    log.error("bookable-api", { msg: `${what} failed`, user_id: userId }, err);
  }
}

/**
 * The activation reachability gate (#281, #913). Probes the calendar; a
 * definitive "gone" blocks at once, a "transient" is retried once (to ride out a
 * Google blip) and only then blocks. Returns null when the agent may go into the
 * pool (reachable), or a {reason, key, message} block otherwise.
 */
async function checkActivationGate(
  email: string,
  userId: string,
  deps: BookableDeps,
): Promise<{ reason: BlockedReason; key: string; message: string } | null> {
  let kind = await deps.checkReachable(email);
  if (kind === "transient") kind = await deps.checkReachable(email); // one retry
  if (kind === "reachable") return null;
  // #1396: refused for the same reason as gone (nothing about their availability
  // can be read, ever, until a human acts) but named separately, because the human
  // and the action are different. Enumerated BEFORE the gone branch so the two
  // cannot be conflated, and note the fall-through at the bottom is the TRANSIENT
  // branch: a definitive kind reaching it would be refused with "retry shortly",
  // which is advice that can never work. isDefinitiveFailure is what keeps that
  // from happening silently if a fourth kind ever arrives.
  if (kind === "not-provisioned") {
    return {
      reason: "google_not_provisioned",
      key: `bookable_blocked:${userId}`,
      message: bookableNotProvisionedAlert(email),
    };
  }
  if (isDefinitiveFailure(kind)) {
    return {
      reason: "google_unreachable",
      key: `bookable_blocked:${userId}`,
      message: bookableBlockedAlert(email),
    };
  }
  return {
    reason: "google_unverified",
    key: `bookable_unverified:${userId}`,
    message: bookableUnverifiedAlert(email),
  };
}

/** The one write that flips a user's bookable flag (shared with the admin
 *  action, #281). Orthogonal to `deactivated_at` (this never touches it).
 *
 *  It also settles `bookable_pending_since` (#2071): that mark records that the
 *  Salesforce sync planned to make somebody bookable and was refused, and ANY
 *  explicit bookable write answers the question it was asking, whether the sync
 *  finally succeeded or a person decided either way. Clearing it here, in the one
 *  write, is what stops the sync retrying a decision a human has already made. */
export async function writeBookable(userId: string, bookable: boolean): Promise<void> {
  await supabaseAdmin()
    .from("users")
    .update({ bookable, bookable_pending_since: null })
    .eq("id", userId);
}

/**
 * Move an agent into or out of the bookable pool by email (#281). Idempotent on
 * email; the plan is a pure function of the current row so a retrying automation
 * is harmless. On ACTIVATION only, verifies the agent's Google calendar is
 * reachable first: if it is not, the flip is BLOCKED (the agent stays out of the
 * pool) and a named alert fires, never a silent admit. Deactivation is never
 * blocked.
 */
type BookableRow = { id: string; bookable: boolean; email: string };

export async function applyBookableByEmail(
  email: string,
  bookable: boolean,
  deps: BookableDeps = defaultBookableDeps,
): Promise<BookableResult> {
  const db = supabaseAdmin();
  // Exact match, consistent with the offboarding lookup (NOT ilike: `_`/`%` in
  // the address would act as wildcards and could resolve the WRONG user).
  const user = unwrap(
    await db.from("users").select("id, bookable, email").eq("email", email.trim()).maybeSingle(),
    "bookable.lookup",
  ) as BookableRow | null;
  return applyBookableToRow(user, bookable, deps);
}

/**
 * Same flip keyed by user id, for the admin toggle (#912) where the caller
 * already has the RBAC-checked id. Shares the activation gate and write with the
 * by-email path so the admin UI can't put a calendar-less agent into the pool
 * either.
 */
export async function applyBookableByUserId(
  userId: string,
  bookable: boolean,
  deps: BookableDeps = defaultBookableDeps,
): Promise<BookableResult> {
  const user = unwrap(
    await supabaseAdmin().from("users").select("id, bookable, email").eq("id", userId).maybeSingle(),
    "bookable.lookup",
  ) as BookableRow | null;
  return applyBookableToRow(user, bookable, deps);
}

/**
 * Establish the agent's calendars and load them into the availability cache, and
 * answer what that achieved. `null` means it threw.
 *
 * A throw is the LEAST informative failure there is, so it must not be the one
 * that admits somebody: it is mapped to the same refusal a measured failure gets
 * (L93, choose which defect ships and say so). What it costs is precision in the
 * message, which is why the log line carries the counts separately.
 */
async function readCalendarForPool(
  userId: string,
  deps: BookableDeps,
): Promise<PoolEntryResult | null> {
  try {
    return await deps.onboardIntoPool(userId);
  } catch (err) {
    log.error("bookable-api", { msg: "pool-entry read threw", user_id: userId }, err);
    return null;
  }
}

/** Shared: plan (idempotent) from the row, run the activation gate on the way
 *  into the pool, then write. The gate probes the row's canonical email. */
async function applyBookableToRow(
  user: BookableRow | null,
  bookable: boolean,
  deps: BookableDeps,
): Promise<BookableResult> {
  const plan = planBookableChange(user, bookable);
  if (plan.status === "not_found") return { status: "not_found" };
  if (plan.status === "noop") return { status: "noop", userId: user!.id, bookable };

  if (plan.bookable === true) {
    const block = await checkActivationGate(user!.email, user!.id, deps);
    if (block) {
      await deps.notify(block.key, BOOKABLE_BLOCKED_COOLDOWN_MS, block.message);
      log.warn("bookable-api", { msg: "activation blocked", user_id: user!.id, reason: block.reason });
      return { status: "blocked", userId: user!.id, reason: block.reason };
    }
    // The SECOND half of the gate (#2302). Reachable is not the same as readable:
    // the probe above asks whether Google answers for this account, and this asks
    // whether their events actually reached the availability cache. Before the
    // write, because the answer decides whether there is a write at all.
    const entry = await readCalendarForPool(user!.id, deps);
    if (entry === null || entry.hydrated === 0 || entry.failed > 0) {
      const message = bookableUnhydratedAlert(
        user!.email,
        entry?.hydrated ?? 0,
        entry?.calendars ?? 0,
      );
      await deps.notify(`bookable_blocked:${user!.id}`, BOOKABLE_BLOCKED_COOLDOWN_MS, message);
      log.warn("bookable-api", {
        msg: "activation blocked",
        user_id: user!.id,
        reason: "calendar_unhydrated",
        calendars: entry?.calendars ?? 0,
        hydrated: entry?.hydrated ?? 0,
        failed: entry?.failed ?? 0,
      });
      // Nothing written, so `bookable_pending_since` survives and the hourly roster
      // sync retries this next hour, which is the same recovery path every other
      // arm of the gate already uses.
      return { status: "blocked", userId: user!.id, reason: "calendar_unhydrated" };
    }
  }

  await writeBookable(user!.id, plan.bookable);
  // Left the pool: stop the agent's Google watches and prune their cached busy
  // time so we're no longer POSTed for someone we don't book (#239/#248).
  if (plan.bookable === false) {
    await settleTransition("pool-exit cleanup", user!.id, () => deps.cleanupOnPoolExit(user!.id));
  }

  log.info("bookable-api", { msg: "bookable set", user_id: user!.id, bookable: plan.bookable });
  return { status: "applied", userId: user!.id, bookable: plan.bookable };
}
