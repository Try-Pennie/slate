// Where each burst's time went (#3416).
//
// Load run 37520312761 failed two of its three bursts: every burst confirm took
// about ten seconds against three to four on run 37390071571, and the slowest losers
// were refused 503 VERIFY_UNAVAILABLE rather than SLOT_TAKEN. Nobody could say which
// stage ate the time, because no log line from any burst confirm was kept: the
// archive's tail starts after the bursts. The run now streams a burst tail, and the
// judge matches each burst request to its own confirm's log lines and reports, per
// burst, where the winner's, the SLOT_TAKEN losers' and every other refusal's time
// went. A report, never a bar.
//
// The fixtures are built by the code that EMITS them, never typed out: each burst
// confirm's `confirm answered` line is written by the route's own `answerTimed`, its
// refusal fields by `noteRefusal`, its profile and marks by the profile and the marks
// themselves, and the driver's view of the same answer by the deployment's own echo
// builders read through the driver's own parser. The tail event around it has the
// shape run 37520312761's archive really has (the request's address under
// `event.request.headers`, pretty printed four spaces). A fixture written by the hand
// that wrote the reader agrees with the reader by construction (L52).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-burst-breakdown.ts
import {
  readBurstTail,
  matchBurstAttempts,
  burstBreakdowns,
  burstBreakdownLines,
  readBurstTailFile,
  type BurstTailFile,
} from "./loadtest/burst-breakdown.ts";
import { burstLegLabel, type BurstLegGroup } from "./loadtest/judge-booking-run.ts";
import type { BookingAttempt, DriverResult } from "./loadtest/book-plan.ts";
import { answerTimed, noteRefusal, type ConfirmLineFacts } from "../src/lib/booking/confirm-latency.ts";
import { makeWaitMarks } from "../src/lib/booking/wait-marks.ts";
import { traced, type RefusalTrace } from "../src/lib/booking/refusal-trace.ts";
import { DependencyTimeoutError } from "../src/lib/booking/orchestration.ts";
import { answeredAtEchoHeader, confirmLineEchoHeaders, readLoadtestEcho } from "../src/lib/loadtest-echo.ts";
import { formatLine } from "../src/lib/log.ts";
import type { LineGroupSource } from "../src/lib/booking/pool-grouping-reader.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SLOT = "2026-10-07T17:40:00.000Z";
const MOMENT = 1_791_316_778_917;

interface ConfirmSpec {
  ip: string;
  /** When the invocation began, on the deployment's clock. */
  startAtMs: number;
  status: number;
  outcome: string;
  /** The route's own answer time. */
  responseMs: number;
  line?: { key: "code" | "ladder"; lineMs: number };
  waits: { auth: number; line: number; decide: number };
  /** The stages the confirm ran, each charged its milliseconds. */
  stages?: [string, number][];
  refusal?: RefusalTrace;
  timeout?: boolean;
  leg?: string;
  cpuMs?: number;
  /** #3460: where its line key's grouping came from, and the wait for the snapshot. */
  grouping?: { source: LineGroupSource; waitedMs: number | null };
}

/**
 * One burst confirm, end to end: the tail event its invocation archives and the
 * attempt the driver records for the same answer.
 */
