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
    skipFilters: [] as string[],
  };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.in = (_col: string, ids: string[]) => {
    state.inIds = ids;
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
  db.state.skipFilters = [];
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
