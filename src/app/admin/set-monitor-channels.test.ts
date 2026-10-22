import { describe, it, expect, vi, beforeEach } from "vitest";

// #1957: the save-time Slack channel check inside setMonitorSettings.
//
// This is the half the issue calls the more valuable one, and the reason is the
// asymmetry of the failure: a typo in a channel id degrades ALL alerting to log
// only, and nothing can alert about it by construction, because the paging
// channel cannot page about itself. Save time is the only moment somebody is
// looking at the screen.
//
// What is pinned here is what no pure test can see: that a refusal REACHES the
// redirect and leaves the store untouched, and that an answer Slate cannot get
// saves anyway. The mapping of Slack's replies to outcomes is pinned offline in
// `scripts/test-slack-channels.ts`.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const upsert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
// #2438: the stored channel row, read only when a typed name is not in the list.
const stored = vi.hoisted(() => ({
  row: null as Record<string, string | null> | null,
  error: null as { message: string } | null,
}));
const from = vi.hoisted(() =>
  vi.fn(() => ({
    upsert,
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: stored.row, error: stored.error }) }),
    }),
  })),
);
const slack = vi.hoisted(() => ({
  asked: [] as string[],
  reply: { ok: true, data: { channel: { name: "alerts", is_member: true } } } as {
    ok: boolean;
    error?: string;
    data?: Record<string, unknown>;
  },
}));

// #2438: the channel list a typed NAME is resolved against. `listed` counts the
// reads, because a value that is already an id must not cost a list read.
const listing = vi.hoisted(() => ({
  listed: 0,
  reply: {
    readable: true,
    complete: true,
    channels: [
      { id: "C08A3BYMB29", name: "statuspage", isMember: true },
      { id: "C09F4L6PLQP", name: "dan-systems-test", isMember: true },
    ],
  } as
    | { readable: true; complete: boolean; channels: { id: string; name: string; isMember: boolean }[] }
    | { readable: false; why: string },
}));

const channels = vi.hoisted(() => ({ clearChannelCache: vi.fn() }));
vi.mock("@/lib/notify/channels", () => channels);
vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/notify/slack", () => ({
  fetchSlackChannel: async (channel: string) => {
    slack.asked.push(channel);
    return slack.reply;
  },
  listSlackChannels: async () => {
    listing.listed++;
    return listing.reply;
  },
}));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setMonitorSettings } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  slack.asked = [];
  stored.row = null;
  stored.error = null;
  listing.listed = 0;
  listing.reply = {
    readable: true,
    complete: true,
    channels: [
      { id: "C08A3BYMB29", name: "statuspage", isMember: true },
      { id: "C09F4L6PLQP", name: "dan-systems-test", isMember: true },
    ],
  };
  slack.reply = { ok: true, data: { channel: { name: "alerts", is_member: true } } };
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

