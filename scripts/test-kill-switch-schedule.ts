// The nightly proof that public booking can still be stopped, and the verdict it
// stamps (#2493). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-kill-switch-schedule.ts
//
// THE DEFECT THIS GUARDS. `pnpm verify:kill-switch` (#2365) is the only thing that can
// see the fault that matters most about the #2297 kill switch: the gate fails CLOSED, so
// a booker that cannot read its own flag refuses EVERY lead, and nothing else would say
// so until the booking failure rate window fired after real people had been turned away.
// The command had run exactly once, in the session that wrote it, which is the state the
// burst counter proof was in when #2392 found its path had moved five times with nobody
// re-running it. A rule that lives only in a prompt is a hope (L27), and a check that has
// never once concluded is measuring nothing (L557).
//
// So the command runs on a schedule and stamps `verdict:kill-switch`, which puts it in
// the family that pages when a detector stops concluding (#1394). FOUR things have to
// hold for that to be worth anything, and they are what this file drives:
//
//  1. ONLY A MEASURED VERDICT STAMPS. The command ends on its own exit code per outcome,
//     and most of those mean it never got to ask the question. A stamp on one of those
//     would report the detector concluding while it is blind (L98, L331).
//  2. THE BOUND IS DERIVED FROM THE SCHEDULE, read out of the workflow file rather than
//     typed beside it (L614).
//  3. THE SCHEDULE IS OUTSIDE THE HOURS THE ORG ADVERTISES, which is the one way this
//     differs from its sibling and the whole reason #2493 was a decision rather than a
//     copy: running the command STOPS public booking for about two seconds.
//  4. THE RUN SPEAKS when it found something, and says nothing on the good day.
//
// No network, no clock, no real workflow dispatch: the workflow file is read as text and
// every decision is driven through hand written summaries.
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VERDICT_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { KILL_SWITCH_VERDICT_LANE } from "../src/lib/monitor/verdict-freshness.ts";
import { verdictBlindAlertText } from "../src/lib/monitor/lane-copy.ts";
import { SEEDED_BUSINESS_HOURS, BUSINESS_ZONE } from "../src/lib/booking/business-hours.ts";
import { parseWorkflowSchedules, cronCadenceMs } from "./lib/scan-workflow-schedules.ts";
import { KILL_SWITCH_EXIT } from "./lib/kill-switch-live-control.ts";
import { judgeDrillClock } from "./lib/kill-switch-clock.ts";
import {
  RUN_JUDGEMENT,
  decideKillSwitchReport,
  writeKillSwitchSummary,
  CONCLUDING_EXITS,
  SKIPPED_EXITS,
} from "./lib/kill-switch-run-outcome.ts";
import { run as runNotifier } from "./notify-kill-switch.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

/**
 * How late GitHub has started this repo's scheduled workflows, in minutes after the
 * declared time (#3920). Measured 2026-10-19 over the last 32 scheduled runs of this
 * workflow (07:10 UTC cron): 262 to 570, median 383. Every other daily cron here showed
 * the same shape whatever its hour (the shortest anywhere was 173, on the 11:23
 * dependency audit), so the delay is a property of GitHub's queue rather than of the
 * hour. The workflow comment records the same figures beside the cron they chose.
 */
const MEASURED_GITHUB_DELAY_MIN = { min: 262, max: 570 } as const;
const WORKFLOW = "kill-switch.yml";
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", WORKFLOW);

/** Printable ASCII only: catches an em dash, an en dash and an emoji in one read,
 *  and this file holds no literal one of any of them to be caught by the style hook. */
const PLAIN = /^[\x20-\x7E\n]*$/;

// --- the workflow exists and this file can really read it ----------------------
// Every derivation below rests on the parse, and a parser that read NOTHING hands back
// the same empty answer a workflow with no schedule would (L98).
assert(existsSync(WORKFLOW_PATH), `${WORKFLOW} exists`);
const yml = readFileSync(WORKFLOW_PATH, "utf8");

