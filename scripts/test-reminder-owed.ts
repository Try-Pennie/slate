// The owed reminder email check (#4300, replacing #4295). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-owed.ts
//
// A send that fails pages, but a booking the reminder lane wrongly skips or never
// reaches fails nothing (the first run after #4284 emailed 47 leads at once and was
// caught by hand). So the monitor lane reads, per switched on email, the live calls
// still ahead whose window opened over 15 minutes ago, and pages when the lane recorded
// nothing for one, or claimed one over 15 minutes ago and never settled it.
//
// It must judge "owed" by its OWN reading of the rules (L721), never `reminderDecision`:
// a monitor sharing the gate's predicate agrees with it about every blind spot. So both
// directions are driven here: it fires on a forgotten booking and a stale claim, and
// stays quiet on every case the rules legitimately hold back (the two hour gap, a late
// booking on a skip email, the 30 minute minimum, a placeholder call the email skips, no
// address, no mailbox, an email switched on mid window, a call that moved minutes ago).
import { readFileSync } from "node:fs";
import {
  judgeReminderOwed,
  reminderOwedAlert,
  reminderOwedAlertKey,
  reminderOwedAllClear,
  reminderOwedStandDown,
  REMINDER_OWED_GRACE_MS,
  runReminderOwedCheck,
} from "../src/lib/monitor/reminder-owed.ts";
import { loadOwedBookings } from "../src/lib/monitor/reminder-owed-store.ts";
import { sendRecordsForBooking } from "../src/lib/booking/reminder-legacy.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { booking, DAY_EMAIL, email, HOUR, HOUR_EMAIL, iso, MIN, NOW, owedDeps, send } from "./lib/reminder-owed-fake.ts";

const ALL = [DAY_EMAIL, HOUR_EMAIL];
const verdict = (b: ReturnType<typeof booking>, e = HOUR_EMAIL, emails = ALL) =>
  judgeReminderOwed(b, e, sendRecordsForBooking(b, emails), NOW).kind;

