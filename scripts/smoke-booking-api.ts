// Manual smoke test for the live direct booking API (#253/#250). NOT a CI test
// (it hits production and creates REAL, then-cancelled bookings) — run it by
// hand to validate the endpoint end to end after setting BOOKING_API_KEY_CANARY.
//
//   BOOKING_API_KEY_CANARY=xxx node --experimental-strip-types scripts/smoke-booking-api.ts
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
//   EXPECT_HTTPS_REDIRECT (default unset): arms the http->https redirect guard
//                                          (#1024/#1203): set to 1 and a regression
//                                          FAILS the run instead of only warning.
//                                          Set as a repo Actions variable AND wired
//                                          into the canary steps' env (#1494), and a
//                                          variable alone never reaches the process.
//
// A defaulted var above is read through envOr, not `??`, because a workflow wiring
// `${{ vars.X }}` for an unset repo variable passes an EMPTY STRING rather than
// leaving it undefined, and `??` would take it (#1494).
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
//   2. cross-bucket move: book in A, rebook the same person into B -> new booking.
//      B's start is chosen relative to the instant A actually landed on (#1489):
//      a same-instant rebook always dedupes, so two slots picked independently
//      from two reads of the live cache can collide and false-page.
//   3. confirm path: a weak (email-only) match on a new time -> confirm_required,
//      then the same call with confirmReschedule:true -> rescheduled
//   6. reassign: book -> POST /api/bookings/reassign onto the OTHER SMOKE agent
//      (whichever one it did not land on) -> assert the booking moved (response +
//      an independent re-GET), then cancel. The endpoint runs the reassign outbox
//      INLINE before returning 200, so a moved agent IS proof of delivery.
//      Since #2370 that endpoint REFUSES a target who is not bookable or has
//      approved time off overlapping the call, so a 409 OWNER_NOT_BOOKABLE here
//      means the seeded target agent has drifted, not that the reassign broke:
//      re-run scripts/seed-smoke-test.ts, which seeds it bookable.
//   7. reschedule stickiness (#523): book -> reschedule by less than the event
//      length (new slot overlaps the booking's own event) -> assert it stayed on
//      the SAME agent (no silent re-route in the two-agent SMOKE bucket, #464).
//
// Keys (BOOKING_API_KEY_CANARY, REASSIGN_API_KEY, ...) load from .env.local / .dev.vars
// if not already in the environment, so a plain `node … smoke-booking-api.ts`
// works without exporting them by hand (and without `source`, which dies on an
// unmatched quote anywhere in the file).
import { envOr, loadEnvFiles } from "./smoke-env.ts";
import { evaluateSlotAvailability, jpost, slots, withRetry } from "./smoke-lib.ts";
import { createSmokeCleanup } from "./lib/smoke-cleanup.ts";
import { sweepQuietly } from "./lib/smoke-event-cleanup.ts";
import {
  judgePublicTestBucketGate,
  judgePublicTestBucketRead,
  publicTestBucketUrl,
} from "./lib/public-test-bucket-check.ts";
import { PUBLIC_TEST_BUCKET_CODES } from "../src/lib/embed/public-test-bucket.ts";
import { bookFirstFreeSlot } from "./lib/smoke-book-retry.ts";
import { smokeAttendee } from "./lib/smoke-identity.ts";
import { chooseCrossBucketSlot } from "./lib/smoke-cross-bucket-slot.ts";
import {
  MIN_SLOTS_FOR_RUN,
  createSlotPlan,
  type SlotPlan,
} from "./lib/smoke-slot-plan.ts";
import {
  failureLogPath,
  nodeSmokeFailureIo,
  recordFailure,
  recordPass,
  SMOKE_NAMES,
} from "./lib/smoke-failure-log.ts";
import { recordSmokeCrash } from "./lib/smoke-crash.ts";
import { responseDetail, type SmokeResponse } from "./lib/smoke-response-detail.ts";
import {
  evaluateStaticAssetTransport,
  fetchProbe,
  httpProbeUrl,
  isHttpsRedirect,
  redirectVerdict,
} from "./lib/https-redirect.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

