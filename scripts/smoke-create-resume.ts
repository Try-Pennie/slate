// Post-deploy smoke for the crash-safe create resume + exactly-once
// booking.created (#668, closing the verification gap left by #613/#429). The
// #613 fix is otherwise only proven against the in-memory fake in
// scripts/test-booking-orchestration.ts; this exercises the REAL safety net end
// to end on production Postgres + deployed code:
//
//   1. Book a throwaway SMOKE-bucket appointment via the key-authed direct API
//      (fires booking.created once, deletes its reservation).
//   2. Simulate a crash AFTER the insert but BEFORE the webhook: inject a pending
//      booking_reservations row for that same booking (buildResumeReservation).
//   3. Drive the DEPLOYED reservation drain (GET /api/cron/outbox): it finds the
//      booking already inserted, re-runs the idempotent side effects, and
//      RE-FIRES booking.created.
//   4. Assert the webhook_deliveries dedupe collapsed the re-fire to nothing:
//      exactly the same number of booking.created rows as before the resume.
//   5. Teardown: cancel the booking; drop any stray reservation.
//
// It hits PRODUCTION (creates a real, then-cancelled booking on smoketest@'s
// calendar; attendee is a plus-alias of that mailbox) and fires a real
// booking.created to the org's endpoints, exactly as smoke-reschedule.ts fires
// booking.rescheduled. Run it manually:
//
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/smoke-create-resume.ts
//
// Required env (from .env.local or the process env; process env wins):
//   BOOKING_API_KEY_CANARY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, CRON_SECRET
// Optional: SLATE_BASE_URL (default prod), SMOKE_BUCKET (default SMOKE).

import { buildResumeReservation, type PersistedBookingRow } from "./create-resume-reservation.ts";
import { envOr, loadEnvFiles } from "./smoke-env.ts";
import { jpost, slots, tokenFrom, createChecker, type Json } from "./smoke-lib.ts";
import { smokeAttendee } from "./lib/smoke-identity.ts";
import { cancelSmokeBooking, createRefusal, teardownCheckMessage } from "./lib/smoke-own-booking.ts";

// --- config -----------------------------------------------------------------

// Keys load from .env.local if not already in the environment (process env wins).
loadEnvFiles([".env.local"]);
// envOr, not `??`: a workflow wiring SLATE_BASE_URL from an unset repo variable
// passes an EMPTY STRING, which `??` would accept as the base URL (#1494).
const BASE = envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app").replace(/\/$/, "");
const KEY = process.env.BOOKING_API_KEY_CANARY ?? "";
const SB_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
const CRON = process.env.CRON_SECRET ?? "";
const BUCKET = process.env.SMOKE_BUCKET ?? "SMOKE";

const { check, failed } = createChecker();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- HTTP helpers ------------------------------------------------------------

// PostgREST against the same project the deployed app writes to.
const PG = `${SB_URL}/rest/v1`;
const PG_H = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" };

