import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  FULL_FAILURE_STREAK_WINDOW_S,
  fullFailureWaits,
  isCanaryQuietHour,
} from "./smoke-canary-failure";

// #1493: the full canary pass runs hourly, and overnight (9pm to 8am ET) a failure
// pages only on the second in a row, so one flaky run does not wake anybody while a
// real break still pages within two hours (Dan, 2026-10-16).

const et = (iso: string) => DateTime.fromISO(iso, { zone: "America/New_York" }).toMillis();

describe("isCanaryQuietHour", () => {
  it("is quiet from 9pm up to 8am Eastern, and not at either edge's daytime side", () => {
    expect(isCanaryQuietHour(et("2026-10-16T20:59:59"))).toBe(false);
    expect(isCanaryQuietHour(et("2026-10-16T21:00:00"))).toBe(true);
    expect(isCanaryQuietHour(et("2026-10-17T03:00:00"))).toBe(true);
    expect(isCanaryQuietHour(et("2026-10-17T07:59:59"))).toBe(true);
    expect(isCanaryQuietHour(et("2026-10-17T08:00:00"))).toBe(false);
    expect(isCanaryQuietHour(et("2026-10-17T13:00:00"))).toBe(false);
  });

  it("judges the hour in Eastern time on both sides of a clock change, never in UTC", () => {
    // 01:30 UTC is 9:30pm EDT in October and 8:30pm EST in December.
    expect(isCanaryQuietHour(Date.UTC(2026, 9, 17, 1, 30))).toBe(true);
    expect(isCanaryQuietHour(Date.UTC(2026, 11, 17, 1, 30))).toBe(false);
    // 12:30 UTC is 8:30am EDT and 7:30am EST.
    expect(isCanaryQuietHour(Date.UTC(2026, 9, 17, 12, 30))).toBe(false);
    expect(isCanaryQuietHour(Date.UTC(2026, 11, 17, 12, 30))).toBe(true);
  });
});

describe("fullFailureWaits", () => {
  const night = et("2026-10-16T23:10:00");
  const day = et("2026-10-16T14:10:00");

  it("holds the first overnight failure of a run of failures", () => {
    expect(fullFailureWaits(night, "below")).toBe(true);
  });

  it("posts the second overnight failure in a row", () => {
    expect(fullFailureWaits(night, "reached")).toBe(false);
  });

  it("posts when the streak could not be read: an unknown is never a reason to stay quiet", () => {
    expect(fullFailureWaits(night, "unknown")).toBe(false);
  });

  it("never holds a daytime failure, whatever the streak says", () => {
    for (const streak of ["below", "reached", "unknown"] as const) {
      expect(fullFailureWaits(day, streak)).toBe(false);
    }
  });
});

describe("the streak window", () => {
  it("spans a dropped hourly run, so two failures two hours apart still count as in a row", () => {
    // GitHub's schedule has dropped runs for 2 to 3 hours (smoke-canary.yml); two
    // failures with one dropped run between them are 2h apart.
    expect(FULL_FAILURE_STREAK_WINDOW_S).toBeGreaterThan(2 * 60 * 60);
    // and short enough that a failure yesterday evening and one this morning are
    // not "in a row"
    expect(FULL_FAILURE_STREAK_WINDOW_S).toBeLessThan(8 * 60 * 60);
  });
});
