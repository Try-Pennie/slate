// The one off backfill that gives Regal its starting state (#2085).
//
// The helper sends a trait only when a write CHANGES the derived value, so on the
// day it ships Regal holds the trait for nobody, and would go on holding it for
// nobody until each agent happened to change state (L389). The backfill posts the
// current value for every user row and says how many it sent. Finding nobody to
// send is never a pass (L98): an empty roster read and a broken one look alike.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-bookable-trait-backfill.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  backfillExitCode,
  backfillSummary,
  runBookableTraitBackfill,
  BACKFILL_EXIT,
} from "./lib/bookable-trait-backfill.ts";
import type { RoutableStateRow, TraitEmission } from "../src/lib/bookable/routable-trait.ts";

function row(over: Partial<RoutableStateRow>): RoutableStateRow {
  return {
    id: "u",
    org_id: "org-1",
    email: "a@trypennie.com",
    bookable: false,
    deactivated_at: null,
    is_test: false,
    ...over,
  };
}

const ROSTER = [
  row({ id: "u1", email: "one@trypennie.com", bookable: true }),
  row({ id: "u2", email: "two@trypennie.com", bookable: false }),
  row({ id: "u3", email: "three@trypennie.com", bookable: true, deactivated_at: "2026-09-01T00:00:00.000Z" }),
  row({ id: "u4", email: "smoke@trypennie.com", bookable: true, is_test: true }),
];

{
  const sent: Array<{ e: TraitEmission; key: string | null }> = [];
  const report = await runBookableTraitBackfill({
    listUsers: async () => ROSTER,
    emit: async (e, key) => {
      sent.push({ e, key });
    },
  });
  eq(report.users, 4, "reads every user row");
  eq(sent.length, 4, "records one trait per user, current value, change or not");
  eq(
    sent.map((s) => `${s.e.userId}:${s.e.slateBookable}`).join(","),
    "u1:true,u2:false,u3:false,u4:true",
    "each is the DERIVED value: a departed row still carrying the flag is false",
  );
  eq(sent[3]?.e.suppressed, true, "a test agent is recorded suppressed, never POSTed");
  eq(report.recorded, 3, "counts the traits that will be sent");
  eq(report.suppressed, 1, "and the ones recorded but withheld, separately");
  eq(report.failed.length, 0, "nothing failed");
  // NO dedupe key, deliberately. The run is also the REPAIR the unrecorded trait
  // page names, so a second run must send again: a per user key would make it skip
  // everybody the first run reached, the page's remedy would do nothing, and nothing
  // would say so. A duplicate is harmless, because every send states the agent's
  // value at that send.
  assert(sent.every((s) => s.key === null), "carries no dedupe key, so running it again sends again");
  eq(backfillExitCode(report), BACKFILL_EXIT.ok, "a full run exits 0");
  const summary = backfillSummary(report);
  assert(/4 user/.test(summary) && /3 /.test(summary) && /1 /.test(summary), `the summary states the counts: ${summary}`);
}

{
  const report = await runBookableTraitBackfill({ listUsers: async () => [], emit: async () => {} });
  eq(report.users, 0, "an empty roster is read as zero users");
  eq(backfillExitCode(report), BACKFILL_EXIT.noUsers, "and finding nobody exits non zero, never a pass");
  assert(BACKFILL_EXIT.noUsers !== 0, "  on a code that is not zero");
}

{
  // A failed record for one agent is counted and named, the rest still go, and
  // the run exits on its own code.
  const report = await runBookableTraitBackfill({
    listUsers: async () => ROSTER,
    emit: async (e) => {
      if (e.userId === "u2") throw new Error("webhook delivery insert failed: timeout");
    },
  });
  eq(report.failed.map((f) => f.userId).join(","), "u2", "names the agent whose trait was not recorded");
  eq(report.recorded, 2, "the others are still recorded");
  eq(backfillExitCode(report), BACKFILL_EXIT.someFailed, "a partial run exits on its own code");
  assert(/timeout/.test(report.failed[0]?.error ?? ""), "carrying the failure's own reason");
}

{
  // A roster read that throws is not "nobody": it propagates for the runner to
  // report as unreadable.
  let threw = false;
  try {
    await runBookableTraitBackfill({
      listUsers: async () => {
        throw new Error("permission denied for table users");
      },
      emit: async () => {},
    });
  } catch (e) {
    threw = /permission denied/.test(String(e));
  }
  assert(threw, "an unreadable roster throws rather than reporting zero users");
}

{
  const codes = Object.values(BACKFILL_EXIT);
  eq(new Set(codes).size, codes.length, "every outcome has its own exit code");
}

finish();
