// #2438: what somebody TYPED into a Slack channel field, read against the channel
// list, on both sides of the save.
//
// The field takes a channel by name or an ID. The picker submits the ID of a
// channel picked from the list, but a person can still type a name and press Save,
// or paste an ID the list cannot see (a private channel). So one pure function
// decides what a typed value means, and the picker and the save action both call
// it, which is what keeps the client from accepting what the server refuses (L99).
//
// Every refusal is pinned against its sentence, because the defect this issue
// opened with was a true refusal that named the wrong mistake: a NAME sent to a
// lookup that takes an ID, answered "Slack has no channel dan-systems-test", and
// read as the channel not existing (L11, L111).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-slack-channel-input.ts
import {
  channelInputMessage,
  channelText,
  filterChannels,
  looksLikeChannelId,
  resolveChannelInput,
  WHERE_TO_FIND_CHANNEL_ID,
  type SlackChannelListing,
  type SlackChannelOption,
} from "../src/lib/notify/slack-channel-input.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const statuspage: SlackChannelOption = { id: "C08A3BYMB29", name: "statuspage", isMember: true };
const systems: SlackChannelOption = { id: "C09F4L6PLQP", name: "dan-systems-test", isMember: true };
const random: SlackChannelOption = { id: "C024BE91L", name: "random", isMember: false };
const channels = [statuspage, systems, random];
const listing: SlackChannelListing = { readable: true, channels, complete: true };
const unreadable: SlackChannelListing = { readable: false, why: "missing_scope" };

// --- what counts as an ID -----------------------------------------------------
// Slack channel IDs are upper case letters and digits behind a C (public), G
// (private, older) or D (a direct message). Names are lower case by Slack's own
// rule, so the two shapes cannot collide.
assert(looksLikeChannelId("C08A3BYMB29"), "an eleven character channel ID is an ID");
assert(looksLikeChannelId("C024BE91L"), "a nine character (older) channel ID is an ID");
assert(looksLikeChannelId("G01ABCDEFGH"), "a private channel ID is an ID");
assert(!looksLikeChannelId("statuspage"), "a channel name is not an ID");
assert(!looksLikeChannelId("#statuspage"), "a hash name is not an ID");
assert(!looksLikeChannelId("c08a3bymb29"), "lower case is a name shape, never an ID");
assert(!looksLikeChannelId("C-TYPO"), "punctuation is not an ID");
assert(!looksLikeChannelId("C12"), "too short to be an ID");

// --- resolution ---------------------------------------------------------------
eq(resolveChannelInput("", listing), { ok: true, value: null }, "blank means use the default");
eq(resolveChannelInput("   ", listing), { ok: true, value: null }, "spaces are blank");
eq(resolveChannelInput("", null), { ok: true, value: null }, "blank needs no list at all");

eq(
  resolveChannelInput("statuspage", listing),
  { ok: true, value: "C08A3BYMB29" },
  "THE ISSUE: a typed name is stored as its ID",
);
eq(
  resolveChannelInput("#statuspage", listing),
  { ok: true, value: "C08A3BYMB29" },
  "a name typed with its hash resolves the same way",
);
eq(
  resolveChannelInput("  #StatusPage ", listing),
  { ok: true, value: "C08A3BYMB29" },
  "case and surrounding spaces do not matter to a name",
);
eq(
  resolveChannelInput("dan-systems-test", listing),
  { ok: true, value: "C09F4L6PLQP" },
  "the name the issue was opened with resolves",
);
eq(
  resolveChannelInput("random", listing),
  { ok: true, value: "C024BE91L" },
  "a channel Slate is not in still resolves; the save's own check says to invite it",
);
eq(
  resolveChannelInput("C08A3BYMB29", listing),
  { ok: true, value: "C08A3BYMB29" },
  "an ID in the list is kept as it is",
);
eq(
  resolveChannelInput("G01PRIVATE9", listing),
  { ok: true, value: "G01PRIVATE9" },
  "a pasted ID the list cannot see (a private channel) is kept, for the save to check with Slack",
);
eq(
  resolveChannelInput("C08A3BYMB29", unreadable),
  { ok: true, value: "C08A3BYMB29" },
  "an ID needs no list, so an unreadable list does not refuse one",
);
eq(
  resolveChannelInput("C08A3BYMB29", null),
  { ok: true, value: "C08A3BYMB29" },
  "an ID needs no list, so none has to be fetched for it",
);

