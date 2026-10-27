// The reminder lane's orchestration (#2359, #4282, #4298): judge every stored reminder
// email for every booking, claim, then send, and what happens when the send fails. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-reminder-send.ts
//
// This is a scheduled job that sends something a REAL PERSON reads, so the property
// under test is that it is safe to run twice. Every dependency is injected, so the
// ordering that makes it safe is asserted rather than assumed.
//
// Since #4298 the lane reads its emails from `reminder_emails` and records each one in
// `booking_reminder_sends`, while still writing the legacy bookings columns for the day
// and hour emails, so a rollback to the old code resends nothing. The default emails
// here are the two seeded ones (DEFAULT_TEMPLATES), and the default store is the shared
// fake (scripts/lib/reminder-send-store-fake.ts), which answers as migration 0211 does.
import {
  REMINDER_CALLING_NUMBER_DEADLINE_MS,
  REMINDER_PAGES_PER_TICK,
  reminderFailedAlertKey,
  reminderShareKey,
  runBookingReminders,
  type LaneEmail,
  type ReminderDeps,
  type DueBooking,
} from "../src/lib/booking/reminder-send.ts";
import { sendRecordsForBooking } from "../src/lib/booking/reminder-legacy.ts";
import { DEFAULT_TEMPLATES } from "../src/lib/booking/reminder-template.ts";
import { HOUR_REMINDER_GAP_MS } from "../src/lib/booking/reminder.ts";
import { PENNIE_CARD_LOGO } from "../src/lib/booking/pennie-card-logo.ts";
import { EmailSendError } from "../src/lib/notify/email-errors.ts";
import { reminderSendStoreFake } from "./lib/reminder-send-store-fake.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 8, 16, 14, 0, 0);
const LEAD = "00QUi000010889ZMAQ";
/** The invite as the booking path writes it, before any calling number. */
const STANDARD_DESCRIPTION =
  "Booked via Pennie. Phone: +12035615295\nReschedule or cancel: https://slate.trypennie.app/manage/abc";

/** A stored email as the route maps it, switched on since the epoch like the seeds. */
const email = (over: Partial<LaneEmail> & Pick<LaneEmail, "id" | "slug">): LaneEmail => ({
  name: over.slug,
  minutesBefore: 60,
  lateBooking: "skip",
  enabled: true,
  effectiveFromIso: "1970-01-01T00:00:00.000Z",
  subject: DEFAULT_TEMPLATES.hour.subject,
  body: DEFAULT_TEMPLATES.hour.body,
  cardBlock: true,
  placeholderSends: true,
  ...over,
});
const fromDefault = (slug: "day" | "hour"): LaneEmail => {
  const t = DEFAULT_TEMPLATES[slug];
  return email({
    id: `email-${slug}`,
    slug,
    name: t.name,
    minutesBefore: t.minutesBefore,
    lateBooking: t.lateBooking,
    subject: t.subject,
    body: t.body,
    cardBlock: t.cardBlock,
    placeholderSends: t.placeholderSends,
  });
};
const DAY = fromDefault("day");
const HOUR_EMAIL = fromDefault("hour");
/** A third email an admin might add: 12 hours ahead, sent at once to a late booking. */
const TWELVE = email({
  id: "email-twelve",
  slug: "twelve",
  name: "12 hour reminder",
  minutesBefore: 720,
  lateBooking: "send_now",
  subject: DEFAULT_TEMPLATES.day.subject,
  body: DEFAULT_TEMPLATES.day.body,
});

const due = (over: Partial<DueBooking> = {}): DueBooking => ({
  id: "bk-1",
  startsAtIso: new Date(NOW + 12 * HOUR).toISOString(),
  // Old enough to be past the hand-back hold (#2633), so the suites below judge the
  // send path rather than the hold. The hold has its own section at the end.
  createdAtIso: new Date(NOW - HOUR).toISOString(),
  reminderSentForIso: null,
  reminderSentAtIso: null,
  hourReminderSentForIso: null,
  attendeePhone: null,
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
  sends: [],
  ...over,
});

/**
 * Records the ORDER of every effect, which is the whole subject of this suite. `order`
 * holds the claim, the send, a release and the invite refresh, as it always has; the
 * other writes (the send record, the legacy columns, the skips) each have their own
 * list, and `writes` holds every one of them in the order they happened.
 */
