import { describe, it, expect, vi, beforeEach } from "vitest";

// #1648: provisioning ran read then insert in three places and swallowed every
// read error, so a transient failure at login created a SECOND organization or a
// DUPLICATE users row.
//
// Two separate things have to hold, and neither one covers the other:
//
//   1. A read that FAILED must refuse the sign in, never fall through to the
//      insert. A swallowed error makes "no org yet" and "could not tell" the same
//      answer, and the insert acts on the wrong one of them.
//   2. A read that CORRECTLY returned nothing is still not protection: two
//      concurrent first logins both pass it. Only a database key can make the
//      second write impossible, so the fake store below enforces the real unique
//      keys (organizations_single_default_idx from migration 0110,
//      users_email_key and users_auth_user_id_key from 0001 and 0006) and refuses
//      a duplicate the way Postgres does, with SQLSTATE 23505.
//
// The fake is only as honest as its claim that those keys exist in the schema,
// which a fake can never prove about itself (L52). scripts/test-provision-unique-keys.ts
// is what pins that: it reads the migrations and fails if any of the three keys
// this file relies on is missing.

type Row = Record<string, unknown>;

interface PgError {
  message: string;
  code: string;
  details: string;
  hint: string;
}

interface UniqueKey {
  name: string;
  cols: string[];
  /** A partial index: only rows satisfying this are covered by the key. */
  only?: (row: Row) => boolean;
}

function uniqueViolation(key: string): PgError {
  return {
    message: `duplicate key value violates unique constraint "${key}"`,
    code: "23505",
    details: "",
    hint: "",
  };
}

function readFailed(): PgError {
  return {
    message: "canceling statement due to statement timeout",
    code: "57014",
    details: "",
    hint: "",
  };
}

class FakeTable {
  rows: Row[] = [];
  conflicts: string[] = [];
  private seq = 0;

  constructor(
    readonly name: string,
    readonly keys: UniqueKey[],
  ) {}

  private violated(candidate: Row, ignoreId: unknown): string | null {
    for (const key of this.keys) {
      if (key.only && !key.only(candidate)) continue;
      const clash = this.rows.some(
        (r) =>
          r.id !== ignoreId &&
          (!key.only || key.only(r)) &&
          key.cols.every((c) => r[c] === candidate[c]),
      );
      if (clash) return key.name;
    }
    return null;
  }

  insert(payload: Row): { data: Row | null; error: PgError | null } {
    this.seq += 1;
    const candidate: Row = { id: `${this.name}-${this.seq}`, ...payload };
    const key = this.violated(candidate, null);
    if (key) {
      this.conflicts.push(key);
      return { data: null, error: uniqueViolation(key) };
    }
    this.rows.push(candidate);
    return { data: { ...candidate }, error: null };
  }

  /**
   * An UPDATE honours every filter it was given, the way Postgres does, and not
   * only the id (#3526). Provisioning records Google's account id with a compare
   * and swap (`.is("google_sub", null)`), and a fake that matched on the id alone
   * would let the second of two racing writers overwrite the first, which is
   * exactly the behaviour the filter exists to refuse (L52).
   */
  update(filters: Row, payload: Row): { data: Row | null; error: PgError | null } {
    const row = this.find(filters)[0];
    if (!row) return { data: null, error: null };
    const id = row.id;
    const candidate: Row = { ...row, ...payload };
    const key = this.violated(candidate, id);
    if (key) {
      this.conflicts.push(key);
      return { data: null, error: uniqueViolation(key) };
    }
    Object.assign(row, payload);
    return { data: { ...row }, error: null };
  }

  find(filters: Row): Row[] {
    // An absent column reads as null, as it would in a real row, so `.is(col, null)`
    // matches a seeded row that never set it.
    return this.rows.filter((r) =>
      Object.entries(filters).every(([c, v]) => (r[c] ?? null) === v),
    );
  }
}

