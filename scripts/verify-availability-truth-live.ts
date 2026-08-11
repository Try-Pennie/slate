// Live positive control for the availability-truth drift probe (#1377). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/verify-availability-truth-live.ts
//
// WHY THIS IS NOT A UNIT TEST. The probe (#1315) scores a calendar it cannot
// read as `unverified` and stays silent, which is the right direction of failure
// and makes a probe whose Google reads never succeed indistinguishable from one
// finding nothing wrong. It also cannot prove itself from production traffic:
// on 2026-08-11 every tick since deploy skipped with "bucket is offering no
// times to check", because the roster is deliberately dark before cutover
// (#1272), so `verifySlotLive` had never executed once in the shipping runtime.
// Injected fakes cannot close that: they agree with our assumption about
// Google's interface by construction (L52). Only a real call does.
//
// WHAT IT PROVES. It reads one agent's calendar live, and from GOOGLE'S OWN
// ANSWER (never from busy_blocks, which is written by the very reads under test)
// builds two windows: one it reports as occupied, one it reports as clear. Then
// it asks the probe's own `verifySlotLive` about each. Busy must come back
// `drift`, free must come back `free`. Both directions, or it proves nothing: a
// one-sided control is satisfied by a probe hard-wired to one answer (L1).
//
// It talks to LIVE Google, so it is deliberately not named `test-*.ts` (that
// glob is the unit suite). It writes nothing, anywhere.
//
// Needs the Google service-account creds (GOOGLE_SA_CLIENT_EMAIL /
// GOOGLE_SA_PRIVATE_KEY) and the Supabase secret key in .env.local / .dev.vars.
//
// Env overrides:
//   TRUTH_CONTROL_EMAIL   agent whose calendar is used (default smoketest@trypennie.com)
//   TRUTH_CONTROL_DAYS    how far ahead to look for the windows (default 14)
//   TRUTH_CONTROL_MINUTES the booking length checked over (default 30)
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { calendarsForEmails } = await import("@/lib/booking/service");
const { freeBusyMany } = await import("@/lib/google/calendar");
const { verifySlotLive } = await import("@/lib/monitor/availability-truth-store");
const { pickControlWindows, judgeControlVerdicts } = await import(
  "./lib/availability-truth-live-control.ts"
);
type BusyInterval = { start: string; end: string };

const email = process.env.TRUTH_CONTROL_EMAIL ?? "smoketest@trypennie.com";
const days = Number(process.env.TRUTH_CONTROL_DAYS ?? "14");
const minutes = Number(process.env.TRUTH_CONTROL_MINUTES ?? "30");

/** Every refusal exits non-zero. A run that could not build its controls proved
 *  nothing, and must never read as a pass (L98). */
function fail(why: string): never {
  console.error(`\nFAILED: ${why}`);
  process.exit(1);
}

const nowMs = Date.now();
const horizonMs = days * 24 * 60 * 60_000;
const durationMs = minutes * 60_000;

console.log(
  `Availability-truth live control over ${email}, next ${days} days, ${minutes}-minute windows`,
);

// --- 1. Read the calendar live, through the same mapping the probe uses ---
const { byEmail, readFailed } = await calendarsForEmails([email]);
if (readFailed.has(email)) fail(`could not map ${email} to any calendar (agent_calendars unreadable)`);
const calendarIds = byEmail.get(email) ?? [];
if (calendarIds.length === 0) fail(`${email} has no calendar rows, so there is nothing to read`);

const nowIso = new Date(nowMs).toISOString();
const horizonIso = new Date(nowMs + horizonMs).toISOString();
let busyByCalendar: Map<string, { busy: BusyInterval[]; error: boolean }>;
try {
  busyByCalendar = await freeBusyMany(email, nowIso, horizonIso, calendarIds);
} catch (err) {
  fail(`the live freeBusy read threw, so the delegated identity cannot read this calendar: ${String(err)}`);
}
const refused = [...busyByCalendar.entries()].filter(([, v]) => v.error).map(([id]) => id);
// A refused calendar is exactly the condition that makes the probe silent, so it
// is the finding, not a reason to carry on with what did read.
if (refused.length > 0) fail(`Google refused ${refused.length} of ${calendarIds.length} calendar(s): ${refused.join(", ")}`);

const busy: BusyInterval[] = [...busyByCalendar.values()].flatMap((v) => v.busy);
console.log(`  live read ok: ${calendarIds.length} calendar(s), ${busy.length} busy period(s) ahead`);

// --- 2. Build both control windows from that answer ---
const pick = pickControlWindows(busy, { nowMs, horizonMs, durationMs, stepMs: 30 * 60_000 });
if (!pick.ok) {
  fail(
    `${pick.why}.\n` +
      `  The Google read itself SUCCEEDED, so delegation is fine; this calendar just cannot\n` +
      `  host the control. Point TRUTH_CONTROL_EMAIL at an agent with a real meeting on it.`,
  );
}
const { busy: busyWindow, free: freeWindow } = pick.windows;
console.log(`  busy control: ${busyWindow.startIso} to ${busyWindow.endIso}`);
console.log(`  free control: ${freeWindow.startIso} to ${freeWindow.endIso}`);

// --- 3. Ask the probe's own live check about each ---
const busyVerdict = await verifySlotLive([email], busyWindow.startIso, busyWindow.endIso);
const freeVerdict = await verifySlotLive([email], freeWindow.startIso, freeWindow.endIso);
console.log(`  probe on the busy window: ${busyVerdict} (expected drift)`);
console.log(`  probe on the free window: ${freeVerdict} (expected free)`);

const judgement = judgeControlVerdicts(busyVerdict, freeVerdict);
if (!judgement.ok) {
  for (const f of judgement.failures) console.error(`  - ${f}`);
  fail("the drift probe's live calendar check is NOT working");
}
console.log(
  "\nPASSED: the probe's live calendar check reads real Google events and " +
    "distinguishes busy from free in both directions.",
);
