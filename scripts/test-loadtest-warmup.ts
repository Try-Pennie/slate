// The warm up ladder the load run's preflight climbs before it books anything (#2347).
//
// WHY IT EXISTS. Run 34974744173 failed preflight 40 seconds after the load test
// Worker was created, with "bucket 112 is offering no times". Nothing was wrong
// with the branch or the roster: a Worker that has just been created is not yet
// being delivered its crons, and the calendars the seed wrote have never been
// hydrated, so every bucket answers `emptyBecause: {kind: "busy"}`. Two minutes
// later the same deployment offered 42 times. The cost was the whole environment,
// because teardown runs `if: always()`.
//
// The ladder is driven here with no deployment, no database and no real waiting:
// every reading and every elapsed time is passed in (the test speed rules).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-warmup.ts
import {
  warmupStep,
  hydrationPerDrive,
  WARMUP_CRON_DELIVERY_DEADLINE_MS,
  WARMUP_CRON_FRESH_MS,
  WARMUP_HYDRATION_STALL_DRIVES,
  WARMUP_RECOMPUTE_DRIVES,
  type WarmupReading,
  type WarmupProgress,
} from "./loadtest/preflight-checks.ts";
import { hydrationBatchSize, HYDRATION_ONBOARDING_MAX } from "../src/lib/google/hydration.ts";
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";

/** A branch that is entirely warm: every gate satisfied, times on offer. */
const WARM: WarmupReading = {
  laneStampAgeMs: 30_000,
  bookableAgents: 93,
  agentsMissingCalendarRow: 0,
  agentsFullyHydrated: 93,
  offeredSlots: 42,
  emptyBecause: null,
};

/** Nothing driven yet, no time elapsed. */
const START: WarmupProgress = {
  elapsedMs: 0,
  cronConfirmed: false,
  hydrationDrives: 0,
  drivesSinceHydrationProgress: 0,
  recomputeDrives: 0,
};

const reasons: string[] = [];
function giveUpWhy(r: WarmupReading, p: WarmupProgress, label: string): string {
  const step = warmupStep(r, p);
  eq(step.action, "give-up", label);
  const why = step.action === "give-up" ? step.why : "";
  reasons.push(why);
  return why;
}

// --- a warm branch is ready, or this ladder would stop every run there is ------

{
  const step = warmupStep(WARM, { ...START, cronConfirmed: true, elapsedMs: 74_000 });
  eq(step.action, "ready", "a branch whose crons tick, whose calendars are hydrated and which is offering times is ready");
  assert(
    step.action === "ready" && /74\s*s/.test(step.why),
    "and the ready line says how long the warm up took, so the run records it",
  );
}

// --- the states waiting can never fix are refused, each on its own reason ------

{
  // A branch with no bookable agents is not a cold cache: the seed did not run, or
  // ran against another project. Polling for ten minutes would end in the same
  // place having told nobody why (L11).
  const why = giveUpWhy(
    { ...WARM, bookableAgents: 0, agentsFullyHydrated: 0, offeredSlots: 0 },
    START,
    "a branch with no bookable agents gives up rather than waiting",
  );
  assert(/seed/i.test(why), "and says the seed is what is missing");
  assert(!/hydrat/i.test(why), "not that hydration is behind, which it is not");
}

{
  // Hydration can only ever cover a calendar that EXISTS. An agent with no
  // `agent_calendars` row is an incomplete seed, and a ladder that waited for it
  // would spend its whole deadline driving a lane that has nothing to do.
  const why = giveUpWhy(
    { ...WARM, agentsMissingCalendarRow: 4, agentsFullyHydrated: 89, offeredSlots: 0 },
    START,
    "a bookable agent with no calendar row gives up rather than waiting",
  );
  assert(/4\b/.test(why) && /93/.test(why), "naming how many of how many");
}

// --- stage zero: the crons are actually being delivered ------------------------

{
  // Measured on 2026-09-15: a freshly created Worker took about six minutes to
  // receive its first scheduled invocation, and the one before it never received
  // one in seventeen. The run's freshness and outbox bars are about lanes that
  // have to be live, so this is a gate rather than an observation.
  const cold: WarmupReading = { ...WARM, laneStampAgeMs: null, agentsFullyHydrated: 0, offeredSlots: 0 };
  const step = warmupStep(cold, START);
  eq(step.action, "wait-for-cron", "a lane that has never stamped waits for the first scheduled tick");
  assert(step.action === "wait-for-cron" && step.waitMs > 0, "with a wait to serve");

  // A stamp OLDER than the freshness bound is the same state: something ticked
  // once and stopped, and a run dispatched onto it measures dead lanes.
  eq(
    warmupStep({ ...cold, laneStampAgeMs: WARMUP_CRON_FRESH_MS + 1 }, START).action,
    "wait-for-cron",
    "and so does a stamp older than the freshness bound",
  );
  // The other direction, or the gate could simply be returning wait (L1).
  assert(
    warmupStep({ ...cold, laneStampAgeMs: WARMUP_CRON_FRESH_MS - 1 }, START).action !== "wait-for-cron",
    "a stamp inside the bound passes the gate",
  );
}

