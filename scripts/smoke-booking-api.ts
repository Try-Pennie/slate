// Manual smoke test for the live direct booking API (#253/#250). NOT a CI test
// (it hits production and creates REAL, then-cancelled bookings) — run it by
// hand to validate the endpoint end to end after setting BOOKING_API_KEY.
//
//   BOOKING_API_KEY=xxx node --experimental-strip-types scripts/smoke-booking-api.ts
//
// Optional env:
//   SLATE_BASE_URL  (default https://slate.trypennie.app)
//   SMOKE_BUCKET    (default SMOKE)      — the primary bucket. Defaults to the
//                                          ISOLATED test bucket (sole member:
//                                          smoketest@trypennie.com), so a run
//                                          never books a real round-robin agent.
//   SMOKE_BUCKET_B  (default SMOKE2)     — a SECOND isolated bucket the test
//                                          agent also serves; enables the
//                                          cross-bucket move scenario.
//   REASSIGN_API_KEY (default unset)     — Bearer key for POST /api/bookings/reassign;
//                                          enables the reassign scenario (else it SKIPs).
//   SMOKE_AGENT_B_EMAIL (default          — the SECOND test agent the reassign scenario
//     smoketest2@trypennie.com)             moves the booking onto. Must be a real
//                                          Workspace mailbox in NO smoke bucket (so
//                                          round-robin never picks it). Seed it with
//                                          scripts/seed-smoke-test.ts.
//   SMOKE_DRY_RUN_ONLY (default unset)   — run ONLY scenario 0 (zero side effects);
//                                          a safe health check against the live fleet.
//   SMOKE_STRICT       (default unset)   — treat any SKIPped scenario as a failure
//                                          (non-zero exit), so CI/cron can require
//                                          full coverage rather than a quiet skip.
//
// Isolation (#396): the default buckets route only to the dedicated test agent,
// whose email is the real smoketest@trypennie.com mailbox; synthetic attendees
// are plus-aliases of it (smoketest+<tag>@), so invite/cancel emails deliver
// into that inbox instead of bouncing "undeliverable" notices onto a real agent.
// Seed the agent + buckets with scripts/seed-smoke-test.ts. Override SMOKE_BUCKET
// only to deliberately exercise a live bucket.
//
// Teardown: each scenario cancels its own bookings, and a guaranteed sweep
// cancels every active booking under every identity it booked under — running
// from a finally block, so a partway failure never leaks a live booking onto the
// fleet.
//
// Scenarios (each uses a fresh identity + cleans up its bookings):
//   0. dry run -> validates routing with NO booking/event/webhook (side-effect-free)
//   1. create -> deduped (same slot) -> rescheduled (different time), same bucket
//   2. cross-bucket move: book in A, rebook the same person into B -> new booking
//   3. confirm path: a weak (email-only) match on a new time -> confirm_required,
//      then the same call with confirmReschedule:true -> rescheduled
//   6. reassign: book -> POST /api/bookings/reassign onto the OTHER SMOKE agent
//      (whichever one it did not land on) -> assert the booking moved (response +
//      an independent re-GET), then cancel. The endpoint runs the reassign outbox
//      INLINE before returning 200, so a moved agent IS proof of delivery.
//   7. reschedule stickiness (#523): book -> reschedule by less than the event
//      length (new slot overlaps the booking's own event) -> assert it stayed on
//      the SAME agent (no silent re-route in the two-agent SMOKE bucket, #464).
//
// Keys (BOOKING_API_KEY, REASSIGN_API_KEY, ...) load from .env.local / .dev.vars
// if not already in the environment, so a plain `node … smoke-booking-api.ts`
// works without exporting them by hand (and without `source`, which dies on an
// unmatched quote anywhere in the file).
import { loadEnvFiles } from "./smoke-env.ts";
import { evaluateSlotAvailability, slots } from "./smoke-lib.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const BASE = (process.env.SLATE_BASE_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
// Default to the ISOLATED test buckets (#396): they have a single dedicated
// member (smoketest@trypennie.com) so a smoke run never books a real
// round-robin agent. Override SMOKE_BUCKET/SMOKE_BUCKET_B only to deliberately
// exercise a live bucket. (Booking real agents with the synthetic smoke+
// attendee is what bounced "undeliverable" notices onto agents like marnold.)
const BUCKET_A = process.env.SMOKE_BUCKET ?? "SMOKE";
const BUCKET_B = process.env.SMOKE_BUCKET_B ?? "SMOKE2";
const KEY = process.env.BOOKING_API_KEY ?? "";
// Reassign scenario (#450): a separate Bearer key (the owner-override API) and
// the second test agent the booking is forced onto. Defaults to the seeded
// smoketest2@ target; the scenario SKIPs if REASSIGN_API_KEY is unset.
const REASSIGN_KEY = process.env.REASSIGN_API_KEY ?? "";
const AGENT_B_EMAIL = process.env.SMOKE_AGENT_B_EMAIL ?? "smoketest2@trypennie.com";
// SMOKE's two bookable agents (#464): the booking can land on either, so the
// reassign scenario targets whichever one it did NOT land on.
const AGENT_A_EMAIL = process.env.SMOKE_AGENT_A_EMAIL ?? "smoketest@trypennie.com";

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log(`SKIP: ${msg}`);
  skipped++;
}

