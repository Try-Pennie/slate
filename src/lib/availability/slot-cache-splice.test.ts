import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBucketSlotsTable, type SlotRow } from "../../../scripts/lib/fake-bucket-slots-table";

// #3324: the REAL wiring of the booked window splice, against a database fake that
// counts every statement. The rule and the race are pinned offline
// (scripts/test-booked-splice.ts, scripts/test-booked-splice-race.ts); these pin what
// only the real module can show, and above all the call budget (#3324 review): the
// load run's burst failed on a saturated database, so a splice must not trade the
// CPU it saves for a statement per pool. Its reads are SEVEN whatever the advisor's
// pool count, plus one compare and swap per code whose offer changed.

const db = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => db.current }));
const HOURS = vi.hoisted(() => ({
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })),
  exceptions: [],
  source: "stored" as const,
}));
vi.mock("@/lib/booking/business-hours-load", () => ({
  loadBusinessHoursCached: vi.fn(async () => HOURS),
  loadBusinessHours: vi.fn(async () => HOURS),
}));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log }));

import { spliceBookedTimeAfterBooking, readSpliceInputsAfterBooking } from "./slot-cache";

const A = "advisor-a";
const B = "advisor-b";
const BOOKED_AT = "2026-10-13T14:00:00.000Z"; // 10:00 Eastern, a Tuesday
const BOOKED = { userId: A, startsAt: BOOKED_AT, endsAt: "2026-10-13T14:20:00.000Z", fenceAtMs: Date.parse("2026-10-05T15:00:00.000Z") };
const EVENT = {
  id: "event-1",
  duration_min: 20,
  buffer_before_min: 0,
  buffer_after_min: 0,
  min_notice_min: 0,
  daily_cap: null,
  slot_interval_min: 10,
};

type Row = Record<string, unknown>;

/**
 * A roster of `pools` pools of four codes each. A serves every one; B serves all but
 * the first `sole`, so in those A's booking empties the booked time and in the rest
 * B is still free for it.
 */
function roster(pools: number, sole: number) {
  const tiers = Array.from({ length: pools }, (_, i) => `t${i}`);
  const buckets: Row[] = tiers.flatMap((t, i) =>
    [0, 1, 2, 3].map((j) => ({
      id: `b-${i}-${j}`,
      org_id: "org-1",
      code: `${i + 1}0${j}`,
      name: `Bucket ${i}${j}`,
      event_type_id: "event-1",
      criteria: { debt_team: t },
      fallback_user_id: null,
      is_test: false,
      event_types: EVENT,
    })),
  );
  const users: Row[] = [
    { id: A, org_id: "org-1", attributes: { debt_team: tiers } },
    { id: B, org_id: "org-1", attributes: { debt_team: tiers.slice(sole) } },
  ];
  const schedules: Row[] = [A, B].map((u) => ({
    id: `s-${u}`,
    user_id: u,
    timezone: "America/New_York",
    availability_rules: [1, 2, 3, 4, 5].map((weekday) => ({
      schedule_id: `s-${u}`,
      weekday,
      start_minute: 9 * 60,
      end_minute: 17 * 60,
    })),
  }));
  const busy: Row[] = [{ id: "busy-1", user_id: A, starts_at: BOOKED_AT, ends_at: BOOKED.endsAt }];
  const slotRows: SlotRow[] = buckets.map((b) => ({
    bucket_code: String(b.code),
    payload: { bucket: { code: b.code }, eventType: EVENT, orgName: "Pennie", slots: ["2026-10-13T13:00:00.000Z", BOOKED_AT] },
    computed_at: "2026-10-05T14:58:00.000Z",
    invalidated_at: null,
  }));
  return { buckets, users, schedules, busy, slotRows, members: [] as Row[] };
}

/** A supabase client fake that answers each table from the roster and COUNTS every
 *  statement: one per `from()` or `rpc()`, which is one round trip each. */
function countingDb(r: ReturnType<typeof roster>) {
  const table = fakeBucketSlotsTable(r.slotRows);
  const statements: string[] = [];
  const answer = (name: string): Row[] => {
    if (name === "buckets") return r.buckets;
    if (name === "bucket_members") return r.members;
    if (name === "users") return r.users;
    if (name === "availability_schedules") return r.schedules;
    if (name === "busy_blocks") return r.busy;
    throw new Error(`the splice read a table it has no business reading: ${name}`);
  };
  const chain = (rows: Row[]) => {
    let out = rows;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => ((out = out.filter((x) => x[c] === undefined || x[c] === v)), b),
      is: () => b,
      in: (c: string, vs: unknown[]) => ((out = out.filter((x) => vs.includes(x[c]))), b),
      lt: (c: string, v: string) => ((out = out.filter((x) => String(x[c]) < v)), b),
      gt: (c: string, v: string) => ((out = out.filter((x) => String(x[c]) > v)), b),
      order: () => b,
      range: async () => ({ data: out, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: out, error: null }).then(ok),
    };
    return b;
  };
  const client = {
    from(name: string) {
      statements.push(name);
      if (name === "bucket_slots") return (table.db as unknown as { from(n: string): unknown }).from(name);
      return chain(answer(name));
    },
    rpc(name: string, args: { p_user_ids: string[] }) {
      statements.push(name);
      expect(name).toBe("count_bookings_per_local_day");
      expect(args.p_user_ids).toContain(A);
      return Promise.resolve({ data: { [`${A}|2026-10-13`]: 1 }, error: null });
    },
  };
  return { client, statements, table };
}

