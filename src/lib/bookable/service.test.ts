import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Reachability } from "@/lib/google/reachability-classify";

// #281 + #913: the bookable-toggle service. Making an agent bookable when Slate
// can't reach their Google calendar must BLOCK the flip (the agent never enters
// the pool) and fire a named alert, because verify-on-book would otherwise fail
// them at confirm time. A DEFINITIVE failure (gone) blocks immediately; a
// TRANSIENT failure is retried once and only then blocks, with a distinct
// "couldn't verify" reason/alert. Deactivation is never blocked. Supabase is
// mocked; the reachability probe and alerter are injected.

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

// checkReachable yields the given outcomes in order (last one repeats), so a
// test can model the retry: e.g. deps("transient", "reachable").
function deps(...outcomes: Reachability[]) {
  const seq = [...outcomes];
  return {
    checkReachable: vi.fn(async (_email: string) => seq.shift() ?? outcomes[outcomes.length - 1]),
    notify: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  };
}

describe("applyBookableByEmail", () => {
  beforeEach(() => {
    updates.length = 0;
    currentUser = null;
  });

  it("returns not_found for an unknown email and writes nothing", async () => {
    const d = deps("reachable");
    const res = await applyBookableByEmail("nobody@trypennie.com", true, d);
    expect(res.status).toBe("not_found");
    expect(updates).toEqual([]);
    expect(d.checkReachable).not.toHaveBeenCalled();
  });

  it("is a no-op when already in the target state (no probe, no write)", async () => {
    currentUser = { id: "u1", bookable: true };
    const d = deps("reachable");
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res.status).toBe("noop");
    expect(updates).toEqual([]);
    expect(d.checkReachable).not.toHaveBeenCalled();
  });

  it("applies activation when the calendar is reachable", async () => {
    currentUser = { id: "u1", bookable: false };
    const d = deps("reachable");
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "applied", userId: "u1", bookable: true });
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
    expect(d.checkReachable).toHaveBeenCalledTimes(1);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("BLOCKS immediately on a gone account (no retry), reason google_unreachable", async () => {
    currentUser = { id: "u1", bookable: false };
    const d = deps("gone");
    const res = await applyBookableByEmail("gone@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "blocked", userId: "u1", reason: "google_unreachable" });
    expect(updates).toEqual([]);
    expect(d.checkReachable).toHaveBeenCalledTimes(1); // gone is definitive, no retry
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0]).toBe("bookable_blocked:u1");
  });

  it("retries once on transient, then applies if the retry succeeds", async () => {
    currentUser = { id: "u1", bookable: false };
    const d = deps("transient", "reachable");
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "applied", bookable: true });
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
    expect(d.checkReachable).toHaveBeenCalledTimes(2);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("retries once on transient, then BLOCKS with google_unverified if still transient", async () => {
    currentUser = { id: "u1", bookable: false };
    const d = deps("transient", "transient");
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "blocked", userId: "u1", reason: "google_unverified" });
    expect(updates).toEqual([]);
    expect(d.checkReachable).toHaveBeenCalledTimes(2);
    expect(d.notify).toHaveBeenCalledTimes(1);
    // distinct alert key from the gone case so they don't throttle each other
    expect(d.notify.mock.calls[0][0]).toBe("bookable_unverified:u1");
  });

  it("blocks on gone even when it surfaces on the retry", async () => {
    currentUser = { id: "u1", bookable: false };
    const d = deps("transient", "gone");
    const res = await applyBookableByEmail("gone@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "blocked", reason: "google_unreachable" });
    expect(updates).toEqual([]);
  });

  it("never probes or blocks on deactivation (bookable=false)", async () => {
    currentUser = { id: "u1", bookable: true };
    const d = deps("gone");
    const res = await applyBookableByEmail("agent@trypennie.com", false, d);
    expect(res).toMatchObject({ status: "applied", userId: "u1", bookable: false });
    expect(updates).toEqual([{ id: "u1", bookable: false }]);
    expect(d.checkReachable).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });
});
