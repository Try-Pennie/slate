// The handoff table's reads, against a fake that refuses an unknown column the way
// PostgREST does (#2369 follow-up to #2367).
//
// `loadHandoffBookings` shipped selecting `is_test` FROM `bookings`, and `bookings`
// has no such column: migration 0051 put it on `users` and `buckets` only. PostgREST
// answers that with 42703 at runtime, the read is `unwrap`ped, so the #2367 delivery
// step would have thrown on every tick that had a row to post, and nothing in the
// repo said a word. Nothing caught it because the column list is a STRING and the
// hand written schema is not compiled against it.
//
// So the fake here does not hold its own idea of the tables. It takes the columns
// from `src/lib/db/schema.ts` plus `src/lib/db/types.ts`, the same parse the repo
// guard uses, and refuses anything they do not declare. A fake that agreed with the
// code's assumption by construction would have passed on the broken read (L52).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-handoff-store.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { tableTypeMap, interfaceFields, withoutEmbeddedGroups } from "./lib/scan-db-columns.ts";
import { loadHandoffBookings } from "@/lib/handoffs/store";

const ROOT = join(import.meta.dirname, "..");

/**
 * Table to its declared columns, from the SAME parse `scripts/test-db-column-names.ts`
 * judges the tree with. One idea of what the tables hold, not two.
 */
const COLUMNS = (() => {
  const tables = tableTypeMap(readFileSync(join(ROOT, "src", "lib", "db", "schema.ts"), "utf8"));
  const fields = interfaceFields(readFileSync(join(ROOT, "src", "lib", "db", "types.ts"), "utf8"));
  const out = new Map<string, Set<string>>();
  for (const [table, type] of tables) {
    const cols = fields.get(type);
    if (cols) out.set(table, cols);
  }
  return out;
})();

/** The columns a select argument asks for, embedded groups dropped. */
const selectedColumns = (arg: string): string[] =>
  withoutEmbeddedGroups(arg)
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c !== "*");

// The parse itself has to have worked, or every refusal below would be vacuous (L98).
assert(COLUMNS.size > 20, `read the hand written schema (${COLUMNS.size} tables)`);
assert(COLUMNS.get("bookings")!.has("bucket_id"), "bookings declares bucket_id");
assert(!COLUMNS.get("bookings")!.has("is_test"), "bookings declares NO is_test column");
assert(COLUMNS.get("buckets")!.has("is_test"), "buckets is where is_test lives");

interface Row {
  [k: string]: unknown;
}

interface Recorded {
  table: string;
  columns: string[];
  ids: string[] | null;
}

/**
 * A fake PostgREST. It records what was asked for, refuses a column the schema does
 * not declare (code 42703, as the real one does), and otherwise answers the rows it
 * holds, projected to the columns asked for.
 */
function fakeDb(tables: Record<string, Row[]>, opts: { failTable?: string } = {}) {
  const calls: Recorded[] = [];
  const builder = (table: string) => {
    const state: Recorded = { table, columns: [], ids: null };
    const result = () => {
      if (opts.failTable === table) {
        return { data: null, error: { code: "08006", message: `connection to ${table} failed` } };
      }
      const declared = COLUMNS.get(table);
      if (declared) {
        const missing = state.columns.find((c) => !declared.has(c));
        if (missing) {
          // What PostgREST really answers, which is what shipped unnoticed.
          return {
            data: null,
            error: {
              code: "42703",
              message: `column ${table}.${missing} does not exist`,
            },
          };
        }
      }
      const rows = (tables[table] ?? []).filter(
        (r) => state.ids === null || state.ids.includes(String(r.id)),
      );
      const projected = rows.map((r) => {
        const out: Row = {};
        for (const c of state.columns) out[c] = r[c];
        return out;
      });
      return { data: projected, error: null };
    };
    const chain = {
      select(arg: string) {
        state.columns = selectedColumns(arg);
        return chain;
      },
      in(_col: string, ids: string[]) {
        state.ids = ids;
        return chain;
      },
      eq(_col: string, value: string) {
        state.ids = [value];
        return chain;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        calls.push(state);
        return Promise.resolve(result()).then(resolve, reject);
      },
    };
    return chain;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: builder } as any, calls };
}

