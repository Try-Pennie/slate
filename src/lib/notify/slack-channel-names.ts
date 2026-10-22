import { fetchSlackChannel } from "@/lib/notify/slack";
import { readChannelReply, type ChannelCheck } from "@/lib/notify/slack-channel-check";

/**
 * Slack's answer about each DISTINCT channel id, asked once (#1957, #2438).
 *
 * In the ordinary configuration both alert destinations resolve to the same id,
 * so a check per destination is two identical calls to Slack for one answer
 * (L573).
 *
 * Three readers share it. The destinations panel says where alerts land; the
 * channel fields and the save read the NAMES in it (`channelNames`), because a
 * private channel is never in Slack's public channel list and its name is only
 * ever known from this check. The alerts page starts it once per render and
 * hands the same answers to the panel and the fields.
 *
 * Never throws: `fetchSlackChannel` returns Slack's reply as a value, and
 * `readChannelReply` maps every reply, no reply included, to an outcome.
 */
export async function checkChannels(channels: string[]): Promise<Map<string, ChannelCheck>> {
  const distinct = [...new Set(channels.filter(Boolean))];
  const checks = await Promise.all(
    distinct.map(async (c) => readChannelReply(await fetchSlackChannel(c))),
  );
  return new Map(distinct.map((c, i) => [c, checks[i]]));
}
