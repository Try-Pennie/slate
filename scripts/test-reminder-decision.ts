// The one judge for every reminder email (#4297): send, held, wait, skip or nothing,
// for one booking and one email. Proves it agrees with today's three judges
// (`reminderDue`, `reminderHeld`, `hourReminderDue`) over a generated grid before the
// lane is moved onto it, and that a third email moves neither the hold nor the retry
// floors of the other two.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-decision.ts
import {
  reminderDecision,
  reminderRetryFloorMs,
  type DecisionBooking,
  type DecisionEmail,
  type ReminderDecision,
  type SendRecord,
} from "../src/lib/booking/reminder-decision.ts";
import {
  reminderDue,
  reminderHeld,
  hourReminderDue,
  REMINDER_HOLD_FLOOR_MS,
  REMINDER_HOLD_MS,
  REMINDER_RETRY_MARGIN_MS,
  HOUR_REMINDER_MIN_LEAD_MS,
  HOUR_REMINDER_GAP_MS,
} from "../src/lib/booking/reminder.ts";
import { DEFAULT_TEMPLATES } from "../src/lib/booking/reminder-template.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 27, 14, 0, 0);

const email = (over: Partial<DecisionEmail> = {}): DecisionEmail => ({
  id: "day",
  minutesBefore: 1440,
  lateBooking: "send_now",
  effectiveFromMs: 0,
  placeholderSends: true,
  ...over,
});
const DAY = email({ id: "day", minutesBefore: DEFAULT_TEMPLATES.day.minutesBefore, lateBooking: DEFAULT_TEMPLATES.day.lateBooking });
const HOUR_EMAIL = email({ id: "hour", minutesBefore: DEFAULT_TEMPLATES.hour.minutesBefore, lateBooking: DEFAULT_TEMPLATES.hour.lateBooking });
const TWELVE = email({ id: "twelve", minutesBefore: 720, lateBooking: "send_now" });
const TODAY = [DAY, HOUR_EMAIL];

const booking = (over: Partial<DecisionBooking> = {}): DecisionBooking => ({
  startsAtMs: NOW + 20 * HOUR,
  createdAtMs: NOW - 3 * 24 * HOUR,
  status: "confirmed",
  leadEmail: "lead@example.com",
  senderEmail: "sam@trypennie.com",
  onPlaceholder: false,
  ...over,
});
const sent = (emailId: string, sentForMs: number, sentAtMs: number | null, status: SendRecord["status"] = "sent"): SendRecord => ({
  emailId,
  sentForMs,
  status,
  sentAtMs,
  claimedAtMs: sentAtMs === null ? null : sentAtMs - 2_000,
});
const show = (d: ReminderDecision) => ("reason" in d ? `${d.action}:${d.reason}` : d.action);
const judge = (b: DecisionBooking, e: DecisionEmail, sends: SendRecord[] = [], all = TODAY, now = NOW) =>
  show(reminderDecision(b, e, sends, all, now));

// --- the basics ------------------------------------------------------------------
{
  eq(judge(booking(), DAY), "send", "a call 20 hours out with nothing sent is sent its day email");
  eq(judge(booking({ startsAtMs: NOW + 25 * HOUR }), DAY), "wait:not_yet", "a call beyond the window waits");
  eq(judge(booking({ startsAtMs: NOW + 24 * HOUR }), DAY), "send", "the window's edge itself is inside");
  eq(judge(booking({ status: "cancelled" }), DAY), "none:not_live", "a cancelled call gets nothing");
  eq(judge(booking({ startsAtMs: NOW }), DAY), "none:past", "a call starting now gets nothing");
  eq(judge(booking(), DAY, [sent("day", NOW + 20 * HOUR, NOW - HOUR)]), "none:resolved", "a start already sent is done");
  eq(
    judge(booking(), DAY, [sent("day", NOW + 22 * HOUR, NOW - HOUR)]),
    "send",
    "a send for an earlier start does not count: a moved call earns a fresh email",
  );
  eq(judge(booking(), DAY, [sent("day", NOW + 20 * HOUR, null, "released")]), "send", "a released claim is sent again");
  for (const status of ["claimed", "failed", "skipped", "legacy_claimed"] as const) {
    eq(judge(booking(), DAY, [sent("day", NOW + 20 * HOUR, null, status)]), "none:resolved", `a ${status} record is resolved`);
  }
}