async function confirmOf(spec: ConfirmSpec, n: number): Promise<{ event: string; attempt: BookingAttempt }> {
  let t = spec.startAtMs;
  const now = () => t;
  const facts: ConfirmLineFacts = {
    marks: makeWaitMarks(now, spec.startAtMs),
    lineTrace: `trace-${n}`,
    loadtestLeg: (spec.leg ?? "burst") as ConfirmLineFacts["loadtestLeg"],
    isolateInvocationIndex: 4,
  };
  const lines: string[] = [];
  const info = console.info;
  console.info = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    await answerTimed(
      "booking-api",
      async () => {
        facts.marks?.mark("handler");
        t += spec.waits.auth;
        facts.marks?.mark("authed");
        facts.marks?.mark("line_start");
        t += spec.waits.line;
        facts.marks?.mark("line_turn");
        if (spec.line) facts.line = { line: "shared", reason: "ok", key: spec.line.key, lineMs: spec.line.lineMs };
        if (spec.grouping) {
          facts.lineGroupSource = spec.grouping.source;
          facts.grouping = { source: spec.grouping.waitedMs === null ? "held" : "installed", waitedMs: spec.grouping.waitedMs, ageMs: null };
        }
        t += spec.waits.decide;
        facts.marks?.mark("decided");
        facts.marks?.mark("profile");
        for (const [stage, ms] of spec.stages ?? []) {
          await facts.profile!.time(stage, async () => {
            t += ms;
          });
        }
        t = spec.startAtMs + spec.responseMs;
        if (spec.refusal) noteRefusal(facts, traced(new Error("refused"), spec.refusal));
        if (spec.timeout) noteRefusal(facts, new DependencyTimeoutError({ label: "google freeBusy", timeoutMs: 4_000, budget: null }, null));
        return new Response(null, { status: spec.status });
      },
      { now, facts },
    );
  } finally {
    console.info = info;
  }
  const answer = lines.find((l) => l.includes('msg="confirm answered"'));
  if (!answer) throw new Error("answerTimed wrote no answer line, so the fixture is not the real shape");
  const answeredAtMs = t;
  const event = JSON.stringify(
    {
      wallTime: spec.responseMs + 400,
      cpuTime: spec.cpuMs ?? 300,
      truncated: false,
      executionModel: "stateless",
      outcome: "ok",
      scriptTags: ["cf:service=slate", "cf:environment=loadtest"],
      scriptVersion: { id: "214806f9-7511-4c55-8982-19dd878a03ae" },
      scriptName: "slate-loadtest",
      diagnosticsChannelEvents: [],
      exceptions: [],
      logs: [
        { message: [formatLine("booking-api", { msg: "authenticated request", key: "canary:primary" })], level: "info", timestamp: spec.startAtMs + spec.waits.auth },
        { message: [answer], level: "info", timestamp: answeredAtMs },
      ],
      eventTimestamp: spec.startAtMs,
      event: {
        request: {
          url: "https://slate-loadtest.example.workers.dev/api/bookings",
          method: "POST",
          headers: { "cf-connecting-ip": spec.ip, "content-type": "application/json", "x-loadtest-leg": spec.leg ?? "burst" },
        },
        response: { status: spec.status },
      },
    },
    null,
    4,
  );
  // The driver's view of the same answer, through the deployment's own builders and
  // the driver's own parser: the stamp is the clock the answer line was written on.
  const headers = new Headers([
    ...(facts.line ? confirmLineEchoHeaders(facts.line) : []),
    answeredAtEchoHeader(answeredAtMs),
  ]);
  const attempt: BookingAttempt = {
    driver: 0,
    n,
    code: n % 2 === 0 ? "120" : "121",
    externalId: `run-1-1-b-0-${n}`,
    sentAtMs: spec.startAtMs - 12,
    wallMs: spec.responseMs + 40,
    status: spec.status,
    outcome: spec.outcome,
    startIso: SLOT,
    seenIp: spec.ip,
    echo: readLoadtestEcho(headers),
  } as BookingAttempt;
  return { event, attempt };
}

function noReply(n: number): BookingAttempt {
  return {
    driver: 0,
    n,
    code: "120",
    externalId: `run-1-1-b-0-${n}`,
    sentAtMs: MOMENT,
    wallMs: 30_000,
    status: 0,
    outcome: "transport: TimeoutError",
    startIso: SLOT,
    seenIp: null,
    echo: null,
  } as BookingAttempt;
}

function group(index: number, attempts: BookingAttempt[], momentMs = MOMENT): BurstLegGroup {
  const file = {
    runId: "run-1-1",
    driver: 0,
    mode: "burst",
    planned: attempts.length,
    startedAtMs: momentMs - 1_000,
    finishedAtMs: momentMs + 20_000,
    burstLeg: { index, of: 2, slot: SLOT, codes: ["120", "121"], startAtMs: momentMs },
    attempts,
  } as DriverResult;
  return { index, of: 2, slot: SLOT, files: [file] };
}

const IP_A = "20.115.95.126";
const IP_B = "20.12.244.197";
const follower: RefusalTrace = { requestedStart: SLOT, bucketCode: "120", stage: "follower", rungs: [], leaderRefusal: "taken" };
const unreadable: RefusalTrace = {
  requestedStart: SLOT,
  bucketCode: "121",
  stage: "verify_unreadable",
  rungs: [{ code: "121", members: 1, read: 1, claimed: 0, checked: 1, stage: "verify_unreadable" }],
};