function spy(over: Partial<ReminderDeps> = {}, emails: LaneEmail[] = [DAY, HOUR_EMAIL]) {
  const order: string[] = [];
  const writes: string[] = [];
  const sent: { to: string; subject: string }[] = [];
  const alerts: string[] = [];
  const alertIds: string[] = [];
  const alertKeys: string[] = [];
  const warnings: string[] = [];
  const warned: { msg: string; bookingId: string | null; err: unknown; fields: Record<string, unknown> }[] = [];
  const released: { id: string; emailId: string; sentForIso: string }[] = [];
  const legacyReleased: { id: string; slug: string; claimedForIso: string; restoreTo: string | null; restoreSentAt: string | null }[] = [];
  const marked: string[] = [];
  const legacyMarked: string[] = [];
  const failedRecords: { id: string; emailId: string; reason: string }[] = [];
  const skips: { id: string; emailId: string; reason: string }[] = [];
  const unrenderable: { slug: string; text: string }[] = [];
  const renderable: { slug: string; text: string }[][] = [];
  const noneEnabled: string[] = [];
  let loadDueCalls = 0;
  const store = reminderSendStoreFake({
    now: () => NOW,
    minutesOf: (id) => emails.find((e) => e.id === id)?.minutesBefore,
    gapMs: HOUR_REMINDER_GAP_MS,
  });
  const deps: ReminderDeps = {
    now: () => NOW,
    loadEmails: async () => emails,
    loadDue: async () => {
      loadDueCalls += 1;
      return [due()];
    },
    claimSend: async (id, emailId, sentForIso) => {
      order.push(`claim:${id}`);
      writes.push(`claim:${id}:${emailId}`);
      return store.claim(id, emailId, sentForIso);
    },
    // A release that lands, by default; the cases that need it to lose say so.
    releaseSend: async (id, emailId, sentForIso) => {
      order.push(`release:${id}`);
      writes.push(`release:${id}:${emailId}`);
      released.push({ id, emailId, sentForIso });
      store.release(id, emailId, sentForIso);
      return true;
    },
    markSendSent: async (id, emailId, sentForIso) => {
      writes.push(`mark:${id}:${emailId}`);
      marked.push(`${id}:${emailId}@${sentForIso}`);
      return store.mark(id, emailId, sentForIso);
    },
    failSend: async (id, emailId, sentForIso, reason) => {
      writes.push(`fail:${id}:${emailId}`);
      failedRecords.push({ id, emailId, reason });
      return store.fail(id, emailId, sentForIso, reason);
    },
    skipSend: async (id, emailId, sentForIso, reason) => {
      writes.push(`skip:${id}:${emailId}:${reason}`);
      skips.push({ id, emailId, reason });
      return store.skip(id, emailId, sentForIso, reason);
    },
    // The legacy columns land by default, whatever the fake held, so the suites judge
    // the send path; the cases about the compare and swap use the store's own.
    legacyClaim: async (id, slug) => {
      writes.push(`legacy-claim:${id}:${slug}`);
      return true;
    },
    legacyRelease: async (id, slug, claimedForIso, restoreTo, restoreSentAt) => {
      writes.push(`legacy-release:${id}:${slug}`);
      legacyReleased.push({ id, slug, claimedForIso, restoreTo, restoreSentAt });
      return true;
    },
    legacyMarkSent: async (id, startsAtIso) => {
      writes.push(`legacy-mark:${id}`);
      legacyMarked.push(`${id}@${startsAtIso}`);
    },
    send: async (msg) => {
      order.push(`send:${msg.to[0]}`);
      writes.push(`send:${msg.to[0]}`);
      sent.push({ to: msg.to[0]!, subject: msg.subject });
      return "gmail-id";
    },
    alert: async (bookingId, slug, text) => {
      order.push("alert");
      alerts.push(text);
      alertIds.push(bookingId);
      alertKeys.push(reminderFailedAlertKey(bookingId, slug));
    },
    alertUnrenderable: async (slug, text) => {
      unrenderable.push({ slug, text });
    },
    resolveRenderable: async (list) => {
      renderable.push(list);
    },
    notifyNoneEnabled: async (text) => {
      noneEnabled.push(text);
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
  return {
    deps,
    store,
    order,
    writes,
    sent,
    alerts,
    alertIds,
    alertKeys,
    warnings,
    warned,
    released,
    legacyReleased,
    marked,
    legacyMarked,
    failedRecords,
    skips,
    unrenderable,
    renderable,
    noneEnabled,
    loadDueCalls: () => loadDueCalls,
  };
}

/**
 * Backs a spy's reads and legacy writes with its store, so several ticks run against
 * one database: each tick's worklist carries what the previous tick wrote, both the send
 * rows and the legacy columns, and the legacy writes are the store's compare and swaps.
 */
function wireStore(s: ReturnType<typeof spy>, rows: (DueBooking | (() => DueBooking))[] = [due()]) {
  s.deps.loadDue = async () =>
    rows.map((r) => {
      const row = typeof r === "function" ? r() : r;
      const cols = s.store.legacyOf(row.id);
      return {
        ...row,
        reminderSentForIso: cols.reminderSentFor ?? row.reminderSentForIso,
        reminderSentAtIso: cols.reminderSentAt ?? row.reminderSentAtIso,
        hourReminderSentForIso: cols.hourReminderSentFor ?? row.hourReminderSentForIso,
        sends: s.store.sendsFor(row.id),
      };
    });
  s.deps.legacyClaim = async (id, slug, startsAtIso, seen) => {
    s.writes.push(`legacy-claim:${id}:${slug}`);
    return s.store.legacyClaim(id, slug, startsAtIso, seen);
  };
  s.deps.legacyRelease = async (id, slug, claimedForIso, restoreTo, restoreSentAt) => {
    s.writes.push(`legacy-release:${id}:${slug}`);
    s.legacyReleased.push({ id, slug, claimedForIso, restoreTo, restoreSentAt });
    return s.store.legacyRelease(id, slug, claimedForIso, restoreTo, restoreSentAt);
  };
  s.deps.legacyMarkSent = async (id, startsAtIso) => {
    s.writes.push(`legacy-mark:${id}`);
    s.legacyMarked.push(`${id}@${startsAtIso}`);
    s.store.legacyMarkSent(id, startsAtIso);
  };
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
  const s = spy({ claimSend: async () => "taken" });
  const run = await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "a booking whose claim was lost sends nothing");
  eq(s.alerts.length, 0, "and losing a claim is not a fault, so nothing is alerted");
  eq(run.lost, 1, "it is counted as lost");
  eq(s.skips, [], "and a taken claim records nothing: the row that took it is the record");
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
  eq(s.failedRecords, [{ id: "bk-1", emailId: "email-day", reason: "provider_unavailable" }], "the send record is failed with its classified code");
  eq(s.alertKeys, ["booking_reminder_failed:bk-1"], "the 24 hour email pages under the booking's bare key, as before");
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
  eq(s.writes, [], "and nothing is recorded about it");
}

// --- a lead with no email address cannot be reminded -----------------------------
//
// It is not an error worth paging about: a booking can legitimately carry a phone and
// no address. It must not be claimed either, or the row is marked reminded for a
// message that never existed. Since #4298 it is RECORDED as a skip with its reason, so
// the status page and the owed check can tell it from an email nobody sent.
{
  const s = spy({ loadDue: async () => [due({ attendeeEmail: null })] });
  const result = await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "no address means no email");
  eq(s.order.length, 0, "and no claim, so the row is not marked as reminded");
  eq(result.skipped, 1, "the run counts it, because a silent skip is how a gap hides");
  eq(s.skips, [{ id: "bk-1", emailId: "email-day", reason: "no_email" }], "and records it as a no_email skip");
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
    claimSend: async () => "taken",
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
    { id: "bk-1", emailId: "email-day", sentForIso: due().startsAtIso },
    "the send record for this booking, email and start",
  );
  eq(
    s.legacyReleased[0],
    { id: "bk-1", slug: "day", claimedForIso: due().startsAtIso, restoreTo: null, restoreSentAt: null },
    "and the legacy column, conditional on the start it claimed, back to the value the tick read",
  );
  eq(s.order.join(" -> "), "claim:bk-1 -> release:bk-1", "after the claim and the failed send, never before");
  eq(s.failedRecords, [], "a released send is not recorded as failed");
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
  eq(s.failedRecords, [{ id: "bk-1", emailId: "email-day", reason: "token_unavailable" }], "and the send is recorded failed with its code");
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
  const lost = spy({ send: failingWith(mintTimeout()), releaseSend: async () => false });
  const lostRun = await runBookingReminders(lost.deps);
  eq(lostRun.retrying, 0, "a release that changed no row is not counted as retrying");
  eq(lostRun.retried, {}, "and names no booking to the share");
  assert(lost.warnings.some((w) => /not released/i.test(w)), "it is logged");
  eq(lost.alerts.length, 0, "and not paged: the row no longer holds the claim this tick wrote");

  const thrown = spy({
    send: failingWith(mintTimeout()),
    releaseSend: async () => {
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
  // The legacy column is put back only once the send record has been: left claimed, it
  // keeps a rollback from resending what this lane may still hold.
  eq(lost.legacyReleased, [], "a send record that would not release leaves the legacy column claimed");
  eq(thrown.legacyReleased, [], "and so does one whose release threw");
}

// --- the legacy column's own release, after the send record's ------------------------
{
  const s = spy({
    send: failingWith(mintTimeout()),
    legacyRelease: async () => {
      throw new Error("bookings update failed");
    },
  });
  const run = await runBookingReminders(s.deps);
  eq(run.retrying, 0, "a legacy column that could not be put back is not retrying: its claim still blocks the retry");
  eq(s.alerts.length, 1, "so it pages");
  assert(/could not be confirmed/i.test(s.alerts[0] ?? ""), `as a retry that could not be confirmed (${s.alerts[0]})`);
}
{
  // The column no longer holds this tick's claim: another writer moved it to some other
  // start, so it settles nothing for this one, and the released record is retried.
  const s = spy({ send: failingWith(mintTimeout()), legacyRelease: async () => false });
  const run = await runBookingReminders(s.deps);
  eq(run.retrying, 1, "a legacy column already changed by another writer blocks nothing, so the send is retrying");
  eq(s.alerts.length, 0, "and nobody is paged");
  assert(s.warnings.some((w) => /legacy column had changed/.test(w)), "but it is logged");
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
// again and sends. One email, and both records end holding the reminded start: the
// send row as sent, and the legacy column a rollback would read.
{
  const startsAtIso = due().startsAtIso;
  let sends = 0;
  const delivered: string[] = [];
  const s = spy({
    send: async (msg) => {
      sends += 1;
      if (sends === 1) throw mintTimeout();
      delivered.push(msg.to[0]!);
      return "gmail-id";
    },
  });
  wireStore(s);
  const first = await runBookingReminders(s.deps);
  eq(first.retrying, 1, "tick one: the mint timed out and the claim went back");
  eq(s.store.legacyOf("bk-1").reminderSentFor, null, "so the legacy column no longer records a reminder");
  eq(s.store.rows.map((r) => r.status), ["released"], "and the send record is released");
  const second = await runBookingReminders(s.deps);
  eq(second.sent, 1, "tick two: sent");
  eq(delivered, ["lead@example.com"], "exactly one email reached the lead");
  eq(s.store.legacyOf("bk-1").reminderSentFor, startsAtIso, "and the legacy column records the start it was sent about");
  assert(s.store.legacyOf("bk-1").reminderSentAt !== null, "with its send time");
  eq(s.store.rows.map((r) => r.status), ["sent"], "and the send record reads sent");
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
  assert(!placeholder.body.includes("(219) 758-8170"), "and never the number the call comes from");
  assert(/reply to one of our texts/.test(placeholder.body), "it tells the customer to reply to one of our texts");
  assert(!placeholder.body.includes("https://slate.trypennie.app/manage/abc"), "with no manage link (Dan, 2026-10-27)");
  assert(routed.body.includes("https://slate.trypennie.app/manage/abc"), "while the routed call keeps its manage link");
  assert(!/reply to this email and it will reach me/.test(placeholder.body), "and never promises a reply to the seat is read");
  eq(routed.attachments?.length ?? 0, 1, "the routed call beside it keeps its card");
  assert(/reply to this email and it will reach me directly/.test(routed.body), "and its own reply line");
  eq(s.order.filter((o) => o === "refresh").length, 1, "only the routed call's invite is rewritten with the number");
  eq(run.withCallingNumber, 1, "and only it counts as sent with a number");
  eq(asked, [["00QUi000010889AMAQ"]], "Salesforce is asked only about the routed call's lead");
}


// --- the 1 hour email (#4282) -------------------------------------------------------
//
// Judged in the same tick as the 24 hour email, after it: the same claim before send,
// the same sender, its own rule for being due and its own words.
const MIN = 60_000;
/** A call 55 minutes out, booked two days ago, whose 24 hour email went out yesterday. */
const hourDue = (over: Partial<DueBooking> = {}): DueBooking => {
  const startsAtIso = over.startsAtIso ?? new Date(NOW + 55 * MIN).toISOString();
  return due({
    startsAtIso,
    createdAtIso: new Date(NOW - 48 * HOUR).toISOString(),
    reminderSentForIso: startsAtIso,
    reminderSentAtIso: new Date(NOW - 23 * HOUR).toISOString(),
    hourReminderSentForIso: null,
    ...over,
  });
};
{
  const s = spy({ loadDue: async () => [hourDue()] });
  const run = await runBookingReminders(s.deps);
  eq(s.order.join(" -> "), "claim:bk-1 -> send:lead@example.com", "the 1 hour email is claimed before it is sent");
  eq(run.sent, 1, "and goes out once");
  assert(/in about an hour/.test(s.sent[0]!.subject), `in the 1 hour words (${s.sent[0]!.subject})`);
  assert(s.writes.includes("claim:bk-1:email-hour"), "claimed as the 1 hour email");
  eq(run.byEmail.hour?.sent, 1, "and counted under it");
}
{
  // A booking made a few hours ahead: its 24 hour email went out half an hour ago.
  const s = spy({ loadDue: async () => [hourDue({ reminderSentAtIso: new Date(NOW - 30 * MIN).toISOString() })] });
  const run = await runBookingReminders(s.deps);
  eq(s.order, [], "inside the two hour gap nothing is claimed or sent");
  eq(run.attempted, 0, "and nothing counts as attempted");
  eq(s.writes, [], "and the gap is a wait, never a stored skip");
  assert(run.waiting >= 1, "it is counted as waiting");
}
{
  // The 24 hour email, judging the same booking after its 1 hour email went out.
  const start = new Date(NOW + 50 * MIN).toISOString();
  const s = spy({ loadDue: async () => [due({ startsAtIso: start, reminderSentForIso: null, hourReminderSentForIso: start })] });
  await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "a 24 hour email is not sent after the 1 hour email for the same start");
  eq(s.skips, [{ id: "bk-1", emailId: "email-day", reason: "superseded" }], "and is recorded as superseded");
}
{
  // Too close to retry: the 1 hour email's own floor, 30 minutes plus the margin.
  const s = spy({
    loadDue: async () => [hourDue({ startsAtIso: new Date(NOW + 35 * MIN).toISOString() })],
    send: failingWith(mintTimeout()),
  });
  await runBookingReminders(s.deps);
  eq(s.released.length, 0, "a 1 hour email failing 35 minutes out is not handed back");
  eq(s.alerts.length, 1, "so it pages");
  eq(s.alertKeys, ["booking_reminder_failed:bk-1:hour"], "under the 1 hour email's own key, as before");
  assert(/1 hour reminder email/.test(s.alerts[0]!), `naming the 1 hour email (${s.alerts[0]})`);
  assert(!/24 hour/.test(s.alerts[0]!), "never the 24 hour one");
  assert(/too close to the call/i.test(s.alerts[0]!), `and that it is too late to try again (${s.alerts[0]})`);
}
{
  const s = spy({ loadDue: async () => [hourDue()], send: failingWith(mintTimeout()) });
  const run = await runBookingReminders(s.deps);
  eq(s.released.length, 1, "55 minutes out, a send that provably went nowhere is handed back");
  eq(s.legacyReleased[0]!.slug, "hour", "to the 1 hour record");
  eq(s.legacyReleased[0]!.restoreTo, null, "as this tick read it, not the 24 hour one");
  eq(run.retrying, 1, "and retried next tick");
  eq(run.retried, { "hour:bk-1": "token_unavailable" }, "keyed hour:<id> for the share, as before");
}
{
  const many = Array.from({ length: REMINDER_PAGES_PER_TICK + 2 }, (_, i) =>
    hourDue({ id: `bk-${i}`, attendeeEmail: `l${i}@example.com`, startsAtIso: new Date(NOW + 35 * MIN).toISOString() }),
  );
  const s = spy({ loadDue: async () => many, send: failingWith(mintTimeout()) });
  await runBookingReminders(s.deps);
  const foldedPage = s.alerts.at(-1)!;
  assert(/1 hour reminder emails/.test(foldedPage), `the folded page names the 1 hour email too (${foldedPage})`);
  eq(s.alertKeys.at(-1), `booking_reminder_failed:bk-${REMINDER_PAGES_PER_TICK}:hour`, "keyed on the first folded booking's 1 hour key");
}

// --- the send time is recorded only once it has gone (#4282) -----------------------
//
// The two hour gap is judged from it. Stamped at the claim, a 24 hour email that FAILED
// would read as sent minutes ago and cost the lead the 1 hour email too, so the lead
// would get neither. The send record is marked sent, and the legacy 24 hour column is
// stamped, both after Gmail accepted it.
{
  const s = spy();
  await runBookingReminders(s.deps);
  eq(s.marked, [`bk-1:email-day@${due().startsAtIso}`], "a 24 hour email that went out marks its send record");
  eq(s.legacyMarked, [`bk-1@${due().startsAtIso}`], "and stamps the legacy send time");
  eq(
    s.writes,
    ["claim:bk-1:email-day", "legacy-claim:bk-1:day", "send:lead@example.com", "mark:bk-1:email-day", "legacy-mark:bk-1"],
    "in this order: the send record claimed, the legacy column claimed, Gmail, then both marked",
  );
}
{
  const s = spy({ send: failingWith(new Error("Gmail send failed: 503")) });
  await runBookingReminders(s.deps);
  eq(s.marked, [], "one that failed marks nothing");
  eq(s.legacyMarked, [], "and stamps no send time");
}
{
  const s = spy({ loadDue: async () => [hourDue()] });
  await runBookingReminders(s.deps);
  eq(s.legacyMarked, [], "the 1 hour email stamps no legacy send time: there is no such column");
  eq(
    s.writes,
    ["claim:bk-1:email-hour", "legacy-claim:bk-1:hour", "send:lead@example.com", "mark:bk-1:email-hour"],
    "the 1 hour email claims its own legacy column, then sends, then marks its record",
  );
}
{
  const s = spy({
    legacyMarkSent: async () => {
      throw new Error("update failed");
    },
  });
  const run = await runBookingReminders(s.deps);
  eq(run.sent, 1, "a send time that cannot be written does not turn a sent email into a failed one");
  eq(s.alerts.length, 0, "and pages nobody: the 1 hour email then simply goes out");
  assert(s.warnings.some((w) => /send time/.test(w)), "but it is logged");
}
{
  const s = spy({
    markSendSent: async () => {
      throw new Error("rpc failed");
    },
  });
  const run = await runBookingReminders(s.deps);
  eq(run.sent, 1, "a send record that cannot be marked sent still counts the email as sent");
  eq(s.alerts.length, 0, "and pages nobody");
  assert(s.warnings.some((w) => /not marked sent/.test(w)), "but it is logged");
}

// --- the lead's own number reaches the email (#4292) -------------------------------
{
  const bodies: string[] = [];
  const s = spy({
    loadDue: async () => [due({ attendeePhone: "+12155550100" })],
    send: async (msg) => {
      bodies.push(msg.body);
      return "gmail-id";
    },
  });
  await runBookingReminders(s.deps);
  assert(bodies[0]?.includes("We will call you at (215) 555-0100") ?? false, "the booking's phone is the number the email names");
}

// =====================================================================================
// #4298: the stored emails
// =====================================================================================

// --- a failed read of the emails THROWS: no sends, and the heartbeat lapses ----------
//
// There is no fallback to DEFAULT_TEMPLATES. "Send the defaults" would email leads
// copy an admin may have changed or switched off, and the throw is what pages.
{
  const s = spy({
    loadEmails: async () => {
      throw new Error("reminder_emails read failed");
    },
  });
  let threw = false;
  try {
    await runBookingReminders(s.deps);
  } catch {
    threw = true;
  }
  assert(threw, "a failed read of the stored emails fails the tick");
  eq(s.sent.length, 0, "and nothing is sent");
  eq(s.loadDueCalls(), 0, "and the worklist is never read");
}

// --- no email switched on: an info line, and nothing read or sent ---------------------
for (const [label, emails] of [
  ["every email switched off", [{ ...DAY, enabled: false }, { ...HOUR_EMAIL, enabled: false }]],
  ["no email stored at all", []],
] as [string, LaneEmail[]][]) {
  const s = spy({}, emails);
  const run = await runBookingReminders(s.deps);
  eq(s.noneEnabled.length, 1, `${label}: the lane says so once`);
  assert(/no reminder email is switched on/i.test(s.noneEnabled[0] ?? ""), `${label}: in plain words (${s.noneEnabled[0]})`);
  eq(run.emailsEnabled, 0, `${label}: and the run counts none on`);
  eq(s.loadDueCalls(), 0, `${label}: with no worklist read`);
  eq(s.sent.length, 0, `${label}: and nothing sent`);
}
{
  const s = spy();
  await runBookingReminders(s.deps);
  eq(s.noneEnabled, [], "the control: with an email on, nothing is said");
}

// --- the worklist window is the longest ENABLED lead -------------------------------------
{
  const windows: number[] = [];
  const s = spy({
    loadDue: async (windowEndMs) => {
      windows.push(windowEndMs);
      return [];
    },
  }, [DAY, HOUR_EMAIL, { ...TWELVE, minutesBefore: 2880, enabled: false }]);
  await runBookingReminders(s.deps);
  eq(windows, [NOW + 24 * HOUR], "a disabled 48 hour email does not widen the read");
  const t = spy({
    loadDue: async (windowEndMs) => {
      windows.push(windowEndMs);
      return [];
    },
  }, [HOUR_EMAIL, { ...TWELVE, minutesBefore: 2880 }]);
  await runBookingReminders(t.deps);
  eq(windows[1], NOW + 48 * HOUR, "an enabled one does, up to its 48 hours");
}

// --- the legacy columns read as send records (one helper, which phase 5 reads too) --------
{
  const start = new Date(NOW + 5 * HOUR).toISOString();
  const sentAt = new Date(NOW - 19 * HOUR).toISOString();
  const records = sendRecordsForBooking(
    due({
      startsAtIso: start,
      reminderSentForIso: start,
      reminderSentAtIso: sentAt,
      hourReminderSentForIso: start,
      sends: [{ emailId: "email-twelve", sentForIso: start, status: "skipped", sentAtIso: null, claimedAtIso: sentAt }],
    }),
    [DAY, HOUR_EMAIL, TWELVE],
  );
  const startMs = Date.parse(start);
  const sentAtMs = Date.parse(sentAt);
  eq(
    records,
    [
      { emailId: "email-twelve", sentForMs: startMs, status: "skipped", sentAtMs: null, claimedAtMs: sentAtMs },
      { emailId: "email-day", sentForMs: startMs, status: "sent", sentAtMs, claimedAtMs: null },
      { emailId: "email-hour", sentForMs: startMs, status: "legacy_claimed", sentAtMs: null, claimedAtMs: null },
    ],
    "the stored rows, then reminder_sent_for with its time as sent and hour_reminder_sent_for as legacy_claimed",
  );
  const noTime = sendRecordsForBooking(due({ startsAtIso: start, reminderSentForIso: start }), [DAY, HOUR_EMAIL]);
  eq(noTime.map((r) => r.status), ["legacy_claimed"], "reminder_sent_for with no send time is legacy_claimed");
  eq(sendRecordsForBooking(due({ reminderSentForIso: start }), [HOUR_EMAIL]), [], "and no day email stored means no day record");
}
{
  // A send the OLD code made between the migration and this deploy wrote only the
  // legacy columns. It is never sent again.
  const start = due().startsAtIso;
  const s = spy({ loadDue: async () => [due({ reminderSentForIso: start, reminderSentAtIso: new Date(NOW - 5 * MIN).toISOString() })] });
  const run = await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "a 24 hour email the old code sent is not sent again");
  eq(s.writes, [], "and nothing is written for it");
  eq(run.attempted, 0, "or attempted");
  const h = spy({
    loadDue: async () => [hourDue({ reminderSentAtIso: null })],
  });
  await runBookingReminders(h.deps);
  eq(h.sent.length, 1, "a legacy 24 hour record with no send time starts no gap, as the old 1 hour rule released on one");
}

// --- a shorter email that was sent and then switched off still supersedes ---------------
//
// The judge is handed EVERY stored email, so the record of a 1 hour email sent before an
// admin switched it off still says the 24 hour one would now arrive after it.
{
  const start = new Date(NOW + 50 * MIN).toISOString();
  const s = spy(
    { loadDue: async () => [due({ startsAtIso: start, createdAtIso: new Date(NOW - 48 * HOUR).toISOString(), hourReminderSentForIso: start })] },
    [DAY, { ...HOUR_EMAIL, enabled: false }],
  );
  await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "the 24 hour email is not sent after a 1 hour email that has since been switched off");
  eq(s.skips, [{ id: "bk-1", emailId: "email-day", reason: "superseded" }], "it is superseded");
}

