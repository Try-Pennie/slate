import { describe, it, expect, vi, beforeEach } from "vitest";

// #1015: the direct-booking default-bucket accessor. Reads the single-row
// booking_settings config (id=1) and returns the configured bucket code, or null
// when no default is set. Fail-loud: a real read error THROWS (via unwrap) rather
// than degrading to a false "no default", which downstream would misread as an
// intentional NO_DEFAULT_BUCKET. Only the DB client is mocked.
const maybeSingle = vi.hoisted(() =>
  vi.fn(async () => ({ data: null as unknown, error: null as { message: string } | null })),
);
const admin = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle })),
      })),
    })),
  })),
}));
vi.mock("@/lib/supabase/admin", () => admin);

import {
  getDefaultBucketCode,
  parseDefaultBucketForm,
  resolveHorizonDays,
  loadBookingHorizonDays,
  parseHorizonForm,
  HORIZON_DEFAULT,
  HORIZON_MIN,
  HORIZON_MAX,
} from "./settings";

describe("parseDefaultBucketForm", () => {
  const valid = new Set(["100", "200", "300"]);

  it("accepts a code that is a real (non-test) bucket", () => {
    expect(parseDefaultBucketForm("200", valid)).toEqual({ default_bucket_code: "200", errors: [] });
  });

  it("treats blank as clearing the default (null, no error)", () => {
    expect(parseDefaultBucketForm("", valid)).toEqual({ default_bucket_code: null, errors: [] });
    expect(parseDefaultBucketForm("   ", valid)).toEqual({ default_bucket_code: null, errors: [] });
  });

  it("refuses a code that is not a known bucket (fail loud, no write)", () => {
    const r = parseDefaultBucketForm("999", valid);
    expect(r.default_bucket_code).toBeNull();
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/999/);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(parseDefaultBucketForm(" 100 ", valid)).toEqual({ default_bucket_code: "100", errors: [] });
  });
});

describe("getDefaultBucketCode", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    maybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it("returns the configured default bucket code", async () => {
    maybeSingle.mockResolvedValue({ data: { default_bucket_code: "123" }, error: null });
    expect(await getDefaultBucketCode()).toBe("123");
  });

  it("returns null when no config row exists (maybeSingle -> null)", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getDefaultBucketCode()).toBeNull();
  });

  it("returns null when the stored code is blank/whitespace", async () => {
    maybeSingle.mockResolvedValue({ data: { default_bucket_code: "   " }, error: null });
    expect(await getDefaultBucketCode()).toBeNull();
  });

  it("throws (fail-loud) on a real read error rather than returning null", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    await expect(getDefaultBucketCode()).rejects.toThrow(/relation does not exist/);
  });
});

describe("resolveHorizonDays (store > env > coded default)", () => {
  it("uses a valid stored value in range", () => {
    expect(resolveHorizonDays(6, undefined, HORIZON_DEFAULT)).toBe(6);
    expect(resolveHorizonDays(HORIZON_MIN, undefined, HORIZON_DEFAULT)).toBe(HORIZON_MIN);
    expect(resolveHorizonDays(HORIZON_MAX, undefined, HORIZON_DEFAULT)).toBe(HORIZON_MAX);
  });

  it("falls through to env when stored is null/unset", () => {
    expect(resolveHorizonDays(null, 5, HORIZON_DEFAULT)).toBe(5);
  });

  it("falls through to the coded default when neither store nor env is valid", () => {
    expect(resolveHorizonDays(null, undefined, HORIZON_DEFAULT)).toBe(HORIZON_DEFAULT);
  });

  it("rejects an out-of-range stored value and falls through", () => {
    expect(resolveHorizonDays(HORIZON_MAX + 1, undefined, HORIZON_DEFAULT)).toBe(HORIZON_DEFAULT);
    expect(resolveHorizonDays(0, 3, HORIZON_DEFAULT)).toBe(3);
  });

  it("rejects a non-integer stored value (e.g. 4.5) and falls through", () => {
    expect(resolveHorizonDays(4.5, undefined, HORIZON_DEFAULT)).toBe(HORIZON_DEFAULT);
  });

  it("rejects an out-of-range env value and falls through to the default", () => {
    expect(resolveHorizonDays(null, HORIZON_MAX + 1, HORIZON_DEFAULT)).toBe(HORIZON_DEFAULT);
  });
});

describe("parseHorizonForm", () => {
  it("accepts a whole number in range", () => {
    expect(parseHorizonForm("5")).toEqual({ horizon_days: 5, errors: [] });
  });

  it("treats blank as clearing the override (null, no error)", () => {
    expect(parseHorizonForm("")).toEqual({ horizon_days: null, errors: [] });
    expect(parseHorizonForm("   ")).toEqual({ horizon_days: null, errors: [] });
  });

  it("refuses an out-of-range value (fail loud, no write)", () => {
    const r = parseHorizonForm(String(HORIZON_MAX + 1));
    expect(r.horizon_days).toBeNull();
    expect(r.errors.length).toBe(1);
  });

  it("refuses a non-integer value", () => {
    expect(parseHorizonForm("4.5").errors.length).toBe(1);
    expect(parseHorizonForm("abc").errors.length).toBe(1);
  });
});

describe("loadBookingHorizonDays", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    maybeSingle.mockResolvedValue({ data: null, error: null });
    delete process.env.SLATE_BOOKING_HORIZON_DAYS;
  });

  it("returns the stored horizon when set", async () => {
    maybeSingle.mockResolvedValue({ data: { horizon_days: 6 }, error: null });
    expect(await loadBookingHorizonDays()).toBe(6);
  });

  it("returns the coded default when no config row exists", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await loadBookingHorizonDays()).toBe(HORIZON_DEFAULT);
  });

  it("degrades to the default (never throws) on a read error, unlike getDefaultBucketCode", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "column horizon_days does not exist" } });
    await expect(loadBookingHorizonDays()).resolves.toBe(HORIZON_DEFAULT);
  });
});
