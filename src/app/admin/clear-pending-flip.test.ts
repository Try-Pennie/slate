import { describe, it, expect, vi, beforeEach } from "vitest";

// #2078: an admin settling a pending bookable flip by hand.
//
// The toggle cannot do it: "not bookable" on somebody already not bookable is a
// noop, so the write that clears `bookable_pending_since` is never reached and the
// hourly sync goes on retrying and re-alerting. Latent today (nobody is pending),
// so these tests are what carries it: who may press it, that it never moves
// `bookable`, that it is a compare and swap so a second press or a racing sync
// writes nothing twice, that the trail records the old and new values, and that
// every outcome comes back to the page as a code it can draw.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireSuperAdmin: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

const SINCE = "2026-09-08T14:00:00+00:00";

/** What the fake database holds and answers, per test. */
const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  readError: null as { message: string } | null,
  writeError: null as { message: string; code?: string } | null,
  /** Rows the conditional update reports it changed. */
  changed: [{ id: "u1" }] as { id: string }[],
  updates: [] as { patch: Record<string, unknown>; filters: [string, unknown][] }[],
  readFilters: [] as [string, unknown][],
}));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (_t: string) => ({
      select: () => {
        const chain = {
          eq: (col: string, v: unknown) => {
            db.readFilters.push([col, v]);
            return chain;
          },
          maybeSingle: async () => ({ data: db.row, error: db.readError }),
        };
        return chain;
      },
      update: (patch: Record<string, unknown>) => {
        const entry = { patch, filters: [] as [string, unknown][] };
        db.updates.push(entry);
        const chain = {
          eq: (col: string, v: unknown) => {
            entry.filters.push([col, v]);
            return chain;
          },
          select: async () =>
            db.writeError ? { data: null, error: db.writeError } : { data: db.changed, error: null },
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({
  applyBookableByUserId: vi.fn(),
  BookableLookupError: class extends Error {},
}));
vi.mock("@/lib/salesforce/run-roster-sync", () => ({ runRosterSync: vi.fn() }));

import { clearPendingBookableFlip } from "./actions";

function form(userId = "u1"): FormData {
  const fd = new FormData();
  fd.set("user_id", userId);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
  db.row = { id: "u1", role: "agent", bookable: false, bookable_pending_since: SINCE };
  db.readError = null;
  db.writeError = null;
  db.changed = [{ id: "u1" }];
  db.updates = [];
  db.readFilters = [];
});

describe("clearPendingBookableFlip", () => {
  it("clears only the mark, conditionally, and records the old and new values", async () => {
    await expect(clearPendingBookableFlip(form())).rejects.toThrow(
      "NEXT_REDIRECT:/admin/agents/u1?bookable=pending-cleared",
    );
    expect(db.updates).toHaveLength(1);
    // Never `bookable` itself: this is a decision NOT to flip, and the column has
    // one owning writer (routable-write.ts).
    expect(db.updates[0].patch).toEqual({ bookable_pending_since: null });
    // A compare and swap on the stamp it read, scoped to the admin's org, so a
    // sync that settled or re-marked the row in between is not overwritten.
    expect(db.updates[0].filters).toEqual(
      expect.arrayContaining([
        ["id", "u1"],
        ["org_id", "o1"],
        ["bookable_pending_since", SINCE],
      ]),
    );
    expect(db.readFilters).toEqual(expect.arrayContaining([["org_id", "o1"]]));
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith({
      orgId: "o1",
      actorId: "admin1",
      action: "agent.pending_flip_cleared",
      targetUserId: "u1",
      details: { bookable_pending_since: { from: SINCE, to: null }, bookable: false },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/agents/u1");
  });

  it("is admin only: a refused requireAdmin writes and records nothing", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(clearPendingBookableFlip(form())).rejects.toThrow("Not authorized");
    expect(db.updates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a target the admin may not manage (a super admin)", async () => {
    db.row = { id: "u1", role: "super_admin", bookable: false, bookable_pending_since: SINCE };
    await expect(clearPendingBookableFlip(form())).rejects.toThrow(
      "NEXT_REDIRECT:/admin/agents/u1?bookable=not-permitted",
    );
    expect(db.updates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("says nothing was pending, and writes nothing, when the mark is already gone", async () => {
    db.row = { id: "u1", role: "agent", bookable: false, bookable_pending_since: null };
    await expect(clearPendingBookableFlip(form())).rejects.toThrow(
      "NEXT_REDIRECT:/admin/agents/u1?bookable=pending-none",
    );
    expect(db.updates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("records nothing when the conditional write changed no row (a racing sync settled it)", async () => {
    db.changed = [];
    await expect(clearPendingBookableFlip(form())).rejects.toThrow(
      "NEXT_REDIRECT:/admin/agents/u1?bookable=pending-none",
    );
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("answers missing for a user outside the org or gone", async () => {
    db.row = null;
    await expect(clearPendingBookableFlip(form())).rejects.toThrow(
      "NEXT_REDIRECT:/admin/agents/u1?bookable=missing",
    );
    expect(db.updates).toHaveLength(0);
  });

  it("answers unreadable, and writes nothing, when the row cannot be read", async () => {
    db.readError = { message: "connection reset" };
    await expect(clearPendingBookableFlip(form())).rejects.toThrow(
      "NEXT_REDIRECT:/admin/agents/u1?bookable=unreadable",
    );
    expect(db.updates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("shows a refused write on the page and records nothing", async () => {
    db.writeError = { message: "permission denied", code: "42501" };
    const err = await clearPendingBookableFlip(form()).catch((e: Error) => e);
    expect(String(err)).toContain("NEXT_REDIRECT:/admin/agents/u1?error=");
    expect(decodeURIComponent(String(err))).toContain("permission denied");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
