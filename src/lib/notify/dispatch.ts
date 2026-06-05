import { supabaseAdmin } from "@/lib/supabase/admin";
import { postSlack, slackConfigured } from "@/lib/notify/slack";
import { shouldSendAlert } from "@/lib/notify/alerts";

/**
 * Post a Slack alert at most once per cooldown for a given key, using the
 * `alert_state` table as the persistent cooldown (the cron runs every minute,
 * so a persistent fault must not spam). No-op when Slack is unconfigured.
 */
export async function sendThrottledAlert(
  key: string,
  cooldownMs: number,
  text: string,
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

  await postSlack({ text });
  // Stamp regardless of delivery result so a flaky Slack can't be spammed.
  await db
    .from("alert_state")
    .upsert({ key, last_sent_at: new Date().toISOString() }, { onConflict: "key" });
}
