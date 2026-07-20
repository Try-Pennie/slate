import { describe, it, expect, vi, beforeEach } from "vitest";

// #281: the bookable-toggle service. The heart of the issue is the activation
// guard: making an agent bookable when Slate can't reach their Google calendar
// must BLOCK the flip (the agent never enters the pool) and fire a named alert,
// because verify-on-book would otherwise fail them at confirm time. Deactivation
// (bookable=false) is never blocked. Supabase is mocked; the reachability probe
// and the alerter are injected so no Google/Slack call happens.

const updates: Array<{ id: string; bookable: boolean }> = [];
let currentUser: { id: string; bookable: boolean } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: currentUser, error: null }) }),
      }),
      update: (patch: { bookable: boolean }) => ({
        eq: async (_col: string, id: string) => {
          updates.push({ id, bookable: patch.bookable });
          return { error: null };
        },
      }),
    }),
  }),
}));

import { applyBookableByEmail } from "./service";

function deps(reachable: boolean) {
  return {
    checkReachable: vi.fn(async (_email: string) => reachable),
    notify: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  };
}

describe("applyBookableByEmail", () => {
  beforeEach(() => {
    updates.length = 0;
    currentUser = null;
  });

  it("returns not_found for an unknown email and writes nothing", async () => {
    const d = deps(true);
    const res = await applyBookableByEmail("nobody@trypennie.com", true, d);
    expect(res.status).toBe("not_found");
    expect(updates).toEqual([]);
    expect(d.checkReachable).not.toHaveBeenCalled();
  });

  it("is a no-op when already in the target state (no probe, no write)", async () => {
    currentUser = { id: "u1", bookable: true };
    const d = deps(true);
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res.status).toBe("noop");
    expect(updates).toEqual([]);
    expect(d.checkReachable).not.toHaveBeenCalled();
  });

  it("applies activation when the calendar is reachable", async () => {
    currentUser = { id: "u1", bookable: false };
    const d = deps(true);
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "applied", userId: "u1", bookable: true });
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
    expect(d.checkReachable).toHaveBeenCalledWith("agent@trypennie.com");
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("BLOCKS activation and alerts when the calendar is unreachable (no write)", async () => {
    currentUser = { id: "u1", bookable: false };
    const d = deps(false);
    const res = await applyBookableByEmail("gone@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "blocked", userId: "u1", reason: "google_unreachable" });
    expect(updates).toEqual([]);
    expect(d.notify).toHaveBeenCalledTimes(1);
    // named, per-agent alert key so one broken agent can't throttle another
    expect(d.notify.mock.calls[0][0]).toBe("bookable_blocked:u1");
  });

  it("never probes or blocks on deactivation (bookable=false)", async () => {
    currentUser = { id: "u1", bookable: true };
    const d = deps(false);
    const res = await applyBookableByEmail("agent@trypennie.com", false, d);
    expect(res).toMatchObject({ status: "applied", userId: "u1", bookable: false });
    expect(updates).toEqual([{ id: "u1", bookable: false }]);
    expect(d.checkReachable).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });
});
