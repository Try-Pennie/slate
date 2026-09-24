import { describe, it, expect, vi, afterEach } from "vitest";
import { DateTime } from "luxon";

import { bookerSlotIso } from "@/components/booker-test-slot";
import { withinLeadCallingWindow } from "@/lib/booking/lead-calling-window";
import { deviceTimeZone, resolveZone } from "@/lib/booking/timezones";

// #2310: the fixture helper exists so a component test's offered slot is inside
// the lead's calling window whatever machine zone and whatever hour the suite
// runs at. These pin both halves: the hour lands where asked in the zone asked,
// and the clock's own time of day no longer moves the answer.
afterEach(() => vi.useRealTimers());

describe("bookerSlotIso", () => {
  it("lands on the asked hour, the asked number of days out, in the zone given", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    const iso = bookerSlotIso(2, 15, "America/New_York");
    const local = DateTime.fromISO(iso).setZone("America/New_York");
    expect(local.toFormat("yyyy-LL-dd HH:mm")).toBe("2026-09-26 15:00");
    expect(iso.endsWith("Z")).toBe(true);
  });

  it("stays inside the calling window at any hour the suite runs, in the booker's zone", () => {
    const zone = resolveZone(deviceTimeZone()).id;
    vi.useFakeTimers({ toFake: ["Date"] });
    // Late evening and early morning UTC, the hours at which "now plus N days"
    // fixtures fell outside 08:00 to 20:00 Eastern.
    for (const now of ["2026-09-24T02:30:00Z", "2026-09-24T23:30:00Z", "2026-09-24T09:00:00Z"]) {
      vi.setSystemTime(new Date(now));
      const iso = bookerSlotIso(3);
      expect(withinLeadCallingWindow(iso, zone)).toBe(true);
      expect(DateTime.fromISO(iso).setZone(zone).hour).toBe(12);
    }
  });

  it("refuses to build a slot in a zone it cannot read, rather than returning junk", () => {
    expect(() => bookerSlotIso(1, 12, "Not/AZone")).toThrow(/could not build a slot in Not\/AZone/);
  });
});
