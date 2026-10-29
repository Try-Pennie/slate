import { describe, it, expect, vi, beforeEach } from "vitest";

// #4379: a coordinator's first Microsoft sign in LINKS the row Team access granted, and
// nothing else. Unlike `provisionUser` it never inserts (an uninvited Microsoft account
// gets no row), it writes only to an active coordinator row nobody has signed in to yet,
// and it writes as a compare and swap on `auth_user_id is null`, so two sign ins racing
// for one row cannot both win.
//
// The fake holds real rows and applies each filter a write carries, so a compare and
// swap that matches nothing writes nothing, which is the property the race tests need
// (L52: a fake that ignored the filter would pass a write the database refuses).

type Row = Record<string, unknown> & { id: string };

const db = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  const writes: { patch: Record<string, unknown>; filters: [string, string, unknown][] }[] = [];
  const inserts: unknown[] = [];
  const failures: { read?: string; write?: string } = {};
  /** Runs between a link's read and its write: another sign in getting there first. */
  const between: { fn: (() => void) | null } = { fn: null };

  function matches(row: Record<string, unknown>, filters: [string, string, unknown][]): boolean {
    return filters.every(([kind, col, val]) => (kind === "is" ? (row[col] ?? null) === val : row[col] === val));
  }

  function from(table: string) {
    if (table !== "users") throw new Error(`unexpected table ${table}`);
    const filters: [string, string, unknown][] = [];
    let patch: Record<string, unknown> | null = null;
    const b = {
      select: () => b,
      eq: (col: string, val: unknown) => (filters.push(["eq", col, val]), b),
      is: (col: string, val: unknown) => (filters.push(["is", col, val]), b),
      update: (p: Record<string, unknown>) => ((patch = p), b),
      insert: (p: unknown) => (inserts.push(p), b),
      maybeSingle: async () => {
        if (patch) {
          if (failures.write) return { data: null, error: { message: failures.write } };
          between.fn?.();
          between.fn = null;
          writes.push({ patch, filters: [...filters] });
          const hit = [...rows.values()].find((r) => matches(r, filters));
          if (!hit) return { data: null, error: null };
          Object.assign(hit, patch);
          return { data: { ...hit }, error: null };
        }
        if (failures.read) return { data: null, error: { message: failures.read } };
        const hit = [...rows.values()].find((r) => matches(r, filters));
        return { data: hit ? { ...hit } : null, error: null };
      },
    };
    return b;
  }
  return { rows, writes, inserts, failures, between, from };
});

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: db.from }) }));

import { linkCoordinator } from "@/lib/provision";
import { DeactivatedAccountError, PlaceholderAccountError } from "@/lib/auth/active-session";
import { CoordinatorNotInvitedError, MicrosoftAccountMismatchError } from "@/lib/auth/microsoft-identity";

const EMAIL = "dana.coordinator@partner.example";
const AUTH = "auth-ms-1";
const SUB = "ms-sub-1";

function seed(row: Partial<Row> & { id: string }): void {
  db.rows.set(row.id, {
    org_id: "org-1",
    email: EMAIL,
    role: "coordinator",
    bookable: false,
    deactivated_at: null,
    auth_user_id: null,
    google_sub: null,
    microsoft_sub: null,
    is_placeholder: false,
    ...row,
  });
}

const link = (over: Partial<{ authUserId: string; email: string; microsoftSub: string }> = {}) =>
  linkCoordinator({ authUserId: AUTH, email: EMAIL, microsoftSub: SUB, ...over });

beforeEach(() => {
  db.rows.clear();
  db.writes.length = 0;
  db.inserts.length = 0;
  db.failures.read = undefined;
  db.failures.write = undefined;
  db.between.fn = null;
});