const crons = parseWorkflowSchedules(yml);
eq(crons.length, 1, "the kill switch workflow declares exactly one cron line");
{
  const withoutSchedule = yml.replace(/^ *- cron: .*$/gm, "");
  eq(
    parseWorkflowSchedules(withoutSchedule).length,
    0,
    "control: the same parse over a copy with the cron removed finds nothing, so a zero above would have meant something",
  );
}

const cron = crons[0] as string;
const cadenceMs = cronCadenceMs(cron);
assert(cadenceMs !== null, "the kill switch cron is one a cadence can be read from");
const timeoutMin = Number(yml.match(/^ {4}timeout-minutes:\s*(\d+)/m)?.[1] ?? NaN);
assert(Number.isFinite(timeoutMin), "the job declares an explicit timeout (L313), and the derivation can use it");

// --- it runs while the org is SHUT, which is the decision #2493 is about --------
//
// Running the command writes `public_booking_paused` true, probes, and writes it back:
// public booking is stopped for about two seconds. The burst counter's answer (a daily
// run in the morning) would put that inside the advertised day, so this one has to sit
// outside it, in BOTH offsets the Eastern clock takes, and a change to the cron that
// walked it into business hours has to fail rather than be noticed later.
//
// The DECLARED time is not the whole question (#3920, L386). GitHub started the 07:10 UTC
// cron between 262 and 570 minutes late on every one of its last 32 runs, so every morning
// the drill landed inside business hours. So this asks two things: that the declared time
// is outside the hours, and that the declared time plus every delay up to the worst one
// measured is too, judged by the SAME clock check the command makes before it pauses
// anything (`judgeDrillClock`), margin included, on every day of a year. A second copy
// of "when is it safe" written here would drift from the one that decides (L107).
//
// The advertised week comes from the SEEDED business hours, never from a window
// restated here: two copies of "when is Pennie open" drift and this one would drift
// silently (L41).
//
// WHAT THIS CANNOT SEE, so a green run is never read as more than it measured (L400).
// The seeded week is what the migration writes and what an unconfigured table falls
// back to; the LIVE week lives in `business_hours` and an admin may edit it. A repo
// scan cannot read a database, which is exactly why the command now reads the live week
// itself and stands down inside it: this sweep says where the cron SHOULD land, and the
// command's own check is what stops it pausing booking when it does not.
{
  const [minuteField, hourField] = cron.split(/\s+/);
  const utcHour = Number(hourField);
  const utcMinute = Number(minuteField);
  assert(
    Number.isInteger(utcHour) && Number.isInteger(utcMinute),
    `the cron names one fixed time of day rather than a range (${cron})`,
  );

  // Eastern is UTC-5 in winter and UTC-4 in summer. Both, because a schedule that is
  // safe in one offset and not the other is a fault that arrives with a clock change
  // and nobody would connect it to this file.
  for (const offsetHours of [-5, -4]) {
    const localHour = (utcHour + offsetHours + 24) % 24;
    const localMinute = localHour * 60 + utcMinute;
    // Every entry in the seeded week IS an open day: closed days are absent rather
    // than flagged, which is why there is nothing to filter here.
    for (const day of SEEDED_BUSINESS_HOURS) {
      assert(
        localMinute < day.start_minute || localMinute >= day.end_minute,
        `at UTC${offsetHours} the run lands at ${localHour}:${String(utcMinute).padStart(2, "0")} ` +
          `local, outside weekday ${day.weekday}'s advertised ${day.start_minute} to ${day.end_minute}`,
      );
    }
  }

  // Control: the same comparison over a time INSIDE the advertised day must fail, or
  // the loop above would pass just as happily on a midday cron (L1).
  const noon = 12 * 60;
  const openDay = SEEDED_BUSINESS_HOURS[0];
  assert(openDay !== undefined, "the seeded week has at least one open day to compare against");
  assert(
    !(noon < openDay.start_minute || noon >= openDay.end_minute),
    "control: midday IS inside the advertised day, so the assertions above measured something",
  );

  // The sweep. Every day of a year from a fixed start, so both clock changes are crossed,
  // and every delay from on time to the worst measured, in ten minute steps (the margin is
  // thirty, so no window can sit between two samples). The control stops at its first
  // landing: it only has to show the sweep can find one.
  const seededReading = {
    ok: true as const,
    hours: { zone: BUSINESS_ZONE, rules: SEEDED_BUSINESS_HOURS, exceptions: [] },
  };
  const landingsInsideHours = (hour: number, minute: number, stopAtFirst = false): string[] => {
    const found: string[] = [];
    for (let day = 0; day < 366; day++) {
      const declared = Date.UTC(2026, 9, 19 + day, hour, minute);
      for (let delay = 0; delay <= MEASURED_GITHUB_DELAY_MIN.max; delay += 10) {
        const decision = judgeDrillClock(seededReading, declared + delay * 60_000);
        if (decision.kind !== "clear") found.push(`${new Date(declared).toISOString().slice(0, 10)} +${delay}m`);
        if (stopAtFirst && found.length > 0) return found;
      }
    }
    return found;
  };
  const inside = landingsInsideHours(utcHour, utcMinute);
  eq(
    inside.length,
    0,
    `the declared time plus every delay up to the worst measured (${MEASURED_GITHUB_DELAY_MIN.max} minutes) ` +
      `lands outside the org's hours and their margin on every day of a year: ${inside.slice(0, 5).join(", ")}`,
  );
  // Control: the OLD cron, 07:10 UTC, is exactly the schedule #3920 caught pausing
  // booking at 10:35 AM, so the same sweep over it must find landings inside the hours,
  // or the zero above would have meant nothing (L1).
  assert(
    landingsInsideHours(7, 10, true).length > 0,
    "control: the same sweep over the old 07:10 UTC cron finds landings inside the hours",
  );
}

