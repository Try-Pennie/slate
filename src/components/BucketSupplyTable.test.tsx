// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BucketSupplyTable } from "./BucketSupplyTable";
import { supplyCellTitle, freshnessLabel } from "@/lib/admin/bucket-supply-copy";
import type { BucketSupplyRow, SupplyCell, SupplyDay } from "@/lib/admin/bucket-supply";

// A cell's visible content is a bare number or a single letter (#1254), so the
// sentence behind it is the content, and it is all a screen reader gets. A static
// check on the copy builder cannot prove that sentence reaches the screen, and a
// table whose numbers were right while its sentences were stale would read as a
// working screen to everybody who can see the tints and as nothing at all to
// everybody who cannot.
//
// The failure path is the one that matters most here: a bucket whose cache could
// not be read must not put a number on the screen at all, because a zero on this
// page means "this pool is offering nothing today", which is the opposite claim.

const DAYS: SupplyDay[] = [
  { iso: "2026-08-04", weekday: 2 },
  { iso: "2026-08-05", weekday: 3 },
];

function row(over: Partial<BucketSupplyRow> = {}): BucketSupplyRow {
  return {
    code: "120",
    name: "Low | Beyond | No Legal Param",
    depth: 4,
    effectiveDepth: 3,
    cacheState: "measured",
    computedAtMs: Date.parse("2026-08-04T15:18:30.000Z"),
    freshness: "fresh",
    cells: [
      { kind: "counted", open: 9, max: 21, share: 9 / 21 },
      { kind: "counted", open: 21, max: 21, share: 1 },
    ],
    ...over,
  };
}

function renderTable(rows: BucketSupplyRow[], over: { depthReadable?: boolean; bucketListReadable?: boolean } = {}) {
  render(
    <BucketSupplyTable
      days={DAYS}
      rows={rows}
      zone="America/New_York"
      depthReadable={over.depthReadable ?? true}
      bucketListReadable={over.bucketListReadable ?? true}
    />,
  );
}

describe("BucketSupplyTable (#1254)", () => {
  it("says what every cell means, in the words the builder produces", () => {
    const cells: SupplyCell[] = [
      { kind: "counted", open: 9, max: 21, share: 9 / 21 },
      { kind: "closed" },
    ];
    renderTable([row({ cells })]);

    // The exact builder output, on screen. Anything less would let the component
    // drift back to holding its own sentence while the builder read fine (L41).
    expect(
      screen.getByText(
        supplyCellTitle(cells[0], "120 Low | Beyond | No Legal Param", "Tuesday 4 August"),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        supplyCellTitle(cells[1], "120 Low | Beyond | No Legal Param", "Wednesday 5 August"),
      ),
    ).toBeTruthy();
  });

  it("shows a measured cell as open over the maximum, with its share", () => {
    renderTable([row()]);
    expect(screen.getByText("9 / 21")).toBeTruthy();
    expect(screen.getByText("43%")).toBeTruthy();
    expect(screen.getByText("21 / 21")).toBeTruthy();
  });

  it("renders an unreadable bucket as unknown, never as a zero", () => {
    renderTable([
      row({
        cacheState: "unreadable",
        computedAtMs: null,
        freshness: "unknown",
        cells: [{ kind: "unknown" }, { kind: "unknown" }],
      }),
    ]);

    // Not a single figure anywhere: no count, no maximum, no share. A zero here
    // would be read as "this pool is offering nothing", which is a claim nothing
    // measured.
    const marks = [...document.querySelectorAll("td > span > span[aria-hidden='true']")].map(
      (n) => n.textContent ?? "",
    );
    expect(marks).toEqual(["?", "?"]);
    expect(screen.queryByText("0 / 21")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();

    // And the sentence says WHY, rather than saying nothing.
    expect(
      screen.getAllByText(/could not be checked, because this pool's cached answer/).length,
    ).toBe(2);
  });

  it("tells a genuinely empty bucket apart from an unreadable one", () => {
    renderTable([
      row({
        cells: [
          { kind: "counted", open: 0, max: 21, share: 0 },
          { kind: "unknown" },
        ],
      }),
    ]);
    // The empty day is a real, hard zero: that is the answer the page exists for.
    expect(screen.getByText("0 / 21")).toBeTruthy();
    expect(screen.getByText(/nothing open\. The day could have held 21\./)).toBeTruthy();
    // The unmeasured day beside it stays silent about counts.
    expect(screen.getByText(/could not be checked/)).toBeTruthy();
  });

  it("keeps a day past the pool's own horizon out of the booked out reading", () => {
    renderTable([
      row({ cells: [{ kind: "counted", open: 4, max: 21, share: 4 / 21 }, { kind: "beyond-horizon" }] }),
    ]);
    const marks = [...document.querySelectorAll("td > span > span[aria-hidden='true']")].map(
      (n) => n.textContent ?? "",
    );
    expect(marks).toEqual(["4 / 21", "19%", "H"]);
    expect(screen.getByText(/past this pool's horizon\. It found its allowance/)).toBeTruthy();
    expect(screen.queryByText("0 / 21")).toBeNull();
  });

  it("shows a stale row as stale rather than as a current answer", () => {
    renderTable([row({ freshness: "stale" })]);
    const label = freshnessLabel("stale");
    const el = screen.getByText(label.label);
    expect(el.className).toContain("text-error");
    expect(el.getAttribute("title")).toBe(label.meaning);
  });

  it("says an unreadable roster is unknown depth, not zero agents", () => {
    renderTable([row({ depth: null, effectiveDepth: null })], { depthReadable: false });
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getByText(/roster could not be read/)).toBeTruthy();
    expect(screen.queryByText("0", { selector: "td span" })).toBeNull();
  });

  it("groups the rows by the backend digit so a thin family stands out", () => {
    renderTable([
      row({ code: "110", name: "Low | Both | No Legal Param" }),
      row({ code: "120", name: "Low | Beyond | No Legal Param" }),
      row({ code: "220", name: "Medium | Beyond | No Legal Param" }),
    ]);
    const groups = [...document.querySelectorAll("th[scope='rowgroup']")].map(
      (n) => n.textContent ?? "",
    );
    expect(groups).toEqual(["Both", "Beyond"]);
  });
});
