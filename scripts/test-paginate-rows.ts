// Tests for in-memory row pagination (src/lib/paginate-rows.ts, #94).
// Run: node --experimental-strip-types scripts/test-paginate-rows.ts
import { paginateRows } from "../src/lib/paginate-rows.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const nums = Array.from({ length: 108 }, (_, i) => i + 1);

{
  const p = paginateRows(nums, 1, 50);
  eq(p.items.length, 50, "first page has pageSize items");
  eq(p.items[0], 1, "first page starts at item 1");
  eq(p.pageCount, 3, "108 / 50 -> 3 pages");
  eq(p.start, 1, "start index 1");
  eq(p.end, 50, "end index 50");
}
{
  const p = paginateRows(nums, 3, 50);
  eq(p.items.length, 8, "last page holds the remainder");
  eq(p.items[0], 101, "last page starts at item 101");
  eq(p.end, 108, "end index is the total on the last page");
}
{
  // Out-of-range and garbage pages clamp to a valid page (a hand-edited URL must
  // not render an empty table).
  eq(paginateRows(nums, 99, 50).page, 3, "a too-high page clamps to the last page");
  eq(paginateRows(nums, 0, 50).page, 1, "page 0 clamps to 1");
  eq(paginateRows(nums, -5, 50).page, 1, "a negative page clamps to 1");
  eq(paginateRows(nums, NaN, 50).page, 1, "NaN page clamps to 1");
}
{
  const p = paginateRows<number>([], 1, 50);
  eq(p.items.length, 0, "empty list yields no items");
  eq(p.pageCount, 1, "empty list still reports 1 page");
  eq(p.start, 0, "empty list start index 0");
  eq(p.end, 0, "empty list end index 0");
}
{
  // A page smaller than the set: exact page math.
  const p = paginateRows([1, 2, 3, 4, 5], 2, 2);
  eq(p.items.join(","), "3,4", "page 2 of size 2 is items 3,4");
  eq(p.pageCount, 3, "5 items / size 2 -> 3 pages");
}

assert(true, "paginateRows covered");
finish();