interface Hooks {
  /** Returns an error to fail this read with, or null to let it run. */
  failRead?: (table: string, filters: Row) => PgError | null;
  /**
   * A read to hold at a barrier so two callers are provably at the same point
   * before either writes. The read's RESULT is evaluated before the wait, so both
   * callers see the store as it was: that is the race, and a correct read cannot
   * prevent it.
   */
  hold?: (table: string, filters: Row) => Promise<void> | null;
}

/** Releases every waiter once `target` of them have arrived. */
function barrier(target: number) {
  let arrived = 0;
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async function wait(): Promise<void> {
    arrived += 1;
    if (arrived >= target) open();
    await gate;
  };
}

function makeStore(hooks: Hooks = {}) {
  const organizations = new FakeTable("org", [
    // Migration 0110: at most one organization may be the default.
    { name: "organizations_single_default_idx", cols: ["is_default"], only: (r) => r.is_default === true },
  ]);
  const users = new FakeTable("user", [
    { name: "users_email_key", cols: ["email"] },
    {
      name: "users_auth_user_id_key",
      cols: ["auth_user_id"],
      only: (r) => r.auth_user_id !== null && r.auth_user_id !== undefined,
    },
  ]);
  const tables: Record<string, FakeTable> = { organizations, users };

  function from(tableName: string) {
    const table = tables[tableName];
    if (!table) throw new Error(`fake store has no table ${tableName}`);
    const filters: Row = {};
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};

    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      is: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      insert: (p: Row) => {
        mode = "insert";
        payload = p;
        return builder;
      },
      update: (p: Row) => {
        mode = "update";
        payload = p;
        return builder;
      },
      maybeSingle: async (): Promise<{ data: Row | null; error: PgError | null }> => {
        if (mode === "insert") return table.insert(payload);
        if (mode === "update") return table.update(filters, payload);
        const failure = hooks.failRead?.(tableName, filters) ?? null;
        if (failure) return { data: null, error: failure };
        const matches = table.find(filters);
        const result = { data: matches[0] ? { ...matches[0] } : null, error: null };
        const wait = hooks.hold?.(tableName, filters) ?? null;
        if (wait) await wait;
        return result;
      },
      single: async () => builder.maybeSingle(),
    };
    return builder;
  }

  return { organizations, users, client: { from } };
}

const store = vi.hoisted(() => ({
  current: null as { from: (t: string) => unknown } | null,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => store.current,
}));

import { provisionUser } from "./provision";
import { GoogleAccountMismatchError } from "@/lib/auth/google-identity";

const input = {
  authUserId: "auth-1",
  email: "agent@trypennie.com",
  name: "An Agent",
  googleSub: "sub-1",
  avatarUrl: null,
};

function seedDefaultOrg(s: ReturnType<typeof makeStore>) {
  s.organizations.rows.push({
    id: "org-1",
    name: "Pennie",
    is_default: true,
    created_at: "2026-06-03T00:00:00Z",
  });
}

beforeEach(() => {
  store.current = null;
});

describe("provisionUser refuses on an unreadable read (#1648)", () => {
  it("refuses when the default organization read fails, and creates NO organization", async () => {
    const s = makeStore({
      failRead: (table) => (table === "organizations" ? readFailed() : null),
    });
    store.current = s.client;

    await expect(provisionUser(input)).rejects.toThrow();

    expect(s.organizations.rows).toHaveLength(0);
    expect(s.users.rows).toHaveLength(0);
  });

  it("refuses when the users read by auth_user_id fails, and creates NO users row", async () => {
    const s = makeStore({
      failRead: (table, filters) =>
        table === "users" && "auth_user_id" in filters ? readFailed() : null,
    });
    seedDefaultOrg(s);
    store.current = s.client;

    await expect(provisionUser(input)).rejects.toThrow();

    expect(s.users.rows).toHaveLength(0);
  });

  it("refuses when the users read by email fails, and creates NO users row", async () => {
    const s = makeStore({
      failRead: (table, filters) =>
        table === "users" && "email" in filters ? readFailed() : null,
    });
    seedDefaultOrg(s);
    store.current = s.client;

    await expect(provisionUser(input)).rejects.toThrow();

    expect(s.users.rows).toHaveLength(0);
  });

  it("does not sign the person in as a new identity when a read fails for someone who already exists", async () => {
    // The worst shape of the defect: the row is there, the read cannot see it, and
    // the fall-through mints a SECOND identity for the same person.
    const s = makeStore({
      failRead: (table, filters) =>
        table === "users" && "auth_user_id" in filters ? readFailed() : null,
    });
    seedDefaultOrg(s);
    s.users.rows.push({
      id: "user-existing",
      org_id: "org-1",
      email: input.email,
      auth_user_id: input.authUserId,
      role: "admin",
      bookable: true,
    });
    store.current = s.client;

    await expect(provisionUser(input)).rejects.toThrow();

    expect(s.users.rows).toHaveLength(1);
    expect(s.users.rows[0].id).toBe("user-existing");
  });
});

