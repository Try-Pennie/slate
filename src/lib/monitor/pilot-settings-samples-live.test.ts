import { describe, it, expect, vi, beforeEach } from "vitest";

// #3641: the monitor lane's pilot split reading, bound to the real systems. The
// decisions are pinned by scripts/test-pilot-settings-samples.ts; this pins the WIRING,
// which a wrong argument would break without any decision test noticing: the settings
// come through the isolate's shared cache (the same reading the per page alarm takes,
// so a tick costs no second Salesforce read) at THIS tick's clock, and the row lands in
// pilot_settings_samples.

const cache = vi.hoisted(() => ({ readTimed: vi.fn() }));
vi.mock("@/lib/salesforce/pilot-settings", () => ({ pilotSettingsCache: cache }));

import { runPilotSettingsSampleLive } from "./pilot-settings-samples-live";

const NOW = Date.parse("2026-10-13T14:00:00.000Z");

function fakeDb(lastSampledAt: string | null) {
  const inserted: unknown[] = [];
  const db = {
    from: (table: string) => {
      expect(table).toBe("pilot_settings_samples");
      return {
        select: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: lastSampledAt ? { sampled_at: lastSampledAt } : null, error: null }),
            }),
          }),
        }),
        insert: (row: unknown) => {
          inserted.push(row);
          return { select: async () => ({ data: [row], error: null }) };
        },
      };
    },
  };
  return { db: db as never, inserted };
}

beforeEach(() => {
  cache.readTimed.mockReset();
});

describe("runPilotSettingsSampleLive", () => {
  it("reads through the shared cache at this tick's clock and stores the row", async () => {
    cache.readTimed.mockResolvedValue({
      settings: { active: true, percent: 50, tiers: "1;2;3;4;5", lastModified: "2026-10-12T15:00:04.000+0000" },
      readAtMs: NOW - 60_000,
    });
    const { db, inserted } = fakeDb(null);
    expect(await runPilotSettingsSampleLive(db, NOW)).toEqual({ sampled: true, ok: true });
    expect(cache.readTimed).toHaveBeenCalledWith(NOW);
    expect(inserted).toEqual([
      {
        sampled_at: new Date(NOW).toISOString(),
        ok: true,
        read_at: new Date(NOW - 60_000).toISOString(),
        active: true,
        percent: 50,
        tiers: "1;2;3;4;5",
        record_modified_at: "2026-10-12T15:00:04.000Z",
        error: null,
      },
    ]);
  });

  it("asks nothing when the last stored reading is recent", async () => {
    const { db, inserted } = fakeDb(new Date(NOW - 5 * 60_000).toISOString());
    expect(await runPilotSettingsSampleLive(db, NOW)).toEqual({ sampled: false });
    expect(cache.readTimed).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("stores a failed read as a failure", async () => {
    cache.readTimed.mockImplementation(async () => {
      throw new Error("Salesforce answered 503");
    });
    const { db, inserted } = fakeDb(null);
    expect(await runPilotSettingsSampleLive(db, NOW)).toEqual({ sampled: true, ok: false });
    expect(inserted).toMatchObject([{ ok: false, error: "Salesforce answered 503", percent: null }]);
  });
});
