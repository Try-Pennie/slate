// Seeds the dedicated smoke-test agent + isolated buckets (#396) so the manual
// booking smoke test (scripts/smoke-booking-api.ts) never books a real
// round-robin agent, and the PUBLIC test bucket a partner can book from any host
// page without a key (#2660). Row shapes come from the pure, unit-tested builder
// (scripts/smoke-seed.ts -> buildSmokeSeed); this file is the I/O wrapper, same
// posture as scripts/seed-buckets.ts (Supabase REST, secret key from .env.local).
//
// The bucket codes are READ from `src/lib/embed/public-test-bucket.ts`, never
// spelled here: the routes serve from the same constants, so the seed cannot make
// a bucket nothing serves or serve one the seed never made.
//
// Idempotent: the agent + schedule upsert on their deterministic ids, the public
// test event type on its id, buckets on (org_id, code), members on
// (bucket_id, user_id); rules are replaced wholesale. Re-running refreshes in
// place without duplicating.
//
// RUN IT OUTSIDE A CANARY TICK. The canary fires at :00 and :30 and books the
// smoke agents; this script deletes and reinserts both agents' working hours, so
// for the length of that write the agents have no hours and a canary run in
// flight reads them as off shift. Start it a few minutes past the half hour.
//
// PREFLIGHT: smoketest@trypennie.com must already be a real Google Workspace
// mailbox (booking impersonates it via domain-wide delegation to create the
// calendar event, and its plus-aliases receive the invite/cancel emails). The
// per-calendar watch cron creates the agent_calendars row automatically on its
// next pass once the mailbox exists.
//
// REASSIGN TARGET / SMOKE FALLBACK (#450/#464): smoketest2@trypennie.com must
// ALSO be a real Workspace mailbox: the reassign smoke scenario moves a booking
// onto it, which impersonates that address to create the moved calendar event.
// It now joins the SMOKE bucket as a bookable fallback (with its own 9-5
// schedule) so round-robin CAN pick it and the reschedule-stickiness (#523)
// scenario has a genuine second agent; it stays OUT of SMOKE2 and out of the
// public test bucket.
//
// Safety: DRY RUN by default: prints the planned rows and writes nothing. The
// dry run then MEASURES the live rows and exits on what it finds (#2660), one
// code per state, so "seeded" is a measurement rather than a printed line:
//   0  every test bucket exists, is flagged is_test, has a member, and the
//      recompute cron has published its slots
//   2  a bucket row is missing (run with APPLY=1)
//   3  a bucket has no active member (run with APPLY=1)
//   4  a bucket is seeded and its slots are not published yet (wait a cycle)
//   5  a bucket row exists and is NOT flagged is_test (do not serve it; APPLY=1)
//   6  nothing was judged
// Set APPLY=1 to actually write to the project in .env.local; that exits 0 on a
// successful write and tells you to run the dry run again after one recompute.
//
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/seed-smoke-test.ts          # measure
//   APPLY=1 node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/seed-smoke-test.ts  # write
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSmokeSeed, type EventTypeTemplate } from "./smoke-seed.ts";
import {
  HIDDEN_TEST_BUCKET_CODES,
  PUBLIC_TEST_BUCKET_CODES,
} from "../src/lib/embed/public-test-bucket.ts";
import {
  judgeSeedReadiness,
  worstReadiness,
  type SeedReadiness,
} from "./lib/smoke-seed-readiness.ts";

const AGENT_EMAIL = "smoketest@trypennie.com";
const REASSIGN_TARGET_EMAIL = "smoketest2@trypennie.com";
const BUCKET_CODES = [...HIDDEN_TEST_BUCKET_CODES];
const PUBLIC_BUCKET_CODES = [...PUBLIC_TEST_BUCKET_CODES];
const ALL_CODES = [...BUCKET_CODES, ...PUBLIC_BUCKET_CODES];
const APPLY = process.env.APPLY === "1";

