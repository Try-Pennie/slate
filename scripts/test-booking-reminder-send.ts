// The 24 hour reminder lane's orchestration (#2359): claim, then send, and what
// happens when the send fails. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-reminder-send.ts
//
// This is a scheduled job that sends something a REAL PERSON reads, so the property
// under test is that it is safe to run twice. Every dependency is injected, so the
// ordering that makes it safe is asserted rather than assumed.
import { runBookingReminders, type ReminderDeps, type DueBooking } from "../src/lib/booking/reminder-send.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 8, 16, 14, 0, 0);

const due = (over: Partial<DueBooking> = {}): DueBooking => ({
  id: "bk-1",
  startsAtIso: new Date(NOW + 12 * HOUR).toISOString(),
  reminderSentForIso: null,
  status: "confirmed",
  attendeeEmail: "lead@example.com",
  agentEmail: "jordan@trypennie.com",
  agentName: "Jordan Lee",
  timezone: "America/New_York",
  manageUrl: "https://slate.trypennie.app/manage/abc",
  ...over,
});

/** Records the ORDER of every effect, which is the whole subject of this suite. */
function spy(over: Partial<ReminderDeps> = {}) {
  const order: string[] = [];
  const sent: { to: string; subject: string }[] = [];
  const alerts: string[] = [];
  const deps: ReminderDeps = {
    now: () => NOW,
    loadDue: async () => [due()],
    claim: async (id) => {
      order.push(`claim:${id}`);
      return true;
    },
    send: async (msg) => {
      order.push(`send:${msg.to[0]}`);
      sent.push({ to: msg.to[0]!, subject: msg.subject });
      return "gmail-id";
    },
    alert: async (text) => {
      order.push("alert");
      alerts.push(text);
    },
    ...over,
  };
  return { deps, order, sent, alerts };
}

// --- the claim comes BEFORE the send, which is what makes a crash safe -----------
//
// The two are not transactional, so one of them has to be first and the choice
// decides which way a crash between them is wrong. Claiming first costs a reminder;
// sending first sends a second copy to a real person on the next tick, and an email
// cannot be taken back. A test asserting only that both happened would pass either
// way round, so this asserts the ORDER (L228).
{
  const s = spy();
  await runBookingReminders(s.deps);
  eq(s.order.join(" -> "), "claim:bk-1 -> send:lead@example.com", "the claim is written before Gmail is called");
  eq(s.sent.length, 1, "and exactly one email goes out");
}

// --- a booking somebody else claimed first is not sent twice ----------------------
//
// Two ticks can overlap (a slow send, a retried invocation), and the claim is a
// conditional write, so the loser is told so and must not send. This is the
// concurrency case the issue asks for: assume it runs twice (L157).
{
  const s = spy({ claim: async () => false });
  await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "a booking whose claim was lost sends nothing");
  eq(s.alerts.length, 0, "and losing a claim is not a fault, so nothing is alerted");
}

