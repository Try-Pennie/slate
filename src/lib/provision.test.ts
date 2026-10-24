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
  /** Every (column, value) a lookup filtered on, so a test can assert WHAT was
   *  asked for and not merely which column was consulted. */
  const eqFilters: { col: string; value: unknown }[] = [];
  const updatePayloads: Record<string, unknown>[] = [];

  function builder() {
    const state = { insert: null as Record<string, unknown> | null };
    const eqCols: string[] = [];
    const b: Record<string, unknown> = {};
    const chain = () => b;
    // Writes come back through whichever terminal the caller used. #1648 moved the
    // inserts and updates off `.single()` (whose zero-row error masks a lost race
    // as a generic failure) onto `.maybeSingle()`, so both terminals resolve here.
    const resolveWrite = async () => {
      if (state.insert) {
        return { data: { id: "new-user", ...state.insert }, error: null };
      }
      if (updatePayloads.length) {
        return { data: { id: "existing-user", ...updatePayloads.at(-1) }, error: null };
      }
      return { data: null, error: null };
    };
    Object.assign(b, {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (col: string, value?: unknown) => {
        eqCols.push(col);
        eqFilters.push({ col, value });
        // The legacy code counts users with role='admin'; flag it so the test
        // can prove the fixed code no longer consults role at all.
        if (col === "role") roleCounted = true;
        return b;
      },
      // #3526: the account id is recorded with a compare and swap on
      // `google_sub is null`. A filter only, so it narrows nothing here.
      is: () => b,
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
        if (state.insert || updatePayloads.length) return resolveWrite();
        // organizations lookup returns the existing org; the users lookups are
        // told apart by which column they filtered on, so a test can drive the
        // already-linked branch and the found-by-email branch separately.
        if (eqCols.includes("auth_user_id")) {
          return { data: opts.linked ?? null, error: null };
        }
        if (eqCols.includes("email")) {
          // The stored row answers ONLY to its own exact address. Without this the
          // fake would hand the row back whatever case was queried, and a test for
          // case-insensitive matching would pass on a lookup that never normalised
          // anything (L52: a fake agrees with your assumption by construction).
          const asked = eqFilters.find((f) => f.col === "email")?.value;
          const stored = (opts.existingByEmail as { email?: string } | undefined)?.email;
          if (opts.existingByEmail && (stored === undefined || stored === asked)) {
            return { data: opts.existingByEmail, error: null };
          }
          return { data: null, error: null };
        }
        return { data: null, error: null };
      },
      single: resolveWrite,
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
    getEqFilters: () => eqFilters,
    roleWasCounted: () => roleCounted,
  };
}

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof makeDb> | null }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => db.current!.handler,
}));

import { provisionUser } from "./provision";
import { DeactivatedAccountError } from "@/lib/auth/active-session";

