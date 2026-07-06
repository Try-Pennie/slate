import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role, User } from "@/lib/db/types";

// Integration coverage for the #588 impersonation role ceiling as it runs
// through the real DB/cookie boundary in currentUser + getImpersonation. The
// pure predicate (canImpersonate) is unit-tested in scripts/test-roles.ts; this
// verifies the wiring actually applies it after fetching the target: an admin
// impersonating someone who outranks-or-equals them must resolve back to the
// admin, never to the higher-ranked target.

// Queue of rows returned by the chained supabase builder's maybeSingle(), in
// call order: [ real signed-in user, impersonation target ].
const dbRows = vi.hoisted(() => ({ queue: [] as (unknown | null)[] }));
const maybeSingle = vi.hoisted(() =>
  vi.fn(async () => ({ data: dbRows.queue.shift() ?? null })),
);
const builder = vi.hoisted(() => {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.is = () => b;
  b.maybeSingle = maybeSingle;
  return b;
});
const authUser = vi.hoisted(() => ({ id: "auth-1" as string | null }));
const cookieValue = vi.hoisted(() => ({ v: undefined as string | undefined }));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from: () => builder }),
}));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser.id ? { id: authUser.id } : null } }) },
  }),
}));
vi.mock("@/lib/auth/dev-preview", () => ({ devPreviewUser: async () => null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookieValue.v ? { value: cookieValue.v } : undefined) }),
}));

import {
  currentUser,
  getImpersonation,
  requireRole,
  requireManager,
  requireAdmin,
  requireSuperAdmin,
} from "@/lib/auth";

const ORG = "org-1";
const user = (id: string, role: Role, extra: Partial<User> = {}): User =>
  ({
    id,
    org_id: ORG,
    auth_user_id: role === "agent" ? null : "auth-1",
    email: `${id}@trypennie.com`,
    name: id,
    role,
    google_sub: null,
    avatar_url: null,
    attributes: {},
    bookable: true,
    deactivated_at: null,
    last_synced_at: null,
    manager_id: null,
    ...extra,
  }) as User;

// Arrange a session for `real` impersonating `target` (target null = the row
// the target-fetch returns, e.g. null when deactivated/vanished).
function arrange(real: User, target: User | null) {
  authUser.id = real.auth_user_id ?? "auth-1";
  cookieValue.v = target ? target.id : "some-target-id";
  dbRows.queue = [real, target];
}

beforeEach(() => {
  vi.clearAllMocks();
  dbRows.queue = [];
  cookieValue.v = undefined;
  authUser.id = "auth-1";
});

describe("currentUser impersonation ceiling (#588)", () => {
  it("blocks admin -> super_admin: acts as the admin, not the super_admin", async () => {
    const admin = user("admin-1", "admin");
    arrange(admin, user("super-1", "super_admin"));
    const acting = await currentUser();
    expect(acting?.id).toBe("admin-1");
    expect(acting?.role).toBe("admin");
  });

  it("blocks admin -> peer admin (equal rank): acts as the real admin", async () => {
    const admin = user("admin-1", "admin");
    arrange(admin, user("admin-2", "admin"));
    expect((await currentUser())?.id).toBe("admin-1");
  });

  it("allows admin -> agent (strictly below): acts as the agent", async () => {
    const admin = user("admin-1", "admin");
    arrange(admin, user("agent-9", "agent"));
    expect((await currentUser())?.id).toBe("agent-9");
  });

  it("allows super_admin -> admin: acts as the admin", async () => {
    const su = user("super-1", "super_admin");
    arrange(su, user("admin-3", "admin"));
    expect((await currentUser())?.id).toBe("admin-3");
  });

  it("falls back to the real user when the target vanished/deactivated", async () => {
    const admin = user("admin-1", "admin");
    arrange(admin, null);
    expect((await currentUser())?.id).toBe("admin-1");
  });
});

// A plain signed-in session (no impersonation cookie): currentUser resolves to
// `who`. This is the denial chokepoint every admin/manager route + action funnels
// through, so its reject branch is the highest-value RBAC test (#606).
function signedInAs(who: User) {
  authUser.id = who.auth_user_id ?? "auth-1";
  cookieValue.v = undefined;
  dbRows.queue = [who];
}

describe("requireRole denial (#606)", () => {
  it("rejects an unauthenticated caller", async () => {
    authUser.id = null;
    cookieValue.v = undefined;
    dbRows.queue = [];
    await expect(requireManager()).rejects.toThrow("Not authorized");
  });

  it("rejects an agent from every manager+ gate", async () => {
    signedInAs(user("agent-9", "agent"));
    await expect(requireRole("manager")).rejects.toThrow("Not authorized");
    signedInAs(user("agent-9", "agent"));
    await expect(requireManager()).rejects.toThrow("Not authorized");
    signedInAs(user("agent-9", "agent"));
    await expect(requireAdmin()).rejects.toThrow("Not authorized");
  });

  it("rejects a manager from admin+ gates but allows the manager gate", async () => {
    signedInAs(user("mgr-1", "manager"));
    await expect(requireAdmin()).rejects.toThrow("Not authorized");
    signedInAs(user("mgr-1", "manager"));
    await expect(requireSuperAdmin()).rejects.toThrow("Not authorized");
    signedInAs(user("mgr-1", "manager"));
    expect((await requireManager()).id).toBe("mgr-1");
  });

  it("rejects an admin from the super_admin gate but allows admin and manager", async () => {
    signedInAs(user("admin-1", "admin"));
    await expect(requireSuperAdmin()).rejects.toThrow("Not authorized");
    signedInAs(user("admin-1", "admin"));
    expect((await requireAdmin()).id).toBe("admin-1");
    signedInAs(user("admin-1", "admin"));
    expect((await requireManager()).id).toBe("admin-1");
  });

  it("allows a caller that holds exactly the required rank", async () => {
    signedInAs(user("mgr-1", "manager"));
    expect((await requireRole("manager")).role).toBe("manager");
  });
});

describe("getImpersonation ceiling (#588)", () => {
  it("returns null when an admin's cookie points at a super_admin", async () => {
    const admin = user("admin-1", "admin");
    arrange(admin, user("super-1", "super_admin"));
    expect(await getImpersonation()).toBeNull();
  });

  it("returns real+target for a valid down-rank impersonation", async () => {
    const admin = user("admin-1", "admin");
    arrange(admin, user("agent-9", "agent"));
    const imp = await getImpersonation();
    expect(imp?.real.id).toBe("admin-1");
    expect(imp?.target.id).toBe("agent-9");
  });
});
