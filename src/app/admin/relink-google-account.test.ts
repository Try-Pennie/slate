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
// Each entry also lands in `db.steps`, so a test can see WHEN the trail was written
// relative to the deletion and the row write.
const recordAudit = vi.hoisted(() =>
  vi.fn(async (entry: Record<string, unknown>) => {
    db.steps.push(`audit:${String(entry.action)}`);
  }),
);
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
  /** Every call in order, so a test can assert the auth user goes BEFORE the row. */
  steps: [] as string[],
  /** What the admin API answers when asked to delete the old auth user. */
  deleteError: null as { message: string; status?: number } | null,
  deleted: [] as string[],
}));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          db.steps.push(`delete-auth:${id}`);
          if (db.deleteError) return { data: null, error: db.deleteError };
          db.deleted.push(id);
          return { data: {}, error: null };
        },
      },
    },
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
        db.steps.push("update-row");
        const chain = {
          eq: (col: string, v: unknown) => {
            entry.filters.push([col, v]);
            return chain;
          },
          is: (col: string, v: unknown) => {
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
  db.row = { id: "u1", role: "agent", google_sub: "sub-old", auth_user_id: "auth-old" };
  db.readError = null;
  db.writeError = null;
  db.changed = [{ id: "u1" }];
  db.updates = [];
  db.readFilters = [];
  db.steps = [];
  db.deleteError = null;
  db.deleted = [];
});

describe("relinkGoogleAccount", () => {
  it("forgets only the stored account id, conditionally, records it, and says so", async () => {
    await expect(relinkGoogleAccount(form())).rejects.toThrow(
      "NEXT_REDIRECT:/admin/agents/u1?ok=agent-google-relinked",
    );
    expect(db.updates).toHaveLength(1);
    // Nothing else on the row moves: the role, the bookings and the calendar stay
    // with the person, which is the point of relinking rather than recreating. The
    // link to the old auth user goes too, since that auth user is deleted.
    expect(db.updates[0].patch).toEqual({ google_sub: null, auth_user_id: null });
    // The old auth user (and with it the old Google identity) is deleted FIRST, so
    // the rehire's next sign in lands on a fresh auth user holding only their new
    // account, and a failure there leaves the row untouched and the press retryable.
    // The deletion is recorded the moment it happens, before the row write that
    // could still fail, so it is in the trail exactly once whatever follows.
    expect(db.steps).toEqual([
      "delete-auth:auth-old",
      "audit:agent.sign_in_removed",
      "update-row",
      "audit:agent.google_relinked",
    ]);
    // A compare and swap on the id it read, scoped to the admin's org.
    expect(db.updates[0].filters).toEqual(
      expect.arrayContaining([
        ["id", "u1"],
        ["org_id", "o1"],
        ["google_sub", "sub-old"],
      ]),
    );
    expect(db.readFilters).toEqual(expect.arrayContaining([["org_id", "o1"]]));
    expect(recordAudit).toHaveBeenCalledTimes(2);
    // The trail says a sign in was removed and an account unlinked, never the
    // account id or the auth user id itself.
    expect(recordAudit).toHaveBeenCalledWith({
      orgId: "o1",
      actorId: "admin1",
      action: "agent.sign_in_removed",
      targetUserId: "u1",
      details: { sign_in: { from: "present", to: "deleted" }, because: "relink google account" },
    });
    expect(recordAudit).toHaveBeenCalledWith({
      orgId: "o1",
      actorId: "admin1",
      action: "agent.google_relinked",
      targetUserId: "u1",
      details: { google_account: { from: "linked", to: "unlinked" } },
    });
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain("auth-old");
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain("sub-old");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/agents/u1");
  });

  it("refuses, and changes nothing, when the old auth user cannot be deleted", async () => {
    db.deleteError = { message: "service unavailable", status: 503 };
    expect(await refusal(relinkGoogleAccount(form()))).toBe(GOOGLE_RELINK_REFUSED.signInNotRemoved);
    expect(db.updates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // A press that deleted the auth user and then failed on the row write leaves the
  // row still holding the account id, so the control is still offered; the retry
  // finds the auth user already gone and finishes the job.
  it("carries on when the old auth user is already gone, recording no deletion it did not make", async () => {
    db.deleteError = { message: "User not found", status: 404 };
    await expect(relinkGoogleAccount(form())).rejects.toThrow("?ok=agent-google-relinked");
    expect(db.updates).toHaveLength(1);
    expect(db.steps).toEqual(["delete-auth:auth-old", "update-row", "audit:agent.google_relinked"]);
  });

  it("deletes no auth user when the row is linked to none", async () => {
    db.row = { id: "u1", role: "agent", google_sub: "sub-old", auth_user_id: null };
    await expect(relinkGoogleAccount(form())).rejects.toThrow("?ok=agent-google-relinked");
    expect(db.steps).toEqual(["update-row", "audit:agent.google_relinked"]);
  });

  // The audit gap the re-review found: a delete that landed followed by a row write
  // that failed used to leave the deletion unrecorded, and the retry then said no
  // sign in was removed.
  it("records the deletion even when the row write after it fails", async () => {
    db.writeError = { message: "permission denied", code: "42501" };
    expect(await refusal(relinkGoogleAccount(form()))).toContain("permission denied");
    expect(db.steps).toEqual(["delete-auth:auth-old", "audit:agent.sign_in_removed", "update-row"]);
  });

  // A row with no account recorded whose auth user holds no Google identity, or
  // two, is refused on every request; this is the admin's way out for it.
  it("removes the sign in of a row with no account recorded but a sign in on record", async () => {
    db.row = { id: "u1", role: "agent", google_sub: null, auth_user_id: "auth-stuck" };
    await expect(relinkGoogleAccount(form())).rejects.toThrow("?ok=agent-google-relinked");
    expect(db.steps).toEqual(["delete-auth:auth-stuck", "audit:agent.sign_in_removed", "update-row"]);
    // The swap matches the row as read: still no account recorded.
    expect(db.updates[0].filters).toEqual(expect.arrayContaining([["google_sub", null]]));
  });

  it("says nothing was linked when the row has neither an account nor a sign in", async () => {
    db.row = { id: "u1", role: "agent", google_sub: null, auth_user_id: null };
    expect(await refusal(relinkGoogleAccount(form()))).toBe(GOOGLE_RELINK_REFUSED.nothingLinked);
    expect(db.steps).toEqual([]);
  });

  // Relinking yourself deletes the auth user your own session runs on.
  it("refuses an admin relinking their own account", async () => {
    auth.requireAdmin.mockResolvedValue({ id: "u1", role: "admin", org_id: "o1" });
    db.row = { id: "u1", role: "admin", google_sub: "sub-old", auth_user_id: "auth-old" };
    expect(await refusal(relinkGoogleAccount(form()))).toBe(GOOGLE_RELINK_REFUSED.self);
    expect(db.steps).toEqual([]);
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

  it("records no unlink when the conditional write changed no row (only the deletion it made)", async () => {
    db.changed = [];
    expect(await refusal(relinkGoogleAccount(form()))).toBe(GOOGLE_RELINK_REFUSED.nothingLinked);
    expect(db.steps).toEqual(["delete-auth:auth-old", "audit:agent.sign_in_removed", "update-row"]);
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

  it("shows a refused write on the page and records no unlink", async () => {
    db.row = { id: "u1", role: "agent", google_sub: "sub-old", auth_user_id: null };
    db.writeError = { message: "permission denied", code: "42501" };
    expect(await refusal(relinkGoogleAccount(form()))).toContain("permission denied");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
