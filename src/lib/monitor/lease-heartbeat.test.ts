import { describe, it, expect, vi, beforeEach } from "vitest";

// #3120 review: a fenced lane that lost its lease abandoned part of its work, and
// stamping the dead man's switch anyway made a lane that keeps losing its lease
// read as healthy for ever. The stamp is withheld, so the lane goes stale and pages.

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { warn: logWarn, info: vi.fn(), error: vi.fn() } }));

import { leaseHeldThroughout } from "./lease-heartbeat";
import type { LeaseStopReason, LockLease } from "@/lib/locks";

const lease = (stopped: LeaseStopReason | null): LockLease => ({
  key: "cron_x",
  token: () => "t",
  stillHeld: async () => stopped === null,
  stopReason: () => stopped,
});

beforeEach(() => vi.clearAllMocks());

describe("leaseHeldThroughout", () => {
  it("lets the lane stamp when the lease held for the whole run", () => {
    expect(leaseHeldThroughout(lease(null), "sync")).toBe(true);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it.each(["taken", "refused"] as const)("withholds the stamp when the lease was %s, and says so", (why) => {
    expect(leaseHeldThroughout(lease(why), "sync")).toBe(false);
    expect(logWarn).toHaveBeenCalledWith("locks", expect.objectContaining({ lane: "sync", why }));
  });
});
