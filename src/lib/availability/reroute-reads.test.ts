import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Booking, Bucket, EventType } from "@/lib/db/types";

// #3251 (phase 5 of #3244): the two live reads a reroute hold depends on, driven
// through the real functions with only the database faked (L52: a fake of the
// function itself agrees with whatever it is told).
//
// 1. The booker's candidate list (`roundRobinCandidates`) skips an advisor held for
//    another booking's correction BEFORE verify, so a lead picking that time is
//    routed elsewhere rather than invited and then cancelled (red team 1). The pure
//    drop and the hold read each have their own suite; this proves the booker
//    actually wires them together.
// 2. A reroute's keep check reads the current advisor's time off and daily cap
//    count live (`loadCurrentAgentPicture`), and either read failing throws, so the
//    caller answers with the retriable error rather than a keep (audit 12).
//
// Both directions (L1): every refusal has the same call succeeding beside it.

const db = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>,
  failing: new Set<string>(),
}));

/** A Supabase client answering each table or function from `db.answers`, empty by default. */
function fakeDb() {
  const answer = (name: string) =>
    db.failing.has(name)
      ? { data: null, error: { message: `${name} refused` } }
      : { data: db.answers[name] ?? (name === "count_bookings_per_local_day" ? {} : []), error: null };
  const chain = (name: string): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then" ? (resolve: (v: unknown) => void) => resolve(answer(name)) : () => chain(name),
      },
    );
  return { from: (table: string) => chain(table), rpc: (fn: string) => Promise.resolve(answer(fn)) };
}
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => fakeDb() }));

const ALL_DAY = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 }));
vi.mock("@/lib/booking/business-hours-load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/business-hours-load")>()),
  loadBusinessHours: async () => ({ zone: "UTC", rules: ALL_DAY, exceptions: [] }),
}));

import { loadCurrentAgentPicture, roundRobinCandidates } from "./service";

const bucket = {
  id: "b512", org_id: "org1", code: "512", is_test: false, event_type_id: "et1", fallback_user_id: null, criteria: {},
} as unknown as Bucket;
const eventType = {
  id: "et1", duration_min: 20, buffer_before_min: 10, buffer_after_min: 10,
  min_notice_min: 120, daily_cap: 8, slot_interval_min: 10,
} as unknown as EventType;

/** A future Tuesday, so minimum notice never decides anything here. */
const at = (hhmm: string) => `2031-03-04T${hhmm}:00.000Z`;
const START = Date.parse(at("15:00"));

/** Two advisors in the pool, free all day, with no calls. */
function pool() {
  db.answers.bucket_members = [{ user_id: "A" }, { user_id: "B" }];
  db.answers.users = [
    { id: "A", attributes: {} },
    { id: "B", attributes: {} },
  ];
  db.answers.availability_schedules = ["A", "B"].map((id) => ({
    id: `s${id}`, user_id: id, timezone: "UTC",
    availability_rules: ALL_DAY.map((r) => ({ schedule_id: `s${id}`, ...r })),
  }));
}

/** A live hold on `agent` for booking `bookingId`, at `hhmm` for twenty minutes. */
function hold(agent: string, bookingId: string, hhmm: string) {
  const s = Date.parse(at(hhmm));
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    agent_user_id: agent, booking_id: bookingId,
    booking_starts_at: iso(s), booking_ends_at: iso(s + 20 * 60_000),
    buffered_starts_at: iso(s - 10 * 60_000), buffered_ends_at: iso(s + 30 * 60_000),
  };
}

beforeEach(() => {
  db.answers = {};
  db.failing.clear();
  pool();
});

describe("the booker's candidate list and a reroute hold", () => {
  it("offers both advisors when nobody is held", async () => {
    const { candidates } = await roundRobinCandidates(bucket, eventType, START);
    expect([...candidates].sort()).toEqual(["A", "B"]);
  });

  it("drops an advisor held for another booking's correction at that time", async () => {
    db.answers.live_reroute_holds = [hold("A", "K-other", "15:00")];
    expect((await roundRobinCandidates(bucket, eventType, START)).candidates).toEqual(["B"]);
  });

  it("drops them back to back at the hold's end, inside its ten minute buffer", async () => {
    // The hold is 14:40 to 15:00 and this call starts at 15:00, with no gap.
    db.answers.live_reroute_holds = [hold("A", "K-other", "14:40")];
    expect((await roundRobinCandidates(bucket, eventType, START)).candidates).toEqual(["B"]);
  });

  it("keeps an advisor exactly one buffer away on either side, as the slot judge would", async () => {
    // One buffer is the gap, never two: 14:30 to 14:50 and 15:30 to 15:50 each
    // leave ten minutes, the same rule the database trigger applies.
    for (const hhmm of ["14:30", "15:30"]) {
      db.answers.live_reroute_holds = [hold("A", "K-other", hhmm)];
      expect([...(await roundRobinCandidates(bucket, eventType, START)).candidates].sort(), hhmm).toEqual(["A", "B"]);
    }
  });

  it("never drops an advisor for the hold on the very booking being rerouted", async () => {
    db.answers.live_reroute_holds = [hold("A", "K1", "15:00")];
    const { candidates } = await roundRobinCandidates(bucket, eventType, START, false, undefined, false, {
      fixedTime: true,
      forBookingId: "K1",
    });
    expect([...candidates].sort()).toEqual(["A", "B"]);
  });

  it("throws when the hold read fails, never reading it as nobody held", async () => {
    db.failing.add("live_reroute_holds");
    await expect(roundRobinCandidates(bucket, eventType, START)).rejects.toThrow(/live reroute holds/);
  });
});

describe("loadCurrentAgentPicture", () => {
  const booking = { assigned_user_id: "A", starts_at: at("15:00"), ends_at: at("15:20") } as Pick<
    Booking,
    "assigned_user_id" | "starts_at" | "ends_at"
  >;

  it("loads the current advisor's picture when every read answers", async () => {
    const picture = await loadCurrentAgentPicture(bucket, eventType, booking);
    expect(picture.onTimeOff).toBe(false);
    expect(picture.member?.userId).toBe("A");
    expect([...picture.pool.ids].sort()).toEqual(["A", "B"]);
  });

  it("reads approved time off over the call as time off", async () => {
    db.answers.ooo_requests = [{ id: "ooo-1", user_id: "A" }];
    expect((await loadCurrentAgentPicture(bucket, eventType, booking)).onTimeOff).toBe(true);
  });

  it("throws when the time off read fails, never reading it as no time off", async () => {
    db.failing.add("ooo_requests");
    await expect(loadCurrentAgentPicture(bucket, eventType, booking)).rejects.toThrow(/ooo_requests refused/);
  });

  it("throws when the daily cap count fails, never reading it as no calls that day", async () => {
    db.failing.add("count_bookings_per_local_day");
    await expect(loadCurrentAgentPicture(bucket, eventType, booking)).rejects.toThrow(/daily-cap count failed/);
  });
});
