import { describe, it, expect, vi, beforeEach } from "vitest";

// #1329 / #1339: the first bookable days past a closure, computed on demand.
//
// The walk itself is tested in scripts/test-next-available.ts. What belongs here is
// the route's part, and every assertion is about a cost or a leak rather than about
// the days themselves:
//
//   * it starts where the ordinary search gave up, so no ground is computed twice;
//   * it never writes the slot cache, because these days sit OUTSIDE the horizon
//     every cached row is keyed on, and a row holding them would be read back by
//     the ordinary path as though they were inside it;
//   * it is rate limited, since it is strictly more expensive per call than
//     /api/availability and sits behind a button anyone can press;
//   * a hidden test bucket 404s exactly like an unknown one, so a lead can never
//     learn one exists (#396).

const service = vi.hoisted(() => ({ getBucketSlots: vi.fn() }));
const rateLimit = vi.hoisted(() => ({
  availabilityWithinLimit: vi.fn(async () => true),
  clientIp: () => "203.0.113.7",
}));
const hours = vi.hoisted(() => ({
  loadBusinessHoursCached: vi.fn(async () => ({
    zone: "America/New_York",
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
    source: "stored" as const,
  })),
}));
const settings = vi.hoisted(() => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));
const slotCache = vi.hoisted(() => ({
  writeBucketSlotsRow: vi.fn(),
  getCachedBucketSlots: vi.fn(),
  getBucketSlotsWithFallback: vi.fn(),
}));

vi.mock("@/lib/availability/service", () => service);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/booking/business-hours-load", () => hours);
vi.mock("@/lib/booking/settings", () => settings);
vi.mock("@/lib/availability/slot-cache", () => slotCache);
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { GET } from "./route";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];

const EVENT_TYPE = { name: "Call", description: null, duration_min: 20, min_notice_min: 0 };

/** A compute that answers with slots inside the requested window. */
function computeReturning(slots: string[], opts?: { isTest?: boolean }) {
  service.getBucketSlots.mockImplementation(async (_c: string, from: string, to: string) => ({
    bucket: { code: "411", is_test: opts?.isTest ?? false },
    eventType: EVENT_TYPE,
    orgName: "Pennie",
    slots: slots.filter((s) => Date.parse(s) >= Date.parse(from) && Date.parse(s) <= Date.parse(to)),
  }));
}

const get = (query = "?bucket=411") =>
  GET(new NextRequest(`http://localhost/api/availability/next${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.availabilityWithinLimit.mockResolvedValue(true);
  hours.loadBusinessHoursCached.mockResolvedValue({
    zone: "America/New_York",
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
    source: "stored" as const,
  });
  settings.loadBookingHorizonDays.mockResolvedValue(4);
});

describe("GET /api/availability/next (#1329, #1339)", () => {
  it("starts the walk past the window the ordinary search already covered", async () => {
    computeReturning([]);
    await get();

    expect(service.getBucketSlots).toHaveBeenCalled();
    const firstFrom = Date.parse(service.getBucketSlots.mock.calls[0][1] as string);
    // horizon 4 + the 2 day closed-run allowance = 6 days already searched, so the
    // walk must begin on day 6 at the earliest, never re-computing empty ground.
    expect(firstFrom).toBeGreaterThan(Date.now() + 5 * 86_400_000);
  });

  it("never writes the slot cache with these out-of-horizon days", async () => {
    computeReturning([new Date(Date.now() + 20 * 86_400_000).toISOString()]);
    const res = await get();

    expect(res.status).toBe(200);
    expect(slotCache.writeBucketSlotsRow).not.toHaveBeenCalled();
    // And it tells shared caches not to keep the response either.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns the slots it found", async () => {
    const day = new Date(Date.now() + 20 * 86_400_000);
    day.setHours(14, 0, 0, 0);
    computeReturning([day.toISOString()]);

    const body = await (await get()).json();
    expect(body.slots).toEqual([day.toISOString()]);
  });

  it("returns an empty list, not an error, when nothing is bookable at all", async () => {
    computeReturning([]);
    const res = await get();

    // The live state while the routing pool is off. An empty answer is honest; an
    // error would make the booker show a broken state for a working system.
    expect(res.status).toBe(200);
    expect((await res.json()).slots).toEqual([]);
  });

  it("is rate limited on the same window as the ordinary availability read", async () => {
    rateLimit.availabilityWithinLimit.mockResolvedValue(false);
    const res = await get();

    expect(res.status).toBe(429);
    // Nothing computed: the limit has to bite BEFORE the expensive walk, or it
    // protects nothing.
    expect(service.getBucketSlots).not.toHaveBeenCalled();
  });

  it("400s a request with no bucket, before computing anything", async () => {
    const res = await get("");
    expect(res.status).toBe(400);
    expect(service.getBucketSlots).not.toHaveBeenCalled();
  });

  it("404s an unknown bucket", async () => {
    service.getBucketSlots.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  // #396: a real lead must never learn a hidden test bucket exists, so it gets the
  // identical 404 an unknown code gets.
  it("404s a hidden test bucket exactly like an unknown one", async () => {
    computeReturning([new Date(Date.now() + 20 * 86_400_000).toISOString()], { isTest: true });
    const res = await get();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown bucket" });
  });

  // #2660: the PUBLIC test bucket counts as existing here, so a partner's tester
  // who lands during a closure can press the button like a lead can. The hidden
  // buckets keep the 404 above: the two are told apart by the code, in the one
  // module that lists them, never by a flag a caller could set.
  it("counts the public test bucket as existing, offering its days past a closure", async () => {
    const day = new Date(Date.now() + 20 * 86_400_000);
    day.setHours(14, 0, 0, 0);
    service.getBucketSlots.mockImplementation(async (_c: string, from: string, to: string) => ({
      bucket: { code: PUBLIC_TEST, is_test: true },
      eventType: EVENT_TYPE,
      orgName: "Pennie",
      slots: [day.toISOString()].filter(
        (s) => Date.parse(s) >= Date.parse(from) && Date.parse(s) <= Date.parse(to),
      ),
    }));
    const res = await get(`?bucket=${PUBLIC_TEST}`);
    expect(res.status).toBe(200);
    expect((await res.json()).slots).toEqual([day.toISOString()]);
  });

  it("returns the generic 500 when the compute throws", async () => {
    service.getBucketSlots.mockRejectedValue(new Error("google is down"));
    const res = await get();
    expect(res.status).toBe(500);
    // No internals in the body.
    expect(JSON.stringify(await res.json())).not.toMatch(/google is down/);
  });
});
