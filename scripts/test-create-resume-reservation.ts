// Unit tests for the #668 create-resume reservation builder. Pure; no DB.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-create-resume-reservation.ts
import {
  buildResumeReservation,
  type PersistedBookingRow,
} from "./create-resume-reservation.ts";
import { assert, finish } from "./lib/harness.ts";

const row: PersistedBookingRow = {
  org_id: "org1",
  bucket_id: "bkt1",
  event_type_id: "et1",
  assigned_user_id: "agent-1",
  agent_name: "Smoke Agent",
  agent_email: "smoketest@trypennie.com",
  starts_at: "2026-08-01T13:00:00.000Z",
  ends_at: "2026-08-01T13:30:00.000Z",
  original_starts_at: "2026-08-01T13:00:00.000Z",
  original_ends_at: "2026-08-01T13:30:00.000Z",
  timezone: "America/New_York",
  status: "confirmed",
  salesforce_id: "smoke-ext-1",
  attendee_name: "Resume Smoke",
  attendee_email: "smoketest+resume@trypennie.com",
  attendee_phone: "+12025550123",
  prefill: { xbc: "SMOKE" },
  gcal_event_id: "slateabc123",
  manage_token: "tok-abc",
  idempotency_key: "SMOKE|2026-08-01T13:00:00.000Z|smoketest+resume@trypennie.com||smoke-ext-1",
  external_id: "smoke-ext-1",
  routing_trace: {
    bucket_code: "SMOKE",
    bucket_id: "bkt1",
    considered: ["agent-1"],
    chosen_user_id: "agent-1",
    fallback_applied: false,
  },
};

// Happy path: the resume reservation is keyed + pinned off the persisted booking.
{
  const r = buildResumeReservation(row, "SMOKE");
  assert(r.idempotency_key === row.idempotency_key, "reservation reuses the booking's idempotency key (the resume lookup key)");
  assert(r.pinned_user_id === "agent-1", "pins the booking's assigned agent");
  assert(r.pinned_agent_email === "smoketest@trypennie.com", "pins the agent email");
  assert(
    r.gcal_client_id === "slateabc123",
    "pins the stored gcal_event_id as the client id (409-reuse on re-create)",
  );
  assert(
    r.payload.booking.idempotency_key === row.idempotency_key,
    "payload booking carries the same key completeReservation looks up by",
  );
  assert(
    r.payload.booking.routing_trace.bucket_code === "SMOKE",
    "payload booking preserves the routing trace (drain prefers it for the bucket code)",
  );
  assert(r.payload.bucketCode === "SMOKE", "payload carries the fallback bucket code");
  assert(
    r.payload.event.start === row.starts_at && r.payload.event.end === row.ends_at,
    "payload event mirrors the booked window",
  );
}

// Failure path: a keyless booking can't seed a resume (no lookup key, and the
// real keyless-create path never leaves this row shape).
{
  let threw = false;
  try {
    buildResumeReservation({ ...row, idempotency_key: null }, "SMOKE");
  } catch {
    threw = true;
  }
  assert(threw, "throws when the booking has no idempotency key");
}

// Failure path: the reservation's pinned columns are NOT NULL, so a booking with
// no assigned agent must be rejected rather than producing an invalid row.
{
  let threwNoUser = false;
  try {
    buildResumeReservation({ ...row, assigned_user_id: null as unknown as string }, "SMOKE");
  } catch {
    threwNoUser = true;
  }
  assert(threwNoUser, "throws when the booking has no assigned user");

  let threwNoEmail = false;
  try {
    buildResumeReservation({ ...row, agent_email: null }, "SMOKE");
  } catch {
    threwNoEmail = true;
  }
  assert(threwNoEmail, "throws when the booking has no agent email");
}

finish();
