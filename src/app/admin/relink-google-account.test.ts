import { describe, it, expect, vi, beforeEach } from "vitest";

// #3526: an admin linking a new Google account to somebody's Slate account.
//
// Sign in refuses a Google account other than the one a row was set up with,
// because a reused address would otherwise hand a newcomer the old row. A real
// rehire on a NEW Google account is the case that refusal also catches, and this
// is how it is let through: the stored account id is forgotten, and their next
// sign in records the new one. These tests carry who may press it, that it is a
// compare and swap on the id it read, that it touches nothing else on the row,
// that the trail records it, and that every outcome comes back to the page.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireSuperAdmin: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async (_entry: Record<string, unknown>) => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

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

import { relinkGoogleAccount } from "./actions";
import { GOOGLE_RELINK_REFUSED } from "@/lib/auth/google-identity-copy";

function form(userId = "u1"): FormData {
  const fd = new FormData();
  fd.set("user_id", userId);
  return fd;
}

/** The refusal sentence a redirect carried, decoded. */
async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: Error) => e);
  const url = String(err).replace(/^Error: NEXT_REDIRECT:/, "");
  return decodeURIComponent(url.split("?error=")[1] ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
  db.row = { id: "u1", role: "agent", google_sub: "sub-old" };
  db.readError = null;
  db.writeError = null;
  db.changed = [{ id: "u1" }];
  db.updates = [];
  db.readFilters = [];
});

describe("relinkGoogleAccount", () => {
  it("forgets only the stored account id, conditionally, records it, and says so", async () => {
    await expect(relinkGoogleAccount(form())).rejects.toThrow(
      "NEXT_REDIRECT:/admin/agents/u1?ok=agent-google-relinked",
    );
    expect(db.updates).toHaveLength(1);
    // Nothing else on the row moves: the role, the bookings and the calendar stay
    // with the person, which is the point of relinking rather than recreating.
    expect(db.updates[0].patch).toEqual({ google_sub: null });
    // A compare and swap on the id it read, scoped to the admin's org.
    expect(db.updates[0].filters).toEqual(
      expect.arrayContaining([
        ["id", "u1"],
        ["org_id", "o1"],
        ["google_sub", "sub-old"],
      ]),
    );
    expect(db.readFilters).toEqual(expect.arrayContaining([["org_id", "o1"]]));
    expect(recordAudit).toHaveBeenCalledTimes(1);
    // The trail says an account was unlinked, never the account id itself.
    expect(recordAudit).toHaveBeenCalledWith({
      orgId: "o1",
      actorId: "admin1",
      action: "agent.google_relinked",
      targetUserId: "u1",
      details: { google_account: { from: "linked", to: "unlinked" } },
    });
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain("sub-old");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/agents/u1");
  });

  it("is admin only: a refused requireAdmin writes and records nothing", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(relinkGoogleAccount(form())).rejects.toThrow("Not authorized");
    expect(db.updates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a target the admin may not manage (a super admin), on the page", async () => {
    db.row = { id: "u1", role: "super_admin", google_sub: "sub-old" };
    expect(await refusal(relinkGoogleAccount(form()))).toBe(GOOGLE_RELINK_REFUSED.notPermitted);
    expect(db.updates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("says nothing was linked, and writes nothing, when no account id is stored", async () => {
    db.row = { id: "u1", role: "agent", google_sub: null };
    expect(await refusal(relinkGoogleAccount(form()))).toBe(GOOGLE_RELINK_REFUSED.nothingLinked);
    expect(db.updates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("records nothing when the conditional write changed no row", async () => {
    db.changed = [];
    expect(await refusal(relinkGoogleAccount(form()))).toBe(GOOGLE_RELINK_REFUSED.nothingLinked);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("answers missing for a user outside the org or gone", async () => {
    db.row = null;
    expect(await refusal(relinkGoogleAccount(form()))).toBe(GOOGLE_RELINK_REFUSED.missing);
    expect(db.updates).toHaveLength(0);
  });

  it("answers unreadable, and writes nothing, when the row cannot be read", async () => {
    db.readError = { message: "connection reset" };
    expect(await refusal(relinkGoogleAccount(form()))).toBe(GOOGLE_RELINK_REFUSED.unreadable);
    expect(db.updates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("shows a refused write on the page and records nothing", async () => {
    db.writeError = { message: "permission denied", code: "42501" };
    expect(await refusal(relinkGoogleAccount(form()))).toContain("permission denied");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