// --- the bound is DERIVED from that schedule (L614) ----------------------------
{
  const bound = VERDICT_STALE_BOUNDS_MS[KILL_SWITCH_VERDICT_LANE];
  assert(typeof bound === "number", "the lane is watched by a staleness bound at all");

  // GitHub's scheduler DROPS runs under load, and on a daily cadence a dropped run
  // costs the whole day. There is no gap filler on this lane, so the bound has to
  // survive one dropped run or it pages for a cause nobody can fix (L36).
  const droppedRunMs = 2 * (cadenceMs as number);
  // It runs LATE as well as dropping runs. This read 2 to 3 hours when #2493 wrote it;
  // measured again for #3920 it is up to 9.5 hours on this very workflow, so the run
  // after a dropped one being merely that late must not be a second page.
  const OBSERVED_GITHUB_LATENESS_MS = MEASURED_GITHUB_DELAY_MIN.max * 60_000;
  // The stamp lands at the END of the run, so the job's own timeout is part of the
  // worst case gap between two stamps.
  const earliestHonest = droppedRunMs + OBSERVED_GITHUB_LATENESS_MS + timeoutMin * 60_000;

  assert(
    (bound as number) >= earliestHonest,
    `the bound clears two cadences plus GitHub's measured lateness plus the job's own timeout ` +
      `(bound ${bound}ms, earliest honest ${earliestHonest}ms)`,
  );
  assert(
    (bound as number) <= earliestHonest + 2 * 60 * 60_000,
    `the bound is the derivation plus a rounding hour, not an arbitrary large number ` +
      `(bound ${bound}ms, derivation ${earliestHonest}ms)`,
  );
  // A night the clock check SKIPS stamps nothing (#3920), so a run of skips has to reach
  // the bound like any other run of nights that measured nothing. Three skipped nights in
  // a row must page, or a schedule that drifted back into business hours would read as a
  // detector that is fine (L98).
  assert(
    (bound as number) < 3 * (cadenceMs as number),
    `a run of three skipped nights is past the bound and pages (bound ${bound}ms)`,
  );
}

