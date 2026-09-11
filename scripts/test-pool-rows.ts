// Collapsing a screen's sixty rows into the fifteen answers they carry (#2237).
//
// The tiers page and the supply page each list one row per bucket code, and six
// codes in a tier produce identical numbers by construction: they share one set
// of criteria, so they resolve the same agents and the same slots. Sixty rows
// giving fifteen answers is what a reader has to hold in their head to compare
// anything (L605: read the composed page as one surface and delete every second
// statement).
//
// The guard that matters is the NON-UNIFORM one. Collapsing rows that do NOT
// agree would show one of their numbers and silently drop the others, on a
// screen whose whole job is to report those numbers. Grouping is a display
// convenience; being right is not.
//
// Run: node --experimental-strip-types scripts/test-pool-rows.ts
import { groupRowsByPool } from "../src/lib/admin/pool-rows.ts";
import { assert, eq, finish } from "./lib/harness.ts";

interface Row {
  code: string;
  poolKey: string;
  poolLabel: string | null;
  depth: number;
}

const row = (code: string, poolKey: string, depth: number, poolLabel: string | null = "Low"): Row =>
  ({ code, poolKey, poolLabel, depth });

const sameDepth = (a: Row, b: Row) => a.depth === b.depth;

// --- The collapse ---

{
  const rows = ["100", "101", "102", "110", "111", "112"].map((c) => row(c, "low", 7));
  const groups = groupRowsByPool(rows, sameDepth);
  eq(groups.length, 1, "six codes carrying one answer become one group");
  eq(groups[0]!.codes, ["100", "101", "102", "110", "111", "112"], "which names every code");
  eq(groups[0]!.label, "Low", "and the pool");
  assert(groups[0]!.uniform, "and reports that its rows agreed");
  eq(groups[0]!.rows.length, 6, "while keeping every row, so nothing is lost to the grouping");
}

{
  const groups = groupRowsByPool(
    [row("100", "low", 7), row("300", "high", 2, "High")],
    sameDepth,
  );
  eq(groups.length, 2, "two pools stay two groups");
  eq(
    groups.map((g) => g.label),
    ["Low", "High"],
    "in the order the rows arrived, which is the page's own ordering",
  );
}

// --- The guard: rows that disagree are NOT collapsed ---

{
  // This cannot happen while the pool key covers everything the numbers are
  // derived from, which is exactly why it needs a test: the day it can, the
  // screen must show the disagreement rather than pick a winner (L131).
  const rows = [row("100", "low", 7), row("101", "low", 7), row("102", "low", 2)];
  const groups = groupRowsByPool(rows, sameDepth);
  eq(groups.length, 3, "a group whose rows disagree is not collapsed at all");
  assert(
    groups.every((g) => !g.uniform),
    "and every one of them says it was not a clean grouping",
  );
  eq(
    groups.map((g) => g.codes[0]),
    ["100", "101", "102"],
    "so the reader sees each code's own number",
  );
}

{
  // One differing row must not cost the OTHER pools their grouping.
  const rows = [
    row("100", "low", 7),
    row("101", "low", 2),
    ...["300", "301"].map((c) => row(c, "high", 4, "High")),
  ];
  const groups = groupRowsByPool(rows, sameDepth);
  eq(groups.length, 3, "the disagreeing pool splits and the agreeing one does not");
  eq(groups[2]!.codes, ["300", "301"], "the healthy pool is still one group");
  assert(groups[2]!.uniform, "and is still marked uniform");
}

// --- Codes are ordered, groups are not reordered ---

{
  const groups = groupRowsByPool(
    [row("111", "low", 7), row("100", "low", 7), row("102", "low", 7)],
    sameDepth,
  );
  eq(
    groups[0]!.codes,
    ["100", "102", "111"],
    "codes read in their own order, never the order the rows happened to arrive in",
  );
}

// --- Degenerate shapes ---

eq(groupRowsByPool([], sameDepth).length, 0, "no rows means no groups");

{
  const groups = groupRowsByPool([row("CUSTOM", "custom", 3, null)], sameDepth);
  eq(groups.length, 1, "a pool of one is still a group");
  eq(groups[0]!.label, null, "and keeps the fact that it has no name");
  assert(groups[0]!.uniform, "a group of one row cannot disagree with itself");
}

finish();
