// #3490: the load test's Google stand in can take production's time on the confirm path.
//
// The stand in answered every call at once, so a load run's confirm latency and its burst
// timings left out production's live check and calendar write. (The 3s and 5s once quoted
// here were the contention model's assumed figures, never a measurement; the values now come
// from the `google_*` fields on every `confirm answered` line, #3490.) This suite holds the
// four things that make the delay usable and safe, a fifth that keeps its value measured,
// plus the confirm line's Google fields counting the same calls the delay stands in for:
//
//   1. the setting's grammar, strict, with off as the default and a typo reported rather
//      than half applied;
//   2. the distribution really is production shaped: fitted through the median and the p95
//      it was given, and capped at the call's own deadline and the budget left;
//   3. it can never run in production: outside SLATE_LOADTEST the delay is zero and the
//      sleep is never called, whatever the setting says;
//   4. every Google call a lead waits on (the ones cut off at GOOGLE_CONFIRM_TIMEOUT_MS)
//      takes the delay in its stand in branch, with the kind that matches it, derived from
//      calendar.ts rather than listed, so the next such call is covered by construction;
//   5. the value measured off production is ONE recorded string, the one the contention
//      model's production profile is built from and the one the runbook says to dispatch.
//
// Nothing here waits for real: the sleep, the draw and the budget are all injected (L524).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-google-delay.ts
import { readFileSync } from "node:fs";
import {
  delayAtQuantile,
  formatGoogleDelay,
  googleDelayLine,
  googleDelayOn,
  normalQuantile,
  parseGoogleDelay,
  GOOGLE_DELAY_VAR,
} from "../src/lib/google/loadtest-google-delay.ts";
import { loadtestGoogleDelay } from "../src/lib/google/loadtest-stub.ts";
import { calendarExports } from "./lib/scan-loadtest-stub-coverage.ts";
import { GOOGLE_TIMING_GROUPS } from "../src/lib/booking/confirm-profile.ts";
import { awaitGoogleDelay, googleDelayVerdict } from "./loadtest/preflight-checks.ts";
import {
  MEASURED_PRODUCTION_GOOGLE_DELAY,
  PRODUCTION_PROFILE,
  STACK_PRODUCTION_PROFILE,
} from "./lib/confirm-load-model.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the grammar -----------------------------------------------------------------------------
{
  eq(parseGoogleDelay(undefined), { read: null, write: null, unknown: null }, "unset is off");
  eq(parseGoogleDelay("  "), { read: null, write: null, unknown: null }, "blank is off");
  eq(
    parseGoogleDelay("read=3000/5000,write=5000/8000"),
    { read: { p50Ms: 3000, p95Ms: 5000 }, write: { p50Ms: 5000, p95Ms: 8000 }, unknown: null },
    "both kinds parse",
  );
  eq(
    parseGoogleDelay(" write = 5000 / 8000 "),
    { read: null, write: { p50Ms: 5000, p95Ms: 8000 }, unknown: null },
    "one kind alone parses, and spacing is forgiven",
  );
  for (const bad of [
    "read=3000",
    "read=3s/5s",
    "reads=3000/5000",
    "read=5000/3000",
    "read=0/100",
    "read=3000/70000",
    "read=3000/5000,read=3000/5000",
    "read=3000/5000,write=oops",
    "READ=3000/5000",
  ]) {
    const s = parseGoogleDelay(bad);
    assert(
      s.unknown === bad.trim() && s.read === null && s.write === null,
      `"${bad}" is unknown and delays NOTHING, rather than half of what was asked`,
    );
  }
  eq(
    formatGoogleDelay(parseGoogleDelay(" write=5000/8000 , read=3000/5000")),
    "read=3000/5000,write=5000/8000",
    "two spellings of one rig format the same, so the preflight compares rigs and not order",
  );
  eq(formatGoogleDelay(parseGoogleDelay(undefined)), "", "off formats empty");
  assert(!googleDelayOn(parseGoogleDelay("")), "off is off");
  assert(googleDelayOn(parseGoogleDelay("read=1/1")), "one kind is on");
}

