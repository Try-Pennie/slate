import { describe, it, expect, vi, beforeEach } from "vitest";

// #1641: the bucket join inside `queryBookings`, as it is wired.
//
// The bookings read above it deliberately tolerates a null result (its
// `// error-ok:` says why). The JOIN beside it does not, and the two were
// written as if they did: the join was `(await ...).data ?? []`, so a failed
// query produced an empty code map and every listed booking came back with
// `bucketCode: null`. Null there is a real value the caller reads, documented as
// "the routing trace does not record it", so a broken join turns a healthy list
// of bookings into a list nobody can say the team for.
//
// Both directions in one fixture, because a "no wrong codes were shown"
// assertion is satisfied by a fixture that lists no bookings at all (L159).

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

const resultByTable = vi.hoisted(() => new Map<string, FakeResult>());

const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "lte", "gt", "in", "order", "limit"]) {
      q[method] = () => q;
    }
    q.range = () => Promise.resolve(resultByTable.get(table) ?? { data: [], error: null });
    q.then = (resolve: (r: FakeResult) => unknown) =>
      Promise.resolve(resultByTable.get(table) ?? { data: [], error: null }).then(resolve);
    return q;
  }),
);

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { listBookings } from "@/lib/booking/service";

const QUERY = {
  status: null,
  afterStart: null,
  beforeEnd: null,
  updatedSince: null,
  bucketCode: null,
  agentEmail: null,
  limit: 50,
  offset: 0,
};

const BOOKING = {
  id: "bk-1",
  bucket_id: "b-411",
  event_type_id: "et-1",
  status: "confirmed",
  starts_at: "2026-09-01T14:00:00.000Z",
  ends_at: "2026-09-01T14:30:00.000Z",
  manage_token: "tok-1",
  external_id: null,
  attendee_name: "Dana Lee",
  attendee_email: "dana@example.com",
  attendee_phone: null,
  agent_name: null,
  agent_email: null,
  routing_trace: null,
};

describe("listBookings bucket join (wired, not injected)", () => {
  beforeEach(() => {
    resultByTable.clear();
    from.mockClear();
  });

  it("throws when the bucket join errors, rather than listing every booking with no team", async () => {
    resultByTable.set("bookings", { data: [BOOKING], error: null });
    resultByTable.set("buckets", { data: null, error: { message: "statement timeout" } });

    await expect(listBookings(QUERY)).rejects.toThrow(/queryBookings bucket join/);
  });

  // #1675: the ROW read above the join had the opposite treatment, and it is the
  // worse of the two. A failed page resolved to `[]`, so the API answered 200
  // with `bookings: []` and `nextCursor: null`, which an integrator paging the
  // list reads as "that is everything": the watermark advances past bookings
  // nobody read and they are never asked for again.
  it("throws when the bookings page itself errors, rather than reporting an empty page", async () => {
    resultByTable.set("bookings", { data: null, error: { message: "statement timeout" } });
    resultByTable.set("buckets", { data: [{ id: "b-411", code: "411" }], error: null });

    await expect(listBookings(QUERY)).rejects.toThrow(/queryBookings rows/);
  });

  // The control the refusal above needs: a page that genuinely holds nothing
  // must still come back as an empty page, not as a failure (L159).
  it("reports a genuinely empty page as an empty page", async () => {
    resultByTable.set("bookings", { data: [], error: null });

    const res = await listBookings(QUERY);
    expect(res.items).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });

  it("still tags each booking with its bucket code when the join reads", async () => {
    resultByTable.set("bookings", { data: [BOOKING], error: null });
    resultByTable.set("buckets", { data: [{ id: "b-411", code: "411" }], error: null });

    const res = await listBookings(QUERY);
    expect(res.items.map((i) => i.bucketCode)).toEqual(["411"]);
  });
});
