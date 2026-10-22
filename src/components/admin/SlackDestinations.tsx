import { effectiveChannelLine, effectiveChannels } from "@/lib/notify/channel-effective";
import {
  channelCheckMessage,
  checkedName,
  needsFollowUp,
  type ChannelCheck,
} from "@/lib/notify/slack-channel-check";
import { checkChannels } from "@/lib/notify/slack-channel-names";
import type { MonitorAlertConfig } from "@/lib/db/types";

/**
 * Where alerts actually land, and whether Slate can confirm it (#1957).
 *
 * Two things the panel could not do before. It could not say the DESTINATION:
 * both fields are usually blank, the prose described the precedence rules, and
 * the reader had to run them in their head. And it could not say whether the
 * destination was REAL, which is the more valuable half, because a wrong channel
 * id degrades all alerting to log only and nothing can alert about it by
 * construction.
 *
 * It used to draw the channel fields' native datalist element too. That is gone
 * (#2438): each field is a `SlackChannelField` with its own Slate styled list.
 *
 * It is drawn on every render rather than only after a save, because those are
 * STANDING conditions rather than events: a channel the bot was never invited to
 * is wrong every day until somebody invites it, and a notice that clears would
 * name it once and then leave the fault in place with the remedy gone (L126).
 *
 * It never throws: `checkChannels` maps every Slack reply, including no reply at
 * all, to an outcome that says which one it is. A panel about the alerting is a
 * poor place to take a page down.
 */

export async function SlackDestinations({
  config,
  envAlerts,
  envInfo,
  checks: started,
}: {
  config: Pick<MonitorAlertConfig, "alerts_channel" | "info_channel"> | null;
  envAlerts: string;
  envInfo: string;
  /** The page's own `checkChannels`, so Slack is asked once per render. */
  checks?: Promise<Map<string, ChannelCheck>>;
}) {
  const eff = effectiveChannels(config, { alertsEnv: envAlerts, infoEnv: envInfo });
  const checks = await (started ?? checkChannels([eff.alerts.channel, eff.info.channel]));

  const row = (what: string, dest: typeof eff.alerts) => {
    const check = checks.get(dest.channel) ?? null;
    return {
      line: effectiveChannelLine(what, dest, check ? checkedName(check) : null),
      follow: check && needsFollowUp(check) ? channelCheckMessage(check, dest.channel) : null,
      unset: dest.origin === "none",
    };
  };
  const rows = [row("Urgent alerts", eff.alerts), row("Quiet notices", eff.info)];
  // One channel serving both destinations is the commonest configuration, and
  // its verdict is one finding about one thing: printed twice it reads as two.
  const sameChannel = eff.alerts.channel !== "" && eff.alerts.channel === eff.info.channel;

  return (
    <dl className="mb-4 space-y-2 text-xs">
      {rows.map((r, i) => (
        <div key={r.line}>
          <dt className={r.unset ? "text-error" : "text-fg"}>{r.line}</dt>
          {r.follow && !(i === 1 && sameChannel) ? (
            <dd className="text-fg-muted">{r.follow}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