// Every defaulted read goes through envOr, which treats an EMPTY value as absent
// (#1494). The canary wires SLATE_BASE_URL and EXPECT_HTTPS_REDIRECT from repo
// Actions variables, and `${{ vars.X }}` for an UNSET variable arrives as "", which
// `??` would happily accept: a base URL of "" would break every request in the run.
const BASE = envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app").replace(/\/$/, "");
// Default to the ISOLATED test buckets (#396): they have a single dedicated
// member (smoketest@trypennie.com) so a smoke run never books a real
// round-robin agent. Override SMOKE_BUCKET/SMOKE_BUCKET_B only to deliberately
// exercise a live bucket. (Booking real agents with the synthetic smoke+
// attendee is what bounced "undeliverable" notices onto agents like marnold.)
//
// env-ok: SMOKE_BUCKET (a local override only; CI wants the seeded default, and
//   wiring it would let an unset repo variable send the run at bucket "")
// env-ok: SMOKE_BUCKET_B (same, the seeded second isolated bucket)
const BUCKET_A = envOr(process.env.SMOKE_BUCKET, "SMOKE");
const BUCKET_B = envOr(process.env.SMOKE_BUCKET_B, "SMOKE2");
const KEY = process.env.BOOKING_API_KEY_CANARY ?? "";
// Reassign scenario (#450): a separate Bearer key (the owner-override API) and
// the second test agent the booking is forced onto. Defaults to the seeded
// smoketest2@ target; the scenario SKIPs if REASSIGN_API_KEY is unset.
const REASSIGN_KEY = process.env.REASSIGN_API_KEY ?? "";
// env-ok: SMOKE_AGENT_B_EMAIL (a local override only; CI wants the seeded
//   smoketest2@ mailbox, and an unset repo variable would blank the target)
const AGENT_B_EMAIL = envOr(process.env.SMOKE_AGENT_B_EMAIL, "smoketest2@trypennie.com");
// SMOKE's two bookable agents (#464): the booking can land on either, so the
// reassign scenario targets whichever one it did NOT land on.
// env-ok: SMOKE_AGENT_A_EMAIL (a local override only; as above for smoketest@)
const AGENT_A_EMAIL = envOr(process.env.SMOKE_AGENT_A_EMAIL, "smoketest@trypennie.com");

let failures = 0;
let skipped = 0;
// #1492: each failure is recorded as it happens, so the Slack alert can name WHICH
// checks failed instead of one sentence covering every possible cause. Appended
// immediately rather than at exit, because the run can die before it finishes: on
// 2026-08-14 it threw on an unparseable URL before a single booking check ran, and a
// log written at exit would have been empty for exactly the failure that most needed
// explaining.
const failureLog = failureLogPath(process.env);
// #3663: a check that judged a response hands it over, and a failure prints its
// status, code and short error. `got 503/undefined` could not tell a timeout from the
// kill switch or an unconfigured key; `scripts/test-smoke-response-detail.ts` fails
// any check here that reads a response without passing it.
function check(cond: boolean, msg: string, res?: SmokeResponse) {
  const line = cond || !res ? msg : `${msg} [${responseDetail(res)}]`;
  console.log(`${cond ? "PASS" : "FAIL"}: ${line}`);
  if (!cond) {
    failures++;
    recordFailure(nodeSmokeFailureIo, failureLog, line);
  } else {
    // #4062: a pass is recorded too, so a crash after passing checks is never read
    // as a run that stopped before the checks began.
    recordPass(nodeSmokeFailureIo, failureLog, SMOKE_NAMES.booking);
  }
}
function skip(msg: string) {
  console.log(`SKIP: ${msg}`);
  skipped++;
}

/** Final line. Skips are surfaced loudly so a clean run is never mistaken for
 *  full coverage (#397); SMOKE_STRICT=1 makes any skip a non-zero exit. */
function printSummaryAndExit() {
  const skipNote = skipped > 0 ? ` (${skipped} SKIPPED — coverage incomplete)` : "";
  // Absorbed slot conflicts are reported even on a passing run (#1491, L77): they are
  // classified as expected, so without a count a run that retried nine times reads
  // exactly like one that retried none, and rising contention stays invisible.
  const retryNote =
    retriesAbsorbed > 0
      ? ` (${retriesAbsorbed} slot conflict(s) retried past; see RETRY lines)`
      : "";
  console.log(
    failures === 0
      ? `\nALL CHECKS PASSED${skipNote}${retryNote}`
      : `\n${failures} CHECK(S) FAILED${skipNote}${retryNote}`,
  );
  const strictFail = !!process.env.SMOKE_STRICT && skipped > 0;
  process.exit(failures === 0 && !strictFail ? 0 : 1);
}