const input = {
  authUserId: "auth-1",
  email: "newperson@trypennie.com",
  name: "New Person",
  googleSubs: ["sub-1"],
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

// #1663: `users.email` is unique but CASE SENSITIVE, and Google addresses are
// effectively case insensitive, so one person can arrive under two spellings. A
// row synced as agent@trypennie.com and a login arriving as Agent@trypennie.com
// would miss the by-email read AND pass users_email_key, leaving one person with
// two identities that never converge: the roster, the bookable pool, the manager
// link and every per agent count can each resolve to a different half.
describe("provisionUser matches an address case insensitively (#1663)", () => {
  beforeEach(() => {
    db.current = null;
  });

  it("links the login to the stored row when the cases differ", async () => {
    db.current = makeDb({
      org: { id: "org-1" },
      adminExists: true,
      existingByEmail: {
        id: "synced-1",
        email: "newperson@trypennie.com",
        name: "New Person",
        bookable: true,
      },
    });
    const user = await provisionUser({ ...input, email: "NewPerson@TryPennie.com" });
    // The linked row, not a second one: an insert here is the duplicate identity.
    expect(user.id).toBe("existing-user");
    expect(db.current.getInsertedPayload()).toBeNull();
  });

  it("asks for the address in its normalised form, so the read can match", async () => {
    db.current = makeDb({ org: { id: "org-1" }, adminExists: true });
    await provisionUser({ ...input, email: "  NewPerson@TryPennie.com " });
    const asked = db.current
      .getEqFilters()
      .filter((f) => f.col === "email")
      .map((f) => f.value);
    expect(asked).toContain("newperson@trypennie.com");
    expect(asked).not.toContain("  NewPerson@TryPennie.com ");
  });

  it("stores the normalised address, so the row login matches on is the row that exists", async () => {
    db.current = makeDb({ org: { id: "org-1" }, adminExists: true });
    await provisionUser({ ...input, email: "NewPerson@TryPennie.com" });
    expect(db.current.getInsertedPayload()?.email).toBe("newperson@trypennie.com");
  });

  // The control beside it: an address that is ALREADY lower case still resolves
  // the same way, so the three assertions above cannot be passing because
  // provisioning stopped matching or stopped inserting altogether.
  it("still links an address that needed no normalising", async () => {
    db.current = makeDb({
      org: { id: "org-1" },
      adminExists: true,
      existingByEmail: { id: "synced-1", email: "newperson@trypennie.com", name: "New Person" },
    });
    const user = await provisionUser(input);
    expect(user.id).toBe("existing-user");
    expect(db.current.getInsertedPayload()).toBeNull();
  });
});

// #2378: a fresh sign in by somebody who has LEFT used to succeed. The already
// linked branch returned the row unconditionally, and the by-email branch linked
// a departed row to whatever Google account arrived, so a Workspace account that
// had not yet been suspended minted a live Slate session for a person the roster
// no longer carries.
//
// Provisioning REFUSES rather than degrading, which is the same choice #1648 made
// for an unreadable read: the callback turns the refusal into a sign in error and
// clears the half made session, rather than landing them on an internal page.
describe("provisionUser refuses a deactivated account (#2378)", () => {
  const LEFT = "2026-09-01T00:00:00.000Z";

  beforeEach(() => {
    db.current = null;
  });

  it("refuses a sign in for a row already linked by auth_user_id", async () => {
    db.current = makeDb({
      org: { id: "org-1" },
      adminExists: true,
      linked: { id: "linked-1", email: input.email, deactivated_at: LEFT },
    });

    await expect(provisionUser(input)).rejects.toBeInstanceOf(DeactivatedAccountError);
    // And it refuses without writing: a refused sign in must not relink or touch
    // the departed row on its way out.
    expect(db.current.getUpdates()).toHaveLength(0);
    expect(db.current.getInsertedPayload()).toBeNull();
  });

  it("refuses a sign in for a departed row matched by email, and never links it", async () => {
    db.current = makeDb({
      org: { id: "org-1" },
      adminExists: true,
      existingByEmail: { id: "synced-1", email: input.email, deactivated_at: LEFT },
    });

    await expect(provisionUser(input)).rejects.toBeInstanceOf(DeactivatedAccountError);
    // The dangerous write is the one that sets auth_user_id on a departed row.
    for (const payload of db.current.getUpdates()) {
      expect("auth_user_id" in payload).toBe(false);
    }
    expect(db.current.getInsertedPayload()).toBeNull();
  });

  // The positive control in the same fixture (L159): the identical rows with
  // `deactivated_at` null sign in exactly as before, so the two refusals above
  // cannot be provisioning having stopped working altogether.
  it("still signs in the same rows while they are active", async () => {
    db.current = makeDb({
      org: { id: "org-1" },
      adminExists: true,
      // A linked row carries the account id it signed in with (#3526), so this
      // sign in writes nothing and the row read is the row returned.
      linked: { id: "linked-1", email: input.email, deactivated_at: null, google_sub: "sub-1" },
    });
    expect((await provisionUser(input)).id).toBe("linked-1");

    db.current = makeDb({
      org: { id: "org-1" },
      adminExists: true,
      existingByEmail: { id: "synced-1", email: input.email, deactivated_at: null },
    });
    expect((await provisionUser(input)).id).toBe("existing-user");
  });
});