// --- a third email (12 hours) moves neither the hold nor the 24 hour retry floor -------
{
  const created = NOW;
  const startsAtIso = new Date(NOW + 5 * HOUR).toISOString();
  let clock = created + 9 * MIN;
  const s = spy(
    { now: () => clock, loadDue: async () => [due({ createdAtIso: new Date(created).toISOString(), startsAtIso })] },
    [DAY, TWELVE, HOUR_EMAIL],
  );
  const first = await runBookingReminders(s.deps);
  eq(first.byEmail.day?.held, 1, "nine minutes after booking, the 24 hour email is still held, as it was with two emails");
  eq(s.sent.length, 0, "and nothing goes out");
  clock = created + 10 * MIN + 30_000;
  const second = await runBookingReminders(s.deps);
  eq(second.byEmail.day?.sent, 1, "past the ten minute hold it goes, the same moment it did with two emails");
  eq(second.byEmail.twelve?.sent ?? 0, 0, "and the 12 hour email waits out the two hour gap behind it");
}
for (const [minutes, released] of [
  [65, 0],
  [80, 1],
] as const) {
  const s = spy(
    { loadDue: async () => [due({ startsAtIso: new Date(NOW + minutes * MIN).toISOString() })], send: failingWith(mintTimeout()) },
    [DAY, TWELVE, HOUR_EMAIL],
  );
  await runBookingReminders(s.deps);
  eq(s.released.length, released, `with a 12 hour email stored, the 24 hour email failing ${minutes} minutes out is released ${released} times, as before`);
  eq(s.released[0]?.emailId ?? "email-day", "email-day", `${minutes} minutes out: it is the 24 hour email that was attempted`);
}
{
  // The 12 hour email's own floor is set by its own lead, over an hour, so it is 70.
  const s = spy({ loadDue: async () => [due({ startsAtIso: new Date(NOW + 65 * MIN).toISOString() })], send: failingWith(mintTimeout()) }, [TWELVE]);
  await runBookingReminders(s.deps);
  eq(s.released.length, 0, "the 12 hour email failing 65 minutes out is not released either");
  eq(s.alertKeys, ["booking_reminder_failed:bk-1:twelve"], "and pages under booking_reminder_failed:<id>:<slug>");
  assert(/12 hour reminder email/.test(s.alerts[0] ?? ""), `naming the email by its stored name (${s.alerts[0]})`);
  assert(/before the lead's one hour text/.test(s.alerts[0] ?? ""), "with the reason a long lead email has a floor");
}

// --- switching an email on does not burst, through effective_from ---------------------
{
  const switchedOn = { ...TWELVE, effectiveFromIso: new Date(NOW - 20 * MIN).toISOString() };
  const s = spy(
    {
      loadDue: async () => [
        // Booked days ago, its 12 hour window opened two hours ago, before the switch.
        due({ id: "before", createdAtIso: new Date(NOW - 48 * HOUR).toISOString(), startsAtIso: new Date(NOW + 10 * HOUR).toISOString() }),
        // Booked after the switch, inside the window: sent at once.
        due({ id: "after", attendeeEmail: "after@example.com", createdAtIso: new Date(NOW - 15 * MIN).toISOString(), startsAtIso: new Date(NOW + 11 * HOUR).toISOString() }),
        // Its window has not opened.
        due({ id: "later", createdAtIso: new Date(NOW - 48 * HOUR).toISOString(), startsAtIso: new Date(NOW + 13 * HOUR).toISOString() }),
      ],
    },
    [switchedOn],
  );
  const run = await runBookingReminders(s.deps);
  eq(s.skips, [{ id: "before", emailId: "email-twelve", reason: "before_effective" }], "a booking whose window opened before the switch is skipped, and recorded");
  eq(s.sent.map((m) => m.to), ["after@example.com"], "one booked after it is sent");
  eq(run.waiting, 1, "and one whose window has not opened waits");
}

// --- a template the renderer refuses: send nothing for it, and alert ONCE per email ----
{
  const broken = { ...DAY, subject: "Your Pennie call {whenever}" };
  const s = spy(
    { loadDue: async () => [due({ id: "a" }), due({ id: "b", attendeeEmail: "b@example.com" }), due({ id: "c", attendeeEmail: "c@example.com" })] },
    [broken, HOUR_EMAIL],
  );
  const run = await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "no lead is sent an email holding a fill-in nobody can fill");
  eq(s.writes, [], "nothing is claimed or skipped for it either, so a fix sends what is still owed");
  eq(s.unrenderable.length, 1, "one alert for the email, not one per booking");
  eq(s.unrenderable[0]?.slug, "day", "about the email that cannot render");
  assert(/24 hour reminder/.test(s.unrenderable[0]?.text ?? ""), `naming it (${s.unrenderable[0]?.text})`);
  assert(/\{whenever\}/.test(s.unrenderable[0]?.text ?? ""), "and what it cannot fill");
  eq(run.unrenderable, ["day"], "the run names it");
  eq(s.renderable.at(-1)?.map((r) => r.slug), ["hour"], "and the email that does render is cleared");

  const fixed = spy({}, [DAY, HOUR_EMAIL]);
  await runBookingReminders(fixed.deps);
  eq(fixed.renderable.at(-1)?.map((r) => r.slug), ["day", "hour"], "once fixed, its alert is cleared on a tick that rendered it");
  assert(/renders again|being sent again/i.test(fixed.renderable.at(-1)?.[0]?.text ?? ""), `saying it is sent again (${fixed.renderable.at(-1)?.[0]?.text})`);

  const off = spy({}, [{ ...broken, enabled: false }, HOUR_EMAIL]);
  await runBookingReminders(off.deps);
  eq(off.unrenderable, [], "a broken email that is switched off pages nobody");
  assert(/switched off/i.test(off.renderable.at(-1)?.[0]?.text ?? ""), `and stands its alert down as switched off (${off.renderable.at(-1)?.[0]?.text})`);
}

