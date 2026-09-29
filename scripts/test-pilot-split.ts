// The Slate against cal.com pilot split report (#2898). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pilot-split.ts
//
// Everything `pnpm report:pilot-split` decides lives in scripts/lib/pilot-split.ts
// and is driven here with hand written exports: no network, no GA4, no clock.
//
// The hash half is the part that has to agree with ANOTHER repository. trypennie
// decides which booker a lead gets with `slateBucket` (Halo-lab-Trypennie/trypennie#517); this report re-runs
// the same function to tell a lead outside the pilot from one inside it. Two copies
// of one function in two codebases drift silently, so both are held to ONE
// committed fixture whose buckets were computed by trypennie's own code at a named
// sha (L26), never by Slate's copy: a fixture written by the implementation under
// test can only confirm that implementation agrees with itself (L70).
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  slateBucket,
  parseGa4Export,
  summarizeLeads,
  compareHalves,
  daysNeeded,
  judgePilotSplit,
  planFromEnv,
  crossCheckSlateBookings,
  PILOT_SPLIT_EXIT,
  MIN_LEADS_PER_HALF,
  MIN_OUTCOMES_PER_HALF,
} from "./lib/pilot-split.ts";

// --- 1. the bucket agrees with trypennie's own function ------------------------
{
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/pilot-split-buckets.json", import.meta.url), "utf8")) as {
    source: { repo: string; pr: number; sha: string };
    pairs: { id: string; bucket: number }[];
  };
  eq(fixture.source.repo, "Halo-lab-Trypennie/trypennie", "the fixture names the repository its buckets came from");
  assert(/^[0-9a-f]{40}$/.test(fixture.source.sha), "the fixture records the full sha it was computed at");
  assert(fixture.pairs.length >= 200, `the fixture carries a few hundred ids (got ${fixture.pairs.length})`);
  assert(
    fixture.pairs.some((p) => p.id.length === 15) && fixture.pairs.some((p) => p.id.length === 18),
    "the fixture carries both the 15 and the 18 character id forms",
  );
  const distinct = new Set(fixture.pairs.map((p) => p.bucket)).size;
  assert(distinct > 50, `the fixture spreads across the bucket range, not a handful of values (got ${distinct})`);
  const mismatches = fixture.pairs.filter((p) => slateBucket(p.id) !== p.bucket);
  eq(mismatches.length, 0, "Slate's slateBucket agrees with trypennie's on every fixture id");

  // Positive control: a copy that hashed the WHOLE id instead of the first 15
  // characters must disagree somewhere, or the check above is too weak to notice.
  const wholeId = (id: string) => {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % 100;
  };
  assert(
    fixture.pairs.some((p) => wholeId(p.id) !== p.bucket),
    "control: a hash over the whole 18 character id fails the fixture",
  );
  for (const p of fixture.pairs.filter((x) => x.id.length === 18).slice(0, 20)) {
    eq(slateBucket(p.id), slateBucket(p.id.slice(0, 15)), `the 15 and 18 character forms of ${p.id} share a bucket`);
  }
}

// --- helpers: a GA4 Exploration export -----------------------------------------
const HEADER = ["Date", "submission_id", "booking_provider", "Event name", "ga4_event_name", "Event count"];
function csv(rows: string[][], header: string[] = HEADER): string {
  const preamble = [
    "# ----------------------------------------",
    "# Pilot split",
    "# Account: Pennie",
    "# ----------------------------------------",
    "",
  ];
  const line = (r: string[]) => r.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",");
  return [...preamble, line(header), ...rows.map(line)].join("\n") + "\n";
}
/** A lead's rows: one assignment, plus whatever booker events follow. */
function lead(
  id: string,
  provider: "slate" | "cal.com",
  events: string[] = [],
  date = "20261005",
): string[][] {
  return [
    [date, id, provider, "booking_assignment", "(not set)", "1"],
    ...events.map((e) => [date, id, provider, "cal_booking", e, "1"]),
  ];
}
/** Ids whose trypennie bucket is below or at least the given percent. */
function idsInBucketRange(n: number, below: boolean, percent: number, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const id = `${prefix}${String(i).padStart(15 - prefix.length, "0")}`;
    if ((slateBucket(id) < percent) === below) out.push(id);
  }
  return out;
}

