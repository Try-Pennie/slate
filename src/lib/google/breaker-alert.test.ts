import { describe, it, expect, vi, beforeEach } from "vitest";

// #3134: the open page and the all-clear for the Google breaker. Driven through a
// real breaker with this module as its listener, so the test asks the question
// that matters (#1152): does anything other than a probe Google ANSWERED post the
// all-clear? A probe that failed, or one cut short by a confirm's budget, measured
// nothing about recovery and must stay silent.

const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_k: string, _ms: number, _t: string) => {}),
  resolveAlert: vi.fn(async (_k: string, _t: string) => true),
}));
vi.mock("@/lib/notify/dispatch", () => dispatch);
// Run the deferred send at once, so the assertion sees it.
vi.mock("@/lib/after-response", () => ({
  afterResponse: (_ctx: string, work: () => Promise<unknown>) => void work(),
}));

import { announceGoogleBreaker, GOOGLE_BREAKER_ALERT_KEY, GOOGLE_BREAKER_ALERT_COOLDOWN_MS } from "./breaker-alert";
import { createCircuitBreaker } from "./breaker";
import { alertFamily } from "@/lib/notify/alert-runbook";
import { forgetDependencyCalls, noteDependencyCall, STALLED_TOGETHER_WINDOW_MS } from "@/lib/dependency-stall";

function rig() {
  let t = 0;
  const breaker = createCircuitBreaker({ threshold: 2, openMs: 1000, now: () => t, onTransition: announceGoogleBreaker });
  const open = () => {
    breaker.record(breaker.admit(), "failure", "503 backendError");
    breaker.record(breaker.admit(), "failure", "503 backendError");
  };
  return { breaker, open, advance: (ms: number) => (t += ms) };
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetDependencyCalls();
});

describe("Google breaker alerts (#3134)", () => {
  it("pages once when it opens, naming the last failure, on its cooldown", async () => {
    const { open } = rig();
    open();
    await Promise.resolve();
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledOnce();
    const [key, cooldown, text] = dispatch.sendThrottledAlert.mock.calls[0];
    expect(key).toBe(GOOGLE_BREAKER_ALERT_KEY);
    expect(cooldown).toBe(GOOGLE_BREAKER_ALERT_COOLDOWN_MS);
    expect(text).toContain("503 backendError");
    expect(text).toContain("2 calls in a row");
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("posts NO all-clear when the probe fails", async () => {
    const { breaker, open, advance } = rig();
    open();
    advance(1000);
    breaker.record(breaker.admit(), "failure", "still 503");
    await Promise.resolve();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledOnce();
  });

  it("posts NO all-clear when the probe measured nothing", async () => {
    const { breaker, open, advance } = rig();
    open();
    advance(1000);
    breaker.record(breaker.admit(), "neutral");
    await Promise.resolve();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("posts the all-clear on the same key once a probe is answered", async () => {
    const { breaker, open, advance } = rig();
    open();
    advance(3 * 60_000);
    breaker.record(breaker.admit(), "answered");
    await Promise.resolve();
    expect(dispatch.resolveAlert).toHaveBeenCalledOnce();
    const [key, text] = dispatch.resolveAlert.mock.calls[0];
    expect(key).toBe(GOOGLE_BREAKER_ALERT_KEY);
    expect(text).toContain("3 minutes");
  });

  it("sends the reader to the Google procedure in the runbook", () => {
    expect(alertFamily(GOOGLE_BREAKER_ALERT_KEY)).toBe("google-cannot-be-reached-for-an-agent");
  });

  it("never lets a failed send escape into the call path", async () => {
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    const { breaker, open } = rig();
    expect(open).not.toThrow();
    await Promise.resolve();
    expect(breaker.state()).toBe("open");
  });

  // #3784: placement runs every fetch beside Oregon (#3730), so a degraded location
  // there slows Google and Supabase together. When this isolate's Supabase calls also
  // stalled in the same minutes, the page suspects the location before either service.
  describe("when Supabase stalled in the same minutes (#3784)", () => {
    beforeEach(() => forgetDependencyCalls());

    it("suspects the Cloudflare location first, by name, not Google", async () => {
      noteDependencyCall("supabase bookings", 3_200, Date.now(), "SEA");
      rig().open();
      await Promise.resolve();
      const [, , text] = dispatch.sendThrottledAlert.mock.calls[0];
      expect(text).toContain("Supabase calls from SEA stalled in the same minutes");
      expect(text).toContain("suspect the Cloudflare location these calls ran from (SEA) before either service");
      expect(text).toContain("request.cf.colo");
      expect(text).not.toMatch(/^Google Calendar is not answering/);
      // What the reader will see while it holds is still said.
      expect(text).toContain("bookings ask the lead to try again");
    });

    it("says where to read the location when no Supabase answer named it", async () => {
      noteDependencyCall("supabase", 3_200, Date.now(), null);
      rig().open();
      await Promise.resolve();
      const [, , text] = dispatch.sendThrottledAlert.mock.calls[0];
      expect(text).toContain("suspect the Cloudflare location these calls ran from before either service");
      expect(text).toContain("supabase_edge_colo");
    });

    it("keeps blaming Google when Supabase answered quickly, or stalled too long ago", async () => {
      noteDependencyCall("supabase", 40, Date.now(), "SEA");
      noteDependencyCall("supabase", 3_200, Date.now() - STALLED_TOGETHER_WINDOW_MS - 1_000, "SEA");
      rig().open();
      await Promise.resolve();
      const [, , text] = dispatch.sendThrottledAlert.mock.calls[0];
      expect(text).toMatch(/^Google Calendar is not answering/);
      expect(text).not.toContain("Cloudflare location");
    });
  });
});
