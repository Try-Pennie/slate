import { describe, it, expect, vi, beforeEach } from "vitest";

// #2417: the one place the cal.com override dual-write is started from.
//
// A date's overrides are derived from EVERY approved absence touching it, so the
// read of the agent's other approved absences is load bearing: a short or failed
// read hands cal.com back hours another absence is holding, and cal.com is still
// taking every real booking until cutover. The behaviour pinned here is that a
// failed read WRITES NOTHING (L214, L211), and that the set handed to the client
// excludes the request being written so ordering cannot double-count it.

type Row = { starts_at: string; ends_at: string };

const state = vi.hoisted(() => ({
  rows: [] as { starts_at: string; ends_at: string }[],
  error: null as { message: string } | null,
  filters: [] as [string, unknown][],
}));

const range = vi.hoisted(() => vi.fn());
const add = vi.hoisted(() => vi.fn(async () => "ok"));
const remove = vi.hoisted(() => vi.fn(async () => "ok"));

vi.mock("@/lib/calcom/client", () => ({
  addOooOverrides: add,
  removeOooOverrides: remove,
}));
// #2875: the "cal.com retired" switch. Only its read is replaced.
const retired = vi.hoisted(() => ({ load: vi.fn(async (): Promise<boolean | null> => false) }));
vi.mock("@/lib/calcom/retirement", async (orig) => ({
  ...(await orig<typeof import("@/lib/calcom/retirement")>()),
  loadCalcomRetired: retired.load,
}));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          state.filters.push([col, val]);
          return chain;
        },
        neq: (col: string, val: unknown) => {
          state.filters.push([`neq:${col}`, val]);
          return chain;
        },
        lt: (col: string, val: unknown) => {
          state.filters.push([`lt:${col}`, val]);
          return chain;
        },
        gt: (col: string, val: unknown) => {
          state.filters.push([`gt:${col}`, val]);
          return chain;
        },
        order: () => chain,
        range: (from: number, to: number) => {
          range(from, to);
          return Promise.resolve(
            state.error
              ? { data: null, error: state.error }
              : // A fixture row naming no primary key is given one: a paged read cuts its
                // next page on it (keyset paging, 2026-10-25).
                { data: state.rows.map((r, i) => ({ id: `ooo-${i}`, ...r })), error: null },
          );
        },
      };
      return chain;
    },
  }),
}));

import { syncCalcomOverrides } from "./calcom-sync";
import { OUTCOME_CALCOM_RETIRED } from "@/lib/calcom/outcomes";

const ARGS = {
  requestId: "req-1",
  agentUserId: "user-1",
  agentEmail: "agent@trypennie.com",
  startIso: "2026-08-07T17:00:00Z",
  endIso: "2026-08-07T21:00:00Z",
};

const other: Row = { starts_at: "2026-08-07T13:00:00Z", ends_at: "2026-08-07T16:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.error = null;
  state.filters = [];
  retired.load.mockResolvedValue(false);
});

describe("the cal.com override write refuses a set it could not measure (#2417)", () => {
  it("writes NOTHING when the other approved absences cannot be read", async () => {
    state.error = { message: "connection reset" };
    const outcome = await syncCalcomOverrides({ mode: "add", ...ARGS });
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("could not be read");
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses a removal the same way, rather than clearing the date from a short read", async () => {
    // The dangerous direction: a removal computed from an empty set gives the
    // whole working day back, including hours a second absence still holds.
    state.error = { message: "statement timeout" };
    const outcome = await syncCalcomOverrides({ mode: "remove", ...ARGS });
    expect(outcome).toMatch(/^failed/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses an unreadable window without reading anything at all", async () => {
    const outcome = await syncCalcomOverrides({
      ...ARGS,
      mode: "add",
      startIso: "not-a-timestamp",
    });
    expect(outcome).toMatch(/^failed/);
    expect(range).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("hands the client every OTHER approved absence, and excludes this request", async () => {
    state.rows = [other];
    const outcome = await syncCalcomOverrides({ mode: "add", ...ARGS });
    expect(outcome).toBe("ok");
    expect(add).toHaveBeenCalledWith(ARGS.agentEmail, ARGS.startIso, ARGS.endIso, [
      { startIso: other.starts_at, endIso: other.ends_at },
    ]);
    // Only approved rows, only this agent, and never this request itself: the
    // request's own window is supplied by the caller, so counting the stored row
    // as well would depend on whether the status transition had committed yet.
    expect(state.filters).toContainEqual(["user_id", "user-1"]);
    expect(state.filters).toContainEqual(["status", "approved"]);
    expect(state.filters).toContainEqual(["neq:id", "req-1"]);
  });

  it("passes an empty set through as a measured answer, not as a refusal", async () => {
    state.rows = [];
    expect(await syncCalcomOverrides({ mode: "remove", ...ARGS })).toBe("ok");
    expect(remove).toHaveBeenCalledWith(ARGS.agentEmail, ARGS.startIso, ARGS.endIso, []);
  });

  it("looks a day either side of the window, because the schedule's zone is not known yet", async () => {
    state.rows = [];
    await syncCalcomOverrides({ mode: "add", ...ARGS });
    const upper = state.filters.find(([k]) => k === "lt:starts_at")?.[1] as string;
    const lower = state.filters.find(([k]) => k === "gt:ends_at")?.[1] as string;
    expect(Date.parse(upper) - Date.parse(ARGS.endIso)).toBe(24 * 60 * 60 * 1000);
    expect(Date.parse(ARGS.startIso) - Date.parse(lower)).toBe(24 * 60 * 60 * 1000);
  });
});

// #2875: every writer of a cal.com override starts here (the approval, the
// cancellation, the narrowing edit, the admin Retry and the monitor lane's sweep),
// so this is the one place retiring cal.com can stop them all.
describe("the cal.com retired switch (#2875)", () => {
  it("writes nothing to cal.com once it is retired, and records its own skip", async () => {
    retired.load.mockResolvedValue(true);
    state.rows = [other];
    for (const mode of ["add", "remove"] as const) {
      const outcome = await syncCalcomOverrides({ mode, ...ARGS });
      expect(outcome).toBe(OUTCOME_CALCOM_RETIRED);
    }
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(range).not.toHaveBeenCalled();
  });

  it("keeps writing when the setting could not be read, so a failed read never unprotects an absence", async () => {
    retired.load.mockResolvedValue(null);
    state.rows = [];
    expect(await syncCalcomOverrides({ mode: "add", ...ARGS })).toBe("ok");
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("writes as today while cal.com is live", async () => {
    state.rows = [];
    expect(await syncCalcomOverrides({ mode: "remove", ...ARGS })).toBe("ok");
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