/** Final line. Skips are surfaced loudly so a clean run is never mistaken for
 *  full coverage (#397); SMOKE_STRICT=1 makes any skip a non-zero exit. */
function printSummaryAndExit() {
  const skipNote = skipped > 0 ? ` (${skipped} SKIPPED — coverage incomplete)` : "";
  console.log(failures === 0 ? `\nALL CHECKS PASSED${skipNote}` : `\n${failures} CHECK(S) FAILED${skipNote}`);
  const strictFail = !!process.env.SMOKE_STRICT && skipped > 0;
  process.exit(failures === 0 && !strictFail ? 0 : 1);
}

type BookBody = {
  outcome?: string;
  booking?: { id?: string; manageUrl?: string };
  dryRun?: boolean;
  wouldAssign?: { id?: string; name?: string | null; email?: string | null } | null;
  error?: string;
  code?: string;
};

type Agent = { name?: string | null; email?: string | null };
type DirectBody = {
  bookings?: Array<{ id: string; manageUrl?: string; status?: string; bucketCode?: string; agent?: Agent }>;
  booking?: { id: string; manageUrl?: string; status?: string; agent?: Agent };
  outcome?: string;
  code?: string;
  error?: string;
};

// Reassign API (#450) response shape: { booking: { id, agentEmail, status, ... } }.
type ReassignBody = {
  booking?: { id?: string; assignedUserId?: string | null; agentEmail?: string | null; status?: string };
  error?: string;
};

async function req(method: string, path: string): Promise<{ status: number; body: DirectBody }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}` },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as DirectBody };
}

async function book(args: {
  bucket: string;
  start: string;
  externalId: string;
  email: string;
  phone: string;
  confirmReschedule?: boolean;
  dryRun?: boolean;
}): Promise<{ status: number; body: BookBody }> {
  // Record the identity up front (even for a dry run or a call that errors) so
  // the guaranteed teardown (#396) can sweep it regardless of what came back.
  if (!args.dryRun) identitiesToClean.add(args.externalId);
  const res = await fetch(`${BASE}/api/bookings`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      bucketCode: args.bucket,
      start: args.start,
      timezone: "America/New_York",
      attendee: { name: "Smoke Test", email: args.email, phone: args.phone },
      externalId: args.externalId,
      confirmReschedule: args.confirmReschedule ?? false,
      dryRun: args.dryRun ?? false,
    }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as BookBody };
}

// Owner-override reassign (#9/#450): forces an existing booking onto a specific
// agent. Authed with its OWN key (REASSIGN_API_KEY), distinct from the booking key.
async function reassign(bookingId: string, agentEmail: string): Promise<{ status: number; body: ReassignBody }> {
  const res = await fetch(`${BASE}/api/bookings/reassign`, {
    method: "POST",
    headers: { authorization: `Bearer ${REASSIGN_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      bookingId,
      agentEmail,
      reasonCode: "owner_reassignment",
      reasonDetail: "smoke test",
    }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ReassignBody };
}

