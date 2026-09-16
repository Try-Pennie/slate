// The daily proof that the burst counter answers, and the verdict it stamps (#2392).
//
// THE DEFECT THIS GUARDS. `pnpm verify:burst-counter` (#1564) exists because the
// monitor lane's presence read cannot see a counter that is BOUND and does not
// ANSWER: resolving the namespace as a property read is deliberate, because calling
// the object would create it and hand the cron lane an alarm to clean up on every
// tick forever. AGENTS.md then said, in words, to re-run the command after any
// change to the burst path or the `BURST_LIMITER` binding. Nothing enforced it, and
// between the command shipping and this change the path moved five times with no run
// recorded. A rule that lives only in a prompt is a hope (L27), and a check that has
// never once concluded is measuring nothing (L557).
//
// So the command runs on a schedule and stamps `verdict:burst-counter`, which puts
// it in the family that pages when a detector stops concluding (#1394). Three things
// have to hold for that to be worth anything, and they are what this file drives:
//
//  1. ONLY A MEASURED VERDICT STAMPS. The command ends on its own exit code per
//     outcome, and most of those codes mean it never got to ask the question. A
//     stamp on one of those would report the detector concluding while it is blind,
//     which is the exact substitution the family exists to stop (L98, L331).
//  2. THE BOUND IS DERIVED FROM THE SCHEDULE, read out of the workflow file rather
//     than typed beside it (L614), so editing the cron or the job's timeout without
//     revisiting the bound fails the build.
//  3. THE RUN SPEAKS when it found something, and says nothing on the good day.
//
// No network, no clock, no real workflow dispatch: the workflow file is read as text
// and every decision is driven through hand written summaries.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-burst-counter-schedule.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VERDICT_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { BURST_COUNTER_VERDICT_LANE } from "../src/lib/monitor/verdict-freshness.ts";
import { verdictBlindAlertText } from "../src/lib/monitor/lane-copy.ts";
import { parseWorkflowSchedules, cronCadenceMs } from "./lib/scan-workflow-schedules.ts";
import {
  VERIFY_EXIT,
  RUN_JUDGEMENT,
  decideBurstCounterReport,
  writeBurstSummary,
  CONCLUDING_EXITS,
} from "./lib/burst-counter-run-outcome.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = "burst-counter.yml";
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", WORKFLOW);

/** Printable ASCII only: catches an em dash, an en dash and an emoji in one read,
 *  and this file holds no literal one of any of them to be caught by the style hook. */
const PLAIN = /^[\x20-\x7E\n]*$/;

// --- the workflow exists and this file can really read it ----------------------
// Every derivation below rests on the parse, and a parser that read NOTHING hands
// back the same empty answer a workflow with no schedule would (L98). So prove it
// reads the real file, and prove it would notice if the schedule went away.
assert(existsSync(WORKFLOW_PATH), `${WORKFLOW} exists`);
const yml = readFileSync(WORKFLOW_PATH, "utf8");

const crons = parseWorkflowSchedules(yml);
eq(crons.length, 1, "the burst counter workflow declares exactly one cron line");
{
  const withoutSchedule = yml.replace(/^ *- cron: .*$/gm, "");
  eq(
    parseWorkflowSchedules(withoutSchedule).length,
    0,
    "control: the same parse over a copy with the cron removed finds nothing, so a zero above would have meant something",
  );
  eq(cronCadenceMs("not a cron"), null, "control: an unreadable expression is refused, never guessed at");
}

const cadenceMs = cronCadenceMs(crons[0] as string);
assert(cadenceMs !== null, "the burst counter cron is one a cadence can be read from");
const timeoutMin = Number(yml.match(/^ {4}timeout-minutes:\s*(\d+)/m)?.[1] ?? NaN);
assert(Number.isFinite(timeoutMin), "the job declares an explicit timeout (L313), and the derivation can use it");