describe("setMonitorSettings channel check", () => {
  it("saves a channel Slack confirms", async () => {
    await expect(setMonitorSettings(form({ alerts_channel: "C0GOOD0001" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    expect(slack.asked).toEqual(["C0GOOD0001"]);
    expect(upsert).toHaveBeenCalled();
    // #3121: the in-process channel cache is cleared, so the next alert goes to
    // the channel just saved rather than the one cached a minute ago.
    expect(channels.clearChannelCache).toHaveBeenCalledTimes(1);
  });

  it("leaves the channel cache alone when the save is refused", async () => {
    slack.reply = { ok: false, error: "channel_not_found" };
    await expect(setMonitorSettings(form({ alerts_channel: "C0TYPO0001" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(channels.clearChannelCache).not.toHaveBeenCalled();
  });

  // A CHANNEL THAT DOES NOT EXIST IS NEVER STORED. Storing it is what makes the
  // fault invisible: every later alert is logged as a failed post and nothing
  // is on screen to connect that to what was typed here.
  it("refuses an unknown channel and writes nothing", async () => {
    slack.reply = { ok: false, error: "channel_not_found" };
    await expect(setMonitorSettings(form({ alerts_channel: "C0TYPO0001" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    const url = String(redirect.mock.calls[0][0]);
    expect(decodeURIComponent(url)).toMatch(/Alerts channel: Slack has no channel C0TYPO0001/);
  });

  it("refuses a channel the bot is not in, and says so differently", async () => {
    slack.reply = { ok: true, data: { channel: { name: "ops", is_member: false } } };
    await expect(setMonitorSettings(form({ alerts_channel: "C0OPS00001" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(decodeURIComponent(String(redirect.mock.calls[0][0]))).toMatch(/Invite the Slate app/);
  });

  // THE FIELD IT NAMES. Two channels are saved by one form, so a refusal that
  // did not say which one leaves the reader checking both.
  it("names the info channel when that is the broken one", async () => {
    slack.reply = { ok: false, error: "channel_not_found" };
    await expect(
      setMonitorSettings(form({ info_channel: "C0TYPO0001" })),
    ).rejects.toThrow(/NEXT_REDIRECT:.*error=/);
    expect(decodeURIComponent(String(redirect.mock.calls[0][0]))).toMatch(/^\/admin\/alerts\?error=Info channel:/);
  });

  // AN UNVERIFIABLE ANSWER SAVES. Until the Slate app carries the scope,
  // `conversations.info` answers `missing_scope` for every channel, good or bad.
  // Refusing on it would block every save on this page.
  it("saves when Slack cannot be asked", async () => {
    slack.reply = { ok: false, error: "missing_scope" };
    await expect(setMonitorSettings(form({ alerts_channel: "C0UNKNOWN1" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    expect(upsert).toHaveBeenCalled();
  });

  // #2367: the handoff channel is checked like the other two, and a refusal names it,
  // because a typo there sends every handoff nowhere while the page reads as set.
  it("refuses an unknown handoff channel, names it, and writes nothing", async () => {
    slack.reply = { ok: false, error: "channel_not_found" };
    await expect(setMonitorSettings(form({ handoff_channel: "C0TYPO0001" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(slack.asked).toEqual(["C0TYPO0001"]);
    expect(upsert).not.toHaveBeenCalled();
    expect(decodeURIComponent(String(redirect.mock.calls[0][0]))).toMatch(
      /^\/admin\/alerts\?error=Handoff channel:/,
    );
  });

  it("stores a handoff channel Slack confirms", async () => {
    await expect(setMonitorSettings(form({ handoff_channel: "C0SALES001" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    const configWrite = upsert.mock.calls
      .map((c) => (c as unknown[])[0])
      .find((p) => !Array.isArray(p)) as Record<string, unknown> | undefined;
    expect(configWrite?.handoff_channel).toBe("C0SALES001");
  });

  // A BLANK FIELD IS NOT A CHANNEL. It means fall back, and asking Slack about
  // an empty string would refuse every save that clears one.
  it("asks Slack nothing when both fields are blank", async () => {
    await expect(setMonitorSettings(form({ alerts_channel: "", info_channel: "  " }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    expect(slack.asked).toEqual([]);
    expect(upsert).toHaveBeenCalled();
  });

  // #2438: A NAME IS TAKEN, and stored as the id it names. The issue's report: the
  // name the panel itself prints was refused as "Slack has no channel", and the
  // empty field afterwards read as a save that had worked.
  it("stores a typed channel name as its id", async () => {
    await expect(setMonitorSettings(form({ handoff_channel: "dan-systems-test" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    // The id is what Slack is asked about, so the membership check still runs.
    expect(slack.asked).toEqual(["C09F4L6PLQP"]);
    const configWrite = upsert.mock.calls
      .map((c) => (c as unknown[])[0])
      .find((p) => !Array.isArray(p)) as Record<string, unknown> | undefined;
    expect(configWrite?.handoff_channel).toBe("C09F4L6PLQP");
  });

  it("takes a name written with its hash", async () => {
    await expect(setMonitorSettings(form({ alerts_channel: "#statuspage" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    const configWrite = upsert.mock.calls
      .map((c) => (c as unknown[])[0])
      .find((p) => !Array.isArray(p)) as Record<string, unknown> | undefined;
    expect(configWrite?.alerts_channel).toBe("C08A3BYMB29");
  });

  // AN ID COSTS NO LIST READ. The list is only consulted to turn a name into an id.
  it("reads no channel list when every field is already an id", async () => {
    await expect(setMonitorSettings(form({ alerts_channel: "C0GOOD0001" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    expect(listing.listed).toBe(0);
  });

  // AN ID THE LIST CANNOT SEE (a private channel) is still asked of Slack directly,
  // rather than refused for being absent from a list of public channels.
  it("checks a pasted id the list does not hold with Slack itself", async () => {
    await expect(
      setMonitorSettings(form({ alerts_channel: "statuspage", info_channel: "G01PRIVATE9" })),
    ).rejects.toThrow(/NEXT_REDIRECT:.*ok=alerts/);
    expect(slack.asked).toEqual(["C08A3BYMB29", "G01PRIVATE9"]);
  });

  // A NAME MATCHING NOTHING is refused with what was wrong with it, never sent to
  // Slack as though it were an id, and nothing is written.
  it("refuses a name that matches no channel, says why and where an id is found", async () => {
    await expect(setMonitorSettings(form({ handoff_channel: "#stauspage" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(slack.asked).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(channels.clearChannelCache).not.toHaveBeenCalled();
    const msg = decodeURIComponent(String(redirect.mock.calls[0][0]));
    expect(msg).toBe(
      "/admin/alerts?error=Handoff channel: No channel called #stauspage. Pick one from the list or paste its channel ID.",
    );
  });

  // THE LIST CANNOT BE READ: a name cannot be looked up, and the refusal says THAT
  // rather than that the channel does not exist.
  it("refuses a name when the channel list cannot be read, naming that cause", async () => {
    listing.reply = { readable: false, why: "missing_scope" };
    await expect(setMonitorSettings(form({ alerts_channel: "statuspage" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(upsert).not.toHaveBeenCalled();
    const msg = decodeURIComponent(String(redirect.mock.calls[0][0]));
    expect(msg).toBe(
      "/admin/alerts?error=Alerts channel: Slate could not read Slack's channel list to find #statuspage. Paste its channel ID instead.",
    );
  });

  // #2438 review: A PRIVATE CHANNEL ALREADY STORED is never in the public list, and
  // its name is known only from Slack's answer about its id. Typing that name (the
  // one the field itself displays) saves the id.
  it("stores a typed name of a private channel that is already stored, as its id", async () => {
    listing.reply = {
      readable: true,
      complete: true,
      channels: [{ id: "C08A3BYMB29", name: "statuspage", isMember: true }],
    };
    // The Slack double gives one answer for every id, so only the private channel
    // is stored here; otherwise every stored id would carry its name.
    stored.row = { alerts_channel: null, info_channel: "C09F4L6PLQP", handoff_channel: null };
    slack.reply = { ok: true, data: { channel: { name: "dan-systems-test", is_member: true } } };
    await expect(setMonitorSettings(form({ handoff_channel: "#dan-systems-test" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    const configWrite = upsert.mock.calls
      .map((c) => (c as unknown[])[0])
      .find((p) => !Array.isArray(p)) as Record<string, unknown> | undefined;
    expect(configWrite?.handoff_channel).toBe("C09F4L6PLQP");
  });

  it("still refuses a name matching neither the list nor a stored channel", async () => {
    listing.reply = {
      readable: true,
      complete: true,
      channels: [{ id: "C08A3BYMB29", name: "statuspage", isMember: true }],
    };
    stored.row = { alerts_channel: null, info_channel: "C09F4L6PLQP", handoff_channel: null };
    slack.reply = { ok: true, data: { channel: { name: "dan-systems-test", is_member: true } } };
    await expect(setMonitorSettings(form({ handoff_channel: "elsewhere" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(decodeURIComponent(String(redirect.mock.calls[0][0]))).toMatch(/No channel called #elsewhere\./);
  });

  // FAILURE PATH: the stored channels cannot be read. The typed name is refused as
  // unmatched, never stored as typed and never guessed.
  it("refuses the name when the stored channels cannot be read", async () => {
    listing.reply = {
      readable: true,
      complete: true,
      channels: [{ id: "C08A3BYMB29", name: "statuspage", isMember: true }],
    };
    stored.error = { message: "read timeout" };
    await expect(setMonitorSettings(form({ handoff_channel: "dan-systems-test" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  // The list is read ONCE for a save with several names in it.
  it("reads the channel list once for several names", async () => {
    await expect(
      setMonitorSettings(form({ alerts_channel: "statuspage", handoff_channel: "dan-systems-test" })),
    ).rejects.toThrow(/NEXT_REDIRECT:.*ok=alerts/);
    expect(listing.listed).toBe(1);
  });
});
