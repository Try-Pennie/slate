// #1678: when the hourly Salesforce roster sync departs an advisor, their remaining calls
// are moved by the SAME offboarding coverage the lifecycle API runs (#1241), keyed on the
// row's own stored departure stamp, so a retry converges onto one sweep. A failure to
// enqueue never undoes or fails the departure: it is counted and logged, and the
// inactive agent monitor backstops it.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reap-coverage.ts
import { coverReapDepartures } from "../src/lib/salesforce/reap-coverage.ts";
import type { OffboardingSweepPlan } from "../src/lib/offboarding/coverage-trigger.ts";
import { assert, eq, finish } from "./lib/harness.ts";

async function run() {
  // Each departed row is covered under its own stored stamp, in order.
  {
    const seen: OffboardingSweepPlan[] = [];
    const counts = await coverReapDepartures(
      [
        { id: "u1", deactivatedAtIso: "2026-10-11T23:57:40.000Z" },
        { id: "u2", deactivatedAtIso: "2026-10-11T23:57:40.000Z" },
      ],
      async (plan) => {
        seen.push(plan);
        return plan.outUserId === "u1" ? "queued" : "none";
      },
    );
    eq(seen, [
      { outUserId: "u1", deactivatedAtIso: "2026-10-11T23:57:40.000Z" },
      { outUserId: "u2", deactivatedAtIso: "2026-10-11T23:57:40.000Z" },
    ], "every departed advisor is covered, keyed on their row's own departure stamp");
    eq(counts, { queued: 1, none: 1, failed: 0 }, "and what each one came to is counted");
  }

  // A row with no stamp left is not a departure (reactivated underneath the run), so
  // nothing is enqueued for it: an empty key would collide every advisor onto one sweep.
  {
    let calls = 0;
    const counts = await coverReapDepartures([{ id: "u1", deactivatedAtIso: "  " }], async () => {
      calls++;
      return "queued";
    });
    eq([calls, counts], [0, { queued: 0, none: 0, failed: 0 }], "a row with no departure stamp is never swept");
  }

  // Failure paths: a reported failure and a thrown one are both counted, and neither
  // stops the next advisor being covered.
  {
    const seen: string[] = [];
    const counts = await coverReapDepartures(
      [
        { id: "u1", deactivatedAtIso: "2026-10-11T23:57:40.000Z" },
        { id: "u2", deactivatedAtIso: "2026-10-11T23:57:40.000Z" },
        { id: "u3", deactivatedAtIso: "2026-10-11T23:57:40.000Z" },
      ],
      async (plan) => {
        seen.push(plan.outUserId);
        if (plan.outUserId === "u1") return "failed";
        if (plan.outUserId === "u2") throw new Error("bulk_reassign_jobs insert failed: connection reset");
        return "queued";
      },
    );
    eq(seen, ["u1", "u2", "u3"], "a failed cover never stops the next advisor's");
    eq(counts, { queued: 1, none: 0, failed: 2 }, "and a thrown failure is counted as failed, never as nothing to do");
  }

  // Nobody departed: nothing is asked.
  {
    let calls = 0;
    const counts = await coverReapDepartures([], async () => {
      calls++;
      return "queued";
    });
    assert(calls === 0 && counts.queued + counts.none + counts.failed === 0, "a run that departed nobody covers nobody");
  }
}

await run();
finish();
