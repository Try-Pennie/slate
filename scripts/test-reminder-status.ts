// Each reminder email's status for the admin page (#4300). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-status.ts
//
// Per email, over the last 24 hours: sent, counted by when it was sent; failed and
// skipped by reason, counted by when the key was taken (`claimed_at`, which a skip
// stamps too); the rows the earlier reminder job left with no time (`legacy_claimed`),
// counted apart and never as sent; and the last send whenever it was.
//
// The direction that matters most: a read that FAILED is an explicit unknown, never a
// row of zeros, because "none sent, none failed" is what an admin would read off zeros,
// and it is exactly the healthy looking answer a broken read must not give (L10).
import {
  countReminderSends,
  readReminderEmailStatus,
  REMINDER_STATUS_WINDOW_MS,
  reminderStatusSummary,
} from "../src/lib/booking/reminder-status.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { HOUR, iso, NOW, row, statusDeps } from "./lib/reminder-status-fake.ts";

const IDS = ["email-day", "email-hour"];

// --- each count by its own stamp -----------------------------------------------------
{
  eq(REMINDER_STATUS_WINDOW_MS, 24 * HOUR, "the window is the last 24 hours");
  const rows = [
    row(), // sent an hour ago
    row({ sentAtIso: iso(NOW - 25 * HOUR), claimedAtIso: iso(NOW - 25 * HOUR) }), // sent yesterday, outside
    row({ status: "sent", claimedAtIso: iso(NOW - 25 * HOUR), sentAtIso: iso(NOW - 23 * HOUR) }), // claimed outside, sent inside
    row({ status: "failed", reason: "not_authorised", sentAtIso: null, claimedAtIso: iso(NOW - 2 * HOUR) }),
    row({ status: "failed", reason: "not_authorised", sentAtIso: null, claimedAtIso: iso(NOW - 30 * HOUR) }), // outside
    row({ status: "skipped", reason: "late_booking", sentAtIso: null, claimedAtIso: iso(NOW - 3 * HOUR) }),
    row({ status: "skipped", reason: "late_booking", sentAtIso: null, claimedAtIso: iso(NOW - 4 * HOUR) }),
    row({ status: "skipped", reason: "too_close", sentAtIso: null, claimedAtIso: iso(NOW - 5 * HOUR) }),
    row({ status: "legacy_claimed", sentAtIso: null, claimedAtIso: null }),
    row({ status: "claimed", sentAtIso: null, claimedAtIso: iso(NOW - 1 * HOUR) }), // in flight: none of the counts
    row({ status: "released", sentAtIso: null, claimedAtIso: iso(NOW - 1 * HOUR) }),
    row({ emailId: "email-hour", status: "sent", sentAtIso: iso(NOW - 10 * HOUR) }),
  ];
  const counts = countReminderSends(IDS, rows, { "email-day": iso(NOW - HOUR), "email-hour": null }, NOW);
  const day = counts["email-day"]!;
  eq(day.sent, 2, "sent is counted by when it was SENT, so one claimed yesterday and sent today counts");
  eq(day.failed, 1, "failed by when it was claimed");
  eq(day.skippedByReason, { late_booking: 2, too_close: 1 }, "skipped by reason, by when it was claimed");
  eq(day.skipped, 3, "with their total");
  eq(day.legacyClaimed, 1, "the earlier job's rows apart, never as sent");
  eq(day.lastSentAtIso, iso(NOW - HOUR), "and the last send");
  eq(counts["email-hour"]!.sent, 1, "each email counts its own rows only");
  eq(counts["email-hour"]!.lastSentAtIso, null, "and an email that never sent says so");
}

// --- an unreadable stamp is never in the window ------------------------------------
{
  const counts = countReminderSends(["email-day"], [row({ sentAtIso: "garbage" })], {}, NOW);
  eq(counts["email-day"]!.sent, 0, "a send whose time cannot be read is not counted as in the window");
  eq(counts["email-day"]!.undated, 1, "and is counted as undated, so it is not silently lost");
}

// --- the read: reads the window, and every email asked about is answered -------------
{
  const { deps, since } = statusDeps([row()], { "email-day": iso(NOW - HOUR) });
  const r = await readReminderEmailStatus(IDS, deps);
  eq(since, [iso(NOW - 24 * HOUR)], "asks for the rows about calls from 24 hours ago on");
  assert(r.status === "read", "a read that worked is read");
  if (r.status === "read") {
    eq(Object.keys(r.byEmail).sort(), IDS, "every email asked about has counts");
    eq(r.byEmail["email-hour"]!.sent, 0, "a real zero only after a measured read");
  }
}

// --- THE failure path: a failed read is an explicit unknown, never zeros ----------------
for (const which of ["loadSends", "loadLastSent"] as const) {
  const { deps } = statusDeps([], {}, {
    [which]: async () => {
      throw new Error(`${which} failed`);
    },
  });
  const r = await readReminderEmailStatus(IDS, deps);
  eq(r.status, "unreadable", `a failed ${which} is unreadable`);
  assert(!("byEmail" in r), "and carries no counts at all");
}

// --- the summary: a positive line only after a measured read --------------------------
{
  const read = (over: Partial<ReturnType<typeof countReminderSends>[string]> = {}) => ({
    sent: 0,
    failed: 0,
    skipped: 0,
    skippedByReason: {},
    legacyClaimed: 0,
    lastSentAtIso: null,
    undated: 0,
    ...over,
  });
  const healthy = reminderStatusSummary(read({ sent: 41, lastSentAtIso: "2026-10-27T18:14:00.000Z" }));
  eq(healthy.tone, "healthy", "sends with no failure are healthy");
  eq(healthy.lines[0], "41 sent in the last 24 hours, none failed.", "said as a positive line");
  assert(healthy.lines.includes("Last sent Oct 27, 2:14 PM ET."), `with the last send, in Eastern time (${healthy.lines.join(" | ")})`);

  const failing = reminderStatusSummary(read({ sent: 3, failed: 2, lastSentAtIso: "2026-10-27T18:14:00.000Z" }));
  eq(failing.tone, "failing", "any failure is the failing tone");
  eq(failing.lines[0], "2 failed and 3 sent in the last 24 hours.", "and leads the line");

  const quiet = reminderStatusSummary(read());
  eq(quiet.tone, "quiet", "nothing sent is neither healthy nor failing");
  eq(quiet.lines, ["None sent in the last 24 hours.", "Never sent."], "and says so plainly");

  const skips = reminderStatusSummary(read({ sent: 1, skipped: 3, skippedByReason: { late_booking: 2, mystery: 1 }, legacyClaimed: 4 }));
  assert(skips.lines.includes("Skipped 3: 2 booked after its time, 1 mystery."), `skips by reason in words, an unknown reason by name (${skips.lines.join(" | ")})`);
  assert(skips.lines.includes("4 sent by the earlier reminder job, with no send time kept."), "the earlier job's rows in words");

  const unreadable = reminderStatusSummary("unreadable");
  eq(unreadable.tone, "unreadable", "an unreadable read has its own tone");
  assert(/not the same as none/i.test(unreadable.lines[0] ?? ""), `and says it is not a zero (${unreadable.lines[0]})`);
}

finish();
