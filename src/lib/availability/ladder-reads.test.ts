import { describe, it, expect, vi, beforeEach } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { Bucket, EventType } from "@/lib/db/types";

// #3489: a rung judged from the walk's ONE ladder read gets exactly the candidates, in
// exactly the order, that the rung's own seven to nine reads gave it, and reads nothing.
//
// `ladder_candidate_inputs` (0176) returns the rows the separate reads returned, for
// every bookable advisor of the org and over windows wider than any rung's;
// scripts/verify-ladder-candidate-inputs-sql.ts proves that in a real Postgres. This
// proves the other half: `roundRobinCandidates`, given those rows, narrows them to the
// rung's pool and window and judges them the same way. The fake database below honours
// every filter the live reads send, the same rows feed both paths, and each case is
// something the reads filter on: busy time, a hold block, a live hold, the daily cap,
// the share order, the Low exclusion, a handed advisor, a manual member, an advisor
// who left.

const dbHolder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof supabaseAdmin>, calls: 0 }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => dbHolder.db }));

import { roundRobinCandidates } from "./service";
import { ladderInputsFrom, ladderWindows } from "./ladder-inputs";

type Row = Record<string, unknown>;

/** A database that answers each read with the rows its filters select. */
function fakeDb(tables: Record<string, Row[]>, rpc: Record<string, (args: Row) => unknown>): ReturnType<typeof supabaseAdmin> {
  const builder = (all: Row[]) => {
    const filters: ((r: Row) => boolean)[] = [];
    const time = (v: unknown) => Date.parse(String(v));
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      lt: (c: string, v: string) => (filters.push((r) => time(r[c]) < time(v)), b),
      gt: (c: string, v: string) => (filters.push((r) => time(r[c]) > time(v)), b),
      gte: (c: string, v: string) => (filters.push((r) => (/^\d{4}-\d\d-\d\d$/.test(v) ? String(r[c]) >= v : time(r[c]) >= time(v))), b),
      lte: () => b,
      limit: () => b,
      order: () => b,
      range: (from: number, to: number) => {
        filters.push(() => true);
        (b as { _range?: [number, number] })._range = [from, to];
        return b;
      },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        dbHolder.calls++;
        const rows = all.filter((r) => filters.every((f) => f(r)));
        const range = (b as { _range?: [number, number] })._range;
        return Promise.resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null }).then(resolve);
      },
    };
    return b;
  };
  return {
    from: (t: string) => builder(tables[t] ?? []),
    rpc: (name: string, args: Row) => {
      dbHolder.calls++;
      return Promise.resolve({ data: rpc[name] ? rpc[name]!(args) : null, error: null });
    },
  } as unknown as ReturnType<typeof supabaseAdmin>;
}

const ORG = "org1";
const BUCKET = { id: "b500", org_id: ORG, code: "500", name: "Top", criteria: { debt_team: ["high"] }, fallback_user_id: null, is_test: false } as unknown as Bucket;
const EVENT = {
  id: "e1",
  duration_min: 20,
  buffer_before_min: 10,
  buffer_after_min: 10,
  min_notice_min: 0,
  daily_cap: 3,
  slot_interval_min: 10,
} as unknown as EventType;
// Tuesday 2031-03-04 11:00 New York, 16:00Z.
const START_ISO = "2031-03-04T16:00:00.000Z";
const START = Date.parse(START_ISO);
const at = (min: number) => new Date(START + min * 60_000).toISOString();

const ADVISORS = ["free1", "free2", "free3", "busy", "holdblock", "held", "capped", "low", "manual", "left", "off"];
const HIGH = { debt_team: ["high"] };