// --- a failed send is LOUD, and stays claimed ------------------------------------
//
// The claim is deliberately not released. Releasing it would retry, and a send that
// timed out AFTER Gmail accepted the message is indistinguishable here from one that
// never arrived, so a retry is the one path that can deliver twice. The gap is made
// visible instead of silently recovered (L12: report what verifiably happened).
{
  const s = spy({
    send: async () => {
      throw new Error("Gmail send failed: 503");
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(s.alerts.length, 1, "a send that failed says so");
  assert(/reminder/i.test(s.alerts[0]!), "the alert names what did not go out");
  assert(/bk-1/.test(s.alerts[0]!), "and names the booking, so it can be looked at");
  assert(
    !/503/.test(s.alerts[0]!) || s.alerts[0]!.length < 300,
    "and stays short enough to read on a phone rather than pasting the raw error",
  );
  eq(result.failed, 1, "the run reports the failure to its caller rather than swallowing it");
  eq(result.sent, 0, "and counts nothing as sent");
}

// --- one lead's failure does not stop the others ---------------------------------
//
// A wave of reminders is independent work, so a single bad address must not cost
// everybody else theirs (L73).
{
  const rows = [due({ id: "bk-1" }), due({ id: "bk-2" }), due({ id: "bk-3" })];
  // Failed by POSITION, because the message carries no booking id: the subject is
  // what a lead reads, and putting an internal id in it to make a test easier would
  // be the test shaping the product.
  let n = 0;
  const s = spy({
    loadDue: async () => rows,
    send: async () => {
      n += 1;
      if (n === 2) throw new Error("bad address");
      return "id";
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 2, "the other two are still sent");
  eq(result.failed, 1, "and the one failure is counted");
}

// --- nothing due is a clean, quiet run -------------------------------------------
{
  const s = spy({ loadDue: async () => [] });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 0, "nothing due sends nothing");
  eq(s.alerts.length, 0, "and says nothing, because an empty queue is the normal state");
}

// --- a row the load returned that is no longer due is re-checked ------------------
//
// The query and the judgement are two different things, and the judgement is the one
// that owns the rule. A row that stopped being due between the read and the loop (it
// was cancelled, or moved) must not be sent just because a SQL WHERE clause matched
// it a moment ago (L166).
{
  const s = spy({ loadDue: async () => [due({ status: "cancelled" })] });
  await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "a cancelled row the query returned is not emailed");
  eq(s.order.length, 0, "and is not even claimed");
}

// --- a lead with no email address cannot be reminded -----------------------------
//
// It is not an error worth paging about: a booking can legitimately carry a phone and
// no address. It must not be claimed either, or the row is marked reminded for a
// message that never existed.
{
  const s = spy({ loadDue: async () => [due({ attendeeEmail: null })] });
  const result = await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "no address means no email");
  eq(s.order.length, 0, "and no claim, so the row is not marked as reminded");
  eq(result.skipped, 1, "the run counts it, because a silent skip is how a gap hides");
}

// --- the run reports WHY each send failed, in a bounded vocabulary ---------------
//
// #2496. One lead's refused address and every reminder failing are the same single
// throttled message today, so the lane also measures a SHARE, and a share is only
// actionable if it can name what is failing. The classification happens HERE, where
// the error is caught, rather than in the window: the window stores counts, and a
// map keyed on the provider's raw message would have one key per message.
{
  const boom = (msg: string) => async () => {
    throw new Error(msg);
  };
  const s = spy({
    loadDue: async () => [
      due({ id: "a", attendeeEmail: "a@x.com" }),
      due({ id: "b", attendeeEmail: "b@x.com" }),
      due({ id: "c", attendeeEmail: "c@x.com" }),
    ],
  });
  let n = 0;
  s.deps.send = async () => {
    n += 1;
    if (n === 1) return boom("Gmail send failed: 403 forbidden")();
    if (n === 2) return boom("Gmail send failed: 403 forbidden")();
    return boom("Gmail send failed: 400 Invalid To header")();
  };
  const result = await runBookingReminders(s.deps);
  eq(result.failed, 3, "all three failed");
  eq(result.attempted, 3, "and all three were attempted");
  eq(result.byCode.not_authorised, 2, "two of them because the mailbox refused us");
  eq(result.byCode.recipient_refused, 1, "and one because the address was rejected");
}

// --- a lead with no address is not an ATTEMPT --------------------------------------
//
// The share is failures over sends ATTEMPTED. Counting a booking with no address in
// the denominator would make a real outage look proportionally smaller exactly while
// it was happening, which is the thing a share exists to prevent.
{
  const s = spy({
    loadDue: async () => [
      due({ id: "a", attendeeEmail: null }),
      due({ id: "b", attendeeEmail: "b@x.com" }),
    ],
  });
  const result = await runBookingReminders(s.deps);
  eq(result.skipped, 1, "the addressless booking is skipped");
  eq(result.attempted, 1, "and is not in the denominator of the share");
  eq(Object.keys(result.byCode).length, 0, "a clean run names no failure reasons");
}

finish();
