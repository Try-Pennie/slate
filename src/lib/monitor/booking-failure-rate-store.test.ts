import { describe, it, expect, vi, beforeEach } from "vitest";

// The IO half of the booking-failure-rate page (#1313): reading today's
// cumulative tally and loading/saving the one rolling-window state row.
//
// What matters here is the distinction the pure logic depends on and cannot make
// for itself: "there is no state yet" (a first run, fine) versus "the state could
// not be READ" (which must reach the caller as a throw, so the tick reports
// unverified instead of silently resetting the window and calling it healthy).
// Same for the tally: a failed RPC must never present as a day with no failures.

const rpc = vi.hoisted(() => vi.fn());
const maybeSingle = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn());
/**
 * The `routing_decisions` read (#3633): a chain that records every call it is
 * given, and answers each `.range()` page from `page`, so a test can see both the
 * filters the store asked for and how it walked the pages.
 */
const routing = vi.hoisted(() => {
  const calls: unknown[][] = [];
  const page = vi.fn<(from: number, to: number) => { data: unknown[] | null; error: { message: string } | null }>();
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const method of ["select", "not", "gte", "lt", "gt", "order"]) {
      b[method] = (...args: unknown[]) => {
        calls.push([method, ...args]);
        return b;
      };
    }
    b.range = async (from: number, to: number) => {
      calls.push(["range", from, to]);
      return page(from, to);
    };
    return b;
  };
  return { calls, page, builder };
});
const from = vi.hoisted(() =>
  vi.fn((table: string) =>
    table === "routing_decisions"
      ? routing.builder()
      : {
          select: () => ({ eq: () => ({ maybeSingle }) }),
          upsert,
        },
  ),
);
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ rpc, from })) }));
vi.mock("@/lib/supabase/admin", () => admin);

import { loadRateState, saveRateState, readTodayOutcomes, readRefusedPeople } from "./booking-failure-rate-store";
import { PAGE_SIZE } from "@/lib/supabase/paginate";

beforeEach(() => {
  vi.clearAllMocks();
  routing.calls.length = 0;
  upsert.mockResolvedValue({ error: null });
});

describe("loadRateState", () => {
  it("returns null when no state row exists yet (a first run is not a failure)", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await loadRateState()).toBeNull();
  });

  it("THROWS when the state row could not be read, rather than reading as no state", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "relation missing" } });
    // Silently returning null here would reset the window on every tick, which
    // presents as a permanently unjudgeable (and so permanently silent) check.
    await expect(loadRateState()).rejects.toThrow(/relation missing/);
  });

  it("maps the stored row onto the window shape the pure logic consumes", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        key: "monitor",
        day: "2026-08-11",
        attempts: 900,
        failures: 40,
        by_code: { slot_unavailable: 30 },
        // #1442/#1450/#1709, migration 0113: the baseline the self-inflicted
        // refusal counts are differenced against, in its own column for the same
        // reason attempts and failures have theirs.
        refusals: { refused_ceiling_key: 12 },
        samples: [
          {
            atMs: 1,
            attempts: 2,
            failures: 1,
            byCode: { internal: 1 },
            refusals: { refused_ceiling_key: 3 },
          },
        ],
      },
      error: null,
    });
    const state = await loadRateState();
    expect(state).toEqual({
      day: "2026-08-11",
      attempts: 900,
      failures: 40,
      byCode: { slot_unavailable: 30 },
      refusals: { refused_ceiling_key: 12 },
      samples: [
        {
          atMs: 1,
          attempts: 2,
          failures: 1,
          byCode: { internal: 1 },
          refusals: { refused_ceiling_key: 3 },
        },
      ],
    });
  });

  // A row written before 0113 has no refusal baseline. That must read as an empty
  // map rather than throwing on the first tick after the deploy: a check that
  // exists to speak where nothing else does must not take its own step down.
  it("tolerates a row written before the refusal baseline existed", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        key: "monitor",
        day: "2026-08-11",
        attempts: 1,
        failures: 0,
        by_code: {},
        samples: [{ atMs: 1, attempts: 1, failures: 0, byCode: {} }],
      },
      error: null,
    });
    const state = await loadRateState();
    expect(state?.refusals).toEqual({});
    expect(state?.samples[0].refusals).toBeUndefined();
  });

  it("tolerates a row written before the jsonb columns had values", async () => {
    maybeSingle.mockResolvedValue({
      data: { key: "monitor", day: "2026-08-11", attempts: 1, failures: 0, by_code: null, samples: null },
      error: null,
    });
    const state = await loadRateState();
    expect(state?.samples).toEqual([]);
    expect(state?.byCode).toEqual({});
  });
});

