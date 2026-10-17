import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { noteAlertKey } from "@/lib/notify/alert-recording";

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
  return (await trackConsecutiveStreak(key, windowSeconds, alertAt)) === "reached";
}

/**
 * The same count, answered three ways (#1493): `reached`, `below`, or `unknown` when
 * the count could not be read. `recordConsecutiveStreak` folds `unknown` into quiet,
 * which is right for a caller whose first hit is quiet anyway. A caller holding a
 * failure ONLY because it can count on hearing the next one must speak on `unknown`
 * instead, so it needs the difference.
 */
export async function trackConsecutiveStreak(
  key: string,
  windowSeconds: number,
  alertAt: number,
): Promise<"reached" | "below" | "unknown"> {
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
      return "unknown";
    }
    if (typeof underLimit !== "boolean") {
      log.error("streak", { msg: "tracking answered no verdict", key });
      return "unknown";
    }
    const reached = underLimit === false;
    // Tracked and deliberately QUIET: the caller's own decision about this failure
    // is to say nothing yet, so the generic lane page must not overrule it (#3133
    // follow-up, see alert-recording.ts). A streak that REACHED its threshold is not
    // noted here: the caller is about to send, and the send notes itself only if it
    // returns, so a send that fails still leaves the failure one message.
    if (!reached) noteAlertKey(key);
    return reached ? "reached" : "below";
  } catch (err) {
    log.error("streak", { msg: "tracking threw", key }, err);
    return "unknown";
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