let world: ReturnType<typeof countingDb>;
const slotsOf = (code: string) =>
  (world.table.rows.find((r) => r.bucket_code === code)!.payload as { slots: string[] }).slots;
const READS = 7;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("spliceBookedTimeAfterBooking (#3324): the call budget", () => {
  for (const [pools, sole] of [
    [4, 1],
    [12, 3],
    [12, 12],
  ] as const) {
    it(`${pools} pools, ${sole} of them A's alone: seven reads, and a write only per changed code`, async () => {
      world = countingDb(roster(pools, sole));
      db.current = world.client;
      await spliceBookedTimeAfterBooking("101", BOOKED);

      const writes = world.table.statements.update;
      expect(world.statements.length - writes, "the batched reads do not grow with the pool count").toBe(READS);
      expect(writes, "one compare and swap per code whose offer changed").toBe(sole * 4);
      expect(world.statements.length).toBeLessThanOrEqual(READS + pools * 4);
      // Before #3324's review this shape made about 9 statements a pool plus a read
      // and a write per code: 77 for four pools and 209 for twelve.

      for (let i = 0; i < pools; i++) {
        const code = `${i + 1}00`;
        if (i < sole) expect(slotsOf(code), `${code}: A's own pool no longer offers the time`).not.toContain(BOOKED_AT);
        else expect(slotsOf(code), `${code}: B is still free, so it stays on offer`).toContain(BOOKED_AT);
      }
      expect(log.info).toHaveBeenCalledWith(
        "slot-cache",
        expect.objectContaining({ msg: "booked time spliced", pools, spliced: sole * 4, unchanged: (pools - sole) * 4, failed: 0 }),
      );
    });
  }

  it("reads busy time over the booked window only", async () => {
    world = countingDb(roster(4, 1));
    const busyCalls: string[][] = [];
    const real = world.client.from.bind(world.client);
    world.client.from = (name: string) => {
      const b = real(name) as Record<string, (...a: unknown[]) => unknown>;
      if (name !== "busy_blocks") return b;
      const args: string[] = [];
      const lt = b.lt!;
      const gt = b.gt!;
      b.lt = (c: unknown, v: unknown) => (args.push(`lt ${String(v)}`), lt(c, v));
      b.gt = (c: unknown, v: unknown) => (args.push(`gt ${String(v)}`), gt(c, v));
      busyCalls.push(args);
      return b;
    };
    db.current = world.client;
    await spliceBookedTimeAfterBooking("101", BOOKED);
    expect(busyCalls).toEqual([["lt 2026-10-13T14:40:00.000Z", "gt 2026-10-13T13:40:00.000Z"]]);
  });
});

describe("spliceBookedTimeAfterBooking (#3324): failures", () => {
  it("REJECTS when a code could not be spliced, leaving that row as it was", async () => {
    world = countingDb(roster(2, 2));
    db.current = world.client;
    let n = 0;
    const churn = async () => {
      world.table.rows.find((r) => r.bucket_code === "200")!.computed_at = new Date(Date.UTC(2026, 9, 5, 14, 0, ++n)).toISOString();
      world.table.beforeNextUpdate(churn);
    };
    world.table.beforeNextUpdate(churn);
    await expect(spliceBookedTimeAfterBooking("101", BOOKED)).rejects.toThrow(/could not be spliced/);
    expect(slotsOf("200")).toContain(BOOKED_AT);
    expect(log.warn).toHaveBeenCalled();
  });

  it("REJECTS when the advisor serves no pool, rather than reporting a splice that never happened", async () => {
    const r = roster(2, 0);
    r.users = r.users.filter((u) => u.id !== A);
    world = countingDb(r);
    db.current = world.client;
    await expect(spliceBookedTimeAfterBooking("101", BOOKED)).rejects.toThrow(/serves no pool/);
    expect(world.table.statements.update).toBe(0);
  });
});

describe("readSpliceInputsAfterBooking (#3324, the reads-only arm)", () => {
  it("makes the splice's seven reads and writes nothing", async () => {
    world = countingDb(roster(4, 1));
    db.current = world.client;
    await readSpliceInputsAfterBooking("101", BOOKED);
    expect(world.statements.length).toBe(READS);
    expect(world.table.statements.update).toBe(0);
    expect(slotsOf("100")).toContain(BOOKED_AT);
  });
});
