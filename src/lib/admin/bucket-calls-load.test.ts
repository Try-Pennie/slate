import { describe, it, expect, vi, beforeEach } from "vitest";

// The reads behind Bucket availability's calls (#3939). The adding up is driven natively by
// scripts/test-bucket-calls.ts; what only this layer can get wrong is a failed read arriving as a
// pool with no room, the reading that sends somebody to staff a pool that was fine (L10).
const capacity = vi.hoisted(() => ({ loadCapacityRules: vi.fn(), loadCapacityPeople: vi.fn() }));
vi.mock("@/lib/admin/team-capacity-load", () => capacity);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { loadPoolCalls } from "./bucket-calls-load";

const Z = "America/New_York";
const hours = { zone: Z, source: "stored" as const, exceptions: [], rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })) };
const eventType = { duration_min: 20, slot_interval_min: 10, min_notice_min: 5, buffer_before_min: 10, buffer_after_min: 10, daily_cap: null };
const member = (userId: string) => ({ userId, timezone: Z, rules: [2].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })), busy: [], bookingStartsMs: [], dayCounts: new Map() });
const NOW = Date.parse("2026-10-19T12:00:00Z"); // Monday 8 AM in New York
const DAYS = ["2026-10-20"];

beforeEach(() => {
  vi.clearAllMocks();
  capacity.loadCapacityRules.mockResolvedValue({ ok: true, value: { hours, eventType, bucket: {} } });
  capacity.loadCapacityPeople.mockResolvedValue({
    ok: true,
    value: { roster: [{ id: "a1", name: "A", email: "a@x.test" }, { id: "a2", name: "B", email: "b@x.test" }], members: [member("a1"), member("a2")], timeOff: new Map(), failingEmails: new Set() },
  });
});

describe("loadPoolCalls (#3939)", () => {
  it("adds up each pool's own advisors' calls, measured with the booker's rules", async () => {
    const calls = await loadPoolCalls("org", new Map([["110", ["a1", "a2"]], ["120", ["a1"]]]), DAYS, NOW);
    const one = calls?.get("120")?.get(DAYS[0]);
    // An empty Tuesday shift of 9 to 5 holds a call every 30 minutes (20 plus the 10 minute gap).
    expect(one?.taken).toBe(0);
    expect(one?.capacity).toBeGreaterThan(10);
    expect(calls?.get("110")?.get(DAYS[0])).toEqual({ taken: 0, capacity: one!.capacity * 2 });
    expect(capacity.loadCapacityPeople).toHaveBeenCalledWith("org", expect.anything(), DAYS);
  });

  it.each([
    ["the call setting", () => capacity.loadCapacityRules.mockResolvedValue({ ok: false, reason: "event-type" })],
    ["the calendars", () => capacity.loadCapacityPeople.mockResolvedValue({ ok: false, reason: "calendars", err: new Error("down") })],
    ["the sync health", () => capacity.loadCapacityPeople.mockResolvedValue({ ok: false, reason: "calendar-sync" })],
    ["an incomplete availability read", () => capacity.loadCapacityPeople.mockResolvedValue({ ok: true, value: { roster: [{ id: "a1", name: "A", email: "a@x.test" }], members: [], timeOff: new Map(), failingEmails: new Set() } })],
  ])("answers unknown when %s cannot be read, never a pool with no room", async (_what, fail) => {
    fail();
    expect(await loadPoolCalls("org", new Map([["110", ["a1"]]]), DAYS, NOW)).toBeNull();
  });

  it("gives every pool no calls when nobody is bookable, which is a state rather than a failed read", async () => {
    capacity.loadCapacityPeople.mockResolvedValue({ ok: false, reason: "no-advisors" });
    const calls = await loadPoolCalls("org", new Map([["110", ["a1"]]]), DAYS, NOW);
    expect(calls?.get("110")?.get(DAYS[0])).toEqual({ taken: 0, capacity: 0 });
  });
});