describe("provisionUser under two concurrent first logins (#1648)", () => {
  it("creates exactly one organization and one users row", async () => {
    // Both callers are held at the read that decides whether to insert, so both
    // legitimately see nothing. Only the unique keys can stop the second write.
    const orgGate = barrier(2);
    const emailGate = barrier(2);
    const s = makeStore({
      hold: (table, filters) => {
        if (table === "organizations" && Object.keys(filters).length > 0) return orgGate();
        if (table === "users" && "email" in filters) return emailGate();
        return null;
      },
    });
    store.current = s.client;

    const [a, b] = await Promise.all([provisionUser(input), provisionUser(input)]);

    expect(s.organizations.rows).toHaveLength(1);
    expect(s.users.rows).toHaveLength(1);
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(s.users.rows[0].id);
    expect(a.org_id).toBe(s.organizations.rows[0].id);
    expect(b.org_id).toBe(s.organizations.rows[0].id);
  });

  it("reaches both unique keys rather than being saved by a lucky ordering", async () => {
    // Without this the test above could pass on a serialization where neither
    // insert ever collided, which proves nothing about the constraint.
    const orgGate = barrier(2);
    const emailGate = barrier(2);
    const s = makeStore({
      hold: (table, filters) => {
        if (table === "organizations" && Object.keys(filters).length > 0) return orgGate();
        if (table === "users" && "email" in filters) return emailGate();
        return null;
      },
    });
    store.current = s.client;

    await Promise.all([provisionUser(input), provisionUser(input)]);

    expect(s.organizations.conflicts).toEqual(["organizations_single_default_idx"]);
    expect(s.users.conflicts).toHaveLength(1);
  });
});

