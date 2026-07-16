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