type BookBody = {
  outcome?: string;
  // startsAt is the instant the booking ACTUALLY holds, which is what the person
  // dedupe compares (#1489); the cross-bucket scenario anchors on it rather than
  // on the slot it asked for.
  booking?: { id?: string; manageUrl?: string; startsAt?: string };
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
  const doFetch = () => fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${KEY}` } });
  // #3583: retry an idempotent GET on a thrown network error so a transient blip does
  // not fail the run; never retry a mutating method (a DELETE re-send is not safe).
  const res = method === "GET" ? await withRetry(doFetch) : await doFetch();
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
  if (!args.dryRun) cleaner.trackIdentity(args.externalId);
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

// Teardown (#396, #4060): cancel every manage token this run tracked, then sweep
// every identity (externalId) it booked under, from the finally block too. Only a 200
// `created` answer is tracked, so a 409 that hands back somebody else's booking is
// never cancelled here, and a booking still active after both passes is a failed
// check naming its id rather than a swallowed error (scripts/lib/smoke-cleanup.ts).
const cleaner = createSmokeCleanup({
  post: jpost,
  list: (externalId) => req("GET", `/api/bookings?externalId=${encodeURIComponent(externalId)}`),
  remove: (externalId, bookingId) =>
    req("DELETE", `/api/bookings?externalId=${encodeURIComponent(externalId)}&bookingId=${bookingId}`),
  check,
});
function trackForCleanup(res: { status: number; body: BookBody }) {
  cleaner.track(res);
}
async function cleanup() {
  await cleaner.run();

  // #524: cancel above deletes the booking's Google event on the happy path, but
  // per #166 a cancel can orphan it, leaving a busy block that flakes the next
  // reschedule (which reads Google live). Sweep the two test mailboxes for any
  // stale smoke orphans. Best-effort: it needs the SA creds (absent in some CI
  // contexts) and a purge failure must not fail the smoke run, but we surface it
  // rather than swallow it. Set SMOKE_SKIP_EVENT_CLEANUP=1 to opt out.
  if (!process.env.SMOKE_SKIP_EVENT_CLEANUP) {
    const res = await sweepQuietly([AGENT_A_EMAIL, AGENT_B_EMAIL]);
    if (res.ok && res.deleted > 0) {
      console.log(`  cleanup: swept ${res.deleted} orphaned smoke event(s) off the test calendars (#524)`);
    } else if (!res.ok) {
      console.warn(`  cleanup: smoke event sweep skipped (${res.error})`);
    }
  }
}

// #3581: the per-run identity helper lives in one place now
// (scripts/lib/smoke-identity.ts), so a new scenario cannot quietly reintroduce a
// FIXED identity and re-accumulate cancelled-tombstone chains (#3576). The scan in
// scripts/test-smoke-identity-nonce.ts fails on a hand-rolled fixed plus-alias.
const uniq = smokeAttendee;

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

// --- Transport health: the public booker must force http->https (#1024) ---
// A lead following an http:// link submits name/email/phone in plaintext unless
// the edge redirects to https first. The Worker serves that redirect itself
// (worker/index.ts; a Cloudflare Redirect Rule cannot, see
// scripts/lib/https-redirect.ts for why), and unit tests prove the DECISION but
// not the DEPLOYMENT, so assert it LIVE here. Skips on a localhost/http dev base
// (see httpProbeUrl). Side-effect-free, so it runs on the every-30-min dry tick.
//
// It only PAGES once we EXPECT the redirect (EXPECT_HTTPS_REDIRECT=1, set once it
// is confirmed live); until then a missing redirect is a visible WARN, so
// shipping the guard early doesn't page every 30 min (see redirectVerdict).
async function checkHttpsRedirect() {
  const probe = httpProbeUrl(BASE);
  if (!probe) {
    console.log(`SKIP-INFO: http->https redirect check (base ${BASE} is not a public https host)`);
    return;
  }
  // #1210: one retry when the probe cannot reach the site at all, so a single
  // network blip on a 30 minute tick does not report a redirect as missing. Same
  // helper and same narrowness as the asset probe: only "no answer" is retried.
  const outcome = await fetchProbe({ fetchImpl: fetch, url: probe, init: { redirect: "manual" } });
  const res = outcome.reached
    ? { status: outcome.response.status, location: outcome.response.headers.get("location") }
    : { status: 0, location: null };
  const isRedirect = isHttpsRedirect(res.status, res.location);
  const expected = process.env.EXPECT_HTTPS_REDIRECT === "1";
  const detail = `got ${res.status} -> ${res.location ?? "(no Location)"}`;
  const verdict = redirectVerdict(isRedirect, expected);
  if (verdict === "warn") {
    // Toggle not enabled yet: visible, but does not fail the run or page.
    console.warn(`WARN: http:// does not yet redirect to https:// (#1024, redirect not live yet): ${detail}`);
    return;
  }
  check(verdict === "ok", `http:// redirects to https:// (#1024): ${detail}`);
  // Redirect is live but the guard isn't armed: nudge us to set the flag so a
  // later regression pages instead of silently warning (avoids a guard that
  // verifies nothing).
  if (isRedirect && !expected) {
    console.warn("WARN: http->https redirect is LIVE but EXPECT_HTTPS_REDIRECT is unset; set it to 1 (repo Actions var) to arm the regression guard (#1024).");
  }
}

