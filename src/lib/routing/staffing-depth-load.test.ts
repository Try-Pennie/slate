import { describe, it, expect } from "vitest";
import { loadTierDepths } from "./staffing-depth-load";
import type { supabaseAdmin } from "@/lib/supabase/admin";

// #569: the shared IO loader that backs both /admin/tiers and the monitor cron.
// These tests pin the plumbing (three reads + roster mapping) with a fake db; the
// depth math itself is covered by staffing-depth.test.ts.

type Rows = Record<string, unknown[]>;

/** Every table's primary key, which a paged read cuts its pages on: a fixture row
 *  that names none is given one by its position. */
const keyed = (table: string, rows: unknown[]) =>
  rows.map((r, i) => ({ id: `${table}-${i}`, ...(r as Record<string, unknown>) }));

/** Minimal chainable stand-in for the supabase client: from().select().eq() all
 *  resolve to { data } for the table, ignoring filters (fixtures are pre-scoped). */
function fakeDb(tables: Rows): ReturnType<typeof supabaseAdmin> {
  const builder = (rows: unknown[]) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      lte: () => b,
      gt: () => b,
      in: () => b,
      order: () => b,
      range: () => b,
      then: (resolve: (v: { data: unknown[] }) => unknown) => Promise.resolve({ data: rows }).then(resolve),
    };
    return b;
  };
  return {
    from: (table: string) => builder(keyed(table, tables[table] ?? [])),
  } as unknown as ReturnType<typeof supabaseAdmin>;
}

/**
 * The same fake, but ONE named table answers with a query error. #1629: a read
 * that fails has to be told apart from a table that is genuinely empty, and only
 * a per-table fixture can do that (a fake where everything fails is satisfied by
 * any read throwing, including one that was already covered).
 */
function fakeDbFailing(tables: Rows, failingTable: string): ReturnType<typeof supabaseAdmin> {
  const builder = (result: unknown) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      lte: () => b,
      gt: () => b,
      in: () => b,
      order: () => b,
      range: () => b,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return b;
  };
  return {
    from: (table: string) =>
      builder(
        table === failingTable
          ? { data: null, error: { message: `${table} read exploded` } }
          : { data: keyed(table, tables[table] ?? []), error: null },
      ),
  } as unknown as ReturnType<typeof supabaseAdmin>;
}

