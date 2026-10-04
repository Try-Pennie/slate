// #3258: the load test switch for the post confirm recompute.
//
// The 2026-10-04 load run measured the confirm's "assign and verify" stage 1.7s
// slower at the median than the same day control, while the stage's own database
// reads had not changed. The suspect is the slot recompute every booking schedules
// after its response. The switch lets three back to back runs compare it on, off,
// and doing its reads without its compute.
//
// Pinned here, each from both sides (L1, L159):
//
//   1. PRODUCTION IGNORES IT. With SLATE_LOADTEST not "true" every value, including
//      "off" and a typo, reads as "on" and schedules the real recompute. This is
//      measured through the default arguments too, which read process.env, so the
//      claim is about the wiring rather than about a parameter a test supplied.
//   2. THE MODES. Unset or blank is "on"; "off" schedules nothing; "reads-only"
//      schedules the reads under its OWN job name, so the run's per job line can
//      never count it as the full recompute (L11).
//   3. A BAD VALUE FAILS LOUD. An unknown value is reported (log.error, once per
//      isolate) and treated as "on", matching the fault switch's handling of an
//      unknown target: the deployment reports it on /api/smoke/version, and the
//      preflight refuses before anything is driven.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-post-confirm-recompute-switch.ts
import {
  POST_CONFIRM_RECOMPUTE_MODES,
  POST_CONFIRM_RECOMPUTE_VAR,
  parsePostConfirmRecompute,
  postConfirmRecomputeMode,
  postConfirmRecomputeSetting,
  postConfirmRefresh,
  resetPostConfirmRecomputeWarning,
} from "../src/lib/booking/post-confirm-recompute.ts";
import { awaitRecomputeArm, recomputeModeVerdict } from "./loadtest/preflight-checks.ts";
import { recomputeArmLine } from "../src/lib/booking/post-confirm-recompute-modes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const LT = { SLATE_LOADTEST: "true" } as Record<string, string | undefined>;

// --- the parse ---------------------------------------------------------------------
eq(parsePostConfirmRecompute(undefined), { mode: "on", unknown: null }, "unset is on");
eq(parsePostConfirmRecompute("   "), { mode: "on", unknown: null }, "blank is on");
eq(parsePostConfirmRecompute("off"), { mode: "off", unknown: null }, "off parses");
eq(parsePostConfirmRecompute(" reads-only "), { mode: "reads-only", unknown: null }, "reads-only parses, trimmed");
eq(parsePostConfirmRecompute("on"), { mode: "on", unknown: null }, "on parses");
eq(parsePostConfirmRecompute("OFF"), { mode: "on", unknown: "OFF" }, "case is not forgiven: an unknown value is on, and reported");
eq(parsePostConfirmRecompute("of"), { mode: "on", unknown: "of" }, "a typo is on, and reported");
eq([...POST_CONFIRM_RECOMPUTE_MODES], ["on", "off", "reads-only"], "the three modes, on first");

// --- production ignores it -----------------------------------------------------------
for (const raw of ["off", "reads-only", "garbage"]) {
  const env = { [POST_CONFIRM_RECOMPUTE_VAR]: raw } as Record<string, string | undefined>;
  eq(postConfirmRecomputeSetting(env, false), { mode: "on", unknown: null }, `production reads ${raw} as on, unreported`);
  eq(postConfirmRecomputeSetting({ ...env, SLATE_LOADTEST: "false" }), { mode: "on", unknown: null }, `SLATE_LOADTEST=false reads ${raw} as on`);
  // Positive control in the same fixture: the identical value DOES take effect
  // under load test, so the production answer is the gate and not a dead parser.
  const underLoad = postConfirmRecomputeSetting({ ...env, ...LT });
  if (raw === "garbage") eq(underLoad, { mode: "on", unknown: "garbage" }, "under load test the typo is reported");
  else eq(underLoad.mode, raw, `under load test ${raw} takes effect`);
}

// The default arguments, which are what the booking service calls with. They read
// process.env and isLoadtest() at call time.
{
  const saved = { lt: process.env.SLATE_LOADTEST, v: process.env[POST_CONFIRM_RECOMPUTE_VAR] };
  try {
    delete process.env.SLATE_LOADTEST;
    process.env[POST_CONFIRM_RECOMPUTE_VAR] = "off";
    eq(postConfirmRecomputeMode(), "on", "real env: production with the switch set to off still recomputes");
    process.env.SLATE_LOADTEST = "true";
    eq(postConfirmRecomputeMode(), "off", "real env: the same setting under load test is off (positive control)");
  } finally {
    if (saved.lt === undefined) delete process.env.SLATE_LOADTEST;
    else process.env.SLATE_LOADTEST = saved.lt;
    if (saved.v === undefined) delete process.env[POST_CONFIRM_RECOMPUTE_VAR];
    else process.env[POST_CONFIRM_RECOMPUTE_VAR] = saved.v;
  }
}

