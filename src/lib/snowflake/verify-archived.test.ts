// Tests for the archive verifier (#1102), the control that makes a permanent
// delete safe: before a retention lane destroys a row, the warehouse must be
// shown to hold that SPECIFIC row at a version no older than Supabase's.
//
// The export watermark cannot do this job. A lane deletes rows older than 30 days
// / 90 days / 12 months and compares them against a watermark that is minutes
// old, so the watermark predicate is satisfied by every candidate it will ever
// see. It is shaped like a gate and cannot fail.
//
// The load-bearing property is that the failure states stay DISTINCT (L11): a
// warehouse read that failed, a row the warehouse lacks, and a row whose
// warehouse copy is older are three different things. Collapsing any of them into
// "not archived" turns a broken read into a confident-looking answer.
//
// This is vitest rather than a node script because the module imports the
// Snowflake client, which the node runner cannot resolve (same reason merge.ts is
// tested here). Only executeStatement is stubbed; escapeSqlLiteral stays REAL, so
// the injection assertions test the shipping escaper and not a mock of it.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  executeStatement: vi.fn(),
}));

import {
  MAX_VERIFY_BATCH,
  buildVerifySql,
  classifyVerifyRows,
  destroyVerified,
  verifyArchived,
  type Candidate,
  type VerifyOutcome,
  type VerifyVerdict,
} from "./verify-archived";
import { readSnowflakeConfig } from "./config";
import { executeStatement } from "./client";

const cands: Candidate[] = [
  { id: "11111111-1111-4111-8111-111111111111", watermark: "2026-06-01T00:00:00.000Z" },
  { id: "22222222-2222-4222-8222-222222222222", watermark: "2026-06-02T00:00:00.000Z" },
  { id: "33333333-3333-4333-8333-333333333333", watermark: "2026-06-03T00:00:00.000Z" },
];

const cfg = {
  account: "a",
  user: "u",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "SLATE_WH",
  role: "SLATE_ROLE",
};

afterEach(() => vi.resetAllMocks());

describe("buildVerifySql", () => {
  const sql = buildVerifySql("booking_outbox", "updated_at", cands);

  it("left-joins the mirror so an absent row still comes back with a verdict", () => {
    expect(sql).toContain("LEFT JOIN booking_outbox t");
    expect(sql).toContain("t.id IS NOT NULL AS present");
  });

  it("compares the watermark inside Snowflake, where both timestamp types are known", () => {
    // A TIMESTAMP_TZ read back through the SQL API is not an ISO string, so a
    // JS-side compare would be a silent-offset bug.
    expect(sql).toContain("t.updated_at >= TO_TIMESTAMP_TZ(s.wm)");
    expect(sql).not.toContain("SELECT id FROM");
  });

  it("names every candidate and carries its Supabase watermark", () => {
    for (const c of cands) expect(sql).toContain(c.id);
    expect(sql).toContain("'2026-06-01T00:00:00.000Z'");
  });

  it("escapes a quote in an id so it cannot break out of the literal", () => {
    const evil = buildVerifySql("bookings", "updated_at", [{ id: "a'b", watermark: "2026-01-01T00:00:00Z" }]);
    expect(evil).toContain("'a''b'");
  });

  it("refuses an empty batch and an oversized one", () => {
    expect(() => buildVerifySql("bookings", "updated_at", [])).toThrow(/no candidates/);
    const tooMany = Array.from({ length: MAX_VERIFY_BATCH + 1 }, (_, i) => ({
      id: `id-${i}`,
      watermark: "2026-01-01T00:00:00Z",
    }));
    expect(() => buildVerifySql("bookings", "updated_at", tooMany)).toThrow(/MAX_VERIFY_BATCH/);
  });
});

describe("classifyVerifyRows", () => {
  it("clears rows the warehouse holds at a current version", () => {
    // The SQL API returns booleans as the strings "true"/"false".
    const r = classifyVerifyRows(cands, cands.map((c) => [c.id, "true", "true"]));
    expect(r.archived).toHaveLength(3);
    expect(r.problems).toEqual([]);
  });

  it("separates a row the warehouse lacks from one whose copy is older", () => {
    const r = classifyVerifyRows(cands, [
      [cands[0].id, "true", "true"],
      [cands[1].id, "false", "false"],
      [cands[2].id, "true", "false"],
    ]);
    expect(r.archived).toEqual([cands[0].id]);
    expect(r.problems.find((p) => p.id === cands[1].id)?.state).toBe("absent");
    expect(r.problems.find((p) => p.id === cands[2].id)?.state).toBe("stale");
  });

  // The #35/#166/#277 false-empty class: the house idiom
  // `Number(res.data?.[0]?.[0] ?? 0)` would turn a shape error into a confident
  // zero. Here that would read as "the warehouse has none of these rows".
  it.each([
    ["a short answer", [[cands[0].id, "true", "true"]]],
    ["an empty answer", []],
    [
      "an answer naming an id we never asked about",
      [
        [cands[0].id, "true", "true"],
        [cands[1].id, "true", "true"],
        ["99999999-9999-4999-8999-999999999999", "true", "true"],
      ],
    ],
    [
      "a row missing its columns",
      [[cands[0].id], [cands[1].id, "true", "true"], [cands[2].id, "true", "true"]],
    ],
    [
      "a duplicated id",
      [
        [cands[0].id, "true", "true"],
        [cands[0].id, "true", "true"],
        [cands[1].id, "true", "true"],
      ],
    ],
  ])("throws rather than under-reporting on %s", (_label, rows) => {
    expect(() => classifyVerifyRows(cands, rows as unknown[][])).toThrow();
  });
});