// --- the bound is DERIVED from that schedule (L614) ----------------------------
{
  const bound = VERDICT_STALE_BOUNDS_MS[BURST_COUNTER_VERDICT_LANE];
  assert(typeof bound === "number", "the lane is watched by a staleness bound at all");

  // GitHub's scheduler DROPS runs under load, and on a daily cadence a dropped run
  // costs the whole day. There is no gap filler on this lane (the parity sweep's
  // #2414 table is where a fourth one would go), so the bound has to survive one
  // dropped run or it pages for a cause nobody can fix, which is how a channel stops
  // being read (L36).
  const droppedRunMs = 2 * (cadenceMs as number);
  // It runs LATE as well as dropping runs, measured at 2 to 3 hours in this repo
  // (the canary-trigger header).
  const OBSERVED_GITHUB_LATENESS_MS = 3 * 60 * 60_000;
  // The stamp lands at the END of the run, so the job's own timeout is part of the
  // worst case gap between two stamps.
  const earliestHonest = droppedRunMs + OBSERVED_GITHUB_LATENESS_MS + timeoutMin * 60_000;

  assert(
    (bound as number) >= earliestHonest,
    `the bound clears two cadences plus GitHub's measured lateness plus the job's own timeout ` +
      `(bound ${bound}ms, earliest honest ${earliestHonest}ms)`,
  );
  // And it stays DERIVED rather than merely large: a bound with days of slack in it
  // would take a week to notice a lane that had stopped, which is the state this
  // whole change exists to end.
  assert(
    (bound as number) <= earliestHonest + 2 * 60 * 60_000,
    `the bound is the derivation plus a rounding hour, not an arbitrary large number ` +
      `(bound ${bound}ms, derivation ${earliestHonest}ms)`,
  );
}

// --- which endings COUNT as a measured verdict --------------------------------
// The whole point. Driven over every code the command can end on, enumerated from
// VERIFY_EXIT itself rather than from a list written here, so a thirteenth ending
// added to the command fails this rather than quietly inheriting somebody's guess
// (L96).
{
  const codes = Object.values(VERIFY_EXIT);
  for (const code of codes) {
    assert(
      RUN_JUDGEMENT[code] !== undefined,
      `exit ${code} has a deliberate judgement rather than falling to a default`,
    );
  }
  for (const key of Object.keys(RUN_JUDGEMENT)) {
    assert(
      codes.includes(Number(key) as (typeof codes)[number]),
      `the judgement table names exit ${key}, which the command can really end on`,
    );
  }

  // The three that CONCLUDED, each said separately rather than as a set comparison,
  // because the reason each one counts is different.
  assert(
    RUN_JUDGEMENT[VERIFY_EXIT.passed].concluded,
    "a run where the count rose measured the counter answering and counting",
  );
  assert(
    RUN_JUDGEMENT[VERIFY_EXIT.didNotRise].concluded,
    "a run where two readings in one window did not rise measured the counter NOT counting, which is a verdict and not a blind run",
  );
  assert(
    RUN_JUDGEMENT[VERIFY_EXIT.objectUnreachable].concluded,
    "a run where the bound object did not answer measured the state the monitor lane cannot see, so it concluded",
  );
  eq(
    [...CONCLUDING_EXITS].sort((a, b) => a - b).join(","),
    [VERIFY_EXIT.passed, VERIFY_EXIT.objectUnreachable, VERIFY_EXIT.didNotRise]
      .sort((a, b) => a - b)
      .join(","),
    "and nothing else concludes",
  );

  // The refusals, several of them and each for its own reason, because the point of
  // the exit table is that they are not one thing (L11).
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.bindingMissing].concluded,
    "a deployment with no BURST_LIMITER bound never exercised the answering half, so it stamps nothing however definite it feels",
  );
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.unauthorized].concluded,
    "a refused key measured nothing about the counter",
  );
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.noAnswer].concluded,
    "a request that never got a reply measured nothing about the counter",
  );
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.endpointMissing].concluded,
    "a deployment that predates the endpoint measured nothing about the counter",
  );
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.contextUnreadable].concluded,
    "a Worker that could not read its own context never looked for the counter",
  );
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.noCount].concluded,
    "an object that answered without a count left the counting half unmeasured",
  );
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.notConfigured].concluded,
    "a disabled endpoint measured nothing about the counter",
  );
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.unreadableReply].concluded,
    "an answer from something other than the endpoint measured nothing about the counter",
  );
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.misconfigured].concluded,
    "a run that never attempted anything measured nothing about the counter",
  );
  assert(
    !RUN_JUDGEMENT[VERIFY_EXIT.windowRolled].concluded,
    "two readings from two windows are two counts, so nothing was measured",
  );
}

