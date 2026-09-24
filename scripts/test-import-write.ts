// The one write both cal.com importers use (#2627). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-import-write.ts
//
// The daily importer and the activation gate both write an imported week through
// `writeImportedWeek`. It replaced the importer's old two statement write (rules,
// then the zone) whose gap left new hours read in the old zone when a run died
// between them, so what is pinned here is that it is ONE call carrying both, stamped
// `calcom-import`, and that nothing short of the exact count it asked for reads as
// a save (L12): a refusal, a short count and an unreadable count all throw.
import { writeImportedWeek } from "@/lib/calcom/import-write";
import { assert, eq, finish } from "./lib/harness.ts";

type Reply = { data: unknown; error: { message: string } | null };

function fakeDb(reply: Reply) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return reply;
    },
  };
  return { db: db as never, calls };
}

const WEEK = {
  timezone: "America/Los_Angeles",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 420, end_minute: 960 })),
};

async function throws(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// --- the success path: ONE call carrying zone, rules, source and expected count ---
{
  const { db, calls } = fakeDb({ data: 5, error: null });
  const err = await throws(writeImportedWeek(db, "u1", WEEK));
  eq(err, null, "an exact count is a save");
  eq(calls.length, 1, "zone and rules go in ONE call, never two statements");
  eq(calls[0].fn, "replace_user_schedule", "through the transactional zone plus rules RPC (migration 0129)");
  eq(calls[0].args, {
    p_user_id: "u1",
    p_timezone: "America/Los_Angeles",
    p_rules: WEEK.rules,
    p_source: "calcom-import",
    p_expected: 5,
  }, "stamped calcom-import, with the count checked inside the transaction");
}

// --- every way the write can fail to be a save throws, and names which ---
{
  const { db } = fakeDb({ data: null, error: { message: "check_violation: empty rule set" } });
  const err = await throws(writeImportedWeek(db, "u1", WEEK));
  assert(err !== null && err.includes("refused") && err.includes("check_violation"),
    `a refused write throws and carries the database's reason (got ${err})`);
}
{
  const { db } = fakeDb({ data: 3, error: null });
  const err = await throws(writeImportedWeek(db, "u1", WEEK));
  assert(err !== null && err.includes("asked for 5") && err.includes("recorded 3"),
    `a short count throws rather than reading as a save (got ${err})`);
}
{
  const { db } = fakeDb({ data: "5", error: null });
  const err = await throws(writeImportedWeek(db, "u1", WEEK));
  assert(err !== null && err.includes("an unreadable count"),
    `a count that is not a number throws as unreadable, never as a match (got ${err})`);
}

finish();
