// Live positive control for the public booking kill switch (#2365). Run:
//   pnpm verify:kill-switch
//
// WHY THIS IS NOT A UNIT TEST. #2297 shipped the switch and nothing has ever thrown it in
// production. Every path is covered by tests and the setting is confirmed present in the live
// database, but the PAUSED state has never once run against the deployed Worker. That matters
// more here than it would for most features, because this gate deliberately fails CLOSED: it
// refuses the booking when it cannot read its own flag. So the fault nobody would see coming is
// the one where it refuses EVERYTHING, and the only signal would be the booking failure rate
// window firing under `booking_pause_unreadable` after real leads had already been turned away.
// This is the #1394 family, a safeguard that cannot prove itself from production traffic, beside
// `verify:availability-truth`, `verify:burst-counter` and `verify:ooo-protection`.
//
// WHAT IT PROVES, BOTH DIRECTIONS OR NOTHING (L1). With the flag OFF a deliberately malformed
// request reaches the body parser and answers 400; with it ON the same request is refused ahead
// of parsing and answers 503 carrying the PAUSED copy rather than the unreadable copy. A route
// hard wired to either answer satisfies a check that only asks one way.
//
// IT CREATES NO BOOKING. The gate sits ahead of body parsing, so the probe is a body the parser
// would reject anyway. Nothing reaches the booking path in either half.
//
// IT ALSO ASSERTS WHAT THE SWITCH LEAVES ALONE, which is half its design: availability keeps
// answering while bookings are paused. Compared open against paused rather than demanded to be
// non zero, because before cutover a real bucket legitimately offers no times (#1272) and a check
// that demanded them would be red from the day it shipped (L36).
//
// WHAT IT WRITES. One column, twice: `booking_settings.public_booking_paused` on, then off. The
// restore is in a `finally` and a run that could not restore exits non-zero and says so as loudly
// as it can (L514, L515), because what it leaves behind is PUBLIC BOOKING STOPPED.
//
// It talks to a live deployment and a live database, so it is deliberately not named `test-*.ts`:
// that glob is the offline unit suite. Its decision logic is pinned offline by
// `scripts/test-kill-switch-live-control.ts`.
//
// Env overrides:
//   SLATE_BASE_URL     the deployment to ask (default https://slate.trypennie.app)
//   KILL_SWITCH_BUCKET the bucket whose availability is read (default 111, a real public one)
import { loadEnvFiles, envOr } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

if (!process.env.SUPABASE_SECRET_KEY?.trim() || !process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) {
  console.error(
    "FAILED (not-configured): SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL are needed to flip the flag; nothing was attempted",
  );
  process.exit(1);
}

// Imported after the env files are loaded, like the other live scripts here: a static import is
// hoisted above the call above, so anything reading the environment as it loads would read it unset.
const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const { BOOKING_ERROR_COPY } = await import("@/lib/booking/booker-copy");
const { KILL_SWITCH_EXIT, readProbeReply, judgeKillSwitchRun, restoreFailureMessage } = await import(
  "./lib/kill-switch-live-control.ts"
);
type ProbeReply = import("./lib/kill-switch-live-control.ts").ProbeReply;
type AvailabilityReading = import("./lib/kill-switch-live-control.ts").AvailabilityReading;

// envOr, not `??`: a workflow wiring SLATE_BASE_URL from an unset repo variable sets it to the
// empty string, and `??` would take that as the value (#1494).
const BASE = envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app").replace(/\/$/, "");
// A REAL bucket, not SMOKE. The test buckets are invisible without a bearer token
// (#396, #601), so an unauthenticated read of one 404s in both halves and the run
// learns nothing about the half it is there to check. Caught by the first live run.
const BUCKET = envOr(process.env.KILL_SWITCH_BUCKET, "111");

const db = supabaseAdmin();

/**
 * The probe body. Deliberately malformed, so the parser rejects it the instant the gate lets it
 * through: the 400 IS the evidence the request got past the gate. It carries no attendee and no
 * slot, so there is nothing for the booking path to act on even if a future change moved the gate.
 */
const PROBE_BODY = JSON.stringify({ verifyKillSwitch: true });

