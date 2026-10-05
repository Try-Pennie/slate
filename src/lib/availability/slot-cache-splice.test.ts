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
function countingDb(r: ReturnType<typeof roster>, counts: Record<string, number> = { [`${A}|2026-10-13`]: 1 }) {
  const table = fakeBucketSlotsTable(r.slotRows);
  const statements: string[] = [];
  /** Every `or` a busy read sent: one overlap test per span (#3334). */
  const busyOr: string[] = [];
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
      // Reads the one shape the splice sends: `and(starts_at.lt.X,ends_at.gt.Y)`, comma joined.
      or: (expr: string) => {
        busyOr.push(expr);
        const spans = [...expr.matchAll(/and\(starts_at\.lt\.([^,]+),ends_at\.gt\.([^)]+)\)/g)].map((m) => ({
          to: m[1]!,
          from: m[2]!,
        }));
        if (spans.length === 0) throw new Error(`the fake cannot read or(${expr})`);
        out = out.filter((x) => spans.some((sp) => String(x.starts_at) < sp.to && String(x.ends_at) > sp.from));
        return b;
      },
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
      return Promise.resolve({ data: counts, error: null });
    },
  };
  return { client, statements, table, busyOr };
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

  it("SKIPS, logged, when the advisor serves no pool any more (made unbookable since the booking)", async () => {
    // Deactivated or made unbookable between the confirm and the splice: no pool
    // routes to them, so no row offers their time and there is nothing to splice.
    // That is a legitimate outcome, not a failed job.
    const r = roster(2, 0);
    r.users = r.users.filter((u) => u.id !== A);
    world = countingDb(r);
    db.current = world.client;
    await expect(spliceBookedTimeAfterBooking("101", BOOKED)).resolves.toBeUndefined();
    expect(world.table.statements.update).toBe(0);
    expect(log.info).toHaveBeenCalledWith(
      "slot-cache",
      expect.objectContaining({ msg: "booked time splice skipped: the advisor serves no pool", user_id: A }),
    );
  });

  it("REJECTS when the roster read itself fails, which is could not tell, never no pools", async () => {
    world = countingDb(roster(2, 0));
    const real = world.client.from.bind(world.client);
    world.client.from = (name: string) => {
      if (name !== "users") return real(name);
      world.statements.push(name);
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: "connection reset" } }).then(ok),
      };
      return b;
    };
    db.current = world.client;
    await expect(spliceBookedTimeAfterBooking("101", BOOKED)).rejects.toThrow(/connection reset/);
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