// --- 2. parsing: every required column is named when missing -------------------
{
  for (const missing of ["Date", "submission_id", "booking_provider", "Event name", "ga4_event_name", "Event count"]) {
    const header = HEADER.filter((h) => h !== missing);
    const parsed = parseGa4Export(csv([], header));
    assert(!parsed.ok, `a file with no ${missing} column is refused`);
    if (!parsed.ok) {
      eq(parsed.exit, PILOT_SPLIT_EXIT.missingColumn, `a missing ${missing} column exits on its own code`);
      assert(parsed.message.includes(missing.toLowerCase().replace(/ /g, "_")), `the refusal names ${missing}`);
    }
  }
  const ok = parseGa4Export(csv(lead("a04Ui000000AAAA", "slate", ["view_booker"])));
  assert(ok.ok, "a complete export parses");
  if (ok.ok) {
    eq(ok.rows.length, 2, "both data rows are read, the comment preamble is skipped");
    eq(ok.rows[0].date, "2026-10-05", "a GA4 YYYYMMDD date is read as a calendar date");
    eq(ok.rows[1].event, "view_booker", "a booker event is read by its ga4_event_name");
    eq(ok.rows[0].event, "booking_assignment", "a (not set) ga4_event_name falls back to the GA4 event name");
  }
  // Header spellings GA4 uses for display names are normalised.
  const spaced = parseGa4Export(
    csv([["2026-10-05", "a04Ui000000AAAA", "Slate", "booking_assignment", "", "1,204"]], [
      "date",
      "Submission ID",
      "Booking Provider",
      "event_name",
      "GA4 event name",
      "EVENT COUNT",
    ]),
  );
  assert(spaced.ok, "display name spellings of the columns are accepted");
  if (spaced.ok) {
    eq(spaced.rows[0].count, 1204, "a quoted count with a thousands separator is read as a number");
    eq(spaced.rows[0].provider, "slate", "the provider is read case blind");
  }
  const badCount = parseGa4Export(csv([["20261005", "a04Ui000000AAAA", "slate", "booking_assignment", "", "many"]]));
  assert(!badCount.ok && badCount.exit === PILOT_SPLIT_EXIT.unreadableValue, "an unreadable event count is refused, never read as zero");
  if (!badCount.ok) assert(/line \d+/.test(badCount.message), "the refusal names the line");
  const badDate = parseGa4Export(csv([["Oct 5", "a04Ui000000AAAA", "slate", "booking_assignment", "", "1"]]));
  assert(!badDate.ok && badDate.exit === PILOT_SPLIT_EXIT.unreadableValue, "an unreadable date is refused");
  const empty = parseGa4Export("# only a comment\n\n");
  assert(!empty.ok && empty.exit === PILOT_SPLIT_EXIT.unreadableFile, "a file with no header at all is refused as unreadable");
  const totals = parseGa4Export(
    csv([["", "", "", "", "", "812"], ...lead("a04Ui000000AAAA", "slate")]),
  );
  assert(totals.ok && totals.rows.length === 1, "a GA4 totals row (every dimension blank) is skipped");
  const notSet = parseGa4Export(csv([["20261005", "(not set)", "slate", "booking_assignment", "", "3"]]));
  assert(notSet.ok, "a row with no submission id parses");
  if (notSet.ok) eq(notSet.withoutSubmission, 3, "events with no submission id are counted, not dropped silently");
}