// --- which endings COUNT as a measured verdict --------------------------------
// Driven over every code the command can end on, enumerated from KILL_SWITCH_EXIT
// itself rather than from a list written here, so a seventeenth ending added to the
// command fails this rather than quietly inheriting somebody's guess (L96).
{
  const codes = Object.values(KILL_SWITCH_EXIT);
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

  // The five that CONCLUDED, each said separately rather than as a set comparison,
  // because the reason each one counts is different.
  assert(
    RUN_JUDGEMENT[KILL_SWITCH_EXIT.ok].concluded,
    "a run that saw the booker take the request while open and refuse it while paused measured the switch in both directions",
  );
  assert(
    RUN_JUDGEMENT[KILL_SWITCH_EXIT.doesNotRefuse].concluded,
    "a switch that was ON and did not stop the booking is a definite reading of the thing under test",
  );
  assert(
    RUN_JUDGEMENT[KILL_SWITCH_EXIT.refusesWhileOpen].concluded,
    "a booker refusing while the flag was OFF is the fail closed fault, measured",
  );
  assert(
    RUN_JUDGEMENT[KILL_SWITCH_EXIT.refusedUnreadable].concluded,
    "a refusal carrying the cannot-read copy is measured too, and is the worst version of the same fault",
  );
  assert(
    RUN_JUDGEMENT[KILL_SWITCH_EXIT.availabilityClosed].concluded,
    "the switch was proven in both directions and also closed availability, which is a verdict about the switch plus a second finding",
  );
  assert(
    RUN_JUDGEMENT[KILL_SWITCH_EXIT.availabilityUnmeasured].concluded,
    "and so is the case where the switch was proven and only the availability half went unread: the detector's question is about the SWITCH",
  );
  eq(
    [...CONCLUDING_EXITS].sort((a, b) => a - b).join(","),
    [
      KILL_SWITCH_EXIT.ok,
      KILL_SWITCH_EXIT.doesNotRefuse,
      KILL_SWITCH_EXIT.refusesWhileOpen,
      KILL_SWITCH_EXIT.refusedUnreadable,
      KILL_SWITCH_EXIT.availabilityClosed,
      KILL_SWITCH_EXIT.availabilityUnmeasured,
    ]
      .sort((a, b) => a - b)
      .join(","),
    "and nothing else concludes",
  );

  // The refusals, each for its own reason, because the point of the exit table is that
  // they are not one thing (L11).
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.notRestored].concluded,
    "a run that stranded the flag is judged before anything else it found, so the gate's own behaviour may never have been reached: it stamps nothing however loud it is",
  );
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.alreadyPaused].concluded,
    "a run that stood down because somebody had already stopped bookings tested nothing at all",
  );
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.flagNotSet].concluded,
    "a run that could not write the flag never exercised the paused half",
  );
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.noAnswer].concluded,
    "a request that never got a reply measured nothing about the switch",
  );
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.rateLimited].concluded,
    "a limiter answering before the gate means the gate was never reached",
  );
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.serverError].concluded,
    "a booking route that threw while the switch was off measured nothing about the switch",
  );
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.endpointMissing].concluded,
    "a deployment with no public booking route has no gate to ask about",
  );
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.unreadableReply].concluded,
    "an answer from something other than the booking route measured nothing about the switch",
  );

  // The two clock stand downs (#3920). Neither paused anything, so neither measured the
  // switch, and a stamp on either would read a night the drill never ran as a healthy
  // detector (L98).
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.insideBusinessHours].concluded,
    "a run that skipped because it started inside business hours measured nothing, so it does not stamp",
  );
  assert(
    !RUN_JUDGEMENT[KILL_SWITCH_EXIT.hoursUnreadable].concluded,
    "a run that could not read the org's hours paused nothing and measured nothing, so it does not stamp",
  );
  eq(
    [...SKIPPED_EXITS].join(","),
    String(KILL_SWITCH_EXIT.insideBusinessHours),
    "only the inside-hours stand down is a SKIP; unreadable hours are a read that failed, said as one (L11)",
  );
}