describe("saveRateState", () => {
  it("upserts the single row on its fixed key, so ticks can never accumulate rows", async () => {
    await saveRateState({
      day: "2026-08-11",
      attempts: 5,
      failures: 1,
      byCode: { internal: 1 },
      samples: [],
    });
    expect(upsert).toHaveBeenCalledOnce();
    const [row, opts] = upsert.mock.calls[0];
    expect(row).toMatchObject({ day: "2026-08-11", attempts: 5, failures: 1 });
    expect(row.key).toBeTruthy();
    expect(opts).toMatchObject({ onConflict: "key" });
  });

  it("throws when the write fails, so the caller cannot report a saved window it never saved", async () => {
    upsert.mockResolvedValue({ error: { message: "read only transaction" } });
    await expect(
      saveRateState({ day: "2026-08-11", attempts: 1, failures: 0, byCode: {}, samples: [] }),
    ).rejects.toThrow(/read only transaction/);
  });
});

describe("readTodayOutcomes", () => {
  it("sums every outcome into attempts and carries the error slice by code", async () => {
    rpc.mockResolvedValue({
      data: {
        by_outcome: { created: 80, rescheduled: 5, deduped: 3, confirm_required: 2, error: 10 },
        by_error: { slot_unavailable: 8, internal: 2 },
      },
      error: null,
    });
    const reading = await readTodayOutcomes(Date.UTC(2026, 7, 11, 18, 0, 0));
    expect(reading.attempts).toBe(100);
    expect(reading.failures).toBe(10);
    expect(reading.byCode).toEqual({ slot_unavailable: 8, internal: 2 });
    expect(reading.day).toBe("2026-08-11");
  });

  it("asks for TODAY's ET day, so the window is measured against the same day the tally buckets by", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {}, by_error: {} }, error: null });
    // 01:00 UTC on the 12th is still the 11th in Eastern time.
    const reading = await readTodayOutcomes(Date.UTC(2026, 7, 12, 1, 0, 0));
    expect(reading.day).toBe("2026-08-11");
    expect(rpc).toHaveBeenCalledWith("booking_api_outcome_mix", {
      p_since: "2026-08-11",
      p_include_test: false,
      p_include_offsite: false,
    });
  });

  // #1616. Before cutover EVERY attempt in the tally is the smoke canary's, and
  // exactly one per pass is a reschedule_conflict the canary raises on purpose, so
  // a reading that counts it measures the test harness. The exclusion is asserted
  // at the reading site rather than trusted to the RPC's own default, which nothing
  // in this repo can see.
  it("asks the tally to EXCLUDE test traffic, so the canary is not the thing being measured", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {}, by_error: {}, test_total: 16 }, error: null });
    await readTodayOutcomes(Date.UTC(2026, 7, 11, 18, 0, 0));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_include_test: false });
  });

  it("reads a day of nothing but excluded canary traffic as zero attempts, not as a failure", async () => {
    // What production looks like while the roster is dark: the canary wrote 16
    // rows and every one of them was filtered out by the RPC, so the window has
    // nothing to judge and the check parks instead of concluding.
    rpc.mockResolvedValue({ data: { by_outcome: {}, by_error: {}, test_total: 16 }, error: null });
    const reading = await readTodayOutcomes(Date.UTC(2026, 7, 11, 18, 0, 0));
    expect(reading.attempts).toBe(0);
    expect(reading.failures).toBe(0);
    expect(reading.byCode).toEqual({});
  });

  it("THROWS when the tally read fails, rather than reporting a day with no failures", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    await expect(readTodayOutcomes(Date.now())).rejects.toThrow(/function does not exist/);
  });

  it("reads a genuinely empty day as zeroes, which is a real measurement", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {}, by_error: {} }, error: null });
    const reading = await readTodayOutcomes(Date.UTC(2026, 7, 11, 18, 0, 0));
    expect(reading.attempts).toBe(0);
    expect(reading.failures).toBe(0);
  });
});

