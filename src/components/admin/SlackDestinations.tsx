import { effectiveChannelLine, effectiveChannels } from "@/lib/notify/channel-effective";
import {
  channelCheckMessage,
  checkedName,
  needsFollowUp,
  readChannelReply,
  type ChannelCheck,
} from "@/lib/notify/slack-channel-check";
import { fetchSlackChannel, listSlackChannels } from "@/lib/notify/slack";
import type { MonitorAlertConfig } from "@/lib/db/types";

/**
 * Where alerts actually land, whether Slate can confirm it, and the list of
 * channels to pick from (#1957).
 *
 * Three things the panel could not do before. It could not say the DESTINATION:
 * both fields are usually blank, the prose described the precedence rules, and
 * the reader had to run them in their head. It could not say whether the
 * destination was REAL, which is the more valuable half, because a wrong channel
 * id degrades all alerting to log only and nothing can alert about it by
 * construction. And it could not offer a NAME: the field took an id typed from
 * memory.
 *
 * It is drawn on every render rather than only after a save, because those are
 * STANDING conditions rather than events: a channel the bot was never invited to
 * is wrong every day until somebody invites it, and a notice that clears would
 * name it once and then leave the fault in place with the remedy gone (L126).
 *
 * It never throws. `fetchSlackChannel` returns Slack's reply as a value and
 * `readChannelReply` maps every reply, including no reply at all, to an outcome
 * that says which one it is; `listSlackChannels` answers with an empty list it
 * cannot read. A panel about the alerting is a poor place to take a page down.
 */

/** The id every channel field points its `list` at. Exported so the page cannot
 *  spell it differently from the datalist that has to answer to it. */
export const SLACK_CHANNEL_LIST_ID = "slack-channel-options";

/**
 * The check for each DISTINCT channel, asked once.
 *
 * In the ordinary configuration both destinations resolve to the same id, so a
 * check per destination is two identical calls to Slack on every render of this
 * page for one answer (L573).
 */
async function checkDistinct(channels: string[]): Promise<Map<string, ChannelCheck>> {
  const distinct = [...new Set(channels.filter(Boolean))];
  const checks = await Promise.all(
    distinct.map(async (c) => readChannelReply(await fetchSlackChannel(c))),
  );
  return new Map(distinct.map((c, i) => [c, checks[i]]));
}

export async function SlackDestinations({
  config,
  envAlerts,
  envInfo,
}: {
  config: Pick<MonitorAlertConfig, "alerts_channel" | "info_channel"> | null;
  envAlerts: string;
  envInfo: string;
}) {
  const eff = effectiveChannels(config, { alertsEnv: envAlerts, infoEnv: envInfo });
  const [checks, options] = await Promise.all([
    checkDistinct([eff.alerts.channel, eff.info.channel]),
    listSlackChannels(),
  ]);

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
    <>
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
      {/* The suggestions for both fields. A datalist SUGGESTS without
          restricting, so a private channel (which needs a scope this may not
          have) or one past the paging bound is still reachable by typing its id,
          and is then checked at save like any other. A select would have refused
          it outright (L568). */}
      <datalist id={SLACK_CHANNEL_LIST_ID}>
        {options.map((c) => (
          <option key={c.id} value={c.id} label={`#${c.name}${c.isMember ? "" : " (Slate is not in it)"}`} />
        ))}
      </datalist>
    </>
  );
}