// --- what each claim answer writes --------------------------------------------------------
{
  const s = spy({ claimSend: async () => "superseded" });
  const run = await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "superseded sends nothing");
  eq(s.skips, [{ id: "bk-1", emailId: "email-day", reason: "superseded" }], "and is recorded as a superseded skip");
  eq(run.skipped, 1, "counted as skipped");
}
{
  const s = spy({ claimSend: async () => "gap" });
  const run = await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "gap sends nothing");
  eq(s.skips, [], "and writes nothing: it is judged again next tick");
  assert(run.waiting >= 1, "counted as waiting");
}
{
  const s = spy({ claimSend: async () => "taken" });
  await runBookingReminders(s.deps);
  // The overriding claim records nothing itself, so every write here is the lane's own.
  eq(s.writes, [], "taken writes nothing past the claim: no legacy column, no skip, no send");
}
{
  // The legacy column changed under the claim (the old code claimed it in the same
  // minute): the old code is sending it, so this one must not.
  const s = spy({ legacyClaim: async () => false });
  const run = await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "a lost legacy claim sends nothing");
  eq(run.lost, 1, "and is counted as lost");
  eq(s.released.map((r) => r.emailId), ["email-day"], "and the send record it took is handed back");
}
{
  // The claim is a compare and swap on the legacy value THIS tick read.
  const seen: (string | null)[] = [];
  const earlier = new Date(NOW + 30 * HOUR).toISOString();
  const s = spy({
    loadDue: async () => [due({ reminderSentForIso: earlier })],
    legacyClaim: async (_id, _slug, _start, was) => {
      seen.push(was);
      return true;
    },
  });
  await runBookingReminders(s.deps);
  eq(seen, [earlier], "a moved booking claims its legacy column from the start it used to hold");
}
{
  // Any other email writes no legacy column at all.
  const s = spy({}, [TWELVE]);
  await runBookingReminders(s.deps);
  eq(
    s.writes,
    ["claim:bk-1:email-twelve", "send:lead@example.com", "mark:bk-1:email-twelve"],
    "a third email claims, sends and marks its send record only",
  );
}

