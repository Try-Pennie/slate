/**
 * #1318: every way a customer's booking request can end without a booking has a
 * recorded decision about whether it needs a rate signal.
 *
 * The defect this guards is not a wrong value, it is an OMISSION. A new refusal
 * path is the shortest thing in the world to add (one early return), it is
 * individually plausible every time it fires, and at volume it means customers are
 * being turned away with nothing anywhere saying so. That is the 2026-08-06 cal.com
 * failure exactly, and the only reason Pennie found out was a complaint monitor
 * outside the booking system.
 *
 * Read BOTH ways, because a hand-written registry can only ever check what somebody
 * remembered to list, and the entry that is missing is the one that needed deciding
 * (L96):
 *
 *   - every refusal site in the booking entry points names a catalog entry;
 *   - every catalog entry is named by a live site, so a path that was removed
 *     cannot leave a decision behind that reads as coverage.
 *
 * Boundary, stated so this is never read as broader than it is: the response-shape
 * scan looks for a 4xx/5xx status LITERAL. The direct booking API returns its
 * status through a variable from `mapBookingError`, so those sites are covered by
 * the annotation on each branch of that mapping rather than by the shape scan.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-refusal-catalog.ts
 */
import { readFileSync } from "node:fs";
import {
  AUTH_REFUSAL_REASONS,
  authRefusalCounting,
} from "../src/lib/booking/api-auth.ts";
import { REFUSAL_CATALOG, refusalPath } from "../src/lib/booking/refusal-catalog.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const FILES = [
  "src/app/booking/route.ts",
  "src/app/api/bookings/route.ts",
  "src/app/api/bookings/[token]/reschedule/route.ts",
  // #2373. The lead cancel route, reached by both the manage page and the booker's
  // panel. It recorded nothing at all and named no decision, so a cancel that turned
  // a lead away was invisible to every counter Slate has, and the one that told them
  // a call was cancelled while it stood was invisible too.
  "src/app/api/bookings/[token]/cancel/route.ts",
  // #2591. The key authed cancel moved here when it gained a POST form, so the 400 it
  // answers (api_query_invalid) left the route file above. Listed so the annotation is
  // still checked where the refusal now lives, rather than exempt by having moved.
  "src/lib/booking/direct-cancel-http.ts",
  // #3543. The direct booking API's error to code mapping moved here so Marcia's
  // booking MCP endpoint shares it; its branches carry the annotations.
  "src/lib/booking/api-error-map.ts",
];

/** Source with comments kept (the annotations live in them) and with them
 *  stripped, so a shape check can never be satisfied by prose about a call (L103). */
const sources = FILES.map((f) => {
  const raw = readFileSync(f, "utf8");
  return {
    file: f,
    raw,
    code: raw.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n"),
  };
});

// ------------------------------------------------------- the catalog itself

{
  eq(
    REFUSAL_CATALOG.length,
    new Set(REFUSAL_CATALOG.map((r) => r.id)).size,
    "no two entries share an id, or one decision would silently stand in for another",
  );
  for (const r of REFUSAL_CATALOG) {
    assert(r.why.trim().length > 40, `${r.id} records the reasoning, not just the verdict`);
    // A decision to page on a share is only true if the path reaches the counter.
    if (r.rateSignal.kind === "covered" || r.rateSignal.kind === "covered-and-pages") {
      eq(
        r.counting.kind,
        "error",
        `${r.id} claims the failure-rate window covers it, so it must be recorded as an error ` +
          `outcome; a covered signal over an uncounted path is a decision that cannot be true`,
      );
    }
    // #1442 / #1709: a path kept OUT of the share carries its own counter and its
    // own signal, and the two halves check each other. A counter nothing reads is
    // a stored value with no reader (L46); a signal over a path that records
    // nothing is a decision that cannot be true.
    if (r.counting.kind === "own-counter") {
      eq(
        r.rateSignal.kind,
        "uncounted-but-pages",
        `${r.id} records into its own counter, so it must page from that counter; a private ` +
          `counter nobody judges is a number with no reader`,
      );
      assert(
        r.counting.outcome.trim().length > 0,
        `${r.id} names the outcome it records under, so the counter can be found`,
      );
    }
    if (r.rateSignal.kind === "uncounted-but-pages") {
      eq(
        r.counting.kind,
        "own-counter",
        `${r.id} claims its own signal, so it must really record somewhere; a page over a path ` +
          `that records nothing can never fire`,
      );
      assert(
        r.rateSignal.alertKey.trim().length > 0,
        `${r.id} names the alert key it pages on, so the all-clear can find it again`,
      );
    }
    // And the reverse: you cannot page on a share of something you never count.
    if (r.counting.kind === "none") {
      assert(
        r.rateSignal.kind === "none" || r.rateSignal.kind === "deferred",
        `${r.id} records nothing, so it can only be a deliberate no or a deferred yes; it ` +
          `cannot claim a signal that is live`,
      );
    }
    if (r.rateSignal.kind === "deferred") {
      assert(
        r.rateSignal.issue > 0,
        `${r.id} defers its signal, so it names the issue that will build it (L65): a "later" ` +
          `with no issue becomes a "no" the moment the reason is forgotten`,
      );
    }
  }
  // The deliberate NOs are the point of the file, so at least one has to survive,
  // or the catalog has quietly become a list of things that alert.
  assert(
    REFUSAL_CATALOG.some((r) => r.rateSignal.kind === "none"),
    "the deliberate no is recorded too, which is what stops it being re-derived",
  );
}

