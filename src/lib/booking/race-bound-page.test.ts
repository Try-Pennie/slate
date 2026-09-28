import { describe, it, expect, vi, beforeEach } from "vitest";

// #2838: the production dispatcher for the race bound hit page. The confirm path
// hands it the page and moves on, so a lead's 409 never waits on an alert_state
// read and a Slack post (up to its 8s timeout), and a failed send is logged while
// the refusal stands. The dispatcher is mocked here, so nothing reaches Slack.

const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
}));
vi.mock("@/lib/notify/dispatch", () => dispatch);

import { pageRaceBoundHitAfterResponse } from "./race-bound-page";

const PAGE = { key: "booking_race_bound_hit", cooldownMs: 3_600_000, text: "a lead was refused" };

beforeEach(() => vi.clearAllMocks());

describe("pageRaceBoundHitAfterResponse", () => {
  it("sends the page it was handed", async () => {
    pageRaceBoundHitAfterResponse(PAGE);
    await vi.waitFor(() => expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1));
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledWith(PAGE.key, PAGE.cooldownMs, PAGE.text);
  });

  it("returns without waiting on the send, so Slack can never hold the 409", async () => {
    // A send that never settles: the call still returns synchronously, with
    // nothing to await, and the send is then started behind it.
    dispatch.sendThrottledAlert.mockImplementationOnce(() => new Promise<void>(() => {}));
    const result = pageRaceBoundHitAfterResponse(PAGE);
    expect(result).toBeUndefined();
    await vi.waitFor(() => expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1));
  });

  it("logs a failed send and never throws it back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    expect(() => pageRaceBoundHitAfterResponse(PAGE)).not.toThrow();
    await vi.waitFor(() =>
      expect(warn.mock.calls.some((c) => String(c[0]).includes("could not page a race bound hit"))).toBe(true),
    );
    warn.mockRestore();
  });
});
