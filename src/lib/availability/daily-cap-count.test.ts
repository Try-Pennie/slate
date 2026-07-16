import { describe, it, expect } from "vitest";
import { assembleMemberAvailability, computeBucketSlots } from "./compute";
import type { SlotComputeInput } from "./compute";

// #832: the daily-cap count is supplied per agent as a precomputed local-date -> count
// map (from the server-side RPC) instead of a list of booking instants. These pin that
// assembleMemberAvailability adopts that map and that the slot compute actually enforces
// the cap off it (a day already at cap yields no slots).

const SCHEDULE = { id: "s1", user_id: "u1", timezone: "America/New_York" };
// Monday 2026-07-13, 09:00-17:00 local.
const RULES = [{ schedule_id: "s1", weekday: 1, start_minute: 540, end_minute: 1020 }];

function inputFor(members: ReturnType<typeof assembleMemberAvailability>): SlotComputeInput {
  return {
    members,
    durationMin: 60,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    dailyCap: 1,
    slotIntervalMin: 60,
    from: "2026-07-13T00:00:00.000Z",
    to: "2026-07-14T00:00:00.000Z",
    nowMs: Date.parse("2026-07-13T00:00:00.000Z"),
  };
}

describe("daily-cap count from the server-side RPC map (#832)", () => {
  it("assembleMemberAvailability adopts the per-agent dayCounts map", () => {
    const members = assembleMemberAvailability(
      ["u1"],
      [SCHEDULE],
      RULES,
      [],
      new Map([["u1", new Map([["2026-07-13", 2]])]]),
    );
    expect(members[0].dayCounts?.get("2026-07-13")).toBe(2);
  });

  it("a day already at the cap in dayCounts yields no slots; an empty count yields slots", () => {
    const atCap = assembleMemberAvailability(
      ["u1"],
      [SCHEDULE],
      RULES,
      [],
      new Map([["u1", new Map([["2026-07-13", 1]])]]),
    );
    const underCap = assembleMemberAvailability(
      ["u1"],
      [SCHEDULE],
      RULES,
      [],
      new Map(), // no bookings for u1 -> empty count, under the cap of 1
    );

    expect(computeBucketSlots(inputFor(atCap))).toHaveLength(0);
    expect(computeBucketSlots(inputFor(underCap)).length).toBeGreaterThan(0);
  });
});
