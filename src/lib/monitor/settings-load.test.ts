import { describe, it, expect, vi, beforeEach } from "vitest";

// #571 red-team S4: loadMonitorSettings must NEVER throw. Migrations push
// separately from the code deploy, so the monitor_settings tables may not exist
// yet when new code runs — the read must fall back to env/coded defaults so the
// monitor tick keeps alerting instead of dying on its own config read.

const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => admin);

import { loadMonitorSettings, MONITOR_DEFAULTS } from "./settings";
import { MEASURED_VOLUME_BASELINE } from "./volume-baseline";

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV };
});

it("falls back to coded defaults when the DB client throws", async () => {
  admin.supabaseAdmin.mockImplementation(() => {
    throw new Error("no such table: monitor_settings");
  });
  const out = await loadMonitorSettings();
  expect(out.cooldownMs.availability_data_anomaly).toBe(
    MONITOR_DEFAULTS.cooldownMs.availability_data_anomaly,
  );
  // #1956: an unreadable store leaves the MEASURED floors in charge, never nothing.
  expect(out.floors.baseline).toBe(MEASURED_VOLUME_BASELINE);
  expect(out.floors.override30).toBeNull();
  expect(out.floors.override120).toBeNull();
});

it("falls back when the query resolves with an error (missing relation)", async () => {
  admin.supabaseAdmin.mockReturnValue({
    from: () => ({
      select: () => ({
        // cooldowns query resolves to an error
        then: undefined,
        error: { message: "relation does not exist" },
        data: null,
        eq: () => ({ maybeSingle: async () => ({ error: { message: "relation does not exist" }, data: null }) }),
      }),
    }),
  });
  const out = await loadMonitorSettings();
  expect(out.cooldownMs.low_booking_volume).toBe(MONITOR_DEFAULTS.cooldownMs.low_booking_volume);
});

describe("happy path", () => {
  it("applies stored cooldowns and floors over defaults", async () => {
    admin.supabaseAdmin.mockReturnValue({
      from: (table: string) => ({
        select: () =>
          table === "monitor_settings"
            ? Promise.resolve({ error: null, data: [{ key: "availability_data_anomaly", cooldown_min: 10 }] })
            : {
                eq: () => ({
                  maybeSingle: async () => ({ error: null, data: { floor_30: 2, floor_120: 8 } }),
                }),
              },
      }),
    });
    const out = await loadMonitorSettings();
    expect(out.cooldownMs.availability_data_anomaly).toBe(10 * 60_000);
    expect(out.floors.override30).toEqual({ value: 2, origin: "stored" });
    expect(out.floors.override120).toEqual({ value: 8, origin: "stored" });
  });
});
