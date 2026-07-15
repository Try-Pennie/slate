// Batched per-agent last_synced_at write (#243): the sync cron used to fire one
// UPDATE per agent inside its loop; now it stamps every agent it processed this
// tick in a single write. stampLastSynced is dependency-free (the db client is
// passed in) so this is a real behavior test of the batching + guards.
// Run: node --experimental-strip-types scripts/test-sync-writes.ts
import { stampLastSynced } from "../src/lib/google/sync-writes.ts";
import { assert, finish } from "./lib/harness.ts";

interface Call {
  table: string;
  values: Record<string, unknown>;
  col: string;
  ids: string[];
}
function fakeDb() {
  const calls: Call[] = [];
  const db = {
    calls,
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            in(col: string, ids: string[]) {
              calls.push({ table, values, col, ids });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return db;
}

type DbArg = Parameters<typeof stampLastSynced>[0];

// Empty set: must NOT issue an `IN ()` write.
{
  const db = fakeDb();
  await stampLastSynced(db as unknown as DbArg, [], "2026-06-19T00:00:00Z");
  assert(db.calls.length === 0, "no write is issued when no agents were processed");
}

// Non-empty: ONE batched update to users, deduped, with the given timestamp.
{
  const db = fakeDb();
  await stampLastSynced(db as unknown as DbArg, ["a", "a", "b"], "2026-06-19T00:00:00Z");
  assert(db.calls.length === 1, "one batched update covers every processed agent");
  const c = db.calls[0];
  assert(c.table === "users", "writes to the users table");
  assert(c.col === "id", "matches the agents by id");
  assert(
    c.values.last_synced_at === "2026-06-19T00:00:00Z",
    "stamps the supplied timestamp",
  );
  assert(
    JSON.stringify([...c.ids].sort()) === JSON.stringify(["a", "b"]),
    "dedupes ids so each agent is stamped once",
  );
}

finish();