// --- L721: it never asks the gate ----------------------------------------------------
{
  const src = readFileSync(new URL("../src/lib/monitor/reminder-owed.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert(!/reminderDecision|reminderHeld|hourReminderDue|reminderDue/.test(code), "the owed check calls none of the lane's judges");
  assert(!/reminder-decision/.test(code.replace(/import type[^;]*;/g, "")), "and imports nothing but types from the lane's decision module");
}

// --- it fires on a forgotten booking ------------------------------------------------
{
  // The 1 hour email's window opened 20 minutes ago and nothing is recorded.
  const b = booking(40 * MIN);
  eq(verdict(b), "owed", "a call whose window opened 20 minutes ago with nothing recorded is owed");
  const { deps, spy } = owedDeps(ALL, [b]);
  const r = await runReminderOwedCheck(deps);
  assert(r.status === "checked", "a readable tick is checked");
  eq(spy.paged.map((p) => p.key), [reminderOwedAlertKey("hour")], "and pages under that email's key");
  eq(spy.paged[0]?.subjects, ["bk-1"], "naming the booking as the page's subject, so a new one posts at once");
  assert(spy.paged[0]!.text.includes("1 hour reminder"), `the page names the email (${spy.paged[0]?.text})`);
  assert(spy.paged[0]!.text.includes("bk-1"), "and the booking");
}

// --- inside the 15 minute grace it waits --------------------------------------------
{
  eq(REMINDER_OWED_GRACE_MS, 15 * MIN, "the grace is 15 minutes");
  eq(verdict(booking(50 * MIN)), "not_yet", "a window opened 10 minutes ago is not yet owed");
  eq(verdict(booking(44 * MIN)), "owed", "and one opened 16 minutes ago is");
}

// --- every resolved record settles it; a released claim does not ---------------------
{
  const b = booking(40 * MIN);
  const withSend = (status: "sent" | "skipped" | "failed" | "released", at: { sentAtMs?: number; claimedAtMs?: number }) =>
    booking(40 * MIN, { sends: [send(b, HOUR_EMAIL, status, at)] });
  eq(verdict(withSend("sent", { sentAtMs: NOW - 19 * MIN, claimedAtMs: NOW - 19 * MIN })), "settled", "sent settles it");
  eq(verdict(withSend("skipped", { claimedAtMs: NOW - 19 * MIN })), "settled", "a recorded skip settles it");
  eq(verdict(withSend("failed", { claimedAtMs: NOW - 19 * MIN })), "settled", "a failure settles it: it pages on its own");
  eq(verdict(withSend("released", { claimedAtMs: NOW - 19 * MIN })), "owed", "a released claim with no send since does not");
  eq(
    verdict(booking(40 * MIN, { hourReminderSentForIso: b.startsAtIso })),
    "settled",
    "a legacy record in the bookings column settles it, read through the one helper",
  );
  const other = booking(40 * MIN, { sends: [{ ...send(b, HOUR_EMAIL, "sent", { sentAtMs: NOW - 2 * HOUR }), sentForIso: iso(NOW + 3 * HOUR) }] });
  eq(verdict(other), "owed", "a record about the call's EARLIER start does not count for this one");
}

// --- it fires on a stale claim -------------------------------------------------------
{
  const b = booking(40 * MIN);
  const stale = booking(40 * MIN, { sends: [send(b, HOUR_EMAIL, "claimed", { claimedAtMs: NOW - 16 * MIN })] });
  const fresh = booking(40 * MIN, { sends: [send(b, HOUR_EMAIL, "claimed", { claimedAtMs: NOW - 5 * MIN })] });
  eq(verdict(stale), "stale_claim", "a claim 16 minutes old that never settled pages");
  eq(verdict(fresh), "in_flight", "a claim 5 minutes old is a send in flight");
  const { deps, spy } = owedDeps(ALL, [stale]);
  await runReminderOwedCheck(deps);
  assert(spy.paged[0]?.text.includes("claimed") ?? false, `the stale claim page says what is stuck (${spy.paged[0]?.text})`);
}

// --- quiet: the two hour gap after another email for this start ---------------------
{
  // Booked 90 minutes out, so the 24 hour email went at once (send_now). The 1 hour
  // email's window opened 20 minutes ago, inside the gap, which runs until after the
  // 30 minute minimum: the lane will record a too_close skip then, never a send.
  const created = NOW + 40 * MIN - 90 * MIN;
  const b = booking(40 * MIN, { createdAtIso: iso(created), updatedAtIso: iso(created) });
  const inGap = { ...b, sends: [send(b, DAY_EMAIL, "sent", { sentAtMs: created + 2 * MIN, claimedAtMs: created + 2 * MIN })] };
  eq(verdict(inGap), "not_yet", "an email the gap can still be holding back is not paged");
  const old = { ...b, sends: [send(b, DAY_EMAIL, "sent", { sentAtMs: NOW - 3 * HOUR, claimedAtMs: NOW - 3 * HOUR })] };
  eq(verdict(old), "owed", "CONTROL: a sibling sent three hours ago holds nothing back");
  const inGapClaim = { ...b, sends: [send(b, DAY_EMAIL, "claimed", { claimedAtMs: NOW - 10 * MIN })] };
  eq(verdict(inGapClaim), "not_yet", "a sibling still being claimed holds the gap too");
}

// --- quiet: a late booking on a skip email -------------------------------------------
{
  // Booked 55 minutes before the call, after the 1 hour email's window opened 20 minutes ago.
  const created = NOW + 35 * MIN - 55 * MIN;
  const late = booking(35 * MIN, { createdAtIso: iso(created), updatedAtIso: iso(created) });
  eq(verdict(late), "not_owed", "a late booking on a skip email is owed nothing");
  eq(verdict(late, email({ lateBooking: "send_now" })), "owed", "CONTROL: the same booking on a send now email is owed");
}

// --- quiet: the 30 minute minimum ----------------------------------------------------
{
  // Booked 25 minutes before the call, 20 minutes ago, on a send now email.
  const created = NOW - 20 * MIN;
  const close = booking(5 * MIN, { createdAtIso: iso(created), updatedAtIso: iso(created) });
  eq(verdict(close, email({ lateBooking: "send_now" })), "not_owed", "a window that opened under 30 minutes out is owed nothing");
}

// --- quiet: a placeholder call the email skips ---------------------------------------
{
  const b = booking(40 * MIN, { onPlaceholder: true });
  eq(verdict(b, email({ placeholderSends: false })), "not_owed", "a placeholder call with the email off for it");
  eq(verdict(b, email({ placeholderSends: true })), "owed", "CONTROL: and owed when the email does go to placeholder calls");
}

// --- quiet: no address, no mailbox ---------------------------------------------------
{
  eq(verdict(booking(40 * MIN, { attendeeEmail: null })), "not_owed", "no lead address");
  eq(verdict(booking(40 * MIN, { attendeeEmail: "   " })), "not_owed", "a blank lead address");
  eq(verdict(booking(40 * MIN, { agentEmail: null })), "not_owed", "no advisor mailbox to send from");
}

// --- quiet: an email switched on mid window ------------------------------------------
{
  const b = booking(40 * MIN);
  eq(verdict(b, email({ effectiveFromIso: iso(NOW - 10 * MIN) })), "not_owed", "switched on after this booking's window opened");
  eq(verdict(b, email({ effectiveFromIso: iso(NOW - 30 * MIN) })), "owed", "CONTROL: switched on before it opened");
  eq(verdict(b, email({ enabled: false })), "not_owed", "an email switched off is owed to nobody");
}

// --- quiet: a call that moved into the window minutes ago ----------------------------
{
  eq(verdict(booking(40 * MIN, { updatedAtIso: iso(NOW - 5 * MIN) })), "not_yet", "moved 5 minutes ago: the lane has not had its tick");
  eq(verdict(booking(40 * MIN, { updatedAtIso: iso(NOW - 20 * MIN) })), "owed", "moved 20 minutes ago: it has");
}

// --- quiet: past calls and dead bookings ---------------------------------------------
{
  eq(verdict(booking(-5 * MIN)), "not_owed", "a call that has started is no longer judged");
  eq(verdict(booking(40 * MIN, { status: "cancelled" })), "not_owed", "a cancelled call");
  eq(verdict(booking(40 * MIN, { startsAtIso: "not a time" })), "unreadable", "an unreadable start is said, never judged");
}

// --- the read window is the longest switched on lead ---------------------------------
{
  const { deps, spy } = owedDeps([DAY_EMAIL, HOUR_EMAIL, email({ id: "e3", slug: "two_day", minutesBefore: 2880, enabled: false })], []);
  await runReminderOwedCheck(deps);
  eq(spy.windowEnds, [iso(NOW + 24 * HOUR)], "the 24 hour email's lead, not the switched off 48 hour one's");
  const none = owedDeps([email({ enabled: false })], []);
  await runReminderOwedCheck(none.deps);
  eq(none.spy.windowEnds, [], "with nothing switched on, no booking is read");
}

// --- a failed read measures nothing, pages nobody, clears nothing --------------------
for (const which of ["loadEmails", "loadBookings", "loadFiringSlugs"] as const) {
  const { deps, spy } = owedDeps(ALL, [booking(40 * MIN)], {
    firing: ["hour"],
    [which]: async () => {
      throw new Error(`${which} failed`);
    },
  });
  const r = await runReminderOwedCheck(deps);
  eq(r.status, "unreadable", `a failed ${which} is unreadable`);
  eq(spy.paged.length, 0, `and ${which} failing pages nobody`);
  eq(spy.resolved.length, 0, `and ${which} failing clears nothing`);
}

// --- the all clear hangs off a measured read ---------------------------------------
{
  const b = booking(40 * MIN);
  const sent = { ...b, sends: [send(b, HOUR_EMAIL, "sent", { sentAtMs: NOW - 18 * MIN, claimedAtMs: NOW - 18 * MIN })] };
  const { deps, spy } = owedDeps(ALL, [sent], { firing: ["hour", "gone", "day"] });
  await runReminderOwedCheck(deps);
  eq(spy.paged.length, 0, "nothing owed pages nobody");
  const byKey = Object.fromEntries(spy.resolved.map((c) => [c.key, c.text]));
  eq(byKey[reminderOwedAlertKey("hour")], reminderOwedAllClear(HOUR_EMAIL.name), "the measured clean email clears in the recovery's words");
  eq(byKey[reminderOwedAlertKey("gone")], reminderOwedStandDown(undefined), "an email no longer stored stands down in its own words");
  eq(byKey[reminderOwedAlertKey("day")], reminderOwedAllClear(DAY_EMAIL.name), "the 24 hour email, owed nothing, clears too");
  const off = owedDeps([email({ enabled: false })], [], { firing: ["hour"] });
  await runReminderOwedCheck(off.deps);
  eq(off.spy.resolved.map((c) => c.text), [reminderOwedStandDown(HOUR_EMAIL.name)], "a switched off email stands down, never 'recovered'");
}

// --- a firing email still owed is not cleared ----------------------------------------
{
  const { deps, spy } = owedDeps(ALL, [booking(40 * MIN)], { firing: ["hour"] });
  await runReminderOwedCheck(deps);
  eq(spy.resolved.length, 0, "an email still owed clears nothing");
  eq(spy.paged.length, 1, "and pages again (the dispatcher decides whether that posts)");
}

// --- the copy names the count and each kind ----------------------------------------
{
  const text = reminderOwedAlert("1 hour reminder", {
    unrecorded: ["bk-1", "bk-2"],
    staleClaims: ["bk-3"],
  });
  assert(text.startsWith("The 1 hour reminder email is owed to 3 leads"), `opens with the email and the count (${text})`);
  assert(text.includes("bk-1") && text.includes("bk-3"), "names every booking");
  assert(/Sent mail/.test(text), "and says to check the mailbox before resending a stale claim by hand");
  const many = reminderOwedAlert("1 hour reminder", { unrecorded: Array.from({ length: 14 }, (_, i) => `bk-${i}`), staleClaims: [] });
  assert(many.includes("and 4 more"), `a long list is cut, saying how many more (${many})`);
}

// --- the store leaves test bookings out through the bucket ---------------------------
{
  const calls: { method: string; args: unknown[] }[] = [];
  const rows = [
    { id: "bk-real", buckets: { is_test: false } },
    { id: "bk-test", buckets: { is_test: true } },
  ];
  const query = () => {
    let filtered = rows;
    const q: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["select", "in", "gt", "lte", "order", "or"]) {
      q[m] = (...a: unknown[]) => {
        calls.push({ method: m, args: a });
        return q;
      };
    }
    q.eq = (col: unknown, val: unknown) => {
      calls.push({ method: "eq", args: [col, val] });
      if (col === "buckets.is_test") filtered = filtered.filter((r) => r.buckets.is_test === val);
      return q;
    };
    q.range = async () => ({ data: filtered.map((r) => ({ ...r, starts_at: iso(NOW + HOUR), created_at: iso(NOW - HOUR), updated_at: iso(NOW - HOUR), status: "confirmed", kind: "standard", booking_reminder_sends: [] })), error: null });
    return q;
  };
  const db = { from: () => query() } as unknown as Parameters<typeof loadOwedBookings>[0];
  const got = await loadOwedBookings(db, iso(NOW), iso(NOW + 24 * HOUR));
  eq(got.map((b) => b.id), ["bk-real"], "a booking in a test bucket is never read");
  assert(calls.some((c) => c.method === "eq" && c.args[0] === "buckets.is_test" && c.args[1] === false), "filtered through the bucket's flag");
  assert(
    calls.some((c) => c.method === "select" && String(c.args[0]).includes("buckets!inner(is_test)")),
    "joined inner, so a booking with no readable bucket is left out rather than read as real",
  );
}

finish();
