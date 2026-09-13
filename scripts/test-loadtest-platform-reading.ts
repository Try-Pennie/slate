// How the load run reads Cloudflare's own numbers (#2279), driven offline.
//
// The platform bar had never once reached a reading on any run, and the reason was
// not the one recorded on the issue. Three separate faults, each measured against
// the live GraphQL API on 2026-09-13, and each of which alone is enough to make the
// bar permanently blind:
//
//   1. `dimensions { outcome }` is not a field. The dimension is `status`. The API
//      answers HTTP 200 with an `errors` array and a null `data`, so the old reader
//      saw "no rows" and blamed a lagging pipeline.
//   2. Nothing looked at `body.errors` on a 200, so a schema error and an idle
//      Worker produced the same sentence (L11).
//   3. The healthy sentinel was `ok`. The real `status` dimension reports
//      `success`, so the first reading that ever arrived would have made EVERY
//      healthy invocation a finding.
//
// Every case below drives the reader with a hand written reply. No network, no
// clock, no credentials.
//
// Run: node --experimental-strip-types scripts/test-loadtest-platform-reading.ts
import {
  HEALTHY_INVOCATION_STATUS,
  INVOCATIONS_QUERY,
  SCHEDULED_QUERY,
  readInvocationsResponse,
  readScheduledResponse,
  shouldPollAgain,
  POLL_REASON,
  WRANGLER_CRON_CPU_MS,
  pollTimings,
  POLL_DEFAULTS,
} from "./loadtest/platform-reading.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { readFileSync } from "node:fs";

// --- the query asks for fields that exist -------------------------------------
// Measured against the live schema: the dimension list for
// workersInvocationsAdaptive is cacheStatus, coloCode, date, datetime,
// datetimeFifteenMinutes, datetimeFiveMinutes, datetimeHour, datetimeMinute,
// datetimeSixHours, dispatchNamespaceName, environmentName, isDispatcher,
// isPreview, previewSlug, scriptName, scriptTag, scriptVersion, status,
// usageModel. There is no `outcome`.
assert(
  !/dimensions\s*\{[^}]*\boutcome\b/.test(INVOCATIONS_QUERY),
  "the invocations query does not ask for `outcome`, which is not a dimension",
);
assert(
  /dimensions\s*\{[^}]*\bstatus\b/.test(INVOCATIONS_QUERY),
  "it asks for `status`, which is",
);
assert(
  /sum\s*\{[^}]*\bsubrequests\b/.test(INVOCATIONS_QUERY),
  "and for subrequests, which the API does expose as a sum",
);
eq(HEALTHY_INVOCATION_STATUS, "success", "the healthy status is `success`, not `ok`");
// The scheduled dataset is RAW, one row per invocation, so it must ask for the per
// invocation CPU and the cron that fired it. Asking it for a `sum` is a schema error
// (its fields are cpuTimeUs, cron, datetime, environmentName, scheduledDatetime,
// scriptName, status), which is the same class of fault as `outcome` above.
assert(
  /cpuTimeUs/.test(SCHEDULED_QUERY) && /\bcron\b/.test(SCHEDULED_QUERY),
  "the scheduled query asks for per invocation CPU and the cron that fired it",
);
assert(
  !/\bsum\s*\{/.test(SCHEDULED_QUERY),
  "and does not ask it for a sum, which it does not have",
);

// --- a reply the reader can use -----------------------------------------------
function reply(rows: unknown) {
  return { data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } };
}

const good = readInvocationsResponse(
  200,
  reply([
    {
      sum: { requests: 600, subrequests: 51_600 },
      quantiles: { cpuTimeP99: 180_000 },
      dimensions: { status: "success" },
    },
    {
      sum: { requests: 2, subrequests: 12 },
      quantiles: { cpuTimeP99: 250_000 },
      dimensions: { status: "exceededCpu" },
    },
  ]),
);
assert(good.ok, "a well formed reply is read");
if (good.ok) {
  eq(good.reading.invocations, 602, "invocations are summed across status rows");
  eq(good.reading.subrequests, 51_612, "so are subrequests");
  eq(good.reading.statuses.success, 600, "the status histogram keeps its own names");
  eq(good.reading.statuses.exceededCpu, 2, "including the unhealthy ones");
  // MICROSECONDS in, milliseconds out. A reading a thousand times too small sits
  // comfortably under every budget (the units are the trap here).
  eq(good.reading.cpuMsP99, 250, "cpuTimeP99 is microseconds and comes back in ms");
}

