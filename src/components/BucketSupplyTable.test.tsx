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
      { kind: "counted", booked: 9, capacity: 21, share: 9 / 21 },
      { kind: "counted", booked: 21, capacity: 21, share: 1 },
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
      { kind: "counted", booked: 9, capacity: 21, share: 9 / 21 },
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

  it("leads with the share booked and says what it is a share of", () => {
    renderTable([row()]);
    // #1937: the share leads and its ceiling sits under it, so a zero reads as
    // "none of 21 taken" rather than as a bare zero. The fixture holds two
    // cells against the same ceiling, so the marks are read in order rather
    // than by text, which would match either.
    const marks = [...document.querySelectorAll("td > span > span[aria-hidden='true']")].map(
      (n) => n.textContent ?? "",
    );
    expect(marks).toEqual(["43%", "of 21", "100%", "of 21"]);
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
    // Not one figure: the marks above are the whole visible content of the two
    // cells, so a count, a ceiling or a share appearing would show up there.
    expect(marks.some((m) => /%/.test(m) || /^of /.test(m))).toBe(false);

    // And the sentence says WHY, rather than saying nothing.
    expect(
      screen.getAllByText(/could not be checked, because this pool's cached answer/).length,
    ).toBe(2);
  });

  it("tells a bucket with nobody available apart from an unreadable one", () => {
    renderTable([
      row({
        cells: [
          { kind: "nobody-available" },
          { kind: "unknown" },
        ],
      }),
    ]);
    // #1937: a bucket with no times and nothing booked is its own answer, not a
    // zero share. Under a BOOKED metric a zero reads as "nothing taken yet",
    // which is the healthy state every bucket is in today, so the two would be
    // indistinguishable on the one page that has to tell them apart.
    const marks = [...document.querySelectorAll("td > span > span[aria-hidden='true']")].map(
      (n) => n.textContent ?? "",
    );
    // Its own letter, distinct from the unreadable cell's beside it, and no
    // share at all: there is no ceiling for it to be a share of.
    expect(marks).toEqual(["N", "?"]);
    expect(screen.getByText(/nobody available\. The day had room/i)).toBeTruthy();
    // The unmeasured day beside it stays silent about counts.
    expect(screen.getByText(/could not be checked/)).toBeTruthy();
  });

  it("keeps a day past the pool's own horizon out of the booked out reading", () => {
    renderTable([
      row({ cells: [{ kind: "counted", booked: 4, capacity: 21, share: 4 / 21 }, { kind: "beyond-horizon" }] }),
    ]);
    const marks = [...document.querySelectorAll("td > span > span[aria-hidden='true']")].map(
      (n) => n.textContent ?? "",
    );
    expect(marks).toEqual(["19%", "of 21", "H"]);
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