// --- a bad value fails loud, once per isolate ----------------------------------------
{
  resetPostConfirmRecomputeWarning();
  const reported: string[] = [];
  const report = (msg: string) => reported.push(msg);
  const env = { ...LT, [POST_CONFIRM_RECOMPUTE_VAR]: "of" };
  eq(postConfirmRecomputeMode(env, true, report), "on", "an unknown value is treated as on");
  eq(postConfirmRecomputeMode(env, true, report), "on", "and again");
  eq(reported.length, 1, "reported once per isolate, not once per booking");
  assert(reported[0]?.includes("of") ?? false, "the report names the value it could not read");
  const quiet: string[] = [];
  resetPostConfirmRecomputeWarning();
  postConfirmRecomputeMode({ ...LT, [POST_CONFIRM_RECOMPUTE_VAR]: "off" }, true, (m) => quiet.push(m));
  postConfirmRecomputeMode({ [POST_CONFIRM_RECOMPUTE_VAR]: "of" }, false, (m) => quiet.push(m));
  eq(quiet.length, 0, "a known value, or any value in production, reports nothing");
}

// --- what each mode schedules ---------------------------------------------------------
{
  const calls: string[] = [];
  const deps = {
    recompute: async (code: string) => void calls.push(`recompute:${code}`),
    readsOnly: async (code: string) => void calls.push(`reads:${code}`),
  };
  const on = postConfirmRefresh("on", "212", deps);
  eq(on?.context, "post-confirm-recompute", "on keeps the job name the judge already counts");
  await on?.work();
  const reads = postConfirmRefresh("reads-only", "112", deps);
  eq(reads?.context, "post-confirm-recompute-reads-only", "reads-only runs under its own job name");
  await reads?.work();
  eq(postConfirmRefresh("off", "312", deps), null, "off schedules nothing");
  eq(calls, ["recompute:212", "reads:112"], "each mode calls exactly its own work, with the booked code");
}

// --- the preflight's check of what the deployment reports --------------------------------
{
  const ok = recomputeModeVerdict({ loadtest: true, postConfirmRecompute: "off", postConfirmRecomputeUnknown: null }, "off");
  eq(ok, { ok: true }, "the deployment reports the arm asked for");
  const stale = recomputeModeVerdict({ loadtest: true, postConfirmRecompute: "on", postConfirmRecomputeUnknown: null }, "off");
  assert(!stale.ok && stale.retriable, "a deployment still on when off was asked for is worth waiting out (a redeploy landing)");
  const leftover = recomputeModeVerdict({ loadtest: true, postConfirmRecompute: "off", postConfirmRecomputeUnknown: null }, "on");
  assert(!leftover.ok && !leftover.retriable && leftover.why.includes("off"), "an on arm against a deployment left off refuses, naming it");
  const typo = recomputeModeVerdict({ loadtest: true, postConfirmRecompute: "on", postConfirmRecomputeUnknown: "of" }, "on");
  const typoOff = recomputeModeVerdict({ loadtest: true, postConfirmRecompute: "on", postConfirmRecomputeUnknown: "of" }, "off");
  assert(
    !typoOff.ok && typoOff.why.includes("ignores it and runs the on arm whatever this run was dispatched for"),
    "an unknown deployment value says the Worker runs on, not the arm asked for",
  );
  assert(!typo.ok && !typo.retriable && typo.why.includes("of"), "a deployment holding an unknown value refuses, even for the on arm");
  const old = recomputeModeVerdict({ loadtest: true }, "on");
  assert(!old.ok && !old.retriable, "a deployment that predates the switch cannot say which arm it is, so it refuses");
  const badWanted = recomputeModeVerdict({ loadtest: true, postConfirmRecompute: "on", postConfirmRecomputeUnknown: null }, "of");
  assert(!badWanted.ok && !badWanted.retriable && badWanted.why.includes("of"), "a misspelled workflow input refuses by name");
}

