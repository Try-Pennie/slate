/**
 * What somebody typed into a Slack channel field, read against Slack's channel
 * list (#2438).
 *
 * The three channel fields on /admin/alerts store a channel ID, because that is
 * what `conversations.info` checks and what a post is sent to. People think in
 * names. Before this a NAME typed into the field went to Slack as if it were an
 * ID and came back "Slack has no channel dan-systems-test", which is true and
 * names the wrong mistake: the channel existed, the input was the wrong kind.
 *
 * So one function decides what a typed value means, and BOTH sides call it: the
 * picker, to show the name and submit the ID, and the save action, which is the
 * one that decides. A field that accepted what the save refuses would be a mask
 * looser than its validator (L99).
 *
 * Pure, with no imports, so the client bundle and the server read the same rule.
 */

/** One channel from Slack's list, as the picker and the save read it. */
export interface SlackChannelOption {
  id: string;
  name: string;
  /** Whether the Slate app is in the channel. An alert posts only where it is. */
  isMember: boolean;
}

/**
 * Slack's channel list, or the fact that it could not be read.
 *
 * Unreadable is its OWN state rather than an empty list, because the two say
 * different things to somebody who typed a name: "no channel by that name" and
 * "Slate could not look". An empty list standing for both would refuse a real
 * channel with a sentence claiming it does not exist (L10, L11).
 *
 * `complete` is false when the paging stopped short (a later page failed, or the
 * bound was reached), so a miss can say it was judged against part of the list.
 */
export type SlackChannelListing =
  | { readable: true; channels: SlackChannelOption[]; complete: boolean }
  | { readable: false; why: string };

/** What a typed value turns out to be. `value` null is a blank field: use the default. */
export type ChannelResolution =
  | { ok: true; value: string | null }
  | { ok: false; reason: "no-match"; name: string; complete: boolean }
  | { ok: false; reason: "listing-unreadable"; name: string };

/**
 * A Slack conversation ID: C (public channel), G (private, older) or D (direct
 * message), then upper case letters and digits. Slack requires channel NAMES to
 * be lower case, so a value of this shape is never a name.
 */
const CHANNEL_ID = /^[CGD][A-Z0-9]{8,}$/;

export function looksLikeChannelId(raw: string): boolean {
  return CHANNEL_ID.test(raw.trim());
}

/** A typed value as a name: no surrounding space, no leading hash, lower case. */
function asName(raw: string): string {
  return raw.trim().replace(/^#+/, "").trim().toLowerCase();
}

/** How a listed channel is written everywhere a person reads it. */
export function channelLabel(c: SlackChannelOption): string {
  return `#${c.name}`;
}

/**
 * The way out of every channel refusal, one short instruction (Dan's plain error
 * copy rule: one line of what went wrong, one short instruction, never a
 * paragraph). Shared so the field, the save and the panel say it the same way.
 */
export const CHANNEL_WAY_OUT = "Pick one from the list or paste its channel ID.";

/**
 * What a typed value means.
 *
 * `names` are the names Slack gave for the STORED channels when they were checked
 * by id (`channelNames`). A private channel is never in the public list, so this
 * is the only way its name can be typed back, and it is the name the field itself
 * displays (#2438 review). The list wins where both hold a name, so one name never
 * means two channels.
 */
export function resolveChannelInput(
  raw: string,
  listing: SlackChannelListing | null,
  names: Readonly<Record<string, string>> = {},
): ChannelResolution {
  const typed = raw.trim();
  if (typed === "") return { ok: true, value: null };
  const name = asName(typed);

  if (listing?.readable) {
    const byId = listing.channels.find((c) => c.id === typed);
    if (byId) return { ok: true, value: byId.id };
    const byName = listing.channels.find((c) => c.name.toLowerCase() === name);
    if (byName) return { ok: true, value: byName.id };
  }
  const stored = Object.entries(names).find(([, n]) => n.toLowerCase() === name);
  if (stored) return { ok: true, value: stored[0] };
  // An ID the list does not hold is still a real candidate: a private channel is
  // never in the list Slate reads, and that is why the field is typeable at all.
  // The save asks Slack about it directly (`conversations.info`).
  if (looksLikeChannelId(typed)) return { ok: true, value: typed };

  const shown = typed.replace(/^#+/, "").trim();
  if (!listing?.readable) return { ok: false, reason: "listing-unreadable", name: shown };
  return { ok: false, reason: "no-match", name: shown, complete: listing.complete };
}

/** The note under a picked channel Slate is not in: the save would refuse it. */
export function notInChannelNote(c: SlackChannelOption): string {
  return `Slate is not in ${channelLabel(c)}. Invite the Slate app before saving.`;
}

/** The sentence a refused value gets: what was wrong, then the way out. */
export function channelInputMessage(
  refusal: Extract<ChannelResolution, { ok: false }>,
): string {
  if (refusal.reason === "listing-unreadable") {
    return `Slate could not read Slack's channel list to find #${refusal.name}. Paste its channel ID instead.`;
  }
  // A partial list may only claim the part it read (L11).
  const where = refusal.complete ? "" : " in the part of Slack's list Slate could read";
  return `No channel called #${refusal.name}${where}. ${CHANNEL_WAY_OUT}`;
}

/**
 * What the box shows for a stored value: the channel's name when the list holds
 * its ID, else the name Slack gave when asked about that ID directly (`names`,
 * which is how a PRIVATE channel, never in the list, still reads by name), else
 * the value itself. Never a guessed name: an ID cannot be turned into a name
 * without Slack, so one nothing has named shows bare.
 */
export function channelText(
  value: string,
  channels: SlackChannelOption[],
  names: Readonly<Record<string, string>> = {},
): string {
  if (value === "") return "";
  const c = channels.find((ch) => ch.id === value);
  if (c) return channelLabel(c);
  const named = Object.hasOwn(names, value) ? names[value] : undefined;
  return named ? `#${named}` : value;
}

/**
 * The channels offered for what is typed so far.
 *
 * Names starting with the query come first, then names containing it, each group
 * keeping the list's own order (channels Slate is in first). A pasted ID finds its
 * own channel, so a person who pasted one sees which channel it is.
 */
export function filterChannels(
  channels: SlackChannelOption[],
  query: string,
): SlackChannelOption[] {
  const q = asName(query);
  if (q === "") return channels;
  const idQuery = query.trim().toUpperCase();
  const starts: SlackChannelOption[] = [];
  const contains: SlackChannelOption[] = [];
  for (const c of channels) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) starts.push(c);
    else if (name.includes(q) || (idQuery.length >= 3 && c.id.startsWith(idQuery))) contains.push(c);
  }
  return [...starts, ...contains];
}