// #3526: Slate used to key staff identity on the email address alone. Google's
// `sub` is the account's permanent id and is never reused, while an address can
// be handed to somebody new, so a reused address would have signed the new person
// in as the old row: its role, its bookings, its calendar. Once a row has a
// stored `sub`, a sign in carrying a DIFFERENT one is a different person and is
// refused without any write. A row with none keeps the old behaviour and records
// the `sub` it is first signed in with.
describe("provisionUser and Google's permanent account id (#3526)", () => {
  function seededStore(row: Row, hooks: Hooks = {}) {
    const s = makeStore(hooks);
    seedDefaultOrg(s);
    s.users.rows.push({ org_id: "org-1", role: "admin", bookable: true, deactivated_at: null, ...row });
    store.current = s.client;
    return s;
  }

  it("links a sign in whose account id matches the one stored on the row it found by email", async () => {
    const s = seededStore({ id: "user-9", email: input.email, auth_user_id: null, google_sub: "sub-1" });

    const user = await provisionUser(input);

    expect(user.id).toBe("user-9");
    expect(s.users.rows[0].auth_user_id).toBe("auth-1");
    expect(s.users.rows[0].google_sub).toBe("sub-1");
  });

  it("signs in an already linked row whose account id matches", async () => {
    seededStore({ id: "user-9", email: input.email, auth_user_id: "auth-1", google_sub: "sub-1" });
    expect((await provisionUser(input)).id).toBe("user-9");
  });

  it("refuses a different Google account on a row found by email, and writes nothing", async () => {
    const s = seededStore({ id: "user-9", email: input.email, auth_user_id: "auth-old", google_sub: "sub-old" });

    const refused = provisionUser(input);
    await expect(refused).rejects.toBeInstanceOf(GoogleAccountMismatchError);
    await expect(refused).rejects.toMatchObject({
      userId: "user-9",
      email: input.email,
      reason: "different-account",
    });

    // The old row is untouched: not relinked to the new auth user, not given the
    // new account id, and no second row was created for the newcomer either.
    expect(s.users.rows).toHaveLength(1);
    expect(s.users.rows[0].auth_user_id).toBe("auth-old");
    expect(s.users.rows[0].google_sub).toBe("sub-old");
  });

  // Supabase links a new Google identity to an existing auth user with the same
  // verified address, so the newcomer can arrive already LINKED by auth_user_id.
  // The guard has to hold on that branch too, or it guards only half the path.
  it("refuses a different Google account on a row already linked by auth_user_id", async () => {
    const s = seededStore({
      id: "user-9",
      email: input.email,
      auth_user_id: "auth-1",
      google_sub: "sub-old",
      avatar_url: "old.png",
    });

    await expect(provisionUser({ ...input, avatarUrl: "new.png" })).rejects.toBeInstanceOf(
      GoogleAccountMismatchError,
    );
    expect(s.users.rows[0].google_sub).toBe("sub-old");
    expect(s.users.rows[0].avatar_url).toBe("old.png");
  });

  it("refuses a sign in that carries no account id at all once the row has one", async () => {
    const s = seededStore({ id: "user-9", email: input.email, auth_user_id: null, google_sub: "sub-old" });

    await expect(provisionUser({ ...input, googleSub: null })).rejects.toMatchObject({
      reason: "no-account-id",
    });
    expect(s.users.rows[0].auth_user_id).toBeNull();
  });

  it("records the account id on a row found by email that has none yet", async () => {
    const s = seededStore({ id: "user-9", email: input.email, auth_user_id: null, google_sub: null });

    expect((await provisionUser(input)).id).toBe("user-9");
    expect(s.users.rows[0].google_sub).toBe("sub-1");
  });

  // A row linked before the account id was compared (or one an admin unlinked for a
  // rehire) has to start being guarded on its next sign in, or it never is.
  it("records the account id on an already linked row that has none yet", async () => {
    const s = seededStore({ id: "user-9", email: input.email, auth_user_id: "auth-1", google_sub: null });

    expect((await provisionUser(input)).id).toBe("user-9");
    expect(s.users.rows[0].google_sub).toBe("sub-1");
  });

  it("lets only the first of two different accounts racing for one unrecorded row have it", async () => {
    // Both are held at the read by email, so both see a row with no account id.
    // The record is a compare and swap, so the second write matches nothing and
    // its second pass reads the account id the first one stored.
    const gate = barrier(2);
    let held = 0;
    const s = seededStore(
      { id: "user-9", email: input.email, auth_user_id: null, google_sub: null },
      {
        hold: (table, filters) => {
          if (table === "users" && "email" in filters && held < 2) {
            held += 1;
            return gate();
          }
          return null;
        },
      },
    );

    const results = await Promise.allSettled([
      provisionUser({ ...input, authUserId: "auth-a", googleSub: "sub-a" }),
      provisionUser({ ...input, authUserId: "auth-b", googleSub: "sub-b" }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(GoogleAccountMismatchError);
    expect(s.users.rows).toHaveLength(1);
    const winner = s.users.rows[0];
    const pair = `${String(winner.auth_user_id)}/${String(winner.google_sub)}`;
    expect(["auth-a/sub-a", "auth-b/sub-b"]).toContain(pair);
  });
});
