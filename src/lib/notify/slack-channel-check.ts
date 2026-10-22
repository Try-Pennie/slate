/**
 * What a Slack channel id turns out to be, when somebody saves one (#1957).
 *
 * ## Why this is checked at SAVE time and nowhere else
 *
 * The field accepted any string, so a typo sent every alert nowhere. The send
 * path itself is not the problem and was fixed deliberately in #1035: a failed
 * post is logged with its Slack error and stamps only a short retry window
 * rather than burning the full cooldown.
 *
 * The residual is that the only signal is a `log.warn`, and that is CORRECT: the
 * paging channel cannot page about itself. So a wrong id degrades all alerting
 * to log only and nothing can alert about it by construction, with seven day
 * retention and no alerting on top.
 *
 * Save time is therefore the one place this can be caught: it is the only moment
 * a person is looking at the screen.
 *
 * ## Why an unverifiable answer is its own outcome
 *
 * `conversations.info` needs `channels:read`, which the Slate app turns out to
 * carry already (measured 2026-09-06; #1957 assumed it did not and that a Slack
 * app change was a prerequisite). A PRIVATE channel needs `groups:read`, which
 * has not been measured, and Slack answers `missing_scope` for a scope it lacks.
 *
 * That answer is neither a good channel nor a bad one. Scoring it as either
 * would be the whole defect again: as good, a typo still ships; as bad, a
 * correct channel is refused and nobody can save anything. So it is a third
 * outcome that SAYS SO, and the panel repeats it.
 */
import { WHERE_TO_FIND_CHANNEL_ID } from "@/lib/notify/slack-channel-input";

export type ChannelCheck =
  /** Slack confirmed it, and the bot can post there. */
  | { state: "ok"; name: string | null }
  /** Slack says no such channel: almost always a typo in the id. */
  | { state: "not-found" }
  /** The channel exists and the bot is not in it, which is an invite, not a typo. */
  | { state: "not-invited"; name: string | null }
  /** Slate cannot ask. Not a verdict about the channel. */
  | { state: "cannot-check"; why: string };

/** What the person reads. One sentence per outcome, each naming a DIFFERENT
 *  next move, because a wrong id and an uninvited bot are different problems
 *  with different remedies (L11). */
export function channelCheckMessage(check: ChannelCheck, channel: string): string {
  switch (check.state) {
    case "ok":
      return check.name ? `Checked: ${channel} is #${check.name}.` : `Checked: ${channel} exists.`;
    case "not-found":
      // #2438: says where the right id is, since "check the id" alone sends the
      // reader to look without saying where (L111).
      return `Slack has no channel ${channel}. Check the id: an alert sent to a channel that does not exist goes nowhere and nothing can tell you. ${WHERE_TO_FIND_CHANNEL_ID}`;
    case "not-invited":
      return `Slate is not in ${check.name ? `#${check.name}` : channel}. Invite the Slate app to that channel, then save again.`;
    case "cannot-check":
      return `Saved, but Slate could not check this channel (${check.why}). It cannot confirm alerts will arrive there.`;
  }
}

/** Whether a save should be REFUSED on this outcome. */
export function refusesSave(check: ChannelCheck): boolean {
  return check.state === "not-found" || check.state === "not-invited";
}

/**
 * Read Slack's own answer into one of the four outcomes.
 *
 * Kept pure and separate from the call so every branch is driven offline: a
 * hand written double of Slack agrees with our assumption about its replies by
 * construction (L52), so what is pinned here is the MAPPING, against the error
 * strings Slack's own documentation names.
 */
export function readChannelReply(reply: {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}): ChannelCheck {
  if (reply.ok) {
    const ch = reply.data?.channel as { name?: string; is_member?: boolean } | undefined;
    const name = typeof ch?.name === "string" ? ch.name : null;
    // `is_member: false` is the channel existing with the bot outside it, which
    // is the one Slack answers 200 for and which would otherwise read as fine.
    if (ch && ch.is_member === false) return { state: "not-invited", name };
    return { state: "ok", name };
  }
  switch (reply.error) {
    case "channel_not_found":
      return { state: "not-found" };
    case "not_in_channel":
      return { state: "not-invited", name: null };
    // Everything below is Slate being unable to ASK, never a verdict about the
    // channel. `missing_scope` is the expected one until the Slack app is given
    // `channels:read`.
    case "missing_scope":
    case "not_allowed_token_type":
      return { state: "cannot-check", why: "the Slate app has not been given permission to read channels" };
    case "slack-not-configured":
      return { state: "cannot-check", why: "no Slack token is configured here" };
    default:
      return { state: "cannot-check", why: reply.error ?? "Slack did not answer" };
  }
}

/** The channel's own name where Slack gave one, else `null`. Never invented: an
 *  id cannot be turned into a name locally, so a null here means Slate did not
 *  ask successfully rather than that the channel has no name. */
export function checkedName(check: ChannelCheck): string | null {
  return check.state === "ok" || check.state === "not-invited" ? check.name : null;
}

/**
 * The names Slack gave for each checked id, for the channel fields (#2438).
 *
 * A private channel is never in the list the picker reads, so without this a
 * stored private channel showed as its bare id. The panel already asks Slack
 * about every stored channel, and those answers carry the name, so the fields
 * read them rather than asking again. An id with no named answer is left out.
 */
export function channelNames(checks: ReadonlyMap<string, ChannelCheck>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, check] of checks) {
    const name = checkedName(check);
    if (name) out[id] = name;
  }
  return out;
}

/** Whether the outcome still needs a sentence of its own beneath the line.
 *
 *  A confirmed channel does not: the line already names it, and a name is proof
 *  Slack answered. Everything else does, because everything else is either a
 *  fault with a remedy or an admission that nothing was checked. */
export function needsFollowUp(check: ChannelCheck): boolean {
  return !(check.state === "ok" && check.name !== null);
}