// --- every way it can fail to read, each with its own sentence ----------------
const refusals: string[] = [];
function refusal(label: string, r: { ok: boolean; why?: string }) {
  assert(!r.ok, `${label} is refused`);
  if (!r.ok && r.why) refusals.push(r.why);
  return r;
}

refusal("a non 200", readInvocationsResponse(500, { errors: [{ message: "boom" }] }));

// THE ONE THAT MATTERED. HTTP 200, a GraphQL `errors` array, null data. This is
// exactly what `dimensions { outcome }` produced on every run.
const schemaError = refusal(
  "a 200 carrying GraphQL errors",
  readInvocationsResponse(200, {
    data: null,
    errors: [{ message: 'unknown field "outcome"' }],
  }),
);
assert(
  !schemaError.ok && /unknown field "outcome"/.test(schemaError.why ?? ""),
  "and it QUOTES what the API objected to, rather than calling it an empty window",
);

refusal("a 200 with no rows at all", readInvocationsResponse(200, reply([])));
refusal("a 200 whose shape is not a listing", readInvocationsResponse(200, { nope: true }));

const distinct = new Set(refusals);
eq(
  distinct.size,
  refusals.length,
  `no two refusals say the same thing (L11), got ${refusals.length} refusals and ${distinct.size} sentences`,
);

// --- the scheduled half, which is what makes the CPU bar judgeable ------------
// `workersInvocationsAdaptive` counts cron invocations ALONGSIDE fetch ones and
// carries no dimension separating them. Slate's cron lanes run under a raised CPU
// ceiling by design (limits.cpu_ms is 120000), so a p99 over a window containing crons is the cron lane, and
// judging it against a per request budget would fail every run for a reason nobody
// should fix (L36). `workersInvocationsScheduled` is the separate raw dataset that
// makes the two tellable apart. Measured on production 2026-09-13: 79 scheduled
// invocations in an hour, the every minute lane at p50 4,281ms and max 74,365ms.
const sched = readScheduledResponse(
  200,
  {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsScheduled: [
              { cpuTimeUs: 4_281_000, cron: "* * * * *", status: "success" },
              { cpuTimeUs: 74_365_000, cron: "* * * * *", status: "success" },
              { cpuTimeUs: 245_000, cron: "*/10 * * * *", status: "success" },
            ],
          },
        ],
      },
    },
  },
);
assert(sched.ok, "the scheduled dataset is read");
if (sched.ok) {
  eq(sched.reading.invocations, 3, "every scheduled invocation is counted");
  eq(sched.reading.worstCpuMs, 74_365, "and the worst CPU is reported in ms");
  eq(
    sched.reading.byCron["* * * * *"]?.worstCpuMs,
    74_365,
    "attributed to the cron expression that produced it, so a lane can be named",
  );
  eq(sched.reading.byCron["*/10 * * * *"]?.invocations, 1, "each cron keeps its own count");
}

// A window with no crons in it is a REAL reading of zero, not a failure to read:
// it is what makes the adaptive percentile request only and therefore judgeable.
const noCrons = readScheduledResponse(200, {
  data: { viewer: { accounts: [{ workersInvocationsScheduled: [] }] } },
});
assert(noCrons.ok, "an empty scheduled window is a reading, not a refusal");
if (noCrons.ok) eq(noCrons.reading.invocations, 0, "and it reads zero");

refusal("a scheduled reply carrying errors", readScheduledResponse(200, {
  data: null,
  errors: [{ message: "nope" }],
}));