// --- unreadable values land on the silent side --------------------------------------
{
  eq(judge(booking({ startsAtMs: Number.NaN }), DAY), "none:unreadable", "an unreadable start sends nothing");
  eq(judge(booking(), DAY, [], TODAY, Number.NaN), "none:unreadable", "an unreadable clock sends nothing");
  eq(judge(booking(), email({ minutesBefore: Number.NaN })), "none:unreadable", "an unreadable timing sends nothing");
  eq(judge(booking(), email({ effectiveFromMs: null })), "none:unreadable", "an email with no effective time sends nothing");
  eq(
    judge(booking({ startsAtMs: NOW + 50 * MIN, createdAtMs: Number.NaN }), HOUR_EMAIL),
    "none:unreadable",
    "an unreadable booking time cannot show a skip email was booked early enough",
  );
  // The hold is a courtesy and releases on an unreadable value, as `reminderHeld` does.
  eq(judge(booking({ createdAtMs: Number.NaN }), DAY), "send", "an unreadable booking time does not hold a send now email");
}

// --- effective_from: turning an email on or retiming it never bursts -------------------
{
  const enabledAt = NOW - 2 * HOUR;
  const fresh = email({ effectiveFromMs: enabledAt });
  eq(
    judge(booking({ startsAtMs: NOW + 20 * HOUR }), fresh),
    "skip:before_effective",
    "a booking whose window opened before the email took effect is skipped",
  );
  eq(
    judge(booking({ startsAtMs: NOW + 22 * HOUR - 1 }), fresh),
    "skip:before_effective",
    "a millisecond is enough: its window opened just before the email took effect",
  );
  eq(judge(booking({ startsAtMs: NOW + 22 * HOUR }), fresh), "send", "a window opening the instant it took effect is sent");
  eq(
    judge(booking({ startsAtMs: NOW + 23 * HOUR - 1, createdAtMs: NOW - 5 * HOUR }), email({ effectiveFromMs: NOW - HOUR - 1 })),
    "send",
    "a window opening after the email took effect is sent",
  );
  eq(
    judge(booking({ startsAtMs: NOW + 20 * HOUR, createdAtMs: NOW - HOUR }), fresh),
    "send",
    "a call booked after the email took effect is not old: its window opened when it was booked",
  );
  eq(
    judge(booking({ startsAtMs: NOW + 20 * HOUR, createdAtMs: NOW - 5 * MIN }), fresh),
    "held",
    "and it is still held for the hand back like any new booking",
  );
}

// --- late booking, per email -------------------------------------------------------------
{
  const late = booking({ startsAtMs: NOW + 50 * MIN, createdAtMs: NOW - 5 * MIN });
  eq(judge(late, HOUR_EMAIL), "skip:late_booking", "a skip email refuses a call booked inside its window");
  eq(judge(late, email({ id: "x", minutesBefore: 60 })), "send", "a send now email of the same lead sends it");
  eq(
    judge(booking({ startsAtMs: NOW + 50 * MIN, createdAtMs: NOW + 50 * MIN - HOUR }), HOUR_EMAIL),
    "send",
    "booked exactly at the window's opening counts as early enough",
  );
}

// --- never under thirty minutes ------------------------------------------------------------
{
  eq(HOUR_REMINDER_MIN_LEAD_MS, 30 * MIN, "the shared minimum is half an hour");
  eq(judge(booking({ startsAtMs: NOW + 30 * MIN }), HOUR_EMAIL), "send", "thirty minutes out is sent");
  eq(judge(booking({ startsAtMs: NOW + 30 * MIN - 1 }), HOUR_EMAIL), "skip:too_close", "under it is skipped for good");
  eq(judge(booking({ startsAtMs: NOW + 20 * MIN }), DAY), "skip:too_close", "for every email, the day one included");
}

