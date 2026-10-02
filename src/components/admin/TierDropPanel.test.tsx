// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/booking/timezones", () => ({ deviceTimeZone: () => "America/New_York" }));

import { TierDropPanel } from "@/components/admin/TierDropPanel";
import type { TierDropReport } from "@/lib/admin/tier-drops-load";

// 2026-10-02 (Dan): a manager never reads a raw bucket code. The drop list names
// the pool the lead came in on, the way staffing depth names it; an admin keeps
// the code exactly as before.

const tally = (lost: number) => ({
  "lost-at-confirm": lost,
  "nothing-on-show": 0,
  "not-recorded": 0,
  total: lost,
});

const report = (bucketCode: string): TierDropReport => ({
  counts: {
    week: tally(1),
    month: tally(1),
    recent: [
      {
        id: "d1",
        createdAt: "2026-10-01T21:07:26Z",
        cause: "lost-at-confirm",
        requestedLabel: "Ultra High",
        bookedLabel: "Very High",
        bucketCode,
      },
    ],
    unreadableStamps: 0,
  },
  booked: { week: 10, month: 10 },
});

describe("the tier drop list, by who is reading", () => {
  it("shows a manager the pool in words and no code", () => {
    render(<TierDropPanel report={report("532")} showCodes={false} />);
    expect(screen.getByRole("columnheader", { name: "Pool" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Bucket" })).toBeNull();
    expect(screen.getByRole("cell", { name: "Ultra High with Achieve" })).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "532" })).toBeNull();
  });

  it("falls back to the code outside the matrix rather than drawing nothing", () => {
    render(<TierDropPanel report={report("SMOKE")} showCodes={false} />);
    expect(screen.getByRole("cell", { name: "SMOKE" })).toBeTruthy();
  });

  it("shows an admin the code, as today", () => {
    render(<TierDropPanel report={report("532")} showCodes />);
    expect(screen.getByRole("columnheader", { name: "Bucket" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "532" })).toBeTruthy();
    expect(screen.queryByText("Ultra High with Achieve")).toBeNull();
  });
});
