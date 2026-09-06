// #1896: the buckets table, which replaced sixty stacked editors.
//
// What is pinned here is the reading of sixty pools: how a code decodes into the
// matrix, what "can this pool take a booking" means, and the ORDER, which is the
// thing that makes the table legible at all.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-bucket-table.ts
import {
  bucketHealth,
  bucketHealthLabel,
  bucketRow,
  bucketRowMatches,
  bucketTableSummary,
  filterBucketRows,
  noMatchText,
  showsManualMembers,
  sortBucketRows,

} from "../src/lib/admin/bucket-table.ts";
import {
  allXbcCodes,
  bucketSpecForXbc,
  seederOwnsCode,
  BACKEND,
  DEBT_TIER,
  LEGAL,
} from "../src/lib/xbc.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import type { Bucket } from "../src/lib/db/types.ts";

// The NAME is derived from the code, the way the seeder writes it, rather than
// pinned to one string. A fixture whose every row was named "Low | ..." made a
// filter test pass for the wrong reason: it matched the fixture's stale name on
// a pool that is Medium (L48).
const bucket = (over: Partial<Bucket> = {}): Bucket => ({
  id: `id-${over.code ?? "100"}`,
  org_id: "o1",
  code: "100",
  name: bucketSpecForXbc(over.code ?? "100")?.name ?? `Pool ${over.code ?? "100"}`,
  event_type_id: "e1",
  assignment: "round_robin",
  criteria: {},
  routing_form_id: null,
  fallback_user_id: null,
  is_test: false,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

// ------------------------------------------------------------------ the matrix

// THE CODE IS THREE DIMENSIONS, and splitting it is the whole reason this is a
// table: a seeded bucket's NAME is exactly those three joined, so a name column
// would be the same information again, unaligned and unsortable.
{
  const r = bucketRow(bucket({ code: "432" }), 5, 0);
  eq(r.matrix?.tier, "Very High", "the first digit is the debt tier");
  eq(r.matrix?.backend, "Achieve", "the second is the backend");
  eq(r.matrix?.legal, "Non-Legal", "the third is the legal parameter");
}

// A HAND MADE BUCKET HAS NO POSITION IN THE MATRIX, and the test is the same one
// #2006 uses for what is editable, not a second rule about code shapes (L41). A
// code that merely LOOKS like an XBC but is not one the seeder writes must not
// be labelled with a tier nobody chose.
{
  eq(bucketRow(bucket({ code: "SMOKE" }), 1, 0).matrix, null, "a non numeric code decodes to nothing");
  eq(bucketRow(bucket({ code: "999" }), 1, 0).matrix, null, "and neither does a three digit code outside the matrix");
  assert(bucketRow(bucket({ code: allXbcCodes()[0]! }), 1, 0).matrix !== null, "while a real XBC does");
}

// THE GUARD AND THE DECODE MUST AGREE ON EVERY POSSIBLE CODE, which is what lets
// this ask `seederOwnsCode` rather than re-testing the code's shape (L41). They
// are equivalent today by construction, so no single fixture can tell a broken
// guard from a working one: what is asserted is the equivalence itself, over the
// whole three digit space, so a matrix that grew a digit the seeder does not
// write would fail here rather than silently labelling a pool with a tier
// nobody chose.
{
  let decodable = 0;
  let disagreements = 0;
  for (let n = 0; n < 1000; n++) {
    const code = String(n).padStart(3, "0");
    const [a, b, c] = code.split("");
    const decodes = Boolean(DEBT_TIER[a!] && BACKEND[b!] && LEGAL[c!]);
    if (decodes) decodable++;
    if (decodes !== seederOwnsCode(code)) disagreements++;
  }
  eq(decodable, 60, "exactly sixty of the thousand three digit codes decode");
  eq(disagreements, 0, "and the seeder owns precisely those");
}

// ------------------------------------------------------------------ the health

// NOT MEASURED IS NOT ZERO, and this is the assertion that matters most: zero is
// the value this table paints in the error colour, and #1929 shipped exactly
// that mistake against two working buckets for months.
{
  const unmeasured = bucketRow(bucket(), undefined, 0);
  eq(unmeasured.eligible, null, "an unmeasured depth is null, never zero");
  eq(bucketHealth(unmeasured), "unmeasured", "and it is its own state");
  assert(bucketHealth(unmeasured) !== "blocked", "never the alarming one");
  assert(!/agent|fallback/.test(bucketHealthLabel(unmeasured)), "and its label claims nothing about staffing");
}

{
  eq(bucketHealth(bucketRow(bucket(), 0, 0)), "blocked", "nobody and no fallback is blocked");
  eq(
    bucketHealth(bucketRow(bucket({ fallback_user_id: "u1" }), 0, 0)),
    "fallback-only",
    "nobody with a fallback is caught, not blocked",
  );
  eq(bucketHealth(bucketRow(bucket(), 7, 0)), "staffed", "somebody matching is staffed");
  eq(bucketHealthLabel(bucketRow(bucket(), 1, 0)), "1 agent", "one agent is singular");
  eq(bucketHealthLabel(bucketRow(bucket(), 7, 0)), "7 agents", "and more than one is plural");
  // Every state renders something, and no two of them read the same.
  const labels = [
    bucketHealthLabel(bucketRow(bucket(), undefined, 0)),
    bucketHealthLabel(bucketRow(bucket(), 0, 0)),
    bucketHealthLabel(bucketRow(bucket({ fallback_user_id: "u1" }), 0, 0)),
    bucketHealthLabel(bucketRow(bucket(), 7, 0)),
  ];
  eq(new Set(labels).size, 4, "each staffing state says something different");
  for (const l of labels) assert(!/undefined|null|NaN/.test(l), "and none leaks a value");
}

// ------------------------------------------------------------------- the order

// A READ WITH NO ORDER RETURNS WHATEVER THE STORE FELT LIKE (L343), and measured
// against production that was 100, 101, 102, 110, 111, then 500: the tiers
// interleaved, which destroys the arrangement that makes sixty pools legible.
{
  const asStored = ["102", "500", "100", "410", "101"].map((code) =>
    bucketRow(bucket({ code, id: `id-${code}` }), 1, 0),
  );
  eq(
    sortBucketRows(asStored).map((r) => r.code),
    ["100", "101", "102", "410", "500"],
    "sorted by code, which groups by tier then backend then legal",
  );
  eq(
    asStored.map((r) => r.code)[0],
    "102",
    "and the input really was in a different order, so the sort is what produced it",
  );
}

// A HAND MADE POOL GOES AFTER THE MATRIX rather than interleaving on a code that
// means nothing in that scheme.
{
  // The custom code is chosen to sort BEFORE every matrix code by text, so a
  // sort that had only the code comparison would put it first. A code that
  // happened to sort last anyway passes with the matrix rule removed entirely.
  const rows = [
    bucketRow(bucket({ code: "001", id: "x" }), 1, 0),
    bucketRow(bucket({ code: "500", id: "y" }), 1, 0),
    bucketRow(bucket({ code: "100", id: "z" }), 1, 0),
  ];
  eq(bucketRow(bucket({ code: "001" }), 1, 0).matrix, null, "and 001 really is outside the matrix");
  assert("001".localeCompare("100", "en") < 0, "and really does sort first by text");
  eq(sortBucketRows(rows).map((r) => r.code), ["100", "500", "001"], "custom pools sort last");
}

{
  const rows = [bucketRow(bucket({ code: "100", id: "b" }), 1, 0), bucketRow(bucket({ code: "100", id: "a" }), 1, 0)];
  eq(sortBucketRows(rows).map((r) => r.id), ["a", "b"], "an exact tie breaks stably by id");
  eq(rows.map((r) => r.id), ["b", "a"], "and the input is not mutated");
}

// ------------------------------------------------------------------ the filter

{
  const rows = allXbcCodes().map((code) => bucketRow(bucket({ code, id: code }), 5, 0));
  eq(rows.length, 60, "the real matrix is sixty pools");
  // Typing a DIMENSION finds a whole slice of the matrix, which is the question
  // somebody actually has: five tiers times three legal values.
  eq(
    filterBucketRows(rows, { query: "achieve", blockedOnly: false }).length,
    15,
    "a backend name finds its column of the matrix",
  );
  eq(
    filterBucketRows(rows, { query: "very high", blockedOnly: false }).length,
    12,
    "a tier name finds its row of the matrix, all four backends",
  );
  eq(filterBucketRows(rows, { query: "412", blockedOnly: false }).length, 1, "a code finds one pool");
  eq(filterBucketRows(rows, { query: "  ", blockedOnly: false }).length, 60, "a blank filter means no filter");
  eq(filterBucketRows(rows, { query: "ACHIEVE", blockedOnly: false }).length, 15, "and it is case folded");
  eq(filterBucketRows(rows, { query: "nothing here", blockedOnly: false }).length, 0, "a miss really misses");
}

{
  const row = bucketRow(bucket({ code: "432", name: "Very High | Achieve | Non-Legal" }), 1, 0);
  assert(bucketRowMatches(row, "achieve"), "matches a decoded label");
  assert(bucketRowMatches(row, "432"), "and the code");
  assert(!bucketRowMatches(row, "beyond"), "and not a label it does not carry");
}

// The two filters COMPOSE rather than one winning: a text query narrowed to the
// blocked set must apply both.
{
  const rows = [
    bucketRow(bucket({ code: "120", id: "a" }), 0, 0),
    bucketRow(bucket({ code: "220", id: "b" }), 0, 0),
    bucketRow(bucket({ code: "130", id: "c" }), 9, 0),
  ];
  eq(filterBucketRows(rows, { query: "", blockedOnly: true }).map((r) => r.code), ["120", "220"], "blocked only");
  eq(filterBucketRows(rows, { query: "low", blockedOnly: true }).map((r) => r.code), ["120"], "and text as well");
  // An UNMEASURED row is not swept into the blocked set by the filter, for the
  // same reason it is not painted red.
  const withUnknown = [...rows, bucketRow(bucket({ code: "320", id: "d" }), undefined, 0)];
  eq(
    filterBucketRows(withUnknown, { query: "", blockedOnly: true }).map((r) => r.code),
    ["120", "220"],
    "an unmeasured pool is not shown as one that can take no booking",
  );
}

// ----------------------------------------------------------------- the columns

// A COLUMN THAT READS 0 SIXTY TIMES DOWN is noise that pushes the columns that
// vary further right. Routing here is by attribute, so on production every pool
// has zero hand picked members.
{
  const rows = allXbcCodes().map((code) => bucketRow(bucket({ code, id: code }), 5, 0));
  assert(!showsManualMembers(rows), "with nobody named by hand the column is not drawn");
  rows[3]!.manualMembers = 2;
  assert(showsManualMembers(rows), "and one pool with a manual member brings it back");
}

// ----------------------------------------------------------------- the summary

{
  const rows = [
    bucketRow(bucket({ code: "120", id: "a" }), 0, 0),
    bucketRow(bucket({ code: "121", id: "b" }), 0, 0),
    bucketRow(bucket({ code: "130", id: "c" }), 9, 0),
    bucketRow(bucket({ code: "131", id: "d" }), undefined, 0),
  ];
  const s = bucketTableSummary(rows);
  assert(/4 pools/.test(s), "the summary counts the pools");
  assert(/2 can take no booking/.test(s), "names the blocked ones");
  assert(/1 could not be measured/.test(s), "and counts the unmeasured separately rather than folding them in");
}

{
  const clean = [bucketRow(bucket({ code: "100" }), 9, 0)];
  assert(/every one of them staffed/.test(bucketTableSummary(clean)), "an all clear says so");
  eq(bucketTableSummary([]), "No buckets yet.", "and an empty list is its own sentence");
  assert(!/pools,/.test(bucketTableSummary([])), "rather than a count of nothing");
}

// A FILTER HIDING EVERYTHING is a different fact from having no buckets (L10),
// and the three ways it can happen say three different things.
{
  const a = noMatchText({ query: "", blockedOnly: true }, 60);
  const b = noMatchText({ query: "zzz", blockedOnly: true }, 60);
  const c = noMatchText({ query: "zzz", blockedOnly: false }, 60);
  eq(new Set([a, b, c]).size, 3, "each empty result explains itself differently");
  assert(/Every one of the 60 pools can take a booking/.test(a), "an empty blocked filter is good news, and says so");
  for (const t of [a, b, c]) assert(/60/.test(t), "and each says how many pools there really are");
}

finish();