// --- a skip is reported in its own words, and never stamped -----------------------
// Driven end to end through the reporter the workflow runs, from a summary file on disk,
// because the stamp step reads the reporter's `concluded` and nothing else.
{
  const dir = mkdtempSync(join(tmpdir(), "kill-switch-skip-"));
  const file = join(dir, "summary.json");
  const posted: string[] = [];
  const post = async (msg: { text: string }) => {
    posted.push(msg.text);
    return { ok: true };
  };
  const env = (exit: number) => {
    writeFileSync(file, JSON.stringify({ exit, detail: `the command's own sentence for exit ${exit}` }));
    return {
      KILL_SWITCH_SUMMARY_FILE: file,
      RUN_URL: "https://github.com/Try-Pennie/slate/actions/runs/1234",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_ALERTS_CHANNEL: "C0TEST",
    };
  };

  const skipped = await runNotifier(post, env(KILL_SWITCH_EXIT.insideBusinessHours));
  eq(skipped.concluded, false, "a skipped night leaves the verdict unstamped, so the freshness watch counts it as a night with no verdict");
  eq(skipped.skipped, true, "and the reporter knows it was a skip");
  eq(posted.length, 1, "a skip is said out loud, because silence on this lane means a pass");
  const skipText = posted[0] as string;
  assert(/skipped|did not run/i.test(skipText.split("\n")[0] as string), `the skip's opening sentence says it did not run: ${skipText}`);
  assert(!/fail/i.test(skipText.split("\n")[0] as string), "and does not call itself a failure");
  assert(skipText.includes(`the command's own sentence for exit ${KILL_SWITCH_EXIT.insideBusinessHours}`), "and carries the command's own sentence about when it was judged");

  posted.length = 0;
  const unreadable = await runNotifier(post, env(KILL_SWITCH_EXIT.hoursUnreadable));
  eq(unreadable.concluded, false, "unreadable hours leave the verdict unstamped too");
  eq(unreadable.skipped, false, "and are not reported as a skip");
  assert(/could not/i.test((posted[0] ?? "").split("\n")[0] as string), "they say the check could not be made");

  posted.length = 0;
  const passed = await runNotifier(post, env(KILL_SWITCH_EXIT.ok));
  eq(passed.concluded, true, "control: a pass through the same reporter DOES conclude, so the two falses above measured something");
  eq(passed.skipped, false, "and is not a skip");
  eq(posted.length, 0, "and says nothing");

  rmSync(dir, { recursive: true, force: true });
}

// --- what it SAYS -------------------------------------------------------------
const RUN_URL = "https://github.com/Try-Pennie/slate/actions/runs/1234";

