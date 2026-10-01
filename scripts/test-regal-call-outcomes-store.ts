// The stored side of the call outcome check counts the same population the received
// side does (#2950): human calls only. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-regal-call-outcomes-store.ts
//
// The check's own suite injects the written count as a bare number, so it cannot see
// whether the real query filters out AI calls and calls with nobody on them. This
// drives the real query builder against a fake that records every filter it is given.

import { countHumanOutcomesSince } from "@/lib/monitor/regal-call-outcomes-store";
import { assert, eq, finish } from "./lib/harness.ts";

type Call = { method: string; args: unknown[] };

function fakeDb(result: { count: number | null; error: { message: string } | null }) {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "gte", "eq", "not"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  const db = {
    from: (table: string) => {
      calls.push({ method: "from", args: [table] });
      return chain;
    },
  };
  return { db, calls };
}

const SINCE = "2026-10-01T17:12:26.170Z";

{
  const { db, calls } = fakeDb({ count: 32, error: null });
  const n = await countHumanOutcomesSince(db, SINCE);
  eq(n, 32, "returns the server side count");
  const has = (method: string, ...args: unknown[]) =>
    calls.some((c) => c.method === method && JSON.stringify(c.args) === JSON.stringify(args));
  assert(has("from", "regal_call_outcomes"), "reads regal_call_outcomes");
  assert(has("gte", "received_at", SINCE), "windows on received_at from the given instant");
  assert(has("eq", "is_ai_agent", false), "leaves out AI calls, which the received side does not count");
  assert(has("not", "agent_email", "is", null), "leaves out calls with nobody on them, which the received side does not count");
  const select = calls.find((c) => c.method === "select");
  assert(
    select !== undefined && JSON.stringify(select.args[1]) === JSON.stringify({ count: "exact", head: true }),
    "a head count, so no rows come back and the 1,000 row cap cannot shorten it",
  );
}
{
  const { db } = fakeDb({ count: null, error: { message: "boom" } });
  let threw = false;
  try {
    await countHumanOutcomesSince(db, SINCE);
  } catch (err) {
    threw = err instanceof Error && err.message.includes("boom");
  }
  assert(threw, "a failed count throws with the database's reason, never reads as zero");
}

finish();
