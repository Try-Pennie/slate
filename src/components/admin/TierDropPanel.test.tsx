// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/booking/timezones", () => ({ deviceTimeZone: () => "America/New_York" }));

import { TierDropPanel } from "@/components/admin/TierDropPanel";
import type { TierDropReport } from "@/lib/admin/tier-drops-load";

// 2026-10-02 (Dan): a manager never reads a raw bucket code. In the drop list a
// manager reads the backend of the code the lead came in on, since the Tier
// column beside it already names the tier; an admin keeps the code exactly as
// before.

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
    behind: { week: { race: 0, line: 0, claimed: 0 }, month: { race: 0, line: 0, claimed: 0 } },
  },
  booked: { week: 10, month: 10 },
});

describe("the tier drop list, by who is reading", () => {
  // Dan, 2026-10-02: the Tier column already says the tier, so for a manager the
  // second column names only the backend, and the tier is said once per row.
  it("shows a manager the backend only, so the tier is said once in the row", () => {
    render(<TierDropPanel report={report("532")} showCodes={false} />);
    expect(screen.getByRole("columnheader", { name: "Backend" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Bucket" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Pool" })).toBeNull();
    expect(screen.getByRole("cell", { name: "Achieve" })).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "532" })).toBeNull();
    const row = screen.getByRole("cell", { name: "Achieve" }).closest("tr")!;
    expect(row.textContent!.match(/Ultra High/g)).toHaveLength(1);
  });

  it("names the backend digits that set no backend the way the vocabulary does", () => {
    render(<TierDropPanel report={report("512")} showCodes={false} />);
    expect(screen.getByRole("cell", { name: "Both" })).toBeTruthy();
  });

  it("falls back to the code outside the matrix rather than drawing nothing", () => {
    render(<TierDropPanel report={report("SMOKE")} showCodes={false} />);
    expect(screen.getByRole("cell", { name: "SMOKE" })).toBeTruthy();
  });

  it("shows an admin the code, as today", () => {
    render(<TierDropPanel report={report("532")} showCodes />);
    expect(screen.getByRole("columnheader", { name: "Bucket" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "532" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Backend" })).toBeNull();
    expect(screen.queryByRole("cell", { name: "Achieve" })).toBeNull();
  });
});

// #3338: a confirm that loses the insert race, or waits in line while the ones ahead
// of it book, now walks on down its routing instead of being told the time is taken,
// and since #3489 one may walk past advisors other leads are still booking. Every
// branch is counted here apart from the tier drops, and drawn even at zero, so a
// branch that never fires is seen (L551).
describe("drops made behind leads confirming the same time", () => {
  const withBehind = (behind: TierDropReport["counts"]["behind"], quiet = false): TierDropReport => {
    const r = report("532");
    if (quiet) {
      r.counts.week = tally(0);
      r.counts.month = tally(0);
      r.counts.recent = [];
    }
    r.counts.behind = behind;
    return r;
  };

  // The body rows of the table counting these drops, each as its two window counts.
  const behindRows = () => {
    const table = screen.getByRole("columnheader", { name: /Booked further down their routing/ }).closest("table")!;
    return [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
  };

  it("counts each branch in both windows", () => {
    render(<TierDropPanel report={withBehind({ week: { race: 1, line: 2, claimed: 5 }, month: { race: 3, line: 4, claimed: 6 } })} showCodes={false} />);
    const race = screen.getByText(/Lost their advisor to a lead confirming at the same moment/).closest("tr")!;
    expect([...race.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["1", "3"]);
    const line = screen.getByText(/Waited behind leads confirming the same time/).closest("tr")!;
    expect([...line.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["2", "4"]);
    // #3531: the claimed branch was counted and never drawn.
    const claimed = screen.getByText(/Walked past advisors other leads were still booking/).closest("tr")!;
    expect([...claimed.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["5", "6"]);
  });

  // #3531: the rows came from a hand written list that stopped at two of three kinds.
  // Every kind the tally carries is given its own count here, so a kind added to the
  // tally and left off the page fails this rather than reading as a quiet zero.
  it("draws one row for every kind the tally carries", () => {
    const week = { race: 11, line: 12, claimed: 13 };
    const month = { race: 21, line: 22, claimed: 23 };
    render(<TierDropPanel report={withBehind({ week, month })} showCodes={false} />);
    const kinds = Object.keys(week) as (keyof typeof week)[];
    expect(behindRows()).toHaveLength(kinds.length);
    for (const k of kinds) expect(behindRows()).toContainEqual([String(week[k]), String(month[k])]);
  });

  it("draws every branch at zero rather than leaving it out", () => {
    render(<TierDropPanel report={withBehind({ week: { race: 0, line: 0, claimed: 0 }, month: { race: 0, line: 0, claimed: 0 } })} showCodes={false} />);
    expect(behindRows()).toEqual([["0", "0"], ["0", "0"], ["0", "0"]]);
  });

  it("is drawn in a month with no tier drop, since a sideways move is not one", () => {
    render(<TierDropPanel report={withBehind({ week: { race: 0, line: 1, claimed: 0 }, month: { race: 0, line: 1, claimed: 0 } }, true)} showCodes={false} />);
    expect(screen.getByText(/No lead has dropped a tier/)).toBeTruthy();
    const line = screen.getByText(/Waited behind leads confirming the same time/).closest("tr")!;
    expect([...line.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["1", "1"]);
  });
});
