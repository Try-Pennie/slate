import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { planBookableChange } from "@/lib/bookable/plan";
import { isCalendarReachable } from "@/lib/google/reachability";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

/**
 * Keyed per agent (`bookable_blocked:<userId>`) so a single agent stuck with a
 * broken calendar can't throttle away the first alert for a different agent.
 * 30 min mirrors the watch-lapse cadence: a persistently-failing activation
 * pages once, not on every retry.
 */
export const BOOKABLE_BLOCKED_COOLDOWN_MS = 30 * 60 * 1000;

export type BookableResult =
  | { status: "not_found" }
  | { status: "noop"; userId: string; bookable: boolean }
  | { status: "applied"; userId: string; bookable: boolean }
  | { status: "blocked"; userId: string; reason: "google_unreachable" };

export interface BookableDeps {
  /** Live Google reachability probe (injected in tests). */
  checkReachable: (email: string) => Promise<boolean>;
  /** Throttled named alert (injected in tests). */
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
}

const defaultDeps: BookableDeps = {
  checkReachable: isCalendarReachable,
  // Best-effort: a flaky Slack must never fail the flip (the write already
  // didn't happen on a block; the alert is the only side effect left).
  notify: (key, cooldownMs, text) => sendThrottledAlert(key, cooldownMs, text).catch(() => {}),
};

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
export async function applyBookableByEmail(
  email: string,
  bookable: boolean,
  deps: BookableDeps = defaultDeps,
): Promise<BookableResult> {
  const trimmed = email.trim();
  const db = supabaseAdmin();
  // Exact match, consistent with the offboarding lookup (NOT ilike: `_`/`%` in
  // the address would act as wildcards and could resolve the WRONG user).
  const user = unwrap(
    await db.from("users").select("id, bookable").eq("email", trimmed).maybeSingle(),
    "bookable.lookup",
  ) as { id: string; bookable: boolean } | null;

  const plan = planBookableChange(user, bookable);
  if (plan.status === "not_found") return { status: "not_found" };
  if (plan.status === "noop") return { status: "noop", userId: user!.id, bookable };

  if (plan.bookable === true) {
    const reachable = await deps.checkReachable(trimmed);
    if (!reachable) {
      await deps.notify(
        `bookable_blocked:${user!.id}`,
        BOOKABLE_BLOCKED_COOLDOWN_MS,
        `Slate: blocked making ${trimmed} bookable because their Google calendar is unreachable (account gone from the Workspace, or delegation broken). The agent was NOT added to the booking pool; fix the calendar and retry.`,
      );
      log.warn("bookable-api", { msg: "activation blocked, google unreachable", user_id: user!.id });
      return { status: "blocked", userId: user!.id, reason: "google_unreachable" };
    }
  }

  await writeBookable(user!.id, plan.bookable);
  log.info("bookable-api", { msg: "bookable set", user_id: user!.id, bookable: plan.bookable });
  return { status: "applied", userId: user!.id, bookable: plan.bookable };
}
