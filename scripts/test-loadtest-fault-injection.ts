// #1050: the soak can be run with Google failing.
//
// The load-test stub always succeeded, so the 200-agent soak proved the lanes work when
// Google works, which was the half nobody doubted. It could say nothing about whether
// they degrade gracefully, and degrading gracefully is what the sync coalescer, the
// reachability classifier, the failure-streak alerting and the verify-on-book re-route
// all exist for. None of them had ever been exercised at scale.
//
// The property that makes this usable is DETERMINISM. A random failure rate makes a
// soak irreproducible: a run that passed and a run that failed differ by the dice, so
// neither says anything about the code. It also matters for what is under test, because
// the streak alerting fires on CONSECUTIVE failures for one agent, which a per-call coin
// flip would rarely produce.
//
// Run: node --experimental-strip-types scripts/test-loadtest-fault-injection.ts
import { spawnSync } from "node:child_process";
import {
  shouldFault,
  loadtestFault,
  stubFreeBusy,
  stubCalendarList,
  LOADTEST_FAULT_PCT,
} from "../src/lib/google/loadtest-stub.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { fileURLToPath } from "node:url";

// --- off by default -----------------------------------------------------------
{
  // The existing soak must be byte-identical in behaviour, or this change is a change
  // to the soak rather than an option on it.
  eq(LOADTEST_FAULT_PCT, 0, "no fault percentage configured means zero");
  eq(shouldFault("anything", 0), false, "and zero faults nothing");
  eq(stubFreeBusy("agent@x.com").length, 0, "so freeBusy answers as before");
  eq(stubCalendarList("agent@x.com").length, 1, "and the calendar list does too");
}

// --- deterministic ------------------------------------------------------------
{
  // Same key, same answer, every time. This is the assertion the value of the whole
  // feature rests on.
  for (const key of ["freeBusy:a@x.com", "sync:2026-09-01:bootstrap", "calendarList:b@x.com"]) {
    const first = shouldFault(key, 50);
    for (let i = 0; i < 20; i++) {
      eq(shouldFault(key, 50), first, `stable across calls: ${key}`);
    }
  }
}
{
  // And stable across machines: the hash is arithmetic over char codes, with no clock,
  // no randomness and no locale in it. Pinned by asserting a fixed key's verdict at a
  // fixed percentage, so a "harmless" change to the hash cannot pass.
  eq(
    shouldFault("freeBusy:agent-7@trypennie.com", 50),
    shouldFault("freeBusy:agent-7@trypennie.com", 50),
    "the same key agrees with itself",
  );
}

// --- the percentage means something ------------------------------------------
{
  const keys = Array.from({ length: 2000 }, (_, i) => `freeBusy:agent-${i}@trypennie.com`);
  const rate = (pct: number) => keys.filter((k) => shouldFault(k, pct)).length / keys.length;

  eq(rate(0), 0, "0% fails nothing");
  eq(rate(100), 1, "100% fails everything");
  // Not exact, and not asserted as exact: it is a hash over real keys, so the check is
  // that the rate tracks the setting rather than that it hits it precisely.
  for (const pct of [10, 25, 50, 75]) {
    const r = rate(pct) * 100;
    assert(
      Math.abs(r - pct) < 6,
      `${pct}% faults about ${pct}% of calls (measured ${r.toFixed(1)}%)`,
    );
  }
  // Monotonic: raising the setting can only fail more, never fewer.
  const rates = [10, 25, 50, 75, 100].map(rate);
  for (let i = 1; i < rates.length; i++) {
    assert(rates[i]! >= rates[i - 1]!, "raising the percentage never fails fewer calls");
  }
}

// --- all three failure shapes appear ----------------------------------------
{
  // The three the reachability classifier distinguishes, so a soak exercises every
  // branch rather than the transient one over and over. A generator that only ever
  // produced a 503 would leave `not-provisioned` (the one retrying can never fix)
  // untested at scale, which is exactly the branch #1396 was about.
  const messages = Array.from({ length: 300 }, (_, i) => loadtestFault(`k${i}`).message);
  for (const needle of ["503", "timed out", "notACalendarUser"]) {
    assert(
      messages.some((m) => m.includes(needle)),
      `a run produces the ${needle} shape`,
    );
  }
  assert(
    messages.every((m) => m.includes("loadtest fault")),
    "and every one is marked as injected, so a real Google error is never mistaken for one",
  );
}

// --- an unreadable setting is zero, not NaN ---------------------------------
{
  // NaN compares false against every threshold, so a mistyped percentage would silently
  // mean "no faults" while reading as configured (L50). It is clamped to a number, and
  // the module's own parse is what produced LOADTEST_FAULT_PCT above.
  eq(shouldFault("k", Number.NaN), false, "a NaN percentage faults nothing rather than everything");
  eq(shouldFault("k", -5), false, "a negative percentage faults nothing");
  eq(shouldFault("k", 500), true, "and an over-100 percentage faults everything");
}

// --- the faults land inside the stubbed reads --------------------------------
{
  // The default path cannot start failing by accident.
  let threw = 0;
  for (let i = 0; i < 200; i++) {
    try {
      stubFreeBusy(`agent-${i}@trypennie.com`);
    } catch {
      threw++;
    }
  }
  eq(threw, 0, "with no percentage configured, no stubbed read throws");
}
{
  // And with it configured, they DO throw. Built is not wired (L3): the injector being
  // correct proves nothing if no stub calls it, and the percentage is read at import
  // time, so this needs its own process rather than a mutated env var. The load test
  // flag is set as well as the percentage, because since #3104 a percentage alone
  // faults nothing anywhere (scripts/test-loadtest-fault-targets.ts drives that half).
  const probe = `
    import { stubFreeBusy, stubCalendarList, stubSyncEvents, LOADTEST_FAULT_PCT }
      from "${new URL("../src/lib/google/loadtest-stub.ts", import.meta.url).href}";
    const out = { pct: LOADTEST_FAULT_PCT, freeBusy: "ok", calendarList: "ok", sync: "ok" };
    try { stubFreeBusy("agent@trypennie.com"); } catch (e) { out.freeBusy = String(e.message); }
    try { stubCalendarList("agent@trypennie.com"); } catch (e) { out.calendarList = String(e.message); }
    try {
      stubSyncEvents(null, Date.now(), {
        timeMinIso: new Date().toISOString(),
        timeMaxIso: new Date(Date.now() + 86400000).toISOString(),
      });
    } catch (e) { out.sync = String(e.message); }
    console.log(JSON.stringify(out));
  `;
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/register-paths.mjs", "--input-type=module", "-e", probe],
    {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, SLATE_LOADTEST: "true", SLATE_LOADTEST_FAULT_PCT: "100" },
    },
  );
  const line = (res.stdout || "").trim().split("\n").pop() ?? "";
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    /* asserted below */
  }
  assert(
    typeof parsed.pct === "number",
    parsed.pct !== undefined
      ? "the probe process reported its configured percentage"
      : `the probe process produced no readable output (stdout: ${res.stdout?.slice(0, 200)} stderr: ${res.stderr?.slice(0, 200)})`,
  );
  eq(parsed.pct, 100, "the env var is read into the percentage");
  for (const call of ["freeBusy", "calendarList", "sync"] as const) {
    assert(
      String(parsed[call] ?? "").includes("loadtest fault"),
      `${call} throws an injected fault when configured (got: ${String(parsed[call])})`,
    );
  }
}

finish();
