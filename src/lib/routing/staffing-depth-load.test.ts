import { describe, it, expect } from "vitest";
import { loadTierDepths } from "./staffing-depth-load";
import type { supabaseAdmin } from "@/lib/supabase/admin";

// #569: the shared IO loader that backs both /admin/tiers and the monitor cron.
// These tests pin the plumbing (three reads + roster mapping) with a fake db; the
// depth math itself is covered by staffing-depth.test.ts.

type Rows = Record<string, unknown[]>;

/** Minimal chainable stand-in for the supabase client: from().select().eq() all
 *  resolve to { data } for the table, ignoring filters (fixtures are pre-scoped). */
function fakeDb(tables: Rows): ReturnType<typeof supabaseAdmin> {
  const builder = (rows: unknown[]) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      then: (resolve: (v: { data: unknown[] }) => unknown) => Promise.resolve({ data: rows }).then(resolve),
    };
    return b;
  };
  return {
    from: (table: string) => builder(tables[table] ?? []),
  } as unknown as ReturnType<typeof supabaseAdmin>;
}

describe("loadTierDepths", () => {
  it("reads buckets/users/members, maps the roster, and returns per-tier depths", async () => {
    const db = fakeDb({
      buckets: [
        { id: "b520", code: "520", name: "Ultra High | Beyond", criteria: {}, is_test: false, fallback_user_id: null },
        { id: "b120", code: "120", name: "Standard", criteria: {}, is_test: false, fallback_user_id: null },
      ],
      users: [
        // No name -> the loader must fall back to email in the depth roster.
        { id: "u1", name: null, email: "tyler@x.com", attributes: {}, bookable: true, deactivated_at: null },
        { id: "u2", name: "Amanda", email: "a@x.com", attributes: {}, bookable: true, deactivated_at: null },
      ],
      // u1 is the sole active member of 520 (empty criteria matches nobody, so
      // depth comes purely from the manual member); 120 has no members -> depth 0.
      bucket_members: [{ bucket_id: "b520", user_id: "u1" }],
    });

    const depths = await loadTierDepths(db, "org1");
    const byCode = new Map(depths.map((d) => [d.code, d]));

    expect(byCode.get("520")?.depth).toBe(1);
    expect(byCode.get("520")?.flag).toBe("spof");
    // name-less user surfaced by email fallback in the sole-agent label.
    expect(byCode.get("520")?.soleAgentName).toBe("tyler@x.com");
    expect(byCode.get("120")?.depth).toBe(0);
  });

  it("returns an empty list when there are no buckets", async () => {
    const db = fakeDb({ buckets: [], users: [], bucket_members: [] });
    expect(await loadTierDepths(db)).toEqual([]);
  });
});
