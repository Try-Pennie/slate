// Tests for the pure batching helpers used by the Salesforce sync (#91). The
// sync used to write one row per round-trip in two sequential loops (existing
// agents, then manager links); these helpers let it write in chunked/grouped
// statements instead. Side-effect-free, so tested here; the IO lives in sync.ts.
// Run: node --experimental-strip-types scripts/test-salesforce-sync-batch.ts
import { groupManagerLinks, chunkRows } from "../src/lib/salesforce/sync-batch.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- groupManagerLinks: all agents under one manager collapse to one write ---
{
  const grouped = groupManagerLinks([
    { agentId: "a1", managerId: "m1" },
    { agentId: "a2", managerId: "m1" },
    { agentId: "a3", managerId: "m2" },
    { agentId: "a4", managerId: "m1" },
  ]);
  eq(grouped.size, 2, "distinct managers => 2 grouped writes (not 4 per-agent)");
  eq(JSON.stringify(grouped.get("m1")), JSON.stringify(["a1", "a2", "a4"]), "m1 agents grouped in order");
  eq(JSON.stringify(grouped.get("m2")), JSON.stringify(["a3"]), "m2 has its one agent");
}

// --- empty input => no writes ---
{
  const grouped = groupManagerLinks([]);
  eq(grouped.size, 0, "no links => no grouped writes");
}

// --- chunkRows: splits a large roster into bounded batches ---
{
  const rows = Array.from({ length: 450 }, (_, i) => i);
  const chunks = chunkRows(rows, 200);
  eq(chunks.length, 3, "450 rows / 200 => 3 chunks");
  eq(chunks[0].length, 200, "first chunk full");
  eq(chunks[2].length, 50, "last chunk holds the remainder");
  eq(chunks.flat().length, 450, "no rows dropped across chunks");
}

// --- chunkRows: fewer rows than the size => one chunk, exact-fit => no empty tail ---
{
  eq(chunkRows([1, 2, 3], 200).length, 1, "small list => single chunk");
  eq(chunkRows([], 200).length, 0, "empty list => no chunks (no empty write)");
  eq(chunkRows([1, 2, 3, 4], 2).length, 2, "exact multiple => no trailing empty chunk");
}

// --- chunkRows: an invalid size fails loud rather than looping forever ---
{
  let threw = false;
  try {
    chunkRows([1, 2, 3], 0);
  } catch {
    threw = true;
  }
  assert(threw, "chunk size < 1 throws instead of spinning");
}

finish();
