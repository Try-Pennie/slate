import { describe, it, expect, vi, beforeEach } from "vitest";

// #3381: the database half of the served versus confirm check. Every read must THROW
// on failure (an empty pool list or marker set would read as nothing to judge and
// let the check clear a condition still true), the markers must round trip, and the
// judge must be the confirm's own candidate read over the confirm's own ladder read.

const db = vi.hoisted(() => ({
  rows: [] as { key: string; last_sent_at: string }[],
  readError: null as { message: string } | null,
  writeError: null as { message: string } | null,
  calls: [] as { op: string; args: unknown[] }[],
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      select: (cols: string) => ({
        like: (col: string, pattern: string) => ({
          limit: async (n: number) => {
            db.calls.push({ op: "select", args: [table, cols, col, pattern, n] });
            return db.readError ? { data: null, error: db.readError } : { data: db.rows.slice(0, n), error: null };
          },
        }),
      }),
      upsert: async (values: unknown, opts: unknown) => {
        db.calls.push({ op: "upsert", args: [table, values, opts] });
        return { error: db.writeError };
      },
      delete: () => ({
        eq: async (col: string, val: unknown) => {
          db.calls.push({ op: "delete", args: [table, col, val] });
          return { error: db.writeError };
        },
      }),
    }),
  }),
}));
const precompute = vi.hoisted(() => ({ listPoolBuckets: vi.fn(async (): Promise<unknown[]> => []) }));
vi.mock("@/lib/availability/precompute", () => precompute);
const service = vi.hoisted(() => ({
  roundRobinCandidates: vi.fn(async (..._a: unknown[]) => ({ candidates: ["a", "b"], memberCount: 74 })),
}));
vi.mock("@/lib/availability/service", () => service);
const ladder = vi.hoisted(() => ({
  bucket: vi.fn((_code: string): unknown => ({ bucket: { id: "b-112", code: "112" }, eventType: { id: "e-1" } })),
}));
const ladderLive = vi.hoisted(() => ({ readLadderInputsLive: vi.fn(async (..._a: unknown[]) => ladder) }));
vi.mock("@/lib/availability/ladder-inputs-live", () => ladderLive);

import {
  loadRealPools,
  readOfferedSuspects,
  markOfferedSuspect,
  clearOfferedSuspect,
  judgeOfferedTime,
} from "./offered-nobody-free-live";
import { MAX_JUDGMENTS_PER_TICK } from "./offered-nobody-free";

const T1630 = Date.parse("2026-10-14T20:30:00.000Z");
const SEEN = "2026-10-14T08:46:00.000Z";
const EVENT = { duration_min: 20, buffer_before_min: 10, buffer_after_min: 10 };

beforeEach(() => {
  vi.clearAllMocks();
  db.rows = [];
  db.readError = null;
  db.writeError = null;
  db.calls = [];
});

function pooled(code: string, team: string, isTest = false) {
  return {
    code,
    bucket: { id: `id-${code}`, code, is_test: isTest },
    orgId: "org-1",
    eventTypeId: "event-1",
    criteria: { debt_team: team },
    fallbackUserId: null,
    memberIds: [],
  };
}

describe("loadRealPools", () => {
  it("groups the real buckets by pool and leaves the test buckets out", async () => {
    precompute.listPoolBuckets.mockResolvedValueOnce([
      pooled("112", "low"),
      pooled("111", "low"),
      pooled("212", "mid"),
      pooled("SMOKE", "smoke", true),
    ]);
    expect(await loadRealPools()).toEqual([["111", "112"], ["212"]]);
  });

  it("throws when the pools cannot be read, never answering an empty list", async () => {
    precompute.listPoolBuckets.mockRejectedValueOnce(new Error("bucket_members read failed"));
    await expect(loadRealPools()).rejects.toThrow("bucket_members read failed");
  });
});

describe("the remembered times", () => {
  it("round trips a marker: written, read back, and cleared by the same key", async () => {
    await markOfferedSuspect("112", T1630, Date.parse(SEEN));
    const upsert = db.calls.find((c) => c.op === "upsert")!;
    const values = upsert.args[1] as { key: string; last_sent_at: string };
    expect(values).toEqual({ key: "offered_nobody_free_seen:112@2026-10-14T20:30:00.000Z", last_sent_at: SEEN });

    db.rows = [values];
    expect(await readOfferedSuspects()).toEqual([{ code: "112", startMs: T1630, firstSeenMs: Date.parse(SEEN) }]);

    await clearOfferedSuspect("112", T1630);
    expect(db.calls.find((c) => c.op === "delete")!.args).toEqual(["alert_state", "key", values.key]);
  });

  it("ignores a key the LIKE pattern matched only through its underscore wildcards", async () => {
    db.rows = [{ key: "offeredXnobody_free_seen:112@2026-10-14T20:30:00.000Z", last_sent_at: SEEN }];
    expect(await readOfferedSuspects()).toEqual([]);
  });

  it("throws on a failed read, never answering 'none remembered'", async () => {
    db.readError = { message: "permission denied" };
    await expect(readOfferedSuspects()).rejects.toThrow("permission denied");
  });

  it("throws on a marker it cannot read, rather than dropping it", async () => {
    db.rows = [{ key: "offered_nobody_free_seen:112@not-a-time", last_sent_at: SEEN }];
    await expect(readOfferedSuspects()).rejects.toThrow("cannot be read");
  });

  it("throws when the read comes back at its limit, since the set may then be partial", async () => {
    db.rows = Array.from({ length: MAX_JUDGMENTS_PER_TICK * 4 }, (_, i) => ({
      key: `offered_nobody_free_seen:112@${new Date(T1630 + i * 60_000).toISOString()}`,
      last_sent_at: SEEN,
    }));
    await expect(readOfferedSuspects()).rejects.toThrow("may be partial");
  });

  it("throws when a marker cannot be written or cleared", async () => {
    db.writeError = { message: "statement timeout" };
    await expect(markOfferedSuspect("112", T1630, Date.parse(SEEN))).rejects.toThrow("statement timeout");
    await expect(clearOfferedSuspect("112", T1630)).rejects.toThrow("statement timeout");
  });
});

describe("judgeOfferedTime", () => {
  it("is the confirm's own candidate read, over the confirm's own ladder read, for that code and time", async () => {
    const j = await judgeOfferedTime("112", T1630, EVENT);
    expect(ladderLive.readLadderInputsLive).toHaveBeenCalledWith(["112"], "2026-10-14T20:30:00.000Z", EVENT);
    expect(service.roundRobinCandidates).toHaveBeenCalledWith(
      { id: "b-112", code: "112" },
      { id: "e-1" },
      T1630,
      true,
      undefined,
      false,
      { inputs: ladder },
    );
    expect(j).toEqual({ free: 2, members: 74 });
  });

  it("answers null for a code the ladder has no bucket for", async () => {
    ladder.bucket.mockReturnValueOnce(null);
    expect(await judgeOfferedTime("999", T1630, EVENT)).toBeNull();
    expect(service.roundRobinCandidates).not.toHaveBeenCalled();
  });

  it("lets a failed ladder read throw, which the check counts as unreadable, never as free", async () => {
    ladderLive.readLadderInputsLive.mockRejectedValueOnce(new Error("ladder candidate inputs: refused"));
    await expect(judgeOfferedTime("112", T1630, EVENT)).rejects.toThrow("refused");
  });
});
