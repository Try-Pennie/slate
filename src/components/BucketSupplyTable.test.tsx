// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BucketSupplyTable } from "./BucketSupplyTable";
import {
  SUPPLY_SUMMARY_STATES,
  freshnessLabel,
  supplyCellTitle,
  supplyLegendEntry,
} from "@/lib/admin/bucket-supply-copy";
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
    // One pool per code unless a case says otherwise, so the cases written before
    // pooling keep meaning what they meant.
    poolKey: `pool-${over.code ?? "120"}`,
    poolLabel: "Low with Beyond",
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

// Pinned, never `Date.now()`: the age a row renders and the freshness grade it
// was given are two readings of one measurement, so the fixture fixes the
// instant and the assertions are about the wording rather than the clock (L290).
const NOW_MS = Date.parse("2026-08-04T15:20:30.000Z");

function renderTable(
  rows: BucketSupplyRow[],
  over: {
    depthReadable?: boolean;
    bucketListReadable?: boolean;
    nowMs?: number;
    showCodes?: boolean;
  } = {},
) {
  render(
    <BucketSupplyTable
      days={DAYS}
      rows={rows}
      showCodes={over.showCodes ?? true}
      zone="America/New_York"
      nowMs={over.nowMs ?? NOW_MS}
      depthReadable={over.depthReadable ?? true}
      bucketListReadable={over.bucketListReadable ?? true}
    />,
  );
}

/** The summary block above the table, found by the one line only it holds. The
 *  key below the table explains the same states in the same words, so a bare
 *  text query cannot tell the two ends of the page apart. */
function summaryText(): string {
  const scope = screen.getByText(/^Today, /).parentElement;
  return scope?.textContent ?? "";
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
        supplyCellTitle(cells[0], "120 Low | Beyond | No Legal Param", "Tuesday, August 4"),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        supplyCellTitle(cells[1], "120 Low | Beyond | No Legal Param", "Wednesday, August 5"),
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
    // Both agent columns, and neither of them a zero: an unreadable roster is
    // not a report that nobody can take these bookings.
    expect(screen.getAllByText("Unknown").length).toBe(2);
    expect(screen.getByText(/roster could not be read/)).toBeTruthy();
    expect(screen.queryByText("0", { selector: "td span" })).toBeNull();
  });

  // #1942: grouped by DEBT TIER now, which is the axis the page is read by. The
  // rows arrive already sorted (the report sorts them), so the fixture is given
  // in the order the page receives them.
  it("groups the rows by debt tier, and names each group", () => {
    renderTable([
      row({ code: "220", name: "Medium | Beyond | No Legal Param" }),
      row({ code: "110", name: "Low | Both | No Legal Param" }),
      row({ code: "120", name: "Low | Beyond | No Legal Param" }),
    ]);
    const groups = [...document.querySelectorAll("th[scope='rowgroup']")].map(
      (n) => n.textContent ?? "",
    );
    expect(groups).toEqual(["Medium debt", "Low debt"]);
  });

  // A code the grouping cannot read still gets a group rather than being folded
  // into whichever one happens to precede it.
  it("gives an unreadable code its own group", () => {
    renderTable([
      row({ code: "110", name: "Low | Both | No Legal Param" }),
      row({ code: "zzz", name: "Something else" }),
    ]);
    const groups = [...document.querySelectorAll("th[scope='rowgroup']")].map(
      (n) => n.textContent ?? "",
    );
    expect(groups).toEqual(["Low debt", "Other codes"]);
  });

  // #1938. Everything below is about a person who has never seen this page
  // being able to answer three questions without reading a paragraph: what one
  // cell means, which pool is in trouble, and whether the numbers are current.

  it("carries the unit and the question in the headers, not in a paragraph", () => {
    renderTable([row()]);
    // A spanning header per group, each answering its own columns once. Without
    // these the day columns carry no unit at all and `Eligible agents` does not
    // say eligible for what, which is what the stripped paragraph was carrying.
    const groups = [...document.querySelectorAll("thead th[scope='colgroup']")].map(
      (n) => n.textContent ?? "",
    );
    expect(groups).toEqual([
      "Agents who can take these bookings",
      "Booked share of the appointment times the pool could have taken",
    ]);
    // And the pair underneath is two columns of one fact each, never `84 (75 today)`.
    // Read in DOCUMENT order, not visual order: the headers that span both rows
    // sit in the first one, so `Last computed` precedes the pair here while
    // rendering to their right.
    const cols = [...document.querySelectorAll("thead th[scope='col']")].map(
      (n) => n.textContent ?? "",
    );
    expect(cols.slice(0, 4)).toEqual(["Bucket", "Last computed", "Eligible", "Available today"]);
  });

  it("splits the two agent counts into their own columns", () => {
    renderTable([row({ depth: 84, effectiveDepth: 75 })]);
    const cells = [...document.querySelectorAll("tbody tr td")]
      .slice(0, 2)
      .map((n) => n.textContent ?? "");
    expect(cells).toEqual(["84", "75"]);
    // The bracketed form is what a reader had to decode before they could read.
    expect(screen.queryByText(/\(75 today\)/)).toBeNull();
  });

  it("calls out a pool with nobody on shift today, and only that", () => {
    renderTable([row({ depth: 84, effectiveDepth: 0 })]);
    const zero = screen.getByText("0", { selector: "td span" });
    expect(zero.className).toContain("text-error");
    // 75 of 84 is unremarkable, and a column of emphasis teaches a reader to
    // ignore the column. No threshold is invented for "much lower".
    screen.getByText("84");
  });

  it("answers when these numbers are from with a time", () => {
    // Two minutes old, judged against the pinned instant above.
    renderTable([row({ computedAtMs: NOW_MS - 2 * 60_000 })]);
    expect(screen.getByText("2 min ago")).toBeTruthy();
    // The header asks WHEN, so a grade in that column is the thing being fixed.
    expect(screen.queryByText(freshnessLabel("fresh").label)).toBeNull();
  });

  it("keeps the words for the two states that have no useful time to show", () => {
    renderTable([row({ freshness: "unknown", computedAtMs: null })]);
    const el = screen.getByText(freshnessLabel("unknown").label);
    expect(el.className).toContain("text-error");
    expect(screen.queryByText(/ago$/)).toBeNull();
  });

  it("says the office is shut rather than showing a summary of zeros", () => {
    renderTable([row({ cells: [{ kind: "closed" }, { kind: "closed" }] })]);
    // Every count refuses to count what it could not measure, so a shut day
    // reads zero on all six. That is character for character what a working day
    // on which nothing was found looks like, and they are different screens.
    // Read from the SUMMARY block, because the key below the table explains the
    // same state in the same words. That is the point of the vocabulary, and it
    // is why a bare text query would pass whether the summary said it or not.
    expect(summaryText()).toContain(supplyLegendEntry("closed").label);
    expect(summaryText()).not.toContain(supplyLegendEntry("nobody-available").label);
  });

  it("still says a row is out of date on a day the office is shut", () => {
    // Freshness belongs to the ROW, not to the day: a stale row is stale on a
    // Sunday, and the one line that replaces the chips must not swallow it.
    renderTable([
      row({ freshness: "stale", cells: [{ kind: "closed" }, { kind: "closed" }] }),
    ]);
    expect(summaryText()).toContain(supplyLegendEntry("closed").label);
    expect(summaryText()).toContain(freshnessLabel("stale").label);
  });

  it("names each state once, in the same words above the table and below it", () => {
    renderTable([row()]);
    // ONE vocabulary (#1938): the summary chip and the key entry are the same
    // string, because both read one record. A chip holding its own wording is
    // exactly how the page came to have three names for one state.
    for (const { legendId } of SUPPLY_SUMMARY_STATES) {
      const label = supplyLegendEntry(legendId).label;
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(2);
    }
    // The scope is stated once, above the chips, rather than on the end of each.
    expect(screen.getByText(/^Today, .*, across 1 pool$/)).toBeTruthy();
  });
});