// --- polling, because the pipeline is behind by minutes, not hours ------------
// Measured on production 2026-09-13: the newest minute carrying data was 1.9
// minutes old. The "three hours" on the issue belongs to the Workers LOGS query
// pipeline (#1533), which is a different system. So a bounded poll converges,
// where a single immediate read routinely does not.
//
// The clock is a PARAMETER. Nothing here sleeps and nothing reads Date.now (L524).
const pollArgs = { expected: 600, deadlineMs: 300_000 };
eq(
  shouldPollAgain({ ...pollArgs, invocations: null, elapsedMs: 0 }).reason,
  POLL_REASON.nothingYet,
  "a window with no reading at all is polled again",
);
eq(
  shouldPollAgain({ ...pollArgs, invocations: 100, elapsedMs: 0 }).reason,
  POLL_REASON.stillClimbing,
  "so is a count far under what the run itself made",
);
assert(
  shouldPollAgain({ ...pollArgs, invocations: 100, elapsedMs: 0 }).again,
  "and those really do poll",
);
const settled = shouldPollAgain({ ...pollArgs, invocations: 600, elapsedMs: 10_000 });
assert(!settled.again, "a count that has caught up stops the poll");
eq(settled.reason, POLL_REASON.caughtUp, "and says it caught up");
const expired = shouldPollAgain({ ...pollArgs, invocations: 100, elapsedMs: 300_001 });
assert(!expired.again, "the deadline stops it too");
eq(expired.reason, POLL_REASON.deadline, "and that is NOT the same outcome as catching up");
assert(
  POLL_REASON.deadline !== POLL_REASON.caughtUp,
  "a poll that ran out of time must never read as one that succeeded (L98)",
);

// --- the cron ceiling is the one wrangler actually ships ----------------------
// Derived from the real config rather than maintained beside it (L41). A judge
// carrying a stale ceiling would either pass a lane being killed or fail one that
// is fine, and nothing else would notice.
{
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const shipped = Number(/"limits"\s*:\s*\{[^}]*"cpu_ms"\s*:\s*(\d+)/.exec(wrangler)?.[1]);
  assert(Number.isFinite(shipped), "limits.cpu_ms is readable from wrangler.jsonc");
  eq(WRANGLER_CRON_CPU_MS, shipped, "the cron CPU ceiling matches what wrangler ships");
}

// --- the poll timings, defaults and refusals both driven --------------------
// A deliberate ZERO deadline must survive, which is the whole reason this is not
// `Number(raw) || default`: falsiness would replace it with five minutes and the
// run would poll when somebody had asked it not to.
{
  const unset = pollTimings(undefined, undefined);
  assert(unset.ok, "both unset takes the defaults");
  if (unset.ok) {
    eq(unset.timings.deadlineMs, POLL_DEFAULTS.deadlineMs, "the default deadline");
    eq(unset.timings.intervalMs, POLL_DEFAULTS.intervalMs, "and the default interval");
  }
  const empty = pollTimings("", "   ");
  assert(empty.ok, "an empty or blank value is the same as unset");

  const zeroDeadline = pollTimings("0", "1000");
  assert(zeroDeadline.ok, "a deliberate zero deadline is honoured, not replaced by the default");
  if (zeroDeadline.ok) {
    eq(zeroDeadline.timings.deadlineMs, 0, "and really is zero");
  }

  const set = pollTimings("60000", "5000");
  assert(set.ok, "values that are set take effect as written");
  if (set.ok) eq(set.timings.intervalMs, 5000, "including the interval");

  const refusals: string[] = [];
  for (const [label, r] of [
    ["an unreadable deadline", pollTimings("soon", "1000")],
    ["an unreadable interval", pollTimings("1000", "often")],
    ["a zero interval, which would be a busy loop", pollTimings("1000", "0")],
  ] as const) {
    assert(!r.ok, `${label} is refused`);
    if (!r.ok) {
      refusals.push(r.why);
      assert(/PLATFORM_POLL_/.test(r.why), `${label} names the variable it is about`);
    }
  }
  eq(new Set(refusals).size, refusals.length, "and no two refusals say the same thing (L11)");
}

finish();
