// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-bucket-matchability.ts
//
// WHY IT EXISTS. `rsegui@trypennie.com` was paged on every day as an agent Slate
// held back from a lead cal.com could still route, because the check asked whether
// they carried any attribute rather than whether a bucket could match one. Their
// only attribute was `{"role":"Sales"}` and no bucket keys on `role` (#2094).
import { matchableAgentIds } from "./lib/bucket-matchability.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const REAL_SHAPES = [
  { criteria: { debt_team: "low" } },
  { criteria: { debt_team: "low", "backend_service!": "beyond" } },
  { criteria: { debt_team: "low", backend_service: "achieve" } },
  { criteria: { debt_team: "ultra_high" } },
] as never[];

{
  // The case this exists for.
  const roleOnly = [{ id: "a", attributes: { role: "Sales" } }] as never[];
  const m = matchableAgentIds(roleOnly, REAL_SHAPES, new Set());
  assert(!m.has("a"), "an agent whose only attribute is one no bucket keys on is matchable by nothing");
}
{
  // THE POSITIVE CONTROL. Without it a predicate hard-wired to false satisfies
  // every other assertion here, and the page it is meant to quieten goes silent
  // for everybody (L1).
  const real = [{ id: "b", attributes: { debt_team: ["low"], backend_service: ["achieve"] } }] as never[];
  const m = matchableAgentIds(real, REAL_SHAPES, new Set());
  assert(m.has("b"), "an agent carrying a key the buckets actually use IS matchable");
}
{
  // A tier no bucket asks for is still unmatchable, so this is about the VALUES
  // as well as the keys.
  const wrongTier = [{ id: "c", attributes: { debt_team: ["nonexistent_tier"] } }] as never[];
  const m = matchableAgentIds(wrongTier, REAL_SHAPES, new Set());
  assert(!m.has("c"), "a debt team no bucket asks for matches nothing either");
}
{
  // Manual members are matched by the booker, so leaving them out would report
  // somebody a bucket really can reach as unreachable.
  const bare = [{ id: "d", attributes: {} }] as never[];
  const m = matchableAgentIds(bare, REAL_SHAPES, new Set(["d"]));
  assert(m.has("d"), "a manual member is matchable with no attributes at all");
}
{
  // Empty inputs answer EMPTY, which is only safe because the caller refuses on a
  // bucket list it could not read. Pinned so that contract is visible from here:
  // an empty answer means "nothing could match", and read as fact it would quieten
  // the page for the entire roster (L98).
  eq(matchableAgentIds([{ id: "e", attributes: { debt_team: ["low"] } }] as never[], [], new Set()).size, 0,
    "no buckets means nobody is matchable, which the caller must never read as a healthy answer");
}
{
  const two = [
    { id: "f", attributes: { debt_team: ["ultra_high"] } },
    { id: "g", attributes: { debt_team: ["low"] } },
  ] as never[];
  const m = matchableAgentIds(two, REAL_SHAPES, new Set());
  eq(m.size, 2, "the answer is the union across every bucket, not one bucket's pool");
}

finish();