// --- Transport health: the embed script is an ASSET, and assets skipped it ---
// #1203 / #1204: Cloudflare's asset binding serves anything under public/ WITHOUT
// invoking the Worker, so widget.js alone got neither the http->https redirect
// above nor the global hardening headers (measured live 2026-07-31: 200 over
// plaintext, none of the three headers, while /api/health had all of them). The
// fix is `assets.run_worker_first` in wrangler.jsonc, and
// scripts/test-asset-worker-first.ts pins that CONFIG. Only this check proves the
// deployed site actually behaves that way, which is the half that kept shipping
// broken here. Side-effect-free, so it runs on the every-30-min dry tick.
//
// It also asserts widget.js still SERVES correctly, because the plausible
// regression from routing assets through the Worker is the opposite of a header
// gap: the file 404s into an HTML page and every partner embed breaks at once.
async function checkStaticAssetTransport() {
  // The decision lives in scripts/lib/https-redirect.ts with an injected fetch,
  // so every branch (unreachable asset, HTML 404 in place of the script, missing
  // headers, not-yet-armed) is unit-tested in scripts/test-https-redirect.ts.
  // This is only the renderer.
  const checks = await evaluateStaticAssetTransport({
    base: BASE,
    expected: process.env.EXPECT_HTTPS_REDIRECT === "1",
  });
  for (const { level, message } of checks) {
    if (level === "skip") console.log(`SKIP-INFO: ${message}`);
    else if (level === "warn") console.warn(`WARN: not live yet, no page: ${message}`);
    else check(level === "ok", message);
  }
}

// #1491: every scenario's seed start comes from ONE plan with a stated separation,
// instead of each indexing into slotsA with a hardcoded offset. The offsets were one
// or two slots wide (10 to 20 min) against a 20 minute event, and scenarios 2 and 7
// both started from index 2, so two scenarios could land inside each other's window.
// That does not fail as "the fixture overlapped": it fails as a dedupe or as
// NO_ELIGIBLE_AGENTS, which reads as a booking regression (the #1489 shape).
//
// A refusal is reported as the fixture problem it is, and returns undefined so the
// scenario stops rather than booking a colliding slot.
/**
 * Report an absorbed slot conflict (#1491, L77). The retry deliberately treats a
 * SLOT_TAKEN / NO_ELIGIBLE_AGENTS as expected, so without this a run that needed
 * three retries per scenario reads exactly like a clean one, and a rising tide of
 * orphaned events looks like nothing at all.
 */
function noteRetry(label: string) {
  return (info: { slot: string; code: string | undefined; attempt: number }) => {
    retriesAbsorbed++;
    console.log(
      `RETRY: ${label} attempt ${info.attempt} hit ${info.code ?? "a slot conflict"} on ${info.slot}; advancing an hour`,
    );
  };
}
let retriesAbsorbed = 0;

function reserveSlot(plan: SlotPlan, label: string): string | undefined {
  const r = plan.reserve(label);
  if (r.ok) return r.start;
  check(false, `slot plan: ${r.reason}`);
  return undefined;
}

/** Record where a booking ACTUALLY landed, which the retry helper may have moved. */
function recordBooked(plan: SlotPlan, body: { booking?: { startsAt?: string } } | undefined): void {
  const landed = body?.booking?.startsAt;
  if (landed) plan.record(landed);
}

// --- The public test bucket is served, and gated (#2660, #2666) ---
// The exact request a partner's booker makes, on every tick, because nothing
// else watches this bucket: every monitor skips is_test on purpose, so a row
// deleted by hand or a recompute that stopped publishing it would otherwise be
// found by the next partner reporting "no times". A read, so it runs on the dry
// tick as well as the full pass. The verdict rules are pinned offline in
// scripts/test-public-test-bucket-check.ts.
//
// #2666: two reads now. A browser reaches the bucket only with a pass `/book`
// mints for an approved website, and the canary is not one, so whether it is
// SERVED is asked with the canary's own key, and whether it is GATED is asked
// with nothing at all, exactly as a stray caller would.
async function checkPublicTestBucket() {
  for (const code of PUBLIC_TEST_BUCKET_CODES) {
    // #3583: idempotent GET reads, retried on a thrown network blip during setup.
    const served = await withRetry(() =>
      fetch(publicTestBucketUrl(BASE, code), { headers: { authorization: `Bearer ${KEY}` } }),
    );
    const servedBody: unknown = await served.json().catch(() => null);
    const verdict = judgePublicTestBucketRead({ status: served.status, body: servedBody }, code);
    check(verdict.outcome === "served", `public test bucket ${code} is served: ${verdict.reason}`);

    // Deliberately NO authorization header and NO pass.
    const bare = await withRetry(() => fetch(publicTestBucketUrl(BASE, code)));
    const bareBody: unknown = await bare.json().catch(() => null);
    const gate = judgePublicTestBucketGate({ status: bare.status, body: bareBody }, code);
    check(gate.outcome === "gated", `public test bucket ${code} is gated: ${gate.reason}`);
  }
}

