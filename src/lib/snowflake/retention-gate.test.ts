import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./export-lag", () => ({ measureExportLag: vi.fn(), exportedThrough: vi.fn() }));
vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./reconcile", () => ({ reconcileSnowflakeMirror: vi.fn() }));

import { mirrorReadyForDeletion } from "./retention-gate";
import { measureExportLag } from "./export-lag";
import { readSnowflakeConfig } from "./config";
import { reconcileSnowflakeMirror } from "./reconcile";
import { MAX_EXPORT_LAG_MS, type TableLag } from "./export-lag-core";

afterEach(() => vi.clearAllMocks());

const CONFIG = { account: "acc", user: "u", privateKeyPem: "k", database: "d", schema: "s", warehouse: "w", role: "r" };

const lag = (over: Partial<TableLag> = {}): TableLag => ({
  table: "bookings",
  cursorTs: "2026-07-31T12:00:00Z",
  newestTs: "2026-07-31T12:05:00Z",
  oldestPendingTs: "2026-07-31T12:05:00Z",
  lagMs: 5 * 60_000,
  backlog: 1,
  ...over,
});

describe("mirrorReadyForDeletion", () => {
  it("is not ready when the mirror is unconfigured (never delete unarchived data)", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const g = await mirrorReadyForDeletion();
    expect(g.ready).toBe(false);
    expect(g.reason).toMatch(/not configured/);
    expect(measureExportLag).not.toHaveBeenCalled();
  });

  it("is ready when the export lane is keeping up", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(CONFIG);
    vi.mocked(measureExportLag).mockResolvedValue([lag()]);
    const g = await mirrorReadyForDeletion();
    expect(g.ready).toBe(true);
    expect(g.reason).toBeNull();
  });

  it("is not ready when the export lane has fallen behind", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(CONFIG);
    vi.mocked(measureExportLag).mockResolvedValue([lag({ lagMs: MAX_EXPORT_LAG_MS + 60_000, backlog: 400 })]);
    const g = await mirrorReadyForDeletion();
    expect(g.ready).toBe(false);
    expect(g.reason).toMatch(/bookings/);
    expect(g.reason).toMatch(/oldest row waiting for export is .* old/);
  });

  it("does NOT ask Snowflake anything, so a suspended warehouse cannot stall the lane", async () => {
    // The whole point of #1139: the gate is Supabase-only now. It used to run a
    // full 7-statement reconciliation per lane, three times a day, while holding
    // a 60s lock a cold-warehouse poll could outlast.
    vi.mocked(readSnowflakeConfig).mockReturnValue(CONFIG);
    vi.mocked(measureExportLag).mockResolvedValue([lag()]);
    await mirrorReadyForDeletion();
    expect(reconcileSnowflakeMirror).not.toHaveBeenCalled();
  });

  it("propagates a measurement failure instead of reporting a healthy mirror", async () => {
    // Fail loud: an unmeasured mirror must never present as a ready one, because
    // the caller's next move is to destroy data.
    vi.mocked(readSnowflakeConfig).mockReturnValue(CONFIG);
    vi.mocked(measureExportLag).mockRejectedValue(new Error("cursor read failed"));
    await expect(mirrorReadyForDeletion()).rejects.toThrow(/cursor read failed/);
  });
});
