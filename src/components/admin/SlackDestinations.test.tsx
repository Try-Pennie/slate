// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1957: the panel that answers "where does an alert actually land, and is that
// destination real". The Slack call is mocked because the mapping of Slack's
// replies is pinned offline in `scripts/test-slack-channels.ts`; what is pinned
// HERE is the wiring, which no pure test can see: that the panel asks about the
// EFFECTIVE channel rather than the field, that it says something in every
// state, and that it does not print the same sentence twice when both
// destinations are one channel.
const slack = vi.hoisted(() => ({
  asked: [] as string[],
  reply: { ok: true, data: { channel: { name: "alerts", is_member: true } } } as {
    ok: boolean;
    error?: string;
    data?: Record<string, unknown>;
  },
  options: [] as { id: string; name: string; isMember: boolean }[],
}));
vi.mock("@/lib/notify/slack", () => ({
  fetchSlackChannel: async (channel: string) => {
    slack.asked.push(channel);
    return slack.reply;
  },
  listSlackChannels: async () => slack.options,
}));

import { SlackDestinations } from "./SlackDestinations";

const props = (
  config: { alerts_channel: string | null; info_channel: string | null } | null,
  envAlerts = "",
  envInfo = "",
) => ({ config, envAlerts, envInfo });

describe("SlackDestinations", () => {
  beforeEach(() => {
    slack.asked = [];
    slack.reply = { ok: true, data: { channel: { name: "alerts", is_member: true } } };
    slack.options = [];
  });

  it("names the stored channel and confirms it", async () => {
    render(await SlackDestinations(props({ alerts_channel: "C-STORED", info_channel: null })));
    // THE ISSUE'S TITLE: the channel is named, and the id it stores rides along
    // rather than standing alone.
    expect(screen.getByText(/Urgent alerts post to #alerts \(C-STORED\)/)).toBeTruthy();
    expect(screen.getByText(/Quiet notices post to #alerts \(C-STORED\)/)).toBeTruthy();
    expect(slack.asked).toContain("C-STORED");
  });

  // THE POINT OF THE PANEL. Both fields blank is the ordinary state, and the
  // reader used to be handed the precedence rules and left to apply them. The
  // env channel is what alerts really reach, so it is what must be named.
  it("names the deployment's own channel when the fields are blank", async () => {
    render(await SlackDestinations(props(null, "C-ENV", "")));
    expect(screen.getByText(/Urgent alerts post to #alerts \(C-ENV\)/)).toBeTruthy();
    expect(slack.asked).toEqual(["C-ENV"]);
  });

  // A CONFIRMED CHANNEL NEEDS NO SECOND SENTENCE. The name IS the confirmation:
  // it cannot be derived from an id, so its presence is proof Slack answered
  // about this exact channel. A "Checked: ..." line beneath would repeat that.
  it("does not add a confirmation line to a channel it just named", async () => {
    render(await SlackDestinations(props(null, "C-ENV", "")));
    expect(screen.queryByText(/^Checked:/)).toBeNull();
  });

  it("checks two channels separately when they differ", async () => {
    render(await SlackDestinations(props({ alerts_channel: "C-A", info_channel: "C-B" })));
    expect(slack.asked.sort()).toEqual(["C-A", "C-B"]);
  });

  // THE PICKER. A channel is chosen by name, and the value it puts in the field
  // is the id Slate stores.
  it("offers the workspace channels by name, carrying the id as the value", async () => {
    slack.options = [
      { id: "C1", name: "alerts", isMember: true },
      { id: "C2", name: "random", isMember: false },
    ];
    const { container } = render(await SlackDestinations(props(null, "C-ENV", "")));
    const opts = [...container.querySelectorAll("datalist option")];
    expect(opts.map((o) => o.getAttribute("value"))).toEqual(["C1", "C2"]);
    expect(opts[0].getAttribute("label")).toBe("#alerts");
    // A channel the bot is not in is offered, and says so: it is a legitimate
    // choice that needs an invite first, not one to hide.
    expect(opts[1].getAttribute("label")).toMatch(/#random.*not in it/);
  });

  // AN UNREADABLE LIST IS NO SUGGESTIONS, never a broken panel. The field it
  // decorates still takes a typed id, and that id is still checked at save.
  it("draws the destinations even with no channel list", async () => {
    slack.options = [];
    const { container } = render(await SlackDestinations(props(null, "C-ENV", "")));
    expect(container.querySelectorAll("datalist option").length).toBe(0);
    expect(screen.getByText(/Urgent alerts post to/)).toBeTruthy();
  });

  // NOTHING CONFIGURED. Not a neutral default: no alert reaches Slack at all.
  // Nothing is asked of Slack either, because there is nothing to ask about.
  it("says plainly when no channel is configured anywhere", async () => {
    const { container } = render(await SlackDestinations(props(null, "", "")));
    expect(screen.getAllByText(/reach Slack nowhere/).length).toBe(2);
    expect(slack.asked).toEqual([]);
    expect(container.querySelectorAll(".text-error").length).toBe(2);
  });

  // A CHANNEL SLACK REFUSES still renders, and says which problem it is. This is
  // the state a save can no longer create, but a channel can stop being valid
  // after it was saved (the bot removed from it, the channel archived), and the
  // panel is the only thing that would ever say so.
  it("reports a channel the bot is not in", async () => {
    slack.reply = { ok: true, data: { channel: { name: "ops", is_member: false } } };
    render(await SlackDestinations(props({ alerts_channel: "C-OPS", info_channel: null })));
    expect(screen.getByText(/Slate is not in #ops/)).toBeTruthy();
  });

  // AN UNVERIFIABLE ANSWER is reported as one, rather than as a confirmation or
  // as a fault. This is the state the feature ships into until the Slack app is
  // given permission to read channels.
  it("says it could not check rather than confirming", async () => {
    slack.reply = { ok: false, error: "missing_scope" };
    render(await SlackDestinations(props({ alerts_channel: "C-A", info_channel: null })));
    expect(screen.getByText(/could not check/)).toBeTruthy();
    expect(screen.queryByText(/^Checked:/)).toBeNull();
  });
});