// --- Scenario 0: dry run — validate routing with ZERO side effects ---
async function scenarioDryRun(slotsA: string[]) {
  console.log("\n[0] dry run (no calendar event, no booking, no webhook)");
  const id = uniq("dryrun");
  // No reservation: a dry run creates nothing, so it cannot collide with anything
  // and must not consume a slot the booking scenarios need (#1491).
  const res = await book({ bucket: BUCKET_A, start: slotsA[0], ...id, dryRun: true });
  check(res.status === 200 && res.body.dryRun === true, `dry run -> 200 dryRun:true (got ${res.status}/${res.body.dryRun})`, res);
  check(res.body.outcome === "created", `dry run -> would create (got ${res.body.outcome})`, res);
  check(!!res.body.wouldAssign?.email, `dry run names the agent who WOULD be assigned (${res.body.wouldAssign?.email ?? "none"})`, res);
  check(!res.body.booking, "dry run returns NO booking (nothing was created)", res);
}

// --- Scenario 1: create / dedupe / reschedule within one bucket ---
async function scenarioMain(slotsA: string[], plan: SlotPlan) {
  console.log("\n[1] create -> deduped -> rescheduled (same bucket)");
  const id = uniq("main");
  // Distinct slot per scenario (the single test agent is shared); cleanup runs
  // between scenarios, so holds release before the next one books. slotB is a
  // safe margin LATER than slotA (not the adjacent slot) so the reschedule
  // target doesn't overlap slotA's own event — see laterSlot.
  const slotA = reserveSlot(plan, "scenario 1 (create/dedupe/reschedule)");
  if (!slotA) return;
  const slotB = laterSlot(slotsA, slotA);
  const { phone } = id;
  if (!slotB) {
    check(false, "need a non-overlapping later slot to reschedule into");
    return;
  }

  const created = await book({ bucket: BUCKET_A, start: slotA, ...id, phone });
  trackForCleanup(created);
  recordBooked(plan, created.body);
  check(created.status === 200 && created.body.outcome === "created", `book -> created (got ${created.status}/${created.body.outcome})`, created);

  const dup = await book({ bucket: BUCKET_A, start: slotA, ...id, phone });
  // #3584: carry the actual outcome and ids, so a failure is diagnosable from the
  // log alone (a second booking created, which is serious, vs a different id on a
  // race) rather than needing a database query to tell the two apart.
  check(
    dup.body.outcome === "deduped" && dup.body.booking?.id === created.body.booking?.id,
    `same slot -> deduped (same booking id) (got outcome=${dup.body.outcome}, id=${dup.body.booking?.id ?? "none"}, created id=${created.body.booking?.id ?? "none"})`,
    dup,
  );

  const moved = await book({ bucket: BUCKET_A, start: slotB, ...id, phone });
  trackForCleanup(moved);
  check(moved.body.outcome === "rescheduled", `different time -> rescheduled (got ${moved.body.outcome})`, moved);
  check(moved.body.booking?.id === created.body.booking?.id, "same-bucket reschedule keeps the same booking id", moved);
}