// The burst: one winner, three SLOT_TAKEN followers (two of them answered on the same
// millisecond, from the same runner, on the same line, which is what a crowd released
// at once by its leader looks like), two VERIFY_UNAVAILABLE (one refused by Google
// being unreadable, one timed out with no stage of its own), and one with no reply.
const specs: ConfirmSpec[] = [
  {
    ip: IP_A, startAtMs: MOMENT + 20, status: 200, outcome: "created", responseMs: 9_962,
    line: { key: "code", lineMs: 1_051 }, waits: { auth: 311, line: 1_051, decide: 487 },
    stages: [["assign-and-verify", 6_100], ["complete-reservation", 1_900]], cpuMs: 900,
    grouping: { source: "timeout", waitedMs: 500 },
  },
  {
    ip: IP_A, startAtMs: MOMENT + 25, status: 409, outcome: "SLOT_TAKEN", responseMs: 9_986,
    line: { key: "code", lineMs: 70 }, waits: { auth: 2_900, line: 70, decide: 300 },
    stages: [["confirm-line", 6_500]], refusal: follower,
    grouping: { source: "absent", waitedMs: 30 },
  },
  {
    ip: IP_A, startAtMs: MOMENT + 25, status: 409, outcome: "SLOT_TAKEN", responseMs: 9_986,
    line: { key: "code", lineMs: 70 }, waits: { auth: 2_900, line: 70, decide: 300 },
    stages: [["confirm-line", 6_400]], refusal: follower,
    grouping: { source: "absent", waitedMs: 30 },
  },
  {
    ip: IP_B, startAtMs: MOMENT + 30, status: 409, outcome: "SLOT_TAKEN", responseMs: 10_121,
    line: { key: "ladder", lineMs: 66 }, waits: { auth: 3_000, line: 66, decide: 310 },
    stages: [["confirm-line", 6_600]], refusal: follower,
    grouping: { source: "snapshot", waitedMs: 80 },
  },
  {
    ip: IP_B, startAtMs: MOMENT + 35, status: 503, outcome: "VERIFY_UNAVAILABLE", responseMs: 12_804,
    line: { key: "code", lineMs: 55 }, waits: { auth: 3_100, line: 55, decide: 400 },
    stages: [["assign-and-verify", 9_000]], refusal: unreadable,
    grouping: { source: "local", waitedMs: null },
  },
  {
    ip: IP_B, startAtMs: MOMENT + 40, status: 503, outcome: "VERIFY_UNAVAILABLE", responseMs: 13_280,
    line: { key: "code", lineMs: 68 }, waits: { auth: 3_200, line: 68, decide: 420 },
    stages: [["assign-and-verify", 9_400]], timeout: true,
    grouping: { source: "own-code-missing", waitedMs: null },
  },
];

const built: { event: string; attempt: BookingAttempt }[] = [];
for (const [i, s] of specs.entries()) built.push(await confirmOf(s, i));
const attempts = [...built.map((b) => b.attempt), noReply(specs.length)];
// A steady confirm the window also caught, from another leg, on the winner's own
// address and answer millisecond, so only the leg keeps it out of the burst.
const steadyStray = await confirmOf({ ...specs[0]!, leg: "steady", status: 200, outcome: "created" }, 99);
// A cron tick: an invocation carrying no confirm at all, as the real window holds.
const cronTick = JSON.stringify(
  {
    wallTime: 900,
    cpuTime: 200,
    outcome: "ok",
    logs: [{ message: [formatLine("recompute", { msg: "cycle", refreshed: 3 })], level: "info", timestamp: MOMENT - 5_000 }],
    eventTimestamp: MOMENT - 5_900,
    event: { cron: "* * * * *", scheduledTime: MOMENT - 6_000 },
  },
  null,
  4,
);
const archive = [cronTick, ...built.map((b) => b.event), steadyStray.event].join("\n");

