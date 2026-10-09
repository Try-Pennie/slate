// The lower rung reads a walking confirm hands the line (#3529, `ClaimPlace.lower`) leave
// out everybody the confirm already knows cannot take the instant. A walk resumed after a
// lost race carries the advisors it asked on that rung and found unable, and a confirm the
// line handed an advisor it then found unable carries that one; busy at the instant is busy
// on every rung, so handing them to the line would send a waiting confirm to someone already
// known to be busy. The walk's call site passes its whole exclude list, never only the
// advisors it lost races to.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lower-rung-reads.ts
import { lowerRungReads } from "../src/lib/booking/orchestration.ts";
import type { LadderInputs } from "../src/lib/availability/ladder-inputs.ts";
import { eq, finish } from "./lib/harness.ts";

const pools: Record<string, string[]> = { "500": ["a", "b"], "400": ["b", "c", "d"], "300": ["d", "e"], "200": ["c"] };
const ladder = {
  bucket: (code: string) => ({ bucket: { code, is_test: false }, eventType: { duration_min: 30 } }),
} as unknown as LadderInputs;
const deps = {
  roundRobinCandidates: async (bucket: { code: string }) => ({ candidates: [...(pools[bucket.code] ?? [])], memberCount: 0 }),
} as unknown as Parameters<typeof lowerRungReads>[0];

const got = await lowerRungReads(deps, ladder, ["500", "400", "300", "200"], 0, "500", "2026-10-12T22:40:00.000Z", false, true, ["c", "e"]);
eq(JSON.stringify(got.rungs), JSON.stringify([{ rung: 1, read: ["b", "d"] }, { rung: 2, read: ["d"] }]), "every excluded advisor is left out of every lower rung, and a rung left empty is not listed");
eq(got.complete, true, "and the read still covered every rung below");

const none = await lowerRungReads(deps, ladder, ["500", "400", "300", "200"], 0, "500", "2026-10-12T22:40:00.000Z", false, true, []);
eq(JSON.stringify(none.rungs.map((r) => r.read)), JSON.stringify([["b", "c", "d"], ["d", "e"], ["c"]]), "control: with nobody excluded every rung's read is handed whole");

finish();