async function pgGet<T>(path: string): Promise<T> {
  const res = await fetch(`${PG}/${path}`, { headers: PG_H });
  const body = (await res.json().catch(() => [])) as T;
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function pgPost(path: string, body: unknown, prefer = "return=representation"): Promise<{ status: number; rows: Json[] }> {
  const res = await fetch(`${PG}/${path}`, {
    method: "POST",
    headers: { ...PG_H, Prefer: prefer },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, rows: text ? (JSON.parse(text) as Json[]) : [] };
}

async function pgDelete(path: string): Promise<number> {
  const res = await fetch(`${PG}/${path}`, { method: "DELETE", headers: { ...PG_H, Prefer: "return=representation" } });
  const text = await res.text();
  return text ? (JSON.parse(text) as Json[]).length : res.ok ? 0 : -1;
}

/** Rows in webhook_deliveries for this booking's booking.created (dedupe_key = booking id). */
async function createdDeliveryCount(bookingId: string): Promise<number> {
  // cap-safe: filtered to ONE booking's booking.created (dedupe_key = booking id);
  // at most one row per endpoint, so well under one PostgREST page (#730).
  const rows = await pgGet<Json[]>(
    `webhook_deliveries?select=id&event=eq.booking.created&dedupe_key=eq.${encodeURIComponent(bookingId)}`,
  );
  return rows.length;
}

async function driveDrain(): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BASE}/api/cron/outbox`, { headers: { authorization: `Bearer ${CRON}` } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

const BOOKING_COLS =
  "org_id,bucket_id,event_type_id,assigned_user_id,agent_name,agent_email,starts_at,ends_at," +
  "original_starts_at,original_ends_at,timezone,status,salesforce_id,attendee_name,attendee_email," +
  "attendee_phone,prefill,gcal_event_id,manage_token,idempotency_key,external_id,routing_trace";

// --- run ---------------------------------------------------------------------

async function main(): Promise<void> {
  const missing = [
    ["BOOKING_API_KEY_CANARY", KEY],
    ["NEXT_PUBLIC_SUPABASE_URL", SB_URL],
    ["SUPABASE_SECRET_KEY", SB_KEY],
    ["CRON_SECRET", CRON],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")} (set them in .env.local or the process env).`);
    process.exit(2);
  }

  console.log(`# create-resume smoke vs ${BASE} (bucket ${BUCKET})`);
  const open = await slots(BUCKET);
  check(open.length >= 1, `SMOKE has >= 1 future slot (got ${open.length})`);
  if (open.length < 1) process.exit(1);
  const start = open[0];

  // #4060: a per run identity (email, external id AND phone). The fixed
  // `smoketest+resume@` and +12025550123 weak matched any booking an earlier run of
  // this or the reschedule smoke left active, turning this create into a 409.
  const { externalId, email, phone } = smokeAttendee("resume");
  let token = "";
  let bookingId = "";
  let idempotencyKey = "";

  try {
    // 1. Book a throwaway appointment via the direct API.
    const created = await jpost(
      "/api/bookings",
      {
        bucketCode: BUCKET,
        start,
        timezone: "America/New_York",
        attendee: { name: "Resume Smoke", email, phone },
        externalId,
        confirmReschedule: false,
        dryRun: false,
      },
      true,
    );
    // #4060: only a 200 `created` is this run's booking; any other answer carries one
    // this run did not make, so stop rather than resume and cancel it.
    const refused = createRefusal(created);
    check(
      refused === null,
      `create -> 200 created (${refused ?? `got ${created.status}`}${refused !== null && created.body.error ? ` err=${created.body.error}` : ""})`,
    );
    if (refused !== null) return;
    const b = created.body.booking as Json | undefined;
    bookingId = String(b?.id ?? "");
    token = tokenFrom(b?.manageUrl);
    check(!!bookingId, "create returns a booking id");
    check(!!token, "create returns a manage token");
    if (!bookingId) return;

    // 2. Read the persisted booking row (the shape buildResumeReservation needs).
    const rows = await pgGet<PersistedBookingRow[]>(`bookings?select=${BOOKING_COLS}&id=eq.${bookingId}`);
    const row = rows[0];
    check(!!row, "booking row is readable via PostgREST");
    if (!row) return;
    idempotencyKey = row.idempotency_key ?? "";
    check(!!idempotencyKey, "the direct-API booking has a stable idempotency key");

    // 3. Preconditions for observing dedupe: at least one active endpoint is
    //    subscribed to booking.created, and the create already recorded exactly
    //    one delivery per endpoint. Without an endpoint the dedupe is invisible.
    // cap-safe: one org's active booking.created endpoints, a handful at most
    // (well under one PostgREST page); the count is the assertion, not a sample (#730).
    const endpoints = await pgGet<Json[]>(
      `webhook_endpoints?select=id&org_id=eq.${row.org_id}&active=eq.true&events=cs.%7Bbooking.created%7D`,
    );
    const n = endpoints.length;
    check(n >= 1, `org has >= 1 active booking.created endpoint (got ${n}); required to observe the dedupe`);
    if (n < 1) return;

    const before = await createdDeliveryCount(bookingId);
    check(before === n, `baseline: exactly ${n} booking.created delivery row(s) after create (got ${before})`);

    // 4. Simulate crash-after-insert: inject a pending reservation for this booking.
    const resv = buildResumeReservation(row, BUCKET);
    const ins = await pgPost("booking_reservations", resv);
    check(ins.status === 201, `injected the pending resume reservation (got ${ins.status})`);

    // 5. Drive the deployed reservation drain (retry past the cron lock).
    let drained = false;
    for (let i = 0; i < 5 && !drained; i++) {
      const d = await driveDrain();
      check(d.status === 200, `drain -> 200 (attempt ${i + 1}, got ${d.status})`);
      const skipped = (d.body as { skipped?: string }).skipped;
      if (skipped) {
        console.log(`  drain skipped (${skipped}); retrying`);
        await sleep(1500);
        continue;
      }
      drained = true;
    }
    check(drained, "drain ran (not perpetually lock-skipped)");

    // 6. The drain deletes the reservation on success; poll for it to clear.
    let reservationGone = false;
    for (let i = 0; i < 6 && !reservationGone; i++) {
      // cap-safe: idempotency_key is unique, so this returns at most one row (#730).
      const still = await pgGet<Json[]>(
        `booking_reservations?select=id&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`,
      );
      if (still.length === 0) reservationGone = true;
      else await sleep(1000);
    }
    check(reservationGone, "drain resumed and deleted the injected reservation");

    // 7. THE ASSERTION: the re-fired booking.created was deduped away; the row
    //    count is unchanged. This is the exactly-once guarantee, proven on real
    //    Postgres against the real webhook_deliveries partial-unique index.
    const after = await createdDeliveryCount(bookingId);
    check(
      after === before,
      `exactly-once: booking.created delivery count unchanged after resume (${before} -> ${after})`,
    );
  } finally {
    // 8. Teardown: cancel the booking, then drop any reservation the drain left.
    if (token) {
      const cancelled = await cancelSmokeBooking(jpost, token);
      check(cancelled.ok, teardownCheckMessage(bookingId, cancelled));
    }
    if (idempotencyKey) {
      const deleted = await pgDelete(
        `booking_reservations?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`,
      ).catch(() => -1);
      if (deleted > 0) console.log(`  teardown: removed ${deleted} stray reservation row(s)`);
    }
  }

  console.log(failed() === 0 ? "\nSMOKE PASSED" : `\n${failed()} CHECK(S) FAILED`);
  process.exit(failed() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
