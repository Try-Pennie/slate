/**
 * The warehouse half of the 24 month booking PII window (#1180).
 *
 * Supabase enforced it and Snowflake did not, so the retention limit Pennie has
 * committed to in writing (docs/pii-retention.md section 9, confirmed 2026-07-29)
 * was half enforced: after 24 months the contact data was gone from the live
 * database and still in the warehouse. `docs/pii-legal-positions.md`, the memo for
 * counsel, says the window covers both.
 *
 * Every case below that ends in a throw is the point of the file. A sweep that
 * reports "0 cleared" when it could not read something is indistinguishable from
 * one that had nothing to clean, and this is a compliance control, so an
 * unmeasured zero must never reach the caller as a healthy result.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./client", () => ({
  executeStatement: vi.fn(),
  escapeSqlLiteral: (s: string) => s.replaceAll("'", "''"),
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sweepWarehousePii } from "./warehouse-retention";
import { readSnowflakeConfig } from "./config";
import { executeStatement } from "./client";

const cfg = {
  account: "a",
  user: "u",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "W",
  role: "R",
};

/** A clock pinned so the cutoff is a fixed string, not whatever today is (L130). */
const NOW = "2029-03-01T00:00:00.000Z";

afterEach(() => vi.clearAllMocks());

/**
 * Answer each statement by shape: the select returns `ids`, every update reports
 * `changed` rows, and the verify reports `residual` in all four columns.
 */
function warehouse(opts: { ids: string[]; changed?: number; residual?: number }) {
  vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
    if (/^select id/i.test(sql)) return { data: opts.ids.map((id) => [id]) } as never;
    if (/^select/i.test(sql)) {
      const r = String(opts.residual ?? 0);
      return { data: [[r, r, r, r]] } as never;
    }
    return { data: [[String(opts.changed ?? opts.ids.length)]] } as never;
  });
}

describe("sweepWarehousePii", () => {
  it("does nothing at all when the mirror is not configured", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const r = await sweepWarehousePii(NOW);
    expect(r.skipped).toBe("mirror-not-configured");
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("selects on the appointment being past the window, bounded by a batch limit", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    warehouse({ ids: [] });
    await sweepWarehousePii(NOW, 250);
    const select = vi.mocked(executeStatement).mock.calls[0][1] as string;
    // 24 months before the pinned clock.
    expect(select).toContain("2027-03-01");
    expect(select).toMatch(/limit\s+250/i);
    expect(select).toMatch(/starts_at\s*</i);
  });

  it("reports an empty sweep without sending a single purge statement", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    warehouse({ ids: [] });
    const r = await sweepWarehousePii(NOW);
    expect(r.candidates).toBe(0);
    expect(r.cleared).toBe(0);
    expect(vi.mocked(executeStatement).mock.calls).toHaveLength(1);
  });

  it("clears the aged bookings and reports how many", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    warehouse({ ids: ["bk-1", "bk-2"], changed: 2 });
    const r = await sweepWarehousePii(NOW);
    expect(r.candidates).toBe(2);
    expect(r.cleared).toBe(2);
    expect(r.skipped).toBeUndefined();
  });

  /**
   * The sweep must not write the columns the mirror keys on. `updated_at` mirrors
   * Supabase and is what `buildVerifySql`'s is_current comparison reads to decide
   * whether a row is safely archived, and `exported_at` is the load stamp. Writing
   * either would corrupt the machinery the Supabase-side lane depends on.
   */
  it("never writes the mirror's own watermark or load stamp", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    warehouse({ ids: ["bk-1"] });
    await sweepWarehousePii(NOW);
    const updates = (vi.mocked(executeStatement).mock.calls.map((c) => c[1] as string)).filter((s) =>
      /^update/i.test(s),
    );
    expect(updates.length).toBeGreaterThan(0);
    for (const sql of updates) {
      expect(sql).not.toMatch(/set[\s\S]*\bupdated_at\s*=/i);
      expect(sql).not.toMatch(/\bexported_at\s*=/i);
    }
  });

  it("throws rather than reporting an empty sweep when the select cannot be read", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockResolvedValue({} as never);
    await expect(sweepWarehousePii(NOW)).rejects.toThrow(/could not be read/i);
  });

  it("throws when the select itself errors, and purges nothing", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockRejectedValue(new Error("warehouse suspended"));
    await expect(sweepWarehousePii(NOW)).rejects.toThrow(/warehouse suspended/);
    expect(vi.mocked(executeStatement).mock.calls).toHaveLength(1);
  });

  it("throws when a purge statement's row count cannot be read", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
      if (/^select id/i.test(sql)) return { data: [["bk-1"]] } as never;
      return {} as never;
    });
    await expect(sweepWarehousePii(NOW)).rejects.toThrow(/row count could not be read/i);
  });

  /**
   * The statements ran and the data is still there. That is not a smaller success,
   * it is the control having failed, and reporting a cleared count would certify a
   * window that is not being honored.
   */
  it("throws when the verify still finds contact data after the sweep", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    warehouse({ ids: ["bk-1"], residual: 1 });
    await expect(sweepWarehousePii(NOW)).rejects.toThrow(/still hold/i);
  });

  it("throws when the verify's counts cannot be read at all", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
      if (/^select id/i.test(sql)) return { data: [["bk-1"]] } as never;
      if (/^select/i.test(sql)) return { data: [[null, null, null, null]] } as never;
      return { data: [["1"]] } as never;
    });
    await expect(sweepWarehousePii(NOW)).rejects.toThrow(/unverified|could not read/i);
  });
});

/**
 * The ids come from OUTSIDE (Snowflake's answer), so they are checked rather than
 * coerced. `String(null)` is the string "null", which would be interpolated into
 * the purge as a booking id, match nothing, and leave the run reporting a
 * candidate it cleared zero of: a silent no-op that reads as a healthy sweep.
 */
describe("sweepWarehousePii id handling", () => {
  it("refuses a selected row with no readable id rather than coercing it", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
      if (/^select id/i.test(sql)) return { data: [["bk-1"], [null]] } as never;
      return { data: [["1"]] } as never;
    });
    await expect(sweepWarehousePii(NOW)).rejects.toThrow(/no readable id/i);
  });

  it("refuses a blank id, which would build a statement matching nothing", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
      if (/^select id/i.test(sql)) return { data: [["   "]] } as never;
      return { data: [["1"]] } as never;
    });
    await expect(sweepWarehousePii(NOW)).rejects.toThrow(/no readable id/i);
  });
});