// #3334: a reschedule or reassign splices BOTH windows: the time taken comes off every
// pool its advisor serves, and the time left goes back on in every pool ITS advisor
// serves. Through the real wiring, so the reads a move makes are counted.
describe("spliceBookedTimeAfterBooking (#3334): a move", () => {
  // A moves their Tuesday 10:00 call to Thursday 14:00 Eastern, two days away.
  const MOVED_TO = "2026-10-15T18:00:00.000Z";
  const MOVED_END = "2026-10-15T18:20:00.000Z";
  const TUESDAY_NINE = "2026-10-13T13:00:00.000Z";
  /** Every start on the ten minute grid from `from` to `to` (inclusive), UTC. */
  const grid = (day: string, from: string, to: string) => {
    const out: string[] = [];
    for (let t = Date.parse(`${day}T${from}:00.000Z`); t <= Date.parse(`${day}T${to}:00.000Z`); t += 600_000) {
      out.push(new Date(t).toISOString());
    }
    return out;
  };
  // What the shared predicate offers around each call, so a stored row agrees with
  // the fresh answer wherever nothing changed (a real row is the same predicate's).
  // The call is 20 minutes on a 10 minute grid with no buffers, so a booking at 10:00
  // refuses 09:50, 10:00 and 10:10 to its advisor.
  const TUESDAY_FREE = [TUESDAY_NINE, ...grid("2026-10-13", "13:40", "14:20")];
  const TUESDAY_HELD = [TUESDAY_NINE, "2026-10-13T13:40:00.000Z", "2026-10-13T14:20:00.000Z"];
  const THURSDAY_FREE = grid("2026-10-15", "17:40", "18:20");
  const MOVE = {
    userId: A,
    startsAt: MOVED_TO,
    endsAt: MOVED_END,
    fenceAtMs: BOOKED.fenceAtMs,
    freed: { userId: A, startsAt: BOOKED_AT, endsAt: BOOKED.endsAt },
  };

  /** The roster as the rows stood BEFORE the move: A's own pools withheld Tuesday
   *  10:00 (A held it) and offered Thursday 14:00; busy time is as the move left it. */
  function movedRoster(pools: number, sole: number) {
    const r = roster(pools, sole);
    r.busy = [{ id: "busy-1", user_id: A, starts_at: MOVED_TO, ends_at: MOVED_END }];
    r.slotRows = r.slotRows.map((row, i) => {
      const own = Math.floor(i / 4) < sole;
      const slots = own ? [...TUESDAY_HELD, ...THURSDAY_FREE] : [...TUESDAY_FREE, ...THURSDAY_FREE];
      return { ...row, payload: { ...(row.payload as object), slots } };
    });
    return r;
  }

  for (const [pools, sole] of [
    [4, 1],
    [12, 3],
  ] as const) {
    it(`${pools} pools: the same seven reads a create makes, one busy statement over both windows`, async () => {
      world = countingDb(movedRoster(pools, sole), { [`${A}|2026-10-15`]: 1 });
      db.current = world.client;
      await spliceBookedTimeAfterBooking("101", MOVE);

      const writes = world.table.statements.update;
      expect(world.statements.length - writes, "a move must not add reads to the splice").toBe(READS);
      expect(world.statements.filter((t) => t === "busy_blocks")).toHaveLength(1);
      expect(world.busyOr, "busy time over the two windows only, never the two days between them").toEqual([
        "and(starts_at.lt.2026-10-13T14:40:00.000Z,ends_at.gt.2026-10-13T13:40:00.000Z)," +
          "and(starts_at.lt.2026-10-15T18:40:00.000Z,ends_at.gt.2026-10-15T17:40:00.000Z)",
      ]);
      expect(writes, "one compare and swap per changed code, carrying both windows").toBe(sole * 4);

      for (let i = 0; i < pools; i++) {
        const code = `${i + 1}00`;
        expect(slotsOf(code), `${code}: Tuesday 10:00 is on offer after the move`).toContain(BOOKED_AT);
        if (i < sole) expect(slotsOf(code), `${code}: A's own pool no longer offers Thursday 14:00`).not.toContain(MOVED_TO);
        else expect(slotsOf(code), `${code}: B is free on Thursday, so it stays`).toContain(MOVED_TO);
      }
    });
  }

  it("a cross advisor reassign: the old advisor's pools offer the time again, the new one's stop", async () => {
    // Three pools: t0 is A's alone, t1 both, t2 B's alone. A's 10:00 goes to B.
    const r = roster(3, 0);
    r.users = [
      { id: A, org_id: "org-1", attributes: { debt_team: ["t0", "t1"] } },
      { id: B, org_id: "org-1", attributes: { debt_team: ["t1", "t2"] } },
    ];
    r.busy = [{ id: "busy-1", user_id: B, starts_at: BOOKED_AT, ends_at: BOOKED.endsAt }];
    r.slotRows = r.slotRows.map((row) => {
      const pool = row.bucket_code[0];
      // Before: A held 10:00, so A's own pool withheld it; B's own pool offered it.
      const slots = pool === "1" ? TUESDAY_HELD : TUESDAY_FREE;
      return { ...row, payload: { ...(row.payload as object), slots } };
    });
    world = countingDb(r, { [`${B}|2026-10-13`]: 1 });
    db.current = world.client;
    await spliceBookedTimeAfterBooking("101", {
      userId: B,
      startsAt: BOOKED_AT,
      endsAt: BOOKED.endsAt,
      fenceAtMs: BOOKED.fenceAtMs,
      freed: { userId: A, startsAt: BOOKED_AT, endsAt: BOOKED.endsAt },
    });

    expect(world.statements.length - world.table.statements.update, "still seven reads").toBe(READS);
    expect(world.statements.filter((t) => t === "users"), "both advisors from one roster read").toHaveLength(1);
    for (const j of [0, 1, 2, 3]) {
      expect(slotsOf(`10${j}`), `10${j}: A's own pool offers 10:00 again`).toContain(BOOKED_AT);
      expect(slotsOf(`20${j}`), `20${j}: the shared pool offers it throughout`).toContain(BOOKED_AT);
      expect(slotsOf(`30${j}`), `30${j}: B's own pool no longer offers it`).not.toContain(BOOKED_AT);
    }
    expect(world.table.statements.update, "a write for each single advisor pool's codes, none for the shared one").toBe(8);
    expect(log.info).toHaveBeenCalledWith(
      "slot-cache",
      expect.objectContaining({ msg: "booked time spliced", pools: 3, spliced: 8, unchanged: 4, failed: 0 }),
    );
  });
});