// --------------------------------------------- every annotation is a real id

const annotated = new Set<string>();
{
  const bad: string[] = [];
  for (const s of sources) {
    for (const m of s.raw.matchAll(/\/\/\s*refusal:\s*([A-Za-z0-9_]+)/g)) {
      const id = m[1]!;
      annotated.add(id);
      if (!refusalPath(id)) bad.push(`${s.file}: ${id}`);
    }
  }
  eq(bad, [], "every `// refusal:` annotation names an entry in the catalog");
}

// ----------------------------------- and every entry is named by a live site

{
  const orphans = REFUSAL_CATALOG.filter(
    (r) => r.rateSignal.kind !== "deferred" && !annotated.has(r.id),
  ).map((r) => r.id);
  eq(
    orphans,
    [],
    "every catalog entry is named by a live refusal site; an entry nothing reaches is a " +
      "decision about a path that no longer exists, and it reads exactly like coverage",
  );
}

// ------------------------------- every refusal response names a decision

// The direction that catches a path nobody wrote down. A 4xx/5xx literal in a
// booking entry point is a customer being sent away, so it has to carry an id.
const REFUSAL_SHAPE = /status:\s*(4\d\d|5\d\d)\b/;

/**
 * Is this refusal site annotated? The annotation sits on the line or in the
 * comment block introducing the statement, and a `NextResponse.json(...)` spanning
 * several lines puts the status literal a few lines below that comment, so the
 * search reaches back a short way rather than only to the line above.
 *
 * It stops at the previous refusal-shaped line, so ONE annotation can never be read
 * as covering two different refusals: each site has to carry its own decision.
 */
const LOOKBACK = 10;
function annotationNear(lines: string[], i: number, shape: RegExp): boolean {
  if (/\/\/\s*refusal:/.test(lines[i] ?? "")) return true;
  for (let j = i - 1; j >= 0 && j >= i - LOOKBACK; j--) {
    const line = lines[j] ?? "";
    if (/\/\/\s*refusal:/.test(line)) return true;
    if (shape.test(line)) return false;
  }
  return false;
}

{
  const offenders: string[] = [];
  for (const s of sources) {
    const lines = s.code.split("\n");
    const rawLines = s.raw.split("\n");
    lines.forEach((line, i) => {
      if (!REFUSAL_SHAPE.test(line)) return;
      if (!annotationNear(rawLines, i, REFUSAL_SHAPE)) offenders.push(`${s.file}:${i + 1}: ${line.trim()}`);
    });
  }
  eq(
    offenders,
    [],
    "every refusal response in a booking entry point names the decision that was made about it",
  );
}

// Positive control, or a renamed pattern would leave this green over a refusal
// nobody decided about (L1).
{
  const sabotaged = ['    return NextResponse.json({ error: "nope" }, { status: 402 });'];
  eq(
    sabotaged.filter((l) => REFUSAL_SHAPE.test(l) && !annotationNear(sabotaged, 0, REFUSAL_SHAPE))
      .length,
    1,
    "an unannotated refusal added to a booking route IS caught",
  );
}

