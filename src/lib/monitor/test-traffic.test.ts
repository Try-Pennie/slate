import { describe, it, expect, vi, beforeEach } from "vitest";

// #1616: deciding whether a booking attempt was the smoke canary's.
//
// The decision is made SERVER SIDE from the bucket the attempt belongs to, never
// from anything the caller sends: a "this is a test" header would let anyone hide
// a real wave of failures from the check that exists to see it.
//
// The reschedule case is the one that matters. The manage-token reschedule path
// records an EMPTY bucket_code (4 of the canary's 16 attempts per pass, including
// the reschedule_conflict it raises on purpose), so it is the one route a bucket
// code can never identify, and it has to be resolved through the booking instead.

const bucketMaybeSingle = vi.hoisted(() => vi.fn());
const bookingMaybeSingle = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() =>
  vi.fn((table: string) => ({
    select: () => ({
      eq: () => ({ maybeSingle: table === "buckets" ? bucketMaybeSingle : bookingMaybeSingle }),
    }),
  })),
);
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ from })) }));
const logged = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/log", () => ({ log: logged }));

import { resolveTestTraffic, resolveTrafficMarkers, resetBucketTestCacheForTests, BUCKET_TEST_CACHE_MS } from "./test-traffic";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetBucketTestCacheForTests();
  bucketMaybeSingle.mockResolvedValue({ data: { is_test: false }, error: null });
  bookingMaybeSingle.mockResolvedValue({ data: { buckets: { is_test: false } }, error: null });
});

describe("resolveTestTraffic, by manage token (the reschedule path)", () => {
  it("marks the attempt as test when the booking sits in a test bucket", async () => {
    bookingMaybeSingle.mockResolvedValue({ data: { buckets: { is_test: true } }, error: null });
    expect(await resolveTestTraffic({ by: "manageToken", token: "tok-smoke" })).toBe(true);
    expect(from).toHaveBeenCalledWith("bookings");
  });

  it("marks a real lead's own reschedule as NOT test", async () => {
    bookingMaybeSingle.mockResolvedValue({ data: { buckets: { is_test: false } }, error: null });
    expect(await resolveTestTraffic({ by: "manageToken", token: "tok-real" })).toBe(false);
  });

  // The failure path. An unreadable marker must fail toward COUNTING the attempt:
  // counting a canary call as real adds noise a human can see, while marking a
  // real one as test hides a customer failure from the only check watching for it,
  // and nothing anywhere would report that it happened.
  it("counts the attempt when the lookup FAILS, rather than silently hiding it", async () => {
    bookingMaybeSingle.mockResolvedValue({ data: null, error: { message: "timeout" } });
    expect(await resolveTestTraffic({ by: "manageToken", token: "tok" })).toBe(false);
    expect(logged.warn).toHaveBeenCalled();
  });

  it("counts the attempt when no booking matches the token", async () => {
    bookingMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await resolveTestTraffic({ by: "manageToken", token: "nope" })).toBe(false);
  });

  it("counts the attempt when the lookup throws", async () => {
    bookingMaybeSingle.mockRejectedValue(new Error("socket hang up"));
    expect(await resolveTestTraffic({ by: "manageToken", token: "tok" })).toBe(false);
    expect(logged.warn).toHaveBeenCalled();
  });
});

