import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRateLimits, type FakeRateLimits } from "../../../scripts/lib/fake-rate-limits";

// #3323: the count that decides whether opaque cross origin script errors page.
//
// Driven against a fake of the real `rate_limit_hit` semantics (a fixed window
// from the first hit, reset in place, `count <= p_max` after the increment)
// rather than a mock that answers whatever the test says, because the property
// that matters is arithmetic the database does: that one browser reloading counts
// ONCE, and that the threshold falls on the right report.
let db: FakeRateLimits;
const override = vi.hoisted(() => ({ rpc: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: (name: string, args: Record<string, unknown>) => (override.rpc ? override.rpc() : db.rpc(name, args)),
    from: (table: string) => db.from(table),
  }),
}));

import { countOpaqueScriptError, OPAQUE_BURST_THRESHOLD, OPAQUE_BURST_WINDOW_MS } from "./boundary-count";

const SURFACE = "client_error:book";
const address = (n: number) => `203.0.113.${n}`;

beforeEach(() => {
  db = fakeRateLimits();
  override.rpc = null;
});

describe("countOpaqueScriptError", () => {
  it("is sized so a burst needs several browsers, not one", () => {
    expect(OPAQUE_BURST_THRESHOLD).toBeGreaterThanOrEqual(3);
    expect(OPAQUE_BURST_WINDOW_MS).toBeLessThanOrEqual(30 * 60_000);
  });

  it("counts one address once however often its browser reloads or retries", async () => {
    let last;
    for (let i = 0; i < 40; i++) last = await countOpaqueScriptError(SURFACE, address(1));
    expect(last).toEqual({ newAddress: false, addresses: 1, burst: false, measured: true });
  });

  it("reports the first opaque report as counted, one address, no burst", async () => {
    expect(await countOpaqueScriptError(SURFACE, address(1))).toEqual({
      newAddress: true,
      addresses: 1,
      burst: false,
      measured: true,
    });
  });

  it("one address short of the threshold is not a burst", async () => {
    let last;
    for (let n = 1; n < OPAQUE_BURST_THRESHOLD; n++) last = await countOpaqueScriptError(SURFACE, address(n));
    expect(last).toEqual({ newAddress: true, addresses: OPAQUE_BURST_THRESHOLD - 1, burst: false, measured: true });
  });

  it("is a burst on the report that brings distinct addresses to the threshold", async () => {
    for (let n = 1; n < OPAQUE_BURST_THRESHOLD; n++) await countOpaqueScriptError(SURFACE, address(n));
    expect(await countOpaqueScriptError(SURFACE, address(OPAQUE_BURST_THRESHOLD))).toEqual({
      newAddress: true,
      addresses: OPAQUE_BURST_THRESHOLD,
      burst: true,
      measured: true,
    });
  });

  it("does not count a surface's reports against another surface", async () => {
    for (let n = 1; n < OPAQUE_BURST_THRESHOLD; n++) await countOpaqueScriptError(SURFACE, address(n));
    expect((await countOpaqueScriptError("client_error:booking", address(99))).burst).toBe(false);
  });

  it("starts again once the window has passed", async () => {
    for (let n = 1; n < OPAQUE_BURST_THRESHOLD; n++) await countOpaqueScriptError(SURFACE, address(n));
    db.advance(OPAQUE_BURST_WINDOW_MS + 1000);
    expect(await countOpaqueScriptError(SURFACE, address(50))).toEqual({
      newAddress: true,
      addresses: 1,
      burst: false,
      measured: true,
    });
  });

  it("writes under its own two key spaces, never the boundary or limiter ones", async () => {
    await countOpaqueScriptError(SURFACE, address(1));
    expect([...db.rows.keys()].sort()).toEqual([
      `opaque_script_error_address:${SURFACE}:${address(1)}`,
      `opaque_script_error_count:${SURFACE}`,
    ]);
  });

  // FAILING CLOSED. The limiter in front of this route asks the same RPC and
  // already drops every report when it is down, and failing open here would page
  // on every single opaque report while it lasted, which is the noise #3323 ends.
  it("never calls a burst when the counter errors, and says it is unmeasured", async () => {
    override.rpc = async () => ({ data: null, error: { message: "rpc down" } });
    expect(await countOpaqueScriptError(SURFACE, address(1))).toEqual({
      newAddress: false,
      addresses: null,
      burst: false,
      measured: false,
    });
  });

  it("never calls a burst when the counter throws, and never throws itself", async () => {
    override.rpc = async () => {
      throw new Error("network");
    };
    await expect(countOpaqueScriptError(SURFACE, address(1))).resolves.toEqual({
      newAddress: false,
      addresses: null,
      burst: false,
      measured: false,
    });
  });
});
