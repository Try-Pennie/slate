// Unit test for the shared bounded-concurrency map helper (#224).
// Run: node --experimental-strip-types scripts/test-concurrency.ts
import { mapWithConcurrency } from "../src/lib/concurrency.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function run() {
  // Preserves input order even when later items resolve first.
  const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => n * 10);
  assert(JSON.stringify(out) === "[10,20,30]", "preserves input order in results");

  // Never runs more than `limit` tasks at once.
  let inFlight = 0;
  let maxInFlight = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return null;
  });
  assert(maxInFlight === 2, "caps simultaneous tasks at the limit");

  // Empty input yields an empty result and runs nothing.
  let called = 0;
  const empty = await mapWithConcurrency([], 4, async () => {
    called++;
    return 1;
  });
  assert(empty.length === 0 && called === 0, "empty input runs no tasks");

  // A limit larger than the item count runs everything (no hang on the cap).
  const all = await mapWithConcurrency([1, 2, 3], 10, async (n) => n + 1);
  assert(JSON.stringify(all) === "[2,3,4]", "limit larger than item count is fine");

  // The worker pool drains the full queue, not just the first `limit` items.
  const seen: number[] = [];
  await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    seen.push(n);
    return n;
  });
  assert(seen.length === 5, "every item is processed, not just the first wave");
}

await run();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nconcurrency: all assertions passed");