function world() {
  const users: Row[] = ADVISORS.map((id) => ({
    id,
    org_id: ORG,
    email: `${id}@example.com`,
    attributes: id === "low" ? { debt_team: ["high", "low"] } : id === "manual" ? {} : HIGH,
    bookable: id !== "off",
    deactivated_at: id === "left" ? "2031-02-01T00:00:00.000Z" : null,
  }));
  const schedules: Row[] = ADVISORS.map((id) => ({
    id: `s-${id}`,
    user_id: id,
    timezone: "America/New_York",
    availability_rules: [{ schedule_id: `s-${id}`, weekday: 2, start_minute: 9 * 60, end_minute: 17 * 60 }],
  }));
  const busy: Row[] = [
    { id: "x1", user_id: "busy", starts_at: at(-5), ends_at: at(15), source: "gcal" },
    // A hold block: the candidate read leaves these out and judges the hold itself.
    { id: "x2", user_id: "holdblock", starts_at: at(0), ends_at: at(20), source: "hold" },
    // Busy, but well outside the call's buffered window.
    { id: "x3", user_id: "free2", starts_at: at(120), ends_at: at(150), source: "gcal" },
  ];
  // The share: free1 has two this period, free3 one, free2 none (established last period).
  const bookings: Row[] = [
    { bucket_id: "b500", assigned_user_id: "free1", starts_at: "2031-03-03T15:00:00.000Z", created_at: "2031-03-01T10:00:00.000Z", kind: "routed", status: "confirmed" },
    { bucket_id: "b500", assigned_user_id: "free1", starts_at: "2031-03-04T13:00:00.000Z", created_at: "2031-03-02T10:00:00.000Z", kind: "routed", status: "completed" },
    { bucket_id: "b500", assigned_user_id: "free3", starts_at: "2031-03-04T14:00:00.000Z", created_at: "2031-03-03T10:00:00.000Z", kind: "routed", status: "confirmed" },
    { bucket_id: "b500", assigned_user_id: "free2", starts_at: "2031-03-01T14:00:00.000Z", created_at: "2031-02-25T10:00:00.000Z", kind: "routed", status: "confirmed" },
    // Not a share: a named link booking, a cancelled one, another bucket.
    { bucket_id: "b500", assigned_user_id: "free2", starts_at: "2031-03-04T14:30:00.000Z", created_at: "2031-03-03T11:00:00.000Z", kind: "agent_link", status: "confirmed" },
    { bucket_id: "b500", assigned_user_id: "free2", starts_at: "2031-03-04T14:40:00.000Z", created_at: "2031-03-03T12:00:00.000Z", kind: "routed", status: "cancelled" },
    { bucket_id: "b400", assigned_user_id: "free3", starts_at: "2031-03-04T15:00:00.000Z", created_at: "2031-03-03T12:00:00.000Z", kind: "routed", status: "confirmed" },
  ];
  const tables: Record<string, Row[]> = {
    users,
    bucket_members: [
      { bucket_id: "b500", user_id: "manual", active: true },
      { bucket_id: "b500", user_id: "off", active: true },
    ],
    availability_schedules: schedules,
    busy_blocks: busy,
    bookings,
    business_hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, is_open: true, start_minute: 7 * 60, end_minute: 21 * 60 })),
    business_hours_exceptions: [],
  };
  // capped already has three today; the cap is three.
  const counts = { [`capped|2031-03-04`]: 3, [`free1|2031-03-04`]: 1 };
  const holds: Row[] = [
    {
      agent_user_id: "held",
      booking_id: "bk-held",
      booking_starts_at: at(0),
      booking_ends_at: at(20),
      buffered_starts_at: at(-10),
      buffered_ends_at: at(30),
    },
  ];
  const rpc = {
    count_bookings_per_local_day: (args: Row) => {
      const ids = args.p_user_ids as string[];
      return Object.fromEntries(Object.entries(counts).filter(([k]) => ids.includes(k.split("|")[0]!)));
    },
    live_reroute_holds: (args: Row) => {
      const ids = args.p_user_ids as string[];
      const from = Date.parse(String(args.p_from));
      const to = Date.parse(String(args.p_to));
      return holds.filter((h) => ids.includes(String(h.agent_user_id)) && Date.parse(String(h.buffered_starts_at)) < to && Date.parse(String(h.buffered_ends_at)) > from);
    },
  };
  return { tables, rpc, counts, holds };
}

