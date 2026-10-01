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
const LEAD = "00QUi000010889ZMAQ";

const due = (over: Partial<DueBooking> = {}): DueBooking => ({
  id: "bk-1",
  startsAtIso: new Date(NOW + 12 * HOUR).toISOString(),
  // Old enough to be past the hand-back hold (#2633), so the suites below judge the
  // send path rather than the hold. The hold has its own section at the end.
  createdAtIso: new Date(NOW - HOUR).toISOString(),
  reminderSentForIso: null,
  status: "confirmed",
  attendeeEmail: "lead@example.com",
  agentEmail: "jordan@trypennie.com",
  agentName: "Jordan Lee",
  timezone: "America/New_York",
  manageUrl: "https://slate.trypennie.app/manage/abc",
  leadId: LEAD,
  gcalEventId: "evt-1",
  attendeePhone: "+12035615295",
  ...over,
});

/** Records the ORDER of every effect, which is the whole subject of this suite. */
function spy(over: Partial<ReminderDeps> = {}) {
  const order: string[] = [];
  const sent: { to: string; subject: string }[] = [];
  const alerts: string[] = [];
  const warnings: string[] = [];
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
    // No calling number known by default, so the suites above judge the send path
    // exactly as it was; the calling number has its own section at the end.
    readCallingNumbers: async () => new Map(),
    refreshInvite: async () => {
      order.push("refresh");
    },
    warn: (msg) => {
      warnings.push(msg);
    },
    ...over,
  };
  return { deps, order, sent, alerts, warnings };
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

// --- a young booking is HELD, visibly, and not claimed (#2633) --------------------
//
// A held booking is neither a failure nor a send: it is owed a reminder on a later
// tick. So it is not claimed (claiming would mark it reminded for a message that
// does not exist yet), not attempted (the failure share must not shrink while a
// real outage runs), and it is COUNTED, because a silent skip is how a gap hides.
{
  const MIN = 60_000;
  const s = spy({
    loadDue: async () => [
      due({ id: "young", createdAtIso: new Date(NOW - 2 * MIN).toISOString() }),
      due({ id: "old", attendeeEmail: "old@x.com", createdAtIso: new Date(NOW - 11 * MIN).toISOString() }),
    ],
  });
  const result = await runBookingReminders(s.deps);
  eq(result.held, 1, "the two minute old booking is held");
  eq(result.sent, 1, "the eleven minute old one is sent");
  eq(result.attempted, 1, "a held booking is not an attempt");
  eq(result.failed, 0, "and not a failure");
  eq(result.skipped, 0, "and not an addressless skip either, which is a different fact");
  assert(!s.order.includes("claim:young"), "the held booking is not claimed");
  eq(s.sent.map((m) => m.to).join(","), "old@x.com", "only the older booking's lead is emailed");
}

// --- a call starting soon is sent despite being seconds old ----------------------
{
  const s = spy({
    loadDue: async () => [
      due({
        createdAtIso: new Date(NOW - 5_000).toISOString(),
        startsAtIso: new Date(NOW + 40 * 60_000).toISOString(),
      }),
    ],
  });
  const result = await runBookingReminders(s.deps);
  eq(result.held, 0, "a call forty minutes out is inside the floor, so it is not held");
  eq(result.sent, 1, "and its reminder goes out on this tick");
}

// --- held, then handed back, then sent: the email names the NEW advisor ------------
//
// The whole point of the hold. Tick one sees the booking seconds old on the first
// advisor and holds it; the owner hand-back then moves it; tick two, past the hold,
// reads the row again and sends from, and signs as, the owner who will call.
{
  const MIN = 60_000;
  const created = NOW;
  const startsAtIso = new Date(NOW + 5 * HOUR).toISOString();
  const row = (agentEmail: string, agentName: string) =>
    due({ createdAtIso: new Date(created).toISOString(), startsAtIso, agentEmail, agentName });

  let clock = created + 30_000;
  let current = row("asage@trypennie.com", "Alex Sage");
  const froms: string[] = [];
  const bodies: string[] = [];
  const s = spy({
    now: () => clock,
    loadDue: async () => [current],
    send: async (msg) => {
      froms.push(msg.from);
      bodies.push(msg.body);
      return "gmail-id";
    },
  });

  const first = await runBookingReminders(s.deps);
  eq(first.held, 1, "tick one: seconds old, held");
  eq(froms.length, 0, "and nothing is sent from the first advisor");

  current = row("trios@trypennie.com", "Taylor Rios");
  clock = created + 10 * MIN + 30_000;
  const second = await runBookingReminders(s.deps);
  eq(second.held, 0, "tick two: past the hold, released");
  eq(second.sent, 1, "and sent");
  eq(froms.join(","), "trios@trypennie.com", "from the NEW advisor's mailbox, so a reply reaches them");
  assert(bodies[0]!.includes("Taylor Rios"), "and signed by the new advisor");
  assert(!bodies[0]!.includes("Alex Sage"), "with no trace of the first");
}