// --- reading the burst tail ------------------------------------------------------------
{
  const tail = readBurstTail(archive);
  eq(tail.confirms.length, specs.length, "every burst confirm's answer line is read from the tail");
  eq(tail.otherLegs, 1, "a confirm another leg sent is counted apart, never read as a burst one");
  eq(tail.events, specs.length + 2, "every event in the window is counted, the cron tick and the stray included");
  eq(tail.unparsable, 0, "a whole archive has nothing unparsable");
  const winner = tail.confirms.find((c) => c.status === 200);
  assert(winner !== undefined && winner.ip === IP_A, "the request's address is read from where the runtime archives it");
  eq(winner?.responseMs, 9_962, "the route's own answer time is read");
  eq(winner?.waits.wait_auth_ms, 311, "and its marks");
  eq(winner?.profile?.stages.map((s) => `${s.stage}:${s.ms}`).join(","), "assign-and-verify:6100,complete-reservation:1900", "and the stage profile a slow confirm's line carries");
  const timedOut = tail.confirms.find((c) => c.timedOut);
  assert(timedOut !== undefined && timedOut.refusalStage === null, "a timed out refusal with no trace reads as no stage, never a guessed one");
  const refused = tail.confirms.find((c) => c.refusalStage === "verify_unreadable");
  eq(refused?.stageCounts, "121:1/1/0/1", "a refusal's per rung counts are read in the shape the route writes them");
}

// --- matching each request to its own confirm's lines -------------------------------------
{
  const tail = readBurstTail(archive);
  const m = matchBurstAttempts(attempts, tail.confirms);
  // The positive control (L1): a matcher that matched nothing must never pass as a burst
  // with nothing slow in it, so the count it matched is asserted, not only its silence.
  eq(m.matched.length, specs.length, "every answered burst request is matched to its confirm");
  eq(m.interchangeable, 2, "two answers on one millisecond, address and line are matched as one block");
  eq(m.noReply.length, 1, "a request with no reply has nothing to match, and is counted as that");
  eq(m.unmatched.length + m.ambiguous.length + m.noStamp.length, 0, "nothing else is left over");
  for (const { attempt, confirm } of m.matched) {
    assert(attempt.status === confirm.status, `request ${attempt.n} is matched to a confirm with its own status`);
  }
  const won = m.matched.find((x) => x.attempt.status === 200);
  eq(won?.confirm.responseMs, 9_962, "the winner is matched to the winner's line, not the steady stray on its millisecond");
}

// --- control: a stamp one millisecond off matches nothing, and says so ----------------------
{
  const tail = readBurstTail(archive);
  const shifted = attempts.map((a) =>
    a.echo && a.echo.answeredAtMs.state === "read"
      ? ({ ...a, echo: { ...a.echo, answeredAtMs: { state: "read", value: a.echo.answeredAtMs.value + 1 } } } as BookingAttempt)
      : a,
  );
  const m = matchBurstAttempts(shifted, tail.confirms);
  eq(m.matched.length, 0, "control: a stamp one millisecond off matches no confirm");
  eq(m.unmatched.length, specs.length, "control: and every answered request is unmatched, by name");
  const lines = burstBreakdownLines({ groups: [group(0, shifted)], tail: { kind: "read", text: archive } });
  const text = lines.join("\n");
  assert(/burst 1 of 2.*UNMEASURED/.test(text), `control: a burst whose requests matched nothing is UNMEASURED (got ${text})`);
  assert(!text.includes("assign-and-verify") && !text.includes("refused at"), "control: and no stage figure is printed for it, so it never reads as quick");
  // #3429: the burst is named by the judge's own label, its kind included, so the
  // breakdown and the verdict never name one burst two ways (L41).
  const drop = group(1, shifted);
  drop.files[0]!.burstLeg = { ...drop.files[0]!.burstLeg!, kind: "drop" };
  const named = burstBreakdownLines({ groups: [group(0, shifted), drop], tail: { kind: "read", text: archive } }).join("\n");
  assert(
    named.includes(burstLegLabel(drop)) && named.includes("burst 2 of 2, the tier drop burst") && named.includes("burst 1 of 2, the refusal control"),
    `each burst is named with its kind, by the judge's label (got ${named})`,
  );
}

