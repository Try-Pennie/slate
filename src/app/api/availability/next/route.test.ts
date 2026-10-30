import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
// #4390: a program lead's times. The rules are pinned by scripts/test-program-lead-times.ts;
// the tests at the foot of this file prove the route's part.
const programTimes = vi.hoisted(() => ({
  programLeadTimesLive: vi.fn(async (input: { realSlots: string[] }) => ({
    slots: input.realSlots,
    placeholderStarts: [] as string[],
    outcome: "program" as string,
  })),
}));
vi.mock("@/lib/booking/program-lead-times-live", () => programTimes);

import { NextRequest } from "next/server";
import { HIDDEN_TEST_BUCKET_CODES, PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { TEST_PASS_HEADER, TEST_PASS_REFUSAL_CODES } from "@/lib/embed/test-pass-header";
import { TEST_PASS_TTL_MS, mintTestPass } from "@/lib/embed/test-pass";
import { log } from "@/lib/log";
import { PROGRAM_LEAD_HEADER } from "@/lib/booking/program-lead-header";
import { GET } from "./route";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];
const SECRET = "n".repeat(64);
const goodPass = () => mintTestPass({ code: PUBLIC_TEST, secret: SECRET, nowMs: Date.now() }).value;

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

const get = (query = "?bucket=411", pass?: string) =>
  GET(
    new NextRequest(`http://localhost/api/availability/next${query}`, {
      headers: pass ? { [TEST_PASS_HEADER]: pass } : {},
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMBED_TEST_PASS_SECRET", SECRET);
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
    const res = await get(`?bucket=${PUBLIC_TEST}`, goodPass());
    expect(res.status).toBe(200);
    expect((await res.json()).slots).toEqual([day.toISOString()]);
  });

  // #2666: and only with the pass `/book` handed an approved page. Refused before
  // the walk starts, since this is the most expensive read a browser can make.
  it("refuses the public test bucket with no pass, before computing anything", async () => {
    const res = await get(`?bucket=${PUBLIC_TEST}`);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TEST_PASS_REFUSAL_CODES.refused);
    expect(service.getBucketSlots).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "embed-test",
      expect.objectContaining({ reason: "missing", route: "availability-next" }),
    );
  });

  it("refuses an expired pass with its own code", async () => {
    const stale = mintTestPass({ code: PUBLIC_TEST, secret: SECRET, nowMs: Date.now() - TEST_PASS_TTL_MS - 1 }).value;
    const res = await get(`?bucket=${PUBLIC_TEST}`, stale);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(TEST_PASS_REFUSAL_CODES.expired);
  });

  it("a good pass for the public bucket presented with the canary's code still 404s", async () => {
    computeReturning([], { isTest: true });
    const res = await get(`?bucket=${HIDDEN_TEST_BUCKET_CODES[0]}`, goodPass());
    expect(res.status).toBe(404);
  });

  it("returns the generic 500 when the compute throws", async () => {
    service.getBucketSlots.mockRejectedValue(new Error("google is down"));
    const res = await get();
    expect(res.status).toBe(500);
    // No internals in the body.
    expect(JSON.stringify(await res.json())).not.toMatch(/google is down/);
  });
});

// #4390: the look further ahead past a closure, for a program lead. The placeholder's
// starts are offered beside whatever real times the walk finds, from the day after the
// ordinary search stopped, and the answer keeps the first days offered as it always has.
describe("GET /api/availability/next for a program lead (#4390)", () => {
  const NOW = Date.parse("2026-06-08T12:00:00.000Z"); // Monday 08:00 Eastern
  const TOKEN = "00Q5f00000AbCdE.new.9999999999999.abc";
  const EVENT = { duration_min: 20, slot_interval_min: 30, min_notice_min: 0 };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    hours.loadBusinessHoursCached.mockResolvedValue({
      zone: "America/New_York",
      rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 540, end_minute: 1080 })),
      source: "stored" as const,
    });
    settings.loadBookingHorizonDays.mockResolvedValue(2);
    // A closure: the walk finds no real times anywhere.
    service.getBucketSlots.mockResolvedValue({ bucket: { code: "411", is_test: false }, eventType: EVENT, orgName: "Pennie", slots: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function next(query = "", token: string | null = TOKEN) {
    const headers = new Headers();
    if (token) headers.set(PROGRAM_LEAD_HEADER, token);
    return GET(new NextRequest(`http://localhost/api/availability/next?bucket=411${query}`, { headers }));
  }

  it("never asks for an ordinary lead", async () => {
    const body = await (await next("", null)).json();
    expect(programTimes.programLeadTimesLive).not.toHaveBeenCalled();
    expect(body.slots).toEqual([]);
  });

  it("asks for the placeholder's starts from the day after the ordinary search stopped, with the zone", async () => {
    await next("&leadZone=America%2FChicago");
    // The ordinary search covers 2 + 2 calendar days from Monday: through Thursday.
    expect(programTimes.programLeadTimesLive).toHaveBeenCalledWith({
      token: TOKEN,
      leadZone: "America/Chicago",
      realSlots: [],
      eventType: EVENT,
      fromMs: Date.parse("2026-06-12T04:00:00.000Z"),
    });
  });

  it("serves the merged times, keeping only the first days offered", async () => {
    const friday = "2026-06-12T13:00:00.000Z";
    const monday = "2026-06-15T13:00:00.000Z";
    const tuesday = "2026-06-16T13:00:00.000Z";
    programTimes.programLeadTimesLive.mockResolvedValueOnce({
      slots: [friday, monday, tuesday],
      placeholderStarts: [friday, monday, tuesday],
      outcome: "program",
    });
    const body = await (await next()).json();
    expect(body.slots).toEqual([friday, monday]);
  });
});
