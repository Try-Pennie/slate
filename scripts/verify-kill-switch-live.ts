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
// ON A SCHEDULE SINCE #2493. `.github/workflows/kill-switch.yml` runs it nightly, outside the
// hours the org advertises, and stamps `verdict:kill-switch` only when a run MEASURED whether the
// gate refuses and releases. That is why every ending now writes a summary file as well as exiting
// on its own code: an exit code alone cannot tell a real ending from an uncaught throw, because
// node exits 1 on both (L11, L98). A hand run sets no path and writes nothing.
//
// IT CHECKS THE CLOCK FIRST SINCE #3920. A cron's declared time is not when it runs, and GitHub
// started the nightly run inside business hours every morning for a month. So before it writes
// anything it reads the org's live hours and closed dates and stands down inside an open window
// or within 30 minutes of one (exit 15, a skip), or when the hours cannot be read (exit 16).
// The rule is `scripts/lib/kill-switch-clock.ts`, pinned by `scripts/test-kill-switch-clock.ts`.
//
// Env overrides:
//   SLATE_BASE_URL     the deployment to ask (default https://slate.trypennie.app)
//   KILL_SWITCH_BUCKET the bucket whose availability is read (default 111, a real public one)
// env-ok: KILL_SWITCH_BUCKET (a local override only; the scheduled run wants the coded
//   default, which is a real public bucket. Wiring it as a repo variable would be one more
//   setting that has to exist before the nightly proof can run, and an unset one
//   interpolates to the empty string, which is the #1495 fault)
//   KILL_SWITCH_SUMMARY_FILE  where to record the verdict for the scheduled reporter
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
const { writeKillSwitchSummary } = await import("./lib/kill-switch-run-outcome.ts");
const { judgeDrillClock, drillClockExit, drillClockSummaryLine, readOrgHours, appendStepSummary } = await import(
  "./lib/kill-switch-clock.ts"
);
const { loadBusinessHoursRows, loadBusinessHoursExceptions, businessHoursFromRows } = await import(
  "@/lib/booking/business-hours-load"
);

const SUMMARY_FILE = process.env.KILL_SWITCH_SUMMARY_FILE ?? "";


/**
 * Record the verdict for the scheduled reporter, then leave.
 *
 * Every ending goes through here, so a code added later cannot ship as the one the
 * lane reads as "the run died before deciding".
 */
function leave(exit: number, detail: string): never {
  const wrote = writeKillSwitchSummary(SUMMARY_FILE, { exit, detail });
  if (SUMMARY_FILE && !wrote.written) {
    console.error(`(could not record the verdict for the scheduled lane: ${wrote.why})`);
  }
  process.exit(exit);
}
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

// Ask the CLOCK before anything else (#3920). GitHub started the nightly run 4.5 to 9.5 hours
// late for a month, so the two second pause landed on live booking every morning, and nothing
// the workflow declares can prevent that. So the command reads the org's own hours and closed
// dates, judges this instant on the org's clock, and stands down inside an open window or its
// margin. Hours it cannot read stand down too: a skipped night costs one missing verdict, which
// the staleness bound reports, and a wrong guess costs real leads. This runs before the
// already-paused read and the open probe, so a skip touches nothing at all. Every run checks,
// a hand run included, because a person in a terminal at 10am stops booking just the same.
{
  const nowMs = Date.now();
  // The week and the exceptions from YESTERDAY, so a window closing at midnight carries its
  // margin into today, resolved by the same function the booker's own read uses so the two
  // can never judge one stored week differently. Never throws: a failed read is unreadable.
  const reading = await readOrgHours(nowMs, {
    loadRows: loadBusinessHoursRows,
    loadExceptions: loadBusinessHoursExceptions,
    resolve: businessHoursFromRows,
  });
  const clock = judgeDrillClock(reading, nowMs);
  const summary = appendStepSummary(process.env.GITHUB_STEP_SUMMARY, drillClockSummaryLine(clock));
  if (process.env.GITHUB_STEP_SUMMARY && !summary.written) console.error(`(could not write the job summary: ${summary.why})`);
  const clockExit = drillClockExit(clock);
  if (clockExit !== null) {
    console.error(`${clock.kind === "inside-hours" ? "SKIPPED (inside-business-hours)" : "FAILED (hours-unreadable)"}: ${clock.detail}`);
    leave(clockExit, clock.detail);
  }
  console.log(`clock: ${clock.detail}`);
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
  const detail =
    "Public booking is ALREADY stopped on this deployment. Somebody stopped it on purpose, and " +
    "finishing this run would turn it back on for them, so nothing was attempted. Start booking " +
    "again from the admin business hours page and this will test the switch on its next run.";
  console.error(`FAILED (already-paused): ${detail}`);
  leave(KILL_SWITCH_EXIT.alreadyPaused, detail);
}

console.log(`verify:kill-switch against ${BASE} (availability bucket ${BUCKET})`);

let restored = true;
let flagNotSet = false;
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
    flagNotSet = true;
  } else {
    paused = await probeBooking();
    availabilityPaused = await readAvailability();
    // Compared against the SHIPPED builder rather than a pattern written here, so the two cannot
    // drift and a copy edit cannot quietly turn this into a check that matches nothing (L41).
    pausedCopyIsPauseCopy =
      paused.kind === "refused" && paused.copy.trim() === BOOKING_ERROR_COPY.bookingsPaused.trim();
    console.log(
      `  flag on:  booker answered ${paused.kind}, availability ${availabilityPaused.ok ? `${availabilityPaused.slots} times` : "did not answer"}`,
    );
  }
} finally {
  // In a `finally`, because a throw between the flip and the restore leaves PUBLIC BOOKING
  // STOPPED (L514, L515). Tried twice: the first failure is usually transient, and the cost of
  // giving up is that real leads are refused until somebody notices.
  restored = await setPaused(false).catch(() => false);
  if (!restored) restored = await setPaused(false).catch(() => false);
}

// The write failure is judged AFTER the restore, never instead of it: a flag that was
// half set and could not be read back still has to be cleared, and a stranded flag
// outranks every other finding here.
if (flagNotSet && restored) {
  const detail =
    "The pause flag could not be written, or did not read back as set, so the paused half was " +
    "never exercised and nothing was measured about the switch. Nothing is left stopped. Check " +
    "that booking_settings row 1 is writable with this key.";
  console.error(`FAILED (flag-not-set): ${detail}`);
  leave(KILL_SWITCH_EXIT.flagNotSet, detail);
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
  leave(KILL_SWITCH_EXIT.ok, verdict.message);
}
// The restore failure is shouted rather than logged, because it is the one outcome that goes on
// turning real leads away after this command exits.
if (verdict.exitCode === KILL_SWITCH_EXIT.notRestored) console.error(`\n${restoreFailureMessage()}\n`);
console.error(`FAILED (exit ${verdict.exitCode}): ${verdict.message}`);
leave(verdict.exitCode, verdict.message);
