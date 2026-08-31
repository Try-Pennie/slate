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

  update(id: unknown, payload: Row): { data: Row | null; error: PgError | null } {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return { data: null, error: null };
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
    return this.rows.filter((r) =>
      Object.entries(filters).every(([c, v]) => r[c] === v),
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
        if (mode === "update") return table.update(filters.id, payload);
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
