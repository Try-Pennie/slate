// Live repro for #523 (PR #526): a reschedule that shifts a booking by LESS than
// the event length must keep the SAME agent in a MULTI-agent bucket, instead of
// silently re-routing to another advisor.
//
// It hits PRODUCTION and is fully self-contained + self-cleaning:
//   1. temporarily adds smoketest2@ to the SMOKE bucket (-> two agents),
//   2. books a throwaway appointment (lands on agent A),
//   3. reschedules it by +10 min (the event is 20 min, so the new slot OVERLAPS
//      the booking's own still-present event — the exact #523 trigger),
//   4. reads the DB to assert the booking stayed on agent A,
//   5. cancels the booking and removes the temporary membership (always, via
//      finally), leaving SMOKE back to a single agent.
//
// Run it by hand from a shell that has the app env (it reads .env.local +
// .dev.vars itself for NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY /
// BOOKING_API_KEY):
//
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/smoke-523-stickiness.ts
//
// Optional env: SLATE_BASE_URL (default prod).
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";

// Load env from .env.local then .dev.vars (later file does not override earlier).
for (const file of [".env.local", ".dev.vars"]) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // file absent — fine, rely on the ambient environment.
  }
}

const BASE = (process.env.SLATE_BASE_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
const KEY = process.env.BOOKING_API_KEY ?? "";
const BUCKET = "SMOKE";
const SMOKE_BUCKET_ID = "44004a29-da8a-47fe-9ebc-6a95bccd1bfc";
const SMOKETEST2_ID = "c0000000-0000-4000-8000-000000000002";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) console.log("ok:", msg);
  else {
    console.error("FAIL:", msg);
    failures += 1;
  }
}

type Json = Record<string, unknown>;
async function jpost(path: string, body: Json, auth = false): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${KEY}`;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

async function slots(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/availability?bucket=${encodeURIComponent(BUCKET)}`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  const body = (await res.json().catch(() => ({}))) as { slots?: string[] };
  return res.status === 200 ? body.slots ?? [] : [];
}

function tokenFrom(manageUrl: unknown): string {
  return String(manageUrl ?? "").split("/").pop() ?? "";
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error("Set BOOKING_API_KEY (or put it in .env.local / .dev.vars) first.");
    process.exit(2);
  }
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const db = supabaseAdmin();

  console.log(`# 523 stickiness repro vs ${BASE} (bucket ${BUCKET})`);

  // --- Setup: make SMOKE two-agent (idempotent; remember if WE added the row). ---
  const existing = await db
    .from("bucket_members")
    .select("id")
    .eq("bucket_id", SMOKE_BUCKET_ID)
    .eq("user_id", SMOKETEST2_ID)
    .maybeSingle();
  let addedMembership = false;
  if (!existing.data) {
    const ins = await db
      .from("bucket_members")
      .insert({ bucket_id: SMOKE_BUCKET_ID, user_id: SMOKETEST2_ID, weight: 1, active: true });
    if (ins.error) {
      console.error("setup: could not add smoketest2 to SMOKE:", ins.error.message);
      process.exit(1);
    }
    addedMembership = true;
  }
  console.log(`setup: SMOKE now has both agents${addedMembership ? " (added smoketest2@)" : " (smoketest2@ already present)"}`);

  const externalId = `smoke-523-${Date.now()}`;
  const email = "smoketest+523@trypennie.com";
  let token = "";
  try {
    // Pick a slot comfortably mid-shift so +30 min stays within 9-5 ET and free.
    const open = await slots();
    const usable = open.find((s) => {
      const h = DateTime.fromISO(s, { zone: "America/New_York" }).hour;
      return h >= 9 && h <= 15;
    });
    check(!!usable, `found a mid-shift SMOKE slot (of ${open.length} open)`);
    if (!usable) return;
    const s0 = usable;
    const target = new Date(Date.parse(s0) + 10 * 60_000).toISOString(); // +10 min: overlaps the 20-min event

    // 1. Book — lands on whichever agent round-robin picks.
    const created = await jpost(
      "/api/bookings",
      {
        bucketCode: BUCKET,
        start: s0,
        timezone: "America/New_York",
        attendee: { name: "523 Repro", email, phone: "+12025550123" },
        externalId,
        confirmReschedule: false,
        dryRun: false,
      },
      true,
    );
    check(created.status === 200, `create -> 200 (got ${created.status}${created.status !== 200 ? ` err=${created.body.error}` : ""})`);
    token = tokenFrom((created.body.booking as Json | undefined)?.manageUrl ?? created.body.manageUrl);
    check(!!token, "create returns a manage token");
    if (!token) return;

    const before = await db
      .from("bookings")
      .select("id, assigned_user_id, agent_email, starts_at")
      .eq("external_id", externalId)
      .maybeSingle();
    const agentBefore = before.data?.assigned_user_id ?? null;
    check(!!agentBefore, `booked onto an agent (${before.data?.agent_email ?? "?"})`);

    // 2. Reschedule by +10 min — the new window overlaps the booking's own event.
    const moved = await jpost(`/api/bookings/${token}/reschedule`, { start: target, reason: "schedule_conflict" });
    check(
      moved.status === 200,
      `sub-event reschedule -> 200 (got ${moved.status}${moved.status !== 200 ? ` err=${moved.body.error}` : ""})`,
    );
    check(moved.body.startsAt === target, `reschedule lands on the new time (${moved.body.startsAt} == ${target})`);

    // 3. The load-bearing assertion: the agent did NOT change.
    const after = await db
      .from("bookings")
      .select("assigned_user_id, agent_email")
      .eq("external_id", externalId)
      .maybeSingle();
    const agentAfter = after.data?.assigned_user_id ?? null;
    check(
      agentAfter === agentBefore,
      `STAYED on the same agent across the sub-event reschedule (before=${before.data?.agent_email}, after=${after.data?.agent_email})`,
    );
  } finally {
    // 4. Teardown: cancel the booking, then revert SMOKE to a single agent.
    if (token) {
      const cancelled = await jpost(`/api/bookings/${token}/cancel`, { reason: "no_longer_interested" });
      check(cancelled.status === 200, `teardown: booking cancelled (got ${cancelled.status})`);
    }
    if (addedMembership) {
      const del = await db
        .from("bucket_members")
        .delete()
        .eq("bucket_id", SMOKE_BUCKET_ID)
        .eq("user_id", SMOKETEST2_ID);
      check(!del.error, "teardown: SMOKE reverted to a single agent");
    }
  }

  console.log(failures === 0 ? "\n523 REPRO PASSED (stickiness held)" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("repro crashed:", e);
  process.exit(1);
});