const tokensToClean: string[] = [];
// Every identity (externalId) we book under, swept on teardown (#396).
const identitiesToClean = new Set<string>();
function trackForCleanup(body: BookBody) {
  const m = (body.booking?.manageUrl ?? "").match(/\/booking\/manage\/([^/?#]+)/);
  if (m) tokensToClean.push(m[1]);
}
async function cleanup() {
  // Primary: cancel tracked manage tokens.
  for (const token of [...new Set(tokensToClean)]) {
    await fetch(`${BASE}/api/bookings/${token}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "no_longer_interested" }),
    }).catch(() => {});
  }
  tokensToClean.length = 0;

  // Guaranteed teardown (#396): sweep every identity we booked under and cancel
  // any still-active booking by id — including ones we never tracked (e.g. a
  // response whose manageUrl we couldn't parse). This runs from the finally
  // block too, so a partway failure never leaks a live booking onto the fleet.
  for (const externalId of identitiesToClean) {
    const list = await req("GET", `/api/bookings?externalId=${encodeURIComponent(externalId)}`).catch(() => null);
    for (const b of list?.body.bookings ?? []) {
      if (!b.id) continue;
      await req("DELETE", `/api/bookings?externalId=${encodeURIComponent(externalId)}&bookingId=${b.id}`).catch(() => {});
    }
  }
  identitiesToClean.clear();
}

function uniq(tag: string) {
  const n = Date.now();
  // Attendee address is a plus-alias of the real smoketest@trypennie.com mailbox
  // (the test agent itself), so Google's invite/cancel emails DELIVER into that
  // inbox instead of bouncing an "undeliverable" notice onto the organizer (#396).
  return { externalId: `smoke-${tag}-${n}`, email: `smoketest+${tag}-${n}@trypennie.com` };
}

// A reschedule target a safe margin LATER than `from` (default 60 min). Slots are
// published at a FINER granularity than the event is long (e.g. 10-min slots for
// a 20-min event), so the slot immediately after `from` OVERLAPS its still-present
// event. Rescheduling onto an overlapping slot makes the sole test agent read its
// own current event as a conflict, forcing a re-route the single-member bucket
// can't satisfy (NO_ELIGIBLE_AGENTS). A safe-margin target keeps it in-place.
function laterSlot(slots: string[], from: string, minGapMs = 60 * 60 * 1000): string | undefined {
  const fromMs = new Date(from).getTime();
  return slots.find((s) => new Date(s).getTime() - fromMs >= minGapMs);
}

// --- Scenario 0: dry run — validate routing with ZERO side effects ---
async function scenarioDryRun(slotsA: string[]) {
  console.log("\n[0] dry run (no calendar event, no booking, no webhook)");
  const id = uniq("dryrun");
  const res = await book({ bucket: BUCKET_A, start: slotsA[0], ...id, phone: "+12155550100", dryRun: true });
  check(res.status === 200 && res.body.dryRun === true, `dry run -> 200 dryRun:true (got ${res.status}/${res.body.dryRun})`);
  check(res.body.outcome === "created", `dry run -> would create (got ${res.body.outcome})`);
  check(!!res.body.wouldAssign?.email, `dry run names the agent who WOULD be assigned (${res.body.wouldAssign?.email ?? "none"})`);
  check(!res.body.booking, "dry run returns NO booking (nothing was created)");
}

// --- Scenario 1: create / dedupe / reschedule within one bucket ---
async function scenarioMain(slotsA: string[]) {
  console.log("\n[1] create -> deduped -> rescheduled (same bucket)");
  const id = uniq("main");
  // Distinct slot per scenario (the single test agent is shared); cleanup runs
  // between scenarios, so holds release before the next one books. slotB is a
  // safe margin LATER than slotA (not the adjacent slot) so the reschedule
  // target doesn't overlap slotA's own event — see laterSlot.
  const slotA = slotsA[0];
  const slotB = laterSlot(slotsA, slotA);
  const phone = "+12155550100";
  if (!slotB) {
    check(false, "need a non-overlapping later slot to reschedule into");
    return;
  }

  const created = await book({ bucket: BUCKET_A, start: slotA, ...id, phone });
  trackForCleanup(created.body);
  check(created.status === 200 && created.body.outcome === "created", `book -> created (got ${created.status}/${created.body.outcome})`);

  const dup = await book({ bucket: BUCKET_A, start: slotA, ...id, phone });
  check(dup.body.outcome === "deduped" && dup.body.booking?.id === created.body.booking?.id, "same slot -> deduped (same booking id)");

  const moved = await book({ bucket: BUCKET_A, start: slotB, ...id, phone });
  trackForCleanup(moved.body);
  check(moved.body.outcome === "rescheduled", `different time -> rescheduled (got ${moved.body.outcome})`);
  check(moved.body.booking?.id === created.body.booking?.id, "same-bucket reschedule keeps the same booking id");
}

// --- Scenario 2: cross-bucket move (book in A, rebook same person into B) ---
async function scenarioCrossBucket(slotsA: string[]) {
  console.log("\n[2] cross-bucket move (rebook same person into a different bucket)");
  if (!BUCKET_B) {
    skip("SMOKE_BUCKET_B not set — set it to a second bucket your test agent serves to run this");
    return;
  }
  const slotsB = await slots(BUCKET_B);
  if (slotsB.length === 0) {
    skip(`bucket ${BUCKET_B} has no open slots`);
    return;
  }
  const id = uniq("xbucket");
  const phone = "+12155550101";

  const inA = await book({ bucket: BUCKET_A, start: slotsA[2], ...id, phone });
  trackForCleanup(inA.body);
  check(inA.body.outcome === "created", `book in bucket ${BUCKET_A} -> created (got ${inA.body.outcome})`);

  const inB = await book({ bucket: BUCKET_B, start: slotsB[0], ...id, phone });
  trackForCleanup(inB.body);
  check(inB.body.outcome === "rescheduled", `rebook into bucket ${BUCKET_B} -> rescheduled (got ${inB.body.outcome})`);
  check(
    !!inB.body.booking?.id && inB.body.booking?.id !== inA.body.booking?.id,
    "cross-bucket move creates a NEW booking (different id), not an in-place reschedule",
  );
}

// --- Scenario 3: weak (email-only) match -> confirm_required, then confirm ---
async function scenarioConfirm(slotsA: string[]) {
  console.log("\n[3] weak match -> confirm_required -> confirm -> rescheduled");
  const id1 = uniq("confirm");
  // slotB is a safe margin LATER than slotA (not the adjacent slot) so the
  // confirmed reschedule stays in-place rather than overlapping slotA — see
  // laterSlot.
  const slotA = slotsA[3];
  const slotB = laterSlot(slotsA, slotA);
  if (!slotB) {
    check(false, "need a non-overlapping later slot for the confirm reschedule");
    return;
  }

  // Existing appointment for this email (phone P1, externalId E1).
  const created = await book({ bucket: BUCKET_A, start: slotA, externalId: id1.externalId, email: id1.email, phone: "+12155550110" });
  trackForCleanup(created.body);
  check(created.body.outcome === "created", `seed booking -> created (got ${created.body.outcome})`);

  // New call: SAME email, DIFFERENT externalId + phone, different time -> weak match.
  const weak = {
    bucket: BUCKET_A,
    start: slotB,
    externalId: `${id1.externalId}-other`,
    email: id1.email,
    phone: "+12155550999",
  };
  const asked = await book({ ...weak, confirmReschedule: false });
  check(asked.status === 409 && asked.body.outcome === "confirm_required", `weak match + new time -> 409 confirm_required (got ${asked.status}/${asked.body.outcome})`);
  check(asked.body.booking?.id === created.body.booking?.id, "confirm_required returns the EXISTING booking (no new one created)");

  const confirmed = await book({ ...weak, confirmReschedule: true });
  trackForCleanup(confirmed.body);
  check(confirmed.body.outcome === "rescheduled", `same call with confirmReschedule:true -> rescheduled (got ${confirmed.body.outcome})`);
}

// --- Scenario 4: GET lookup (list + by-id + status filter) + DELETE-by-id ---
async function scenarioLookupAndCancel(slotsA: string[]) {
  console.log("\n[4] GET list / GET by-id / GET by-id+status / DELETE by-id");
  const id = uniq("lookup");
  // Unique phone per run too (not just externalId/email): a fixed phone lets a
  // leftover active booking from an earlier run weak-match this seed and turn it
  // into confirm_required, breaking the scenario. The 555-01xx range is reserved
  // for test use; the run timestamp keeps each run's number distinct.
  const phone = `+1215555${String(Date.now()).slice(-4)}`;

  const created = await book({ bucket: BUCKET_A, start: slotsA[0], ...id, phone });
  check(created.status === 200 && created.body.outcome === "created", `seed booking -> created (got ${created.status}/${created.body.outcome})`);
  const bookingId = created.body.booking?.id;
  if (!bookingId) {
    check(false, "seed booking returned a booking id (needed for lookup checks)");
    return;
  }
  // Fallback cleanup: DELETE-by-id below is the primary cleanup, but if it fails
  // (e.g. the endpoint isn't deployed yet) track the seed so the final cleanup()
  // still cancels it instead of leaking an active booking into the next run.
  trackForCleanup(created.body);

  // GET list — the booked person has at least one active booking.
  const listRes = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}`);
  check(
    listRes.status === 200 && Array.isArray(listRes.body.bookings) && (listRes.body.bookings?.length ?? 0) >= 1,
    "GET list returns the person's active booking(s)",
  );

  // GET by id — returns that one booking with a manageUrl.
  const oneRes = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(
    oneRes.status === 200 && oneRes.body.booking?.id === bookingId && !!oneRes.body.booking?.manageUrl,
    "GET by id returns the booking + manageUrl",
  );

  // GET by id with a non-matching status assertion → 404.
  const missRes = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}&status=cancelled`);
  check(missRes.status === 404 && missRes.body.code === "NOT_FOUND", "GET by id with mismatched status filter -> 404 NOT_FOUND");

  // DELETE by id — cancels (this is also the cleanup for this scenario).
  const delRes = await req("DELETE", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(delRes.status === 200 && delRes.body.outcome === "cancelled", "DELETE by id cancels the booking");

  // Repeat DELETE → 404 (no longer active).
  const delAgain = await req("DELETE", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(delAgain.status === 404 && delAgain.body.code === "NOT_FOUND", "second DELETE -> 404 NOT_FOUND (already cancelled)");
}

// --- Scenario 5: list mode (cross-person, no externalId) ---
async function scenarioListMode() {
  console.log("\n[5] list mode (cross-person)");
  const listRes = await req("GET", `/api/bookings?bucket=${BUCKET_A}&limit=5`);
  check(listRes.status === 200 && Array.isArray(listRes.body.bookings),
    "GET list (no externalId) returns a bookings array");
  check(listRes.body.bookings?.every((b) => b.bucketCode === BUCKET_A) ?? true,
    "list rows are tagged with the filtered bucketCode");
  const blankExt = await req("GET", `/api/bookings?externalId=`);
  check(blankExt.status === 400, "blank externalId -> 400 (not a cross-person dump)");
}

// --- Scenario 6: reassign (owner-override move onto a second agent) ---
async function scenarioReassign(slotsA: string[]) {
  console.log("\n[6] reassign (force the booking onto a second test agent)");
  if (!REASSIGN_KEY) {
    skip("REASSIGN_API_KEY not set — set it to exercise the owner-override reassign path");
    return;
  }
  if (!AGENT_B_EMAIL) {
    skip("SMOKE_AGENT_B_EMAIL not set — set it to the second test agent's email");
    return;
  }
  const id = uniq("reassign");
  const phone = "+12155550120";

  const created = await book({ bucket: BUCKET_A, start: slotsA[0], ...id, phone });
  trackForCleanup(created.body);
  check(created.body.outcome === "created", `book in ${BUCKET_A} -> created (got ${created.body.outcome})`);
  const bookingId = created.body.booking?.id;
  if (!bookingId) {
    check(false, "booking returned an id (needed to reassign)");
    return;
  }

  // SMOKE has TWO bookable agents (#464), so the booking can land on either.
  // Pick the reassign target as whichever agent it is NOT currently on — a
  // same-agent reassign would no-op (returns the booking unchanged).
  const before = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  const landedOn = before.body.booking?.agent?.email;
  check(!!landedOn, `booking starts on a known agent (${landedOn ?? "none"})`);
  const target = landedOn === AGENT_B_EMAIL ? AGENT_A_EMAIL : AGENT_B_EMAIL;

  const moved = await reassign(bookingId, target);
  check(
    moved.status === 200 && moved.body.booking?.agentEmail === target,
    `reassign -> 200 + moved to ${target} (got ${moved.status}/${moved.body.booking?.agentEmail ?? "none"})`,
  );
  check(moved.body.booking?.id === bookingId, "reassign keeps the SAME booking id (in-place move, not a new booking)");

  // Independent re-read confirms the move persisted. The reassign endpoint runs
  // its outbox (slot move + booking.rescheduled webhook + 'reassigned' history)
  // INLINE before returning 200, so a moved agent here is also proof the outbox
  // delivered — the smoke test has no DB read to assert the row directly.
  const after = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(
    after.body.booking?.agent?.email === target,
    `re-GET shows the booking now assigned to ${target} (got ${after.body.booking?.agent?.email ?? "none"})`,
  );
}

// --- Scenario 7: reschedule stickiness (#523) — a reschedule SHORTER than the
// event length keeps the SAME agent, instead of silently re-routing to another.
// Meaningful only in the now-two-agent SMOKE bucket (#464): the new slot overlaps
// the booking's own still-present event, which the pre-#523 self-free check
// counted as a conflict, re-routing the booking to the other agent. ---
async function scenarioRescheduleStickiness(slotsA: string[]) {
  console.log("\n[7] sub-event-length reschedule keeps the same agent (#523)");
  const id = uniq("stick");
  const slot = slotsA[2];
  // +10 min on the 20-min SMOKE event: the new window [+10, +30] overlaps the
  // original [0, +20] event — the exact #523 trigger.
  const target = new Date(Date.parse(slot) + 10 * 60_000).toISOString();

  const created = await book({ bucket: BUCKET_A, start: slot, ...id, phone: "+12155550130" });
  trackForCleanup(created.body);
  check(created.body.outcome === "created", `book in ${BUCKET_A} -> created (got ${created.body.outcome})`);
  const bookingId = created.body.booking?.id;
  const token = (created.body.booking?.manageUrl ?? "").match(/\/booking\/manage\/([^/?#]+)/)?.[1];
  if (!bookingId || !token) {
    check(false, "booking returned an id + manage token (needed to reschedule)");
    return;
  }

  const before = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  const agentBefore = before.body.booking?.agent?.email;
  check(!!agentBefore, `booked onto an agent (${agentBefore ?? "none"})`);

  const moved = await fetch(`${BASE}/api/bookings/${token}/reschedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ start: target, reason: "schedule_conflict" }),
  });
  const movedBody = (await moved.json().catch(() => ({}))) as { startsAt?: string; error?: string };
  check(
    moved.status === 200,
    `sub-event reschedule -> 200 (got ${moved.status}${moved.status !== 200 ? ` err=${movedBody.error}` : ""})`,
  );

  const after = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(
    !!agentBefore && after.body.booking?.agent?.email === agentBefore,
    `STAYED on the same agent across the sub-event reschedule (before=${agentBefore}, after=${after.body.booking?.agent?.email ?? "none"})`,
  );
}

