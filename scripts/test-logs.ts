// TDD test for the log-query tool (#807).
//
// Reading Slate's production logs keeps producing a zero from data that is
// really there, and a zero is indistinguishable from an outage. It has caused a
// wrong conclusion twice: #708 decided Cloudflare drops console.error (it does
// not), and its own canary then decided Cloudflare drops console.log (it does
// not either, #801 measured 250/250 captured).
//
// So the ONE rule this tool exists to enforce: never report a zero without first
// proving the query can find something that is definitely there. Everything below
// is that rule, plus the query shapes that silently return nothing.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-logs.ts
import {
  search,
  buildCountQuery,
  assertWindowSane,
  judge,
  exitCodeFor,
  countFromResponse,
  CONTROL_NEEDLE,
  type Judgement,
} from "./logs.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else {
    console.log("ok:", msg);
  }
}

const NOW = Date.parse("2026-07-14T18:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

// --- The query shape. Every one of these mistakes returns zero rows from data
// that is present, which is the whole failure mode.
const q = buildCountQuery({
  needle: "recompute cycle",
  fromIso: iso(NOW - 60 * MIN),
  toIso: iso(NOW),
});

assert(q.view === "calculations", "uses the calculations view (the events view throws on app log rows)");
// Verified against the live REST API (#807): it takes Unix MILLISECONDS and 400s
// on the ISO strings the MCP tool accepts. Getting this wrong is not a loud
// failure you would notice: it is a 400 that a lazier tool would report as zero.
assert(
  typeof q.timeframe.from === "number" && typeof q.timeframe.to === "number",
  "sends the timeframe as Unix ms numbers (the API 400s on ISO strings)",
);
assert(
  q.timeframe.from === NOW - 60 * MIN && q.timeframe.to === NOW,
  "converts the window to the exact ms bounds requested",
);
assert(
  JSON.stringify(q.parameters.calculations).includes("count"),
  "counts rather than listing events",
);
const filterKeys = q.parameters.filters.map((f) => f.key);
assert(
  filterKeys.includes("message"),
  "filters on the bare `message` field",
);
assert(
  !filterKeys.includes("$metadata.message"),
  "never filters on $metadata.message (that holds only invocation records)",
);
// The level trap: console.log lands with NO level, so ANY level filter or
// group-by hides it. It is banned in src/ now (#801), but a log-reading tool must
// not reintroduce the query shape that hid it.
assert(
  !filterKeys.includes("level") && !filterKeys.includes("$metadata.level"),
  "never filters on level (console.log carries none, so a level filter hides it)",
);
assert(
  (q.parameters.groupBys ?? []).length === 0,
  "never groups by level (group-by returns an empty aggregation even when a filter matches)",
);

// --- Window sanity. A window in the future silently returns zero rows.
let threw = false;
try {
  assertWindowSane({ fromIso: iso(NOW + 5 * MIN), toIso: iso(NOW + 60 * MIN), nowMs: NOW });
} catch {
  threw = true;
}
assert(threw, "rejects a window in the future instead of reporting its empty result");

threw = false;
try {
  assertWindowSane({ fromIso: iso(NOW), toIso: iso(NOW - 60 * MIN), nowMs: NOW });
} catch {
  threw = true;
}
assert(threw, "rejects an inverted window (from after to)");

const sane = assertWindowSane({ fromIso: iso(NOW - 60 * MIN), toIso: iso(NOW - 5 * MIN), nowMs: NOW });
assert(sane.lagWarning === false, "a window that ended well in the past needs no lag warning");

// Ingestion lags a minute or two: a window ending ~now undercounts, which is how
// a 50-line level got read back as 30 during the #801 canary.
const fresh = assertWindowSane({ fromIso: iso(NOW - 10 * MIN), toIso: iso(NOW), nowMs: NOW });
assert(fresh.lagWarning === true, "warns when the window ends inside the ingestion lag");

// --- The core rule: a zero is only believable if the control found something.
const unverifiable: Judgement = judge({ needleCount: 0, controlCount: 0 });
assert(
  unverifiable.trustworthy === false && unverifiable.verdict === "unverifiable",
  "a zero with a DEAD control is unverifiable, never reported as absence",
);

const absent: Judgement = judge({ needleCount: 0, controlCount: 120 });
assert(
  absent.trustworthy === true && absent.verdict === "absent",
  "a zero with a LIVE control is a trustworthy absence",
);

const present: Judgement = judge({ needleCount: 7, controlCount: 120 });
assert(
  present.trustworthy === true && present.verdict === "present",
  "a non-zero result is present",
);

// A dead control poisons even a non-zero needle result: if the control line is
// missing, the query/window/credentials are wrong and nothing here can be trusted.
const contradictory = judge({ needleCount: 7, controlCount: 0 });
assert(
  contradictory.trustworthy === false,
  "a dead control makes even a NON-zero count untrustworthy",
);

// --- Exit codes, so this is usable from a script: grep-like, with a distinct
// code for "do not trust me" so a caller can never mistake it for a clean zero.
assert(exitCodeFor(present) === 0, "found -> exit 0");
assert(exitCodeFor(absent) === 1, "trustworthy absence -> exit 1");
assert(exitCodeFor(unverifiable) === 2, "unverifiable -> exit 2, distinct from a clean zero");

// --- The control needle must be something that is ALWAYS being emitted.
assert(
  CONTROL_NEEDLE.length > 0,
  "ships a default positive control needle",
);

// --- The response parser, pinned to the shape the LIVE API actually returned
// (captured 2026-07-14). A parser that silently yields 0 on a shape change would
// manufacture exactly the false absence this tool exists to prevent.
const liveHit = {
  result: {
    calculations: [
      {
        alias: "n",
        calculation: "count",
        aggregates: [{ value: 59, interval: 1, sampleInterval: 1, count: 59 }],
        series: [{ time: "2026-07-14 17:37:00", data: [{ value: 1 }] }],
      },
    ],
  },
};
const liveMiss = {
  result: {
    calculations: [
      {
        alias: "n",
        calculation: "count",
        aggregates: [{ value: 0, interval: 0, sampleInterval: 0, count: 0 }],
        series: [{ time: "2026-07-14 17:38:00", data: [] }],
      },
    ],
  },
};
assert(countFromResponse(liveHit) === 59, "parses the count out of a real API hit response");
assert(countFromResponse(liveMiss) === 0, "parses a real API zero response as 0");

// A shape it does NOT understand must NOT quietly become 0: that is a false
// absence. It has to blow up so the caller knows the parser is stale.
threw = false;
try {
  countFromResponse({ result: { somethingElse: true } });
} catch {
  threw = true;
}
assert(threw, "throws on an unrecognized response shape rather than silently returning 0");

// --- End to end through a hand-written fake, proving the control is queried in
// the SAME window as the needle. A control measured over a different window would
// be no control at all.
const asked: { needle: string; from: number; to: number }[] = [];
const fakeQuery = async (q: ReturnType<typeof buildCountQuery>): Promise<number> => {
  const needle = q.parameters.filters.find((f) => f.key === "message")!.value;
  asked.push({ needle, from: q.timeframe.from, to: q.timeframe.to });
  return needle === CONTROL_NEEDLE ? 120 : 0;
};

const e2e = await search({
  needle: "some-line-that-is-not-there",
  control: CONTROL_NEEDLE,
  fromIso: iso(NOW - 60 * MIN),
  toIso: iso(NOW),
  query: fakeQuery,
});

assert(asked.length === 2, "queries BOTH the needle and the control");
assert(
  asked[0].from === asked[1].from && asked[0].to === asked[1].to,
  "measures the control over the SAME window as the needle",
);
assert(
  e2e.verdict === "absent" && e2e.trustworthy === true,
  "a live control turns a zero into a trustworthy absence, end to end",
);

// And the inverse: control dead -> the same zero is NOT reported as absence.
const e2eDead = await search({
  needle: "some-line-that-is-not-there",
  control: CONTROL_NEEDLE,
  fromIso: iso(NOW - 60 * MIN),
  toIso: iso(NOW),
  query: async () => 0,
});
assert(
  e2eDead.verdict === "unverifiable" && exitCodeFor(e2eDead) === 2,
  "a dead control turns the same zero into UNVERIFIABLE, end to end",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
