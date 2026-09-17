import { afterEach, describe, expect, it, vi } from "vitest";

// #1102 repair path. #1132 made the retention lanes refuse to destroy a row the
// warehouse cannot confirm, but gave those rows nowhere to go: the export cursor is
// strictly forward, and the #1100 backfill lane does not exist in the codebase. So
// a single missed row would make the refusal permanent and the alert unactionable.
// This re-sends rows by id, ignoring the cursor.
const sf = vi.hoisted(() => ({ executeStatement: vi.fn() }));
const db = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    error: null as { message: string } | null,
    inIds: [] as string[],
    /** EVERY `in` filter this read sent, since #2388 splits it across requests. */
    inCalls: [] as string[][],
    skipFilters: [] as string[],
  };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.in = (_col: string, ids: string[]) => {
    state.inIds = ids;
    state.inCalls.push(ids);
    return chain;
  };
  // applySkipRedacted chains .is()/.eq() for the tables that redact in place.
  chain.is = (col: string) => {
    state.skipFilters.push(`is:${col}`);
    return chain;
  };
  chain.eq = (col: string) => {
    state.skipFilters.push(`eq:${col}`);
    return chain;
  };
  chain.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve({ data: state.rows, error: state.error }).then(onF, onR);
  return { state, from: vi.fn(() => chain) };
});

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: db.from }) }));
vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  executeStatement: sf.executeStatement,
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { reexportByIds, repairUnverified } from "./reexport";
import { MAX_IN_FILTER_BYTES, idFilterBytes } from "@/lib/db/id-batch";
import { readSnowflakeConfig } from "./config";
import { log } from "@/lib/log";

const cfg = {
  account: "a",
  user: "u",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "SLATE_WH",
  role: "SLATE_ROLE",
};

afterEach(() => {
  vi.resetAllMocks();
  db.state.rows = [];
  db.state.error = null;
  db.state.inIds = [];
  db.state.inCalls = [];
  db.state.skipFilters = [];
});

// #2388. `repairUnverified` hands this whole problem list, which is bounded only by
// MAX_VERIFY_BATCH (500). The Supabase read puts those ids in the query string, and
// 500 uuids is roughly 18.6 KB against a ceiling measured between 13 and 15 KB, so
// the read is REFUSED. That is the repair path, so it fails exactly when a lane has
// already refused to destroy rows and is relying on this to make tomorrow work: the
// `// cap-safe: ... capped at MAX_VERIFY_BATCH` comment it carried was a ROW count
// justifying a URL byte constraint, which is the mistake the whole module records.
describe("the read splits across requests (#2388)", () => {
  const manyIds = (n: number) =>
    Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

  it("never asks for more ids than one URL can carry", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    const ids = manyIds(500);
    // Positive control: the bound the caller is allowed to reach really is over the
    // ceiling, or this is measuring a single request.
    expect(idFilterBytes(ids)).toBeGreaterThan(MAX_IN_FILTER_BYTES);
    db.state.rows = [{ id: "x", org_id: "o" }];

    await reexportByIds("routing_decisions", ids);
    expect(db.state.inCalls.length).toBeGreaterThan(1);
    for (const sent of db.state.inCalls) expect(idFilterBytes(sent)).toBeLessThanOrEqual(MAX_IN_FILTER_BYTES);
    expect(db.state.inCalls.flat()).toEqual(ids);
  });

  // The failure case. A refusal partway through means some rows reached the
  // warehouse and the rest did not, and `repairUnverified` swallows this on purpose,
  // so the message is the only record that it happened at all.
  it("reports a failed request as a PARTIAL repair rather than a short answer", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    db.state.rows = [{ id: "x", org_id: "o" }];
    let merges = 0;
    sf.executeStatement.mockImplementation(async () => {
      merges += 1;
      if (merges === 2) throw new Error("warehouse refused");
      return { data: [] };
    });
    const err = (await reexportByIds("routing_decisions", manyIds(500)).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/partial/i);
    expect(err.message).toContain("warehouse refused");
    expect(err.message).toMatch(/\b1 of \d+\b/);
  });
});

describe("reexportByIds", () => {
  it("does nothing for an empty id list", async () => {
    expect(await reexportByIds("booking_outbox", [])).toBe(0);
    expect(sf.executeStatement).not.toHaveBeenCalled();
  });

  it("MERGEs exactly the named rows, keyed by id, without touching any cursor", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    db.state.rows = [{ id: "ob1", status: "delivered", updated_at: "2026-06-01T00:00:00Z" }];
    const sent = await reexportByIds("booking_outbox", ["ob1"]);
    expect(sent).toBe(1);
    expect(db.state.inIds).toEqual(["ob1"]);
    const [, statement] = sf.executeStatement.mock.calls[0] as unknown as [unknown, string];
    expect(statement).toContain("MERGE INTO booking_outbox t");
    expect(statement).toContain("ON t.id = s.id");
    // A repair must never move the export watermark: the cursor says how far the
    // incremental sweep reached, and advancing it here would skip real rows.
    expect(db.from).not.toHaveBeenCalledWith("export_cursor");
  });

  it("refuses a row that has been redacted in place, so it cannot clobber the full-fidelity copy", async () => {
    // Re-MERGEing a blanked row over Snowflake's good copy is the exact clobber
    // #1118 exists to prevent, so the skip predicate must be applied here too.
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    db.state.rows = [];
    await reexportByIds("bookings", ["bk1"]);
    expect(db.state.skipFilters).toContain("is:pii_redacted_at");
    // Nothing came back, so nothing was sent.
    expect(sf.executeStatement).not.toHaveBeenCalled();
  });

  it("applies the erased-payload skip for webhook deliveries too", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    await reexportByIds("webhook_deliveries", ["w1"]);
    expect(db.state.skipFilters).toContain("eq:payload_erased");
  });

  it("throws on an unmirrored table rather than silently sending nothing", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    await expect(reexportByIds("users", ["u1"])).rejects.toThrow(/not a mirrored table/);
  });

  it("throws when the mirror is unconfigured", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    await expect(reexportByIds("booking_outbox", ["ob1"])).rejects.toThrow(/not configured/);
  });

  it("throws on a read failure instead of reporting a successful repair of zero rows", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    db.state.error = { message: "db exploded" };
    await expect(reexportByIds("booking_outbox", ["ob1"])).rejects.toThrow(/db exploded/);
  });

  it("refuses a batch larger than the bound", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    const many = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(reexportByIds("booking_outbox", many)).rejects.toThrow(/exceeds/);
  });
});

describe("repairUnverified", () => {
  it("reports how many rows it re-sent", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    db.state.rows = [{ id: "ob1", status: "delivered" }];
    expect(await repairUnverified("booking_outbox", ["ob1"])).toBe(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("swallows and LOGS its own failure, so a failed repair cannot mask the refusal alert", async () => {
    // The caller is already about to throw and alert. A repair that threw here
    // would replace that specific signal with a different error, and the rows stay
    // un-destroyed either way, which is the safe direction.
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    sf.executeStatement.mockRejectedValue(new Error("warehouse suspended"));
    db.state.rows = [{ id: "ob1", status: "delivered" }];
    expect(await repairUnverified("booking_outbox", ["ob1"])).toBe(0);
    expect(log.error).toHaveBeenCalled();
  });

  it("does nothing for an empty list", async () => {
    expect(await repairUnverified("booking_outbox", [])).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
