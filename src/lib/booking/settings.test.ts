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
  readDemotionRerouteEnabled,
  readPlaceholderBookingEnabled,
  readTransferOfferSettings,
  readPublicBookingPauseState,
  HORIZON_DEFAULT,
  HORIZON_MIN,
  HORIZON_MAX,
} from "./settings";
import { parseDaysOfferedForm } from "./days-offered";

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

// #1924, carried to the Days offered card (#3922): the FORM refuses blank and the
// READER still tolerates a null horizon, on purpose. `horizon_days` is nullable and
// null rows exist, so removing the reader's fallback because "the form no longer
// allows null" would turn a data state that is still there into a booker offering
// nothing. Asserted as a PAIR, because the temptation is to consolidate them. The
// form's own rules are pinned in scripts/test-days-offered.ts.
describe("the days offered form and the horizon reader", () => {
  it("keeps refusing blank at the form while the reader still resolves a null row", () => {
    expect(parseDaysOfferedForm("", "1").errors).toHaveLength(1);
    expect(parseDaysOfferedForm("3", "").errors).toHaveLength(1);
    expect(resolveHorizonDays(null, undefined, HORIZON_DEFAULT)).toBe(HORIZON_DEFAULT);
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

// #3582: the go-live switch for the reroute trigger. It gates a customer-MOVING action, so an
// unreadable switch must never arm it. #3615: it now answers null for an unreadable switch rather
// than a plain false, because a false is also what a deliberately OFF switch answers, and the sync
// has to be able to say "could not read it, so checked nobody" instead of looking like a quiet hour.
describe("readDemotionRerouteEnabled", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
  });

  it("reads a stored true as armed", async () => {
    maybeSingle.mockResolvedValue({ data: { demotion_reroute_enabled: true }, error: null });
    await expect(readDemotionRerouteEnabled()).resolves.toBe(true);
  });

  it("reads a stored false as off", async () => {
    maybeSingle.mockResolvedValue({ data: { demotion_reroute_enabled: false }, error: null });
    await expect(readDemotionRerouteEnabled()).resolves.toBe(false);
  });

  it("reads a missing settings row as off (nobody has armed it)", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(readDemotionRerouteEnabled()).resolves.toBe(false);
  });

  // The one that matters: a read error never arms the trigger, never throws, and is told apart
  // from a switch somebody left off.
  it("answers null (unreadable), never true and never a throw, when the read ERRORS", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "column does not exist" } });
    await expect(readDemotionRerouteEnabled()).resolves.toBeNull();
  });

  // The pair read together, so neither assertion can be satisfied by a reader hard wired to one
  // answer (L1): a stored true really reads true, and only a true arms it.
  it("arms only on a stored true, off on everything else", async () => {
    maybeSingle.mockResolvedValue({ data: { demotion_reroute_enabled: true }, error: null });
    expect(await readDemotionRerouteEnabled()).toBe(true);
    maybeSingle.mockResolvedValue({ data: null, error: { message: "read failed" } });
    expect(await readDemotionRerouteEnabled()).toBeNull();
  });
});

