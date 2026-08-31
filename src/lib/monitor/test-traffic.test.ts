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

import { resolveTestTraffic } from "./test-traffic";

beforeEach(() => {
  vi.clearAllMocks();
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
