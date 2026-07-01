import { supabaseAdmin } from "@/lib/supabase/admin";
import { postSlack, slackConfigured } from "@/lib/notify/slack";
import { shouldSendAlert } from "@/lib/notify/alerts";
import { slackInfoChannel } from "@/lib/env";

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
  if (!shouldSendAlert(lastSentAtMs, Date.now(), cooldownMs)) return;

  await postSlack({ text, ...(channel ? { channel } : {}) });
  // Stamp regardless of delivery result so a flaky Slack can't be spammed.
  await db
    .from("alert_state")
    .upsert({ key, last_sent_at: new Date().toISOString() }, { onConflict: "key" });
}

/**
 * Low-priority, visibility-only variant (#567): same throttle, but posts to the
 * info channel so it never pages the alerts channel. Silently no-ops when no
 * info channel is configured (it defaults to the alerts channel via env).
 */
export async function sendThrottledInfo(
  key: string,
  cooldownMs: number,
  text: string,
): Promise<void> {
  const channel = slackInfoChannel();
  if (!channel) return;
  await sendThrottledAlert(key, cooldownMs, text, channel);
}
