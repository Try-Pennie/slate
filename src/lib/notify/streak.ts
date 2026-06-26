import { supabaseAdmin } from "@/lib/supabase/admin";
import { isConsecutiveFailure } from "@/lib/notify/alerts";

/**
 * Persistent consecutive-failure streak for a periodic job (#486), built on the
 * #31 `rate_limit_hit` SQL function: each failing pass bumps a per-key count
 * inside a window, a clean pass clears it. Mirrors the sync lane's inline streak
 * (`/api/cron/sync`) so a one-off blip stays quiet and only consecutive failures
 * alert. Tracking is best-effort: a tracking miss must never break the caller, so
 * it returns false (stay quiet) rather than throwing.
 *
 * `windowSeconds` must comfortably exceed the job's interval so two genuinely
 * consecutive passes both land in the same window (otherwise each failure looks
 * like the first).
 */
export async function recordFailureStreak(
  key: string,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const db = supabaseAdmin();
    const { data: underLimit, error } = await db.rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_max: 1,
    });
    if (error) {
      console.error(`failure-streak tracking failed for ${key}: ${error.message}`);
      return false;
    }
    // rate_limit_hit returns false once the count exceeds 1 in the window, i.e.
    // from the second consecutive failing pass onward.
    return isConsecutiveFailure(underLimit === false ? 2 : 1);
  } catch (err) {
    console.error(
      `failure-streak tracking threw for ${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Clear a failure streak after a clean pass. Best-effort. */
export async function clearFailureStreak(key: string): Promise<void> {
  try {
    await supabaseAdmin().from("rate_limits").delete().eq("key", key);
  } catch {
    // A tracking miss must never break the caller.
  }
}
