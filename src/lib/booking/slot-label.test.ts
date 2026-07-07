import { describe, it, expect } from "vitest";

import { formatSlotTime, formatSlotDay, groupSlotsByDay } from "@/lib/booking/slot-label";

// #635: reschedule slot buttons showed a bare weekday + time ("Thu 2:30 PM") and
// silently dropped everything past slice(0,30)/slice(0,12). Every slot must now
// sit under a dated day heading, and the whole horizon must render uncapped.
// A fixed zone keeps the expected strings deterministic across CI machines.
const ET = "America/New_York";

describe("slot-label", () => {
  it("formats a day heading with weekday, month and day", () => {
    // 2026-07-03T18:30:00Z = 2:30 PM EDT, a Friday.
    expect(formatSlotDay("2026-07-03T18:30:00.000Z", ET)).toBe("Fri, Jul 3");
  });

  it("formats a slot time without a date", () => {
    expect(formatSlotTime("2026-07-03T18:30:00.000Z", ET)).toBe("2:30 PM");
  });

  it("groups slots into dated day sections across a >7-day span, in order", () => {
    // Fri Jul 3, Sun Jul 5, Sat Jul 11: a bare weekday can't disambiguate these
    // once the span exceeds a week, which is exactly the ambiguity #635 flags.
    const slots = [
      "2026-07-03T14:00:00.000Z",
      "2026-07-03T15:00:00.000Z",
      "2026-07-05T16:00:00.000Z",
      "2026-07-11T17:00:00.000Z",
    ];
    const days = groupSlotsByDay(slots, ET);
    expect(days.map((d) => d.heading)).toEqual(["Fri, Jul 3", "Sun, Jul 5", "Sat, Jul 11"]);
    expect(days[0]!.slots).toHaveLength(2);
    // Every slot is preserved under a dated heading; nothing is dropped.
    expect(days.reduce((n, d) => n + d.slots.length, 0)).toBe(slots.length);
  });

  it("renders every slot uncapped, past the old 30/12 limits", () => {
    // 40 half-hour slots. The old slice(0,30) / slice(0,12) dropped the tail.
    const slots = Array.from({ length: 40 }, (_, i) => {
      const h = String(Math.floor(i / 2)).padStart(2, "0");
      const m = i % 2 === 0 ? "00" : "30";
      return `2026-07-03T${h}:${m}:00.000Z`;
    });
    const days = groupSlotsByDay(slots, ET);
    expect(days.reduce((n, d) => n + d.slots.length, 0)).toBe(40);
  });

  it("assigns a slot to the correct calendar day in the target zone", () => {
    // 03:30Z on Jul 3 is 11:30 PM EDT on Jul 2, so it must group under Jul 2.
    const days = groupSlotsByDay(["2026-07-03T03:30:00.000Z"], ET);
    expect(days).toHaveLength(1);
    expect(days[0]!.heading).toBe("Thu, Jul 2");
  });
});