// FAILURE PATHS. A name that matches nothing, and a name with no list to read it
// against, are different problems and say different things (L11).
const noMatch = resolveChannelInput("#stauspage", listing);
eq(
  noMatch,
  { ok: false, reason: "no-match", name: "stauspage", complete: true },
  "a misspelt name is refused, with the name it was given",
);
const blind = resolveChannelInput("statuspage", unreadable);
eq(
  blind,
  { ok: false, reason: "listing-unreadable", name: "statuspage" },
  "a name with no readable list is refused rather than sent to Slack as an ID",
);
eq(
  resolveChannelInput("statuspage", null),
  { ok: false, reason: "listing-unreadable", name: "statuspage" },
  "a name with no list at all is refused the same way",
);
const partial: SlackChannelListing = { readable: true, channels, complete: false };
const partialMiss = resolveChannelInput("elsewhere", partial);
eq(
  partialMiss,
  { ok: false, reason: "no-match", name: "elsewhere", complete: false },
  "a miss against a partial list records that the list was partial",
);
eq(
  resolveChannelInput("C-TYPO", listing),
  { ok: false, reason: "no-match", name: "C-TYPO", complete: true },
  "something that is neither a listed name nor an ID shape is refused at the field",
);

// --- the sentences --------------------------------------------------------------
if (!noMatch.ok) {
  const m = channelInputMessage(noMatch);
  assert(m.includes("#stauspage"), `the refusal names what was typed (${m})`);
  assert(/cannot find a public channel/.test(m), "it says the NAME was not found, not that a channel does not exist");
  assert(/private/.test(m), "it says a private channel is only reachable by its ID");
  assert(m.includes(WHERE_TO_FIND_CHANNEL_ID), "it says where an ID is found");
  assert(!/part of/.test(m), "a complete list does not claim to be partial");
} else {
  assert(false, "the misspelt name was refused");
}
if (!partialMiss.ok) {
  assert(
    /only part of/.test(channelInputMessage(partialMiss)),
    "a miss against a partial list says the list was partial",
  );
} else {
  assert(false, "the partial miss was refused");
}
if (!blind.ok) {
  const m = channelInputMessage(blind);
  assert(/could not read Slack's channel list/.test(m), `the unreadable refusal names the real cause (${m})`);
  assert(m.includes("#statuspage"), "and what was typed");
  assert(m.includes(WHERE_TO_FIND_CHANNEL_ID), "and where an ID is found");
} else {
  assert(false, "the blind name was refused");
}
assert(
  /open the channel/.test(WHERE_TO_FIND_CHANNEL_ID) &&
    /About/.test(WHERE_TO_FIND_CHANNEL_ID) &&
    /bottom/.test(WHERE_TO_FIND_CHANNEL_ID),
  "the remedy walks Slack's own route to an ID: the channel, its name, About, the bottom",
);

// --- what the box shows ---------------------------------------------------------
eq(channelText("C08A3BYMB29", channels), "#statuspage", "a stored ID in the list shows by name");
eq(channelText("G01PRIVATE9", channels), "G01PRIVATE9", "a stored ID the list cannot see shows bare");
eq(channelText("", channels), "", "blank shows blank");
eq(channelText("C08A3BYMB29", []), "C08A3BYMB29", "with no list yet the ID shows bare, never a guess");
// A PRIVATE channel is never in the list, and the stored Info and Handoff channel
// on 2026-10-22 was one (#dan-systems-test). Its name comes from Slack's answer
// about that id, so the box still reads as a name rather than the bare id Dan
// reported (#2438).
eq(
  channelText("C09F4L6PLQP", [statuspage], { C09F4L6PLQP: "dan-systems-test" }),
  "#dan-systems-test",
  "a stored id the list does not hold shows by the name Slack gave for it",
);
eq(
  channelText("C08A3BYMB29", [statuspage], { C08A3BYMB29: "renamed-elsewhere" }),
  "#statuspage",
  "the list's name wins where the list holds the id",
);
eq(
  channelText("G01PRIVATE9", [statuspage], { C09F4L6PLQP: "dan-systems-test" }),
  "G01PRIVATE9",
  "an id nothing can name still shows bare",
);

// --- filtering, at the real count ---------------------------------------------
// About 150 channels is the scale this list is built for (#2438), so the fixture
// is that size rather than three rows that cannot show an ordering problem (L606).
const many: SlackChannelOption[] = [
  ...channels,
  ...Array.from({ length: 147 }, (_, i) => ({
    id: `C0${String(i).padStart(9, "0")}`,
    name: i % 7 === 0 ? `team-status-${i}` : `channel-${i}`,
    isMember: i % 3 === 0,
  })),
];
eq(filterChannels(many, "").length, 150, "an empty query offers every channel");
eq(filterChannels(many, "#").length, 150, "a bare hash is an empty query");
const sta = filterChannels(many, "sta");
eq(sta[0]?.name, "statuspage", "a name STARTING with the query comes before one merely containing it");
assert(
  sta.every((c) => c.name.includes("sta")),
  "every row offered for a query contains it",
);
assert(sta.length > 1, `the query also finds names containing it (${sta.length})`);
eq(filterChannels(many, "#STATUS")[0]?.name, "statuspage", "the hash and case are ignored while filtering");
eq(
  filterChannels(many, "C08A3B").map((c) => c.name),
  ["statuspage"],
  "a pasted ID finds its own channel, so the box can show the name",
);
eq(filterChannels(many, "nothing-like-this").length, 0, "a query matching nothing offers nothing");

finish();
