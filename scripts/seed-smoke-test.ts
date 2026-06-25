// Seeds the dedicated smoke-test agent + isolated buckets (#396) so the manual
// booking smoke test (scripts/smoke-booking-api.ts) never books a real
// round-robin agent. Row shapes come from the pure, unit-tested builder
// (scripts/smoke-seed.ts -> buildSmokeSeed); this file is the I/O wrapper, same
// posture as scripts/seed-buckets.ts (Supabase REST, secret key from .env.local).
//
// Idempotent: the agent + schedule upsert on their deterministic ids, buckets on
// (org_id, code), members on (bucket_id, user_id); rules are replaced wholesale.
// Re-running refreshes in place without duplicating.
//
// PREFLIGHT: smoketest@trypennie.com must already be a real Google Workspace
// mailbox (booking impersonates it via domain-wide delegation to create the
// calendar event, and its plus-aliases receive the invite/cancel emails). The
// per-calendar watch cron creates the agent_calendars row automatically on its
// next pass once the mailbox exists.
//
// Safety: DRY RUN by default — prints the planned rows and writes nothing.
// Set APPLY=1 to actually write to the project in .env.local.
//
//   node --experimental-strip-types scripts/seed-smoke-test.ts          # preview
//   APPLY=1 node --experimental-strip-types scripts/seed-smoke-test.ts  # write
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSmokeSeed } from "./smoke-seed.ts";

const AGENT_EMAIL = "smoketest@trypennie.com";
const BUCKET_CODES = ["SMOKE", "SMOKE2"];
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

async function main() {
  const [org] = await get<{ id: string; name: string }[]>("organizations?select=id,name&limit=1");
  const [eventType] = await get<{ id: string; name: string }[]>("event_types?select=id,name&limit=1");
  if (!org || !eventType) throw new Error("org or event type missing");
  console.log(
    `${APPLY ? "APPLYING" : "DRY RUN (set APPLY=1 to write)"} | org: ${org.name} | event type: ${eventType.name}`,
  );

  const seed = buildSmokeSeed({
    orgId: org.id,
    eventTypeId: eventType.id,
    agentEmail: AGENT_EMAIL,
    bucketCodes: BUCKET_CODES,
  });

  // 1) Agent — upsert on the deterministic id so re-runs refresh in place.
  console.log("agent:");
  await write("POST", "users?on_conflict=id", "resolution=merge-duplicates,return=minimal", [seed.user]);

  // 2) Availability schedule — upsert on id.
  console.log("schedule:");
  await write(
    "POST",
    "availability_schedules?on_conflict=id",
    "resolution=merge-duplicates,return=minimal",
    [seed.schedule],
  );

  // 3) Rules — replace wholesale (no assumed unique key on schedule_id+weekday).
  console.log("rules (replace):");
  await write("DELETE", `availability_rules?schedule_id=eq.${seed.schedule.id}`, "return=minimal", undefined);
  await write("POST", "availability_rules", "return=minimal", seed.rules);

  // 4) Buckets — upsert on (org_id, code); need the ids back to link members.
  console.log("buckets:");
  await write(
    "POST",
    "buckets?on_conflict=org_id,code",
    "resolution=merge-duplicates,return=minimal",
    seed.buckets,
  );
  const bucketRows = await get<{ id: string; code: string }[]>(
    `buckets?select=id,code&org_id=eq.${org.id}&code=in.(${BUCKET_CODES.join(",")})`,
  );
  const idByCode = new Map(bucketRows.map((b) => [b.code, b.id]));

  // 5) Members — link the agent to each bucket; upsert on (bucket_id, user_id).
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

  console.log(
    APPLY
      ? `\nDone. Agent ${AGENT_EMAIL} seeded into buckets ${BUCKET_CODES.join(", ")}.\n` +
          "Next: ensure the mailbox exists in Workspace, then let the watch cron add its\n" +
          "agent_calendars row (or wait one cycle), and the recompute cron publish SMOKE slots."
      : "\nDry run only — nothing written. Re-run with APPLY=1 to seed.",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
