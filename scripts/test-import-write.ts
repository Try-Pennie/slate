// The one write both cal.com importers use (#2627). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-import-write.ts
//
// The daily importer and the activation gate both write an imported week through
// `writeImportedWeek`. It replaced the importer's old two statement write (rules,
// then the zone) whose gap left new hours read in the old zone when a run died
// between them, so what is pinned here is that it is ONE call carrying both, stamped
// `calcom-import`, and that nothing short of the exact count it asked for reads as
// a save (L12): a refusal, a short count and an unreadable count all throw.
import {
  writeImportedWeek,
  stampImportedSource,
  HoursChangedDuringImportError,
  HOURS_CHANGED_SQLSTATE,
} from "@/lib/calcom/import-write";
import { assert, eq, finish } from "./lib/harness.ts";

type Reply = { data: unknown; error: { message: string; code?: string } | null };

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

// --- #2702: the activation import names the source it read, and the write checks it ---
// The guard lives in the database (migration 0157): the call carries the source the
// caller judged, and `replace_user_schedule` refuses inside the same transaction when
// the row no longer holds it. So the call must carry it, null included, because a
// row written before the stamp existed is judged as unstamped and must still be.
{
  const { db, calls } = fakeDb({ data: 5, error: null });
  eq(await throws(writeImportedWeek(db, "u1", WEEK, { onlyIfSource: "seed" })), null, "a guarded write that lands is a save");
  eq(calls[0].args.p_only_if_source, "seed", "the guarded write carries the source the caller read");
}
{
  const { db, calls } = fakeDb({ data: 5, error: null });
  await throws(writeImportedWeek(db, "u1", WEEK, { onlyIfSource: null }));
  assert("p_only_if_source" in calls[0].args && calls[0].args.p_only_if_source === null,
    "an unstamped row is guarded as null, never dropped to the unguarded call");
}
{
  const { db, calls } = fakeDb({ data: 5, error: null });
  await throws(writeImportedWeek(db, "u1", WEEK));
  assert(!("p_only_if_source" in calls[0].args),
    "the daily importer's call stays unguarded (Dan's rule: it overwrites an admin edit), so it reaches the five argument form");
}
{
  const { db } = fakeDb({
    data: null,
    error: { message: "hours for user u1 changed during the import", code: HOURS_CHANGED_SQLSTATE },
  });
  let caught: unknown = null;
  try {
    await writeImportedWeek(db, "u1", WEEK, { onlyIfSource: "seed" });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof HoursChangedDuringImportError,
    `the database's changed source refusal is its own error, so the caller can tell it from a failed write (got ${String(caught)})`);
}
{
  // Control: any other refusal is NOT that error.
  const { db } = fakeDb({ data: null, error: { message: "permission denied", code: "42501" } });
  let caught: unknown = null;
  try {
    await writeImportedWeek(db, "u1", WEEK, { onlyIfSource: "seed" });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error && !(caught instanceof HoursChangedDuringImportError),
    "a refusal for any other reason stays an ordinary failure");
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

// --- stampImportedSource: the "Set by" stamp on a week that already matches --------
// Sets ONLY hours_source and hours_set_at, ONLY where the source is still null, and
// never touches the rules or the zone. A stateful fake, so running it twice shows
// the second run finding the source set and writing nothing.
type Row = { id: string; timezone: string; hours_source: string | null; hours_set_at: string | null };
function stampDb(
  row: Row,
  opts: { retired?: boolean | "unreadable"; fail?: string; unreadableRows?: boolean } = {},
) {
  const updates: { table: string; patch: Record<string, unknown>; filters: string[] }[] = [];
  const rpcCalls: string[] = [];
  const db = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: unknown) => ({
          maybeSingle: async () =>
            opts.retired === "unreadable"
              ? { data: null, error: { message: "column calcom_retired does not exist" } }
              : { data: { calcom_retired: opts.retired ?? false }, error: null },
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        const filters: string[] = [];
        const rec = { table, patch, filters };
        updates.push(rec);
        const chain = {
          eq: (col: string, val: unknown) => {
            filters.push(`${col}=${String(val)}`);
            return chain;
          },
          is: (col: string, val: unknown) => {
            filters.push(`${col} is ${String(val)}`);
            return chain;
          },
          select: async (_cols: string) => {
            if (opts.fail) return { data: null, error: { message: opts.fail } };
            if (opts.unreadableRows) return { data: null, error: null };
            const matches =
              filters.includes(`id=${row.id}`) && filters.includes("hours_source is null") && row.hours_source === null;
            if (!matches) return { data: [], error: null };
            Object.assign(row, patch);
            return { data: [{ id: row.id }], error: null };
          },
        };
        return chain;
      },
    }),
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      return { data: null, error: null };
    },
  };
  return { db: db as never, updates, rpcCalls };
}

