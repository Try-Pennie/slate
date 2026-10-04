// #3258: the reset between load run arms.
//
// Three arms of the post confirm recompute experiment can share one branch and
// one deployment only if each arm starts from the state the first one did: the
// previous arm's bookings make agents busier, count against daily caps and widen
// every candidate read, and its leftover outbox, reservations and rate limit rows
// add work and refusals the next arm would be measured under.
//
// Pinned here, each from both sides (L1, L159):
//   1. the TARGET is positively a seeded load test branch, never merely "not
//      production" (a blocklist would empty staging or a dev project): the URL's ref
//      must equal the ref recorded for this run, AND the database must carry the
//      seed's own marker, the load test org as its ONLY org with the seed's agents
//      in it. Every refusal happens before a single row is deleted;
//   2. the ORDER: bookings first (their cascades remove only the busy blocks tied to
//      a booking, never the seeded calendar time), then the tables bookings only
//      null their reference in;
//   3. the COUNTS: every delete reports how many rows it removed;
//   4. the bulk reassign refusal, and that it never truncates.
//
// Run: node --experimental-strip-types scripts/test-loadtest-reset.ts
import { readFileSync } from "node:fs";
import { RESET_ORDER, resetBranch, type ResetClient, type SeedMarker } from "./loadtest/reset-plan.ts";
import { productionRefusal, SEED_AGENT_EMAIL_DOMAIN, SEED_ORG_ID, SEED_ORG_NAME } from "./loadtest/seed-guards.ts";
import { PRODUCTION_SUPABASE_REF } from "../src/lib/loadtest-guard.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const BRANCH = "abcdbranchref123";
const BRANCH_URL = `https://${BRANCH}.supabase.co`;
const SEEDED: SeedMarker = { orgs: [{ id: SEED_ORG_ID, name: SEED_ORG_NAME }], seedAgents: 90 };

function fakeClient(
  rows: Record<string, number>,
  opts: { bulk?: { table: string; id: string } | null; marker?: SeedMarker } = {},
) {
  const calls: string[] = [];
  const client: ResetClient = {
    readSeedMarker: async () => {
      calls.push("read-marker");
      return opts.marker ?? SEEDED;
    },
    firstBulkReassignRow: async () => {
      calls.push("check-bulk");
      return opts.bulk ?? null;
    },
    deleteAll: async (table) => {
      calls.push(`delete:${table}`);
      const n = rows[table] ?? 0;
      rows[table] = 0;
      return n;
    },
  };
  return { client, calls };
}

const target = (url = BRANCH_URL, expectedRef: string | undefined = BRANCH) => ({
  url,
  expectedRef,
  productionRef: PRODUCTION_SUPABASE_REF,
});

const deletedNothing = (calls: string[]) => !calls.some((c) => c.startsWith("delete:"));

// --- the order and the counts ------------------------------------------------------
eq(
  [...RESET_ORDER],
  ["bookings", "booking_outbox", "booking_reservations", "pending_event_deletions", "routing_decisions", "rate_limits"],
  "bookings first, then the tables that only null their reference, then rate limits",
);
{
  const rows = { bookings: 631, booking_outbox: 4, booking_reservations: 2, pending_event_deletions: 0, routing_decisions: 640, rate_limits: 37 };
  const { client, calls } = fakeClient({ ...rows });
  const result = await resetBranch(client, target());
  eq(calls.slice(0, 2), ["read-marker", "check-bulk"], "the marker and the bulk reassign check run before anything is deleted");
  eq(calls.slice(2), RESET_ORDER.map((t) => `delete:${t}`), "then each table, in order, once");
  eq(result, { ok: true, deleted: RESET_ORDER.map((t) => ({ table: t, rows: rows[t as keyof typeof rows] })) }, "every delete reports its own row count");
}

// --- the target must be the recorded branch -----------------------------------------
{
  const { client, calls } = fakeClient({ bookings: 5 });
  const r = await resetBranch(client, target("https://someotherref999.supabase.co"));
  assert(!r.ok && r.why.includes("someotherref999") && r.why.includes(BRANCH), "a ref that does not match the recorded branch refuses, naming both");
  eq(calls, [], "before reading or deleting anything");
}
{
  const { client, calls } = fakeClient({ bookings: 5 });
  // Built by hand: a default parameter would turn an explicit undefined back into the ref.
  const r = await resetBranch(client, { url: BRANCH_URL, expectedRef: undefined, productionRef: PRODUCTION_SUPABASE_REF });
  assert(!r.ok && r.why.includes("RESET_BRANCH_REF"), "no recorded ref refuses, naming the setting");
  eq(calls, [], "and touches nothing");
}
{
  const { client } = fakeClient({});
  const r = await resetBranch(client, target(`https://${BRANCH}.supabase.co.evil.example`));
  assert(!r.ok, "a ref that only CONTAINS the branch ref is not a match");
  const r2 = await resetBranch(client, target("http://localhost:54321", BRANCH));
  assert(!r2.ok, "an address with no project ref at all refuses");
}

