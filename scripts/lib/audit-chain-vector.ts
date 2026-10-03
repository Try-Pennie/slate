// #3090: one audit_log row and the chain hash Postgres gives it, MEASURED by
// `pnpm verify:audit-chain-sql` against migration 0160 in a real database (L48).
//
// Two suites read it. The verify command asserts the database and the Worker both
// still produce `hash`; `scripts/test-audit-chain.ts` asserts the Worker does,
// offline, on every push. A change to the encoding on either side therefore fails
// somewhere, rather than shipping a monitor that pages on every row.
//
// `details` is Postgres's own text rendering of `detailsJsonb`: keys reordered
// shortest first and spacing normalised, which is why the hash is taken over the
// rendering and never over a re-serialised object.
import type { AuditChainRow } from "../../src/lib/monitor/audit-chain.ts";

export const AUDIT_CHAIN_VECTOR: {
  prev: string;
  row: AuditChainRow;
  detailsJsonb: string;
  hash: string;
} = {
  prev: "0".repeat(64),
  row: {
    id: "00000000-0000-4000-8000-000000000001",
    org_id: "00000000-0000-4000-8000-000000000002",
    actor_id: null,
    action: "agent.bookable",
    target_id: "00000000-0000-4000-8000-000000000003",
    details: '{"to": true, "note": "café", "reason": "line\\nbreak"}',
    created_at: "2026-10-03T12:34:56.000123+00:00",
    chain_seq: 1,
    chain_hash: "",
  },
  detailsJsonb: '{"reason": "line\\nbreak", "note": "café", "to": true}',
  // Measured 2026-10-03 on postgres:17-alpine.
  hash: "cdceb3d9d9eb9b7ab42acafd0e2b1d913c679ca8739e62b95cbad8464c2ab129",
};