// --- 3. per lead: dedupe, contradictions, pages that do not assign -------------
{
  const rows = [
    // Three visits, one lead: counted once.
    ...lead("a04Ui000000AAAA", "slate"),
    ...lead("a04Ui000000AAAA", "slate", [], "20261006"),
    ...lead("a04Ui000000AAAAQAB", "slate", ["view_booker", "complete_booking"], "20261007"),
    // Seen under both providers: the two pages disagreed.
    ...lead("a04Ui000000BBBB", "slate"),
    ...lead("a04Ui000000BBBB", "cal.com"),
    // Booker events and no assignment: a page outside the split.
    ["20261005", "a04Ui000000CCCC", "cal.com", "cal_booking", "view_booker", "1"],
    ...lead("a04Ui000000DDDD", "cal.com", ["navigate_to_booker"]),
    ...lead("a04Ui000000EEEE", "cal.com", ["complete_booking"]),
  ];
  const parsed = parseGa4Export(csv(rows));
  assert(parsed.ok, "the dedupe fixture parses");
  if (parsed.ok) {
    const s = summarizeLeads(parsed, { percent: null });
    eq(s.slate.leads, 1, "a lead with three assignment events (15 and 18 character forms) counts once");
    eq(s.slate.bookings, 1, "its booking on a later visit counts for it");
    eq(s.contradictions, 1, "a lead seen under both providers is counted as a contradiction");
    eq(s.calcom.leads, 2, "the contradiction is in neither half");
    eq(s.withoutAssignment, 1, "a lead with booker events and no assignment is counted and left out");
    eq(s.calcom.opened, 2, "navigate_to_booker counts as opening, and so does a booking with no open event");
    eq(s.calcom.bookings, 1, "complete_booking counts as a booking");
    eq(s.slate.leftWithoutOpening, 0, "a lead who opened on any visit did not leave without opening");
  }
}

// --- 4. the population check: leads outside the pilot --------------------------
{
  const low = idsInBucketRange(3, true, 50, "a04UiLOW");
  const high = idsInBucketRange(3, false, 50, "a04UiHIG");
  // cal.com leads whose bucket is under the percentage cannot be pilot leads.
  const rows = [...lead(low[0], "slate"), ...lead(low[1], "cal.com"), ...lead(high[0], "cal.com"), ...lead(high[1], "slate")];
  const parsed = parseGa4Export(csv(rows));
  if (parsed.ok) {
    const s = summarizeLeads(parsed, { percent: 50 });
    eq(s.outsidePilot, 1, "a cal.com lead whose bucket is under the percentage is outside the pilot");
    eq(s.hashDisagrees, 1, "a Slate lead whose bucket is at or over the percentage disagrees with the hash");
    eq(s.calcom.leads, 1, "the outside lead is not in the control half");
    eq(s.slate.leads, 2, "the disagreeing Slate lead is still counted in the half it was given");
  }
  // With an xbc column the population is filtered directly.
  const withXbc = parseGa4Export(
    csv(
      [
        ["20261005", low[0], "slate", "booking_assignment", "", "1", "111"],
        ["20261005", high[0], "cal.com", "booking_assignment", "", "1", "111"],
        ["20261005", high[1], "cal.com", "booking_assignment", "", "1", "311"],
        ["20261005", low[1], "cal.com", "booking_assignment", "", "1", "112"],
      ],
      [...HEADER, "xbc"],
    ),
  );
  assert(withXbc.ok && withXbc.hasXbc, "an optional xbc column is read");
  if (withXbc.ok) {
    const s = summarizeLeads(withXbc, { percent: 50 });
    eq(s.outsidePilot, 1, "a lead whose XBC is not Low is outside the pilot");
    eq(s.hashDisagrees, 1, "a Low cal.com lead under the percentage disagrees with the hash");
    eq(s.calcom.leads, 2, "both Low cal.com leads stay in the control half: a lead is counted by the booker it was given");
  }
}

// --- 5. the interval and p value, against a hand worked example ----------------
{
  // Slate 120 of 1000, cal.com 100 of 1000.
  //   SE  = sqrt(.12*.88/1000 + .10*.90/1000) = sqrt(.0001956) = .0139857
  //   95% = .02 +/- 1.959964 * .0139857 = .02 +/- .0274115 -> [-.0074115, .0474115]
  //   z   = .02 / .0139857 = 1.430032, two sided p = 2 * (1 - Phi(1.430032)) = .152700
  const c = compareHalves({ leads: 1000, bookings: 120 }, { leads: 1000, bookings: 100 });
  const near = (a: number | null, b: number, tol: number) => a !== null && Math.abs(a - b) < tol;
  assert(near(c.difference, 0.02, 1e-12), "the difference is Slate minus cal.com");
  assert(near(c.low, -0.0074115, 1e-6), `the interval's low end (got ${c.low})`);
  assert(near(c.high, 0.0474115, 1e-6), `the interval's high end (got ${c.high})`);
  assert(near(c.p, 0.1527, 1e-4), `the two sided p value (got ${c.p})`);
  // A clearly significant case, both directions.
  const big = compareHalves({ leads: 5000, bookings: 500 }, { leads: 5000, bookings: 650 });
  assert(big.difference !== null && big.difference < 0 && big.high !== null && big.high < 0, "a clear drop has an interval wholly below zero");
  assert(big.p !== null && big.p < 0.001, "and a small p value");
  const flat = compareHalves({ leads: 200, bookings: 0 }, { leads: 200, bookings: 0 });
  eq(flat.p, null, "no bookings on either side has no p value rather than a NaN");
}

