// Reset a load test BRANCH between arms of the post confirm recompute experiment
// (#3258): delete the previous arm's bookings and the rows they left behind, so the
// next arm starts where the first did. The plan, its order and its refusals live in
// `reset-plan.ts` and are driven by scripts/test-loadtest-reset.ts.
//
// It acts only on a target it can POSITIVELY prove is a seeded load test branch:
// the address's ref must equal RESET_BRANCH_REF, the ref recorded for this run, and
// the database must carry the seed's own marker (the load test org as its only org,
// with the seed's agents). Production is refused first by the guard the seed uses,
// with no FORCE. Never TRUNCATE (see reset-plan.ts for why).
//
// Run (against the branch):
//   RESET_BRANCH_REF=<branch-ref> \
//   SUPABASE_URL=https://<branch-ref>.supabase.co \
//   SUPABASE_SECRET_KEY=<branch secret key> \
//   node --experimental-strip-types scripts/loadtest/reset.ts
import { PRODUCTION_SUPABASE_REF } from "../../src/lib/loadtest-guard.ts";
import { SEED_AGENT_EMAIL_DOMAIN } from "./seed-guards.ts";
import { resetBranch, targetRefusal, type ResetClient, type ResetTable, type ResetTarget } from "./reset-plan.ts";

// env-ok: RESET_BRANCH_REF (required; the ref of the branch recorded for this run,
// which the target's address must equal. Absent refuses.)
const url = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const target: ResetTarget = { url, expectedRef: process.env.RESET_BRANCH_REF, productionRef: PRODUCTION_SUPABASE_REF };
// Asked before the key is even used, so a refused address costs no request.
const refusal = targetRefusal(target);
if (refusal) {
  console.error(`RESET REFUSED: ${refusal}`);
  process.exit(1);
}
if (key === "") {
  console.error("RESET REFUSED: SUPABASE_SECRET_KEY is not set.");
  process.exit(1);
}

const REST = `${url}/rest/v1`;
const H = { apikey: key, Authorization: `Bearer ${key}` };

/** The primary key each table is filtered on: PostgREST refuses a DELETE with no filter. */
const PRIMARY_KEY: Record<ResetTable, string> = {
  bookings: "id",
  booking_outbox: "id",
  booking_reservations: "id",
  pending_event_deletions: "id",
  routing_decisions: "id",
  rate_limits: "key",
};

/** The row count from a `Prefer: count=exact` answer's Content-Range ("*\/N" or "0-9/N"). */
function countFrom(res: Response): number {
  const total = (res.headers.get("content-range") ?? "").split("/")[1];
  const n = Number(total);
  if (total === undefined || total === "*" || !Number.isFinite(n)) {
    throw new Error(`no row count in the answer (content-range: ${res.headers.get("content-range")})`);
  }
  return n;
}

async function readJson(path: string): Promise<unknown> {
  const res = await fetch(`${REST}/${path}`, { headers: H });
  if (!res.ok) throw new Error(`read ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const client: ResetClient = {
  async readSeedMarker() {
    // cap-safe: limit 50. A seeded branch holds one org; anything beyond the first
    // few already refuses, so a larger page would only lengthen the refusal.
    const orgs = (await readJson("organizations?select=id,name&limit=50")) as { id: string; name: string }[];
    // An exact count from the header, never a row array, so it cannot be capped.
    const res = await fetch(
      `${REST}/users?select=id&email=like.*%40${encodeURIComponent(SEED_AGENT_EMAIL_DOMAIN)}`,
      { method: "HEAD", headers: { ...H, Prefer: "count=exact" } },
    );
    if (!res.ok) throw new Error(`count seeded agents -> ${res.status}`);
    return { orgs, seedAgents: countFrom(res) };
  },
  async firstBulkReassignRow() {
    for (const table of ["bulk_reassign_items", "bulk_reassign_jobs"]) {
      const res = await fetch(`${REST}/${table}?select=id&limit=1`, { headers: H });
      if (!res.ok) throw new Error(`read ${table} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
      const rows = (await res.json()) as { id: string }[];
      if (rows.length > 0) return { table, id: String(rows[0]!.id) };
    }
    return null;
  },
  async deleteAll(table) {
    const pk = PRIMARY_KEY[table];
    const res = await fetch(`${REST}/${table}?${pk}=not.is.null`, {
      method: "DELETE",
      headers: { ...H, Prefer: "count=exact,return=minimal" },
    });
    if (!res.ok) throw new Error(`delete ${table} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return countFrom(res);
  },
};

const result = await resetBranch(client, target);
if (!result.ok) {
  console.error(`RESET REFUSED: ${result.why}`);
  process.exit(2);
}
for (const { table, rows } of result.deleted) console.log(`  ${table}: ${rows} rows deleted`);
console.log("reset done: the branch holds no bookings, and the seeded calendar busy time is untouched.");
