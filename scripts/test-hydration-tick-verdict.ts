// The refresh lane's own failure signal (#1544).
//
// THE HOLE THIS FILLS. `hydrateCalendar` records a per-calendar failure against the SYNC
// lane's health columns, the same ones the every-minute incremental sync writes. That sync
// runs constantly and succeeds, and every success resets the streak to zero, while the
// paging thresholds need 2 consecutive failures (4 for a transient). The rotation fails at
// most once per 15 minute tick, so the sync wipes the count within the next minute and the
// streak can NEVER reach the threshold.
//
// So a rotation failing on every single calendar raises nothing, and its heartbeat keeps
// stamping because that is written whether the work succeeded or not: from outside, a dead
// lane and a healthy one are identical. This is L53 exactly, and the same mistake #1150
// already fixed once by giving the watch lane its own columns.
//
// The tick-level verdict below is the half that needs no schema change. Per-calendar
// visibility, which needs its own columns, is #1545.
//
// Run: node --experimental-strip-types scripts/test-hydration-tick-verdict.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  hydrationTickVerdict,
  runHydrationTickCheck,
  formatHydrationFailingAlert,
  formatHydrationRecovery,
  HYDRATION_FAILING_KEY,
} from "@/lib/google/hydration";

// --- the three outcomes ------------------------------------------------------
{
  eq(
    hydrationTickVerdict({ due: 4, refreshed: 4, failed: 0 }),
    "healthy",
    "a tick that refreshed everything is healthy",
  );
  eq(
    hydrationTickVerdict({ due: 4, refreshed: 1, failed: 3 }),
    "healthy",
    "a tick that refreshed SOMETHING is healthy: the lane is working, and a single bad calendar is not this signal's job",
  );
  eq(
    hydrationTickVerdict({ due: 4, refreshed: 0, failed: 4 }),
    "all-failed",
    "a tick that attempted calendars and refreshed NONE is the failure this exists to catch",
  );
}

{
  // Nothing attempted is not success and not failure. It happens legitimately when every
  // calendar in the rotation is held back by the shared eligibility gate, and scoring it
  // either way is wrong: as healthy it would CLEAR a real page (#1134, #1152), as failure it
  // would page about a lane with nothing to do.
  eq(
    hydrationTickVerdict({ due: 0, refreshed: 0, failed: 0 }),
    "unmeasured",
    "a tick with nothing due measured nothing",
  );
}

{
  // The degenerate shape a bug could produce: counts that do not add up. Treated as
  // unmeasured rather than trusted, because a verdict computed from numbers that contradict
  // each other is not a measurement.
  eq(
    hydrationTickVerdict({ due: 2, refreshed: 5, failed: 0 }),
    "unmeasured",
    "counts that exceed what was due are not trusted as a verdict",
  );
  eq(
    hydrationTickVerdict({ due: -1, refreshed: 0, failed: 0 }),
    "unmeasured",
    "a negative count is not trusted as a verdict",
  );
}

// --- the copy -----------------------------------------------------------------
{
  const text = formatHydrationFailingAlert({ due: 6, consecutiveTicks: 4 });
  assert(text.length > 0, "the alert renders");
  assert(!text.startsWith("Slate"), "and does not open with the word Slate");
  // Escapes, so this file holds no literal dash: the pre-push style gate cannot tell the
  // line BANNING the character from a line using it.
  assert(!/[\u2014\u2013]/.test(text), "and carries no dash punctuation");
  assert(
    !/undefined|NaN|\[object Object\]/.test(text),
    "and leaks no placeholder",
  );
  // It must say what is NOT broken, or the reader assumes bookings are failing and treats a
  // slow-burning maintenance problem as an outage.
  assert(
    /availability|booking|customer|lead/i.test(text),
    "and says what this does and does not affect for customers",
  );
  // And name an action. "The refresh lane is failing" with no next step leaves the reader
  // exactly where they were (L111).
  assert(
    /log|check|delegation|Google/i.test(text),
    "and names somewhere to look",
  );

  const recovery = formatHydrationRecovery();
  assert(recovery.length > 0, "the all-clear renders");
  assert(recovery !== text, "and reads differently from the alert");
  assert(!/[\u2014\u2013]/.test(recovery), "with no dash punctuation either");
}