// --- control: two requests on one key with only one confirm are ambiguous, never guessed ----
{
  const tail = readBurstTail(archive);
  const lone = tail.confirms.filter((c) => c.status !== 409 || c.ip !== IP_A).concat(tail.confirms.find((c) => c.status === 409 && c.ip === IP_A)!);
  const m = matchBurstAttempts(attempts, lone);
  eq(m.ambiguous.length, 2, "two requests sharing one key and one confirm are both ambiguous (L521)");
  eq(m.matched.length, specs.length - 2, "and the others still match");
  // A block of two requests whose outcomes differ cannot be matched as one: which line
  // is whose would decide which outcome each figure is reported under.
  const mixed = attempts.map((a) => (a.n === 2 ? ({ ...a, outcome: "CONFLICT" } as BookingAttempt) : a));
  const mm = matchBurstAttempts(mixed, tail.confirms);
  eq(mm.ambiguous.length, 2, "a block whose requests ended differently is ambiguous rather than split by a guess");
}

// --- the breakdown, by outcome --------------------------------------------------------------
{
  const tail = readBurstTail(archive);
  const [b] = burstBreakdowns([group(0, attempts)], tail);
  assert(b !== undefined, "one breakdown per burst");
  eq(b!.requests, attempts.length, "every request in the burst's files is counted");
  eq(b!.groups.map((g) => g.label).join(" | "), "won | SLOT_TAKEN | 503 VERIFY_UNAVAILABLE | no reply", "the winner first, then SLOT_TAKEN, then every other outcome");
  const taken = b!.groups.find((g) => g.label === "SLOT_TAKEN")!;
  eq(taken.matched, 3, "all three SLOT_TAKEN are matched");
  eq(taken.refusals, { follower: 3 }, "and their refusing stage is tallied");
  eq(taken.stages["confirm-line"]?.slice().sort((x, y) => x - y), [6_400, 6_500, 6_600], "each SLOT_TAKEN's own stage time is carried");
  const other = b!.groups.find((g) => g.label === "503 VERIFY_UNAVAILABLE")!;
  eq(
    other.refusals,
    { "verify_unreadable at 121:1/1/0/1": 1, "no stage on its line, timed out": 1 },
    "every other refusal's stage is reported, with its per rung counts, and a refusal with no stage is said to have none",
  );
}

// --- the report lines ---------------------------------------------------------------------
{
  const lines = burstBreakdownLines({ groups: [group(0, attempts)], tail: { kind: "read", text: archive } });
  const text = lines.join("\n");
  console.log(`(the rendered section)\n${text}`);
  assert(lines[0]!.startsWith("- where each burst's time went"), `the section opens with its own head (got ${lines[0]})`);
  assert(text.includes("reported, not a bar"), "and says it is a report, never a bar");
  assert(/6 of 7 burst requests matched/.test(text), `the head says how many requests were matched, of how many (got ${lines[0]})`);
  assert(/won \(1, 1 matched\)/.test(text), "the winner's own breakdown is there");
  assert(text.includes("assign-and-verify 6100ms"), "carrying its stage times as the line logged them");
  assert(/SLOT_TAKEN \(3, 3 matched\)/.test(text) && text.includes("refused at follower x3"), "the SLOT_TAKEN losers' breakdown and refusing stage are there");
  assert(text.includes("verify_unreadable at 121:1/1/0/1 x1") && text.includes("no stage on its line, timed out x1"), "every other refusal's stage is named, each with its count");
  assert(text.includes("code:members/read/claimed/checked"), "and the per rung counts say what they count");
  assert(/no reply \(1\)/.test(text), "a request with no reply is named, never silently dropped");
  assert(/2 matched as one block/.test(text), "the interchangeable block is named, so the matching is never overstated");
}