// --- no advisor address: recorded, not dropped ------------------------------------------
{
  const s = spy({ loadDue: async () => [due({ agentEmail: null })] });
  const run = await runBookingReminders(s.deps);
  eq(s.sent.length, 0, "a booking with no advisor mailbox has nobody to send from");
  eq(s.skips, [{ id: "bk-1", emailId: "email-day", reason: "no_sender" }], "and is recorded as a no_sender skip");
  eq(run.skippedByReason.no_sender, 1, "counted by its reason");
}

// --- a skip that cannot be written costs nothing else -------------------------------------
{
  const s = spy({
    loadDue: async () => [due({ id: "a", attendeeEmail: null }), due({ id: "b", attendeeEmail: "b@example.com" })],
    skipSend: async () => {
      throw new Error("rpc failed");
    },
  });
  const run = await runBookingReminders(s.deps);
  eq(s.sent.map((m) => m.to), ["b@example.com"], "the other booking is still sent");
  assert(s.warnings.some((w) => /skip not recorded/.test(w)), "and the unrecorded skip is logged");
  eq(run.sent, 1, "the tick completes");
}

// --- the share keys ------------------------------------------------------------------
{
  eq(reminderShareKey("bk-1", "day"), "bk-1", "the 24 hour email keeps the bare id in the failure share");
  eq(reminderShareKey("bk-1", "hour"), "hour:bk-1", "the 1 hour email keeps hour:<id>");
  eq(reminderShareKey("bk-1", "twelve"), "twelve:bk-1", "any other email is <slug>:<id>");
  eq(reminderFailedAlertKey("bk-1", "day"), "booking_reminder_failed:bk-1", "the day page key is unchanged");
  eq(reminderFailedAlertKey("bk-1", "hour"), "booking_reminder_failed:bk-1:hour", "and the hour one");
  eq(reminderFailedAlertKey("bk-1", "twelve"), "booking_reminder_failed:bk-1:twelve", "and any other is :<id>:<slug>");
}

// --- a booking moved inside the window earns its emails afresh, with the store ---------
{
  const first = new Date(NOW + 12 * HOUR).toISOString();
  const moved = new Date(NOW + 13 * HOUR).toISOString();
  let start = first;
  const s = spy();
  wireStore(s, [() => due({ startsAtIso: start })]);
  await runBookingReminders(s.deps);
  start = moved;
  const again = await runBookingReminders(s.deps);
  eq(again.sent, 1, "a booking that moved is reminded about its new start");
  eq(s.store.rows.map((r) => `${r.status}@${r.sentForIso === first ? "first" : "moved"}`), ["sent@first", "sent@moved"], "and keeps the record of the earlier one");
  const third = await runBookingReminders(s.deps);
  eq(third.attempted, 0, "and is not reminded twice about it");
}

finish();