// #2366: the MONITOR's reader for the same flag, plus when the switch was thrown.
// It is a deliberate second reader rather than a widening of the one above, and the
// difference is the error handling: this one THROWS, so the monitor lane's step
// boundary reports it and the check renders "unreadable" rather than a silence
// nobody can tell from a healthy switch.
describe("readPublicBookingPauseState", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    maybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it("reads a stored pause with the instant it was thrown", async () => {
    maybeSingle.mockResolvedValue({
      data: { public_booking_paused: true, public_booking_paused_at: "2026-09-17T06:00:00.000Z" },
      error: null,
    });
    await expect(readPublicBookingPauseState()).resolves.toEqual({
      paused: true,
      sinceMs: Date.UTC(2026, 8, 17, 6, 0, 0),
    });
  });

  // Running is running whatever the stamp says, and the stamp is reported as absent
  // rather than as a time, because a moment carried past the thing it dates is how a
  // correct history reads as corrupt (L589).
  it("reads a stored false as running, with no instant at all", async () => {
    maybeSingle.mockResolvedValue({
      data: { public_booking_paused: false, public_booking_paused_at: null },
      error: null,
    });
    await expect(readPublicBookingPauseState()).resolves.toEqual({ paused: false, sinceMs: null });
  });

  // A row paused before migration 0132, or by hand SQL against a database with the
  // trigger dropped. Stopped, and nothing recorded when, which the check speaks about
  // rather than waiting out a clock that does not exist.
  it("reads a pause with no stamp as stopped with no recorded start", async () => {
    maybeSingle.mockResolvedValue({
      data: { public_booking_paused: true, public_booking_paused_at: null },
      error: null,
    });
    await expect(readPublicBookingPauseState()).resolves.toEqual({ paused: true, sinceMs: null });
  });

  // An unreadable stamp must arrive as "nothing recorded", never as a NaN: every
  // comparison with NaN is false, so the elapsed time would read as under the
  // threshold for ever and the notice would never fire (#1169).
  it("reads an unparseable stamp as no recorded start, never as a NaN", async () => {
    maybeSingle.mockResolvedValue({
      data: { public_booking_paused: true, public_booking_paused_at: "not a timestamp" },
      error: null,
    });
    const read = await readPublicBookingPauseState();
    expect(read).toEqual({ paused: true, sinceMs: null });
    expect(Number.isNaN(read.sinceMs as number)).toBe(false);
  });

  // An unconfigured org has no settings row. A real answer: nobody ever paused
  // bookings, so bookings are running.
  it("reads a missing settings row as running", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(readPublicBookingPauseState()).resolves.toEqual({ paused: false, sinceMs: null });
  });

  // THE FAILURE PATH, and the whole reason this reader exists beside the other one.
  // A read error may not arrive as "bookings are running": that clears the notice off
  // a query that never ran, which is the #1134 shape.
  it("THROWS when the read errors, rather than reporting bookings as running", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "column does not exist" } });
    await expect(readPublicBookingPauseState()).rejects.toThrow();
  });

  // The pair read together, so neither assertion above can be satisfied by a reader
  // hard wired to one answer (L1).
  it("differs from readPublicBookingPaused on exactly the failing read", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "read failed" } });
    expect(await readPublicBookingPaused()).toBeNull();
    await expect(readPublicBookingPauseState()).rejects.toThrow();

    maybeSingle.mockResolvedValue({
      data: { public_booking_paused: true, public_booking_paused_at: "2026-09-17T06:00:00.000Z" },
      error: null,
    });
    expect(await readPublicBookingPaused()).toBe(true);
    expect((await readPublicBookingPauseState()).paused).toBe(true);
  });
});

// #4200: the go live switch for placeholder bookings. It lets a coordinator stack a
// call on the placeholder advisor, so an unreadable switch must never read as on.
describe("readPlaceholderBookingEnabled", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
  });

  it("reads a stored true as on", async () => {
    maybeSingle.mockResolvedValue({ data: { placeholder_booking_enabled: true }, error: null });
    await expect(readPlaceholderBookingEnabled()).resolves.toBe(true);
  });

  it("reads a stored false, and a missing settings row, as off", async () => {
    maybeSingle.mockResolvedValue({ data: { placeholder_booking_enabled: false }, error: null });
    await expect(readPlaceholderBookingEnabled()).resolves.toBe(false);
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(readPlaceholderBookingEnabled()).resolves.toBe(false);
  });

  it("answers null (unreadable), never true and never a throw, when the read ERRORS", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "column does not exist" } });
    await expect(readPlaceholderBookingEnabled()).resolves.toBeNull();
  });
});

// #4380: the two live transfer settings. An unreadable read must never be served as the
// defaults: the page would offer a transfer on a threshold nobody read (L10).
describe("readTransferOfferSettings", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
  });

  it("reads the stored threshold and line", async () => {
    maybeSingle.mockResolvedValue({ data: { transfer_offer_threshold: 5, transfer_line: "212-555-0100" }, error: null });
    await expect(readTransferOfferSettings()).resolves.toEqual({ threshold: 5, line: "212-555-0100" });
  });

  it("reads a missing settings row as the column defaults, a real answer", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(readTransferOfferSettings()).resolves.toEqual({ threshold: 3, line: "786-504-0671" });
  });

  it("answers null, never the defaults and never a throw, when the read errors", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "column does not exist" } });
    await expect(readTransferOfferSettings()).resolves.toBeNull();
  });

  it("answers null for a stored value outside the shape the column check holds", async () => {
    maybeSingle.mockResolvedValue({ data: { transfer_offer_threshold: 0, transfer_line: "786-504-0671" }, error: null });
    await expect(readTransferOfferSettings()).resolves.toBeNull();
    maybeSingle.mockResolvedValue({ data: { transfer_offer_threshold: 3, transfer_line: "7865040671" }, error: null });
    await expect(readTransferOfferSettings()).resolves.toBeNull();
  });
});