const booking = (over: Row = {}): Row => ({
  id: "bk-1",
  bucket_id: "bucket-real",
  status: "confirmed",
  starts_at: "2026-09-20T15:00:00.000Z",
  timezone: "America/New_York",
  assigned_user_id: "agent-1",
  agent_name: "Ada",
  agent_email: "ada@trypennie.com",
  attendee_name: "Lead",
  ...over,
});

const BUCKETS = [
  { id: "bucket-real", is_test: false },
  { id: "bucket-smoke", is_test: true },
];

// --- the read the shipped code could not make --------------------------------

{
  const { db, calls } = fakeDb({ bookings: [booking()], buckets: BUCKETS });
  const rows = await loadHandoffBookings(db, ["bk-1"]);
  eq(rows.length, 1, "one booking comes back");
  eq(rows[0].isTest, false, "a booking on a real bucket is a real lead");
  assert(
    calls.every((c) => c.table !== "bookings" || !c.columns.includes("is_test")),
    "the bookings read never asks for a column that table does not have",
  );
  assert(
    calls.some((c) => c.table === "buckets" && c.columns.includes("is_test")),
    "the test flag is read from the bucket, which is where it lives",
  );
}
{
  const { db } = fakeDb(
    { bookings: [booking({ id: "bk-smoke", bucket_id: "bucket-smoke" })], buckets: BUCKETS },
    {},
  );
  const rows = await loadHandoffBookings(db, ["bk-smoke"]);
  eq(rows[0].isTest, true, "a booking on a test bucket is the canary's, so it can be suppressed");
}
{
  // Both at once: the mapping is per booking, not one answer for the batch.
  const { db } = fakeDb(
    {
      bookings: [booking({ id: "bk-real" }), booking({ id: "bk-smoke", bucket_id: "bucket-smoke" })],
      buckets: BUCKETS,
    },
    {},
  );
  const rows = await loadHandoffBookings(db, ["bk-real", "bk-smoke"]);
  const byId = new Map(rows.map((r) => [r.id, r.isTest]));
  eq(byId.get("bk-real"), false, "the real one is real");
  eq(byId.get("bk-smoke"), true, "and the canary's is the canary's, in the same read");
}

// --- a bucket that does not come back ----------------------------------------
//
// It cannot happen while `bookings.bucket_id` is NOT NULL with its foreign key, and
// it is still given a value rather than a guess, because the two guesses are the two
// ways this can be wrong: `false` announces a canary booking in the sales channel,
// and `true` SUPPRESSES a real lead's handoff, which #2370 also holds out of the
// waiting count, so nothing would ever page about it.

{
  const { db } = fakeDb({ bookings: [booking({ bucket_id: "bucket-gone" })], buckets: BUCKETS });
  const rows = await loadHandoffBookings(db, ["bk-1"]);
  eq(
    rows[0].isTest,
    null,
    "a booking whose bucket did not come back reports an UNKNOWN flag, never a guess",
  );
}

// --- a read that FAILED --------------------------------------------------------

{
  const { db } = fakeDb({ bookings: [booking()], buckets: BUCKETS }, { failTable: "bookings" });
  let threw = false;
  try {
    await loadHandoffBookings(db, ["bk-1"]);
  } catch {
    threw = true;
  }
  assert(threw, "a failed bookings read throws, so the tick resolves and posts nothing");
}
{
  const { db } = fakeDb({ bookings: [booking()], buckets: BUCKETS }, { failTable: "buckets" });
  let threw = false;
  try {
    await loadHandoffBookings(db, ["bk-1"]);
  } catch {
    threw = true;
  }
  assert(
    threw,
    "a failed BUCKETS read throws too: every booking reading as unknown would post the canary's handoffs",
  );
}
{
  const { db } = fakeDb({ bookings: [], buckets: BUCKETS });
  const rows = await loadHandoffBookings(db, ["bk-1"]);
  eq(rows.length, 0, "no bookings is an empty answer, not a failure");
}
{
  const { db, calls } = fakeDb({ bookings: [], buckets: BUCKETS });
  const rows = await loadHandoffBookings(db, []);
  eq(rows.length, 0, "no ids reads nothing");
  eq(calls.filter((c) => c.table === "buckets").length, 0, "and asks the buckets table nothing");
}

finish();