// #3633: who was refused a time, for the page to lead with.
describe("readRefusedPeople", () => {
  const SINCE = Date.UTC(2026, 9, 12, 4, 15, 0);
  const UNTIL = Date.UTC(2026, 9, 12, 4, 25, 0);

  it("reads only the window's refusals, and joins each to its bucket's test marker", async () => {
    routing.page.mockReturnValue({
      data: [
        { id: "1", lead_id: "00QUi000011BI7B", requested_start: "2026-10-12T20:30:00+00:00", buckets: { is_test: false } },
        { id: "2", lead_id: "00QUi000011BI7B", requested_start: "2026-10-12T20:30:00+00:00", buckets: { is_test: false } },
        { id: "3", lead_id: "SMOKE0000000001", requested_start: "2026-10-12T21:00:00+00:00", buckets: { is_test: true } },
        // #3797: a proven lost race is left out of the people, like the share.
        { id: "5", lead_id: "00QUi000011bFqE", requested_start: "2026-10-12T23:00:00+00:00", offer_verdict: "race", buckets: { is_test: false } },
        // The bucket was deleted (`on delete set null`): counted, as real.
        { id: "4", lead_id: "00QUl00000OipHQ", requested_start: "2026-10-12T22:00:00+00:00", buckets: null },
      ],
      error: null,
    });
    const out = await readRefusedPeople(SINCE, UNTIL);
    // #3276: two distinct times among the counted refusals; the test bucket's is out.
    // #3797: the proven race is counted apart, in neither the people nor the refusals.
    expect(out).toEqual({ people: 2, refusals: 3, withoutLead: 0, times: 2, races: 1 });
    expect(from).toHaveBeenCalledWith("routing_decisions");
    expect(routing.calls).toContainEqual(["select", "id, lead_id, requested_start, offer_verdict, buckets(is_test)"]);
    expect(routing.calls).toContainEqual(["not", "refusal_stage", "is", null]);
    expect(routing.calls).toContainEqual(["gte", "created_at", new Date(SINCE).toISOString()]);
    expect(routing.calls).toContainEqual(["lt", "created_at", new Date(UNTIL).toISOString()]);
  });

  it("walks every page, so a big outage is not cut off at the first one", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `a${i}`, lead_id: `L${i}`, buckets: { is_test: false } }));
    const rest = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, lead_id: `M${i}`, buckets: { is_test: false } }));
    routing.page.mockReturnValueOnce({ data: full, error: null }).mockReturnValueOnce({ data: rest, error: null });
    const out = await readRefusedPeople(SINCE, UNTIL);
    expect(out).toEqual({ people: PAGE_SIZE + 5, refusals: PAGE_SIZE + 5, withoutLead: 0 });
    expect(routing.calls.filter((c) => c[0] === "range")).toEqual([
      ["range", 0, PAGE_SIZE - 1],
      ["range", 0, PAGE_SIZE - 1],
    ]);
    // Keyset paging: the second page is the rows after the first page's last id.
    expect(routing.calls.filter((c) => c[0] === "gt")).toEqual([["gt", "id", `a${PAGE_SIZE - 1}`]]);
  });

  it("THROWS when a page fails, rather than counting the pages it did get", async () => {
    routing.page.mockReturnValue({ data: null, error: { message: "statement timeout" } });
    await expect(readRefusedPeople(SINCE, UNTIL)).rejects.toThrow(/statement timeout/);
  });
});
