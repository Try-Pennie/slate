// A realistic bucket roster for the pool grouping suites (#3460): sixty bucket codes,
// shared by `scripts/test-pool-grouping.ts` and the sibling code burst in
// `scripts/test-confirm-contention.ts`, so the two judge the same roster (L41).
//
// Every XBC code (five tiers, four backends, three legal digits). The legal digit does
// not route and backends 0 and 1 set no backend service, so siblings share a pool, as in
// production. Two buckets are edited the way an admin edits them: 411 gains a hand named
// member and 230 a fallback advisor, so each splits off on its own.
import type { PoolInput } from "../../src/lib/availability/pool-key.ts";

const TIERS = ["low", "medium", "high", "very-high", "ultra-high"];

export type RosterRow = PoolInput & { code: string };

export function poolGroupingRoster(): RosterRow[] {
  const rows: RosterRow[] = [];
  for (let tier = 1; tier <= 5; tier++) {
    for (const backend of ["0", "1", "2", "3"]) {
      for (const legal of ["0", "1", "2"]) {
        const code = `${tier}${backend}${legal}`;
        const service = backend === "2" ? { backend_service: ["Beyond"] } : backend === "3" ? { backend_service: ["Achieve"] } : {};
        rows.push({
          code,
          orgId: "org-pennie",
          eventTypeId: "evt-consult",
          criteria: { debt_team: [TIERS[tier - 1]!], ...service },
          fallbackUserId: code === "230" ? "u-fallback" : null,
          memberIds: code === "411" ? ["u-hand-named"] : [],
        });
      }
    }
  }
  return rows;
}