// --- production shaped: a lognormal through the median and p95 it was given ---------------------
{
  // The quantile function itself, at points with known answers.
  assert(Math.abs(normalQuantile(0.5)) < 1e-9, "the median of a standard normal is 0");
  assert(Math.abs(normalQuantile(0.95) - 1.6448536) < 1e-6, "its 95th percentile is 1.645");
  assert(Math.abs(normalQuantile(0.01) + 2.3263479) < 1e-6, "its 1st percentile is -2.326 (the low tail branch)");
  assert(Math.abs(normalQuantile(0.99) - 2.3263479) < 1e-6, "its 99th is 2.326 (the high tail branch)");

  const d = { p50Ms: 3000, p95Ms: 5000 };
  eq(delayAtQuantile(d, 0.5), 3000, "the median draw is the median asked for");
  eq(delayAtQuantile(d, 0.95), 5000, "the 95th percentile draw is the p95 asked for");
  assert(delayAtQuantile(d, 0.05) < 3000 && delayAtQuantile(d, 0.05) > 0, "a low draw is faster than the median and still positive");
  assert(delayAtQuantile(d, 0.99) > 5000, "the tail runs past the p95, as a network call's does");
  eq(delayAtQuantile({ p50Ms: 4000, p95Ms: 4000 }, 0.99), 4000, "a median equal to its p95 is a constant delay");

  // And over many draws the sample has the shape asked for, not merely the two points.
  const draws: number[] = [];
  for (let i = 0; i < 2000; i++) draws.push(delayAtQuantile(d, (i + 0.5) / 2000));
  draws.sort((a, b) => a - b);
  const p50 = draws[Math.floor(0.5 * draws.length)]!;
  const p95 = draws[Math.floor(0.95 * draws.length)]!;
  assert(Math.abs(p50 - 3000) <= 15, `a sample's median lands on 3000 (got ${p50})`);
  assert(Math.abs(p95 - 5000) <= 30, `a sample's p95 lands on 5000 (got ${p95})`);
}

// --- the runtime half: the gate, the draw, the caps, and the sleep ----------------------------
{
  const run = async (opts: {
    loadtest: boolean;
    raw: string | undefined;
    kind: "read" | "write";
    u?: number;
    left?: number | null;
    callDeadlineMs?: number;
  }) => {
    const slept: number[] = [];
    const errors: string[] = [];
    const waited = await loadtestGoogleDelay(opts.kind, opts.callDeadlineMs ?? 8000, {
      loadtest: opts.loadtest,
      raw: opts.raw,
      random: () => opts.u ?? 0.5,
      sleep: async (ms) => void slept.push(ms),
      budgetLeftMs: () => (opts.left === undefined ? null : opts.left),
      reportUnknown: (msg) => void errors.push(msg),
    });
    return { waited, slept, errors };
  };
  const RIG = "read=3000/5000,write=5000/8000";

  // THE GATE. Production never sets SLATE_LOADTEST, so whatever the setting says, nothing waits.
  for (const raw of [RIG, "read=1/60000", "nonsense"]) {
    const prod = await run({ loadtest: false, raw, kind: "read" });
    eq(prod.waited, 0, `outside a load test "${raw}" delays nothing`);
    eq(prod.slept.length, 0, `and the sleep is never called for "${raw}"`);
    eq(prod.errors.length, 0, `and nothing is even read, so a stray value says nothing in production for "${raw}"`);
  }

  const off = await run({ loadtest: true, raw: undefined, kind: "write" });
  assert(off.waited === 0 && off.slept.length === 0, "a load test with the setting unset waits for nothing, as every run before this did");

  const read = await run({ loadtest: true, raw: RIG, kind: "read" });
  eq(read.slept, [3000], "a read at the median waits the read median");
  const write = await run({ loadtest: true, raw: RIG, kind: "write", u: 0.95 });
  eq(write.slept, [8000], "a write at its p95 waits the write p95");
  const onlyReads = await run({ loadtest: true, raw: "read=3000/5000", kind: "write" });
  assert(onlyReads.waited === 0 && onlyReads.slept.length === 0, "a kind the setting does not name is not delayed");

  // THE CAPS. A real call is cut off at its own deadline, and never outlives the budget it runs
  // inside; the stand in holds to both and then ANSWERS, because a timeout is the fault
  // switch's job (google-read's timeout shape), not this setting's.
  const tail = await run({ loadtest: true, raw: RIG, kind: "write", u: 0.999 });
  eq(tail.slept, [8000], "a tail draw past the call's deadline waits the deadline, no longer");
  const tight = await run({ loadtest: true, raw: RIG, kind: "read", left: 1200 });
  eq(tight.slept, [1200], "inside a confirm with 1.2s left, the stand in waits 1.2s, not the median");
  const spent = await run({ loadtest: true, raw: RIG, kind: "read", left: 0 });
  assert(spent.waited === 0 && spent.slept.length === 0, "a budget already spent waits for nothing");

  // FAIL LOUD on a value that did not parse: nothing is delayed, and it is said.
  const typo = await run({ loadtest: true, raw: "read=3s/5s", kind: "read" });
  assert(typo.waited === 0 && typo.slept.length === 0, "an unreadable setting delays nothing");
  assert(
    typo.errors.length === 1 && typo.errors[0]!.includes(GOOGLE_DELAY_VAR) && typo.errors[0]!.includes("read=3s/5s"),
    "and is reported, naming the variable and the value",
  );
}