// --- 6. daysNeeded against a textbook example and each refusal -----------------
{
  // Fleiss (no continuity correction), alpha .05 two sided, power .8, equal groups:
  // 10% against 12% needs 3,841 per group. At 200 leads a day split 50/50 each half
  // gets 100 a day, so 39 days.
  const d = daysNeeded({ leadsPerDay: 200, percent: 50, baseRate: 0.1, lift: 0.02 });
  assert(d.ok, "a well formed plan returns a number");
  if (d.ok) {
    eq(d.slateLeads, 3841, "10% against 12% needs 3,841 leads in each half");
    eq(d.calcomLeads, 3841, "equal halves need equal numbers");
    eq(d.days, 39, "at 100 a day per half that is 39 days");
  }
  const skew = daysNeeded({ leadsPerDay: 200, percent: 20, baseRate: 0.1, lift: 0.02 });
  assert(skew.ok && d.ok && skew.days > d.days, "a lopsided split takes longer than an even one");
  if (skew.ok) assert(skew.calcomLeads > skew.slateLeads, "and the larger half needs more leads than the smaller");
  for (const [label, input] of [
    ["a zero base rate", { leadsPerDay: 200, percent: 50, baseRate: 0, lift: 0.02 }],
    ["a zero lift", { leadsPerDay: 200, percent: 50, baseRate: 0.1, lift: 0 }],
    ["zero leads", { leadsPerDay: 0, percent: 50, baseRate: 0.1, lift: 0.02 }],
    ["a 0 percent split", { leadsPerDay: 200, percent: 0, baseRate: 0.1, lift: 0.02 }],
    ["a 100 percent split", { leadsPerDay: 200, percent: 100, baseRate: 0.1, lift: 0.02 }],
    ["a lift past 100%", { leadsPerDay: 200, percent: 50, baseRate: 0.9, lift: 0.2 }],
    ["a NaN", { leadsPerDay: Number.NaN, percent: 50, baseRate: 0.1, lift: 0.02 }],
  ] as const) {
    const r = daysNeeded(input);
    assert(!r.ok && r.reason.length > 0, `${label} is refused with a reason, not a number`);
  }
}

