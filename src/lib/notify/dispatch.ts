import { supabaseAdmin } from "@/lib/supabase/admin";
import { postSlack, slackConfigured } from "@/lib/notify/slack";
import { shouldSendAlert, alertStampMs } from "@/lib/notify/alerts";
import { defaultInfoChannel } from "@/lib/notify/channels";
import { log } from "@/lib/log";

/**
 * Post a Slack message at most once per cooldown for a given key, using the
 * `alert_state` table as the persistent cooldown (the cron runs every minute,
 * so a persistent fault must not spam). No-op when Slack is unconfigured.
 * `channel` defaults to the alerts channel; pass a quieter one for info signals.
 */
export async function sendThrottledAlert(
  key: string,
  cooldownMs: number,
  text: string,
  channel?: string,
): Promise<void> {
  if (!slackConfigured()) return;
  const db = supabaseAdmin();
  const { data } = await db
    .from("alert_state")
    .select("last_sent_at")
    .eq("key", key)
    .maybeSingle();
  const lastSentAtMs = data
    ? Date.parse((data as { last_sent_at: string }).last_sent_at)
    : null;
  const nowMs = Date.now();
  if (!shouldSendAlert(lastSentAtMs, nowMs, cooldownMs)) return;

  const result = await postSlack({ text, ...(channel ? { channel } : {}) });
  // Fail loud (#1035): a not-ok send used to be invisible AND burned the full
  // cooldown, silently muting this alert for 15-60+ min. Surface it in the logs
  // (the paging channel can't page about itself) and stamp only a short retry
  // window so the every-minute cron re-attempts soon. A stamp still goes down on
  // failure so a hard-down Slack can't be spammed; it's just a shorter mute.
  if (!result.ok) {
    log.warn("slack-alert", { msg: "send failed", key, error: result.error ?? null });
  }
  await db
    .from("alert_state")
    .upsert(
      { key, last_sent_at: new Date(alertStampMs(result.ok, nowMs, cooldownMs)).toISOString() },
      { onConflict: "key" },
    );
}

/**
 * Low-priority, visibility-only variant (#567): same throttle, but posts to the
 * info channel so it never pages the alerts channel. The info channel is now
 * UI-tunable (#571): store > env, falling back to the resolved alerts channel so
 * the signal is never silently lost. Still no-ops when nothing is configured.
 */
export async function sendThrottledInfo(
  key: string,
  cooldownMs: number,
  text: string,
): Promise<void> {
  const channel = await defaultInfoChannel();
  if (!channel) return;
  await sendThrottledAlert(key, cooldownMs, text, channel);
}
