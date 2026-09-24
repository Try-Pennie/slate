import { describe, it, expect, vi, beforeEach } from "vitest";

// #2090: the Regal call ignore list's two server actions.
//
// What no pure test can see: that the SERVER re-checks the rules the picker
// applied (a posted form is not bound by the options it was drawn with), that a
// refused write lands as a refusal on the page and records no audit entry, and
// that each outcome names which way the list moved.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
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
const db = vi.hoisted(() => ({
  target: null as Record<string, unknown> | null,
  insertError: null as { message: string; code?: string } | null,
  deleted: [{ reason: "dialer only" }] as { reason: string }[],
  deleteError: null as { message: string } | null,
  inserted: [] as Record<string, unknown>[],
}));
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    if (table === "users") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.target, error: null }) }) }),
      };
    }
    return {
      insert: async (row: Record<string, unknown>) => {
        if (!db.insertError) db.inserted.push(row);
        return { error: db.insertError };
      },
      delete: () => ({
        eq: () => ({
          select: async () => ({ data: db.deleteError ? null : db.deleted, error: db.deleteError }),
        }),
      }),
    };
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { addRegalCallIgnore, removeRegalCallIgnore } from "./actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}
const AGENT = { id: "u1", name: "Ada Example", email: "ada@trypennie.com", role: "agent", is_test: false, deactivated_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  db.target = AGENT;
  db.insertError = null;
  db.deleted = [{ reason: "dialer only" }];
  db.deleteError = null;
  db.inserted = [];
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
});

describe("addRegalCallIgnore", () => {
  it("adds an agent with a reason, who added them, and an audit entry", async () => {
    await expect(addRegalCallIgnore(form({ user_id: "u1", reason: " dialer only " }))).rejects.toThrow(
      /NEXT_REDIRECT:\/admin\/alerts\?ok=regal-ignore-added/,
    );
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({ user_id: "u1", reason: "dialer only", added_by: "admin1" });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "regal.ignore_added", targetUserId: "u1" }),
    );
  });

  it("refuses a manager posted past the picker, and writes nothing", async () => {
    db.target = { ...AGENT, role: "manager" };
    await expect(addRegalCallIgnore(form({ user_id: "u1", reason: "x" }))).rejects.toThrow(/error=/);
    expect(db.inserted).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses an entry with no reason", async () => {
    await expect(addRegalCallIgnore(form({ user_id: "u1", reason: "   " }))).rejects.toThrow(/error=/);
    expect(db.inserted).toHaveLength(0);
  });

  it("says somebody is already listed rather than replacing their reason", async () => {
    db.insertError = { message: "duplicate key", code: "23505" };
    await expect(addRegalCallIgnore(form({ user_id: "u1", reason: "x" }))).rejects.toThrow(
      /already%20on%20the%20ignore%20list/,
    );
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a failed write before the audit entry and the saved notice", async () => {
    db.insertError = { message: "permission denied" };
    await expect(addRegalCallIgnore(form({ user_id: "u1", reason: "x" }))).rejects.toThrow(/error=/);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("removeRegalCallIgnore", () => {
  it("removes, audits with the reason that was removed, and says which way the list moved", async () => {
    await expect(removeRegalCallIgnore(form({ user_id: "u1" }))).rejects.toThrow(/ok=regal-ignore-removed/);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "regal.ignore_removed", details: { reason: "dialer only" } }),
    );
  });

  it("says so when nobody was on the list to remove, and records nothing", async () => {
    db.deleted = [];
    await expect(removeRegalCallIgnore(form({ user_id: "u1" }))).rejects.toThrow(/error=/);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a failed delete before any audit entry", async () => {
    db.deleteError = { message: "permission denied" };
    await expect(removeRegalCallIgnore(form({ user_id: "u1" }))).rejects.toThrow(/error=/);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