{
  // The singular case has to read properly too: with today's roster the batch is 2, so a
  // one-calendar tick is reachable and "1 calendars" would ship.
  const one = formatHydrationFailingAlert({ due: 1, consecutiveTicks: 4 });
  assert(!/\b1 calendars\b/.test(one), "the singular case is not written as a plural");
}

{
  eq(HYDRATION_FAILING_KEY.length > 0, true, "the alert key is defined");
}

// --- the step, driven through its real send paths -----------------------------
function stub(tick: { due: number; refreshed: number; failed: number }, overThreshold = true) {
  const notified: string[] = [];
  const resolved: string[] = [];
  const cleared: string[] = [];
  return {
    notified,
    resolved,
    cleared,
    deps: {
      tick,
      recordStreak: async () => overThreshold,
      clearStreak: async () => {
        cleared.push("cleared");
      },
      notify: async (key: string, _ms: number, text: string) => {
        notified.push(`${key}|${text}`);
      },
      resolve: async (key: string, text: string) => {
        resolved.push(`${key}|${text}`);
      },
      cooldownMs: 6 * 60 * 60_000,
      consecutiveTicks: 4,
    },
  };
}

{
  const { deps, notified, resolved } = stub({ due: 4, refreshed: 0, failed: 4 });
  eq(await runHydrationTickCheck(deps), "all-failed", "an all-failed tick reports as such");
  eq(notified.length, 1, "and pages once the streak is over its threshold");
  assert(notified[0]!.startsWith(`${HYDRATION_FAILING_KEY}|`), "on the condition's own key");
  eq(resolved.length, 0, "and clears nothing");
}

{
  // Below the streak threshold it stays quiet: today's batch is 2, so a batch of genuinely
  // revoked calendars is an ordinary event and paging on one tick would be the alert nobody
  // reads (L36).
  const { deps, notified, resolved } = stub({ due: 2, refreshed: 0, failed: 2 }, false);
  await runHydrationTickCheck(deps);
  eq(notified.length, 0, "a first all-failed tick does not page on its own");
  eq(resolved.length, 0, "and still clears nothing");
}

{
  const { deps, notified, resolved, cleared } = stub({ due: 4, refreshed: 4, failed: 0 });
  eq(await runHydrationTickCheck(deps), "healthy", "a healthy tick reports as such");
  eq(notified.length, 0, "pages nobody");
  eq(resolved.length, 1, "and CLEARS, which is what makes this a condition rather than a page that never ends");
  eq(cleared.length, 1, "resetting the streak so the next failure starts from zero");
}

{
  // The silent path this file is named as the proof for. A tick that measured nothing must
  // not announce a recovery, or a lane with nothing to do would clear a real page
  // (#1134, #1152).
  const { deps, notified, resolved } = stub({ due: 0, refreshed: 0, failed: 0 });
  eq(await runHydrationTickCheck(deps), "unmeasured", "a tick with nothing due is unmeasured");
  eq(resolved.length, 0, "an unmeasured tick CLEARS NOTHING");
  eq(notified.length, 0, "and pages nobody");
}

{
  // Same for counts that contradict each other: not a measurement, so not a verdict.
  const { deps, notified, resolved } = stub({ due: 2, refreshed: 5, failed: 0 });
  await runHydrationTickCheck(deps);
  eq(resolved.length, 0, "impossible counts clear nothing");
  eq(notified.length, 0, "and page nobody");
}

{
  // Neither send may break the lane: a Slack outage must not stop the refresh itself.
  let threw = false;
  try {
    await runHydrationTickCheck({
      tick: { due: 3, refreshed: 0, failed: 3 },
      recordStreak: async () => true,
      clearStreak: async () => {},
      notify: async () => {
        throw new Error("slack down");
      },
      resolve: async () => {},
      cooldownMs: 1,
      consecutiveTicks: 4,
    });
    await runHydrationTickCheck({
      tick: { due: 3, refreshed: 3, failed: 0 },
      recordStreak: async () => true,
      clearStreak: async () => {
        throw new Error("streak store down");
      },
      notify: async () => {},
      resolve: async () => {
        throw new Error("slack down");
      },
      cooldownMs: 1,
      consecutiveTicks: 4,
    });
  } catch {
    threw = true;
  }
  assert(!threw, "a failing alert store never throws out of the tick");
}

finish();