// --- Scenario 2: cross-bucket move (book in A, rebook same person into B) ---
async function scenarioCrossBucket(slotsA: string[], plan: SlotPlan) {
  console.log("\n[2] cross-bucket move (rebook same person into a different bucket)");
  if (!BUCKET_B) {
    skip("SMOKE_BUCKET_B not set — set it to a second bucket your test agent serves to run this");
    return;
  }
  const id = uniq("xbucket");
  const { phone } = id;

  // Book A FIRST, then read B's slots and choose relative to the instant A
  // actually landed on (#1489). The old code took slotsB[0] and assumed it
  // differed from slotsA[2]: two reads of the same live cache taken at different
  // moments, whose healthy margin is exactly one event length, so one stale read
  // put both bookings on the same instant and these two checks paged three times
  // in ten days. Anchoring on the booking's own startsAt keeps the two sides of
  // the separation independent of the slot we asked for.
  //
  // Since #1465 a same instant cross bucket rebook is a MOVE too, so a collision
  // would no longer read as a dedupe. The separation is kept anyway: with SMOKE2
  // single agent, a same instant move can be legitimately refused (the lead's own
  // booking holds that agent), and this scenario is here to prove the move, not
  // the refusal.
  const seedA = reserveSlot(plan, "scenario 2 (cross bucket, first booking)");
  if (!seedA) return;
  const inA = await bookFirstFreeSlot(
    slotsA,
    slotsA.indexOf(seedA),
    (slot) => book({ bucket: BUCKET_A, start: slot, ...id, phone }),
    4,
    undefined,
    noteRetry("scenario 2"),
  );
  // The retry may have moved it, so record where it LANDED, not what was asked for.
  recordBooked(plan, inA.body);
  trackForCleanup(inA);
  check(inA.body.outcome === "created", `book in bucket ${BUCKET_A} -> created (got ${inA.body.outcome})`, inA);
  const startA = inA.body.booking?.startsAt;
  if (!startA) {
    check(false, `book in bucket ${BUCKET_A} returned no startsAt to separate the rebook from`);
    return;
  }

  const slotsB = await slots(BUCKET_B);
  if (slotsB.length === 0) {
    skip(`bucket ${BUCKET_B} has no open slots`);
    return;
  }
  const pick = chooseCrossBucketSlot(slotsB, startA);
  if (!pick.ok) {
    // A window with slots but none far enough apart is a FAILURE, not a skip: the
    // bucket is offering times, so this is the fixture unable to do its job, and a
    // quiet skip would read as coverage (#397).
    check(false, `cannot separate the rebook in ${BUCKET_B} from ${BUCKET_A}: ${pick.reason}`);
    return;
  }

  const inB = await book({ bucket: BUCKET_B, start: pick.start, ...id, phone });
  trackForCleanup(inB);
  // Both instants are named, so a future failure says whether the two collided
  // (a fixture problem) or the move itself broke. Diagnosing #1489 needed a
  // production query precisely because "got deduped" named neither.
  check(
    inB.body.outcome === "rescheduled",
    `rebook ${startA} in ${BUCKET_A} -> ${pick.start} in ${BUCKET_B} -> rescheduled (got ${inB.body.outcome})`,
    inB,
  );
  check(
    !!inB.body.booking?.id && inB.body.booking?.id !== inA.body.booking?.id,
    "cross-bucket move creates a NEW booking (different id), not an in-place reschedule",
    inB,
  );
}

// --- Scenario 3: weak (email-only) match -> confirm_required, then confirm ---
async function scenarioConfirm(slotsA: string[], plan: SlotPlan) {
  console.log("\n[3] weak match -> confirm_required -> confirm -> rescheduled");
  const id1 = uniq("confirm");
  // slotB is a safe margin LATER than slotA (not the adjacent slot) so the
  // confirmed reschedule stays in-place rather than overlapping slotA — see
  // laterSlot.
  const slotA = reserveSlot(plan, "scenario 3 (weak match then confirm)");
  if (!slotA) return;
  const slotB = laterSlot(slotsA, slotA);
  if (!slotB) {
    check(false, "need a non-overlapping later slot for the confirm reschedule");
    return;
  }

  // Existing appointment for this email (phone P1, externalId E1). Both phones in
  // this scenario come from the helper, so the pair is unique per run (#4060): a
  // fixed pair would weak match a booking an earlier run left active.
  const created = await book({ bucket: BUCKET_A, start: slotA, externalId: id1.externalId, email: id1.email, phone: id1.phone });
  trackForCleanup(created);
  recordBooked(plan, created.body);
  check(created.body.outcome === "created", `seed booking -> created (got ${created.body.outcome})`, created);

  // New call: SAME email, DIFFERENT externalId + phone, different time -> weak match.
  const weak = {
    bucket: BUCKET_A,
    start: slotB,
    externalId: `${id1.externalId}-other`,
    email: id1.email,
    // A second helper phone: guaranteed different from P1 within the run.
    phone: uniq("confirm-other").phone,
  };
  const asked = await book({ ...weak, confirmReschedule: false });
  check(asked.status === 409 && asked.body.outcome === "confirm_required", `weak match + new time -> 409 confirm_required (got ${asked.status}/${asked.body.outcome})`, asked);
  check(asked.body.booking?.id === created.body.booking?.id, "confirm_required returns the EXISTING booking (no new one created)", asked);

  const confirmed = await book({ ...weak, confirmReschedule: true });
  trackForCleanup(confirmed);
  check(confirmed.body.outcome === "rescheduled", `same call with confirmReschedule:true -> rescheduled (got ${confirmed.body.outcome})`, confirmed);
}

