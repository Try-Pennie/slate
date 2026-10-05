// #3103: the fault leg's sync_failures page must be reachable from the stub.
//
// The load run judges whether the `sync_failures` page fires while 10% of calendar
// reads fail. It never had, on any run, and the stub was why. A sync read's fault was
// keyed on `sync:<timeMin>:<syncToken>`, and the token changes on every call
// (`lt-token-<now>`), so each calendar failed independently about one pass in ten. The
// page needs ONE agent failing on consecutive passes (two for a definitive kind, four
// for a transient one), which a per pass coin flip almost never produces. The stub's
// own comment said the fault exists so "a failing agent stays the failing agent across
// passes"; the code did the opposite.
//
// A second fault sat under the first. The stub raised every failure as a plain Error,
// and the classifier reads a kind only from a GoogleHttpError, so even the
// `403 notACalendarUser` shape was recorded as TRANSIENT. Every faulted calendar
// therefore needed four consecutive passes, which the window cannot hold (see the last
// block below).
//
// So this drives the stub over several passes, then feeds what it produced through the
// real health transition, the real classifier and the real paging predicate.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-sync-fault-streak.ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, eq, finish } from "./lib/harness.ts";
import { nextSyncState, type CalSyncHealth, type FailureKind } from "../src/lib/google/sync-health.ts";
import {
  SYNC_PAGING,
  isPageableFailure,
  dedupeFailingAgents,
  applyBlastRadiusHold,
  isConsecutiveFailure,
  type FailingCalendarRow,
} from "../src/lib/notify/alerts.ts";

/** The production roster size the load run seeds from (the 2026-09-14 shape export). */
const ROSTER = 94;
const FAULT_PCT = 10;
const PASSES = 5;
/** Sync passes on the load test Worker land roughly this far apart. */
const PASS_GAP_MS = 90_000;
/** The faulted window the lane sampler scores, end to end. */
const FAULT_WINDOW_MS = 5 * 60_000;
const T0 = Date.parse("2026-10-05T14:00:00.000Z");

const emails = Array.from({ length: ROSTER }, (_, i) => `agent-${i}@loadtest.trypennie.dev`);

type PassOutcome = { email: string; ok: true } | { email: string; ok: false; error: string; kind: string };

/**
 * Drive the real stub, in its own process because the percentage and the load test
 * flag are read at import, over PASSES passes. Every pass carries a NEW sync token and
 * a new clock, exactly as the deployed lane does, which is what broke the old key.
 */
function runStub(): { passes: PassOutcome[][]; problem: string | null } {
  const probe = `
    const { stubSyncEvents } = await import(${JSON.stringify(new URL("../src/lib/google/loadtest-stub.ts", import.meta.url).href)});
    const { reachabilityFromError } = await import(${JSON.stringify(new URL("../src/lib/google/reachability-classify.ts", import.meta.url).href)});
    const emails = ${JSON.stringify(emails)};
    const passes = [];
    const tokens = new Map();
    for (let p = 0; p < ${PASSES}; p++) {
      const now = ${T0} + p * ${PASS_GAP_MS};
      const window = {
        timeMinIso: new Date(now).toISOString(),
        timeMaxIso: new Date(now + 22 * 86400000).toISOString(),
      };
      const row = [];
      for (const email of emails) {
        try {
          const r = stubSyncEvents(email, tokens.get(email) ?? null, now, window);
          tokens.set(email, r.nextSyncToken);
          row.push({ email, ok: true });
        } catch (e) {
          row.push({ email, ok: false, error: String(e.message), kind: reachabilityFromError(e) });
        }
      }
      passes.push(row);
    }
    console.log(JSON.stringify(passes));
  `;
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/register-paths.mjs", "--input-type=module", "-e", probe],
    {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        SLATE_LOADTEST: "true",
        SLATE_LOADTEST_FAULT_PCT: String(FAULT_PCT),
        SLATE_LOADTEST_FAULT_TARGETS: "",
      },
    },
  );
  const line = (res.stdout || "").trim().split("\n").pop() ?? "";
  try {
    return { passes: JSON.parse(line) as PassOutcome[][], problem: null };
  } catch {
    return {
      passes: [],
      problem: `the stub probe produced no readable output (stdout: ${res.stdout?.slice(0, 300)} stderr: ${res.stderr?.slice(0, 600)})`,
    };
  }
}

const { passes, problem } = runStub();
assert(problem === null, problem ?? "the stub probe ran every pass");
eq(passes.length, PASSES, "the probe ran every pass");

const failingIn = (row: PassOutcome[]) => new Set(row.filter((o) => !o.ok).map((o) => o.email));

// --- the same calendars fail on every pass ------------------------------------------
{
  const first = failingIn(passes[0] ?? []);
  assert(first.size > 0, `some calendars fail at ${FAULT_PCT}% (measured ${first.size} of ${ROSTER})`);
  for (let p = 1; p < passes.length; p++) {
    const now = failingIn(passes[p]!);
    const same = now.size === first.size && [...now].every((e) => first.has(e));
    assert(
      same,
      `pass ${p + 1} fails exactly the calendars pass 1 failed ` +
        `(pass 1: ${first.size}, pass ${p + 1}: ${now.size}, shared: ${[...now].filter((e) => first.has(e)).length})`,
    );
  }
  // Roughly the configured share. Not exact: it is a hash over 94 real shaped keys, so
  // the check is that the share tracks the setting, within a band wide enough for that
  // sample and narrow enough that "every calendar" or "one calendar" cannot pass.
  const share = (first.size / ROSTER) * 100;
  assert(
    share >= 4 && share <= 18,
    `about ${FAULT_PCT}% of calendars fail (measured ${share.toFixed(1)}%)`,
  );
}

