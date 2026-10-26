import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient } from "@supabase/supabase-js";

// #4238 made selectAllPages page by keyset and refuse a query that orders itself, but only a
// REAL PostgREST builder carries the `url` that refusal reads; the hand written chain fakes in
// bulk-reassign-store.test.ts have none, so every suite stayed green while all three reads built
// on applyUpcomingWindow (which ordered by starts_at) threw in production on every call: the
// demotion reroute, the coverage sweep snapshot and the offboarding invite clear (2026-10-26).
//
// So these run the real reads through a real supabase-js client whose fetch is faked: the
// builder, its URL and the refusal are the production ones, and only the network is not.

type Row = Record<string, unknown>;

/** The bookings the fake server returns, in the KEY order keyset paging asks for (id), with
 *  starts_at deliberately running the other way, so a caller relying on the server's order
 *  for time order is caught. */
const BOOKINGS: Row[] = [
  {
    id: "a-1",
    starts_at: "2026-10-28T18:00:00Z",
    ends_at: "2026-10-28T18:30:00Z",
    attendee_name: null,
    bucket_id: "b-1",
    kind: "regular",
    gcal_event_id: "ev-1",
  },
  {
    id: "b-2",
    starts_at: "2026-10-27T14:00:00Z",
    ends_at: "2026-10-27T14:30:00Z",
    attendee_name: null,
    bucket_id: "b-1",
    kind: "regular",
    gcal_event_id: "ev-2",
  },
];

const requested: URL[] = [];

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  requested.push(url);
  const table = url.pathname.split("/").pop();
  const body = table === "bookings" ? BOOKINGS : table === "buckets" ? [{ id: "b-1", criteria: null }] : [];
  return Promise.resolve(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

const client = createClient("https://example.supabase.co", "test-key", {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fakeFetch as typeof fetch },
});

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => client }));

const { coverageBookings, coverageInvites, rerouteCandidatesForAgent } = await import("./bulk-reassign-store");

const NOW = new Date().toISOString();

function bookingsRequests(): URL[] {
  return requested.filter((u) => u.pathname.endsWith("/bookings"));
}

beforeEach(() => {
  requested.length = 0;
});

describe("the upcoming window reads survive the real keyset pager (#4238)", () => {
  it("reads a coverage sweep's bookings, ordered by the pager's key alone", async () => {
    await coverageBookings("user-1", NOW, null);
    const reqs = bookingsRequests();
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.searchParams.getAll("order")).toEqual(["id.asc"]);
    expect(reqs[0]!.searchParams.get("assigned_user_id")).toBe("eq.user-1");
  });

  it("still hands the sweep its bookings in time order, sorted after the read", async () => {
    const rows = await coverageBookings("user-1", NOW, null);
    expect(rows.map((r) => r.id)).toEqual(["b-2", "a-1"]);
  });

  it("reads the invites an offboarding clears", async () => {
    const rows = await coverageInvites("user-1", NOW);
    expect(rows.map((r) => r.gcal_event_id).sort()).toEqual(["ev-1", "ev-2"]);
    expect(bookingsRequests()[0]!.searchParams.getAll("order")).toEqual(["id.asc"]);
  });

  it("reads the demotion trigger's candidates for an agent whose tiers changed", async () => {
    const candidates = await rerouteCandidatesForAgent("user-1", NOW, null);
    expect(candidates.length).toBe(2);
    expect(bookingsRequests()[0]!.searchParams.getAll("order")).toEqual(["id.asc"]);
  });
});