// --- Scenario 4: GET lookup (list + by-id + status filter) + DELETE-by-id ---
async function scenarioLookupAndCancel(slotsA: string[], plan: SlotPlan) {
  console.log("\n[4] GET list / GET by-id / GET by-id+status / DELETE by-id");
  const id = uniq("lookup");
  // Unique phone per run too (not just externalId/email): a fixed phone lets a
  // leftover active booking from an earlier run weak-match this seed and turn it
  // into confirm_required, breaking the scenario. The helper builds it now, for
  // every scenario (#4060), rather than this one alone.
  const { phone } = id;

  // Book onto a FRESH slot, skipping past a transient conflict (SLOT_TAKEN /
  // NO_ELIGIBLE_AGENTS) left by a prior scenario's just-cancelled event that the
  // live verify-on-book read still sees busy. The orphan sweep that would clean
  // that residue is off in CI (no SA creds), so re-using slotsA[0] here flaked
  // this create with a 409 and paged (run 30010672602). Start past scenarios
  // 1/2/3 (slots 0/2/3); the helper advances if this slot also has residue.
  const seed = reserveSlot(plan, "scenario 4 (lookup and cancel)");
  if (!seed) return;
  const created = await bookFirstFreeSlot(
    slotsA,
    slotsA.indexOf(seed),
    (slot) => book({ bucket: BUCKET_A, start: slot, ...id, phone }),
    4,
    undefined,
    noteRetry("scenario 4"),
  );
  recordBooked(plan, created.body);
  check(created.status === 200 && created.body.outcome === "created", `seed booking -> created (got ${created.status}/${created.body.outcome})`, created);
  const bookingId = created.body.booking?.id;
  if (!bookingId) {
    check(false, "seed booking returned a booking id (needed for lookup checks)");
    return;
  }
  // Fallback cleanup: DELETE-by-id below is the primary cleanup, but if it fails
  // (e.g. the endpoint isn't deployed yet) track the seed so the final cleanup()
  // still cancels it instead of leaking an active booking into the next run.
  trackForCleanup(created);

  // GET list — the booked person has at least one active booking.
  const listRes = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}`);
  check(
    listRes.status === 200 && Array.isArray(listRes.body.bookings) && (listRes.body.bookings?.length ?? 0) >= 1,
    "GET list returns the person's active booking(s)",
    listRes,
  );

  // GET by id — returns that one booking with a manageUrl.
  const oneRes = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(
    oneRes.status === 200 && oneRes.body.booking?.id === bookingId && !!oneRes.body.booking?.manageUrl,
    "GET by id returns the booking + manageUrl",
    oneRes,
  );

  // GET by id with a non-matching status assertion → 404.
  const missRes = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}&status=cancelled`);
  check(missRes.status === 404 && missRes.body.code === "NOT_FOUND", "GET by id with mismatched status filter -> 404 NOT_FOUND", missRes);

  // DELETE by id — cancels (this is also the cleanup for this scenario).
  const delRes = await req("DELETE", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(delRes.status === 200 && delRes.body.outcome === "cancelled", "DELETE by id cancels the booking", delRes);

  // Repeat DELETE → 404 (no longer active).
  const delAgain = await req("DELETE", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(delAgain.status === 404 && delAgain.body.code === "NOT_FOUND", "second DELETE -> 404 NOT_FOUND (already cancelled)", delAgain);
}

// --- Scenario 5: list mode (cross-person, no externalId) ---
async function scenarioListMode() {
  console.log("\n[5] list mode (cross-person)");
  const listRes = await req("GET", `/api/bookings?bucket=${BUCKET_A}&limit=5`);
  check(listRes.status === 200 && Array.isArray(listRes.body.bookings),
    "GET list (no externalId) returns a bookings array", listRes);
  check(listRes.body.bookings?.every((b) => b.bucketCode === BUCKET_A) ?? true,
    "list rows are tagged with the filtered bucketCode", listRes);
  const blankExt = await req("GET", `/api/bookings?externalId=`);
  check(blankExt.status === 400, "blank externalId -> 400 (not a cross-person dump)", blankExt);
}

// --- Scenario 6: reassign (owner-override move onto a second agent) ---
async function scenarioReassign(slotsA: string[], plan: SlotPlan) {
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
  const { phone } = id;

  // Fresh slot, past scenarios 1/2/3 and scenario 4 (start 1): re-using slotsA[0]
  // here also 409'd on residue from a just-cancelled event (run 30010672602). The
  // helper advances past a transient slot conflict onto a clean slot.
  const seed = reserveSlot(plan, "scenario 6 (reassign)");
  if (!seed) return;
  const created = await bookFirstFreeSlot(
    slotsA,
    slotsA.indexOf(seed),
    (slot) => book({ bucket: BUCKET_A, start: slot, ...id, phone }),
    4,
    undefined,
    noteRetry("scenario 6"),
  );
  recordBooked(plan, created.body);
  trackForCleanup(created);
  check(created.body.outcome === "created", `book in ${BUCKET_A} -> created (got ${created.body.outcome})`, created);
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
    moved,
  );
  check(moved.body.booking?.id === bookingId, "reassign keeps the SAME booking id (in-place move, not a new booking)", moved);

  // Independent re-read confirms the move persisted. The reassign endpoint runs
  // its outbox (slot move + booking.rescheduled webhook + 'reassigned' history)
  // INLINE before returning 200, so a moved agent here is also proof the outbox
  // delivered — the smoke test has no DB read to assert the row directly.
  const after = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(
    after.body.booking?.agent?.email === target,
    `re-GET shows the booking now assigned to ${target} (got ${after.body.booking?.agent?.email ?? "none"})`,
    after,
  );
}

