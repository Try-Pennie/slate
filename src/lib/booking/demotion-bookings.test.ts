import { describe, it, expect, vi, beforeEach } from "vitest";

// #3582: the IO wrappers demotionBookings (the FILTERED snapshot) and rerouteCandidatesForAgent
// (the full candidate list for the decision). Supabase is mocked, so this exercises the reads and
// the join, in particular that demotionBookings filters by the PASSED attributes and never reads
// the users table for them: when a sweep coincides with a tier change the narrowed attributes are
// not written yet, so re-reading would filter against the agent's old eligibility (the finding this
// locks). The pure join and fail-safes are node-tested in test-demotion-snapshot.ts.

type Row = Record<string, unknown>;
const tables = vi.hoisted(() => ({ data: {} as Record<string, Row[]>, from: [] as string[] }));

function chain(rows: Row[]) {
  const self: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gt", "lt", "order", "not"]) self[m] = () => self;
  self.range = async () => ({ data: rows, error: null });
  // Thenable, so an awaited list read (buckets, bucket_members) resolves to the rows.
  self.then = (resolve: (v: { data: Row[]; error: null }) => void) => resolve({ data: rows, error: null });
  return self;
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      tables.from.push(table);
      return chain(tables.data[table] ?? []);
    },
  }),
}));

import { demotionBookings, rerouteCandidatesForAgent } from "./bulk-reassign-store";

const START = "2026-10-01T09:00:00.000Z";

beforeEach(() => {
  tables.from.length = 0;
  tables.data = {
    bookings: [
      { id: "uh1", starts_at: START, ends_at: START, attendee_name: "A", bucket_id: "b-uh", kind: "round_robin" },
      { id: "hi1", starts_at: START, ends_at: START, attendee_name: "B", bucket_id: "b-hi", kind: "round_robin" },
    ],
    buckets: [
      { id: "b-uh", criteria: { debt_team: "ultra_high" } },
      { id: "b-hi", criteria: { debt_team: "high" } },
    ],
    bucket_members: [],
  };
});

describe("demotionBookings", () => {
  it("filters to the bookings the agent no longer serves under the PASSED attributes", async () => {
    // Demoted to high: the ultra_high booking is lost, the high one kept.
    const out = await demotionBookings("u1", START, null, { debt_team: ["high"] });
    expect(out.map((r) => r.id)).toEqual(["uh1"]);
  });

  it("does NOT read the users table (attributes come from the argument, not a fresh read)", async () => {
    await demotionBookings("u1", START, null, { debt_team: ["high"] });
    expect(tables.from).not.toContain("users");
    expect(tables.from).toContain("bookings");
    expect(tables.from).toContain("buckets");
  });

  it("moves nobody for a null (unknown) attribute set", async () => {
    const out = await demotionBookings("u1", START, null, null);
    expect(out).toEqual([]);
  });

  it("still serves everything when the agent keeps both tiers", async () => {
    const out = await demotionBookings("u1", START, null, { debt_team: ["ultra_high", "high"] });
    expect(out).toEqual([]);
  });
});

describe("a call an admin moved back (#3615)", () => {
  it("is read from the sweep items and left out of both the snapshot and the decision", async () => {
    tables.data.bulk_reassign_items = [{ id: "i1", booking_id: "uh1", reverted_at: "2026-10-12T14:00:00.000Z", bulk_reassign_jobs: { out_user_id: "u1" } }];
    expect(await demotionBookings("u1", START, null, { debt_team: ["high"] })).toEqual([]);
    expect((await rerouteCandidatesForAgent("u1", START, null)).map((c) => c.bookingId)).toEqual(["hi1"]);
    expect(tables.from).toContain("bulk_reassign_items");
  });
});

describe("rerouteCandidatesForAgent", () => {
  it("returns every held booking as a candidate, with criteria and kind joined", async () => {
    const out = await rerouteCandidatesForAgent("u1", START, null);
    expect(out.map((c) => c.bookingId).sort()).toEqual(["hi1", "uh1"]);
    const uh = out.find((c) => c.bookingId === "uh1");
    expect(uh?.criteria).toEqual({ debt_team: "ultra_high" });
    expect(uh?.kind).toBe("round_robin");
  });
});