{
  const good = decideKillSwitchReport(
    { exit: KILL_SWITCH_EXIT.ok, detail: "The kill switch works in both directions." },
    RUN_URL,
  );
  assert(good.concluded, "the good day concludes");
  eq(good.alert, null, "and says nothing, because a nightly all is well is how the ones that matter stop being read");

  // The findings that mean the gate is not doing its job right now.
  for (const exit of [
    KILL_SWITCH_EXIT.doesNotRefuse,
    KILL_SWITCH_EXIT.refusesWhileOpen,
    KILL_SWITCH_EXIT.refusedUnreadable,
    KILL_SWITCH_EXIT.notRestored,
  ]) {
    const decision = decideKillSwitchReport(
      { exit, detail: "the command's own sentence about what it measured" },
      RUN_URL,
    );
    assert(decision.alert !== null, `exit ${exit} is spoken about`);
    assert(
      (decision.alert as string).includes("the command's own sentence about what it measured"),
      `exit ${exit} carries the command's OWN sentence rather than a second copy of the wording (L41)`,
    );
    assert((decision.alert as string).includes(RUN_URL), `exit ${exit} says where to look`);
  }

  // A stranded flag is the one ending that goes on turning real leads away after the
  // command exits, so it has to LEAD with that and not bury it behind a verdict.
  const stranded = decideKillSwitchReport(
    { exit: KILL_SWITCH_EXIT.notRestored, detail: "PUBLIC BOOKING IS STILL PAUSED." },
    RUN_URL,
  );
  const firstLine = (stranded.alert as string).split("\n")[0] as string;
  assert(
    /could not turn it back on|refusing every new booking/i.test(firstLine),
    `the stranded flag's OPENING sentence says bookings are stopped right now: ${firstLine}`,
  );

  // A run that died before deciding. An ABSENT summary is evidence, not an inference
  // from an exit code (L11, L98).
  const died = decideKillSwitchReport(null, RUN_URL);
  assert(!died.concluded, "a run that never wrote a verdict concluded nothing");
  assert(died.alert !== null, "and is spoken about, rather than being left to the staleness bound alone");

  // An ending this table has never heard of.
  const unknown = decideKillSwitchReport({ exit: 99, detail: "something new" }, RUN_URL);
  assert(!unknown.concluded, "an exit code nothing here judges is not a verdict");
  assert(unknown.alert !== null, "and is reported rather than dropped");
  assert((unknown.alert as string).includes("99"), "naming the code, so whoever added it knows where it was not judged");

  // An empty RUN_URL is an unset workflow setting, not a link to nowhere.
  const noUrl = decideKillSwitchReport(null, "");
  assert((noUrl.alert as string).includes("Actions tab"), "with no run URL the message still says where to look");

  // Every message is readable, distinct, and names something to do.
  const spoken = Object.values(KILL_SWITCH_EXIT)
    .map((exit) => decideKillSwitchReport({ exit, detail: `detail for ${exit}` }, RUN_URL).alert)
    .filter((t): t is string => t !== null);
  assert(spoken.length >= 12, `every failing ending is spoken about (got ${spoken.length})`);
  for (const text of spoken) {
    assert(PLAIN.test(text), "message is plain ASCII: no em dash, no en dash, no emoji");
    assert(!/undefined|NaN|\[object Object\]/.test(text), "message renders no placeholder leak");
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
  const noPath = writeKillSwitchSummary("", { exit: KILL_SWITCH_EXIT.ok, detail: "x" });
  assert(!noPath.written, "a hand run sets no path and writes nothing");
  assert(noPath.why.trim().length > 0, "and says why, rather than failing silently");

  const bad = writeKillSwitchSummary(join(ROOT, "no", "such", "directory", "kill.json"), {
    exit: KILL_SWITCH_EXIT.ok,
    detail: "x",
  });
  assert(!bad.written, "a write that cannot land is reported rather than thrown");
  assert(
    bad.why.trim().length > 0,
    "and carries the reason: with no file the lane reports a run that did not complete, which is louder than the truth rather than quieter",
  );
}

// --- built is not wired (L3) ---------------------------------------------------
// Everything above holds just as well if the workflow never ran the command, or stamped
// the heartbeat whatever happened. Both are read off the file.
{
  assert(/verify-kill-switch-live\.ts/.test(yml), "the workflow really runs the verification command");
  assert(
    /continue-on-error: true/.test(yml),
    "the verification step does not fail the job, or the reporting step below it would be skipped and the finding would sit in the Actions tab",
  );
  assert(/notify-kill-switch\.ts/.test(yml), "the workflow really runs the reporter that decides both questions");
  assert(
    /KILL_SWITCH_SUMMARY_FILE/.test(yml),
    "and the command is told where to record its verdict, or the reporter has nothing to read and every run reads as one that died",
  );
  const stampLine = /lane=verdict:kill-switch(?![\w:-])/;
  assert(stampLine.test(yml), "the workflow really stamps the verdict lane");
  assert(
    !stampLine.test(yml.replace(/lane=verdict:kill-switch/g, "lane=somewhere-else")),
    "control: the same read over a copy with the stamp renamed finds nothing, so the assertion above measured something",
  );
  // The stamp is GATED on the reporter's answer, never on the workflow having run.
  // Sliced from the step's own name to the curl rather than by a fixed number of
  // characters, which would stop containing the condition the first time somebody added
  // a comment (L518).
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
    lane: KILL_SWITCH_VERDICT_LANE,
    ageMs: Infinity,
    maxStaleMs: VERDICT_STALE_BOUNDS_MS[KILL_SWITCH_VERDICT_LANE] as number,
    unreadable: false,
  });
  assert(/never/i.test(never), "the never concluded page says so plainly, which is the state #2493 describes");
  assert(PLAIN.test(never), "the page is plain ASCII");
  assert(
    !never.includes(KILL_SWITCH_VERDICT_LANE),
    "the page names the detector in words, not by its internal lane key",
  );
  assert(
    /booking/i.test(never) && /stopped/i.test(never),
    "it says which detector went blind and what it was protecting",
  );
  assert(
    /Actions tab|workflow/i.test(never),
    "and names where the answer would have come from, which is an action the reader can actually take (L111)",
  );
}

finish();