// --- Scenario 7: reschedule stickiness (#523) — a reschedule SHORTER than the
// event length keeps the SAME agent, instead of silently re-routing to another.
// Meaningful only in the now-two-agent SMOKE bucket (#464): the new slot overlaps
// the booking's own still-present event, which the pre-#523 self-free check
// counted as a conflict, re-routing the booking to the other agent. ---
async function scenarioRescheduleStickiness(slotsA: string[], plan: SlotPlan) {
  console.log("\n[7] sub-event-length reschedule keeps the same agent (#523)");
  const id = uniq("stick");
  const slot = reserveSlot(plan, "scenario 7 (sub-event-length reschedule)");
  if (!slot) return;
  // +10 min on the 20-min SMOKE event: the new window [+10, +30] overlaps the
  // original [0, +20] event — the exact #523 trigger.
  const target = new Date(Date.parse(slot) + 10 * 60_000).toISOString();

  const created = await book({ bucket: BUCKET_A, start: slot, ...id });
  trackForCleanup(created);
  recordBooked(plan, created.body);
  check(created.body.outcome === "created", `book in ${BUCKET_A} -> created (got ${created.body.outcome})`, created);
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
  const movedRes = { status: moved.status, body: (await moved.json().catch(() => ({}))) as { startsAt?: string; error?: string; code?: string } };
  check(movedRes.status === 200, "sub-event reschedule -> 200", movedRes);

  const after = await req("GET", `/api/bookings?externalId=${encodeURIComponent(id.externalId)}&bookingId=${bookingId}`);
  check(
    !!agentBefore && after.body.booking?.agent?.email === agentBefore,
    `STAYED on the same agent across the sub-event reschedule (before=${agentBefore}, after=${after.body.booking?.agent?.email ?? "none"})`,
    after,
  );
}

async function main() {
  if (!KEY) {
    console.error("Set BOOKING_API_KEY_CANARY in the environment first.");
    process.exit(2);
  }
  console.log(`Smoke test against ${BASE} (bucket ${BUCKET_A}${BUCKET_B ? `, cross-bucket ${BUCKET_B}` : ""})`);

  // Transport health (#1024 pages, #1203/#1204 assets) runs before the
  // availability gate so it reports even when the fleet is misconfigured; all of
  // it is side-effect-free.
  await checkHttpsRedirect();
  await checkStaticAssetTransport();
  await checkPublicTestBucket();

  // Gate on real availability before booking anything. Zero slots means the
  // isolated test agent is misconfigured, so the run would exercise NOTHING;
  // that must fail LOUDLY as a configuration error, never exit quietly in a way
  // that reads as a pass (#456). A thin-but-nonzero window is a distinct failure.
  const slotsA = await slots(BUCKET_A);
  // The floor is derived from what the slot plan actually needs (#1491), not a
  // number chosen when scenarios indexed the list at offsets 0 to 4.
  const availability = evaluateSlotAvailability(BUCKET_A, slotsA.length, MIN_SLOTS_FOR_RUN);
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
  // ONE plan for the whole run (#1491). Each scenario reserves its seed from it, so
  // the separations are stated in one place rather than implied by hardcoded indices
  // that were one or two slots wide against a 20 minute event. cleanup() between
  // scenarios frees the bookings, but the just-cancelled event can still read busy on
  // the live verify, which is precisely why the margin has to hold across scenarios
  // and not only within one.
  const plan = createSlotPlan(slotsA);
  try {
    await scenarioDryRun(slotsA);
    await scenarioMain(slotsA, plan);
    await cleanup();
    await scenarioCrossBucket(slotsA, plan);
    await cleanup();
    await scenarioConfirm(slotsA, plan);
    await cleanup();
    await scenarioLookupAndCancel(slotsA, plan);
    await scenarioListMode();
    await cleanup();
    await scenarioReassign(slotsA, plan);
    await cleanup();
    await scenarioRescheduleStickiness(slotsA, plan);
  } finally {
    console.log("\nCleaning up test bookings...");
    await cleanup();
  }

  printSummaryAndExit();
}

// #4062: a rejected main used to be dropped (`void main()`), so node died on an
// unhandled rejection and the failure log held nothing about it. Record the crash
// with a short reason, after the cleanup in main's finally has run.
main().catch((e) => {
  console.error("smoke crashed:", e);
  recordSmokeCrash(SMOKE_NAMES.booking, e);
  process.exit(1);
});