// 11:00 ET on 2026-07-09. The all-day fixtures below are anchored to ET local
// midnight (04:00Z in July), matching what the #616 sync writes.
const NOW = new Date("2026-07-09T15:00:00Z");
const ET_ALL_DAY = { starts_at: "2026-07-09T04:00:00.000Z", ends_at: "2026-07-10T04:00:00.000Z" };

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
    const db = fakeDb({ buckets: [], users: [], bucket_members: [], ooo_requests: [] });
    expect(await loadTierDepths(db)).toEqual([]);
  });

  it("#738: discounts agents on approved time off from effective depth", async () => {
    const db = fakeDb({
      buckets: [{ id: "b1", code: "311", name: "High", criteria: {}, is_test: false, fallback_user_id: null }],
      users: [
        { id: "u1", name: "A", email: "a@x", attributes: {}, bookable: true, deactivated_at: null },
        { id: "u2", name: "B", email: "b@x", attributes: {}, bookable: true, deactivated_at: null },
      ],
      bucket_members: [
        { bucket_id: "b1", user_id: "u1" },
        { bucket_id: "b1", user_id: "u2" },
      ],
      // The loader's query already restricts to approved + currently-active rows;
      // the fixture returns exactly what that query would (u1 is out now).
      ooo_requests: [{ user_id: "u1" }],
    });
    const [row] = await loadTierDepths(db, "org1", new Date("2026-07-09T15:00:00Z"));
    expect(row.depth).toBe(2);
    expect(row.effectiveDepth).toBe(1);
    expect(row.effectiveFlag).toBe("spof");
    expect(row.outCount).toBe(1);
  });

  // #744: an agent who blocks their own Google calendar all day (no Slate OOO
  // request) is really out, and must not inflate a tier's effective depth.
  const twoAgentTier = () => ({
    buckets: [{ id: "b1", code: "311", name: "High", criteria: {}, is_test: false, fallback_user_id: null }],
    users: [
      { id: "u1", name: "A", email: "a@x", attributes: {}, bookable: true, deactivated_at: null },
      { id: "u2", name: "B", email: "b@x", attributes: {}, bookable: true, deactivated_at: null },
    ],
    bucket_members: [
      { bucket_id: "b1", user_id: "u1" },
      { bucket_id: "b1", user_id: "u2" },
    ],
    availability_schedules: [
      { user_id: "u1", timezone: "America/New_York" },
      { user_id: "u2", timezone: "America/New_York" },
    ],
  });

  it("#744: discounts an agent whose Google calendar is blocked all day", async () => {
    const db = fakeDb({
      ...twoAgentTier(),
      ooo_requests: [],
      busy_blocks: [{ user_id: "u1", ...ET_ALL_DAY }],
    });
    const [row] = await loadTierDepths(db, "org1", NOW);
    expect(row.depth).toBe(2);
    expect(row.effectiveDepth).toBe(1);
    expect(row.outCount).toBe(1);
    expect(row.agents.find((a) => a.id === "u1")?.out).toBe(true);
  });

  it("#744: a timed meeting in progress does not count as out", async () => {
    const db = fakeDb({
      ...twoAgentTier(),
      ooo_requests: [],
      // Covers `now`, but it is an ordinary meeting, not an all-day block.
      busy_blocks: [
        { user_id: "u1", starts_at: "2026-07-09T14:30:00.000Z", ends_at: "2026-07-09T15:30:00.000Z" },
      ],
    });
    const [row] = await loadTierDepths(db, "org1", NOW);
    expect(row.effectiveDepth).toBe(2);
    expect(row.outCount).toBe(0);
  });

  it("#744: an agent with BOTH an approved OOO and an all-day block is counted out once", async () => {
    const db = fakeDb({
      ...twoAgentTier(),
      ooo_requests: [{ user_id: "u1" }],
      busy_blocks: [{ user_id: "u1", ...ET_ALL_DAY }],
    });
    const [row] = await loadTierDepths(db, "org1", NOW);
    expect(row.effectiveDepth).toBe(1);
    expect(row.outCount).toBe(1);
  });

  it("#744: reads the all-day block in the agent's own timezone, not the server's", async () => {
    const db = fakeDb({
      ...twoAgentTier(),
      ooo_requests: [],
      // u2 is on Pacific time, so an ET-anchored span is NOT their local day.
      availability_schedules: [
        { user_id: "u1", timezone: "America/New_York" },
        { user_id: "u2", timezone: "America/Los_Angeles" },
      ],
      busy_blocks: [
        { user_id: "u1", ...ET_ALL_DAY },
        { user_id: "u2", ...ET_ALL_DAY },
      ],
    });
    const [row] = await loadTierDepths(db, "org1", NOW);
    expect(row.outCount).toBe(1);
    expect(row.agents.find((a) => a.id === "u2")?.out).toBe(false);
  });

  it("#744: falls back to ET when the agent has no availability schedule", async () => {
    const tier = twoAgentTier();
    const db = fakeDb({
      ...tier,
      availability_schedules: [],
      ooo_requests: [],
      busy_blocks: [{ user_id: "u1", ...ET_ALL_DAY }],
    });
    const [row] = await loadTierDepths(db, "org1", NOW);
    expect(row.outCount).toBe(1);
  });

  it("#744: surfaces a failed busy-block read instead of silently overstating coverage", async () => {
    const failing = {
      from: () => {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          lte: () => b,
          gt: () => b,
          in: () => b,
          order: () => b,
          range: () => b,
          then: (resolve: (v: { data: null; error: { message: string } }) => unknown) =>
            Promise.resolve({ data: null, error: { message: "read timeout" } }).then(resolve),
        };
        return b;
      },
    } as unknown as ReturnType<typeof supabaseAdmin>;
    await expect(loadTierDepths(failing, "org1", NOW)).rejects.toThrow(/read timeout/);
  });
});

describe("loadTierDepths on an unreadable table (#1629)", () => {
  // The populated roster every case below starts from: whatever it reports, an
  // empty depth list is the WRONG answer, because the fixture has real tiers.
  const roster: Rows = {
    buckets: [
      { id: "b1", code: "311", name: "High", criteria: {}, is_test: false, fallback_user_id: null },
    ],
    users: [
      { id: "u1", name: "A", email: "a@x.com", attributes: {}, bookable: true, deactivated_at: null },
      { id: "u2", name: "B", email: "b@x.com", attributes: {}, bookable: true, deactivated_at: null },
    ],
    bucket_members: [
      { bucket_id: "b1", user_id: "u1" },
      { bucket_id: "b1", user_id: "u2" },
    ],
    ooo_requests: [],
    busy_blocks: [],
    availability_schedules: [],
  };

  it("proves the control: the same roster reads fine when nothing fails", async () => {
    const depths = await loadTierDepths(fakeDbFailing(roster, "nothing"), "org1", NOW);
    expect(depths.map((d) => d.code)).toEqual(["311"]);
    expect(depths[0].effectiveDepth).toBe(2);
  });

  // Each read separately, and each error names its own table, so a caught failure
  // says which read could not be made rather than one answering for another (L11).
  for (const [table, context] of [
    ["buckets", "staffing depth buckets"],
    ["users", "staffing depth users"],
    ["bucket_members", "staffing depth bucket_members"],
    ["ooo_requests", "staffing depth ooo_requests"],
  ] as const) {
    it(`throws (never returns []) when the ${table} read fails, naming that read`, async () => {
      const db = fakeDbFailing(roster, table);
      await expect(loadTierDepths(db, "org1", NOW)).rejects.toThrow(
        new RegExp(`${context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${table} read exploded`),
      );
    });
  }
});