// --- the preflight's wait for a redeployed arm --------------------------------------------
{
  // An answer of "throw" is a fetch that rejected (a reset mid redeploy).
  type Answer = { status: number; body: unknown } | "throw";
  const run = async (answers: Answer[], wanted: string, waitMs = 60_000) => {
    let t = 0;
    let asked = 0;
    const verdict = await awaitRecomputeArm({
      wanted,
      fetchVersion: async () => {
        const a = answers[Math.min(asked++, answers.length - 1)]!;
        if (a === "throw") throw new TypeError("fetch failed: connection reset");
        return a;
      },
      sleep: async (ms) => void (t += ms),
      now: () => t,
      waitMs,
      pauseMs: 5_000,
    });
    return { verdict, asked };
  };
  const on = { status: 200, body: { loadtest: true, postConfirmRecompute: "on", postConfirmRecomputeUnknown: null } };
  const off = { status: 200, body: { loadtest: true, postConfirmRecompute: "off", postConfirmRecomputeUnknown: null } };
  const blip = { status: 503, body: {} };

  const landed = await run([on, blip, off], "off");
  assert(landed.verdict.ok, "a redeploy that lands after a stale answer and a 5xx is waited out");
  eq(landed.asked, 3, "and asked until it landed, no more");

  const never = await run([on], "off", 20_000);
  assert(!never.verdict.ok && never.verdict.why.includes("20s"), "a redeploy that never lands refuses at the deadline, saying how long it waited");

  // #3269 review: a thrown fetch is not ready yet, never a crash.
  const reset = await run(["throw", "throw", off], "off");
  assert(reset.verdict.ok, "a fetch that throws during the redeploy is waited out like a 5xx");
  eq(reset.asked, 3, "and asked again until the deployment answered");
  const unreachable = await run(["throw"], "on", 10_000);
  assert(
    !unreachable.verdict.ok && unreachable.verdict.why.includes("connection reset"),
    "a fetch that never stops throwing refuses at the deadline, naming the error",
  );

  // #3269 review: a 4xx is its own refusal, named, at once.
  const refused = await run([{ status: 401, body: { error: "unauthorized" } }], "off");
  assert(!refused.verdict.ok && refused.verdict.why.includes("401"), "a 401 refuses naming the status");
  assert(!refused.verdict.ok && !refused.verdict.why.includes("predates"), "and is not read as a deployment that predates the switch");
  eq(refused.asked, 1, "at once, since waiting cannot change a refused key");
  const missing = await run([{ status: 404, body: {} }], "on");
  assert(!missing.verdict.ok && missing.verdict.why.includes("404"), "a 404 refuses naming the status too");

  // #3269 review: a 503 saying no booking key is configured is a missing secret,
  // which waiting can never supply, so it refuses at once.
  const noKey = await run([{ status: 503, body: { error: "booking api not configured" } }], "off");
  assert(!noKey.verdict.ok && !noKey.verdict.retriable, "a 503 with no booking key configured refuses");
  eq(noKey.asked, 1, "at once, not after the deadline");
  assert(!noKey.verdict.ok && noKey.verdict.why.includes("key"), "and says it is the key");

  // #3269 review: 408 and 429 are transient, waited out like a 5xx.
  for (const status of [408, 429]) {
    const passing = await run([{ status, body: {} }, off], "off");
    assert(passing.verdict.ok, `a ${status} is waited out`);
    eq(passing.asked, 2, `and the ${status} was asked again`);
  }
  const stillRefused = await run([{ status: 404, body: {} }], "on");
  assert(!stillRefused.verdict.ok && stillRefused.verdict.why.includes("LOADTEST_BASE_URL"), "any other 4xx keeps the base URL remedy");

  // #3269 review: every deadline refusal reads as whole sentences, never ".,".
  for (const v of [never.verdict, unreachable.verdict, (await run([blip], "on", 10_000)).verdict]) {
    assert(!v.ok && !/[.,]\s*[.,]/.test(v.why), `no doubled punctuation: ${v.ok ? "" : v.why}`);
    assert(!v.ok && /[^.]\.$/.test(v.why), `ends in exactly one full stop: ${v.ok ? "" : v.why}`);
  }

  const leftover = await run([off], "on");
  assert(!leftover.verdict.ok, "an on run against a leftover arm refuses");
  eq(leftover.asked, 1, "at once, since waiting cannot fix it");

  const down = await run([blip], "on", 10_000);
  assert(!down.verdict.ok && down.verdict.why.includes("503"), "a deployment that keeps 5xxing refuses at the deadline, naming the status");
}

// --- the report header names the arm ---------------------------------------------------------
eq(recomputeArmLine(undefined), "Post confirm recompute arm: **on** (#3258).", "a hand run is the on arm");
eq(recomputeArmLine("reads-only"), "Post confirm recompute arm: **reads-only** (#3258).", "the dispatched arm is named");
assert(recomputeArmLine("of").includes('"of", which is no arm'), "a dispatch that named no arm says so rather than claiming on");

// The booking service's wiring is driven through the real deps in
// src/lib/booking/confirm-slot-refresh.test.ts (off, reads-only, production, cron).

finish();
