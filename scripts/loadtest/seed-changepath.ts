// Seeds a booking-change-path BACKLOG on top of the base 200-agent seed, so the
// /api/cron/outbox drain lane has real crash-recovery work during the #440 P5
// load/soak. Models "a crash at every mid-sequence point of a cancel" by writing
// booking_outbox rows whose Google-delete step is already `done` and whose
// remaining DB/webhook steps are `pending`, exactly the partial states a crash
// mid-cancel leaves behind. The drain must self-heal every one, exactly once.
//
// It seeds cancelled bookings + their slate busy_blocks + one webhook endpoint
// (subscribed to booking.cancelled), so draining a row frees the stuck slot,
// recomputes, and fires booking.cancelled exactly once (guarded by the
// (endpoint,event,dedupe_key) unique index). Run the app with SLATE_LOADTEST=true
// so the webhook POST is stubbed (src/lib/webhooks/emit.ts): no real subscriber.
//
// SAFETY: refuses to run against the production project ref unless FORCE=1.
// Requires the base seed (scripts/loadtest/seed.ts) to have run first.
//
// Run (against a branch, AFTER seed.ts):
//   SUPABASE_URL=https://<branch-ref>.supabase.co \
//   SUPABASE_SECRET_KEY=<branch secret key> \
//   OUTBOX_BACKLOG=500 \
//   node --experimental-strip-types scripts/loadtest/seed-changepath.ts
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PRODUCTION_SUPABASE_REF } from "../../src/lib/loadtest-guard.ts";
import { WEBHOOK_EVENTS } from "../../src/lib/webhooks/events.ts";

// ONE constant, shared with the app's own load test refusals (#2242). A second
// spelling beside each script is how one of them ends up naming a project that
// is not production (L2, L41).
const PROD_REF = PRODUCTION_SUPABASE_REF;
const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_TYPE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BACKLOG = Number(process.env.OUTBOX_BACKLOG ?? 500);

// The cancel steps, verbatim from orchestration.ts CANCEL_STEPS. A drain re-runs
// only the not-`done` steps, so pre-marking a prefix `done` models a crash after
// that point. Three partial shapes span every mid-sequence crash window.
const STEP_NAMES = ["cancel:gcal_delete", "cancel:busyblock_delete", "cancel:recompute", "cancel:notify"];
function stepsCrashedAfter(doneCount: number) {
  return STEP_NAMES.map((name, i) => ({
    name,
    state: i < doneCount ? "done" : "pending",
    error: null,
  }));
}

function loadEnv(): { url: string; key: string } {
  const fromFile: Record<string, string> = {};
  const p = join(import.meta.dirname, "../../.env.local");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      fromFile[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1).trim();
    }
  }
  const url = process.env.SUPABASE_URL ?? fromFile.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SECRET_KEY ?? fromFile.SUPABASE_SECRET_KEY ?? "";
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY (the BRANCH).");
  if (url.includes(PROD_REF) && process.env.FORCE !== "1") {
    throw new Error(
      `Refusing to seed the production project (${PROD_REF}). Point SUPABASE_URL at a branch, or set FORCE=1 if you really mean it.`,
    );
  }
  return { url: `${url}/rest/v1`, key };
}

const { url: BASE, key: KEY } = loadEnv();
const H = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "content-type": "application/json",
  Prefer: "resolution=merge-duplicates,return=minimal",
};

async function getJson(path: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${BASE}/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>[];
}

async function insert(table: string, rows: unknown[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await fetch(`${BASE}/${table}`, {
      method: "POST",
      headers: H,
      body: JSON.stringify(rows.slice(i, i + CHUNK)),
    });
    if (!res.ok) {
      throw new Error(`insert ${table} [${i}] -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
  }
  console.log(`  ${table}: ${rows.length} rows`);
}

async function main() {
  console.log(`Seeding a ${BACKLOG}-row cancel-outbox backlog into ${BASE} ...`);

  const bucket = (await getJson(`buckets?org_id=eq.${ORG_ID}&select=id,code&limit=1`))[0];
  if (!bucket) throw new Error("No buckets found: run scripts/loadtest/seed.ts first.");
  const agents = await getJson(`users?org_id=eq.${ORG_ID}&select=id,email&limit=${Math.min(BACKLOG, 200)}`);
  if (agents.length === 0) throw new Error("No users found: run scripts/loadtest/seed.ts first.");

  // One stubbed webhook endpoint so NOTIFY has a subscriber (the POST itself is
  // short-circuited by SLATE_LOADTEST in emit.ts). The dedupe unique index does
  // the exactly-once work we want to observe.
  await insert("webhook_endpoints", [
    {
      id: randomUUID(),
      org_id: ORG_ID,
      url: "https://loadtest.invalid/sink",
      secret: "lt-secret",
      // Derived, never a hand kept copy of the same list (L41): a seeded endpoint
      // that missed an event would leave the drain firing into nobody, which is the
      // exact silence #1459 is about, and the run would still read as healthy.
      events: WEBHOOK_EVENTS,
      format: "generic",
      active: true,
    },
  ]);

  const startMs = Date.now() + 2 * 86_400_000; // a couple of days out, all identical
  const bookings: unknown[] = [];
  const busyBlocks: unknown[] = [];
  const outbox: unknown[] = [];

  for (let i = 0; i < BACKLOG; i++) {
    const agent = agents[i % agents.length];
    const bookingId = randomUUID();
    const start = new Date(startMs + i * 60_000).toISOString();
    const end = new Date(startMs + i * 60_000 + 30 * 60_000).toISOString();
    bookings.push({
      id: bookingId,
      org_id: ORG_ID,
      bucket_id: bucket.id,
      event_type_id: EVENT_TYPE_ID,
      assigned_user_id: agent.id,
      agent_email: agent.email,
      starts_at: start,
      ends_at: end,
      timezone: "America/New_York",
      status: "cancelled", // the cancel committed; only the side effects are pending
      manage_token: `lt-mt-${i}`,
    });
    busyBlocks.push({
      id: randomUUID(),
      user_id: agent.id,
      starts_at: start,
      ends_at: end,
      source: "slate",
      booking_id: bookingId,
    });
    // Rotate the crash point: after gcal_delete (1), after busyblock_delete (2),
    // after recompute (3, the webhook-loss window). Every row still owes NOTIFY,
    // so every row produces exactly one booking.cancelled.
    outbox.push({
      id: randomUUID(),
      booking_id: bookingId,
      action: "cancel",
      status: "pending",
      steps: stepsCrashedAfter(1 + (i % 3)),
      payload: { reasonCode: "no_longer_interested", initiator: "system" },
    });
  }

  await insert("bookings", bookings);
  await insert("busy_blocks", busyBlocks);
  await insert("booking_outbox", outbox);

  console.log(
    `Done. ${bookings.length} cancelled bookings, ${busyBlocks.length} stuck busy_blocks, ` +
      `${outbox.length} pending cancel-outbox rows. Drive /api/cron/outbox to self-heal them.`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
