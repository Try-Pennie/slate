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
import { MAX_IN_FILTER_BYTES, idFilterBytes, PartialIdSweepError } from "@/lib/db/id-batch";
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
    expect(sql).toContain("t.id IS NOT NULL AS is_present");
  });

  it("avoids Snowflake reserved words in its column aliases", () => {
    // `CURRENT` is reserved, and `AS current` was a hard SQL compilation error that
    // no unit test could see, because they all answer with a stand-in rather than
    // parsing the statement. It shipped broken and was caught by the live probe on
    // /api/admin/snowflake-check. Keep the aliases prefixed so this cannot recur.
    const aliases = [...sql.matchAll(/\bAS\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
    expect(aliases.length).toBeGreaterThan(0);
    const reserved = ["current", "current_date", "current_time", "current_timestamp", "localtime", "values", "table"];
    for (const a of aliases) expect(reserved).not.toContain(a);
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

  // #1102 repair path. Refusing to destroy an unconfirmed row is only safe if the
  // refusal is recoverable: the export cursor is strictly forward, so nothing else
  // ever revisits a skipped row, and the #1100 backfill lane does not exist.
  it("re-sends the unconfirmed rows, and does so BEFORE refusing, so tomorrow can succeed", async () => {
    const order: string[] = [];
    const repair = vi.fn(async (_t: string, ids: string[]) => {
      order.push(`repair:${ids.join("|")}`);
      return ids.length;
    });
    await expect(
      destroyVerified({
        table: "booking_outbox",
        watermarkCol: "updated_at",
        candidates: cands,
        destroy: async () => 0,
        verify: fakeVerify([], cands.map((c) => ({ id: c.id, state: "absent" as const }))),
        repair,
      }),
    ).rejects.toThrow(/confirmed NONE/);
    // Repaired every unconfirmed id, and ran before the throw.
    expect(repair).toHaveBeenCalledWith("booking_outbox", cands.map((c) => c.id));
    expect(order).toEqual([`repair:${cands.map((c) => c.id).join("|")}`]);
  });

  it("re-sends only the unconfirmed subset while still destroying the confirmed rows", async () => {
    const repair = vi.fn(async () => 1);
    const r = await destroyVerified({
      table: "webhook_deliveries",
      watermarkCol: "updated_at",
      candidates: cands,
      destroy: async (ids) => ids.length,
      verify: fakeVerify([cands[0].id, cands[1].id], [{ id: cands[2].id, state: "stale" }]),
      repair,
    });
    expect(repair).toHaveBeenCalledWith("webhook_deliveries", [cands[2].id]);
    expect(r.destroyed).toBe(2);
  });

  it("does not attempt a repair when everything verified", async () => {
    const repair = vi.fn(async () => 0);
    await destroyVerified({
      table: "routing_decisions",
      watermarkCol: "created_at",
      candidates: cands,
      destroy: async (ids) => ids.length,
      verify: fakeVerify(cands.map((c) => c.id)),
      repair,
    });
    expect(repair).not.toHaveBeenCalled();
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

// #2388. Every lane reads up to MAX_VERIFY_BATCH (500) candidates and used to hand
// the whole verified list to ONE `.in("id", ids)` filter. PostgREST puts that in the
// query string, and 500 uuids is about 18.6 KB against a ceiling measured between 13
// and 15 KB, so the write is REFUSED at the transport. The lane then throws, redacts
// nothing, and finds the same 500 rows tomorrow: a permanent stop rather than a blip,
// behind the retention gate that freezes the export while it lasts.
//
// The splitting is owned HERE rather than in each lane, so a fifth lane cannot be
// written without it (L621). These assert the two halves that matter: no request is
// oversized, and a failure partway through is never reported as a finished sweep.
describe("destroyVerified splits the write across requests (#2388)", () => {
  const manyIds = (n: number) =>
    Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const manyCands = (n: number): Candidate[] =>
    manyIds(n).map((id) => ({ id, watermark: "2026-01-01T00:00:00.000Z" }));
  const verifyAll = (ids: string[]) => async (): Promise<VerifyOutcome> => ({ archived: ids, problems: [] });

  it("never hands one request more ids than the URL budget allows", async () => {
    const ids = manyIds(500);
    // Positive control: the number the lanes actually read must be over the ceiling,
    // or this whole block is measuring a single request and proves nothing.
    expect(idFilterBytes(ids)).toBeGreaterThan(MAX_IN_FILTER_BYTES);

    const sent: string[][] = [];
    const r = await destroyVerified({
      table: "bookings",
      watermarkCol: "updated_at",
      candidates: manyCands(500),
      destroy: async (chunk) => {
        sent.push(chunk);
        return chunk.length;
      },
      verify: verifyAll(ids),
    });
    expect(sent.length).toBeGreaterThan(1);
    for (const chunk of sent) expect(idFilterBytes(chunk)).toBeLessThanOrEqual(MAX_IN_FILTER_BYTES);
    // Every verified row is still destroyed exactly once, and the counts are summed.
    expect(sent.flat()).toEqual(ids);
    expect(r.destroyed).toBe(500);
    expect(r.candidates).toBe(500);
  });

  it("does not split a batch small enough for one request", async () => {
    const sent: string[][] = [];
    await destroyVerified({
      table: "routing_decisions",
      watermarkCol: "created_at",
      candidates: cands,
      destroy: async (chunk) => {
        sent.push(chunk);
        return chunk.length;
      },
      verify: verifyAll(cands.map((c) => c.id)),
    });
    expect(sent).toHaveLength(1);
  });

  // THE case this issue is about. A retention lane that redacts two batches and then
  // meets a refusal must not answer as though the sweep finished: the remaining rows
  // are still carrying contact data and nothing else will notice.
  it("THROWS on a mid sweep failure, naming what was already destroyed", async () => {
    let calls = 0;
    const err = (await destroyVerified({
      table: "bookings",
      watermarkCol: "updated_at",
      candidates: manyCands(500),
      destroy: async (chunk) => {
        calls += 1;
        if (calls === 2) throw new Error("PostgREST refused the request");
        return chunk.length;
      },
      verify: verifyAll(manyIds(500)),
    }).catch((e) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    // It says a sweep happened and did not finish, it says how much of it landed, and
    // it keeps the underlying refusal so nobody has to guess at the cause.
    expect(err.message).toContain("bookings");
    expect(err.message).toMatch(/partial/i);
    expect(err.message).toContain("PostgREST refused the request");
    // The rows the finished requests DID destroy are named, because for a redaction
    // lane that work cannot be undone and a later audit has to account for it.
    expect(err.message).toMatch(/\b1 of \d+\b/);
    expect(err.message).toMatch(/destroyed/i);
  });

  // L367: a sum over chunks cannot see one component collapsing. The pre-#2388 check
  // compared the TOTAL against zero, so a batch that silently affected nothing was
  // invisible as long as its neighbours worked.
  it("throws when ONE request affects no rows, even though the others did", async () => {
    let calls = 0;
    await expect(
      destroyVerified({
        table: "webhook_deliveries",
        watermarkCol: "updated_at",
        candidates: manyCands(500),
        destroy: async (chunk) => {
          calls += 1;
          return calls === 2 ? 0 : chunk.length;
        },
        verify: verifyAll(manyIds(500)),
      }),
    ).rejects.toThrow(/affected 0 rows/);
  });

  // A single request failing reads through the same shape, so no lane has two error
  // types to handle, and it says ZERO destroyed rather than leaving that to be
  // inferred from silence.
  it("reports a single failed request the same way, naming zero destroyed", async () => {
    const err = (await destroyVerified({
      table: "booking_outbox",
      watermarkCol: "updated_at",
      candidates: cands,
      destroy: async () => {
        throw new Error("boom");
      },
      verify: verifyAll(cands.map((c) => c.id)),
    }).catch((e) => e)) as Error;
    expect(err.message).toMatch(/partial/i);
    expect(err.message).toContain("boom");
    expect(err.message).toContain("0 row(s) already destroyed");
    expect(err.cause).toBeInstanceOf(PartialIdSweepError);
  });
});