async function probeBooking(): Promise<ProbeReply> {
  try {
    const res = await fetch(`${BASE}/booking`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: PROBE_BODY,
    });
    return readProbeReply(res.status, await res.text().catch(() => ""));
  } catch (err) {
    return { kind: "no-answer", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function readAvailability(): Promise<AvailabilityReading> {
  try {
    const res = await fetch(`${BASE}/api/availability?bucket=${encodeURIComponent(BUCKET)}`);
    if (!res.ok) return { ok: false, slots: null };
    const body = (await res.json()) as { slots?: unknown };
    // A payload without a slots array is not a reading, not a reading of zero: an unreadable
    // shape counting as "no times" would let a broken response look like a quiet day (L215).
    if (!Array.isArray(body.slots)) return { ok: false, slots: null };
    return { ok: true, slots: body.slots.length };
  } catch {
    return { ok: false, slots: null };
  }
}

/** Write the flag and read it back, because a write that resolved is not a write that landed. */
async function setPaused(paused: boolean): Promise<boolean> {
  const { error } = await db
    .from("booking_settings")
    .update({ public_booking_paused: paused })
    .eq("id", 1);
  if (error) return false;
  const row = unwrap(
    await db.from("booking_settings").select("public_booking_paused").eq("id", 1).maybeSingle(),
    "booking_settings read back",
  ) as { public_booking_paused: boolean | null } | null;
  return (row?.public_booking_paused === true) === paused;
}

// Refuse to run against a deployment where somebody has ALREADY paused bookings. Clearing that at
// the end would turn public booking back on for a person who deliberately stopped it, which is the
// one side effect this command must never have.
const before = unwrap(
  await db.from("booking_settings").select("public_booking_paused").eq("id", 1).maybeSingle(),
  "booking_settings.public_booking_paused",
) as { public_booking_paused: boolean | null } | null;
if (before === null) {
  console.error("FAILED (not-configured): no booking_settings row 1 to flip; nothing was attempted");
  process.exit(1);
}
if (before.public_booking_paused === true) {
  console.error(
    "FAILED (already-paused): public booking is ALREADY paused on this deployment. Somebody stopped it on " +
      "purpose, and finishing this run would turn it back on for them. Nothing was attempted.",
  );
  process.exit(1);
}

console.log(`verify:kill-switch against ${BASE} (availability bucket ${BUCKET})`);

let restored = true;
let paused: ProbeReply = { kind: "no-answer", detail: "the paused half never ran" };
let availabilityPaused: AvailabilityReading = { ok: false, slots: null };
let pausedCopyIsPauseCopy = false;

// The OPEN half first, before anything is written: if the booker is already refusing with the flag
// off, the run has its answer and has changed nothing.
const open = await probeBooking();
const availabilityOpen = await readAvailability();
console.log(`  flag off: booker answered ${open.kind}, availability ${availabilityOpen.ok ? `${availabilityOpen.slots} times` : "did not answer"}`);

try {
  if (!(await setPaused(true))) {
    console.error(
      "FAILED (flag-not-set): the pause flag could not be written or did not read back as set, so the paused half " +
        "was never exercised. Nothing is left paused.",
    );
    process.exit(KILL_SWITCH_EXIT.noAnswer);
  }
  paused = await probeBooking();
  availabilityPaused = await readAvailability();
  // Compared against the SHIPPED builder rather than a pattern written here, so the two cannot
  // drift and a copy edit cannot quietly turn this into a check that matches nothing (L41).
  pausedCopyIsPauseCopy =
    paused.kind === "refused" && paused.copy.trim() === BOOKING_ERROR_COPY.bookingsPaused.trim();
  console.log(
    `  flag on:  booker answered ${paused.kind}, availability ${availabilityPaused.ok ? `${availabilityPaused.slots} times` : "did not answer"}`,
  );
} finally {
  // In a `finally`, because a throw between the flip and the restore leaves PUBLIC BOOKING
  // STOPPED (L514, L515). Tried twice: the first failure is usually transient, and the cost of
  // giving up is that real leads are refused until somebody notices.
  restored = await setPaused(false).catch(() => false);
  if (!restored) restored = await setPaused(false).catch(() => false);
}

const verdict = judgeKillSwitchRun({
  whileOpen: open,
  whilePaused: paused,
  pausedCopyIsPauseCopy,
  availabilityOpen,
  availabilityPaused,
  restored,
});

if (verdict.ok) {
  console.log(`PASSED: ${verdict.message}`);
  process.exit(KILL_SWITCH_EXIT.ok);
}
// The restore failure is shouted rather than logged, because it is the one outcome that goes on
// turning real leads away after this command exits.
if (verdict.exitCode === KILL_SWITCH_EXIT.notRestored) console.error(`\n${restoreFailureMessage()}\n`);
console.error(`FAILED (exit ${verdict.exitCode}): ${verdict.message}`);
process.exit(verdict.exitCode);