const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "../.env.local"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const BASE = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1`;
const H = {
  apikey: env.SUPABASE_SECRET_KEY!,
  Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
  "content-type": "application/json",
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, { headers: H });
  const body = (await res.json()) as T;
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function write(method: string, path: string, prefer: string, body: unknown): Promise<unknown> {
  if (!APPLY) {
    console.log(`  [dry-run] ${method} ${path} <- ${JSON.stringify(body)}`);
    return [];
  }
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: { ...H, Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

/**
 * What the live rows say about each test bucket (#2660). Three bounded reads:
 * the bucket rows by code, their active members, and the published slot rows.
 * The verdict per code is `judgeSeedReadiness`, pinned offline.
 */
async function measureReadiness(orgId: string): Promise<SeedReadiness[]> {
  const buckets = await get<{ id: string; code: string; is_test: boolean }[]>(
    `buckets?select=id,code,is_test&org_id=eq.${orgId}&code=in.(${ALL_CODES.join(",")})`,
  );
  const ids = buckets.map((b) => b.id);
  const members = ids.length
    ? await get<{ bucket_id: string }[]>(
        `bucket_members?select=bucket_id&active=eq.true&bucket_id=in.(${ids.join(",")})`,
      )
    : [];
  const slotRows = await get<{ bucket_code: string; computed_at: string }[]>(
    `bucket_slots?select=bucket_code,computed_at&bucket_code=in.(${ALL_CODES.join(",")})`,
  );
  return ALL_CODES.map((code) => {
    const bucket = buckets.find((b) => b.code === code) ?? null;
    return judgeSeedReadiness({
      code,
      bucket: bucket ? { id: bucket.id, is_test: bucket.is_test === true } : null,
      activeMembers: bucket ? members.filter((m) => m.bucket_id === bucket.id).length : 0,
      slotRow: slotRows.find((s) => s.bucket_code === code) ?? null,
    });
  });
}

async function main() {
  const [org] = await get<{ id: string; name: string }[]>("organizations?select=id,name&limit=1");
  // The org's FIRST event type, by creation, which is the one the hidden buckets
  // have always used. Ordered rather than whichever row PostgREST answers first:
  // with more than one event type an unordered `limit=1` can land the buckets on
  // a different one each run (red team finding 6).
  const [eventType] = await get<({ id: string; name: string } & EventTypeTemplate)[]>(
    "event_types?select=id,name,description,regal_type,duration_min,buffer_before_min,buffer_after_min,min_notice_min,slot_interval_min" +
      `&org_id=eq.${org?.id}&order=created_at.asc&limit=1`,
  );
  if (!org || !eventType) throw new Error("org or event type missing");
  console.log(
    `${APPLY ? "APPLYING" : "DRY RUN (set APPLY=1 to write)"} | org: ${org.name} | event type: ${eventType.name}`,
  );

  const seed = buildSmokeSeed({
    orgId: org.id,
    eventTypeId: eventType.id,
    eventTypeTemplate: {
      description: eventType.description,
      regal_type: eventType.regal_type,
      duration_min: eventType.duration_min,
      buffer_before_min: eventType.buffer_before_min,
      buffer_after_min: eventType.buffer_after_min,
      min_notice_min: eventType.min_notice_min,
      slot_interval_min: eventType.slot_interval_min,
    },
    agentEmail: AGENT_EMAIL,
    bucketCodes: BUCKET_CODES,
    publicBucketCodes: PUBLIC_BUCKET_CODES,
    reassignTargetEmail: REASSIGN_TARGET_EMAIL,
  });

  // 1) Agents: upsert on the deterministic id so re-runs refresh in place. The
  // reassign target (#450) is a second bookable agent in no bucket; written here
  // alongside the primary so a single seed run provisions both.
  console.log("agents:");
  const agentRows = seed.reassignTarget ? [seed.user, seed.reassignTarget] : [seed.user];
  await write("POST", "users?on_conflict=id", "resolution=merge-duplicates,return=minimal", agentRows);

  // 2) Availability schedules: upsert on id (one per seeded agent: the primary
  // and, when present, the reassign-target/SMOKE-fallback agent #464).
  console.log("schedules:");
  await write(
    "POST",
    "availability_schedules?on_conflict=id",
    "resolution=merge-duplicates,return=minimal",
    seed.schedules,
  );

  // 3) Rules: replace wholesale per schedule (no assumed unique key on
  // schedule_id+weekday), then insert the full rule set across all schedules.
  console.log("rules (replace):");
  for (const s of seed.schedules) {
    await write("DELETE", `availability_rules?schedule_id=eq.${s.id}`, "return=minimal", undefined);
  }
  await write("POST", "availability_rules", "return=minimal", seed.rules);

  // 4) The public test bucket's event type (#2660): upsert on id, BEFORE the
  // buckets that reference it.
  console.log("event types:");
  await write(
    "POST",
    "event_types?on_conflict=id",
    "resolution=merge-duplicates,return=minimal",
    seed.eventTypes,
  );

  // 5) Buckets: upsert on (org_id, code); need the ids back to link members.
  console.log("buckets:");
  await write(
    "POST",
    "buckets?on_conflict=org_id,code",
    "resolution=merge-duplicates,return=minimal",
    seed.buckets,
  );
  const bucketRows = await get<{ id: string; code: string }[]>(
    `buckets?select=id,code&org_id=eq.${org.id}&code=in.(${ALL_CODES.join(",")})`,
  );
  const idByCode = new Map(bucketRows.map((b) => [b.code, b.id]));

  // 6) Members: link the agent to each bucket; upsert on (bucket_id, user_id).
  console.log("members:");
  const memberRows = seed.members.map((m) => {
    const bucket_id = idByCode.get(m.bucketCode);
    if (APPLY && !bucket_id) throw new Error(`bucket ${m.bucketCode} not found after upsert`);
    return { bucket_id: bucket_id ?? `<${m.bucketCode}>`, user_id: m.user_id, active: true };
  });
  await write(
    "POST",
    "bucket_members?on_conflict=bucket_id,user_id",
    "resolution=merge-duplicates,return=minimal",
    memberRows,
  );

  if (APPLY) {
    console.log(
      `\nDone. Agent ${AGENT_EMAIL} seeded into buckets ${ALL_CODES.join(", ")}` +
        `${seed.reassignTarget ? `; reassign target ${REASSIGN_TARGET_EMAIL} seeded as a bookable fallback in ${BUCKET_CODES[0]}` : ""}.\n` +
        "Next: ensure both mailboxes exist in Workspace, then let the watch cron add the\n" +
        "agent_calendars row (or wait one cycle), and the recompute cron publish the slots.\n" +
        "Then run this script again WITHOUT APPLY=1: it measures every test bucket and\n" +
        "exits 0 only when each one is flagged, staffed and published.",
    );
    return;
  }

  // The measurement (#2660). Nothing above wrote, so this reads what the
  // database holds today, per bucket, and the exit code is the worst row's.
  console.log("\nLive state of every test bucket:");
  const readiness = await measureReadiness(org.id);
  for (const r of readiness) console.log(`  ${r.state.padEnd(10)} ${r.message}`);
  const worst = worstReadiness(readiness);
  console.log(
    worst.exit === 0
      ? "\nEvery test bucket is ready. Nothing written (this was a dry run)."
      : `\nNot ready: ${worst.state}. Nothing written. Re-run with APPLY=1 to seed, or wait for the recompute, as the line above says.`,
  );
  process.exit(worst.exit);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
