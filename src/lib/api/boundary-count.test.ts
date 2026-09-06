import { describe, it, expect, vi, beforeEach } from "vitest";

// #1974: the count that decides whether a boundary catch wakes anybody.
//
// What matters here is not the arithmetic (Postgres does that, atomically,
// inside one statement) but WHICH WAY each failure falls. This sits on the
// alerting path, so a counter that could not answer must page rather than stay
// quiet: a silent withholding would mute the only detector for a page nobody can
// use, and would look exactly like a healthy console.
const rpc = vi.hoisted(() => vi.fn(async () => ({ data: true, error: null })));
const maybeSingle = vi.hoisted(() => vi.fn(async () => ({ data: { count: 7 }, error: null })));
const from = vi.hoisted(() =>
  vi.fn(() => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      maybeSingle,
    };
    return q;
  }),
);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc, from }) }));

import { countBoundaryCatch, BOUNDARY_WINDOW_MS } from "./boundary-count";

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: true, error: null } as never);
  maybeSingle.mockResolvedValue({ data: { count: 7 }, error: null } as never);
});

describe("countBoundaryCatch", () => {
  // THE FIRST CATCH IS NOT A REPEAT, and it costs one round trip: no read back,
  // because there is no figure worth reporting for a catch nobody is told about.
  it("reports the first catch in a window as not repeated", async () => {
    const seen = await countBoundaryCatch("boundary_error:admin");
    expect(seen).toEqual({ repeated: false, count: 1, measured: true });
    expect(from).not.toHaveBeenCalled();
  });

  it("asks under its own key space, over its own window", async () => {
    await countBoundaryCatch("boundary_error:admin");
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: "boundary_count:boundary_error:admin",
      p_window_seconds: BOUNDARY_WINDOW_MS / 1000,
      // The ceiling is ONE, so the RPC's own boolean is the floor decision,
      // taken atomically inside the increment rather than read back and compared.
      p_max: 1,
    });
  });

  it("reports a second catch as repeated, with the figure", async () => {
    rpc.mockResolvedValue({ data: false, error: null } as never);
    expect(await countBoundaryCatch("boundary_error:admin")).toEqual({
      repeated: true,
      count: 7,
      measured: true,
    });
  });

  // THE FIGURE IS FOR THE MESSAGE ALONE. An unreadable read back must not turn
  // into a number, and must not withhold the page: the repeat is already known
  // from the increment itself.
  it("still pages with no figure when the count cannot be read back", async () => {
    rpc.mockResolvedValue({ data: false, error: null } as never);
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } } as never);
    expect(await countBoundaryCatch("boundary_error:admin")).toEqual({
      repeated: true,
      count: null,
      measured: true,
    });
  });

  it("refuses a count of the wrong shape rather than coercing it", async () => {
    rpc.mockResolvedValue({ data: false, error: null } as never);
    maybeSingle.mockResolvedValue({ data: { count: "7" }, error: null } as never);
    expect((await countBoundaryCatch("k")).count).toBeNull();
  });

  // FAILING OPEN. Both ways the counter can fail land on "page, and say the
  // scope is unknown", and neither is allowed to look like a measurement.
  it("pages and reports itself unmeasured when the counter errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "rpc down" } } as never);
    expect(await countBoundaryCatch("k")).toEqual({
      repeated: true,
      count: null,
      measured: false,
    });
  });

  it("pages and reports itself unmeasured when the counter throws", async () => {
    rpc.mockRejectedValue(new Error("network") as never);
    expect(await countBoundaryCatch("k")).toEqual({
      repeated: true,
      count: null,
      measured: false,
    });
  });

  // It never throws: a monitoring failure must not become a failure of the
  // endpoint it monitors, which here is a public beacon that must always answer.
  it("never throws", async () => {
    rpc.mockRejectedValue(new Error("network") as never);
    await expect(countBoundaryCatch("k")).resolves.toBeTruthy();
  });
});