{
  // Measured on 2026-10-04 (#3229): Cloudflare listed all 13 schedules at deploy
  // time (17:41 UTC) and the first lane stamp landed at 18:07 UTC, 27 minutes
  // later, on a deployment that was healthy (the re-dispatch found every lane
  // ticking). Run 37221540890 refused at 12 minutes and measured nothing. A cold
  // Worker still silent at 27 minutes must be waited for, not given up on.
  const cold: WarmupReading = { ...WARM, laneStampAgeMs: null, agentsFullyHydrated: 0, offeredSlots: 0 };
  const measuredFirstTickMs = 27 * 60_000;
  eq(
    warmupStep(cold, { ...START, elapsedMs: measuredFirstTickMs }).action,
    "wait-for-cron",
    "a Worker with no stamp at the measured 27 minute delivery is still waited for",
  );
  // Headroom over the one slow reading, not a deadline that just clears it: the
  // delay is evidently not a fixed number, so the bound sits well past it.
  assert(
    WARMUP_CRON_DELIVERY_DEADLINE_MS >= measuredFirstTickMs * 1.5,
    "the delivery deadline leaves at least half again the measured 27 minutes",
  );
  // And the wait stays bounded (L110): an hour is the ceiling, because the job
  // holding it has a timeout of its own and a run waiting longer is a dead Worker.
  assert(WARMUP_CRON_DELIVERY_DEADLINE_MS <= 60 * 60_000, "the delivery deadline is still bounded");
}

