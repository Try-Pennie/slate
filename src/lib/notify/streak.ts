import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

/**
 * Persistent consecutive-hit streak for a periodic job, built on the #31
 * `rate_limit_hit` SQL function: each hit bumps a per-key count inside a window,
 * `clearFailureStreak` resets it. The counter is an atomic upsert, so concurrent
 * or retried ticks cannot race it the way a read-increment-write would.
 *
 * Returns true once the streak REACHES `alertAt` consecutive hits, and on every
 * hit after that (the caller's alert cooldown throttles the repeats).
 *
 * Tracking is best-effort: a tracking miss must never break the caller, and it
 * must never invent a streak that did not happen, so it returns false (stay
 * quiet) rather than throwing or guessing.
 *
 * `windowSeconds` must comfortably exceed the job's interval so genuinely
 * consecutive passes land in the same window (otherwise each hit looks like the
 * first).
 */
export async function recordConsecutiveStreak(
  key: string,
  windowSeconds: number,
  alertAt: number,
): Promise<boolean> {
  try {
    const db = supabaseAdmin();
    // rate_limit_hit returns `count <= p_max`. Allowing one fewer than the
    // threshold makes the Nth consecutive hit the first to report over-limit.
    const { data: underLimit, error } = await db.rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_max: alertAt - 1,
    });
    if (error) {
      log.error("streak", { msg: "tracking failed", key }, error);
      return false;
    }
    return underLimit === false;
  } catch (err) {
    log.error("streak", { msg: "tracking threw", key }, err);
    return false;
  }
}

/**
 * Consecutive-failure streak for a periodic job (#486/#43): the first failure
 * stays quiet so a transient Google blip never pages anyone; the second
 * consecutive one alerts. This is `recordConsecutiveStreak` at a threshold of 2.
 */
export async function recordFailureStreak(
  key: string,
  windowSeconds: number,
): Promise<boolean> {
  return recordConsecutiveStreak(key, windowSeconds, 2);
}

/** Clear a failure streak after a clean pass. Best-effort. */
export async function clearFailureStreak(key: string): Promise<void> {
  try {
    // write-ok: a refused clear leaves the streak, so the next failure counts from a higher number and alerts sooner. It never suppresses one.
    await supabaseAdmin().from("rate_limits").delete().eq("key", key);
  } catch {
    // A tracking miss must never break the caller.
  }
}
