import { describe, it, expect } from "vitest";

import { formatSlotTime, formatSlotDay } from "@/lib/booking/slot-label";

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
    // One spelling across the product (#1765), the lowercase form the
    // confirmation copy beside these buttons has always used.
    expect(formatSlotTime("2026-07-03T18:30:00.000Z", ET)).toBe("2:30pm");
  });



});