// --- what it SAYS -------------------------------------------------------------
const RUN_URL = "https://github.com/Try-Pennie/slate/actions/runs/1234";

{
  const good = decideBurstCounterReport(
    { exit: VERIFY_EXIT.passed, detail: "Two reports inside one window read 1 and then 2." },
    RUN_URL,
  );
  assert(good.concluded, "the good day concludes");
  eq(good.alert, null, "and says nothing, because a daily all is well is how the ones that matter stop being read");

  const rolled = decideBurstCounterReport(
    { exit: VERIFY_EXIT.windowRolled, detail: "The two readings fell in different one minute windows." },
    RUN_URL,
  );
  assert(!rolled.concluded, "a rolled window concludes nothing");
  eq(
    rolled.alert,
    null,
    "and says nothing either: nothing is wrong, and if it became the permanent state the stamp lapses and the blind detector page fires with the right words",
  );

  // The two findings that mean the ceiling is failing open right now.
  for (const exit of [VERIFY_EXIT.objectUnreachable, VERIFY_EXIT.didNotRise]) {
    const decision = decideBurstCounterReport(
      { exit, detail: "the command's own sentence about what it measured" },
      RUN_URL,
    );
    assert(decision.concluded, `exit ${exit} concludes`);
    assert(decision.alert !== null, `exit ${exit} is spoken about, since a fresh stamp would otherwise be the only trace`);
    assert(
      (decision.alert as string).includes("the command's own sentence about what it measured"),
      `exit ${exit} carries the command's OWN sentence rather than a second copy of the wording (L41)`,
    );
    assert((decision.alert as string).includes(RUN_URL), `exit ${exit} says where to look`);
  }

  // A run that died before deciding. An ABSENT summary is evidence, not an inference
  // from an exit code: node exits 1 on an uncaught throw and 1 is also a real
  // outcome of this command, so the two would be one message (L11, L98).
  const died = decideBurstCounterReport(null, RUN_URL);
  assert(!died.concluded, "a run that never wrote a verdict concluded nothing");
  assert(died.alert !== null, "and is spoken about, rather than being left to the staleness bound alone");

  // An ending this table has never heard of, which is what a thirteenth exit code
  // added to the command without being judged here would produce. It must arrive as
  // something somebody reads rather than as a silent pass, and it must never count as
  // a verdict (L98).
  const unknown = decideBurstCounterReport({ exit: 99, detail: "something new" }, RUN_URL);
  assert(!unknown.concluded, "an exit code nothing here judges is not a verdict");
  assert(unknown.alert !== null, "and is reported rather than dropped");
  assert(
    (unknown.alert as string).includes("99"),
    "naming the code, so whoever added it knows where it was not judged",
  );

  // An empty RUN_URL is an unset workflow setting, not a link to nowhere.
  const noUrl = decideBurstCounterReport(null, "");
  assert(
    (noUrl.alert as string).includes("Actions tab"),
    "with no run URL the message still says where to look",
  );

  // Every message is readable, distinct, and names something to do.
  const spoken = Object.values(VERIFY_EXIT)
    .map((exit) => decideBurstCounterReport({ exit, detail: `detail for ${exit}` }, RUN_URL).alert)
    .filter((t): t is string => t !== null);
  assert(spoken.length >= 10, `every failing ending is spoken about (got ${spoken.length})`);
  for (const text of spoken) {
    assert(PLAIN.test(text), "message is plain ASCII: no em dash, no en dash, no emoji");
    assert(
      !/undefined|NaN|\[object Object\]/.test(text),
      "message renders no placeholder leak",
    );
    assert(!text.startsWith("Slate"), "message does not open with Slate, which Slack already shows");
  }
  const headlines = spoken.map((t) => t.split("\n")[0] as string);
  eq(
    new Set(headlines).size,
    headlines.length,
    "each ending gets its own opening sentence, so one cause never answers for another (L11)",
  );
}