async function main() {
  if (!KEY) {
    console.error("Set BOOKING_API_KEY in the environment first.");
    process.exit(2);
  }
  console.log(`Smoke test against ${BASE} (bucket ${BUCKET_A}${BUCKET_B ? `, cross-bucket ${BUCKET_B}` : ""})`);

  // Gate on real availability before booking anything. Zero slots means the
  // isolated test agent is misconfigured, so the run would exercise NOTHING;
  // that must fail LOUDLY as a configuration error, never exit quietly in a way
  // that reads as a pass (#456). A thin-but-nonzero window is a distinct failure.
  const slotsA = await slots(BUCKET_A);
  const availability = evaluateSlotAvailability(BUCKET_A, slotsA.length);
  check(availability.ok, `bucket ${BUCKET_A} has enough open slots (got ${slotsA.length})`);
  if (!availability.ok) {
    console.error(`\n${availability.message}`);
    process.exit(availability.kind === "setup_broken" ? 3 : 1);
  }

  // SMOKE_DRY_RUN_ONLY=1 runs ONLY the side-effect-free dry-run check — a safe
  // health check you can run anytime against the live fleet (no real bookings).
  if (process.env.SMOKE_DRY_RUN_ONLY) {
    await scenarioDryRun(slotsA);
    printSummaryAndExit();
  }

  // Clean up between scenarios (not just at the end): the single test agent is
  // shared, so releasing each scenario's holds keeps the next one's slots free.
  // Scenario 4 (lookup + cancel) uses DELETE-by-id for its own cleanup.
  try {
    await scenarioDryRun(slotsA);
    await scenarioMain(slotsA);
    await cleanup();
    await scenarioCrossBucket(slotsA);
    await cleanup();
    await scenarioConfirm(slotsA);
    await cleanup();
    await scenarioLookupAndCancel(slotsA);
    await scenarioListMode();
    await cleanup();
    await scenarioReassign(slotsA);
    await cleanup();
    await scenarioRescheduleStickiness(slotsA);
  } finally {
    console.log("\nCleaning up test bookings...");
    await cleanup();
  }

  printSummaryAndExit();
}

void main();
