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
  newestBucketMsFromResponse,
  CONTROL_NEEDLE,
  type Judgement,
} from "./logs.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-07-14T18:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

// --- The query shape. Every one of these mistakes returns zero rows from data
// that is present, which is the whole failure mode.
const q = buildCountQuery({
  needle: "tag=recompute",
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

// --- The control must prove the window's RECENT END, not merely the window.
//
// The gap this closes, measured on 2026-08-17. Asking at 16:19 UTC whether
// `tag=rate-limit` appeared around 14:44 returned 0 for the needle and 101 for the
// control over the same 4h window, which the count-only rule scored as a trustworthy
// ABSENCE. Cloudflare's pipeline was about three hours behind: at 17:10 the control
// returned 0 over 1h, 50 over 4h and 290 over 8h for a lane that emits every minute,
// and `wrangler tail` captured lines live from production that the API reported zero
// of minutes later.
//
// So the control was doing its job and still could not answer. It proves the query
// shape, the credentials and the field names; it cannot prove the query can SEE the
// part of the window being asked about, because a line from three hours ago satisfies
// it just as well as one from a minute ago. A control satisfiable outside the period
// in question cannot detect a lagging pipeline (the L98 family, on the side where the
// reassuring answer is "absent").
{
  const toMs = Date.UTC(2026, 7, 17, 16, 19);
  const fresh = toMs - 90_000;
  const stale = toMs - 3 * 60 * 60_000;

  const lagged = judge({
    needleCount: 0,
    controlCount: 101,
    controlNewestMs: stale,
    windowEndMs: toMs,
  });
  assert(
    lagged.verdict === "unverifiable" && lagged.trustworthy === false,
    "a live control whose newest line is HOURS old cannot make a zero trustworthy",
  );
  // Distinct from a dead control, because the actions differ: one means fix the query,
  // the other means the data has not landed yet, so wait or use wrangler tail (L11).
  assert(
    lagged.reason !== judge({ needleCount: 0, controlCount: 0, controlNewestMs: null, windowEndMs: toMs }).reason,
    "and it says so in its OWN words, not the dead-control wording",
  );
  assert(
    /lag|behind|stale|recent/i.test(lagged.reason),
    "naming the lag, so the reader knows the query was fine",
  );

  const ok = judge({
    needleCount: 0,
    controlCount: 101,
    controlNewestMs: fresh,
    windowEndMs: toMs,
  });
  assert(
    ok.verdict === "absent" && ok.trustworthy === true,
    "a control whose newest line is RECENT still makes a zero a trustworthy absence",
  );

  // The positive case must survive the new rule too, or the tool becomes useless: a
  // needle that WAS found is still found.
  const found = judge({
    needleCount: 3,
    controlCount: 101,
    controlNewestMs: fresh,
    windowEndMs: toMs,
  });
  assert(found.verdict === "present" && found.trustworthy === true, "a fresh control leaves a hit reported as present");

  // A needle FOUND while the pipeline is behind is still trustworthy for what it
  // found: the rows it counted exist. Only the ABSENCE claim depends on recency, and
  // conflating the two would make the tool cry wolf on every successful search during
  // a lag, which is how a guard gets ignored (L36).
  const foundWhileLagged = judge({
    needleCount: 3,
    controlCount: 101,
    controlNewestMs: stale,
    windowEndMs: toMs,
  });
  assert(
    foundWhileLagged.verdict === "present" && foundWhileLagged.trustworthy === true,
    "a HIT during a lag is still a hit: only an absence claim needs the recent end",
  );

  // An unreadable frontier is the fail-safe side: we could not establish recency, so
  // an absence cannot be vouched for.
  const unknownFrontier = judge({
    needleCount: 0,
    controlCount: 101,
    controlNewestMs: null,
    windowEndMs: toMs,
  });
  assert(
    unknownFrontier.trustworthy === false,
    "an unknown control frontier makes an absence untrustworthy rather than assuming freshness",
  );
  // Assert the REASON, not only the verdict. Removing the null branch still produces
  // "unverifiable", because `windowEndMs - null` coerces to a vast lag, so a verdict-only
  // assertion passes on a message claiming the pipeline is millions of minutes behind. The
  // outcome would be right for a reason the check never measured, which is the failure mode
  // an instrument hides best (L11, L154).
  assert(
    unknownFrontier.reason !== lagged.reason,
    "and says recency could not be ESTABLISHED, not that the pipeline is behind by some measured amount",
  );
  assert(
    !/\d{4,} minutes/.test(unknownFrontier.reason),
    "and never reports a fabricated lag figure derived from a missing frontier",
  );
}

// --- Reading the frontier out of the response, so the rule above has an input.
{
  // The `calculations` view returns a `series` whose empty buckets carry `data: []`.
  // The last NON-EMPTY bucket is the pipeline's frontier. Pinned to the live shape.
  const body = {
    result: {
      calculations: [
        {
          aggregates: [{ value: 101, count: 101 }],
          series: [
            { time: "2026-08-17 12:20:00", data: [{ value: 5 }] },
            { time: "2026-08-17 13:20:00", data: [{ value: 7 }] },
            { time: "2026-08-17 14:20:00", data: [] },
            { time: "2026-08-17 15:20:00", data: [] },
          ],
        },
      ],
    },
  };
  eq(
    newestBucketMsFromResponse(body),
    Date.parse("2026-08-17 13:20:00Z"),
    "the newest NON-EMPTY bucket is the frontier, not the last bucket in the series",
  );
  eq(
    newestBucketMsFromResponse({ result: { calculations: [{ aggregates: [{ value: 0 }], series: [] }] } }),
    null,
    "no buckets at all reports null rather than a guessed time",
  );
  eq(
    newestBucketMsFromResponse({ result: { calculations: [{ aggregates: [{ value: 0 }], series: [{ time: "nonsense", data: [{ value: 1 }] }] }] } }),
    null,
    "an unparseable bucket time reports null rather than NaN flowing into a comparison (L50)",
  );
  // A response with no series at all: the API shape changed or the view differs. Null,
  // never a guess, because the caller maps null to the fail-safe side.
  eq(
    newestBucketMsFromResponse({ result: { calculations: [{ aggregates: [{ value: 3 }] }] } }),
    null,
    "a response carrying no series reports null",
  );
}

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
// The control answers with a FRESH frontier here, so this case is about the window
// matching, not about recency; the lagging case is exercised separately below.
const fakeQuery = async (q: ReturnType<typeof buildCountQuery>) => {
  const needle = q.parameters.filters.find((f) => f.key === "message")!.value;
  asked.push({ needle, from: q.timeframe.from, to: q.timeframe.to });
  return needle === CONTROL_NEEDLE
    ? { count: 120, newestMs: q.timeframe.to - 60_000 }
    : { count: 0, newestMs: null };
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
  query: async () => ({ count: 0, newestMs: null }),
});
assert(
  e2eDead.verdict === "unverifiable" && exitCodeFor(e2eDead) === 2,
  "a dead control turns the same zero into UNVERIFIABLE, end to end",
);

// And the case this whole change exists for, end to end: the control is ALIVE, plenty of
// it, and its newest line is hours older than the window's end. The count-only rule called
// that a trustworthy absence.
const e2eLagged = await search({
  needle: "some-line-that-is-not-there",
  control: CONTROL_NEEDLE,
  fromIso: iso(NOW - 4 * 60 * MIN),
  toIso: iso(NOW),
  query: async (q) => {
    const needle = q.parameters.filters.find((f) => f.key === "message")!.value;
    // Plenty of control, and its newest line three hours older than the window's end:
    // the exact shape measured on 2026-08-17.
    return needle === CONTROL_NEEDLE
      ? { count: 101, newestMs: q.timeframe.to - 3 * 60 * 60_000 }
      : { count: 0, newestMs: null };
  },
});
assert(
  e2eLagged.verdict === "unverifiable" && exitCodeFor(e2eLagged) === 2,
  "a LAGGING control turns a zero into UNVERIFIABLE, end to end",
);
assert(
  /behind|lag/i.test(e2eLagged.reason),
  "and says the query was fine but running behind, so nobody goes looking for a broken query",
);

// The frontier must come from the CONTROL's query, not the needle's. A needle with no
// matches has no frontier at all, and reading recency off it would make every absence
// unverifiable forever, which is the same tool with the answer inverted.
{
  const j = await search({
    needle: "definitely-not-there",
    control: CONTROL_NEEDLE,
    fromIso: iso(NOW - 60 * MIN),
    toIso: iso(NOW),
    query: async (q) => {
      const needle = q.parameters.filters.find((f) => f.key === "message")!.value;
      return needle === CONTROL_NEEDLE
        ? { count: 60, newestMs: q.timeframe.to - 30_000 }
        : { count: 0, newestMs: null };
    },
  });
  assert(
    j.verdict === "absent" && j.trustworthy === true,
    "an absent needle with no frontier of its own is still a trustworthy absence when the CONTROL is fresh",
  );
}

finish();
