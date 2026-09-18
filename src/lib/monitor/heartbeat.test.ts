import { describe, it, expect, vi, beforeEach } from "vitest";

// #1169: a lane_heartbeats row that EXISTS but whose last_ran_at cannot be
// parsed must read as infinitely old (epoch 0 -> stale), never as null.
// Null means "never stamped", which every consumer (findStaleLanes,
// computeHealthStatus, the canary trigger) deliberately treats as a fresh
// deploy and stays quiet about, so mapping a corrupt stamp to null silently
// disabled the dead-man's switch for that lane.

const rows = vi.hoisted(() => ({
  value: [] as { lane: string; last_ran_at: string }[],
  /** Set to make the read come back as a real database error (#2543). */
  error: null as { message: string } | null,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      // The bulk read awaits select() directly; the single read chains
      // .eq().maybeSingle(). One thenable-with-eq mock serves both.
      select: () =>
        Object.assign(Promise.resolve({ data: rows.value, error: rows.error }), {
          eq: (_col: string, lane: string) => ({
            maybeSingle: async () => {
              if (rows.error) return { data: null, error: rows.error };
              const row = rows.value.find((r) => r.lane === lane) ?? null;
              return { data: row ? { last_ran_at: row.last_ran_at } : null, error: null };
            },
          }),
        }),
    }),
  }),
}));

import { readAllHeartbeatMs, readHeartbeatMs, readHeartbeatMsStrict } from "./heartbeat";

beforeEach(() => {
  rows.value = [];
  rows.error = null;
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

  // THE FAILURE PATH the watermark reader cares about (#2543). For a WATCHDOG a
  // failed read must be silent, which is what the function above does. For a
  // caller that uses the stamp as a watermark, null means "start from yesterday",
  // so the same silence would narrow the catch-up and then move the mark past the
  // days it skipped.
  it("reads a failed query as null, which is the answer a watermark must not get", async () => {
    rows.error = { message: "connection reset" };
    expect(await readHeartbeatMs("ooo-approvals-report")).toBe(null);
  });
});

describe("readHeartbeatMsStrict as a watermark read (#2543)", () => {
  it("THROWS on a read failure instead of answering never-stamped", async () => {
    rows.error = { message: "connection reset" };
    await expect(readHeartbeatMsStrict("ooo-approvals-report")).rejects.toThrow(/connection reset/);
  });

  it("still answers null for a row that genuinely does not exist", async () => {
    expect(await readHeartbeatMsStrict("ooo-approvals-report")).toBe(null);
  });

  it("keeps the epoch 0 sentinel for a stamp that cannot be parsed", async () => {
    rows.value = [{ lane: "ooo-approvals-report", last_ran_at: "garbage" }];
    expect(await readHeartbeatMsStrict("ooo-approvals-report")).toBe(0);
  });

  it("parses a healthy stamp to its epoch ms", async () => {
    const iso = "2026-07-29T12:00:00.000Z";
    rows.value = [{ lane: "ooo-approvals-report", last_ran_at: iso }];
    expect(await readHeartbeatMsStrict("ooo-approvals-report")).toBe(Date.parse(iso));
  });
});
