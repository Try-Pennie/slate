import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3134: the breaker as gfetch runs it. Every Google Calendar call goes through
// gfetch, so these drive the real exported calls with fetch and the token mint
// stubbed, and the alert listener mocked so nothing reaches alert_state or Slack.
//
// The control that matters most is the verify-on-book one: with the breaker open,
// the free/busy reads must REJECT, so no caller can read an agent as free.

const dwd = vi.hoisted(() => ({ getDelegatedToken: vi.fn() }));
vi.mock("@/lib/google/dwd", () => dwd);
const alerts = vi.hoisted(() => ({ announceGoogleBreaker: vi.fn() }));
vi.mock("@/lib/google/breaker-alert", () => alerts);

import { freeBusy, freeBusyMany, isFree, createEvent, googleBreaker } from "./calendar";
import { GoogleBreakerOpenError, GOOGLE_BREAKER_THRESHOLD } from "./breaker";
import { GoogleHttpError } from "./http-error";

const WINDOW = ["2026-10-05T14:00:00.000Z", "2026-10-05T14:30:00.000Z"] as const;

function stubGoogle(status: number) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    if (status !== 200) return new Response(JSON.stringify({ error: { errors: [{ reason: "backendError" }] } }), { status });
    return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }), { status: 200 });
  });
  return calls;
}

async function failTimes(n: number) {
  for (let i = 0; i < n; i++) {
    await expect(freeBusy("a@trypennie.com", WINDOW[0], WINDOW[1], ["primary"])).rejects.toThrow();
  }
}

describe("the Google breaker in gfetch (#3134)", () => {
  beforeEach(() => {
    googleBreaker.reset();
    dwd.getDelegatedToken.mockReset();
    dwd.getDelegatedToken.mockResolvedValue("tok");
    alerts.announceGoogleBreaker.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps calling Google one failure short of the threshold", async () => {
    const calls = stubGoogle(503);
    await failTimes(GOOGLE_BREAKER_THRESHOLD - 1);
    expect(calls).toHaveLength(GOOGLE_BREAKER_THRESHOLD - 1);
    expect(alerts.announceGoogleBreaker).not.toHaveBeenCalled();
    await expect(freeBusy("a@trypennie.com", WINDOW[0], WINDOW[1], ["primary"])).rejects.not.toBeInstanceOf(
      GoogleBreakerOpenError,
    );
  });

  it("opens on the threshold, announces it once, and then sends nothing", async () => {
    const calls = stubGoogle(503);
    await failTimes(GOOGLE_BREAKER_THRESHOLD);
    expect(alerts.announceGoogleBreaker).toHaveBeenCalledTimes(1);
    expect(alerts.announceGoogleBreaker).toHaveBeenCalledWith(
      expect.objectContaining({ to: "open", failures: GOOGLE_BREAKER_THRESHOLD, lastFailure: "503 from google freeBusy" }),
    );
    const sent = calls.length;
    await expect(freeBusy("a@trypennie.com", WINDOW[0], WINDOW[1], ["primary"])).rejects.toBeInstanceOf(
      GoogleBreakerOpenError,
    );
    await expect(createEvent("a@trypennie.com", { summary: "x", start: WINDOW[0], end: WINDOW[1], timezone: "UTC" })).rejects.toBeInstanceOf(
      GoogleBreakerOpenError,
    );
    expect(calls).toHaveLength(sent);
    expect(dwd.getDelegatedToken).toHaveBeenCalledTimes(sent);
  });

  it("fails SAFE on verify-on-book: an open breaker never reads an agent as free", async () => {
    stubGoogle(503);
    await failTimes(GOOGLE_BREAKER_THRESHOLD);
    // Google would now say the agent is free; the breaker must not let anyone ask.
    stubGoogle(200);
    await expect(isFree("a@trypennie.com", WINDOW[0], WINDOW[1], ["primary"])).rejects.toBeInstanceOf(
      GoogleBreakerOpenError,
    );
    await expect(freeBusyMany("a@trypennie.com", WINDOW[0], WINDOW[1], ["primary"])).rejects.toBeInstanceOf(
      GoogleBreakerOpenError,
    );
  });

  it("does not count one agent's definitive refusal toward an outage", async () => {
    const calls = stubGoogle(200);
    dwd.getDelegatedToken.mockRejectedValue(new GoogleHttpError("mint 401", 401, "unauthorized_client"));
    await expect(freeBusy("gone@trypennie.com", WINDOW[0], WINDOW[1], ["primary"])).rejects.toThrow();
    for (let i = 0; i < GOOGLE_BREAKER_THRESHOLD; i++) {
      await expect(freeBusy("gone@trypennie.com", WINDOW[0], WINDOW[1], ["primary"])).rejects.not.toBeInstanceOf(
        GoogleBreakerOpenError,
      );
    }
    expect(calls).toHaveLength(0);
    expect(alerts.announceGoogleBreaker).not.toHaveBeenCalled();
  });

  it("closes and announces it when a probe after the window is answered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      stubGoogle(503);
      await failTimes(GOOGLE_BREAKER_THRESHOLD);
      vi.setSystemTime(Date.now() + 31_000);
      const calls = stubGoogle(200);
      await expect(isFree("a@trypennie.com", WINDOW[0], WINDOW[1], ["primary"])).resolves.toBe(true);
      expect(calls).toHaveLength(1);
      expect(alerts.announceGoogleBreaker).toHaveBeenLastCalledWith(expect.objectContaining({ to: "closed" }));
    } finally {
      vi.useRealTimers();
    }
  });
});