{
  // The preflight job's own timeout must outlast the delivery deadline plus the
  // rest of its work (install, the hydration and recompute drives, one booking),
  // or GitHub kills the job mid wait and the reader gets a cancellation instead of
  // the give up wording that says the deployment is still standing (L11).
  const yml = readFileSync(new URL("../.github/workflows/loadtest.yml", import.meta.url), "utf8");
  // The block ends at the next line indented exactly two spaces that starts a key
  // of ANY spelling (underscores, digits, quotes), or at the end of the file. A
  // narrower boundary would run on into the next job, and a preflight with no
  // timeout of its own would then be answered by that job's.
  const match = /^ {2}preflight:[^\n]*\n([\s\S]*?)(?=^ {2}[^\s#][^\n]*:|(?![\s\S]))/m.exec(yml);
  assert(match !== null, "the workflow has a preflight job this can find");
  const job = match?.[1] ?? "";
  // Job level keys sit at four spaces; a step's own timeout sits deeper and must
  // not answer for the job.
  const own = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(job);
  assert(own !== null, "the preflight job declares a timeout-minutes of its own");
  const minutes = Number(own?.[1] ?? NaN);
  assert(Number.isFinite(minutes), "and it is a number");
  const deadlineMinutes = WARMUP_CRON_DELIVERY_DEADLINE_MS / 60_000;
  assert(
    minutes >= deadlineMinutes + 10,
    `the preflight job's ${minutes} minute timeout leaves at least ten minutes past the ${deadlineMinutes} minute delivery deadline`,
  );
}

{
  const why = giveUpWhy(
    { ...WARM, laneStampAgeMs: null, agentsFullyHydrated: 0, offeredSlots: 0 },
    { ...START, elapsedMs: WARMUP_CRON_DELIVERY_DEADLINE_MS },
    "past the delivery deadline it gives up rather than waiting forever",
  );
  assert(
    why.includes(String(Math.round(WARMUP_CRON_DELIVERY_DEADLINE_MS / 60_000))),
    "naming the deadline it waited, so the reader knows this is not propagation",
  );
}

{
  // Once the gate has been passed the preflight starts driving lanes BY HAND, which
  // stamps heartbeats itself. So the gate must not re-open: a confirmed delivery
  // stays confirmed, and a stale reading after that is not evidence about crons.
  const step = warmupStep(
    { ...WARM, laneStampAgeMs: null, agentsFullyHydrated: 40, offeredSlots: 0 },
    { ...START, cronConfirmed: true },
  );
  eq(step.action, "hydrate", "a confirmed delivery is not re-judged on a later reading");
}

// --- stage one: every bookable agent's calendar is hydrated --------------------

{
  // "Offering at least one time" is the WEAKER condition and it is reached far too
  // early: bucket 112 offered 156 times with 24 of 93 calendars hydrated, so a run
  // dispatched there would load a roster a fraction of the shape it claims to test.
  const step = warmupStep(
    { ...WARM, agentsFullyHydrated: 24, offeredSlots: 156 },
    { ...START, cronConfirmed: true },
  );
  eq(step.action, "hydrate", "times on offer do NOT end the wait while calendars are still unhydrated");
}

{
  const step = warmupStep(
    { ...WARM, agentsFullyHydrated: 24, offeredSlots: 0 },
    { ...START, cronConfirmed: true, hydrationDrives: 2 },
  );
  eq(step.action, "hydrate", "a partly hydrated roster drives the hydration lane again");
}

{
  // Driving a lane that covers nothing more is not a wait, it is a fault: a stubbed
  // Google that refuses, or a lock nothing releases. Reported as its own state so
  // nobody reads it as "the cache is still cold".
  const why = giveUpWhy(
    { ...WARM, agentsFullyHydrated: 24, offeredSlots: 0 },
    {
      ...START,
      cronConfirmed: true,
      hydrationDrives: 9,
      drivesSinceHydrationProgress: WARMUP_HYDRATION_STALL_DRIVES,
    },
    "hydration that stops making progress gives up",
  );
  assert(/24/.test(why) && /93/.test(why), "naming how far it got");
  assert(!/deadline/i.test(why), "on a reason of its own rather than borrowing the deadline wording");
}

{
  // One drive short of the stall bound still drives, or the bound would be off by
  // one and a healthy run would be refused on its last drive.
  eq(
    warmupStep(
      { ...WARM, agentsFullyHydrated: 24, offeredSlots: 0 },
      {
        ...START,
        cronConfirmed: true,
        hydrationDrives: 8,
        drivesSinceHydrationProgress: WARMUP_HYDRATION_STALL_DRIVES - 1,
      },
    ).action,
    "hydrate",
    "and one drive short of the stall bound it drives again",
  );
}

// --- stage two: the bucket is offering times ----------------------------------

{
  const step = warmupStep({ ...WARM, offeredSlots: 0, emptyBecause: "busy" }, { ...START, cronConfirmed: true });
  eq(step.action, "recompute", "a hydrated roster offering nothing drives the recompute lane");
}

{
  const why = giveUpWhy(
    { ...WARM, offeredSlots: 0, emptyBecause: "busy" },
    { ...START, cronConfirmed: true, recomputeDrives: WARMUP_RECOMPUTE_DRIVES },
    "a hydrated roster still offering nothing after its recompute budget gives up",
  );
  assert(/busy/.test(why), "naming the last emptyBecause the deployment gave");
  assert(
    /recompute/i.test(why) && why.includes(String(WARMUP_RECOMPUTE_DRIVES)),
    "and how many recomputes it drove, so this reads as a real finding rather than impatience",
  );
}

{
  // The empty reason a deployment gives may be absent; the give-up must still say
  // something a reader can act on rather than rendering a leaked null.
  const why = giveUpWhy(
    { ...WARM, offeredSlots: 0, emptyBecause: null },
    { ...START, cronConfirmed: true, recomputeDrives: WARMUP_RECOMPUTE_DRIVES },
    "and so does one that gave no reason at all",
  );
  assert(!/null|undefined/.test(why), "without rendering a leaked null");
}

// --- every refusal is its own message ------------------------------------------

{
  // Five ways to learn nothing, and one answering for another is how somebody
  // spends an afternoon on a cache that was never the problem (L11).
  eq(new Set(reasons).size, reasons.length, `all ${reasons.length} give-up reasons are distinct`);
  for (const why of reasons) assert(why.trim().length > 20, "and each says something");
}

// --- how much one hydration drive covers, from the app's own pacing ------------

{
  // Derived rather than written here a second time (L41): the preflight drives the
  // real lane, so the number of drives it budgets has to move when the lane's own
  // pacing moves.
  eq(
    hydrationPerDrive(93),
    hydrationBatchSize(93) + HYDRATION_ONBOARDING_MAX,
    "one drive covers the maintenance batch plus the onboarding allowance",
  );
  eq(hydrationPerDrive(93), 12, "which is 12 at the 93 calendar roster the run seeds");
  assert(hydrationPerDrive(200) >= hydrationPerDrive(93), "and never fewer on a larger roster");
}

finish();
