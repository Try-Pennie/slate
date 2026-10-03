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
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));
const slack = vi.hoisted(() => ({
  asked: [] as string[],
  reply: { ok: true, data: { channel: { name: "alerts", is_member: true } } } as {
    ok: boolean;
    error?: string;
    data?: Record<string, unknown>;
  },
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
  slack.reply = { ok: true, data: { channel: { name: "alerts", is_member: true } } };
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

describe("setMonitorSettings channel check", () => {
  it("saves a channel Slack confirms", async () => {
    await expect(setMonitorSettings(form({ alerts_channel: "C-GOOD" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    expect(slack.asked).toEqual(["C-GOOD"]);
    expect(upsert).toHaveBeenCalled();
    // #3121: the in-process channel cache is cleared, so the next alert goes to
    // the channel just saved rather than the one cached a minute ago.
    expect(channels.clearChannelCache).toHaveBeenCalledTimes(1);
  });

  it("leaves the channel cache alone when the save is refused", async () => {
    slack.reply = { ok: false, error: "channel_not_found" };
    await expect(setMonitorSettings(form({ alerts_channel: "C-TYPO" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(channels.clearChannelCache).not.toHaveBeenCalled();
  });

  // A CHANNEL THAT DOES NOT EXIST IS NEVER STORED. Storing it is what makes the
  // fault invisible: every later alert is logged as a failed post and nothing
  // is on screen to connect that to what was typed here.
  it("refuses an unknown channel and writes nothing", async () => {
    slack.reply = { ok: false, error: "channel_not_found" };
    await expect(setMonitorSettings(form({ alerts_channel: "C-TYPO" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    const url = String(redirect.mock.calls[0][0]);
    expect(decodeURIComponent(url)).toMatch(/Alerts channel: Slack has no channel C-TYPO/);
  });

  it("refuses a channel the bot is not in, and says so differently", async () => {
    slack.reply = { ok: true, data: { channel: { name: "ops", is_member: false } } };
    await expect(setMonitorSettings(form({ alerts_channel: "C-OPS" }))).rejects.toThrow(
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
      setMonitorSettings(form({ info_channel: "C-TYPO" })),
    ).rejects.toThrow(/NEXT_REDIRECT:.*error=/);
    expect(decodeURIComponent(String(redirect.mock.calls[0][0]))).toMatch(/^\/admin\/alerts\?error=Info channel:/);
  });

  // AN UNVERIFIABLE ANSWER SAVES. Until the Slate app carries the scope,
  // `conversations.info` answers `missing_scope` for every channel, good or bad.
  // Refusing on it would block every save on this page.
  it("saves when Slack cannot be asked", async () => {
    slack.reply = { ok: false, error: "missing_scope" };
    await expect(setMonitorSettings(form({ alerts_channel: "C-UNKNOWN" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    expect(upsert).toHaveBeenCalled();
  });

  // #2367: the handoff channel is checked like the other two, and a refusal names it,
  // because a typo there sends every handoff nowhere while the page reads as set.
  it("refuses an unknown handoff channel, names it, and writes nothing", async () => {
    slack.reply = { ok: false, error: "channel_not_found" };
    await expect(setMonitorSettings(form({ handoff_channel: "C-TYPO" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*error=/,
    );
    expect(slack.asked).toEqual(["C-TYPO"]);
    expect(upsert).not.toHaveBeenCalled();
    expect(decodeURIComponent(String(redirect.mock.calls[0][0]))).toMatch(
      /^\/admin\/alerts\?error=Handoff channel:/,
    );
  });

  it("stores a handoff channel Slack confirms", async () => {
    await expect(setMonitorSettings(form({ handoff_channel: "C-SALES" }))).rejects.toThrow(
      /NEXT_REDIRECT:.*ok=alerts/,
    );
    const configWrite = upsert.mock.calls
      .map((c) => (c as unknown[])[0])
      .find((p) => !Array.isArray(p)) as Record<string, unknown> | undefined;
    expect(configWrite?.handoff_channel).toBe("C-SALES");
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
});
