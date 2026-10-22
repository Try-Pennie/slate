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
// BOOKING_API_KEY_CANARY):
//
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/smoke-523-stickiness.ts
//
// Optional env: SLATE_BASE_URL (default prod).
import { DateTime } from "luxon";
import { envOr, loadEnvFiles } from "./smoke-env.ts";
import { jpost, slots, tokenFrom, createChecker, type Json } from "./smoke-lib.ts";
import { smokeAttendee } from "./lib/smoke-identity.ts";
import { recordSmokeCrash } from "./lib/smoke-crash.ts";
import {
  cancelSmokeBooking,
  createCheckMessage,
  createRefusal,
  teardownCheckMessage,
} from "./lib/smoke-own-booking.ts";

// Keys load from .env.local / .dev.vars if not already in the environment.
loadEnvFiles([".env.local", ".dev.vars"]);

// envOr, not `??`: a workflow wiring SLATE_BASE_URL from an unset repo variable
// passes an EMPTY STRING, which `??` would accept as the base URL (#1494).
const BASE = envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app").replace(/\/$/, "");
const KEY = process.env.BOOKING_API_KEY_CANARY ?? "";
const BUCKET = "SMOKE";
const SMOKE_BUCKET_ID = "44004a29-da8a-47fe-9ebc-6a95bccd1bfc";
const SMOKETEST2_ID = "c0000000-0000-4000-8000-000000000002";

const { check, failed } = createChecker();

async function main(): Promise<void> {
  if (!KEY) {
    console.error("Set BOOKING_API_KEY_CANARY (or put it in .env.local / .dev.vars) first.");
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

  // #4060: a per run identity (email, external id AND phone). A fixed email or
  // phone weak matches any booking an earlier smoke run left active, so this create
  // would come back 409 carrying that booking instead of a new one.
  const { externalId, email, phone } = smokeAttendee("523");
  let token = "";
  let bookingId = "";
  try {
    // Pick a slot comfortably mid-shift so +30 min stays within 9-5 ET and free.
    const open = await slots(BUCKET);
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
        attendee: { name: "523 Repro", email, phone },
        externalId,
        confirmReschedule: false,
        dryRun: false,
      },
      true,
    );
    // #4060: only a 200 `created` is this run's booking; any other answer carries one
    // this run did not make, so stop rather than reschedule and cancel it.
    const refused = createRefusal(created);
    check(refused === null, createCheckMessage(created, refused));
    if (refused !== null) return;
    bookingId = String((created.body.booking as Json | undefined)?.id ?? "");
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
      const cancelled = await cancelSmokeBooking(jpost, token);
      check(cancelled.ok, teardownCheckMessage(bookingId, cancelled));
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

  console.log(failed() === 0 ? "\n523 REPRO PASSED (stickiness held)" : `\n${failed()} CHECK(S) FAILED`);
  process.exit(failed() === 0 ? 0 : 1);
}

// An early `return` from main (a refused create, no token) skips the exit at its
// end, and node would then exit 0 with a failed check recorded. Exit here by the
// failure count, so every path out of main reports what it recorded.
main().then(
  () => process.exit(failed() === 0 ? 0 : 1),
  (e) => {
    console.error("repro crashed:", e);
    recordSmokeCrash("The stickiness repro", e); // #4062
    process.exit(1);
  },
);
