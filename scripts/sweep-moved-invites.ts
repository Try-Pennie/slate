// One off, at launch: report every upcoming booking whose invite is already out of
// step with Slate (#3919, decision 9).
//
//   pnpm sweep:moved-invites            reads and prints, changes nothing
//   pnpm sweep:moved-invites --apply    also records, blocks and posts
//
// Before #3919 nothing noticed an advisor moving a Slate booking's invite in Google
// Calendar, so on the day it ships some upcoming invites already disagree with their
// bookings. Dan's decision: report them to the alerts channel for a person to handle,
// and put NONE of them back. This reads each upcoming booking's invite live from the
// advisor's calendar (`src/lib/google/invite-move-sweep.ts`) and, with `--apply`, for
// each out of step one:
//   - records it in `booking_invite_changes` as `report_launch`, so a later change to
//     the same invite is never taken for a first move and put back;
//   - writes the moved time as busy, so the advisor is blocked at both times;
//   - and posts ONE message to the alerts channel listing them all, except smoke test
//     bookings (#3930), which are recorded and blocked and only printed here.
// It moves no invite and emails no lead: the sweep has no seam that could.
//
// RUN IT ONCE, RIGHT AFTER THE DEPLOY. Until it has run, an invite moved before launch
// that changes again (the lead accepting it) reaches the live handler as a first move
// and is put back. Running it twice reports only what the first run and the handler
// had not already recorded.
//
// Needs the production credentials in .env.local (Supabase secret key, the Google
// service account, the Slack bot token). Posting from a laptop is refused by default
// (#1537); `--apply` is the explicit intent, so it opts this one process in.
//
// Exit codes: 0 read every invite (found or not) and posted what it found; 1 no
// credentials here, nothing read; 2 the bookings could not be read; 3 some invites
// could not be read, listed; 4 some findings could not be blocked or recorded,
// listed, and a rerun retries them; 5 the message did not post, and is printed to
// send by hand (its findings are recorded, so a rerun would not report them again).
// When several hold, every one is printed and the exit code is the most urgent: 5,
// then 4, then 3.
import { requireSupabaseCredentials } from "./lib/supabase-credentials.ts";

const apply = process.argv.includes("--apply");
if (!requireSupabaseCredentials()) process.exit(1);
if (apply) process.env.SLATE_ALLOW_OFFPLATFORM_ALERTS = "1";

const { sweepOutOfStepInvites } = await import("@/lib/google/invite-move-sweep");
const { realInviteSweepDeps } = await import("@/lib/google/invite-move-deps");
const { inviteLaunchSweepAlert } = await import("@/lib/google/invite-move-copy");

let result;
try {
  result = await sweepOutOfStepInvites(realInviteSweepDeps({ apply }));
} catch (err) {
  console.error(`FAILED: the upcoming bookings could not be read: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

console.log(`${apply ? "APPLIED" : "DRY RUN (nothing written or posted; add --apply)"}`);
console.log(
  `checked ${result.checked} invites, ${result.alreadyRecorded} bookings already recorded by the live handler, ` +
    `${result.found.length} out of step, ${result.gone.length} gone from the calendar, ${result.unreadable.length} unreadable`,
);
// A smoke test booking is never in the message (#3930), dry run included.
const shown = apply ? result.reported : result.found.filter((f) => f.isTest !== true);
if (apply && result.testNotPosted.length > 0) {
  console.log(`${result.testNotPosted.length} smoke test bookings were recorded and blocked, and left out of the message: ${result.testNotPosted.join(", ")}`);
}
if (!apply && shown.length < result.found.length) {
  const tests = result.found.filter((f) => f.isTest === true).map((f) => f.bookingId);
  console.log(`${tests.length} of those are smoke test bookings, which the message leaves out: ${tests.join(", ")}`);
}
if (apply && result.recordedElsewhere > 0) {
  console.log(`${result.recordedElsewhere} were recorded by another run meanwhile, and are left to it.`);
}
if (shown.length > 0) {
  const state = !apply ? "not posted, dry run" : result.posted ? "posted" : "NOT POSTED, send it by hand";
  console.log(`\nThe alerts channel message (${state}):\n`);
  console.log(inviteLaunchSweepAlert(shown));
}
if (result.gone.length > 0) console.log(`\nInvite gone from the advisor's calendar: ${result.gone.join(", ")}`);
// Every state is printed; the exit code is the most urgent one, so a reader of the
// code never misses the message that is the only copy of what was found.
const states: number[] = [];
if (result.unreadable.length > 0) {
  console.error(`\nNOT JUDGED, Google could not be read for: ${result.unreadable.join(", ")}`);
  states.push(3);
}
if (result.notRecorded.length > 0) {
  console.error(`\nNOT RECORDED OR BLOCKED, rerun to retry these:`);
  for (const n of result.notRecorded) console.error(`  ${n.bookingId}: ${n.reason}`);
  states.push(4);
}
if (apply && shown.length > 0 && !result.posted) {
  // The findings are recorded, so a rerun skips them: the printed message is the only copy.
  console.error("\nThe message did not post to the alerts channel. It is printed above; send it by hand.");
  states.push(5);
}
process.exit([5, 4, 3].find((c) => states.includes(c)) ?? 0);