// --- every faulted calendar records a DEFINITIVE kind --------------------------------
{
  const kinds = new Set(passes.flat().filter((o) => !o.ok).map((o) => (o as { kind: string }).kind));
  assert(
    kinds.size === 1 && kinds.has("not-provisioned"),
    `a faulted sync read is classified not-provisioned by the real classifier (got: ${[...kinds].join(", ") || "none"})`,
  );
  assert(
    passes.flat().every((o) => o.ok || o.error.includes("loadtest fault")),
    "and every one is marked as injected",
  );
}

// --- the real paging predicate pages inside the window -------------------------------
/**
 * One pass of the sync lane's decision, built from the shipped pieces: the health
 * transition the lane writes, the route's consecutive pass streak, then
 * `loadFailingAgents`'s filter, dedup and blast radius hold. Returns the agents the
 * page would name, or [] when it stays quiet.
 */
function simulate(outcomes: PassOutcome[][]): { pageAtPass: number | null; named: number } {
  const health = new Map<string, CalSyncHealth>(
    emails.map((e) => [
      e,
      // Healthy going in: the steady leg synced every calendar before the fault leg.
      { consecutive_failures: 0, last_success_at: new Date(T0 - PASS_GAP_MS).toISOString(), last_sync_error: null, last_failure_kind: null },
    ]),
  );
  let routeStreak = 0;
  for (let p = 0; p < outcomes.length; p++) {
    const nowMs = T0 + p * PASS_GAP_MS;
    const nowIso = new Date(nowMs).toISOString();
    let anyFailed = false;
    for (const o of outcomes[p]!) {
      const prev = health.get(o.email)!;
      health.set(
        o.email,
        o.ok
          ? nextSyncState(prev, { ok: true }, nowIso)
          : nextSyncState(prev, { ok: false, error: o.error, kind: o.kind as FailureKind }, nowIso),
      );
      if (!o.ok) anyFailed = true;
    }
    // The route's rate_limit_hit streak: cleared by a clean pass, bumped by a failing one.
    routeStreak = anyFailed ? routeStreak + 1 : 0;
    if (!anyFailed || !isConsecutiveFailure(routeStreak)) continue;
    const rows: FailingCalendarRow[] = [...health.entries()]
      .filter(([, h]) => isPageableFailure(h.last_failure_kind, h.consecutive_failures, SYNC_PAGING))
      .map(([email, h]) => ({
        consecutive_failures: h.consecutive_failures,
        last_success_at: h.last_success_at,
        last_sync_error: h.last_sync_error,
        last_failure_kind: h.last_failure_kind,
        email,
        bookable: true,
        deactivated_at: null,
      }));
    const failing = applyBlastRadiusHold(dedupeFailingAgents(rows), nowMs, SYNC_PAGING);
    if (failing.length > 0) return { pageAtPass: p + 1, named: failing.length };
  }
  return { pageAtPass: null, named: 0 };
}

{
  const { pageAtPass, named } = simulate(passes);
  assert(pageAtPass !== null, `the sync_failures page fires within ${PASSES} passes of the stub's outcomes`);
  // The first faulted pass can land up to one gap after the window opens, so the page
  // must fire by the pass that still sits inside the window measured from THAT start.
  const latestPass = Math.floor((FAULT_WINDOW_MS - PASS_GAP_MS) / PASS_GAP_MS) + 1;
  assert(
    pageAtPass !== null && pageAtPass <= latestPass,
    `and it fires by pass ${latestPass}, inside a ${FAULT_WINDOW_MS / 60_000} minute window ` +
      `however the first pass falls (fired at pass ${pageAtPass})`,
  );
  eq(named, failingIn(passes[0] ?? []).size, "naming every faulted agent");
}

// --- why the kind has to be definitive: a transient streak cannot fit ----------------
{
  // The control the choice above rests on. The same failing set, recorded TRANSIENT as
  // the stub used to record every fault, must not page by the window's last safe pass:
  // TRANSIENT_PAGE_AT is four consecutive passes, which at a 90 second gap is 270
  // seconds after the first failure, and the first failure itself can arrive up to 90
  // seconds into a 300 second window. If this ever starts paging in time, the paging
  // rule changed and the kind the stub draws should be revisited, not the rule.
  const asTransient = passes.map((row) =>
    row.map((o) => (o.ok ? o : { ...o, kind: "transient" })),
  );
  const { pageAtPass } = simulate(asTransient);
  const latestPass = Math.floor((FAULT_WINDOW_MS - PASS_GAP_MS) / PASS_GAP_MS) + 1;
  assert(
    pageAtPass === null || pageAtPass > latestPass,
    `a transient streak cannot page inside the window (would fire at pass ${pageAtPass}, latest safe pass ${latestPass})`,
  );
  // And the same rows really are a page eventually, so the control is not passing
  // because the simulation pages nothing at all (L1).
  const longer = simulate([...asTransient, ...asTransient]);
  assert(longer.pageAtPass !== null, "while a longer transient run does page, so the simulation can say yes");
}

finish();