describe("linkCoordinator links an invited coordinator's first Microsoft sign in (#4379)", () => {
  it("links the active, unlinked coordinator row and records the Microsoft account", async () => {
    seed({ id: "coord-1" });
    const user = await link({ email: "  Dana.Coordinator@Partner.EXAMPLE " });
    expect(user).toMatchObject({ id: "coord-1", auth_user_id: AUTH, microsoft_sub: SUB, role: "coordinator" });
    expect(db.rows.get("coord-1")).toMatchObject({ auth_user_id: AUTH, microsoft_sub: SUB });
    // The compare and swap: only a row still unlinked, still a coordinator, still active.
    const [write] = db.writes;
    expect(write?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "id", "coord-1"],
        ["is", "auth_user_id", null],
        ["eq", "role", "coordinator"],
        ["is", "deactivated_at", null],
      ]),
    );
    // Never the role, bookable or anything else Team access set.
    expect(Object.keys(write?.patch ?? {}).sort()).toEqual(["auth_user_id", "microsoft_sub"]);
  });

  it("signs the same person in again without writing anything", async () => {
    seed({ id: "coord-1", auth_user_id: AUTH, microsoft_sub: SUB });
    expect((await link()).id).toBe("coord-1");
    expect(db.writes).toHaveLength(0);
  });

  it("never inserts: an address no row holds is refused as not invited", async () => {
    await expect(link()).rejects.toBeInstanceOf(CoordinatorNotInvitedError);
    expect(db.inserts).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a row that is not a coordinator's, and writes nothing", async () => {
    seed({ id: "staff-1", email: "staff@trypennie.com", role: "manager" });
    await expect(link({ email: "staff@trypennie.com" })).rejects.toBeInstanceOf(CoordinatorNotInvitedError);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses an auth user already linked to a row that is not a coordinator's", async () => {
    seed({ id: "staff-1", email: "staff@trypennie.com", role: "admin", auth_user_id: AUTH });
    await expect(link()).rejects.toBeInstanceOf(CoordinatorNotInvitedError);
    expect(db.writes).toHaveLength(0);
  });

  // The refusals the Google sign in makes, shared rather than copied.
  it("refuses a removed coordinator as deactivated, and never links them", async () => {
    seed({ id: "coord-1", deactivated_at: "2026-10-01T00:00:00Z" });
    await expect(link()).rejects.toBeInstanceOf(DeactivatedAccountError);
    seed({ id: "coord-2", email: "linked@partner.example", auth_user_id: AUTH, microsoft_sub: SUB, deactivated_at: "2026-10-01T00:00:00Z" });
    await expect(link()).rejects.toBeInstanceOf(DeactivatedAccountError);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses the placeholder advisor's row, writing nothing", async () => {
    seed({ id: "marcia", is_placeholder: true });
    await expect(link()).rejects.toBeInstanceOf(PlaceholderAccountError);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a row another sign in already holds", async () => {
    seed({ id: "coord-1", auth_user_id: "auth-someone-else", microsoft_sub: "ms-other" });
    await expect(link()).rejects.toBeInstanceOf(MicrosoftAccountMismatchError);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a different Microsoft account on a row that recorded one, even unlinked", async () => {
    seed({ id: "coord-1", microsoft_sub: "ms-earlier" });
    await expect(link()).rejects.toBeInstanceOf(MicrosoftAccountMismatchError);
    seed({ id: "coord-2", email: "linked@partner.example", auth_user_id: AUTH, microsoft_sub: "ms-earlier" });
    await expect(link({ email: "linked@partner.example" })).rejects.toBeInstanceOf(MicrosoftAccountMismatchError);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a sign in that carries no Microsoft account id at all", async () => {
    seed({ id: "coord-1" });
    await expect(link({ microsoftSub: " " })).rejects.toBeInstanceOf(MicrosoftAccountMismatchError);
    expect(db.writes).toHaveLength(0);
  });

  it("fails loud on an unreadable row rather than reading it as not invited", async () => {
    seed({ id: "coord-1" });
    db.failures.read = "canceling statement";
    await expect(link()).rejects.toThrow(/read failed/);
    expect(db.writes).toHaveLength(0);
  });

  it("fails loud on a refused write, such as a Microsoft account another row already holds", async () => {
    seed({ id: "coord-1" });
    db.failures.write = 'duplicate key value violates unique constraint "users_microsoft_sub_key"';
    await expect(link()).rejects.toThrow(/users_microsoft_sub_key/);
  });
});

describe("linkCoordinator when two sign ins race for one row (#4379)", () => {
  it("lets the loser through when the winner was its own auth user", async () => {
    seed({ id: "coord-1" });
    // A double click: the same auth user's other callback links the row first.
    db.between.fn = () => Object.assign(db.rows.get("coord-1")!, { auth_user_id: AUTH, microsoft_sub: SUB });
    expect((await link()).id).toBe("coord-1");
  });

  it("refuses the loser when somebody else's sign in won", async () => {
    seed({ id: "coord-1" });
    db.between.fn = () => Object.assign(db.rows.get("coord-1")!, { auth_user_id: "auth-other", microsoft_sub: "ms-other" });
    await expect(link()).rejects.toBeInstanceOf(MicrosoftAccountMismatchError);
    expect(db.rows.get("coord-1")).toMatchObject({ auth_user_id: "auth-other", microsoft_sub: "ms-other" });
  });

  it("refuses the loser when the coordinator was removed between the read and the write", async () => {
    seed({ id: "coord-1" });
    db.between.fn = () => Object.assign(db.rows.get("coord-1")!, { deactivated_at: "2026-10-29T12:00:00Z" });
    await expect(link()).rejects.toBeInstanceOf(DeactivatedAccountError);
    expect(db.rows.get("coord-1")).toMatchObject({ auth_user_id: null });
  });
});