// --- the number we will call FROM (#1334) --------------------------------------------
//
// Read from Salesforce once per tick for the bookings actually being sent, named in
// the email with the advisor's contact card attached, and written into the invite.
// Every way of not knowing it sends the reminder exactly as before: the number is a
// help to the lead, and the reminder itself is the promise.
{
  const asked: string[][] = [];
  const refreshed: { agent: string; event: string; description: string }[] = [];
  const msgs: import("../src/lib/notify/email-mime.ts").MimeMessage[] = [];
  const s = spy({
    loadDue: async () => [due(), due({ id: "bk-2", leadId: null, gcalEventId: "evt-2" })],
    readCallingNumbers: async (ids) => {
      asked.push(ids);
      return new Map([["00QUi000010889Z", "+12197588170"]]);
    },
    send: async (msg) => {
      msgs.push(msg);
      return "gmail-id";
    },
    refreshInvite: async (agent, event, description) => {
      refreshed.push({ agent, event, description });
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(asked.length, 1, "one Salesforce read for the whole tick, not one per booking");
  eq(asked[0], [LEAD], "asking only about the leads that have a lead id");
  eq(result.sent, 2, "both reminders go out");
  eq(result.withCallingNumber, 1, "one carried a calling number, and the run says so");

  const withNumber = msgs[0]!;
  assert(withNumber.body.includes("(219) 758-8170"), "the reminder names the calling number");
  eq(withNumber.attachments?.length ?? 0, 1, "and attaches one contact card");
  const card = withNumber.attachments![0]!;
  eq(card.mimeType, "text/vcard", "a vCard");
  const tels = card.content.split("\r\n").filter((l) => l.startsWith("TEL"));
  eq(tels, ["TEL;TYPE=WORK,VOICE:+12197588170"], "carrying the calling number and no other phone");
  assert(card.content.includes("jordan@trypennie.com"), "and the advisor's address, which is the sender");

  const noLead = msgs[1]!;
  eq(noLead.attachments?.length ?? 0, 0, "a booking with no lead id gets no card");
  assert(!noLead.body.includes("(219)"), "and no number");

  eq(refreshed.length, 1, "the invite is refreshed only where a number is known");
  eq(refreshed[0]!.agent, "jordan@trypennie.com", "on the advisor's calendar");
  eq(refreshed[0]!.event, "evt-1", "the booking's own event");
  assert(refreshed[0]!.description.includes("(219) 758-8170"), "with the calling number in the description");
  assert(refreshed[0]!.description.includes("https://slate.trypennie.app/manage/abc"), "and the manage link kept");
  assert(refreshed[0]!.description.includes("Phone: +12035615295"), "and the lead's own number kept for the advisor");
}

// The ORDER: the invite is touched only AFTER the reminder went out, so a failure
// writing the invite can never cost the lead their reminder.
{
  const s = spy({ readCallingNumbers: async () => new Map([["00QUi000010889Z", "+12197588170"]]) });
  await runBookingReminders(s.deps);
  eq(s.order.join(" -> "), "claim:bk-1 -> send:lead@example.com -> refresh", "claim, send, then the invite");
}

// A failed Salesforce read sends every reminder without a number, and says so.
{
  const msgs: import("../src/lib/notify/email-mime.ts").MimeMessage[] = [];
  const s = spy({
    readCallingNumbers: async () => {
      throw new Error("SF query failed: 503");
    },
    send: async (msg) => {
      msgs.push(msg);
      return "gmail-id";
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 1, "the reminder still goes out when Salesforce cannot be read");
  eq(msgs[0]!.attachments?.length ?? 0, 0, "with no card");
  assert(/nothing you need to set up/.test(msgs[0]!.body), "and the copy that names no number");
  eq(result.callingNumberUnread, true, "the run reports the read failed, so the log can say why no number went out");
  eq(s.order.includes("refresh"), false, "and the invite is left alone");
  eq(s.alerts.length, 0, "it is not a paging fault: no reminder was lost");
  eq(s.warnings.length, 1, "but the failed read is logged with its reason");
}

// A lost claim writes nothing to the invite. The number is read before the claims
// (one batched read per tick), so a lost booking may have been asked about; what
// matters is that nothing is sent or written for it.
{
  const s = spy({
    claim: async () => false,
    readCallingNumbers: async () => new Map([["00QUi000010889Z", "+12197588170"]]),
  });
  await runBookingReminders(s.deps);
  eq(s.order.includes("refresh"), false, "a lost claim writes nothing to the invite");
}
// The read is skipped entirely when nothing is sendable.
{
  let read = false;
  const s = spy({
    loadDue: async () => [due({ attendeeEmail: null })],
    readCallingNumbers: async () => {
      read = true;
      return new Map();
    },
  });
  await runBookingReminders(s.deps);
  eq(read, false, "a tick with nothing sendable never calls Salesforce");
}

// A failed invite refresh is logged by the caller, counted, and costs nothing else.
{
  const s = spy({
    readCallingNumbers: async () => new Map([["00QUi000010889Z", "+12197588170"]]),
    refreshInvite: async () => {
      throw new Error("events.patch.description: 503");
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 1, "the reminder counts as sent");
  eq(result.inviteRefreshFailed, 1, "the invite that could not be written is counted");
  eq(result.failed, 0, "and is not a reminder failure");
  eq(s.alerts.length, 0, "nor a page");
  eq(s.warnings.length, 1, "but it is logged with its reason, never silent");
}

// No event id on the booking: nothing to refresh, and nothing tried.
{
  const s = spy({
    loadDue: async () => [due({ gcalEventId: null })],
    readCallingNumbers: async () => new Map([["00QUi000010889Z", "+12197588170"]]),
  });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 1, "sent with the number");
  eq(s.order.includes("refresh"), false, "and no invite write without an event to write to");
}

finish();