// And the annotation really satisfies it, or the control above would pass on a
// scanner that rejects everything.
{
  const ok = [
    "    // refusal: slot_unavailable",
    '    return NextResponse.json({ error: "gone" }, { status: 409 });',
  ];
  eq(
    ok.filter((l, i) => REFUSAL_SHAPE.test(l) && !annotationNear(ok, i, REFUSAL_SHAPE)).length,
    0,
    "and an annotated one is accepted",
  );
}

// ------------------------- the counted codes are the ones the catalog claims

// The claim "the #1313 window sees this" is only true if the code the route
// records matches the code written down, so the two are compared rather than
// assumed to agree.
{
  const recorded = new Set<string>();
  for (const s of sources) {
    // `recordRoutedOutcome` is the booker confirm's own name for the same call
    // (#2073): it records exactly as `recordApiOutcome` does for a routed confirm
    // and nothing for one made through an agent's own link, which is not routed.
    for (const m of s.code.matchAll(/(?:recordApiOutcome|recordRoutedOutcome)\(\s*"error"\s*,[^,]+,\s*"([^"]+)"/g)) {
      recorded.add(m[1]!);
    }
  }
  // #1429: this used to exempt the WHOLE booking API surface, on the grounds that
  // its codes come from mapBookingError rather than a literal. That made every new
  // counted path on that surface exempt from the check meant to catch it (L96), so
  // the exemption is now per entry and has to be declared: `codeFrom: "mapped"`.
  // Anything else, including a missing field, must really record its code.
  const SCANNABLE = (r: (typeof REFUSAL_CATALOG)[number]) =>
    r.codeFrom !== "mapped" && r.codeFrom !== "authorizer";
  const missing = REFUSAL_CATALOG.filter(
    (r) => r.counting.kind === "error" && SCANNABLE(r) && !recorded.has(r.counting.code),
  ).map((r) => `${r.id} -> ${r.counting.kind === "error" ? r.counting.code : ""}`);
  eq(
    missing,
    [],
    "every path the catalog says is counted really records that error code, so the decision " +
      "cannot be true on paper and absent in the route",
  );
}

// An `authorizer` code is checked against the FUNCTION that produces it, not
// against a string in a route. The authorizer records `counting.code` through a
// variable, so a literal scan could never see it, and declaring the source
// without checking it would be the exemption this guard just stopped granting by
// surface (#1429).
{
  const produced = new Set(
    AUTH_REFUSAL_REASONS.flatMap((reason) =>
      (["write", "read"] as const).map((surface) => authRefusalCounting(reason, surface)),
    )
      .filter((d) => d.kind === "error")
      .map((d) => (d.kind === "error" ? d.code : "")),
  );
  const unproduced = REFUSAL_CATALOG.filter(
    (r) => r.codeFrom === "authorizer" && r.counting.kind === "error" && !produced.has(r.counting.code),
  ).map((r) => r.id);
  eq(
    unproduced,
    [],
    "every entry whose code comes from the authorizer names a code the authorizer really produces",
  );
  assert(produced.size > 0, "and the authorizer really counts something, or the check is vacuous");
}

// ------------------------- the full day refusals are counted, and say where (#4392)

// A program lead refused because the placeholder's day was full is the limit doing its
// job, so it stays out of the failure share. #4392 built what the two entries used to
// defer to: each refusal is bumped into program_lead_outcomes (kind limit_refused) on the
// Eastern day it HAPPENED, which is not the day of the call the admin page counts
// bookings by, and the admin page shows it beside them. The entries must say so, and must
// no longer read as a promise still owed.
{
  for (const id of ["placeholder_day_full", "reschedule_placeholder_day_full"]) {
    const r = refusalPath(id);
    assert(r !== undefined, `${id} is in the catalog`);
    if (!r) continue;
    eq(r.rateSignal.kind, "none", `${id} no longer defers its signal: it is counted, and deliberately not paged`);
    assert(r.why.includes("program_lead_outcomes"), `${id} names where it is counted`);
    assert(/Eastern day it happened/.test(r.why), `${id} says it counts on the Eastern day it happened, not the day of the call`);
    assert(r.why.includes("/admin/program-leads"), `${id} names the page that shows it`);
    assert(!/until then|until #4392|by #4392/i.test(r.why), `${id} no longer reads as waiting on #4392`);
  }
  eq(
    REFUSAL_CATALOG.filter((r) => r.rateSignal.kind === "deferred" && r.rateSignal.issue === 4392).map((r) => r.id),
    [],
    "nothing defers to #4392 any more, which is the issue that built it",
  );
}

finish();
