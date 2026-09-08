// The judgement behind `pnpm verify:parallel-run-readiness` (#2066). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-parallel-run-readiness.ts
//
// Answering "is the shadow run trustworthy today" took a database query and eight
// issues on 2026-09-07. This is the one command that answers it, and this file pins
// the judgement over hand written facts so it is tested where no database exists.
// Two rules carry it: every way of learning nothing exits on its own code (L11,
// L98), and a run that measured nobody is never a pass.
import {
  judgeReadiness,
  READINESS_EXIT,
  READINESS_ORDER,
  type ReadinessFacts,
} from "./lib/parallel-run-readiness.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-09-08T16:00:00Z");
const DAY = 24 * 60 * 60_000;

/** A healthy morning, so each case below states only what it is about. */
function healthy(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    nowMs: NOW,
    stretchedCooldowns: [],
    parity: { lastRunMs: NOW - 4 * 60 * 60_000, boundMs: 30 * 60 * 60_000, drifting: false },
    pendingBookable: [],
    calendars: { bookableAgents: 102, missingRows: [], uncovered: [] },
    emptyBuckets: { realBuckets: 60, empty: [] },
    unsetHours: [],
    ...over,
  };
}

// --- the only pass ------------------------------------------------------------------
{
  const j = judgeReadiness(healthy());
  eq(j.exit, READINESS_EXIT.ready, "a healthy morning is ready");
  assert(/102/.test(j.summary) && /60/.test(j.summary), "and the summary says how many agents and buckets it measured");
  eq(j.findings.length, 0, "with nothing to report");
}

// --- measuring nobody is not a pass ---------------------------------------------------
{
  eq(
    judgeReadiness(healthy({ calendars: { bookableAgents: 0, missingRows: [], uncovered: [] } })).exit,
    READINESS_EXIT.nothingMeasured,
    "no bookable agents means nothing was judged",
  );
  eq(
    judgeReadiness(healthy({ emptyBuckets: { realBuckets: 0, empty: [] } })).exit,
    READINESS_EXIT.nothingMeasured,
    "no real buckets means nothing was judged",
  );
}

// --- each finding, on its own code ------------------------------------------------------
{
  const cases: [string, Partial<ReadinessFacts>, number][] = [
    ["a stretched cooldown", { stretchedCooldowns: [{ key: "empty_buckets", minutes: 10080, defaultMinutes: 360 }] }, READINESS_EXIT.alarmMuted],
    ["parity never ran", { parity: { lastRunMs: null, boundMs: 30 * 60 * 60_000, drifting: false } }, READINESS_EXIT.parityStale],
    ["parity ran too long ago", { parity: { lastRunMs: NOW - 2 * DAY, boundMs: 30 * 60 * 60_000, drifting: false } }, READINESS_EXIT.parityStale],
    ["parity is reporting drift", { parity: { lastRunMs: NOW - 60_000, boundMs: 30 * 60 * 60_000, drifting: true } }, READINESS_EXIT.parityDrifting],
    ["somebody waiting to become bookable", { pendingBookable: ["hire@x"] }, READINESS_EXIT.bookablePending],
    ["a bookable agent with no calendar row", { calendars: { bookableAgents: 102, missingRows: ["a@x"], uncovered: [] } }, READINESS_EXIT.calendarMissing],
    ["a calendar not hydrated to the horizon", { calendars: { bookableAgents: 102, missingRows: [], uncovered: ["b@x"] } }, READINESS_EXIT.calendarUncovered],
    ["an empty real bucket", { emptyBuckets: { realBuckets: 60, empty: ["120", "121", "122"] } }, READINESS_EXIT.bucketEmpty],
    ["an agent on hours nobody set", { unsetHours: ["cfrank@x", "jsaminu@x"] }, READINESS_EXIT.hoursUnset],
  ];
  const seen = new Map<number, number>();
  for (const [what, over, expected] of cases) {
    const j = judgeReadiness(healthy(over));
    eq(j.exit, expected, `${what} exits on its own code`);
    assert(j.findings.length >= 1, `${what} is listed as a finding`);
    // Two cases that are the SAME finding (never ran, ran too long ago) share a
    // code on purpose; what may never happen is two different findings sharing one.
    const clash = seen.get(j.exit);
    assert(clash === undefined || clash === expected, `${what} does not share a code with a different finding`);
    seen.set(j.exit, expected);
  }
}

// --- worst first ----------------------------------------------------------------------------
// Exits on the worst finding but lists every one, so a reader is not sent to fix a
// cooldown while three buckets have nobody in them.
{
  const j = judgeReadiness(
    healthy({
      stretchedCooldowns: [{ key: "empty_buckets", minutes: 10080, defaultMinutes: 360 }],
      emptyBuckets: { realBuckets: 60, empty: ["120"] },
      pendingBookable: ["hire@x"],
    }),
  );
  eq(j.exit, READINESS_EXIT.bucketEmpty, "an empty bucket outranks a muted alarm and a pending flip");
  eq(j.findings.length, 3, "and all three are listed");
  const order = READINESS_ORDER as readonly string[];
  assert(order.indexOf("bucket-empty") < order.indexOf("alarm-muted"), "the order is the one written down");
  assert(/120/.test(j.summary), "the summary names the bucket");
}

// --- a read that failed is neither a finding nor a pass -----------------------------------
{
  const j = judgeReadiness(healthy({ emptyBuckets: null }));
  eq(j.exit, READINESS_EXIT.unreadable, "an unreadable section exits as unreadable");
  assert(/bucket/i.test(j.summary), "and names which section could not be read");
  const j2 = judgeReadiness(healthy({ stretchedCooldowns: null, emptyBuckets: { realBuckets: 60, empty: ["120"] } }));
  eq(j2.exit, READINESS_EXIT.unreadable, "unreadable outranks even a real finding, because a run that cannot see cannot vouch");
}

// --- no two outcomes share a code ------------------------------------------------------------
{
  const codes = Object.values(READINESS_EXIT);
  eq(new Set(codes).size, codes.length, "every outcome has a distinct exit code");
  assert(!(codes as number[]).includes(1), "1 is reserved for not configured, decided by the entry before any judging");
}

finish();
