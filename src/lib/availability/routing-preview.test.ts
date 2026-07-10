import { describe, it, expect, vi, beforeEach } from "vitest";

// #673: the public routing endpoint is a read-only preview. A degraded
// equal-share read must never page the internal unfair-ordering alert, or an
// anonymous probe against a skewed bucket becomes an alert source. The dry-run
// path (#380) already suppresses it; resolveRouting must use the same path.

const sendThrottledAlert = vi.fn(async () => {});
vi.mock("@/lib/notify/dispatch", () => ({
  sendThrottledAlert: (...args: unknown[]) => sendThrottledAlert(...(args as [])),
}));

type Result = { data: unknown; error: { message: string } | null };

/** Table-keyed chainable stand-in: every filter is a no-op, so each fixture is
 *  simply the result that table's query resolves to. */
function fakeDb(tables: Record<string, Result>) {
  const builder = (res: Result) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      gte: () => b,
      lt: () => b,
      in: () => b,
      maybeSingle: () =>
        Promise.resolve({
          data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data,
          error: res.error,
        }),
      then: (resolve: (v: Result) => unknown) => Promise.resolve(res).then(resolve),
    };
    return b;
  };
  return { from: (table: string) => builder(tables[table] ?? { data: [], error: null }) };
}

let db = fakeDb({});
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => db }));

const { resolveRouting } = await import("./service");

const BUCKET = {
  id: "b1",
  org_id: "org1",
  code: "311",
  name: "High",
  criteria: {},
  is_test: false,
  fallback_user_id: null,
  event_type_id: "et1",
  event_types: { id: "et1", duration_minutes: 30 },
};

/** Two manual members (so the ranker has >1 candidate and does not short-circuit),
 *  and a bookings read that FAILS, which is what marks the share `degraded`. */
function degradedShareDb() {
  return fakeDb({
    buckets: { data: [BUCKET], error: null },
    bucket_members: {
      data: [
        { user_id: "u1" },
        { user_id: "u2" },
      ],
      error: null,
    },
    users: {
      data: [
        { id: "u1", attributes: {}, bookable: true },
        { id: "u2", attributes: {}, bookable: true },
      ],
      error: null,
    },
    bookings: { data: null, error: { message: "share read failed" } },
  });
}

describe("resolveRouting (#673)", () => {
  beforeEach(() => {
    sendThrottledAlert.mockClear();
    db = degradedShareDb();
  });

  it("does not page the unfair-ordering alert on a degraded share", async () => {
    await resolveRouting("311");
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("still returns a usable routed order when the share read is degraded", async () => {
    const routing = await resolveRouting("311");
    expect(routing).not.toBeNull();
    expect(routing!.eligibleIds.slice().sort()).toEqual(["u1", "u2"]);
    expect(routing!.routedAgentId).not.toBeNull();
    expect(routing!.eligibleIds).toContain(routing!.routedAgentId!);
  });

  it("returns the same order a healthy share would, so callers see no change", async () => {
    // Healthy read, u1 already booked twice this period -> u2 (fewer) ranks first.
    const now = Date.now();
    db = fakeDb({
      buckets: { data: [BUCKET], error: null },
      bucket_members: { data: [{ user_id: "u1" }, { user_id: "u2" }], error: null },
      users: {
        data: [
          { id: "u1", attributes: {}, bookable: true },
          { id: "u2", attributes: {}, bookable: true },
        ],
        error: null,
      },
      bookings: {
        data: [
          {
            assigned_user_id: "u1",
            starts_at: new Date(now).toISOString(),
            created_at: new Date(now).toISOString(),
          },
        ],
        error: null,
      },
    });
    const routing = await resolveRouting("311");
    expect(routing!.eligibleIds).toEqual(["u2", "u1"]);
    expect(routing!.routedAgentId).toBe("u2");
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });
});