// 2026-10-02: managers read the page by POOL, in words, and never see a bucket
// code. Admins keep one row per code, with the code, because they are the ones
// who configure buckets by it.
describe("BucketSupplyTable for managers", () => {
  const lowCells: SupplyCell[] = [
    { kind: "counted", booked: 3, capacity: 21, share: 3 / 21 },
    { kind: "closed" },
  ];
  const pooled = [
    row({ code: "110", name: "Low | Both | No Legal Param", poolKey: "pool-low", poolLabel: "Low", cells: lowCells }),
    row({ code: "111", name: "Low | Both | Legal", poolKey: "pool-low", poolLabel: "Low", cells: lowCells }),
    row({ code: "120", name: "Low | Beyond | No Legal Param", poolKey: "pool-low-beyond", poolLabel: "Low with Beyond" }),
  ];

  /** Every piece of text a manager can reach: what is drawn, and every title. */
  function everythingReadable(): string {
    const titles = [...document.querySelectorAll("[title]")].map((n) => n.getAttribute("title") ?? "");
    return [document.body.textContent ?? "", ...titles].join("\n");
  }

  it("shows one row per pool, named in words", () => {
    renderTable(pooled, { showCodes: false });
    const heads = [...document.querySelectorAll("tbody th[scope='row']")].map((n) => n.textContent ?? "");
    expect(heads).toEqual(["Low", "Low with Beyond"]);
    // The cell sentence names the pool, not a code.
    expect(screen.getByText(supplyCellTitle(lowCells[0], "Low", "Tuesday, August 4"))).toBeTruthy();
  });

  it("puts no bucket code anywhere on the page, titles included", () => {
    renderTable(pooled, { showCodes: false });
    const text = everythingReadable();
    for (const code of ["110", "111", "120"]) {
      expect(text).not.toMatch(new RegExp(`\\b${code}\\b`));
    }
  });

  it("counts the pools it shows", () => {
    renderTable(pooled, { showCodes: false });
    expect(screen.getByText(/^Today, .*, across 2 pools$/)).toBeTruthy();
  });

  it("keeps a pool whose codes disagree as separate rows, and says which is which", () => {
    renderTable(
      [pooled[0], { ...pooled[1], depth: 1 }, pooled[2]],
      { showCodes: false },
    );
    const heads = [...document.querySelectorAll("tbody th[scope='row']")].map((n) => n.textContent ?? "");
    // Two rows under one pool name would be indistinguishable, so each split row
    // carries the bucket's own name under it. A uniform pool carries none.
    expect(heads).toEqual([
      "LowLow | Both | No Legal Param",
      "LowLow | Both | Legal",
      "Low with Beyond",
    ]);
  });

  it("tells cache only rows apart without a code when the bucket list is unreadable", () => {
    renderTable(
      [
        row({ code: "110", name: "110", poolKey: "bucket:110", poolLabel: null }),
        row({ code: "111", name: "111", poolKey: "bucket:111", poolLabel: null }),
      ],
      { showCodes: false, bucketListReadable: false },
    );
    const heads = [...document.querySelectorAll("tbody th[scope='row']")].map((n) => n.textContent ?? "");
    expect(heads).toEqual(["Low | Both | No Legal Param", "Low | Both | Legal"]);
    expect(everythingReadable()).not.toMatch(/\b11[01]\b/);
  });

  it("says where an empty pool's leads go, and keeps it out of nobody available", () => {
    const overflow: SupplyCell = { kind: "overflows", toPool: "Low with Achieve" };
    renderTable(
      [
        row({
          code: "120",
          poolKey: "pool-low-beyond",
          poolLabel: "Low with Beyond",
          depth: 0,
          effectiveDepth: 0,
          cells: [overflow, { kind: "closed" }],
        }),
      ],
      { showCodes: false },
    );
    const head = document.querySelector("tbody th[scope='row']")?.textContent ?? "";
    expect(head).toContain("Low with Beyond");
    expect(head).toContain("Leads go to Low with Achieve");
    expect(screen.getByText(supplyCellTitle(overflow, "Low with Beyond", "Tuesday, August 4"))).toBeTruthy();
    const summary = summaryText();
    expect(summary).toMatch(new RegExp(`${supplyLegendEntry("nobody-available").label}\\s*0(?!\\d)`));
    expect(summary).toMatch(new RegExp(`${supplyLegendEntry("overflows").label}\\s*1(?!\\d)`));
    // Not painted as the alarm.
    const chip = [...document.querySelectorAll("span[title]")].find((n) =>
      (n.textContent ?? "").startsWith(supplyLegendEntry("overflows").label),
    );
    expect(chip?.className).not.toContain("text-error");
  });

  it("says where the leads go for an admin too", () => {
    renderTable(
      [row({ cells: [{ kind: "overflows", toPool: "Low with Achieve" }, { kind: "closed" }] })],
      { showCodes: true },
    );
    const head = document.querySelector("tbody th[scope='row']")?.textContent ?? "";
    expect(head).toContain("Leads go to Low with Achieve");
    expect(summaryText()).toMatch(new RegExp(`${supplyLegendEntry("overflows").label}\\s*1(?!\\d)`));
  });

  it("names a pool outside the routing matrix by the bucket's name, never its code", () => {
    renderTable(
      [row({ code: "777", name: "Spanish speakers", poolKey: "pool-hand-made", poolLabel: null })],
      { showCodes: false },
    );
    const heads = [...document.querySelectorAll("tbody th[scope='row']")].map((n) => n.textContent ?? "");
    expect(heads).toEqual(["Spanish speakers"]);
    expect(everythingReadable()).not.toMatch(/\b777\b/);
  });

  it("does not fall back to a code when the bucket name itself was not readable", () => {
    // With the bucket list unreadable the loader names a row by its code.
    renderTable(
      [row({ code: "777", name: "777", poolKey: "bucket:777", poolLabel: null })],
      { showCodes: false, bucketListReadable: false },
    );
    expect(everythingReadable()).not.toMatch(/\b777\b/);
  });

  it("leaves the admin view one row per code, with the code", () => {
    renderTable(pooled, { showCodes: true });
    const heads = [...document.querySelectorAll("tbody th[scope='row']")].map((n) => n.textContent ?? "");
    expect(heads).toEqual([
      "110Low | Both | No Legal Param",
      "111Low | Both | Legal",
      "120Low | Beyond | No Legal Param",
    ]);
    // The summary counts pools, so the Low pool's two codes are one: both pools
    // are part booked today, which is two, never the three rows drawn.
    expect(screen.getByText(/^Today, .*, across 2 pools$/)).toBeTruthy();
    expect(summaryText()).toMatch(new RegExp(`${supplyLegendEntry("some").label}\\s*2(?!\\d)`));
  });
});
