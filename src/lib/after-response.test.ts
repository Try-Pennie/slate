import { describe, it, expect, vi, beforeEach } from "vitest";

// #503: best-effort post-response work must survive the Cloudflare/OpenNext
// isolate teardown by going through Next's after() (which OpenNext maps to
// ctx.waitUntil), NOT a floating promise. But after() THROWS synchronously when
// there is no request scope (next/dist/server/after/after.js), so the helper
// must degrade to the old silent-safe float rather than crash a caller, and it
// must never let a background failure escape into the response.

const afterMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/log", () => ({ log: logMock }));

import { afterResponse } from "./after-response";
import { deadlineWithinBudget, withinCallBudget } from "./call-budget";

beforeEach(() => vi.clearAllMocks());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("afterResponse (#503)", () => {
  it("schedules the work through after(), not eagerly", async () => {
    const work = vi.fn(async () => {});
    // after() just captures the callback here (doesn't run it).
    afterResponse("recompute", work);
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();

    // Running after()'s callback is what invokes the work.
    const scheduled = afterMock.mock.calls[0][0] as () => unknown;
    scheduled();
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("degrades to a plain float (no throw) when after() has no request scope", async () => {
    afterMock.mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope.");
    });
    const work = vi.fn(async () => {});

    // Must NOT propagate the throw to the caller: a missed recompute is
    // backstopped by the cron; a crash is not acceptable.
    expect(() => afterResponse("recompute", work)).not.toThrow();

    // The work still runs as a fallback float so the side effect isn't simply lost.
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("catches a rejecting work and logs it (fail-loud, never throws)", async () => {
    const boom = new Error("recompute blew up");
    const work = vi.fn(async () => {
      throw boom;
    });
    afterResponse("recompute", work);

    const scheduled = afterMock.mock.calls[0][0] as () => Promise<unknown>;
    await expect(scheduled()).resolves.toBeUndefined();
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    const [tag, fields] = logMock.warn.mock.calls[0];
    expect(tag).toBe("after-response");
    expect(fields).toMatchObject({ context: "recompute" });
  });
});

// #2353: the deferred span is charged to the invocation's CPU
//
// Run 34980777198 measured warm confirms at 2.8 to 3.4s of CPU on a 6.5s
// invocation, of which about 3.5s was spent AFTER the response had gone. No lead
// waits for that span and Cloudflare still bills it, and the request CPU bar still
// counts it, so it is the span most worth apportioning. Until now it was ONE
// number inferred by subtracting the confirm's own log line from the invocation's
// wall, which cannot separate the webhook send from the tally beside it.
//
// It is WALL, like everything else the Worker can time: `Date.now()` returns the
// time of the last I/O and does not advance during execution, and Workers provide
// no other timer (Cloudflare's own security model page). So per stage CPU is not
// obtainable from inside a Worker at all, and this measures how long each deferred
// job took, not how much of the isolate's compute it used.
describe("the deferred span reports each job's own time (#2353)", () => {
  const enabled = (on: boolean) => {
    if (on) process.env.SLATE_LOADTEST = "true";
    else delete process.env.SLATE_LOADTEST;
  };

  it("logs one line per deferred job, naming the job and its wall time", async () => {
    enabled(true);
    try {
      afterResponse("booking-webhook", async () => {});
      (afterMock.mock.calls[0][0] as () => unknown)();
      await flush();
      const line = logMock.info.mock.calls.find((c) => c[0] === "after-response-profile");
      expect(line, "a deferred job under load test reports its own span").toBeTruthy();
      expect(line![1].context).toBe("booking-webhook");
      // The number itself is whatever the frozen clock gave; what matters is that
      // the field is PRESENT and numeric, because an absent one renders as a job
      // that cost nothing rather than one nobody measured.
      expect(typeof line![1].ms).toBe("number");
    } finally {
      enabled(false);
    }
  });

  it("charges a job that THREW for the time it spent", async () => {
    enabled(true);
    try {
      afterResponse("booking-webhook", async () => {
        throw new Error("the send failed");
      });
      (afterMock.mock.calls[0][0] as () => unknown)();
      await flush();
      // A deferred job that fails is exactly the one somebody profiles, and one
      // recorded only on success would report the expensive failing send as free.
      const line = logMock.info.mock.calls.find((c) => c[0] === "after-response-profile");
      expect(line, "a failed deferred job is still timed").toBeTruthy();
      expect(line![1].failed).toBe(true);
      // And the existing failure warning is NOT replaced by it: the two say
      // different things to different readers.
      expect(logMock.warn).toHaveBeenCalled();
    } finally {
      enabled(false);
    }
  });

  it("reads no clock and logs nothing when the load test flag is unset", async () => {
    enabled(false);
    afterResponse("booking-webhook", async () => {});
    (afterMock.mock.calls[0][0] as () => unknown)();
    await flush();
    // Every production confirm takes this branch, so it pays nothing rather than
    // paying a little and discarding it.
    expect(logMock.info.mock.calls.find((c) => c[0] === "after-response-profile")).toBeUndefined();
  });

  // #3102: deferred work runs after the lead has their answer, so it must not
  // inherit the confirm's budget, which by then may be spent: a webhook send would
  // fail at once for no reason of its own.
  it("runs the deferred work outside any call budget it was scheduled from", async () => {
    let seen: number | null = null;
    await withinCallBudget(1_000, "the booking confirm", async () => {
      afterResponse("webhook-send", async () => {
        seen = deadlineWithinBudget(15_000, "supabase").waitMs;
      });
    });
    const scheduled = afterMock.mock.calls[0][0] as () => unknown;
    await withinCallBudget(1, "a budget the runner happens to sit in", async () => {
      scheduled();
    });
    await flush();
    expect(seen).toBe(15_000);
  });
});
