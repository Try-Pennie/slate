import { resolveChannels } from "@/lib/notify/channels";
import type { MonitorAlertConfig } from "@/lib/db/types";

/**
 * Which channel each destination ACTUALLY posts to, and where that came from
 * (#1957).
 *
 * The panel used to describe the rules in prose ("Blank uses the
 * server-configured channel. The info channel falls back to the alerts
 * channel") and leave the reader to run them in their head against two fields
 * that were usually both blank. Everything on screen was true and the one
 * question being asked, where does an alert land, was answered by nobody.
 *
 * The VALUE here is taken straight from `resolveChannels`, the same function the
 * notifier uses, rather than recomputed beside it. A panel that worked the
 * precedence out for itself would be a second implementation of the rule and
 * would drift, and it would drift in the direction of reassurance: it would go
 * on naming a destination after the sender had stopped using it (L70, L41).
 * Only the ORIGIN is derived here, and it is derived from the same inputs.
 */

export type ChannelOrigin =
  /** Set in this form, stored in `monitor_alert_config`. */
  | "form"
  /** Not set here: the deployment's own environment supplies it. */
  | "server"
  /** Info only: nothing names it, so it rides along with the alerts channel. */
  | "alerts-fallback"
  /** Nothing anywhere. Alerts of this kind reach Slack nowhere. */
  | "none";

export interface EffectiveChannel {
  /** Empty string when nothing is configured, matching `resolveChannels`. */
  channel: string;
  origin: ChannelOrigin;
}

const set = (s: string | null | undefined): boolean => Boolean(s && s.trim());

export function effectiveChannels(
  config: Pick<MonitorAlertConfig, "alerts_channel" | "info_channel"> | null,
  env: { alertsEnv: string; infoEnv: string },
): { alerts: EffectiveChannel; info: EffectiveChannel } {
  const resolved = resolveChannels(config, env);
  const alertsOrigin: ChannelOrigin = set(config?.alerts_channel)
    ? "form"
    : set(env.alertsEnv)
      ? "server"
      : "none";
  const infoOrigin: ChannelOrigin = set(config?.info_channel)
    ? "form"
    : set(env.infoEnv)
      ? "server"
      : resolved.alerts
        ? "alerts-fallback"
        : "none";
  return {
    alerts: { channel: resolved.alerts, origin: alertsOrigin },
    info: { channel: resolved.info, origin: infoOrigin },
  };
}

/**
 * What the panel says about one destination.
 *
 * `name` is the channel's own name where Slack has given us one, and passing it
 * is the issue's title: a person reads `#alerts`, not `C09F4L6PLQP`. The id
 * still rides along in parentheses, because it is what is stored and what
 * anybody comparing this screen against the field below is looking at.
 *
 * Naming the channel is ALSO the confirmation. A name cannot be derived from an
 * id, so its presence is proof Slack answered about this exact channel, which is
 * why an ok check needs no second sentence beneath (L146: the difference is what
 * carries the information).
 *
 * The unconfigured case is the one that has to be loud. It is not a neutral
 * default: no alert of that kind reaches Slack at all, and the only other record
 * of that is a log line nobody is watching (L67, L10).
 */
export function effectiveChannelLine(
  what: string,
  eff: EffectiveChannel,
  name?: string | null,
): string {
  const where = name ? `#${name} (${eff.channel})` : eff.channel;
  switch (eff.origin) {
    case "form":
      return `${what} post to ${where}, set here.`;
    case "server":
      return `${what} post to ${where}, from this deployment's own settings.`;
    case "alerts-fallback":
      return `${what} post to ${where}, the same place as the urgent alerts.`;
    case "none":
      return `${what} reach Slack nowhere. Nothing names a channel here or on the server, so they are written to the logs and nobody is told.`;
  }
}