{
  const row: Row = { id: "s1", timezone: "America/Phoenix", hours_source: null, hours_set_at: null };
  const { db, updates, rpcCalls } = stampDb(row);
  const first = await stampImportedSource(db, "s1");
  eq(first, "stamped", "a null source is stamped");
  eq(row.hours_source, "calcom-import", "the source becomes calcom-import");
  assert(typeof row.hours_set_at === "string" && Number.isFinite(Date.parse(row.hours_set_at)),
    `hours_set_at is a real timestamp (got ${row.hours_set_at})`);
  eq(row.timezone, "America/Phoenix", "the zone is untouched");
  eq(updates.length, 1, "one update");
  eq(updates[0].table, "availability_schedules", "on the schedule row");
  eq(Object.keys(updates[0].patch).sort(), ["hours_set_at", "hours_source"],
    "it sets ONLY the two stamp columns, never the rules or the zone");
  assert(updates[0].filters.includes("hours_source is null"),
    "the write itself is conditional on a null source, so a concurrent writer's stamp is never overwritten");
  eq(rpcCalls.length, 0, "no rules RPC: the week's rules are not rewritten");

  const second = await stampImportedSource(db, "s1");
  eq(second, "already-set", "a second run finds the source set and stamps nothing");
  eq(row.hours_source, "calcom-import", "and the stamp is unchanged");
}
{
  const row: Row = { id: "s1", timezone: "UTC", hours_source: "agent", hours_set_at: "2026-09-20T00:00:00Z" };
  const { db } = stampDb(row);
  eq(await stampImportedSource(db, "s1"), "already-set", "a row an agent stamped is never restamped");
  eq(row.hours_source, "agent", "the agent's stamp stands");
  eq(row.hours_set_at, "2026-09-20T00:00:00Z", "and so does its time");
}
{
  const row: Row = { id: "s1", timezone: "UTC", hours_source: null, hours_set_at: null };
  const { db } = stampDb(row, { fail: "permission denied for table availability_schedules" });
  const err = await throws(stampImportedSource(db, "s1"));
  assert(err !== null && err.includes("permission denied"),
    `a refused stamp throws with the database's reason, so it counts as a failure, never a match (got ${err})`);
}
{
  const row: Row = { id: "s1", timezone: "UTC", hours_source: null, hours_set_at: null };
  const { db } = stampDb(row, { unreadableRows: true });
  const err = await throws(stampImportedSource(db, "s1"));
  assert(err !== null && err.includes("unreadable"),
    `a stamp whose result cannot be read back throws rather than claiming a save (got ${err})`);
}
{
  const row: Row = { id: "s1", timezone: "UTC", hours_source: null, hours_set_at: null };
  const { db, updates } = stampDb(row, { retired: true });
  const err = await throws(stampImportedSource(db, "s1"));
  assert(err !== null && /retired/i.test(err), `retired: the stamp is refused too (got ${err})`);
  eq(updates.length, 0, "retired: nothing is written");
  eq(row.hours_source, null, "retired: the source stays null");
}

finish();
