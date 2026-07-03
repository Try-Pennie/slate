import { describe, it, expect, vi, beforeEach } from "vitest";

// First-login provisioning must never auto-grant admin from a data condition
// (#599). The old bootstrap made the first user an admin whenever zero admins
// existed — a privilege-escalation-by-data-state. New users are always 'agent';
// admins are seeded deliberately (direct DB write), never by logging in first.
//
// These tests drive provisionUser through a mocked secret-key client, exercising
// the brand-new-user branch under both an empty-admin org and a populated one.

interface FakeOpts {
  org: { id: string };
  /** Rows returned by the users lookups (auth_user_id, then email). */
  adminExists: boolean;
}

function makeDb(opts: FakeOpts) {
  let insertPayload: Record<string, unknown> | null = null;
  let roleCounted = false;

  function builder() {
    const state = { insert: null as Record<string, unknown> | null };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (col: string) => {
        // The legacy code counts users with role='admin'; flag it so the test
        // can prove the fixed code no longer consults role at all.
        if (col === "role") roleCounted = true;
        return b;
      },
      in: (col: string) => {
        if (col === "role") roleCounted = true;
        return b;
      },
      insert: (payload: Record<string, unknown>) => {
        state.insert = payload;
        insertPayload = payload;
        return b;
      },
      update: () => b,
      maybeSingle: async () => {
        // organizations lookup returns the existing org; users lookups (linked
        // by auth_user_id, then by email) return nothing → brand-new branch.
        return { data: null, error: null };
      },
      single: async () => {
        if (state.insert) {
          return { data: { id: "new-user", ...state.insert }, error: null };
        }
        return { data: null, error: null };
      },
      // The admin-count query is awaited directly (no terminal). Resolve it as a
      // count result so the legacy path can compute a role.
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ count: opts.adminExists ? 3 : 0, error: null }).then(
          resolve,
        ),
    });
    return chain();
  }

  const handler = {
    from: (table: string) => {
      if (table === "organizations") {
        // Return the existing org so ensureDefaultOrg never inserts.
        const b = builder() as Record<string, unknown>;
        b.maybeSingle = async () => ({ data: opts.org, error: null });
        return b;
      }
      return builder();
    },
  };

  return {
    handler,
    getInsertedRole: () => insertPayload?.role as string | undefined,
    roleWasCounted: () => roleCounted,
  };
}

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof makeDb> | null }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => db.current!.handler,
}));

import { provisionUser } from "./provision";

const input = {
  authUserId: "auth-1",
  email: "newperson@trypennie.com",
  name: "New Person",
  googleSub: "sub-1",
  avatarUrl: null,
};

describe("provisionUser role assignment (#599)", () => {
  beforeEach(() => {
    db.current = null;
  });

  it("provisions a brand-new user as 'agent' even when zero admins exist", async () => {
    db.current = makeDb({ org: { id: "org-1" }, adminExists: false });
    const user = await provisionUser(input);
    expect(user.role).toBe("agent");
    expect(db.current.getInsertedRole()).toBe("agent");
  });

  it("provisions a brand-new user as 'agent' when admins already exist", async () => {
    db.current = makeDb({ org: { id: "org-1" }, adminExists: true });
    const user = await provisionUser(input);
    expect(user.role).toBe("agent");
  });

  it("never consults the role column to decide a new user's role", async () => {
    db.current = makeDb({ org: { id: "org-1" }, adminExists: false });
    await provisionUser(input);
    expect(db.current.roleWasCounted()).toBe(false);
  });
});