// --- never after a shorter email for this start ------------------------------------------------
{
  const b = booking({ startsAtMs: NOW + 50 * MIN });
  eq(judge(b, DAY, [sent("hour", b.startsAtMs, NOW - 5 * MIN)]), "skip:superseded", "the hour email went, so the day one never follows");
  eq(
    judge(booking(), DAY, [sent("twelve", NOW + 20 * HOUR, NOW - MIN)], [DAY, TWELVE, HOUR_EMAIL]),
    "skip:superseded",
    "any shorter email supersedes",
  );
  eq(
    judge(b, DAY, [sent("hour", b.startsAtMs, null, "legacy_claimed")]),
    "skip:superseded",
    "a legacy claim of the shorter email counts, as today's column does",
  );
  eq(judge(b, DAY, [sent("hour", b.startsAtMs, null, "skipped")]), "send", "a skipped shorter email does not supersede");
  eq(judge(b, DAY, [sent("hour", b.startsAtMs, null, "released")]), "send", "nor a released one");
  eq(judge(b, DAY, [sent("hour", b.startsAtMs - HOUR, NOW - HOUR)]), "send", "nor one about an earlier start");
  eq(
    judge(booking({ startsAtMs: NOW + 50 * MIN }), HOUR_EMAIL, [sent("day", NOW + 50 * MIN, NOW - 3 * HOUR)]),
    "send",
    "a LONGER email never supersedes",
  );
}

// --- the two hour gap is a wait ------------------------------------------------------------
{
  eq(HOUR_REMINDER_GAP_MS, 2 * HOUR, "the gap is two hours");
  const b = booking({ startsAtMs: NOW + 50 * MIN, createdAtMs: NOW - 3 * HOUR });
  eq(judge(b, HOUR_EMAIL, [sent("day", b.startsAtMs, NOW - 2 * HOUR + 1)]), "wait:gap", "inside the gap waits");
  eq(judge(b, HOUR_EMAIL, [sent("day", b.startsAtMs, NOW - 2 * HOUR)]), "send", "at the gap it sends");
  eq(judge(b, HOUR_EMAIL, [sent("day", b.startsAtMs, null, "legacy_claimed")]), "send", "an unknown send time holds nothing back");
  eq(judge(b, HOUR_EMAIL, [sent("day", b.startsAtMs, Number.NaN)]), "send", "nor an unreadable one");
  eq(
    judge(b, HOUR_EMAIL, [{ emailId: "day", sentForMs: b.startsAtMs, status: "claimed", sentAtMs: null, claimedAtMs: NOW - 5 * MIN }]),
    "wait:gap",
    "a claim in flight is measured from when it was claimed",
  );
  eq(judge(b, HOUR_EMAIL, [sent("day", b.startsAtMs + HOUR, NOW - 10 * MIN)]), "send", "a send about another start is not in the gap");
}

// --- the hand back hold, with its fixed floor --------------------------------------------------
{
  eq(REMINDER_HOLD_MS, 10 * MIN, "the hold is ten minutes");
  eq(REMINDER_HOLD_FLOOR_MS, HOUR, "and never past an hour before the call");
  const made = (agoMs: number, startInMs: number) => booking({ createdAtMs: NOW - agoMs, startsAtMs: NOW + startInMs });
  eq(judge(made(5 * MIN, 5 * HOUR), DAY), "held", "a call booked five minutes ago is held");
  eq(judge(made(10 * MIN, 5 * HOUR), DAY), "send", "released at ten minutes");
  eq(judge(made(MIN, HOUR), DAY), "send", "the floor releases it at the hour mark");
  eq(judge(made(MIN, HOUR + 1), DAY), "held", "a millisecond before the floor it still holds");
  eq(
    judge(booking({ createdAtMs: NOW - 5 * MIN, startsAtMs: NOW + 50 * MIN }), email({ id: "x", minutesBefore: 60 })),
    "send",
    "a send now email inside the floor is never held",
  );
}

// --- who it goes to -----------------------------------------------------------------
{
  eq(judge(booking({ leadEmail: null }), DAY), "skip:no_email", "no address is a skip, never a page");
  eq(judge(booking({ leadEmail: "" }), DAY), "skip:no_email", "nor is a blank one");
  eq(judge(booking({ senderEmail: null }), DAY), "skip:no_sender", "no advisor mailbox to send from is its own skip");
  eq(judge(booking({ onPlaceholder: true }), DAY), "send", "a placeholder call is sent when the email says so");
  eq(judge(booking({ onPlaceholder: true }), email({ placeholderSends: false })), "skip:placeholder_off", "and skipped when not");
}

