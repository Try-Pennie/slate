import { describe, it, expect, vi, beforeEach } from "vitest";

// #1169: a lane_heartbeats row that EXISTS but whose last_ran_at cannot be
// parsed must read as infinitely old (epoch 0 -> stale), never as null.
// Null means "never stamped", which every consumer (findStaleLanes,
// computeHealthStatus, the canary trigger) deliberately treats as a fresh
// deploy and stays quiet about, so mapping a corrupt stamp to null silently
// disabled the dead-man's switch for that lane.

const rows = vi.hoisted(() => ({ value: [] as { lane: string; last_ran_at: string }[] }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      // The bulk read awaits select() directly; the single read chains
      // .eq().maybeSingle(). One thenable-with-eq mock serves both.
      select: () =>
        Object.assign(Promise.resolve({ data: rows.value, error: null }), {
          eq: (_col: string, lane: string) => ({
            maybeSingle: async () => {
              const row = rows.value.find((r) => r.lane === lane) ?? null;
              return { data: row ? { last_ran_at: row.last_ran_at } : null, error: null };
            },
          }),
        }),
    }),
  }),
}));

import { readAllHeartbeatMs, readHeartbeatMs } from "./heartbeat";

beforeEach(() => {
  rows.value = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("readAllHeartbeatMs on a corrupt stamp (#1169)", () => {
  it("maps an unparseable last_ran_at to 0 (stale), never to null (never-stamped)", async () => {
    rows.value = [{ lane: "sync", last_ran_at: "not-a-timestamp" }];
    const out = await readAllHeartbeatMs();
    expect(out.sync).toBe(0);
  });

  it("still parses a healthy stamp to its epoch ms", async () => {
    const iso = "2026-07-29T12:00:00.000Z";
    rows.value = [{ lane: "sync", last_ran_at: iso }];
    const out = await readAllHeartbeatMs();
    expect(out.sync).toBe(Date.parse(iso));
  });
});

describe("readHeartbeatMs on a corrupt stamp (#1169)", () => {
  it("returns 0 (stale) for an unparseable last_ran_at, null only for a missing row", async () => {
    rows.value = [{ lane: "smoke-canary", last_ran_at: "garbage" }];
    expect(await readHeartbeatMs("smoke-canary")).toBe(0);
    expect(await readHeartbeatMs("no-such-lane")).toBe(null);
  });

  it("still parses a healthy stamp to its epoch ms", async () => {
    const iso = "2026-07-29T12:00:00.000Z";
    rows.value = [{ lane: "smoke-canary", last_ran_at: iso }];
    expect(await readHeartbeatMs("smoke-canary")).toBe(Date.parse(iso));
  });
});
