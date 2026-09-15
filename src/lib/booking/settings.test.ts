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
  readBookingHorizonDays,
  readPublicBookingPaused,
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

  // #1924 reversed this. It used to clear the override, and the field rendered
  // EMPTY with 4 only as a placeholder, so an admin who saved without typing
  // wrote null while a grey 4 sat in the box looking like a value. Dan: "if they
  // try to save with no number, just error and don't let them."
  //
  // The old assertion is replaced rather than adjusted: its whole content was the
  // decision being reversed (L252).
  it("refuses a blank value rather than clearing the override", () => {
    for (const raw of ["", "   ", "\t"]) {
      const parsed = parseHorizonForm(raw);
      expect(parsed.horizon_days).toBeNull();
      expect(parsed.errors).toHaveLength(1);
      // The message tells them what to do, not merely that they were wrong.
      expect(parsed.errors[0]).toMatch(/between 1 and 7/);
    }
  });

  // #1924: the FORM refuses blank and the READER still tolerates null, on
  // purpose. `horizon_days` is nullable and null rows exist, so removing the
  // reader's fallback because "the form no longer allows null" would turn a data
  // state that is still there into a booker offering nothing. Asserted as a PAIR,
  // because the temptation is to consolidate them.
  it("keeps refusing blank at the form while the reader still resolves a null row", () => {
    expect(parseHorizonForm("").errors).toHaveLength(1);
    expect(resolveHorizonDays(null, undefined, HORIZON_DEFAULT)).toBe(HORIZON_DEFAULT);
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

// #1654. The degrade above is right for the BOOKER (booking must keep working
// with the standard window) and wrong for anything that MEASURES against the
// window, because a reading taken over a window nobody chose looks exactly like
// one taken over the right window. `readBookingHorizonDays` is the honest read
// both of those callers now share.
describe("readBookingHorizonDays", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    maybeSingle.mockResolvedValue({ data: null, error: null });
    delete process.env.SLATE_BOOKING_HORIZON_DAYS;
  });

  it("returns null when the read FAILED, so a caller can refuse to measure", async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "column horizon_days does not exist" },
    });
    await expect(readBookingHorizonDays()).resolves.toBeNull();
  });

  // The distinction that makes the null meaningful: no stored override is not a
  // failed read, it is the documented fall through to env and then the default.
  // Collapsing the two would make every unconfigured org unmeasurable (L214).
  it("returns the resolved default when the read SUCCEEDED with no override stored", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(readBookingHorizonDays()).resolves.toBe(HORIZON_DEFAULT);
  });

  it("returns the stored horizon when one is set", async () => {
    maybeSingle.mockResolvedValue({ data: { horizon_days: 6 }, error: null });
    await expect(readBookingHorizonDays()).resolves.toBe(6);
  });

  // The pair, asserted together: on the SAME failure the booker keeps a usable
  // window and the measuring caller gets an explicit unknown. Either one alone
  // would pass on a reader hard wired to a single answer.
  it("differs from loadBookingHorizonDays on exactly the failing read", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "read failed" } });
    expect(await readBookingHorizonDays()).toBeNull();
    expect(await loadBookingHorizonDays()).toBe(HORIZON_DEFAULT);

    maybeSingle.mockResolvedValue({ data: { horizon_days: 5 }, error: null });
    expect(await readBookingHorizonDays()).toBe(5);
    expect(await loadBookingHorizonDays()).toBe(5);
  });
});

// #2297: the kill switch's reader. The whole question this answers is whether a
// read FAILURE can be told apart from the flag reading false, because those two
// take opposite actions: one keeps taking bookings, the other refuses them.
describe("readPublicBookingPaused", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
  });

  it("reads a stored pause as paused", async () => {
    maybeSingle.mockResolvedValue({ data: { public_booking_paused: true }, error: null });
    await expect(readPublicBookingPaused()).resolves.toBe(true);
  });

  it("reads a stored false as open", async () => {
    maybeSingle.mockResolvedValue({ data: { public_booking_paused: false }, error: null });
    await expect(readPublicBookingPaused()).resolves.toBe(false);
  });

  // An unconfigured org has no settings row at all. That is a real answer, not a
  // failure: nobody has ever paused bookings, so bookings are open (L214).
  it("reads a missing settings row as open, not as unreadable", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(readPublicBookingPaused()).resolves.toBe(false);
  });

  // The one that matters. A read error must NOT arrive as false, which is the
  // #277 shape: an error resolving to the benign-looking value, silently.
  it("returns null, never false, when the read ERRORS", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "column does not exist" } });
    const read = await readPublicBookingPaused();
    expect(read).toBeNull();
    expect(read).not.toBe(false);
  });

  // The pair read together, so neither assertion above can be satisfied by a
  // reader hard wired to one answer (L1).
  it("tells a failing read apart from a stored false on consecutive calls", async () => {
    maybeSingle.mockResolvedValue({ data: { public_booking_paused: false }, error: null });
    expect(await readPublicBookingPaused()).toBe(false);
    maybeSingle.mockResolvedValue({ data: null, error: { message: "read failed" } });
    expect(await readPublicBookingPaused()).toBeNull();
  });
});