// --- the retry floor, fixed by lead ---------------------------------------------------------
{
  eq(REMINDER_RETRY_MARGIN_MS, 10 * MIN, "the retry margin is ten minutes");
  eq(reminderRetryFloorMs(DAY), REMINDER_HOLD_FLOOR_MS + REMINDER_RETRY_MARGIN_MS, "the day email retries until 70 minutes out, as today");
  eq(reminderRetryFloorMs(HOUR_EMAIL), HOUR_REMINDER_MIN_LEAD_MS + REMINDER_RETRY_MARGIN_MS, "the hour email until 40 minutes out, as today");
  eq(reminderRetryFloorMs(email({ minutesBefore: 61 })), 70 * MIN, "any lead over an hour lands before Regal's hour text");
  eq(reminderRetryFloorMs(email({ minutesBefore: 30 })), 40 * MIN, "a short lead keeps the half hour floor");
}

// --- a third email moves neither floor --------------------------------------------------------
{
  eq(reminderRetryFloorMs(TWELVE), 70 * MIN, "a 12 hour email retries until 70 minutes out");
  eq(reminderRetryFloorMs(DAY), 70 * MIN, "and the day email's floor is unchanged beside it");
  eq(reminderRetryFloorMs(HOUR_EMAIL), 40 * MIN, "and the hour email's");
  eq(judge(booking({ createdAtMs: NOW - 5 * MIN, startsAtMs: NOW + 5 * HOUR }), TWELVE, [], [DAY, TWELVE, HOUR_EMAIL]), "held", "the 12 hour email is held for the hand back");
  eq(judge(booking({ createdAtMs: NOW - MIN, startsAtMs: NOW + HOUR }), TWELVE, [], [DAY, TWELVE, HOUR_EMAIL]), "send", "and released by the same fixed floor");
}

