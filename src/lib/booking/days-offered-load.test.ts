import { describe, it, expect, vi, beforeEach } from "vitest";

// #3922: offered open days is a stored setting now, read through ONE loader. A
// measuring caller (the supply page, the monitor lane) gets the honest read, which
// is null when the read failed. The booker gets a cached read that keeps the LAST
// value it read through a failed refresh, and never a default that would change
// what leads see. Only the database client is mocked.
const maybeSingle = vi.hoisted(() =>
  vi.fn(async () => ({ data: null as unknown, error: null as { message: string } | null })),
);
const select = vi.hoisted(() => vi.fn((_cols: string) => ({ eq: vi.fn(() => ({ maybeSingle })) })));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: vi.fn(() => ({ from: vi.fn(() => ({ select })) })),
}));

import {
  readDaysOffered,
  readOfferedOpenDays,
  makeOfferedOpenDaysReader,
  loadOfferedOpenDaysCached,
  OFFERED_DAYS_TTL_MS,
} from "./days-offered-load";
import { BUSINESS_HOURS_TTL_MS } from "./business-hours-load";
import { HORIZON_DEFAULT } from "./settings";

beforeEach(() => {
  maybeSingle.mockReset();
  maybeSingle.mockResolvedValue({ data: null, error: null });
  select.mockClear();
  delete process.env.SLATE_BOOKING_HORIZON_DAYS;
});

describe("readDaysOffered", () => {
  it("reads both columns of the card in one read", async () => {
    maybeSingle.mockResolvedValue({ data: { offered_open_days: 4, horizon_days: 6 }, error: null });
    await expect(readDaysOffered()).resolves.toEqual({ offeredOpenDays: 4, horizonDays: 6 });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]![0]).toMatch(/offered_open_days/);
    expect(select.mock.calls[0]![0]).toMatch(/horizon_days/);
  });

  it("reads a missing row as the defaults, which is what the columns would hold", async () => {
    await expect(readDaysOffered()).resolves.toEqual({ offeredOpenDays: 3, horizonDays: HORIZON_DEFAULT });
  });

  it("returns null when the read FAILED, never a default", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "column offered_open_days does not exist" } });
    await expect(readDaysOffered()).resolves.toBeNull();
    await expect(readOfferedOpenDays()).resolves.toBeNull();
  });

  it("returns null for a stored value the column could never hold, rather than guessing", async () => {
    maybeSingle.mockResolvedValue({ data: { offered_open_days: 9, horizon_days: 4 }, error: null });
    await expect(readOfferedOpenDays()).resolves.toBeNull();
  });

  it("follows the stored value: 4 is 4", async () => {
    maybeSingle.mockResolvedValue({ data: { offered_open_days: 4, horizon_days: 5 }, error: null });
    await expect(readOfferedOpenDays()).resolves.toBe(4);
  });
});

describe("the booker's cached read", () => {
  it("lives as long as the business hours it is applied beside", () => {
    expect(OFFERED_DAYS_TTL_MS).toBe(BUSINESS_HOURS_TTL_MS);
  });

  it("reads once per TTL, and picks up a saved change on the next read after it", async () => {
    let clock = 0;
    let stored = 3;
    const read = vi.fn(async () => stored);
    const reader = makeOfferedOpenDaysReader({ read, now: () => clock, onStale: vi.fn() });
    await expect(reader()).resolves.toBe(3);
    stored = 4;
    clock = OFFERED_DAYS_TTL_MS - 1;
    await expect(reader()).resolves.toBe(3);
    clock = OFFERED_DAYS_TTL_MS;
    await expect(reader()).resolves.toBe(4);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the LAST value it read through a failed refresh, and says how old it is", async () => {
    let clock = 0;
    const read = vi.fn<() => Promise<number>>().mockResolvedValueOnce(4).mockRejectedValue(new Error("db down"));
    const onStale = vi.fn();
    const reader = makeOfferedOpenDaysReader({ read, now: () => clock, onStale });
    await expect(reader()).resolves.toBe(4);
    clock = OFFERED_DAYS_TTL_MS + 10;
    // 4, never the default 3: a default here would silently change what leads see.
    await expect(reader()).resolves.toBe(4);
    expect(onStale).toHaveBeenCalledWith(OFFERED_DAYS_TTL_MS + 10, expect.any(Error));
  });

  it("THROWS when a cold isolate's first read fails, so the caller decides rather than a guess", async () => {
    const reader = makeOfferedOpenDaysReader({
      read: async () => {
        throw new Error("db down");
      },
      now: () => 0,
      onStale: vi.fn(),
    });
    await expect(reader()).rejects.toThrow(/db down/);
  });

  it("the production instance throws on a failed read rather than answering a default", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(loadOfferedOpenDaysCached()).rejects.toThrow();
  });
});
