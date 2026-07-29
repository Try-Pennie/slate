import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { planBookableChange } from "@/lib/bookable/plan";
import { classifyCalendarReachability } from "@/lib/google/reachability";
import type { Reachability } from "@/lib/google/reachability-classify";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { cleanupOnPoolExit } from "@/lib/google/sync";
import { log } from "@/lib/log";
import { bookableBlockedAlert, bookableUnverifiedAlert } from "@/lib/notify/misc-alert-copy";

/**
 * Keyed per agent (`bookable_blocked:<userId>`) so a single agent stuck with a
 * broken calendar can't throttle away the first alert for a different agent.
 * 30 min mirrors the watch-lapse cadence: a persistently-failing activation
 * pages once, not on every retry.
 */
export const BOOKABLE_BLOCKED_COOLDOWN_MS = 30 * 60 * 1000;

/** google_unreachable = a definitive "account gone" failure; google_unverified
 *  = a transient failure that persisted through one retry (couldn't confirm). */
export type BlockedReason = "google_unreachable" | "google_unverified";

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
}

const defaultDeps: BookableDeps = {
  checkReachable: classifyCalendarReachability,
  // Best-effort: a flaky Slack must never fail the flip (the write already
  // didn't happen on a block; the alert is the only side effect left).
  // alert-key: bookable_blocked:*
  // alert-key: bookable_unverified:*
  notify: (key, cooldownMs, text) => sendThrottledAlert(key, cooldownMs, text).catch(() => {}),
  // Best-effort: the flip already succeeded, so a cleanup failure must not fail
  // it. The self-heal reconcile backstop retries any leftover watch/blocks.
  cleanupOnPoolExit: (userId) =>
    cleanupOnPoolExit(userId)
      .then(() => {})
      .catch((err) =>
        log.error("bookable-api", { msg: "pool-exit cleanup failed", user_id: userId }, err),
      ),
};

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
  if (kind === "gone") {
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
 *  action, #281). Orthogonal to `deactivated_at` (this never touches it). */
export async function writeBookable(userId: string, bookable: boolean): Promise<void> {
  await supabaseAdmin().from("users").update({ bookable }).eq("id", userId);
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
  deps: BookableDeps = defaultDeps,
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
  deps: BookableDeps = defaultDeps,
): Promise<BookableResult> {
  const user = unwrap(
    await supabaseAdmin().from("users").select("id, bookable, email").eq("id", userId).maybeSingle(),
    "bookable.lookup",
  ) as BookableRow | null;
  return applyBookableToRow(user, bookable, deps);
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
  }

  await writeBookable(user!.id, plan.bookable);
  // Left the pool: stop the agent's Google watches and prune their cached busy
  // time so we're no longer POSTed for someone we don't book (#239/#248).
  if (plan.bookable === false) {
    await deps.cleanupOnPoolExit(user!.id);
  }
  log.info("bookable-api", { msg: "bookable set", user_id: user!.id, bookable: plan.bookable });
  return { status: "applied", userId: user!.id, bookable: plan.bookable };
}
