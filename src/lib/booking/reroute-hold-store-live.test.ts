import { describe, it, expect, vi } from "vitest";

// #3248: building the hold store's deps must never touch the database client, so a
// missing key or a bad environment fails inside the caller's own catch (the self
// heal lane's sweep boundary, L73) instead of while the deps are being wired.

const admin = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({
    rpc: vi.fn(async (name: string) => ({ data: [{ fn: name }], error: null })),
  })),
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/availability/slot-cache", () => ({ refreshPoolsForAgents: vi.fn(async () => null) }));

import { rerouteHoldStoreDeps } from "./reroute-hold-store-live";

describe("rerouteHoldStoreDeps", () => {
  it("makes no database client until a call is made", async () => {
    admin.supabaseAdmin.mockClear();
    const deps = rerouteHoldStoreDeps("test");
    expect(admin.supabaseAdmin).not.toHaveBeenCalled();
    const res = await deps.pruneRpc();
    expect(admin.supabaseAdmin).toHaveBeenCalledTimes(1);
    expect(res.data).toEqual([{ fn: "prune_expired_reroute_hold_blocks" }]);
  });

  it("so a client that cannot be made throws at the call, where the caller catches it", async () => {
    admin.supabaseAdmin.mockImplementationOnce(() => {
      throw new Error("SUPABASE_SECRET_KEY is not set");
    });
    const deps = rerouteHoldStoreDeps("test");
    expect(() => deps.pruneRpc()).toThrow(/SUPABASE_SECRET_KEY/);
  });
});
