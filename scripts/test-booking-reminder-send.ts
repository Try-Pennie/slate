// The 24 hour reminder lane's orchestration (#2359): claim, then send, and what
// happens when the send fails. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-reminder-send.ts
//
// This is a scheduled job that sends something a REAL PERSON reads, so the property
// under test is that it is safe to run twice. Every dependency is injected, so the
// ordering that makes it safe is asserted rather than assumed.
import {
  REMINDER_CALLING_NUMBER_DEADLINE_MS,
  REMINDER_PAGES_PER_TICK,
  runBookingReminders,
  type ReminderDeps,
  type DueBooking,
} from "../src/lib/booking/reminder-send.ts";
import { PENNIE_CARD_LOGO } from "../src/lib/booking/pennie-card-logo.ts";
import { EmailSendError } from "../src/lib/notify/email-errors.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 8, 16, 14, 0, 0);
const LEAD = "00QUi000010889ZMAQ";
/** The invite as the booking path writes it, before any calling number. */
const STANDARD_DESCRIPTION =
  "Booked via Pennie. Phone: +12035615295\nReschedule or cancel: https://slate.trypennie.app/manage/abc";

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
  agentId: "user-jordan",
  onPlaceholder: false,
  ...over,
});

/** Records the ORDER of every effect, which is the whole subject of this suite. */
function spy(over: Partial<ReminderDeps> = {}) {
  const order: string[] = [];
  const sent: { to: string; subject: string }[] = [];
  const alerts: string[] = [];
  const alertIds: string[] = [];
  const warnings: string[] = [];
  const warned: { msg: string; bookingId: string | null; err: unknown; fields: Record<string, unknown> }[] = [];
  const released: { id: string; claimedForIso: string; restoreTo: string | null }[] = [];
  const deps: ReminderDeps = {
    now: () => NOW,
    loadDue: async () => [due()],
    claim: async (id) => {
      order.push(`claim:${id}`);
      return true;
    },
    // A release that lands, by default; the cases that need it to lose say so.
    release: async (id, claimedForIso, restoreTo) => {
      order.push(`release:${id}`);
      released.push({ id, claimedForIso, restoreTo });
      return true;
    },
    send: async (msg) => {
      order.push(`send:${msg.to[0]}`);
      sent.push({ to: msg.to[0]!, subject: msg.subject });
      return "gmail-id";
    },
    alert: async (bookingId, text) => {
      order.push("alert");
      alerts.push(text);
      alertIds.push(bookingId);
    },
    // No calling number known by default, so the suites above judge the send path
    // exactly as it was; the calling number has its own section at the end.
    readCallingNumbers: async () => new Map(),
    // What the invite says NOW, read before it is touched, so the write changes only
    // the calling number line (#1334 review): the standard description by default.
    readInviteDescription: async () => STANDARD_DESCRIPTION,
    refreshInvite: async () => {
      order.push("refresh");
    },
    // No photo held by default; the photo has its own section at the end.
    readAdvisorPhotos: async () => new Map(),
    warn: (msg, bookingId, err, fields) => {
      warnings.push(msg);
      warned.push({ msg, bookingId, err, fields: fields ?? {} });
    },
    ...over,
  };
  return { deps, order, sent, alerts, alertIds, warnings, warned, released };
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
  // Named after the advisor again (Dan reversed the earlier call, 2026-10-01).
  assert(card.content.split("\r\n").includes("FN:Jordan Lee (Pennie)"), "the contact is named after the advisor, with Pennie beside it");
  assert(card.content.split("\r\n").includes("ORG:Pennie"), "and the organisation is still Pennie");
  eq(card.filename, "Jordan Lee Pennie.vcf", "and so is its file");
  assert(withNumber.body.includes("My contact card is attached"), "and the email calls it the advisor's own card");

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

// A Salesforce that never answers must not stall the lane before any claim or send:
// the read runs under the lane's own deadline, and on timeout every reminder goes
// without a number, logged and counted exactly like a refused read.
{
  const msgs: import("../src/lib/notify/email-mime.ts").MimeMessage[] = [];
  const timer = { ms: 0, set: 0, cleared: 0 };
  const s = spy({
    readCallingNumbers: () => new Promise(() => {}),
    deadlineTimer: (ms, fire) => {
      timer.ms = ms;
      timer.set += 1;
      queueMicrotask(fire);
      return () => {
        timer.cleared += 1;
      };
    },
    send: async (msg) => {
      msgs.push(msg);
      return "gmail-id";
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 1, "a hung Salesforce read still lets the reminder go out");
  eq(msgs[0]!.attachments?.length ?? 0, 0, "without a card");
  eq(result.callingNumberUnread, true, "counted as unread");
  eq(s.warnings.length, 1, "and logged");
  eq(timer.ms, REMINDER_CALLING_NUMBER_DEADLINE_MS, "under the lane's own deadline");
  eq(timer.cleared, timer.set, "whose timer is cleared");
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

// The write changes ONLY the calling number line (#1334 review). Text somebody else
// put on the invite, the reassign explanation (#969) above all, survives untouched.
{
  const REASSIGN =
    "Your appointment time has not changed. You have been matched with a different Pennie advisor who will be with you at this time. There is nothing you need to do.";
  const written: string[] = [];
  const s = spy({
    readCallingNumbers: async () => new Map([["00QUi000010889Z", "+12197588170"]]),
    readInviteDescription: async () => REASSIGN,
    refreshInvite: async (_a, _e, description) => {
      written.push(description);
    },
  });
  await runBookingReminders(s.deps);
  eq(written.length, 1, "the reassigned invite is written once");
  assert(written[0]!.startsWith(REASSIGN), "keeping the reassign explanation word for word");
  assert(written[0]!.includes("(219) 758-8170"), "and adding the calling number");
  assert(!written[0]!.includes("Booked via Pennie"), "without swapping in the standard description");
}
// An invite that already says it is not written again, and an old number is replaced
// rather than joined by a second line.
{
  const already =
    "Booked via Pennie. Phone: +12035615295\nThe call will come from (219) 758-8170. Save it to your contacts so your phone lets it through.\nReschedule or cancel: https://slate.trypennie.app/manage/abc";
  const s = spy({
    readCallingNumbers: async () => new Map([["00QUi000010889Z", "+12197588170"]]),
    readInviteDescription: async () => already,
  });
  await runBookingReminders(s.deps);
  eq(s.order.includes("refresh"), false, "an invite already carrying this number is left alone");

  const written: string[] = [];
  const moved = spy({
    readCallingNumbers: async () => new Map([["00QUi000010889Z", "+13025550100"]]),
    readInviteDescription: async () => already,
    refreshInvite: async (_a, _e, description) => {
      written.push(description);
    },
  });
  await runBookingReminders(moved.deps);
  eq((written[0] ?? "").match(/come from/g)?.length ?? 0, 1, "a changed number replaces the old line rather than adding a second");
  assert((written[0] ?? "").includes("(302) 555-0100") && !(written[0] ?? "").includes("(219)"), "and names only the new number");
}
// An event that is gone is not written to; a description that cannot be read is a
// counted, logged refresh failure, never a guess.
{
  const gone = spy({
    readCallingNumbers: async () => new Map([["00QUi000010889Z", "+12197588170"]]),
    readInviteDescription: async () => null,
  });
  const r1 = await runBookingReminders(gone.deps);
  eq(gone.order.includes("refresh"), false, "a deleted invite is not written to");
  eq(r1.sent, 1, "and the reminder still counts as sent");

  const unread = spy({
    readCallingNumbers: async () => new Map([["00QUi000010889Z", "+12197588170"]]),
    readInviteDescription: async () => {
      throw new Error("events.get: 503");
    },
  });
  const r2 = await runBookingReminders(unread.deps);
  eq(unread.order.includes("refresh"), false, "an invite that cannot be read is not overwritten blind");
  eq(r2.inviteRefreshFailed, 1, "and the miss is counted");
  eq(unread.warnings.length, 1, "and logged");
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

// --- the advisor's photo on the card (#1334, Dan 2026-10-01) -------------------------
//
// An optional extra on the card, so every way of not having it sends the reminder and
// the card exactly as before, carrying the Pennie logo instead of a face (#2980).
// Fetched at most once per advisor per tick, and only for advisors whose reminders
// carry a card.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);
const STORED_PHOTO = { base64: Buffer.from(JPEG_BYTES).toString("base64"), mime: "image/jpeg" };
const NUMBER_FOR_LEAD = () => new Map([["00QUi000010889Z", "+12197588170"]]);
const unfoldCard = (content: string) => content.replace(/\r\n /g, "");
const LOGO_LINE = `PHOTO;ENCODING=b;TYPE=${PENNIE_CARD_LOGO.type}:${PENNIE_CARD_LOGO.base64}`;
const cardPhotoLines = (msg: import("../src/lib/notify/email-mime.ts").MimeMessage | undefined) =>
  unfoldCard(msg?.attachments?.[0]?.content ?? "")
    .split("\r\n")
    .filter((l) => l.startsWith("PHOTO"));

{
  const msgs: import("../src/lib/notify/email-mime.ts").MimeMessage[] = [];
  const askedIds: string[][] = [];
  const s = spy({
    // Two reminders for one advisor, one for another, and one with no card at all.
    loadDue: async () => [
      due(),
      due({ id: "bk-2", gcalEventId: "evt-2" }),
      due({ id: "bk-3", agentId: "user-taylor", agentEmail: "trios@trypennie.com", gcalEventId: "evt-3" }),
      due({ id: "bk-4", agentId: "user-casey", leadId: null, gcalEventId: null }),
    ],
    readCallingNumbers: async () => NUMBER_FOR_LEAD(),
    // #3027: the stored directory photos, read from the database. Taylor holds none.
    readAdvisorPhotos: async (ids) => {
      askedIds.push([...ids].sort());
      return new Map([["user-jordan", STORED_PHOTO]]);
    },
    send: async (msg) => {
      msgs.push(msg);
      return "gmail-id";
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 4, "every reminder goes out");
  eq(askedIds, [["user-jordan", "user-taylor"]], "one photo lookup for the tick, only for advisors whose reminders carry a card");
  eq(result.withPhoto, 2, "both of that advisor's cards carry the photo, and the run says so");
  eq(result.photoUnread, 0, "and nothing was unreadable");

  const photoLine = (i: number) =>
    unfoldCard(msgs[i]?.attachments?.[0]?.content ?? "")
      .split("\r\n")
      .filter((l) => l.startsWith("PHOTO"));
  const expected = `PHOTO;ENCODING=b;TYPE=JPEG:${Buffer.from(JPEG_BYTES).toString("base64")}`;
  eq(photoLine(0), [expected], "the first card carries the photo, embedded");
  eq(photoLine(1), [expected], "and so does the second, from the same read");
  eq(photoLine(2), [LOGO_LINE], "an advisor with no photo held gets a card carrying the Pennie logo");
  eq(result.withLogo, 1, "counted as a logo, apart from the photos");
  eq(msgs[3]?.attachments?.length ?? 0, 0, "and a reminder with no card reads nothing for it");
  eq(s.warnings.length, 0, "no photo held is not a fault, so nothing is logged as one");
}

// A stored photo that is not a usable image costs the card its photo and nothing
// else: the reminder and the card still go, logged and counted.
const unusable: [string, { base64: string; mime: string }][] = [
  ["a type the card cannot carry", { base64: STORED_PHOTO.base64, mime: "image/gif" }],
  ["bytes that disagree with their label", { base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"), mime: "image/jpeg" }],
  ["a value that is not base64", { base64: "!!!", mime: "image/jpeg" }],
];
for (const [label, row] of unusable) {
  const msgs: import("../src/lib/notify/email-mime.ts").MimeMessage[] = [];
  const s = spy({
    readCallingNumbers: async () => NUMBER_FOR_LEAD(),
    readAdvisorPhotos: async () => new Map([["user-jordan", row]]),
    send: async (msg) => {
      msgs.push(msg);
      return "gmail-id";
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 1, `${label}: the reminder still goes out`);
  eq(msgs[0]?.attachments?.length ?? 0, 1, `${label}: with its card`);
  eq(cardPhotoLines(msgs[0]), [LOGO_LINE], `${label}: carrying the Pennie logo instead of the photo`);
  eq(result.photoUnread, 1, `${label}: counted as unread`);
  eq(result.withPhoto, 0, `${label}: and not as a photo sent`);
  eq(result.withLogo, 1, `${label}: but as a logo sent`);
  eq(s.warnings.length, 1, `${label}: logged once with its reason`);
  eq(s.alerts.length, 0, `${label}: and never paged, since no reminder was lost`);
}

// The photo lookup itself failing sends every card without a photo, counted per advisor.
{
  const msgs: import("../src/lib/notify/email-mime.ts").MimeMessage[] = [];
  const s = spy({
    readCallingNumbers: async () => NUMBER_FOR_LEAD(),
    readAdvisorPhotos: async () => {
      throw new Error("advisor_photos read failed");
    },
    send: async (msg) => {
      msgs.push(msg);
      return "gmail-id";
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 1, "a failed photo lookup still sends the reminder");
  eq(msgs[0]?.attachments?.length ?? 0, 1, "with its card");
  eq(cardPhotoLines(msgs[0]), [LOGO_LINE], "carrying the Pennie logo");
  eq(result.photoUnread, 1, "counted as unread");
  eq(result.withLogo, 1, "and as a logo sent");
  eq(s.warnings.length, 1, "and logged");
}

// A photo read that never answers must not stall the lane: it runs under the same
// deadline as the calling number read, and the reminder goes with the logo.
{
  const msgs: import("../src/lib/notify/email-mime.ts").MimeMessage[] = [];
  let photoReadStarted = false;
  let cleared = 0;
  const s = spy({
    readCallingNumbers: async () => NUMBER_FOR_LEAD(),
    readAdvisorPhotos: () => {
      photoReadStarted = true;
      return new Promise(() => {});
    },
    deadlineTimer: (_ms, fire) => {
      // Only the deadline armed once the photo read is under way is made to fire.
      if (photoReadStarted) queueMicrotask(fire);
      else queueMicrotask(() => {
        if (photoReadStarted) fire();
      });
      return () => {
        cleared += 1;
      };
    },
    send: async (msg) => {
      msgs.push(msg);
      return "gmail-id";
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(result.sent, 1, "a hung photo read still lets the reminder go out");
  eq(cardPhotoLines(msgs[0]), [LOGO_LINE], "carrying the Pennie logo");
  eq(result.photoUnread, 1, "counted as unread");
  assert(cleared >= 1, "and its timer is cleared");
}

// A booking with no assigned advisor id still gets the logo, and a reminder with no
// card carries no logo and is not counted (#2980).
{
  const msgs: import("../src/lib/notify/email-mime.ts").MimeMessage[] = [];
  const s = spy({
    loadDue: async () => [due({ agentId: null }), due({ id: "bk-2", leadId: null, gcalEventId: null })],
    readCallingNumbers: async () => NUMBER_FOR_LEAD(),
    send: async (msg) => {
      msgs.push(msg);
      return "gmail-id";
    },
  });
  const result = await runBookingReminders(s.deps);
  eq(cardPhotoLines(msgs[0]), [LOGO_LINE], "no advisor id: the card carries the Pennie logo");
  eq(msgs[1]?.attachments?.length ?? 0, 0, "a reminder with no calling number has no card");
  eq(result.withLogo, 1, "only the card is counted as a logo");
  eq(result.withPhoto + result.withLogo, result.withCallingNumber, "every card carries exactly one picture");
}

// --- #2985: the inbox shows the advisor's NAME as the sender -----------------------
//
// Dan, 2026-10-01: the reminder arrived from the bare address. The message now
// carries the advisor's real name, and "Pennie" when there is none, never an
// address dressed up as a name (realAdvisorName refuses one).
{
  const senderFor = async (agentName: string | null) => {
    const names: (string | undefined)[] = [];
    const froms: string[] = [];
    const s = spy({
      loadDue: async () => [due({ agentName })],
      send: async (msg) => {
        names.push(msg.fromName);
        froms.push(msg.from);
        return "gmail-id";
      },
    });
    await runBookingReminders(s.deps);
    eq(froms.join(","), "jordan@trypennie.com", "#2985: still sent from the advisor's own mailbox");
    return names;
  };
  eq((await senderFor("Jordan Lee")).join(","), "Jordan Lee", "#2985: the sender name is the advisor's real name");
  eq((await senderFor("  Jordan Lee  ")).join(","), "Jordan Lee", "#2985: trimmed, as realAdvisorName trims it");
  eq((await senderFor(null)).join(","), "Pennie", "#2985: no name on record reads as Pennie");
  eq((await senderFor("jordan@trypennie.com")).join(","), "Pennie", "#2985: an address in the name field reads as Pennie, not as a name");
  eq((await senderFor("")).join(","), "Pennie", "#2985: an empty name reads as Pennie");
}

// --- a send that provably never reached Gmail is RELEASED and tried again ---------
//
// 2026-10-05 13:30 UTC: one reminder's token mint timed out. The mint runs before
// the Gmail POST, so nothing was delivered, yet the claim was kept like any other
// failure and the lead was never reminded. A failure that PROVES nothing went out,
// and that could pass, now hands the claim back so the next tick sends it, while the
// call is still more than an hour away (the floor that lands before Regal's text).
// Everything else keeps the claim, so the default stays the safe direction: a plain
// Error, or an outcome that might have been delivered, is never retried.
const mintTimeout = () =>
  new EmailSendError("google token mint did not answer within 8000ms", {
    outcome: "never_sent",
    stage: "token",
    transient: true,
  });
const failingWith = (err: unknown) => async () => {
  throw err;
};
{
  const s = spy({ send: failingWith(mintTimeout()) });
  const run = await runBookingReminders(s.deps);
  eq(s.released.length, 1, "the claim is released");
  eq(
    s.released[0],
    { id: "bk-1", claimedForIso: due().startsAtIso, restoreTo: null },
    "for this booking, conditional on the start it claimed, back to the value the tick read",
  );
  eq(s.order.join(" -> "), "claim:bk-1 -> release:bk-1", "after the claim and the failed send, never before");
  eq(s.alerts.length, 0, "nobody is paged: the lead is still going to be reminded");
  eq(run.failed, 1, "it still counts as a failed send");
  eq(run.byCode.token_unavailable, 1, "classified as token_unavailable");
  eq(run.retrying, 1, "and counted as retrying");
  eq(run.retried, { "bk-1": "token_unavailable" }, "naming the booking, so the share can count it once");
  const line = s.warned.find((w) => w.bookingId === "bk-1");
  assert(line !== undefined, "the failure is logged against the booking");
  eq(line?.fields.code, "token_unavailable", "with its code");
  eq(line?.fields.outcome, "never_sent", "its outcome");
  eq(line?.fields.claim_released, true, "and that the claim was released");
  eq(line?.fields.disposition, "released", "under the released disposition");
  assert(!/never reached Gmail/i.test(line?.msg ?? ""), `in a line true of a 429 as well (${line?.msg})`);
  assert(line?.err instanceof Error, "with the Error itself passed through for the log");
  assert(
    !JSON.stringify(line?.fields).includes("lead@example.com"),
    "and no contact data in the fields",
  );
}

// --- inside the floor it is too late, and says so ---------------------------------
{
  const s = spy({
    loadDue: async () => [due({ startsAtIso: new Date(NOW + 40 * 60_000).toISOString() })],
    send: failingWith(mintTimeout()),
  });
  const run = await runBookingReminders(s.deps);
  eq(s.released.length, 0, "a call forty minutes away is not retried");
  eq(run.retrying, 0, "and nothing is retrying");
  eq(s.alerts.length, 1, "so the lost reminder pages");
  assert(/nothing reached Gmail/i.test(s.alerts[0]!), `saying nothing was sent (${s.alerts[0]})`);
  assert(/too close to the call/i.test(s.alerts[0]!), `and that it is too late to try again (${s.alerts[0]})`);
  assert(!/may have/i.test(s.alerts[0]!), "and never that it may have gone out, which it provably did not");
  eq(s.alertIds, ["bk-1"], "keyed to the booking, so it cannot silence another booking's page");
  assert(/did not answer within 8 seconds/.test(s.alerts[0]!), `with the short reason (${s.alerts[0]})`);
  // Every failed send is logged, the ones that page included (plan item E).
  const line = s.warned.find((w) => w.bookingId === "bk-1");
  eq(
    line && {
      code: line.fields.code,
      outcome: line.fields.outcome,
      transient: line.fields.transient,
      disposition: line.fields.disposition,
      claim_released: line.fields.claim_released,
      minutes_to_start: line.fields.minutes_to_start,
    },
    {
      code: "token_unavailable",
      outcome: "never_sent",
      transient: true,
      disposition: "too_late",
      claim_released: false,
      minutes_to_start: 40,
    },
    "the log line says which page went out and why it was not retried",
  );
  assert(line?.err instanceof Error, "with the Error passed through");
}

// --- the retry must itself land before the hour, judged when the send FAILED -------
//
// The floor decides whether the claim goes back, and the retry happens on the NEXT
// tick, five minutes later. A release made 65 minutes out would be retried about 60
// minutes out, after the lead's one hour text: so a release needs the floor plus a
// margin covering the next tick. And a tick that has spent minutes on slow mints
// before this send failed is judged on the clock at the failure, not at its start.
{
  const s = spy({
    loadDue: async () => [due({ startsAtIso: new Date(NOW + 65 * 60_000).toISOString() })],
    send: failingWith(mintTimeout()),
  });
  await runBookingReminders(s.deps);
  eq(s.released.length, 0, "a call 65 minutes away is not handed back: the retry would land inside the hour");
  eq(s.alerts.length, 1, "so it pages as too late");
  assert(/too close to the call/i.test(s.alerts[0]!), `saying it is too close to try again (${s.alerts[0]})`);
}
{
  let reads = 0;
  const s = spy({
    // The tick starts 72 minutes before the call; by the time this send fails the
    // tick has spent three minutes elsewhere.
    now: () => (reads++ === 0 ? NOW : NOW + 3 * 60_000),
    loadDue: async () => [due({ startsAtIso: new Date(NOW + 72 * 60_000).toISOString() })],
    send: failingWith(mintTimeout()),
  });
  await runBookingReminders(s.deps);
  eq(s.released.length, 0, "judged on the clock at the failure (69 minutes out), not the tick's start (72)");
  eq(s.alerts.length, 1, "and pages as too late");
}
{
  const s = spy({
    loadDue: async () => [due({ startsAtIso: new Date(NOW + 80 * 60_000).toISOString() })],
    send: failingWith(mintTimeout()),
  });
  await runBookingReminders(s.deps);
  eq(s.released.length, 1, "the control: 80 minutes out is far enough for the next tick to land before the hour");
}

// --- a rate limit inside the hour does not claim nothing reached Gmail -------------
{
  const limited = new EmailSendError("Gmail send failed: 429 rateLimitExceeded", {
    outcome: "refused",
    stage: "post",
    status: 429,
    transient: true,
  });
  const s = spy({
    loadDue: async () => [due({ startsAtIso: new Date(NOW + 40 * 60_000).toISOString() })],
    send: failingWith(limited),
  });
  await runBookingReminders(s.deps);
  eq(s.alerts.length, 1, "a 429 forty minutes out pages as too late");
  assert(!/nothing reached Gmail/i.test(s.alerts[0]!), `and does not say nothing reached Gmail, which answered it (${s.alerts[0]})`);
  assert(/Gmail turned it away for now/i.test(s.alerts[0]!), `it says Gmail turned it away for now (${s.alerts[0]})`);
}

// --- a message Slate could not build is not called a Google refusal ----------------
{
  const unbuilt = new EmailSendError("MIME build failed", {
    outcome: "never_sent",
    stage: "compose",
    transient: false,
  });
  const s = spy({ send: failingWith(unbuilt) });
  await runBookingReminders(s.deps);
  eq(s.released.length, 0, "a fault that will recur is not retried");
  eq(s.alerts.length, 1, "and pages");
  assert(!/Google refused/i.test(s.alerts[0]!), `without blaming Google, which never saw it (${s.alerts[0]})`);
  assert(/could not build/i.test(s.alerts[0]!), `saying Slate could not build it (${s.alerts[0]})`);
  eq(s.warned.find((w) => w.bookingId === "bk-1")?.fields.disposition, "not_built", "and logs which page it was");
}

// --- a refusal that will not pass keeps the claim ----------------------------------
{
  const refused = new EmailSendError("Gmail send failed: 400 Invalid To header", {
    outcome: "refused",
    stage: "post",
    status: 400,
    transient: false,
  });
  const s = spy({ send: failingWith(refused) });
  const run = await runBookingReminders(s.deps);
  eq(s.released.length, 0, "a refused address is not retried: it would be refused again");
  eq(run.byCode.recipient_refused, 1, "classified as the address");
  eq(s.alerts.length, 1, "and pages");
  assert(/refused/i.test(s.alerts[0]!), `saying it was refused (${s.alerts[0]})`);
  assert(/until/i.test(s.alerts[0]!) && /repaired/i.test(s.alerts[0]!), `and that it waits on a repair (${s.alerts[0]})`);
  const line = s.warned.find((w) => w.bookingId === "bk-1");
  eq(
    line && [line.fields.code, line.fields.outcome, line.fields.disposition, line.fields.claim_released, line.fields.transient],
    ["recipient_refused", "refused", "refused", false, false],
    "and is logged with its code, outcome and disposition",
  );
  assert(line?.err === refused, "with the Error itself passed through");
  eq(run.settled, { "bk-1": "kept" }, "and the share is told this booking is settled, its claim kept");
}

// --- a refusal that can pass is retried, like a send that never left ----------------
{
  const limited = new EmailSendError("Gmail send failed: 429 rateLimitExceeded", {
    outcome: "refused",
    stage: "post",
    status: 429,
    transient: true,
  });
  const s = spy({ send: failingWith(limited) });
  const run = await runBookingReminders(s.deps);
  eq(s.released.length, 1, "a 429 was not delivered and can pass, so it is retried");
  eq(run.retried, { "bk-1": "rate_limited" }, "under its own code");
  eq(s.alerts.length, 0, "without a page");
}

// --- an outcome that may have been delivered is NEVER retried -----------------------
{
  const unknown = new EmailSendError("Gmail send failed: 503 backendError", {
    outcome: "unknown",
    stage: "post",
    status: 503,
    transient: true,
  });
  const s = spy({ send: failingWith(unknown) });
  const run = await runBookingReminders(s.deps);
  eq(s.released.length, 0, "a 503 may have been accepted, so the claim is kept even though it is transient");
  eq(run.retrying, 0, "nothing is retrying");
  eq(s.alerts.length, 1, "and it pages");
  assert(/may/i.test(s.alerts[0]!), `saying it may have gone out (${s.alerts[0]})`);
  assert(/second copy/i.test(s.alerts[0]!), `and why it is not resent (${s.alerts[0]})`);
  const line = s.warned.find((w) => w.bookingId === "bk-1");
  eq(
    line && [line.fields.code, line.fields.outcome, line.fields.disposition, line.fields.claim_released],
    ["provider_unavailable", "unknown", "unknown", false],
    "and is logged with its code, outcome and disposition",
  );
  assert(line?.err === unknown, "with the Error itself passed through");
}

// --- a plain Error keeps the claim: nothing it says is proof -----------------------
{
  const s = spy({ send: failingWith(new Error("google token mint did not answer within 8000ms")) });
  const run = await runBookingReminders(s.deps);
  eq(s.released.length, 0, "release is never called for an error that is not typed");
  eq(run.retrying, 0, "so nothing is retrying");
  eq(s.alerts.length, 1, "and the lost reminder pages");
  assert(/may/i.test(s.alerts[0]!), `as one that may have gone out, since nothing proves otherwise (${s.alerts[0]})`);
}

// --- a release that loses its race, or throws, keeps the claim ---------------------
{
  const lost = spy({ send: failingWith(mintTimeout()), release: async () => false });
  const lostRun = await runBookingReminders(lost.deps);
  eq(lostRun.retrying, 0, "a release that changed no row is not counted as retrying");
  eq(lostRun.retried, {}, "and names no booking to the share");
  assert(lost.warnings.some((w) => /not released/i.test(w)), "it is logged");
  eq(lost.alerts.length, 0, "and not paged: the row no longer holds the claim this tick wrote");

  const thrown = spy({
    send: failingWith(mintTimeout()),
    release: async () => {
      throw new Error("release update failed");
    },
  });
  const thrownRun = await runBookingReminders(thrown.deps);
  eq(thrownRun.retrying, 0, "a release that threw is not counted as retrying");
  assert(thrown.warnings.some((w) => /not released/i.test(w)), "it is logged");
  eq(thrown.alerts.length, 1, "and pages, because the claim may stand and then nothing will retry it");
  assert(/could not be confirmed/i.test(thrown.alerts[0]!), `saying the retry could not be confirmed (${thrown.alerts[0]})`);
  // A release whose UPDATE committed and whose reply was lost also throws, and then
  // the next tick DOES send it, so the page must not state the opposite as fact.
  assert(!/will not be reminded/i.test(thrown.alerts[0]!), `and never that the lead certainly will not be reminded (${thrown.alerts[0]})`);
  const lines = thrown.warned.filter((w) => w.bookingId === "bk-1");
  assert(lines.length > 0 && lines.every((l) => l.fields.disposition === "not_released"), "every log line names the disposition");
  assert(lines.some((l) => l.fields.release === "threw"), "and says the release threw rather than lost its race");
  assert(lines.some((l) => l.err instanceof EmailSendError), "with the send's own Error on one of them");
  eq(lost.warned.find((w) => w.bookingId === "bk-1")?.fields.release, "lost", "a release that lost its race says so");
}

// --- the share is told how each attempted booking settled ---------------------------
{
  const s = spy();
  const run = await runBookingReminders(s.deps);
  eq(run.settled, { "bk-1": "sent" }, "a booking sent is settled as sent");
  const released = await runBookingReminders(spy({ send: failingWith(mintTimeout()) }).deps);
  eq(released.settled, {}, "and a booking handed back is not settled: it is still being retried");
}

// --- two ticks against one store: released, then sent exactly once ----------------
//
// The release is a compare and swap like the claim, so the property is end to end:
// tick one claims, fails before Gmail and hands the claim back; tick two claims
// again and sends. One email, and the store ends holding the reminded start.
{
  const startsAtIso = due().startsAtIso;
  const store = { reminderSentFor: null as string | null };
  let sends = 0;
  const delivered: string[] = [];
  const s = spy({
    loadDue: async () => [due({ reminderSentForIso: store.reminderSentFor })],
    claim: async (_id, start) => {
      if (store.reminderSentFor === start) return false;
      store.reminderSentFor = start;
      return true;
    },
    release: async (_id, claimedForIso, restoreTo) => {
      if (store.reminderSentFor !== claimedForIso) return false;
      store.reminderSentFor = restoreTo;
      return true;
    },
    send: async (msg) => {
      sends += 1;
      if (sends === 1) throw mintTimeout();
      delivered.push(msg.to[0]!);
      return "gmail-id";
    },
  });
  const first = await runBookingReminders(s.deps);
  eq(first.retrying, 1, "tick one: the mint timed out and the claim went back");
  eq(store.reminderSentFor, null, "so the store no longer records a reminder");
  const second = await runBookingReminders(s.deps);
  eq(second.sent, 1, "tick two: sent");
  eq(delivered, ["lead@example.com"], "exactly one email reached the lead");
  eq(store.reminderSentFor, startsAtIso, "and the store records the start it was sent about");
  const third = await runBookingReminders(s.deps);
  eq(third.attempted, 0, "a third tick finds nothing due");
}

// --- an outage pages a few bookings by name and folds the rest into one page -----
//
// Each lost reminder pages under its own key, so one cannot silence the next. The
// cost is that an outage which fails every send (Gmail down for every mailbox)
// would post one page per lead. So a tick names at most REMINDER_PAGES_PER_TICK
// bookings and folds the rest into ONE page that lists every one of them, keyed on
// the first folded booking: nobody unreminded goes unnamed, and the wave is still
// said once by the share (Dan, 2026-10-05).
{
  const ids = ["bk-1", "bk-2", "bk-3", "bk-4", "bk-5"];
  const s = spy({
    loadDue: async () => ids.map((id) => due({ id })),
    send: async () => {
      throw new Error("Gmail send failed: 503 backendError");
    },
  });
  const run = await runBookingReminders(s.deps);
  eq(run.failed, 5, "every send failed");
  eq(s.alerts.length, REMINDER_PAGES_PER_TICK + 1, "the named pages plus one folded page");
  eq(s.alertIds, ["bk-1", "bk-2", "bk-3", "bk-4"], "the folded page is keyed on the first folded booking");
  const folded = s.alerts[REMINDER_PAGES_PER_TICK]!;
  assert(folded.includes("bk-4") && folded.includes("bk-5"), "the folded page names every folded booking");
  assert(!folded.includes("bk-1"), "and not the bookings already paged by name");
  assert(folded.includes("2 more"), "and says how many it folded");
  eq(run.pagesFolded, 2, "the run reports how many pages it folded");
  for (const id of ["bk-4", "bk-5"]) {
    assert(
      s.warned.some((w) => w.bookingId === id && w.msg === "reminder send failed"),
      `a folded booking still gets its own log line (${id})`,
    );
  }
}

// The control: at the cap, nothing is folded, so the fold is not firing on every run.
{
  const ids = ["bk-1", "bk-2", "bk-3"];
  const s = spy({
    loadDue: async () => ids.map((id) => due({ id })),
    send: async () => {
      throw new Error("Gmail send failed: 503 backendError");
    },
  });
  const run = await runBookingReminders(s.deps);
  eq(s.alertIds, ids, "three failures page three bookings by name");
  eq(run.pagesFolded, 0, "and fold nothing");
}

// --- a call on the placeholder advisor, Marcia (#4206, Dan 2026-10-26) ---------------
// Its reminder goes out from the placeholder seat, whose inbox nobody reads, so it
// names NO number at all (a text to the calling number reaches nobody, and a card
// saved under Marcia's name invites exactly that), sends no card, never rewrites the
// invite with one, and tells the customer to reply to one of our texts instead.
{
  const msgs: import("../src/lib/notify/email-mime.ts").MimeMessage[] = [];
  const asked: string[][] = [];
  const s = spy({
    loadDue: async () => [
      due({ id: "bk-p", agentEmail: "scheduling@trypennie.com", agentName: "Marcia", agentId: "user-marcia", onPlaceholder: true }),
      due({ id: "bk-r", attendeeEmail: "other@example.com", leadId: "00QUi000010889AMAQ" }),
    ],
    readCallingNumbers: async (ids) => {
      asked.push(ids);
      return new Map([
        ["00QUi000010889Z", "+12197588170"],
        ["00QUi000010889A", "+12197588170"],
      ]);
    },
    send: async (msg) => {
      msgs.push(msg);
      return "gmail-id";
    },
  });
  const run = await runBookingReminders(s.deps);
  eq(run.sent, 2, "both reminders go out");
  const placeholder = msgs.find((m) => m.to[0] === "lead@example.com")!;
  const routed = msgs.find((m) => m.to[0] === "other@example.com")!;
  eq(placeholder.from, "scheduling@trypennie.com", "the placeholder's reminder comes from the seat");
  eq(placeholder.fromName, "Marcia", "under its display name");
  eq(placeholder.attachments?.length ?? 0, 0, "with no contact card");
  assert(!/\(\d{3}\) \d{3}|\+1\d{10}/.test(placeholder.body), "and no number of any kind");
  assert(/reply to one of our texts/.test(placeholder.body), "it tells the customer to reply to one of our texts");
  assert(!/reply to this email and it will reach me/.test(placeholder.body), "and never promises a reply to the seat is read");
  eq(routed.attachments?.length ?? 0, 1, "the routed call beside it keeps its card");
  assert(/reply to this email and it will reach me directly/.test(routed.body), "and its own reply line");
  eq(s.order.filter((o) => o === "refresh").length, 1, "only the routed call's invite is rewritten with the number");
  eq(run.withCallingNumber, 1, "and only it counts as sent with a number");
  eq(asked, [["00QUi000010889AMAQ"]], "Salesforce is asked only about the routed call's lead");
}

finish();