describe("resolveTestTraffic, by bucket code", () => {
  it("marks a SMOKE bucket attempt as test", async () => {
    bucketMaybeSingle.mockResolvedValue({ data: { is_test: true }, error: null });
    expect(await resolveTestTraffic({ by: "bucket", code: "SMOKE" })).toBe(true);
    expect(from).toHaveBeenCalledWith("buckets");
  });

  it("marks a real bucket attempt as NOT test", async () => {
    expect(await resolveTestTraffic({ by: "bucket", code: "411" })).toBe(false);
  });

  it("does not go to the database at all for an empty bucket code", async () => {
    expect(await resolveTestTraffic({ by: "bucket", code: "" })).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it("counts the attempt when the bucket read fails", async () => {
    bucketMaybeSingle.mockResolvedValue({ data: null, error: { message: "relation missing" } });
    expect(await resolveTestTraffic({ by: "bucket", code: "SMOKE" })).toBe(false);
    expect(logged.warn).toHaveBeenCalled();
  });
});

describe("resolveTestTraffic, unidentifiable", () => {
  it("counts an attempt refused before anything identifying was read", async () => {
    expect(
      await resolveTestTraffic({ by: "unidentifiable", why: "auth refused before the body" }),
    ).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });
});

// #2752: the host page class the tally stores beside the test marker. Judged by the
// off site page's own predicate, so a tester on a real code from a page that is not
// the production site is kept out of the failure rate, and a lead is not.
describe("resolveTrafficMarkers, the host page class", () => {
  const host = (parentOrigin: string | null, referrer: string | null = null) => ({
    prefill: parentOrigin === null ? null : { parentOrigin },
    referrer_origin: referrer,
  });

  it("classes a real bucket attempt from localhost as off site, and still reads the bucket", async () => {
    expect(await resolveTrafficMarkers({ by: "bucket", code: "100", host: host("http://localhost:3000") })).toEqual({
      isTest: false,
      hostClass: "offsite",
    });
    expect(from).toHaveBeenCalledWith("buckets");
  });

  it("classes the production site as production", async () => {
    expect(
      (await resolveTrafficMarkers({ by: "bucket", code: "100", host: host("https://www.trypennie.com") })).hostClass,
    ).toBe("production");
  });

  it("classes a page that framed the booker without declaring itself as off site", async () => {
    expect(
      (await resolveTrafficMarkers({ by: "bucket", code: "100", host: host(null, "https://dev.trypennie.com") })).hostClass,
    ).toBe("offsite");
  });

  it("classes an attempt with no host recorded as none, which still counts", async () => {
    expect((await resolveTrafficMarkers({ by: "bucket", code: "100", host: host(null) })).hostClass).toBe("none");
  });

  it("reads a reschedule's host off the booking it names, in the same lookup as its bucket", async () => {
    bookingMaybeSingle.mockResolvedValue({
      data: { prefill: { parentOrigin: "http://localhost:3000" }, referrer_origin: null, buckets: { is_test: false } },
      error: null,
    });
    expect(await resolveTrafficMarkers({ by: "manageToken", token: "tok" })).toEqual({ isTest: false, hostClass: "offsite" });
    expect(bookingMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it("counts a reschedule whose booking cannot be read as real with no host, and says so", async () => {
    bookingMaybeSingle.mockResolvedValue({ data: null, error: { message: "timeout" } });
    expect(await resolveTrafficMarkers({ by: "manageToken", token: "tok" })).toEqual({ isTest: false, hostClass: "none" });
    expect(logged.warn).toHaveBeenCalled();
  });

  it("counts an unidentifiable attempt as real with no host, without a read", async () => {
    expect(await resolveTrafficMarkers({ by: "unidentifiable", why: "auth refused" })).toEqual({
      isTest: false,
      hostClass: "none",
    });
    expect(from).not.toHaveBeenCalled();
  });
});

// #3461: the tally asks this once per booking API attempt, after the answer. In a burst
// of a hundred confirms that was 145 identical one row reads inside five seconds (load
// run 37581963075), each queued 3 to 4 seconds in the API layer while the winning
// confirm was still writing its booking, which stretched its commit to 7.5 seconds and
// timed out the confirms behind it. A bucket's test flag changes almost never, so one
// server reads each code at most once a minute, and concurrent askers share one read.
describe("resolveTestTraffic, by bucket, read once per server per minute (#3461)", () => {
  it("shares one read among concurrent askers for the same code", async () => {
    let release: (v: unknown) => void = () => {};
    bucketMaybeSingle.mockImplementation(() => new Promise((r) => (release = r)));
    const asks = Array.from({ length: 5 }, () => resolveTestTraffic({ by: "bucket", code: "120" }));
    release({ data: { is_test: true }, error: null });
    expect(await Promise.all(asks)).toEqual([true, true, true, true, true]);
    expect(bucketMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it("answers a later ask inside the minute from the first read", async () => {
    expect(await resolveTestTraffic({ by: "bucket", code: "120" })).toBe(false);
    expect(await resolveTestTraffic({ by: "bucket", code: "120" })).toBe(false);
    expect(bucketMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it("reads again once the minute has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T07:00:00Z"));
    await resolveTestTraffic({ by: "bucket", code: "120" });
    vi.setSystemTime(new Date(Date.parse("2026-10-07T07:00:00Z") + BUCKET_TEST_CACHE_MS + 1));
    bucketMaybeSingle.mockResolvedValue({ data: { is_test: true }, error: null });
    expect(await resolveTestTraffic({ by: "bucket", code: "120" })).toBe(true);
    expect(bucketMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("never keeps a FAILED read as an answer: the next ask reads again", async () => {
    bucketMaybeSingle.mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    expect(await resolveTestTraffic({ by: "bucket", code: "120" })).toBe(false);
    expect(logged.warn).toHaveBeenCalled();
    bucketMaybeSingle.mockResolvedValue({ data: { is_test: true }, error: null });
    expect(await resolveTestTraffic({ by: "bucket", code: "120" })).toBe(true);
    expect(bucketMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("keeps each code apart", async () => {
    bucketMaybeSingle.mockResolvedValueOnce({ data: { is_test: true }, error: null });
    bucketMaybeSingle.mockResolvedValueOnce({ data: { is_test: false }, error: null });
    expect(await resolveTestTraffic({ by: "bucket", code: "SMOKE" })).toBe(true);
    expect(await resolveTestTraffic({ by: "bucket", code: "120" })).toBe(false);
    expect(bucketMaybeSingle).toHaveBeenCalledTimes(2);
  });
});
