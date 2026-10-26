import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What `userIdsOnApprovedTimeOff` actually SELECTS (#1236, pinned here for #2370).
 *
 * Two callers now rest on this one read: coverage selection refuses to place a
 * booking on somebody who is away, and the machine contact-owner reassign refuses
 * to move a call onto an owner who is. Both of those refusals are decided entirely
 * by the filters below, so "approved only" and "half open at both ends" are the
 * behaviour, not an implementation detail of the query: leave that merely abuts an
 * appointment must not block it, and a request nobody has approved must not either.
 *
 * The fake client EVALUATES the filters over fixture rows rather than recording
 * them, because asserting that `.lt("starts_at", end)` was called says nothing
 * about which rows come back. Stamps are all UTC in one format, so comparing them
 * as strings orders them exactly as Postgres orders the timestamps.
 */

type Row = { user_id: string; status: string; starts_at: string; ends_at: string };
/** A row as the table holds it, with the primary key a paged read cuts its pages on. */
type Stored = Row & { id: string };

const state = vi.hoisted(() => ({ rows: [] as Row[], failWith: null as string | null }));

const admin = vi.hoisted(() => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table !== "ooo_requests") throw new Error(`unexpected table ${table}`);
      // A fixture row naming no primary key is given one by its position: a paged
      // read cuts each later page on it (keyset paging, 2026-10-25).
      let rows: Stored[] = state.rows.map((r, i) => ({ id: `ooo-${String(i).padStart(6, "0")}`, ...r }));
      const builder = {
        select: () => builder,
        in: (col: keyof Stored, vals: string[]) => {
          rows = rows.filter((r) => vals.includes(r[col]));
          return builder;
        },
        eq: (col: keyof Stored, val: string) => {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        lt: (col: keyof Stored, val: string) => {
          rows = rows.filter((r) => r[col] < val);
          return builder;
        },
        gt: (col: keyof Stored, val: string) => {
          rows = rows.filter((r) => r[col] > val);
          return builder;
        },
        // Deliberately NO lte/gte: the read is half open on both sides, and a fake
        // that answers the inclusive spellings would let that change go unnoticed.
        order: () => builder,
        range: (from: number, to: number) =>
          Promise.resolve(
            state.failWith
              ? { data: null, error: { message: state.failWith } }
              : { data: rows.slice(from, to + 1), error: null },
          ),
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => admin);

import { userIdsOnApprovedTimeOff } from "./approved-overlap";

// The appointment under test: half an hour, and the two windows that touch it.
const START = "2026-09-20T15:00:00.000Z";
const END = "2026-09-20T15:30:00.000Z";

const row = (over: Partial<Row>): Row => ({
  user_id: "owner-1",
  status: "approved",
  starts_at: "2026-09-20T14:00:00.000Z",
  ends_at: "2026-09-20T16:00:00.000Z",
  ...over,
});

beforeEach(() => {
  state.rows = [];
  state.failWith = null;
});

describe("userIdsOnApprovedTimeOff", () => {
  it("reports somebody whose approved leave covers the appointment", async () => {
    state.rows = [row({})];
    expect([...(await userIdsOnApprovedTimeOff(["owner-1"], START, END))]).toEqual(["owner-1"]);
  });

  it("reports leave that overlaps by a single minute", async () => {
    state.rows = [row({ starts_at: "2026-09-20T15:29:00.000Z", ends_at: "2026-09-20T15:31:00.000Z" })];
    expect((await userIdsOnApprovedTimeOff(["owner-1"], START, END)).has("owner-1")).toBe(true);
  });

  it("does NOT report leave ending exactly when the appointment starts", async () => {
    state.rows = [row({ starts_at: "2026-09-20T09:00:00.000Z", ends_at: START })];
    expect((await userIdsOnApprovedTimeOff(["owner-1"], START, END)).size).toBe(0);
  });

  it("does NOT report leave starting exactly when the appointment ends", async () => {
    state.rows = [row({ starts_at: END, ends_at: "2026-09-20T18:00:00.000Z" })];
    expect((await userIdsOnApprovedTimeOff(["owner-1"], START, END)).size).toBe(0);
  });

  it.each(["pending", "rejected", "cancelled"])(
    "does NOT report a %s request, however well it overlaps",
    async (status) => {
      state.rows = [row({ status })];
      expect((await userIdsOnApprovedTimeOff(["owner-1"], START, END)).size).toBe(0);
    },
  );

  it("does not answer about anybody who was not asked about", async () => {
    state.rows = [row({ user_id: "someone-else" })];
    expect((await userIdsOnApprovedTimeOff(["owner-1"], START, END)).size).toBe(0);
  });

  it("asks nothing when there is nobody to ask about", async () => {
    state.rows = [row({})];
    expect((await userIdsOnApprovedTimeOff([], START, END)).size).toBe(0);
  });

  it("THROWS on a failed read rather than answering that nobody is away", async () => {
    state.rows = [row({})];
    state.failWith = "connection terminated unexpectedly";
    await expect(userIdsOnApprovedTimeOff(["owner-1"], START, END)).rejects.toThrow(
      /connection terminated/,
    );
  });
});