// --- PARITY with today's judges, over a generated grid ------------------------------------------
//
// Today's columns are mapped onto send records the way the Phase 1 backfill maps them:
// a 24 hour send with a time is `sent`, one without (sent before #4282, or kept after a
// failure) is `legacy_claimed` or `failed`, and every 1 hour record is `legacy_claimed`.
// A released claim restored the column, which is the same as no record.
//
// The one deliberate difference: today's day email has no thirty minute minimum, so a
// call moved close in, or an outage caught up, sends it minutes before the call. The
// plan applies the minimum to every email, so every such case must come back
// `skip:too_close` and nothing else may differ.
{
  const startOffsets = [
    -MIN, 0, 1, 10 * MIN, 30 * MIN - 1, 30 * MIN, 30 * MIN + 1, 45 * MIN, HOUR - 1, HOUR, HOUR + 1,
    70 * MIN, 119 * MIN, 2 * HOUR, 2 * HOUR + 1, 3 * HOUR, 10 * HOUR, 24 * HOUR - 1, 24 * HOUR, 24 * HOUR + 1,
    30 * HOUR, Number.NaN,
  ];
  type DayState = { label: string; forStart: boolean | "other"; sentAt: number | null; status: SendRecord["status"] } | null;
  const dayStates: DayState[] = [
    null,
    { label: "sent just inside the gap", forStart: true, sentAt: NOW - 2 * HOUR + 1, status: "sent" },
    { label: "sent at the gap", forStart: true, sentAt: NOW - 2 * HOUR, status: "sent" },
    { label: "sent five minutes ago", forStart: true, sentAt: NOW - 5 * MIN, status: "sent" },
    { label: "sent a day ago", forStart: true, sentAt: NOW - 30 * HOUR, status: "sent" },
    { label: "sent with no time", forStart: true, sentAt: null, status: "legacy_claimed" },
    { label: "failed and kept", forStart: true, sentAt: null, status: "failed" },
    { label: "released", forStart: true, sentAt: null, status: "released" },
    { label: "sent about another start", forStart: "other", sentAt: NOW - 5 * MIN, status: "sent" },
  ];
  const hourStates: (boolean | "other" | null)[] = [null, true, "other"];
  let compared = 0;
  let tooCloseDifferences = 0;
  let held = 0;
  let sendCount = 0;
  let gapWaits = 0;
  const mismatches: string[] = [];
  for (const startOffset of startOffsets) {
    const startsAtMs = NOW + startOffset;
    const createdList = [
      NOW, NOW - MIN, NOW - 10 * MIN + 1, NOW - 10 * MIN, NOW - 10 * MIN - 1, NOW - 30 * MIN, NOW - 2 * HOUR,
      NOW - 2 * HOUR - 1, NOW - 26 * HOUR, NOW - 3 * 24 * HOUR, startsAtMs - HOUR, startsAtMs - HOUR + 1,
      startsAtMs - HOUR - 1, startsAtMs - 24 * HOUR, startsAtMs - 24 * HOUR + 1, startsAtMs - 70 * MIN, Number.NaN,
    ].filter((c) => !(c > NOW));
    for (const createdAtMs of createdList) {
      for (const day of dayStates) {
        for (const hour of hourStates) {
          for (const status of ["confirmed", "rescheduled", "cancelled"]) {
            for (const leadEmail of ["lead@example.com", null]) {
              const otherStart = startsAtMs + 3 * HOUR;
              // Today's columns.
              const dayLive = day !== null && day.status !== "released";
              const reminderSentForMs = dayLive ? (day.forStart === true ? startsAtMs : otherStart) : null;
              const dayReminderSentAtMs = dayLive ? day.sentAt : null;
              const hourReminderSentForMs = hour === null ? null : hour === true ? startsAtMs : otherStart;
              // The same history as send records.
              const sends: SendRecord[] = [];
              if (day) sends.push(sent("day", day.forStart === true ? startsAtMs : otherStart, day.sentAt, day.status));
              if (hour !== null) sends.push(sent("hour", hour === true ? startsAtMs : otherStart, null, "legacy_claimed"));
              const b = booking({ startsAtMs, createdAtMs, status, leadEmail });

              // Today's day email, as the lane reads the three judges.
              const dayDue = reminderDue({ startsAtMs, reminderSentForMs, hourReminderSentForMs, status }, NOW);
              const todayDay = !dayDue
                ? "other"
                : reminderHeld({ createdAtMs, startsAtMs }, NOW)
                  ? "held"
                  : leadEmail
                    ? "send"
                    : "skip:no_email";
              const hourDue = hourReminderDue(
                { startsAtMs, createdAtMs, status, hourReminderSentForMs, dayReminderSentForMs: reminderSentForMs, dayReminderSentAtMs },
                NOW,
              );
              const todayHour = !hourDue ? "other" : leadEmail ? "send" : "skip:no_email";

              for (const [e, today] of [[DAY, todayDay], [HOUR_EMAIL, todayHour]] as const) {
                const d = reminderDecision(b, e, sends, TODAY, NOW);
                const shown = show(d);
                const mapped = shown === "send" || shown === "held" || shown === "skip:no_email" ? shown : "other";
                if (shown === "wait:gap") gapWaits += 1;
                if (mapped === "held") held += 1;
                if (mapped === "send") sendCount += 1;
                compared += 1;
                if (mapped === today) continue;
                const deliberate =
                  e === DAY && shown === "skip:too_close" && (today === "send" || today === "skip:no_email") && startsAtMs - NOW < 30 * MIN;
                if (deliberate) {
                  tooCloseDifferences += 1;
                  continue;
                }
                mismatches.push(
                  `${e.id}: today ${today}, new ${shown}; start +${startOffset / MIN}m, created ${(createdAtMs - NOW) / MIN}m, ` +
                    `day ${day?.label ?? "none"}, hour ${String(hour)}, ${status}, email ${leadEmail ?? "none"}`,
                );
              }
            }
          }
        }
      }
    }
  }
  assert(compared > 50_000, `the grid is large (${compared} decisions compared)`);
  assert(held > 0, `the grid reaches the hold (${held} held)`);
  assert(sendCount > 0, `the grid reaches a send (${sendCount} sends)`);
  assert(gapWaits > 0, `the grid reaches the gap (${gapWaits} gap waits)`);
  assert(tooCloseDifferences > 0, `the deliberate thirty minute difference is exercised (${tooCloseDifferences} cases)`);
  eq(mismatches.length, 0, "the new judge agrees with reminderDue, reminderHeld and hourReminderDue everywhere else");
  for (const m of mismatches.slice(0, 8)) console.error("  mismatch:", m);

  // A third email in the list, with nothing sent for it, changes no decision of the two.
  let changed = 0;
  for (const startOffset of startOffsets) {
    for (const createdAgo of [0, 5 * MIN, 10 * MIN, 3 * HOUR, 3 * 24 * HOUR]) {
      const b = booking({ startsAtMs: NOW + startOffset, createdAtMs: NOW - createdAgo });
      for (const e of TODAY) {
        if (judge(b, e, [], TODAY) !== judge(b, e, [], [DAY, TWELVE, HOUR_EMAIL])) changed += 1;
      }
    }
  }
  eq(changed, 0, "adding a 12 hour email changes no decision of the day or hour email");
}

finish();