// --- the database must carry the seed's own marker -------------------------------------
{
  // A non production project with real data: its own org, no seed.
  const { client, calls } = fakeClient({ bookings: 5 }, { marker: { orgs: [{ id: "real-org", name: "Pennie" }], seedAgents: 0 } });
  const r = await resetBranch(client, target());
  assert(!r.ok && r.why.includes("Loadtest Org"), "a project without the load test org refuses, saying what it looked for");
  assert(deletedNothing(calls), "and nothing is deleted");
}
{
  // The seed was run into a project that also holds a real org: still refused.
  const { client, calls } = fakeClient({ bookings: 5 }, {
    marker: { orgs: [{ id: SEED_ORG_ID, name: SEED_ORG_NAME }, { id: "real-org", name: "Pennie" }], seedAgents: 90 },
  });
  const r = await resetBranch(client, target());
  assert(!r.ok && r.why.includes("Pennie"), "a second org beside the load test one refuses, naming it");
  assert(deletedNothing(calls), "and nothing is deleted");
}
{
  const { client, calls } = fakeClient({ bookings: 5 }, { marker: { orgs: [{ id: SEED_ORG_ID, name: SEED_ORG_NAME }], seedAgents: 0 } });
  const r = await resetBranch(client, target());
  assert(!r.ok && r.why.includes(SEED_AGENT_EMAIL_DOMAIN), "the org with none of the seed's agents refuses");
  assert(deletedNothing(calls), "and nothing is deleted");
}
{
  const { client, calls } = fakeClient({ bookings: 5 }, { marker: { orgs: [{ id: SEED_ORG_ID, name: "Pennie" }], seedAgents: 90 } });
  const r = await resetBranch(client, target());
  assert(!r.ok, "the seed's org id under another name is not the marker");
  assert(deletedNothing(calls), "and nothing is deleted");
}

// --- the bulk reassign refusal ------------------------------------------------------
{
  const { client, calls } = fakeClient({ bookings: 5 }, { bulk: { table: "bulk_reassign_items", id: "item-1" } });
  const result = await resetBranch(client, target());
  assert(!result.ok, "a bulk reassign row refuses the reset");
  assert(!result.ok && result.why.includes("bulk_reassign_items") && result.why.includes("item-1"), "naming the table and the row");
  assert(deletedNothing(calls), "and nothing at all is deleted");
}

// --- production -----------------------------------------------------------------------
{
  const prod = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
  assert(productionRefusal(prod, PRODUCTION_SUPABASE_REF, { force: false, action: "reset" }) !== null, "the shared guard refuses production");
  assert(
    productionRefusal(prod, PRODUCTION_SUPABASE_REF, { force: false, action: "reset" })!.includes("reset"),
    "naming what it refused to do",
  );
  eq(productionRefusal(BRANCH_URL, PRODUCTION_SUPABASE_REF, { force: false, action: "reset" }), null, "a branch passes (positive control)");
  eq(productionRefusal(prod, PRODUCTION_SUPABASE_REF, { force: true, action: "seed" }), null, "the seed's FORCE still works for the seed");
  assert(productionRefusal("", PRODUCTION_SUPABASE_REF, { force: false, action: "reset" }) !== null, "an empty address refuses rather than passing");

  // Production refuses inside the plan, first, even when somebody recorded
  // production's ref as the branch and the marker answered (it never should).
  const { client, calls } = fakeClient({ bookings: 5 });
  const r = await resetBranch(client, target(prod, PRODUCTION_SUPABASE_REF));
  assert(!r.ok && r.why.includes("production"), "the plan refuses production first, with no FORCE to pass");
  eq(calls, [], "before touching anything");

  const entry = readFileSync(new URL("./loadtest/reset.ts", import.meta.url), "utf8");
  assert(!/process\.env\.FORCE/.test(entry), "the reset entry never reads FORCE");
  const seed = readFileSync(new URL("./loadtest/seed.ts", import.meta.url), "utf8");
  assert(/productionRefusal\(/.test(seed), "the seed refuses production through the same guard");
  for (const src of [entry, readFileSync(new URL("./loadtest/reset-plan.ts", import.meta.url), "utf8")]) {
    assert(!/truncate/i.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\/|^\s*\*.*$/gm, "")), "and no code in the reset truncates");
  }
}

// --- the marker is the seed's own -------------------------------------------------------
{
  const seed = readFileSync(new URL("./loadtest/seed.ts", import.meta.url), "utf8");
  assert(/\{ id: SEED_ORG_ID, name: SEED_ORG_NAME \}/.test(seed), "the seed writes the org from the same constants the reset checks");
  const generate = readFileSync(new URL("./loadtest/generate.ts", import.meta.url), "utf8");
  assert(/SEED_AGENT_EMAIL_DOMAIN/.test(generate), "and names its agents with the same domain");
}

finish();
