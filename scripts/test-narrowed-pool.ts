// The pool's own eligibility, narrowed to the one advisor the confirm line handed a
// confirm (#3489).
//
// A released confirm is handed an advisor off another confirm's read of the rung, and
// reads that rung again narrowed to that advisor before it books anybody. The named
// link shortcut (`namedAgentResolver`, #2073) cannot be that read: it answers the
// advisor whatever the pool is, which is right for an advisor's own link and wrong
// here, where a pool grouping up to a minute old can put two pools in one line. So
// the narrowing runs the bucket's REAL resolver and keeps the advisor only when that
// resolver does (the rule #3248's reroute already follows).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-narrowed-pool.ts
import { narrowedTo } from "../src/lib/availability/narrowed-pool.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

type Pool = { ids: string[]; fallbackApplied: boolean; lowIds?: string[] };
const pool = (p: Pool) => async (_bucket: string) => p;

async function main() {
  const real = pool({ ids: ["a", "b", "c"], fallbackApplied: false, lowIds: ["b"] });

  const inPool = await narrowedTo(real, "b")("120");
  assert(JSON.stringify(inPool.ids) === JSON.stringify(["b"]), `an advisor the pool holds is kept, alone (got ${JSON.stringify(inPool.ids)})`);
  assert(inPool.fallbackApplied === false && JSON.stringify(inPool.lowIds) === JSON.stringify(["b"]), "the pool's own facts travel with it");

  const outside = await narrowedTo(real, "z")("120");
  assert(outside.ids.length === 0, `an advisor the pool does not hold is nobody, never the advisor (got ${JSON.stringify(outside.ids)})`);

  // Narrowing composes AFTER whatever the inner resolver already removed: an advisor
  // the Low exclusion took out stays out.
  const lowExcluded = pool({ ids: ["a", "c"], fallbackApplied: false, lowIds: [] });
  const excluded = await narrowedTo(lowExcluded, "b")("120");
  assert(excluded.ids.length === 0, "an advisor the inner resolver removed is not put back");

  // The inner resolver's failure is the read's failure (L215): never an empty pool.
  const failing = async (_bucket: string): Promise<Pool> => {
    throw new Error("pool read failed");
  };
  let threw = "";
  try {
    await narrowedTo(failing, "a")("120");
  } catch (err) {
    threw = (err as Error).message;
  }
  assert(threw === "pool read failed", `a failed pool read throws through the narrowing (got ${JSON.stringify(threw)})`);

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
