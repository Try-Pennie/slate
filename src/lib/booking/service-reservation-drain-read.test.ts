import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The reservation drain's read (`loadDrainableReservations`), against a fake
// PostgREST builder that APPLIES the filters it is given to a fixed set of rows,
// so the test asks what the drain would be handed rather than which methods were
// called.
//
// #3466: a reservation is written by a lead's live confirm and used to be
// drainable the moment it existed, so the every minute drain could lease and
// complete (or roll back) a row the confirm that wrote it was still completing.
// It now waits until the row is older than the longest a confirm can still be
// working on it (`RESERVATION_DRAIN_MIN_AGE_MS`).
//
// The swallowed read: a failed read used to log and return [], which reads as an
// empty drain. Nothing then reached the stuck alert or the lane's failing streak,
// so a read failing on every tick looked like a quiet table. It throws now, and
// the outbox lane counts the throw toward `reservation_drain_failing`.

type Row = { id: string; status: string; attempts: number; created_at: string };

const state = vi.hoisted(() => ({
  rows: [] as { id: string; status: string; attempts: number; created_at: string }[],
  readError: null as { message: string } | null,
  createdAtBounds: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const filters: ((r: Row) => boolean)[] = [];
      const read: Record<string, unknown> = {};
      read.select = () => read;
      read.eq = (col: keyof Row, v: unknown) => (filters.push((r) => r[col] === v), read);
      read.lt = (col: keyof Row, v: unknown) => {
        if (col === "created_at") state.createdAtBounds.push(String(v));
        filters.push((r) =>
          col === "created_at" ? Date.parse(r.created_at) < Date.parse(String(v)) : (r[col] as number) < (v as number),
        );
        return read;
      };
      // The lease and retry time filters: every fixture row has neither set.
      read.or = () => read;
      read.order = () => read;
      read.limit = async (n: number) =>
        state.readError
          ? { data: null, error: state.readError }
          : { data: state.rows.filter((r) => filters.every((f) => f(r))).slice(0, n), error: null };
      return read;
    },
  }),
}));

import { realDeps, RESERVATION_DRAIN_MIN_AGE_MS } from "./service";
import { BOOKING_CONFIRM_WORST_CASE_MS } from "./confirm-budget";
import { REQUEST_TIMEOUT_MS } from "@/lib/http";

const NOW = Date.parse("2026-10-16T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (id: string, ageMs: number): Row => ({ id, status: "pending", attempts: 0, created_at: ago(ageMs) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state.rows = [];
  state.readError = null;
  state.createdAtBounds = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("loadDrainableReservations waits out a live confirm (#3466)", () => {
  it("does not hand the drain a reservation a confirm wrote moments ago", async () => {
    state.rows = [row("fresh", 1_000)];
    expect(await realDeps().loadDrainableReservations(15)).toEqual([]);
  });

  it("does not hand over one still inside a confirm's worst case", async () => {
    state.rows = [row("in-flight", BOOKING_CONFIRM_WORST_CASE_MS)];
    expect(await realDeps().loadDrainableReservations(15)).toEqual([]);
  });

  it("CONTROL: hands over one older than the bound, which no live confirm can still hold", async () => {
    state.rows = [row("fresh", 1_000), row("crashed", RESERVATION_DRAIN_MIN_AGE_MS + 1_000)];
    const got = await realDeps().loadDrainableReservations(15);
    expect(got.map((r) => r.id)).toEqual(["crashed"]);
  });

  it("bounds the read on created_at at exactly the minimum age", async () => {
    await realDeps().loadDrainableReservations(15);
    expect(state.createdAtBounds).toEqual([ago(RESERVATION_DRAIN_MIN_AGE_MS)]);
  });

  it("the bound is derived to clear the whole confirm, not only its budgeted calls", () => {
    // The confirm's worst case counts only time spent waiting on calls; the design
    // leaves the rest of the booker's 20 seconds for computation the budget cannot
    // see. The bound must clear both, or a slow confirm is still raced.
    expect(RESERVATION_DRAIN_MIN_AGE_MS).toBeGreaterThan(BOOKING_CONFIRM_WORST_CASE_MS);
    expect(RESERVATION_DRAIN_MIN_AGE_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    // And it stays under one tick of the every minute drain, so a reservation a
    // crash left behind is still resumed on the next tick but one.
    expect(RESERVATION_DRAIN_MIN_AGE_MS).toBeLessThan(60_000);
  });
});

describe("loadDrainableReservations fails loud", () => {
  it("throws on a failed read rather than reading as an empty drain", async () => {
    state.rows = [row("crashed", RESERVATION_DRAIN_MIN_AGE_MS + 1_000)];
    state.readError = { message: "canceling statement due to statement timeout" };
    await expect(realDeps().loadDrainableReservations(15)).rejects.toThrow(/statement timeout/);
  });
});
