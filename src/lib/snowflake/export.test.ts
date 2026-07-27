import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn(() => ({})) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./export-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export-core")>();
  return { ...actual, exportTable: vi.fn() };
});

import { runSnowflakeExport } from "./export";
import { readSnowflakeConfig } from "./config";
import { exportTable, MIRROR_TABLES } from "./export-core";
import { log } from "@/lib/log";

const cfg = {
  account: "vrkfjso-rwc54963",
  user: "SLATE_SERVICE",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "SLATE_WH",
  role: "SLATE_ROLE",
};

const okResult = (table: string) => ({ table, key: table, exported: 1, batches: 1, hitDeadline: false });

afterEach(() => vi.clearAllMocks());

describe("runSnowflakeExport", () => {
  it("no-ops when the mirror is not configured", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const res = await runSnowflakeExport();
    expect(res).toEqual({ skipped: "not-configured" });
    expect(exportTable).not.toHaveBeenCalled();
  });

  it("exports every mirrored table and sums the rows when all succeed", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(exportTable).mockImplementation(async (spec) => okResult(spec.table));
    const res = await runSnowflakeExport();
    expect("exported" in res && res.exported).toBe(MIRROR_TABLES.length);
    expect(exportTable).toHaveBeenCalledTimes(MIRROR_TABLES.length);
  });

  it("fails loud when a table errors, but still attempts the others first", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    // First table throws; the rest resolve. The lane must attempt all of them
    // and then throw, rather than stopping at the first failure or reporting ok.
    vi.mocked(exportTable).mockImplementation(async (spec) => {
      if (spec.table === MIRROR_TABLES[0].table) throw new Error("non-terminal Snowflake response");
      return okResult(spec.table);
    });
    await expect(runSnowflakeExport()).rejects.toThrow(/table failure/);
    expect(exportTable).toHaveBeenCalledTimes(MIRROR_TABLES.length);
    expect(log.error).toHaveBeenCalled();
  });
});