// --- the report header names the rig -----------------------------------------------------------
{
  assert(googleDelayLine(undefined).includes("**off**"), "a hand run names the delay off");
  eq(
    googleDelayLine("write=5000/8000,read=3000/5000"),
    "Google stand in delay: **read=3000/5000,write=5000/8000** (live checks median 3000ms, p95 5000ms; calendar writes median 5000ms, p95 8000ms) (#3490).",
    "a delayed run names both distributions",
  );
  assert(googleDelayLine("write=5000/8000").includes("live checks not delayed"), "a kind left out is said to be undelayed");
  assert(googleDelayLine("read=3s").includes('"read=3s", which is no setting'), "a dispatch that named no setting says so rather than claiming off");
}

// --- the preflight refuses a deployment running a rig nobody dispatched ----------------------
{
  const body = (googleDelay: unknown, googleDelayUnknown: unknown = null) => ({ loadtest: true, googleDelay, googleDelayUnknown });
  const RIG = "read=3000/5000,write=5000/8000";

  assert(googleDelayVerdict(body(""), undefined).ok, "a hand run against an undelayed deployment passes");
  assert(googleDelayVerdict(body(""), "").ok, "an off dispatch against an undelayed deployment passes");
  assert(googleDelayVerdict(body(RIG), " write=5000/8000,read=3000/5000 ").ok, "the dispatched rig in another spelling passes");

  const landing = googleDelayVerdict(body(""), RIG);
  assert(!landing.ok && landing.retriable, "a delayed dispatch meeting the version being replaced is waited out");
  const otherRig = googleDelayVerdict(body("read=1000/2000"), RIG);
  assert(!otherRig.ok && otherRig.retriable, "and so is the previous rig still answering while the redeploy lands");
  const leftover = googleDelayVerdict(body(RIG), "");
  assert(
    !leftover.ok && !leftover.retriable && leftover.why.includes(RIG) && leftover.why.includes("no --var"),
    "an off dispatch against a deployment left delayed refuses at once, naming the rig and the remedy",
  );
  const badInput = googleDelayVerdict(body(""), "read=3s");
  assert(!badInput.ok && !badInput.retriable && badInput.why.includes("read=3s"), "a misspelled workflow input refuses by name");
  const badDeployment = googleDelayVerdict(body("", "read=3s"), RIG);
  assert(
    !badDeployment.ok && !badDeployment.retriable && badDeployment.why.includes("read=3s") && badDeployment.why.includes("delays nothing"),
    "a deployment holding a value that did not parse refuses, saying it delays nothing",
  );
  const old = googleDelayVerdict({ loadtest: true }, "");
  assert(!old.ok && !old.retriable && old.why.includes("predates"), "a deployment too old to say refuses, even for an off run");

  // The wait itself is the recompute arm's, shared rather than copied (L41): drive it once
  // with the delay's verdict to prove it is wired to this judge, not that one.
  let t = 0;
  let asked = 0;
  const answers = [{ status: 200, body: body("") }, { status: 503, body: {} }, { status: 200, body: body(RIG) }];
  const waited = await awaitGoogleDelay({
    wanted: RIG,
    fetchVersion: async () => answers[Math.min(asked++, answers.length - 1)]!,
    sleep: async (ms) => void (t += ms),
    now: () => t,
    waitMs: 60_000,
    pauseMs: 5_000,
  });
  assert(waited.ok, "a delayed redeploy that lands after a stale answer and a 5xx is waited out");
  eq(asked, 3, "and asked until it landed, no more");
  const refused = await awaitGoogleDelay({
    wanted: "",
    fetchVersion: async () => ({ status: 401, body: { error: "unauthorized" } }),
    sleep: async () => undefined,
    now: () => 0,
    waitMs: 60_000,
    pauseMs: 5_000,
  });
  assert(!refused.ok && refused.why.includes("401") && refused.why.includes("Google delay"), "a refused key is named, and says what could not be asked");
}

