import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MonitorAlertConfig } from "@/lib/db/types";
import { log } from "@/lib/log";

/**
 * App-wide default Slack destinations (#571). The store's channels override the
 * env-configured channels for ALL alerts, so the destination is tunable without
 * a redeploy. Precedence store > env > default; the info channel falls back to
 * the RESOLVED alerts channel so a quiet signal is never silently lost. Reads
 * the RAW env channels separately (not the collapsed `slackInfoChannel()`), so
 * a store-set alerts channel still governs the info fallback.
 *
 * The resolved config is cached in-process briefly so this doesn't add a DB read
 * to every Slack post; a fresh isolate simply reads once. NEVER throws: any DB
 * error falls back to env so notifications can't be broken by their own config,
 * and that fallback is logged and never cached (#3121).
 */

const nonEmpty = (s: string | null | undefined): string => (s && s.trim() ? s : "");

export function resolveChannels(
  config: Pick<MonitorAlertConfig, "alerts_channel" | "info_channel"> | null,
  env: { alertsEnv: string; infoEnv: string },
): { alerts: string; info: string } {
  const alerts = nonEmpty(config?.alerts_channel) || nonEmpty(env.alertsEnv) || "";
  const info = nonEmpty(config?.info_channel) || nonEmpty(env.infoEnv) || alerts || "";
  return { alerts, info };
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; value: { alerts: string; info: string } } | null = null;

async function resolvedChannels(nowMs: number): Promise<{ alerts: string; info: string }> {
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.value;
  let config: Pick<MonitorAlertConfig, "alerts_channel" | "info_channel"> | null = null;
  let readable = true;
  try {
    const { data, error } = await supabaseAdmin()
      .from("monitor_alert_config")
      .select("alerts_channel, info_channel")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      readable = false;
      log.warn("alert-channels", { msg: "channel config unreadable, posting to the env channels" }, error);
    } else if (data) {
      config = data as Pick<MonitorAlertConfig, "alerts_channel" | "info_channel">;
    }
  } catch (err) {
    // Fall through to env (config must never break notifications).
    readable = false;
    log.warn("alert-channels", { msg: "channel config read threw, posting to the env channels" }, err);
  }
  const value = resolveChannels(config, {
    alertsEnv: process.env.SLACK_ALERTS_CHANNEL ?? "",
    infoEnv: process.env.SLACK_INFO_CHANNEL ?? "",
  });
  // #3121: only a READ is cached. A fallback cached for a minute kept a store-set
  // channel replaced by the env one long after the store was readable again, and
  // with no line saying so. An empty store (no row) is a real answer and caches.
  if (readable) cache = { at: nowMs, value };
  return value;
}

/** App-wide default alerts channel (store > env). Empty string = unconfigured. */
export async function defaultAlertsChannel(): Promise<string> {
  return (await resolvedChannels(Date.now())).alerts;
}

/** App-wide default info channel (store > env > resolved alerts channel). */
export async function defaultInfoChannel(): Promise<string> {
  return (await resolvedChannels(Date.now())).info;
}

/** Clear the in-process cache so a change takes effect immediately. Called by the
 *  alert settings save action, so a newly saved channel is used on the next post. */
export function clearChannelCache(): void {
  cache = null;
}