// --- writing the verdict where the lane can read it ----------------------------
{
  const noPath = writeBurstSummary("", { exit: VERIFY_EXIT.passed, detail: "x" });
  assert(!noPath.written, "a hand run sets no path and writes nothing");
  assert(noPath.why.trim().length > 0, "and says why, rather than failing silently");

  const bad = writeBurstSummary(join(ROOT, "no", "such", "directory", "burst.json"), {
    exit: VERIFY_EXIT.passed,
    detail: "x",
  });
  assert(!bad.written, "a write that cannot land is reported rather than thrown");
  assert(
    bad.why.trim().length > 0,
    "and carries the reason: with no file the lane reports a run that did not complete, which is louder than the truth rather than quieter",
  );
}

// --- built is not wired (L3) ---------------------------------------------------
// Everything above holds just as well if the workflow never ran the command, or
// stamped the heartbeat whatever happened. Both are read off the file.
{
  assert(
    /verify-burst-counter-live\.ts/.test(yml),
    "the workflow really runs the verification command",
  );
  assert(
    /continue-on-error: true/.test(yml),
    "the verification step does not fail the job, or the reporting step below it would be skipped and the finding would sit in the Actions tab",
  );
  assert(
    /notify-burst-counter\.ts/.test(yml),
    "the workflow really runs the reporter that decides both questions",
  );
  const stampLine = /lane=verdict:burst-counter(?![\w:-])/;
  assert(stampLine.test(yml), "the workflow really stamps the verdict lane");
  assert(
    !stampLine.test(yml.replace(/lane=verdict:burst-counter/g, "lane=somewhere-else")),
    "control: the same read over a copy with the stamp renamed finds nothing, so the assertion above measured something",
  );
  // The stamp is GATED on the reporter's answer, never on the workflow having run.
  // Sliced from the step's own name to the curl rather than by a fixed number of
  // characters, which would stop containing the condition the first time somebody
  // added a comment (L518).
  const stampStepStart = yml.indexOf("- name: Stamp the verdict");
  assert(stampStepStart !== -1, "the stamp step is where this expects to find it");
  const stampStep = yml.slice(stampStepStart, yml.search(stampLine));
  assert(
    /steps\.report\.outputs\.concluded == '1'/.test(stampStep),
    "the stamp is conditional on the run having reached a measured verdict, not on the workflow having run at all",
  );
  assert(
    /if: always\(\)/.test(stampStep),
    "and carries always(), or GitHub ANDs an implicit success() in and a failed Slack post would " +
      "leave a measured verdict unstamped: two checks sharing one status field (L53)",
  );
}

// --- the page a reader actually gets ------------------------------------------
{
  const never = verdictBlindAlertText({
    lane: BURST_COUNTER_VERDICT_LANE,
    ageMs: Infinity,
    maxStaleMs: VERDICT_STALE_BOUNDS_MS[BURST_COUNTER_VERDICT_LANE] as number,
    unreadable: false,
  });
  assert(/never/i.test(never), "the never concluded page says so plainly, which is the state #2392 describes");
  assert(PLAIN.test(never), "the page is plain ASCII");
  assert(
    !never.includes(BURST_COUNTER_VERDICT_LANE),
    "the page names the detector in words, not by its internal lane key",
  );
  assert(
    /burst/i.test(never) && /ceiling/i.test(never),
    "it says which detector went blind and what it was protecting",
  );
  assert(
    /Actions tab|workflow/i.test(never),
    "and names where the answer would have come from, which is an action the reader can actually take (L111)",
  );
}

finish();
