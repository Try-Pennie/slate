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
  /** An existing row found by auth_user_id, i.e. an already-linked user. */
  linked?: Record<string, unknown>;
  /** An existing row found by email, i.e. a synced agent logging in for the first
   *  time. Used to prove the login path decides nothing about bookable (#1266). */
  existingByEmail?: Record<string, unknown>;
}

function makeDb(opts: FakeOpts) {
  let insertPayload: Record<string, unknown> | null = null;
  let roleCounted = false;
  const updatePayloads: Record<string, unknown>[] = [];

  function builder() {
    const state = { insert: null as Record<string, unknown> | null };
    const eqCols: string[] = [];
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (col: string) => {
        eqCols.push(col);
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
      update: (payload: Record<string, unknown>) => {
        updatePayloads.push(payload);
        return b;
      },
      maybeSingle: async () => {
        // organizations lookup returns the existing org; the users lookups are
        // told apart by which column they filtered on, so a test can drive the
        // already-linked branch and the found-by-email branch separately.
        if (eqCols.includes("auth_user_id")) {
          return { data: opts.linked ?? null, error: null };
        }
        if (eqCols.includes("email")) {
          return { data: opts.existingByEmail ?? null, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => {
        if (state.insert) {
          return { data: { id: "new-user", ...state.insert }, error: null };
        }
        if (updatePayloads.length) {
          return { data: { id: "existing-user", ...updatePayloads.at(-1) }, error: null };
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
    getInsertedPayload: () => insertPayload,
    getUpdates: () => updatePayloads,
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

// Adding an account must never put someone in the round-robin pool by itself
// (#1266). An agent live before anyone approved them may have no working hours
// set, no calendar connected, or not be meant to take bookings at all, and the
// booker will still offer their time to real consumer leads. The failure mode of
// the mistake is "takes real bookings", not "takes none".
//
// Asserted on the LOGIN path specifically: a test that only proved the Salesforce
// sync inserts bookable=false would pass today, because the sync was never the
// path that leaked.
describe("provisionUser and the bookable gate (#1266)", () => {
  beforeEach(() => {
    db.current = null;
  });

  it("creates a brand-new agent who is NOT bookable", async () => {
    db.current = makeDb({ org: { id: "org-1" }, adminExists: true });
    await provisionUser(input);
    // Named at the insert rather than left to the column default: the intent has
    // to be readable here, and the default is the second line of defence.
    expect(db.current.getInsertedPayload()?.bookable).toBe(false);
  });

  it("decides nothing about bookable for a synced agent logging in for the first time", async () => {
    // The Salesforce sync creates the row unbookable and an admin may since have
    // turned it on. Logging in must not move it in EITHER direction.
    db.current = makeDb({
      org: { id: "org-1" },
      adminExists: true,
      existingByEmail: { id: "synced-1", email: input.email, name: "Synced Name", bookable: true },
    });

    await provisionUser(input);

    expect(db.current.getInsertedPayload()).toBeNull();
    const updates = db.current.getUpdates();
    expect(updates.length).toBeGreaterThan(0);
    for (const payload of updates) expect("bookable" in payload).toBe(false);
  });

  it("decides nothing about bookable when refreshing an already linked user", async () => {
    db.current = makeDb({
      org: { id: "org-1" },
      adminExists: true,
      linked: { id: "linked-1", email: input.email, avatar_url: "old.png", bookable: false },
    });

    await provisionUser({ ...input, avatarUrl: "new.png" });

    for (const payload of db.current.getUpdates()) {
      expect("bookable" in payload).toBe(false);
    }
  });
});
