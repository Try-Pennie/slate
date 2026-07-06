import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial branches for the two escalation-sensitive admin server actions (#676).
// setUserRole composes canSetRole / isSelfDemotion / canChangeRole; the role
// helpers are unit-tested on their own, so this pins that the action WIRES them
// as gates (rejects and never writes) rather than re-testing the predicates.
// startImpersonation's admin-floor and role-ceiling (#588) guards are pinned the
// same way. The real role helpers are exercised; only auth, DB, cookies, redirect
// and audit are mocked.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireManager: vi.fn(),
  realCurrentUser: vi.fn(),
  currentUser: vi.fn(),
}));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const revalidatePath = vi.hoisted(() => vi.fn());
const cookieStore = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));

const dbState = vi.hoisted(() => ({ single: null as unknown, count: 0 }));
const updateEq = vi.hoisted(() => vi.fn(async () => ({})));
const update = vi.hoisted(() => vi.fn(() => ({ eq: updateEq })));
const from = vi.hoisted(() =>
  vi.fn(() => {
    const q: Record<string, unknown> = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      in: vi.fn(async () => ({ count: dbState.count })),
      maybeSingle: vi.fn(async () => ({ data: dbState.single })),
      update,
    };
    return q;
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));

import { setUserRole, startImpersonation } from "./actions";

const admin = { id: "admin1", role: "admin", org_id: "o1" };

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.single = null;
  dbState.count = 0;
});

describe("setUserRole denial branches", () => {
  it("rejects a non-admin caller and never touches the DB", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setUserRole(form({ user_id: "u2", role: "agent" }))).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects when a regular admin tries to grant super_admin, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "agent" };
    await expect(
      setUserRole(form({ user_id: "u2", role: "super_admin" })),
    ).rejects.toThrow(/not authorized to set this role/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("blocks an admin from demoting themselves, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "admin" };
    await expect(
      setUserRole(form({ user_id: admin.id, role: "agent" })),
    ).rejects.toThrow(/your own admin access/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("blocks removing the last admin, and does not write", async () => {
    auth.requireAdmin.mockResolvedValueOnce(admin);
    dbState.single = { role: "admin" };
    dbState.count = 1;
    await expect(
      setUserRole(form({ user_id: "u2", role: "agent" })),
    ).rejects.toThrow(/last admin/i);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("startImpersonation denial branches", () => {
  it("rejects a non-admin caller before any lookup or cookie is set", async () => {
    auth.realCurrentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    await expect(startImpersonation(form({ email: "someone@x.com" }))).rejects.toThrow(
      /not authorized/i,
    );
    expect(from).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("refuses to impersonate a peer of equal rank (role ceiling), setting no cookie", async () => {
    auth.realCurrentUser.mockResolvedValueOnce(admin);
    dbState.single = { id: "peer1", role: "admin" };
    await expect(
      startImpersonation(form({ email: "peer@x.com" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const target = redirect.mock.calls.find(([u]) => String(u).includes("imp_error"));
    expect(target).toBeTruthy();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});