/** The snapshot `ladder_candidate_inputs` answers for this world: every section's rows. */
function snapshotOf(w: ReturnType<typeof world>, windows: ReturnType<typeof ladderWindows>) {
  const t = w.tables;
  const roster = t.users!.filter((u) => u.org_id === ORG && u.bookable === true && u.deactivated_at === null);
  const ids = new Set(roster.map((u) => u.id));
  const inWindow = (from: unknown, to: unknown) => Date.parse(String(from)) < Date.parse(windows.busyTo) && Date.parse(String(to)) > Date.parse(windows.busyFrom);
  const data = {
    buckets: [{ ...BUCKET, event_types: EVENT }],
    // The whole row, as the function returns it.
    agents: roster,
    members: t.bucket_members!.filter((m) => m.active).map((m) => ({ bucket_id: m.bucket_id, user_id: m.user_id })),
    schedules: t.availability_schedules!.filter((s) => ids.has(s.user_id)),
    busy: t.busy_blocks!.filter((b) => ids.has(b.user_id) && inWindow(b.starts_at, b.ends_at)).map(({ id: _id, ...b }) => b),
    day_counts: w.counts,
    holds: w.holds.filter((h) => ids.has(h.agent_user_id) && inWindow(h.buffered_starts_at, h.buffered_ends_at)),
    // Every bucket on the ladder, as the function returns them: the rung picks its own.
    shares: t.bookings!.filter(
      (k) =>
        ["b500", "b400"].includes(String(k.bucket_id)) &&
        k.kind === "routed" &&
        ["confirmed", "rescheduled", "completed"].includes(String(k.status)) &&
        Date.parse(String(k.starts_at)) >= Date.parse(windows.shareFrom) &&
        Date.parse(String(k.starts_at)) < Date.parse(windows.shareTo) &&
        ids.has(k.assigned_user_id),
    ).map(({ bucket_id, assigned_user_id, starts_at, created_at }) => ({ bucket_id, assigned_user_id, starts_at, created_at })),
    business_hours: t.business_hours,
    exceptions: [],
  };
  return ladderInputsFrom(JSON.parse(JSON.stringify(data)), windows);
}

type Args = { excludeLow?: boolean; narrowTo?: string };

async function both(args: Args = {}) {
  const w = world();
  dbHolder.db = fakeDb(w.tables, w.rpc);
  const windows = ladderWindows(START_ISO, EVENT, START - 60 * 60_000);
  const opts = args.narrowTo ? { narrowTo: args.narrowTo } : undefined;
  dbHolder.calls = 0;
  const live = await roundRobinCandidates(BUCKET, EVENT, START, true, undefined, args.excludeLow ?? false, opts);
  const liveCalls = dbHolder.calls;
  const inputs = snapshotOf(w, windows);
  dbHolder.calls = 0;
  const fromLadder = await roundRobinCandidates(BUCKET, EVENT, START, true, undefined, args.excludeLow ?? false, { ...opts, inputs });
  return { live, fromLadder, liveCalls, ladderCalls: dbHolder.calls };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START - 60 * 60_000, toFake: ["Date"] });
});

describe("a rung judged from the ladder read (#3489)", () => {
  it("offers the same advisors in the same order as its own reads, and reads nothing", async () => {
    const r = await both();
    expect(r.live.candidates.length).toBeGreaterThan(1);
    expect(r.fromLadder).toEqual(r.live);
    expect(r.liveCalls).toBeGreaterThan(5);
    expect(r.ladderCalls).toBe(0);
  });

  it("leaves out the busy advisor, the held one, the one at their daily cap, and the one who left; keeps the one whose only block is a hold block", async () => {
    const { fromLadder, live } = await both();
    expect(live.candidates).not.toEqual(expect.arrayContaining(["busy"]));
    for (const gone of ["busy", "held", "capped", "left", "off"]) expect(fromLadder.candidates).not.toContain(gone);
    expect(fromLadder.candidates).toContain("holdblock");
    expect(fromLadder.candidates).toContain("manual");
  });

  it("orders by the bucket's share: fewest this period first", async () => {
    const { fromLadder, live } = await both();
    expect(fromLadder.candidates).toEqual(live.candidates);
    expect(fromLadder.candidates.indexOf("free2")).toBeLessThan(fromLadder.candidates.indexOf("free1"));
  });

  it("applies the Low exclusion the same way", async () => {
    const r = await both({ excludeLow: true });
    expect(r.fromLadder).toEqual(r.live);
    expect(r.fromLadder.candidates).not.toContain("low");
  });

  it("narrows to a handed advisor the same way", async () => {
    for (const handed of ["free3", "busy", "outsider"]) {
      const r = await both({ narrowTo: handed });
      expect(r.fromLadder).toEqual(r.live);
    }
  });

  it("reads a rung whose window is outside the ladder read's on its own, never from rows that stop short", async () => {
    const w = world();
    dbHolder.db = fakeDb(w.tables, w.rpc);
    // A ladder read made for a slot two hours earlier does not cover this one.
    const inputs = snapshotOf(w, ladderWindows(at(-180), EVENT, START - 60 * 60_000));
    dbHolder.calls = 0;
    const live = await roundRobinCandidates(BUCKET, EVENT, START, true);
    dbHolder.calls = 0;
    const r = await roundRobinCandidates(BUCKET, EVENT, START, true, undefined, false, { inputs });
    expect(dbHolder.calls).toBeGreaterThan(5);
    expect(r).toEqual(live);
  });
});
