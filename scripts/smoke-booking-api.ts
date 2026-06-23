// Manual smoke test for the live direct booking API (#253/#250). NOT a CI test
// (it hits production and creates REAL, then-cancelled bookings) — run it by
// hand to validate the endpoint end to end after setting BOOKING_API_KEY.
//
//   BOOKING_API_KEY=xxx node --experimental-strip-types scripts/smoke-booking-api.ts
//
// Optional env:
//   SLATE_BASE_URL  (default https://slate.trypennie.app)
//   SMOKE_BUCKET    (default 411)        — the primary bucket
//   SMOKE_BUCKET_B  (default unset)      — a SECOND bucket your test agent also
//                                          serves; enables the cross-bucket move
//                                          scenario. Skipped if unset/no slots.
//   SMOKE_DRY_RUN_ONLY (default unset)   — run ONLY scenario 0 (zero side effects);
//                                          a safe health check against the live fleet.
//
// Scenarios (each uses a fresh identity + cleans up its bookings):
//   0. dry run -> validates routing with NO booking/event/webhook (side-effect-free)
//   1. create -> deduped (same slot) -> rescheduled (different time), same bucket
//   2. cross-bucket move: book in A, rebook the same person into B -> new booking
//   3. confirm path: a weak (email-only) match on a new time -> confirm_required,
//      then the same call with confirmReschedule:true -> rescheduled

const BASE = (process.env.SLATE_BASE_URL ?? "https://slate.trypennie.app").replace(/\/$/, "");
const BUCKET_A = process.env.SMOKE_BUCKET ?? "411";
const BUCKET_B = process.env.SMOKE_BUCKET_B ?? "";
const KEY = process.env.BOOKING_API_KEY ?? "";

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log(`SKIP: ${msg}`);
}

type BookBody = {
  outcome?: string;
  booking?: { id?: string; manageUrl?: string };
  dryRun?: boolean;
  wouldAssign?: { id?: string; name?: string | null; email?: string | null } | null;
  error?: string;
  code?: string;
};

type DirectBody = {
  bookings?: Array<{ id: string; manageUrl?: string; status?: string }>;
  booking?: { id: string; manageUrl?: string; status?: string };
  outcome?: string;
  code?: string;
  error?: string;
};

async function req(method: string, path: string): Promise<{ status: number; body: DirectBody }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}` },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as DirectBody };
}

async function slotsFor(bucket: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/availability?bucket=${encodeURIComponent(bucket)}`);
  const body = (await res.json().catch(() => ({}))) as { slots?: string[] };
  return res.status === 200 ? body.slots ?? [] : [];
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
  const res = await fetch(`${BASE}/api/bookings/direct`, {
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

const tokensToClean: string[] = [];
function trackForCleanup(body: BookBody) {
  const m = (body.booking?.manageUrl ?? "").match(/\/booking\/manage\/([^/?#]+)/);
  if (m) tokensToClean.push(m[1]);
}
async function cleanup() {
  for (const token of [...new Set(tokensToClean)]) {
    await fetch(`${BASE}/api/bookings/${token}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "no_longer_interested" }),
    }).catch(() => {});
  }
  tokensToClean.length = 0;
}

function uniq(tag: string) {
  const n = Date.now();
  return { externalId: `smoke-${tag}-${n}`, email: `smoke+${tag}-${n}@trypennie.com` };
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
  // between scenarios, so holds release before the next one books.
  const [slotA, slotB] = [slotsA[0], slotsA[1]];
  const phone = "+12155550100";

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
  const slotsB = await slotsFor(BUCKET_B);
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
  const [slotA, slotB] = [slotsA[3], slotsA[4]];

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
  const phone = "+12155550102";

  const created = await book({ bucket: BUCKET_A, start: slotsA[0], ...id, phone });
  check(created.status === 200 && created.body.outcome === "created", `seed booking -> created (got ${created.status}/${created.body.outcome})`);
  const bookingId = created.body.booking?.id;
  if (!bookingId) {
    check(false, "seed booking returned a booking id (needed for lookup checks)");
    return;
  }

  // GET list — the booked person has at least one active booking.
  const listRes = await req("GET", `/api/bookings/direct?externalId=${encodeURIComponent(id.externalId)}`);
  check(
    listRes.status === 200 && Array.isArray(listRes.body.bookings) && (listRes.body.bookings?.length ?? 0) >= 1,
    "GET list returns the person's active booking(s)",
  );

  // GET by id — returns that one booking with a manageUrl.
  const oneRes = await req("GET", `/api/bookings/direct?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(
    oneRes.status === 200 && oneRes.body.booking?.id === bookingId && !!oneRes.body.booking?.manageUrl,
    "GET by id returns the booking + manageUrl",
  );

  // GET by id with a non-matching status assertion → 404.
  const missRes = await req("GET", `/api/bookings/direct?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}&status=cancelled`);
  check(missRes.status === 404 && missRes.body.code === "NOT_FOUND", "GET by id with mismatched status filter -> 404 NOT_FOUND");

  // DELETE by id — cancels (this is also the cleanup for this scenario).
  const delRes = await req("DELETE", `/api/bookings/direct?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(delRes.status === 200 && delRes.body.outcome === "cancelled", "DELETE by id cancels the booking");

  // Repeat DELETE → 404 (no longer active).
  const delAgain = await req("DELETE", `/api/bookings/direct?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(delAgain.status === 404 && delAgain.body.code === "NOT_FOUND", "second DELETE -> 404 NOT_FOUND (already cancelled)");
}

async function main() {
  if (!KEY) {
    console.error("Set BOOKING_API_KEY in the environment first.");
    process.exit(2);
  }
  console.log(`Smoke test against ${BASE} (bucket ${BUCKET_A}${BUCKET_B ? `, cross-bucket ${BUCKET_B}` : ""})`);

  const slotsA = await slotsFor(BUCKET_A);
  check(slotsA.length >= 5, `bucket ${BUCKET_A} has enough open slots (got ${slotsA.length})`);
  if (slotsA.length < 5) {
    console.log("\nNot enough slots — pick a bucket with availability via SMOKE_BUCKET.");
    process.exit(1);
  }

  // SMOKE_DRY_RUN_ONLY=1 runs ONLY the side-effect-free dry-run check — a safe
  // health check you can run anytime against the live fleet (no real bookings).
  if (process.env.SMOKE_DRY_RUN_ONLY) {
    await scenarioDryRun(slotsA);
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
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
  } finally {
    console.log("\nCleaning up test bookings...");
    await cleanup();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