// --- #3460: where each burst's line keys came from ------------------------------------------
//
// Every way of not getting the snapshot falls back to the code's own line, so a burst whose
// confirms all fell back reads exactly like one keyed from the snapshot unless the report
// counts them (L551). Counted per burst over its matched confirms, with the wait the fetch
// added, so the next run measures the bound rather than taking it on trust.
{
  const [b] = burstBreakdowns([group(0, attempts)], readBurstTail(archive));
  eq(b!.lineGroupSources, { timeout: 1, absent: 2, snapshot: 1, local: 1, "own-code-missing": 1 }, "every matched confirm's line key source is tallied");
  eq(b!.groupingFetchMs.slice().sort((x, y) => x - y), [30, 30, 80, 500], "and the wait of every confirm that fetched");
  const text = burstBreakdownLines({ groups: [group(0, attempts)], tail: { kind: "read", text: archive } }).join("\n");
  assert(text.includes("line keys: 1 of 6 from the snapshot"), `the share keyed from the snapshot is stated (got ${text})`);
  assert(text.includes("absent x2") && text.includes("timeout x1") && text.includes("own-code-missing x1") && text.includes("local x1"), "and every other source is named, with its count");
  assert(/grouping fetch p50 \d+ms max 500ms/.test(text), "and the fetch's wait is spread");
}
{
  // A deployment before #3460 writes no source: UNMEASURED, never "0 from the snapshot" (L98).
  const bareBuilt: { event: string; attempt: BookingAttempt }[] = [];
  for (const [i, s] of specs.entries()) bareBuilt.push(await confirmOf({ ...s, grouping: undefined }, i));
  const bareArchive = bareBuilt.map((x) => x.event).join("\n");
  const text = burstBreakdownLines({ groups: [group(0, bareBuilt.map((x) => x.attempt))], tail: { kind: "read", text: bareArchive } }).join("\n");
  assert(/line keys: UNMEASURED/.test(text) && !text.includes("from the snapshot"), `a burst whose confirms said nothing about their line keys is UNMEASURED (got ${text})`);
}

// --- UNMEASURED, each in its own words --------------------------------------------------------
{
  const g = [group(0, attempts)];
  const absent = burstBreakdownLines({ groups: g, tail: { kind: "absent" } }).join("\n");
  assert(/UNMEASURED/.test(absent) && absent.includes("burst-tail.jsonl") && /never arrived/.test(absent), `a missing burst tail is UNMEASURED and says it never arrived (got ${absent})`);
  const unread = burstBreakdownLines({ groups: g, tail: { kind: "unreadable", why: "EACCES: permission denied" } }).join("\n");
  assert(/UNMEASURED/.test(unread) && unread.includes("EACCES"), `an unreadable burst tail is UNMEASURED and says why (got ${unread})`);
  const empty = burstBreakdownLines({ groups: g, tail: { kind: "read", text: "" } }).join("\n");
  assert(/UNMEASURED/.test(empty) && /empty/.test(empty), `an empty burst tail is UNMEASURED and says it was empty (got ${empty})`);
  const onlyCron = burstBreakdownLines({ groups: g, tail: { kind: "read", text: cronTick } }).join("\n");
  assert(/UNMEASURED/.test(onlyCron) && /1 events?/.test(onlyCron) && /not one burst confirm/.test(onlyCron), `a tail with no burst confirm in it is UNMEASURED, with what it did hold (got ${onlyCron})`);
  for (const [what, t] of [["absent", absent], ["unreadable", unread], ["empty", empty], ["cron only", onlyCron]] as const) {
    assert(!/refused at|matched \(/.test(t), `${what}: no breakdown figure is printed beside the UNMEASURED`);
  }
  const none = burstBreakdownLines({ groups: [], tail: { kind: "absent" } as BurstTailFile }).join("\n");
  assert(/no burst leg/.test(none), `a run with no burst leg says so rather than leaving the section out (got ${none})`);
}

// --- the file itself: never arrived, could not be read, read -----------------------------------
// Two different facts (L11): a burst tail that never arrived sends a reader to the
// burst-tail job, one that could not be read sends them to the file.
{
  const absent = readBurstTailFile(() => {
    throw Object.assign(new Error("ENOENT: no such file or directory, open 'results/burst-tail.jsonl'"), { code: "ENOENT" });
  });
  eq(absent.kind, "absent", "no file is absent");
  const denied = readBurstTailFile(() => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  });
  assert(denied.kind === "unreadable" && denied.why.includes("EACCES"), `any other failure is unreadable, carrying its cause (got ${JSON.stringify(denied)})`);
  const read = readBurstTailFile(() => archive);
  assert(read.kind === "read" && read.text === archive, "a file that reads is handed on whole");
}

// --- a stream killed mid write is counted, not a crash -------------------------------------------
{
  const cut = archive + "\n" + built[0]!.event.slice(0, 200);
  const tail = readBurstTail(cut);
  eq(tail.unparsable, 1, "a half written last event is counted as unparsable");
  eq(tail.confirms.length, specs.length, "and every whole event before it is still read");
  const text = burstBreakdownLines({ groups: [group(0, attempts)], tail: { kind: "read", text: cut } }).join("\n");
  assert(/1 not readable JSON/.test(text), `and the report says so (got ${text.split("\n")[0]})`);
}

finish();