describe("verifyArchived", () => {
  it("returns an empty outcome without calling Snowflake for an empty batch", async () => {
    const r = await verifyArchived("booking_outbox", "updated_at", []);
    expect(r).toEqual({ archived: [], problems: [] });
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("throws when the mirror is unconfigured, so it can never read as verified", async () => {
    // Returning an empty outcome here would be the dangerous alternative: a caller
    // checking `archived` sees nothing to delete and reports success.
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    await expect(verifyArchived("booking_outbox", "updated_at", cands)).rejects.toThrow(/not configured/);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("throws on a response with no data block rather than reporting nothing verified", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockResolvedValue({});
    await expect(verifyArchived("booking_outbox", "updated_at", cands)).rejects.toThrow(/no data block/);
  });

  it("propagates a warehouse read failure instead of degrading to an empty verdict", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockRejectedValue(new Error("JWT token is invalid"));
    await expect(verifyArchived("booking_outbox", "updated_at", cands)).rejects.toThrow(/JWT/);
  });

  it("clears present, current rows and names the table it asked about", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockResolvedValue({ data: cands.map((c) => [c.id, "true", "true"]) });
    const r = await verifyArchived("booking_outbox", "updated_at", cands);
    expect(r.archived).toHaveLength(3);
    const [, statement] = vi.mocked(executeStatement).mock.calls[0];
    expect(statement).toContain("LEFT JOIN booking_outbox t");
  });
});

describe("destroyVerified", () => {
  const fakeVerify =
    (archived: string[], problems: VerifyVerdict[] = []) =>
    async (): Promise<VerifyOutcome> => ({ archived, problems });

  it("does nothing and does NOT throw on an empty candidate set", async () => {
    // A quiet day, which is every day until the first retention window is crossed.
    const r = await destroyVerified({
      table: "booking_outbox",
      watermarkCol: "updated_at",
      candidates: [],
      destroy: async () => {
        throw new Error("must not be called");
      },
      verify: fakeVerify([]),
    });
    expect(r).toEqual({ candidates: 0, destroyed: 0, problems: [] });
  });

  it("destroys exactly the verified ids and leaves the rest in place", async () => {
    let sawIds: string[] = [];
    const r = await destroyVerified({
      table: "booking_outbox",
      watermarkCol: "updated_at",
      candidates: cands,
      destroy: async (ids) => {
        sawIds = ids;
        return ids.length;
      },
      verify: fakeVerify([cands[0].id, cands[2].id], [{ id: cands[1].id, state: "absent" }]),
    });
    expect(sawIds).toEqual([cands[0].id, cands[2].id]);
    expect(sawIds).not.toContain(cands[1].id);
    expect(r.destroyed).toBe(2);
    expect(r.problems).toHaveLength(1);
  });

  it("throws, and does not attempt the write, when the warehouse confirms none of them", async () => {
    // The watermark said these were archived. If the warehouse confirms nothing,
    // the watermark is lying about coverage, and "0 pruned" would hide it.
    const destroy = vi.fn(async () => 0);
    await expect(
      destroyVerified({
        table: "routing_decisions",
        watermarkCol: "created_at",
        candidates: cands,
        destroy,
        verify: fakeVerify([], cands.map((c) => ({ id: c.id, state: "absent" as const }))),
      }),
    ).rejects.toThrow(/confirmed NONE/);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("throws when rows verified but the destructive write affected none", async () => {
    await expect(
      destroyVerified({
        table: "webhook_deliveries",
        watermarkCol: "updated_at",
        candidates: cands,
        destroy: async () => 0,
        verify: fakeVerify([cands[0].id]),
      }),
    ).rejects.toThrow(/affected 0 rows/);
  });

  it("propagates a failed warehouse read rather than degrading to a no-op", async () => {
    await expect(
      destroyVerified({
        table: "booking_outbox",
        watermarkCol: "updated_at",
        candidates: cands,
        destroy: async () => 1,
        verify: async () => {
          throw new Error("warehouse unreachable");
        },
      }),
    ).rejects.toThrow(/unreachable/);
  });
});
