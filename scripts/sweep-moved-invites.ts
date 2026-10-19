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
//   - and posts ONE message to the alerts channel listing them all.
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
// Exit codes: 0 read every invite (found or not); 1 no credentials here, nothing read;
// 2 the bookings could not be read; 3 some invites could not be read, listed.
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
if (result.found.length > 0) {
  console.log("\nThe alerts channel message:\n");
  console.log(inviteLaunchSweepAlert(result.found));
}
if (result.gone.length > 0) console.log(`\nInvite gone from the advisor's calendar: ${result.gone.join(", ")}`);
if (result.unreadable.length > 0) {
  console.error(`\nNOT JUDGED, Google could not be read for: ${result.unreadable.join(", ")}`);
  process.exit(3);
}
process.exit(0);