// --- every call a lead waits on takes the delay, derived from calendar.ts ---------------------
{
  const calendar = readFileSync("src/lib/google/calendar.ts", "utf8");
  const exports = calendarExports(calendar);
  // The calls whose production deadline is the lead's: these are the confirm path's.
  const leadWaited = exports.filter((e) => /\bGOOGLE_CONFIRM_TIMEOUT_MS\b/.test(e.body));
  // The scan reached something before any verdict is believed (L98).
  assert(leadWaited.length >= 6, `found ${leadWaited.length} lead waited calls; fewer than six means the scan broke`);
  for (const name of ["freeBusy", "freeBusyMany", "createEvent", "updateEventTime", "deleteEvent", "updateEventContact"]) {
    assert(leadWaited.some((e) => e.name === name), `${name} is one of the lead waited calls the scan found`);
  }
  for (const e of leadWaited) {
    const call = /loadtestGoogleDelay\(\s*"(read|write)"\s*,\s*GOOGLE_CONFIRM_TIMEOUT_MS\s*\)/.exec(e.body);
    assert(call !== null, `${e.name} waits for the Google delay in its stand in branch, at the lead's deadline`);
    // A free/busy query is the live check; everything else on this list writes the calendar.
    const expected = /\/freeBusy`/.test(e.body) ? "read" : "write";
    assert(call?.[1] === expected, `${e.name} takes the ${expected} delay (got ${call?.[1] ?? "none"})`);
  }
  // And no call a lead does NOT wait on was given it: a cron lane is not what this measures.
  for (const e of exports.filter((x) => !leadWaited.includes(x))) {
    assert(!/loadtestGoogleDelay\(/.test(e.body), `${e.name} is not a lead waited call and takes no delay`);
  }

  // #3490: the confirm line's Google fields, which the delay's values are read from, count
  // exactly the calls the delay stands in for, by the label each one is profiled under. A
  // renamed label would otherwise leave its field absent for ever, which reads as a confirm
  // that made no such call (L90).
  const groupOf = (label: string) => GOOGLE_TIMING_GROUPS.find((g) => g.labels.includes(label))?.kind ?? null;
  const seen = new Set<string>();
  for (const e of leadWaited) {
    const labels = [...e.body.matchAll(/GOOGLE_CONFIRM_TIMEOUT_MS,\s*"([\w.]+)"/g)].map((m) => `google ${m[1]}`);
    assert(labels.length > 0, `${e.name}: the scan found the label its Google call is profiled under`);
    const expected = /\/freeBusy`/.test(e.body) ? "read" : "write";
    for (const label of labels) {
      seen.add(label);
      assert(groupOf(label) === expected, `${e.name}: "${label}" is counted as ${expected} on the confirm line (got ${groupOf(label) ?? "nothing"})`);
    }
  }
  for (const g of GOOGLE_TIMING_GROUPS.filter((x) => x.kind !== "mint")) {
    for (const label of g.labels) assert(seen.has(label), `"${label}" is a label a lead waited call really uses, not a stale entry`);
  }
  const dwd = readFileSync("src/lib/google/dwd.ts", "utf8");
  const mint = /const MINT_LABEL = "([^"]+)"/.exec(dwd)?.[1];
  eq(GOOGLE_TIMING_GROUPS.find((g) => g.kind === "mint")?.labels, mint ? [mint] : ["(MINT_LABEL not found in dwd.ts)"], "the mint field counts the label dwd.ts mints under");
}

// --- one measured value, read by the model and the runbook (#3490) -------------------------
// The contention model assumed a 3s live check and a 5s write for weeks after production had
// moved to a fraction of that, because the figure lived as a literal nobody re-measured. The
// measurement is now one string: the model's production profile takes its p95s, and the
// runbook names the same string, so a re-measure changes both or this fails.
{
  const measured = parseGoogleDelay(MEASURED_PRODUCTION_GOOGLE_DELAY);
  assert(measured.unknown === null, `the measured value parses (${MEASURED_PRODUCTION_GOOGLE_DELAY})`);
  assert(measured.read !== null && measured.write !== null, "the measured value names both a read and a write");
  for (const profile of [PRODUCTION_PROFILE, STACK_PRODUCTION_PROFILE]) {
    eq(profile.googleCheckMs, measured.read?.p95Ms, `${profile.name}: the live check is the measured read p95`);
    eq(profile.googleWriteMs, measured.write?.p95Ms, `${profile.name}: the calendar write is the measured write p95`);
  }
  const runbook = readFileSync("scripts/loadtest/RUNBOOK.md", "utf8");
  assert(
    runbook.includes(`google_delay: ${MEASURED_PRODUCTION_GOOGLE_DELAY}`),
    `the runbook records the measured value the model uses (google_delay: ${MEASURED_PRODUCTION_GOOGLE_DELAY})`,
  );
}

finish();
