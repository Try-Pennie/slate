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

/**
 * `retired` is what the "cal.com retired" read answers (#2875): a stored value, or
 * `"unreadable"` for a refused read. The default is live, the parallel run.
 */
function fakeDb(reply: Reply, retired: boolean | "unreadable" = false) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: unknown) => ({
          maybeSingle: async () =>
            retired === "unreadable"
              ? { data: null, error: { message: "column calcom_retired does not exist" } }
              : { data: { calcom_retired: retired }, error: null },
        }),
      }),
    }),
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

// --- #2875: once cal.com is retired, no week is ever written FROM it -----------------
// Both importers (the daily sweep and the activation gate) write through here, so
// this is the one place the rule can live and cover them both, and a third writer
// added later is covered by construction (L593).
{
  const { db, calls } = fakeDb({ data: 5, error: null }, true);
  const err = await throws(writeImportedWeek(db, "u1", WEEK));
  assert(err !== null && /retired/i.test(err), `retired: the write is refused and says why (got ${err})`);
  eq(calls.length, 0, "retired: the schedule RPC is never called, so the Slate week is untouched");
}
{
  const { db, calls } = fakeDb({ data: 5, error: null }, "unreadable");
  const err = await throws(writeImportedWeek(db, "u1", WEEK));
  assert(err !== null && /could not read/i.test(err), `unreadable setting: refused, in its own words (got ${err})`);
  eq(calls.length, 0, "unreadable setting: nothing is written, because an overwrite is the one irreversible direction");
}
{
  const { db, calls } = fakeDb({ data: 5, error: null }, false);
  eq(await throws(writeImportedWeek(db, "u1", WEEK)), null, "live: the week is written, as today");
  eq(calls.length, 1, "live: one RPC");
}

finish();