// --- 7. the whole judgement: each exit code from at least one case (L151) ------
{
  const seen = new Set<number>();
  const judge = (csvText: string | null, env: Record<string, string> = {}) => {
    const r = judgePilotSplit({ csvText, env });
    seen.add(r.exit);
    return r;
  };
  const text = (r: { lines: string[] }) => r.lines.join("\n");

  // A healthy export: enough leads in each half, split at 50.
  const slateIds = idsInBucketRange(MIN_LEADS_PER_HALF + 20, true, 50, "a04UiS");
  const calIds = idsInBucketRange(MIN_LEADS_PER_HALF + 20, false, 50, "a04UiC");
  const healthyRows = [
    ...slateIds.flatMap((id, i) => lead(id, "slate", i < 30 ? ["view_booker", "complete_booking"] : i < 60 ? ["view_booker"] : [])),
    ...calIds.flatMap((id, i) => lead(id, "cal.com", i < 20 ? ["view_booker", "complete_booking"] : i < 70 ? ["view_booker"] : [])),
  ];
  const healthy = judge(csv(healthyRows), { PILOT_SPLIT_PERCENT: "50" });
  eq(healthy.exit, PILOT_SPLIT_EXIT.compared, "a healthy export exits 0");
  assert(text(healthy).includes("left without opening the booker"), "the report names its bounce definition");
  assert(/session bounce/i.test(text(healthy)), "and says why GA4's session bounce is not used");
  assert(text(healthy).includes(`${slateIds.length} leads`), "the report says how many leads it compared");
  assert(!/[\u2014\u2013]/.test(text(healthy)), "the report carries no em or en dash");
  eq(healthy.slateBookedKeys.size, 30, "the Slate half's booked submissions are handed to the cross check");

  const noFile = judge(null);
  eq(noFile.exit, PILOT_SPLIT_EXIT.notConfigured, "no PILOT_SPLIT_CSV exits on its own code, before anything is read");

  eq(judge("").exit, PILOT_SPLIT_EXIT.unreadableFile, "an empty file exits unreadable");
  eq(judge(csv([], HEADER.slice(1))).exit, PILOT_SPLIT_EXIT.missingColumn, "a missing column exits on its own code");
  eq(
    judge(csv([["x", "a04Ui000000AAAA", "slate", "booking_assignment", "", "1"]])).exit,
    PILOT_SPLIT_EXIT.unreadableValue,
    "an unreadable value exits on its own code",
  );
  eq(judge(csv(healthyRows), { PILOT_SPLIT_PERCENT: "fifty" }).exit, PILOT_SPLIT_EXIT.unreadablePercent, "an unreadable percentage");
  eq(judge(csv(healthyRows), { PILOT_SPLIT_PERCENT: "150" }).exit, PILOT_SPLIT_EXIT.unreadablePercent, "a percentage over 100");

  const noAssign = judge(
    csv([["20261005", "a04Ui000000AAAA", "slate", "cal_booking", "view_booker", "1"]]),
    { PILOT_SPLIT_PERCENT: "50" },
  );
  eq(noAssign.exit, PILOT_SPLIT_EXIT.noAssignmentEvents, "an export with no booking_assignment at all names the missing tag");
  assert(/GTM/.test(text(noAssign)), "and points at the GTM tag");

  eq(judge(csv(healthyRows)).exit, PILOT_SPLIT_EXIT.populationUnchecked, "no percentage and no xbc: the population cannot be checked");

  const outsideRows = [...healthyRows, ...lead(idsInBucketRange(1, true, 50, "a04UiX")[0], "cal.com")];
  const outside = judge(csv(outsideRows), { PILOT_SPLIT_PERCENT: "50" });
  eq(outside.exit, PILOT_SPLIT_EXIT.outsidePilot, "a cal.com lead under the percentage means the export holds leads outside the pilot");
  assert(/xbc/.test(text(outside)), "and says what would remove them");

  const onlySlate = judge(csv(slateIds.flatMap((id) => lead(id, "slate"))), { PILOT_SPLIT_PERCENT: "50" });
  eq(onlySlate.exit, PILOT_SPLIT_EXIT.emptyHalf, "a half with no leads exits on its own code");

  const fewRows = [
    ...slateIds.slice(0, MIN_LEADS_PER_HALF - 1).flatMap((id, i) => lead(id, "slate", i < 20 ? ["complete_booking"] : [])),
    ...calIds.flatMap((id, i) => lead(id, "cal.com", i < 20 ? ["complete_booking"] : [])),
  ];
  const few = judge(csv(fewRows), { PILOT_SPLIT_PERCENT: "50" });
  eq(few.exit, PILOT_SPLIT_EXIT.tooFewToRead, `a half under ${MIN_LEADS_PER_HALF} leads is not yet readable`);
  assert(/not yet readable/i.test(text(few)), "and says so rather than reporting a finding");
  const fewBookings = judge(
    csv([
      ...slateIds.flatMap((id, i) => lead(id, "slate", i < MIN_OUTCOMES_PER_HALF - 1 ? ["complete_booking"] : [])),
      ...calIds.flatMap((id, i) => lead(id, "cal.com", i < 20 ? ["complete_booking"] : [])),
    ]),
    { PILOT_SPLIT_PERCENT: "50" },
  );
  eq(fewBookings.exit, PILOT_SPLIT_EXIT.tooFewToRead, `fewer than ${MIN_OUTCOMES_PER_HALF} bookings in a half is not yet readable`);

  const noBooker = judge(
    csv([...slateIds.flatMap((id) => lead(id, "slate")), ...calIds.flatMap((id) => lead(id, "cal.com"))]),
    { PILOT_SPLIT_PERCENT: "50" },
  );
  eq(noBooker.exit, PILOT_SPLIT_EXIT.noBookerEvents, "plenty of leads and not one booker event means the booker events are not in the export");
  const halfEach = Math.floor(MIN_LEADS_PER_HALF / 2);
  const thinNoBooker = judge(
    csv([...slateIds.slice(0, halfEach).flatMap((id) => lead(id, "slate")), ...calIds.slice(0, halfEach).flatMap((id) => lead(id, "cal.com"))]),
    { PILOT_SPLIT_PERCENT: "50" },
  );
  eq(
    thinNoBooker.exit,
    PILOT_SPLIT_EXIT.tooFewToRead,
    `${halfEach} leads a half with no booker events is too few to read, never "plenty of leads": the floor is per half`,
  );

  // The planner, from the environment.
  const plan = planFromEnv({
    PILOT_SPLIT_PLAN: "1",
    PILOT_SPLIT_LEADS_PER_DAY: "200",
    PILOT_SPLIT_PERCENT: "50",
    PILOT_SPLIT_BASE_RATE: "0.10",
    PILOT_SPLIT_LIFT: "0.02",
  });
  seen.add(plan.exit);
  eq(plan.exit, PILOT_SPLIT_EXIT.compared, "a complete plan exits 0");
  assert(plan.lines.join("\n").includes("39 days"), "and names the days");
  const planMissing = planFromEnv({ PILOT_SPLIT_PLAN: "1", PILOT_SPLIT_LEADS_PER_DAY: "200" });
  seen.add(planMissing.exit);
  eq(planMissing.exit, PILOT_SPLIT_EXIT.planRefused, "a plan missing an input is refused");
  assert(planMissing.lines.join("\n").includes("PILOT_SPLIT_BASE_RATE"), "and names what is missing");
  const planPercent = planFromEnv({
    PILOT_SPLIT_PLAN: "1",
    PILOT_SPLIT_LEADS_PER_DAY: "200",
    PILOT_SPLIT_PERCENT: "12",
    PILOT_SPLIT_BASE_RATE: "12",
    PILOT_SPLIT_LIFT: "0.02",
  });
  eq(planPercent.exit, PILOT_SPLIT_EXIT.planRefused, "a base rate given as a percentage rather than a fraction is refused");

  // The Slate cross check.
  const cross = crossCheckSlateBookings({
    ga4Booked: new Set(["a04UiS000000001", "a04UiS000000002"]),
    slateHalf: new Set(["a04UiS000000001", "a04UiS000000002", "a04UiS000000003"]),
    slateRows: ["a04UiS000000001AAA", "a04UiS000000003", "a04UiZ000000009"],
  });
  eq(cross.ga4Only, 1, "a GA4 booking with no Slate row is counted");
  eq(cross.slateOnly, 1, "a Slate booking for a Slate half lead GA4 never saw book is counted");
  eq(cross.outsideExport, 1, "a Slate booking for a submission not in the export is counted apart");
  eq(cross.matched, 1, "an 18 character Slate id matches its 15 character GA4 form");
  const crossFailed = judgePilotSplit({ csvText: csv(healthyRows), env: { PILOT_SPLIT_PERCENT: "50" }, slateCheck: { ok: false, message: "boom" } });
  seen.add(crossFailed.exit);
  eq(crossFailed.exit, PILOT_SPLIT_EXIT.crossCheckFailed, "a cross check that could not read Slate exits on its own code");
  const crossSkipped = judgePilotSplit({
    csvText: csv(healthyRows),
    env: { PILOT_SPLIT_PERCENT: "50" },
    slateCheck: { ok: "skipped", missing: ["NEXT_PUBLIC_SUPABASE_URL"] },
  });
  eq(crossSkipped.exit, PILOT_SPLIT_EXIT.compared, "a skipped cross check does not fail the comparison");
  assert(/cross check was skipped: NEXT_PUBLIC_SUPABASE_URL is not set/.test(crossSkipped.lines.join("\n")), "and names what was missing, never a secret key it did not look for (L11)");

  for (const [name, code] of Object.entries(PILOT_SPLIT_EXIT)) {
    assert(seen.has(code), `exit ${code} (${name}) is produced by at least one case`);
  }
  eq(new Set(Object.values(PILOT_SPLIT_EXIT)).size, Object.keys(PILOT_SPLIT_EXIT).length, "no two outcomes share an exit code");
}

finish();
