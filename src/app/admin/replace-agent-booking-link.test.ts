import { describe, it, expect, vi, beforeEach } from "vitest";

// #2073: an admin replaces an agent's own booking link, which stops the old one
// working at once. Pinned: admin only; scoped to the admin's own org; a refused
// write reports nothing as done (no audit entry, no saved notice); the audit
// entry never carries the token, which is a working link wherever it is written.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
  requireSuperAdmin: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async (_entry: unknown) => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const store = vi.hoisted(() => ({
  replaceAgentLinkToken: vi.fn(async (_userId: string, _actorId: string) => "cd".repeat(32)),
}));
// The target lookup: one row in the admin's org, or none.
const target = vi.hoisted(() => ({ row: { id: "u1" } as { id: string } | null }));
const from = vi.hoisted(() =>
  vi.fn(() => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: target.row, error: null });
    return b;
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/agent-link/store", () => store);
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { replaceAgentBookingLink } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  target.row = { id: "u1" };
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
  store.replaceAgentLinkToken.mockResolvedValue("cd".repeat(32));
});

describe("replaceAgentBookingLink (#2073)", () => {
  it("refuses a caller who is not an admin, replacing nothing", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(replaceAgentBookingLink(form({ user_id: "u1" }))).rejects.toThrow("Not authorized");
    expect(store.replaceAgentLinkToken).not.toHaveBeenCalled();
  });

  it("refuses an agent outside the admin's org, replacing nothing", async () => {
    target.row = null;
    await expect(replaceAgentBookingLink(form({ user_id: "u9" }))).rejects.toThrow("Not authorized");
    expect(store.replaceAgentLinkToken).not.toHaveBeenCalled();
  });

  it("replaces the link, records who did it without the token, and says so on the agent's page", async () => {
    await expect(replaceAgentBookingLink(form({ user_id: "u1" }))).rejects.toThrow(
      "NEXT_REDIRECT:/admin/agents/u1?ok=agent-booking-link",
    );
    expect(store.replaceAgentLinkToken).toHaveBeenCalledWith("u1", "admin1");
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const entry = recordAudit.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.action).toBe("agent.booking_link_replaced");
    expect(entry.targetUserId).toBe("u1");
    expect(JSON.stringify(entry)).not.toContain("cd".repeat(32));
    expect(revalidatePath).toHaveBeenCalledWith("/admin/agents/u1");
    expect(revalidatePath).toHaveBeenCalledWith("/me/my-availability");
  });

  it("reports nothing as done when the write is refused", async () => {
    store.replaceAgentLinkToken.mockRejectedValueOnce(new Error("agent link: the new link could not be saved: timeout"));
    await expect(replaceAgentBookingLink(form({ user_id: "u1" }))).rejects.toThrow(/could not be saved/);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
