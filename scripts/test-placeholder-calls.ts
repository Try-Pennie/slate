// A placeholder call past its time with no Regal call to the customer (#4206). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-placeholder-calls.ts
//
// This file pins:
//   1. the verdict on one booking: not due until the booked end plus the grace, served
//      by any call to its Lead from 15 minutes before the start, unserved only once the
//      feed is alive past the due time, and an explicit unknown otherwise;
//   2. ONE summary condition for the Eastern day (#4392, Dan 2026-10-29), not one page per
//      booking: it FIRES on a planted unserved call and stays quiet on a served one (L1),
//      lists every unserved call so far that day, and names each booking as a subject so a
//      new name in the list posts at once under the repeat policy;
//   3. the failure path: every read failing measures nothing, pages nothing and clears
//      nothing, and a feed that is behind clears nothing either;
//   4. every way a listed call stops being listed, in its own words (L11), said when the
//      list next posts and in the all clear, and the day turning as a stand down;
//   5. the retired per booking family: its leftover open pages are closed in words saying
//      so, and it is classified nowhere and pruned as nothing.
import {
  judgePlaceholderCall,
  placeholderCallDueMs,
  runPlaceholderCallCheck,
  formatPlaceholderCallsAlert,
  formatPlaceholderCallEnding,
  formatPlaceholderCallsAllClear,
  PLACEHOLDER_CALLS_ALERT_KEY,
  RETIRED_PLACEHOLDER_CALL_PREFIX,
  RETIRED_PLACEHOLDER_CALL_TEXT,
  PLACEHOLDER_CALL_EARLY_MS,
  PLACEHOLDER_CALL_GRACE_MS,
  type PlaceholderBookingRow,
  type PlaceholderCallDeps,
  type PlaceholderCallEnding,
  type PlaceholderCallRow,
} from "@/lib/monitor/placeholder-calls";
import { BOOKING_KEYED_FAMILIES } from "@/lib/notify/alert-state-retention";
import { ALERT_CATALOG, alertKindOf } from "@/lib/notify/alert-catalog";
import { placeholderDayStartMs } from "@/lib/booking/program-lead-times";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
// 2026-10-26 15:00 ET, a Monday afternoon.
const NOW = Date.UTC(2026, 9, 26, 19, 0, 0);
const LEAD_18 = "00Q5f00000AbCdEFGH";
const LEAD_KEY = LEAD_18.slice(0, 15);
// Built from char codes so this file holds no literal dash for the style gate to read.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

function booking(over: Partial<PlaceholderBookingRow> = {}): PlaceholderBookingRow {
  // Booked 14:00 to 14:30 ET by default: due at 14:45 ET, fifteen minutes ago.
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "staff_placed",
    status: "confirmed",
    starts_at: new Date(NOW - 60 * MIN).toISOString(),
    ends_at: new Date(NOW - 30 * MIN).toISOString(),
    salesforce_id: LEAD_18,
    agent_name: "Marcia",
    ...over,
  };
}
function call(minutesFromStart: number, over: Partial<PlaceholderCallRow> = {}, startMs = NOW - 60 * MIN): PlaceholderCallRow {
  return { lead_key: LEAD_KEY, started_at: new Date(startMs + minutesFromStart * MIN).toISOString(), is_ai_agent: false, ...over };
}
const ALIVE = NOW - 1 * MIN;

// --- 1. the verdict ----------------------------------------------------------

{
  const b = booking();
  eq(placeholderCallDueMs(b), NOW - 30 * MIN + PLACEHOLDER_CALL_GRACE_MS, "due the grace after the booked END, not the start");
  eq(judgePlaceholderCall(b, [], ALIVE, NOW - 16 * MIN).kind, "not-due", "before the due time nothing is judged");
  eq(judgePlaceholderCall(b, [], ALIVE, NOW).kind, "unserved", "due, the feed alive past it, and no call: unserved");
  eq(judgePlaceholderCall(b, [call(5)], ALIVE, NOW).kind, "served", "a call five minutes after the start serves it");
  eq(judgePlaceholderCall(b, [call(-14)], ALIVE, NOW).kind, "served", "a call 14 minutes early still counts");
  eq(judgePlaceholderCall(b, [call(-16)], ALIVE, NOW).kind, "unserved", "a call before the early edge is an earlier conversation");
  eq(PLACEHOLDER_CALL_EARLY_MS, 15 * MIN, "the early edge is the show rule's 15 minutes");
  eq(judgePlaceholderCall(b, [call(5, { lead_key: "00Q5f00000ZZZZZ" })], ALIVE, NOW).kind, "unserved", "another Lead's call does not serve it");
  const ai = judgePlaceholderCall(b, [call(2, { is_ai_agent: true })], ALIVE, NOW);
  eq(ai, { kind: "served", callMs: NOW - 58 * MIN, ai: true }, "a call from Regal's AI agent is Regal reaching out too");
  eq(
    judgePlaceholderCall(booking({ salesforce_id: LEAD_KEY }), [call(5)], ALIVE, NOW).kind,
    "served",
    "a 15 character Lead id finds the same calls as its 18 character spelling",
  );
}
{
  // The positive control on the feed (L98): absence is evidence only once the feed has
  // received anybody's call after the due time.
  const b = booking();
  const due = placeholderCallDueMs(b)!;
  eq(judgePlaceholderCall(b, [], due - 1, NOW).kind, "feed-behind", "a feed with nothing since the due time is an unknown, never no calls");
  eq(judgePlaceholderCall(b, [], null, NOW).kind, "feed-behind", "an empty feed is an unknown too");
  eq(judgePlaceholderCall(b, [], due, NOW).kind, "unserved", "a feed alive at the due time can say nobody called");
  eq(judgePlaceholderCall(b, [call(5)], null, NOW).kind, "served", "a call found is a call found, whatever the feed's newest");
}
{
  eq(judgePlaceholderCall(booking({ salesforce_id: null }), [], ALIVE, NOW).kind, "no-lead-id", "no Lead id is its own verdict");
  eq(judgePlaceholderCall(booking({ salesforce_id: "003000000000001" }), [], ALIVE, NOW).kind, "no-lead-id", "a Contact id is not a Lead id");
}


// --- 2 and 3. the runner: one summary condition for the day ----------------------------

const TODAY_START = placeholderDayStartMs("2026-10-26");
const YESTERDAY_START = placeholderDayStartMs("2026-10-25");
const B2 = "22222222-2222-4222-8222-222222222222";
const B3 = "33333333-3333-4333-8333-333333333333";
const LEAD_B = "00Q5f00000ZyXwVUTS";

interface Sent {
  key: string;
  text: string;
  subjects?: readonly string[];
}
interface HarnessOptions extends Partial<PlaceholderCallDeps> {
  bookings?: PlaceholderBookingRow[];
  calls?: PlaceholderCallRow[];
  listed?: string[];
  retired?: string[];
  feed?: number | null;
  /** The feed's first arrival after an instant, by that instant; default the instant itself. */
  firstAfter?: (ms: number) => number | null;
}
function harness(over: HarnessOptions = {}) {
  const sent: Sent[] = [];
  const resolved: Sent[] = [];
  const asked: { since?: string; until?: string; keys?: string[]; callsSince?: string; byId?: string[]; firstAfter?: string[] } = {};
  const all = over.bookings ?? [booking()];
  const deps: PlaceholderCallDeps = {
    loadCandidates: async (since, until) => {
      asked.since = since;
      asked.until = until;
      return all.filter((b) => b.starts_at >= since && b.starts_at <= until && b.kind === "staff_placed" && b.status !== "cancelled");
    },
    loadListedIds: async () => over.listed ?? [],
    loadBookingsById: async (ids) => {
      asked.byId = ids;
      return all.filter((b) => ids.includes(b.id));
    },
    loadCalls: async (keys, since) => {
      asked.keys = keys;
      asked.callsSince = since;
      return (over.calls ?? []).filter((c) => keys.includes(c.lead_key) && c.started_at >= since);
    },
    feedNewestReceivedMs: async () => (over.feed === undefined ? ALIVE : over.feed),
    feedFirstArrivalAfterMs: async (iso) => {
      (asked.firstAfter ??= []).push(iso);
      return (over.firstAfter ?? ((ms: number) => ms))(Date.parse(iso));
    },
    loadRetiredFiringIds: async () => over.retired ?? [],
    bookingUrl: (id) => `https://slate.example/admin/bookings/${id}`,
    notify: async (key, _ms, text, repeat) => {
      sent.push({ key, text, subjects: repeat?.subjects });
    },
    resolve: async (key, text) => {
      resolved.push({ key, text });
      return true;
    },
    cooldownMs: 24 * 60 * MIN,
    nowMs: NOW,
  };
  return { deps, sent, resolved, asked };
}

{
  const h = harness();
  const r = await runPlaceholderCallCheck(h.deps);
  eq(r.status, "checked", "a readable tick is checked");
  eq(h.sent.length, 1, "a planted unserved placeholder call pages (L1)");
  eq(h.sent[0]!.key, PLACEHOLDER_CALLS_ALERT_KEY, "on the ONE day summary key, never a key per booking");
  eq(h.sent[0]!.subjects, [booking().id], "the booking is a subject, so the next one named posts at once");
  assert(h.sent[0]!.text.includes(`Lead ${LEAD_18}`), "the page names the Lead, an external id, so the customer can be found");
  assert(h.sent[0]!.text.includes("calBookingLink__c"), "the page says where the manage link is");
  assert(h.sent[0]!.text.includes(`https://slate.example/admin/bookings/${booking().id}`), "and links the booking");
  eq(h.resolved.length, 0, "a day with an unserved call clears nothing");
  eq(h.asked.since, new Date(YESTERDAY_START).toISOString(), "it reads from the start of yesterday, for a late call judged this morning");
  eq(h.asked.keys, [LEAD_KEY], "calls are read by Lead key");
  eq(h.asked.callsSince, new Date(NOW - 60 * MIN - PLACEHOLDER_CALL_EARLY_MS).toISOString(), "from the early edge of the earliest start");
}
{
  // Two unserved calls today, in one message: the list, not two pages.
  const second = booking({ id: B2, salesforce_id: LEAD_B, starts_at: new Date(NOW - 120 * MIN).toISOString(), ends_at: new Date(NOW - 90 * MIN).toISOString() });
  const h = harness({ bookings: [booking(), second] });
  await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 1, "every unserved call today goes in one message");
  eq([...h.sent[0]!.subjects!].sort(), [booking().id, B2].sort(), "each booking is its own subject");
  assert(h.sent[0]!.text.includes(LEAD_18) && h.sent[0]!.text.includes(LEAD_B), "and each is named in the list");
  assert(h.sent[0]!.text.startsWith("2 placeholder calls today"), "the count leads, in the noun it counts");
}
{
  const h = harness({ calls: [call(4)] });
  const r = await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 0, "a served call pages nobody");
  eq(r.status === "checked" && r.served, 1, "and is counted as served");
  eq(h.resolved.map((x) => x.key), [PLACEHOLDER_CALLS_ALERT_KEY], "a measured day with nothing owed is the healthy result the all clear hangs off");
}
{
  const h = harness({ feed: NOW - 50 * MIN });
  const r = await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 0, "a feed behind the due time pages nobody");
  eq(r.status === "checked" && r.feedBehind, 1, "and is counted as an unknown, by name");
  eq(h.resolved.length, 0, "and clears nothing, since an unknown is not a healthy day");
}
{
  // An unserved call plus another the feed cannot judge yet: the page lists one and says the other is unknown.
  // Due ten minutes ago (its end plus the grace); the feed's newest is from before that.
  const later = booking({ id: B2, salesforce_id: LEAD_B, starts_at: new Date(NOW - 55 * MIN).toISOString(), ends_at: new Date(NOW - 25 * MIN).toISOString() });
  const h = harness({ bookings: [booking({ starts_at: new Date(NOW - 120 * MIN).toISOString(), ends_at: new Date(NOW - 90 * MIN).toISOString() }), later], feed: NOW - 30 * MIN });
  await runPlaceholderCallCheck(h.deps);
  eq(h.sent[0]!.subjects, [booking().id], "only the judged call is listed");
  assert(h.sent[0]!.text.includes("1 more past its time cannot be judged yet"), "the unknown one is said apart, never as missed");
}
{
  const h = harness({ bookings: [booking({ salesforce_id: null })] });
  const r = await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 0, "a call with no Lead id cannot be matched, so it is not listed as unserved");
  eq(r.status === "checked" && r.noLeadId, [booking().id], "and is reported by id");
}
{
  const h = harness({ bookings: [booking({ status: "cancelled" }), booking({ id: B2, kind: "routed" })] });
  await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 0, "a cancelled call or one moved onto a real advisor is owed nothing");
}
{
  // Yesterday's late call: the feed went quiet before it was due and first heard something
  // this morning, so it could not be judged yesterday. It is listed today.
  const lateStart = placeholderDayStartMs("2026-10-25") + 22.5 * 60 * MIN;
  const late = booking({ id: B3, starts_at: new Date(lateStart).toISOString(), ends_at: new Date(lateStart + 30 * MIN).toISOString() });
  const h = harness({ bookings: [late], firstAfter: () => TODAY_START + 8 * 60 * MIN });
  await runPlaceholderCallCheck(h.deps);
  eq(h.sent[0]?.subjects, [B3], "a late call the feed could only judge today is listed today");
  eq(h.asked.firstAfter, [new Date(placeholderCallDueMs(late)!).toISOString()], "asked of the feed from that call's due time");
  // The same call, but the feed was alive past it last night: it was listed yesterday, and
  // the day has turned, so it is not listed again.
  const h2 = harness({ bookings: [late], firstAfter: (ms) => ms + 5 * MIN });
  await runPlaceholderCallCheck(h2.deps);
  eq(h2.sent.length, 0, "a call judgeable yesterday belongs to yesterday's list, not today's");
}

// Every read failing, one at a time: unmeasured, nothing sent, nothing cleared.
for (const which of [
  "loadCandidates",
  "loadListedIds",
  "loadBookingsById",
  "loadCalls",
  "feedNewestReceivedMs",
  "feedFirstArrivalAfterMs",
  "loadRetiredFiringIds",
] as const) {
  const lateStart = placeholderDayStartMs("2026-10-25") + 22.5 * 60 * MIN;
  const late = booking({ id: B3, starts_at: new Date(lateStart).toISOString(), ends_at: new Date(lateStart + 30 * MIN).toISOString() });
  const h = harness({ bookings: [booking(), late], listed: [B2], retired: [B2] });
  (h.deps as unknown as Record<string, unknown>)[which] = async () => {
    throw new Error(`${which} read failed`);
  };
  const r = await runPlaceholderCallCheck(h.deps);
  eq(r.status, "unreadable", `an unreadable ${which} is unmeasured, never "no calls"`);
  eq(h.sent.length, 0, `an unreadable ${which} pages nobody`);
  eq(h.resolved.length, 0, `an unreadable ${which} clears nothing`);
}

// --- 4. how a listed call stops being listed ------------------------------------------

async function allClearAfter(b: PlaceholderBookingRow | null, calls: PlaceholderCallRow[] = []): Promise<Sent[]> {
  const id = b?.id ?? B3;
  // Listed in the last post, and nothing else is owed today.
  const h = harness({ bookings: b ? [b] : [], listed: [id], calls });
  await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 0, "nothing left to list posts no page");
  return h.resolved.filter((x) => x.key === PLACEHOLDER_CALLS_ALERT_KEY);
}
{
  const reached = await allClearAfter(booking(), [call(22)]);
  eq(reached.length, 1, "the list emptying is the all clear");
  assert(reached[0]!.text.includes("Regal reached the customer"), "naming a call found as one");
  assert(reached[0]!.text.includes("22 minutes after the booked time"), "saying how late the call was");
  const ai = await allClearAfter(booking(), [call(3, { is_ai_agent: true })]);
  assert(ai[0]!.text.includes("Regal's AI agent reached the customer"), "an AI call is said as one");
  const cancelled = await allClearAfter(booking({ status: "cancelled" }));
  assert(
    cancelled[0]!.text.includes("was cancelled") && cancelled[0]!.text.includes("Nothing says the customer was reached"),
    "a cancel is not a recovery",
  );
  const moved = await allClearAfter(booking({ kind: "routed", agent_name: "Sam Davis" }));
  assert(moved[0]!.text.includes("is now with Sam Davis"), "a move onto a real advisor names them");
  const later = await allClearAfter(booking({ starts_at: new Date(NOW + 60 * MIN).toISOString(), ends_at: new Date(NOW + 90 * MIN).toISOString() }));
  assert(later[0]!.text.includes("was moved to") && later[0]!.text.includes("watched again"), "a move to a later time restarts the watch");
  const twoDaysOld = placeholderDayStartMs("2026-10-24") + 14 * 60 * MIN;
  const over = await allClearAfter(booking({ starts_at: new Date(twoDaysOld).toISOString(), ends_at: new Date(twoDaysOld + 30 * MIN).toISOString() }));
  assert(over[0]!.text.includes("no longer listed") && over[0]!.text.includes("Nothing was fixed"), "the day turning is a stand down, never a recovery");
  const gone = await allClearAfter(null);
  assert(gone[0]!.text.includes("no longer in Slate"), "a booking that is gone says so");

  const endings: PlaceholderCallEnding[] = ["reached", "cancelled", "moved-to-advisor", "rescheduled", "day-over", "gone"];
  const sameBooking = endings.map((e) => formatPlaceholderCallEnding({ ending: e, bookingId: booking().id, booking: booking(), callMs: NOW - 50 * MIN }));
  eq(new Set(sameBooking).size, 6, "six endings of one booking, six different sentences (L11)");
}
{
  // One listed call reached while another is still owed: the page posts again only if
  // something new is named; when it does, it says how the dropped one ended.
  const second = booking({ id: B2, salesforce_id: LEAD_B, starts_at: new Date(NOW - 120 * MIN).toISOString(), ends_at: new Date(NOW - 90 * MIN).toISOString() });
  const h = harness({ bookings: [booking(), second], listed: [booking().id], calls: [call(10)] });
  await runPlaceholderCallCheck(h.deps);
  eq(h.sent[0]!.subjects, [B2], "the list is what is owed now");
  assert(h.sent[0]!.text.includes("No longer listed") && h.sent[0]!.text.includes("Regal reached the customer"), "and says how the dropped call ended");
  eq(h.resolved.filter((x) => x.key === PLACEHOLDER_CALLS_ALERT_KEY).length, 0, "while anything is listed nothing clears");
}
{
  // A listed call still owed today stays listed; no ending is invented for it.
  const h = harness({ listed: [booking().id] });
  await runPlaceholderCallCheck(h.deps);
  assert(!h.sent[0]!.text.includes("No longer listed"), "a call still owed is not said to have ended");
}

// --- 5. the retired per booking family ----------------------------------------------

{
  const h = harness({ calls: [call(4)], retired: [B2, B3] });
  const r = await runPlaceholderCallCheck(h.deps);
  eq(
    h.resolved.filter((x) => x.key.startsWith(`${RETIRED_PLACEHOLDER_CALL_PREFIX}:`)).map((x) => [x.key, x.text]),
    [
      [`${RETIRED_PLACEHOLDER_CALL_PREFIX}:${B2}`, RETIRED_PLACEHOLDER_CALL_TEXT],
      [`${RETIRED_PLACEHOLDER_CALL_PREFIX}:${B3}`, RETIRED_PLACEHOLDER_CALL_TEXT],
    ],
    "an open page left by the retired per booking family is closed, in words saying it was replaced",
  );
  eq(r.status === "checked" && r.retiredClosed, 2, "and counted");
  assert(RETIRED_PLACEHOLDER_CALL_TEXT.includes("one summary for the day"), "the closing words point at the summary that replaced it");
  eq(RETIRED_PLACEHOLDER_CALL_PREFIX, "placeholder_call_unserved", "the family retired is the per booking one");
  assert(!ALERT_CATALOG.some((e) => e.key.startsWith(`${RETIRED_PLACEHOLDER_CALL_PREFIX}:`)), "the catalog no longer classifies the retired family");
  assert(!BOOKING_KEYED_FAMILIES.includes(RETIRED_PLACEHOLDER_CALL_PREFIX), "and the prune no longer treats it as a live booking family");
  eq(alertKindOf(PLACEHOLDER_CALLS_ALERT_KEY), "condition", "the summary is a condition, so it resolves");
  assert(PLACEHOLDER_CALLS_ALERT_KEY !== RETIRED_PLACEHOLDER_CALL_PREFIX, "and is a different key");
}
{
  const page = formatPlaceholderCallsAlert({
    unserved: [booking()],
    unknown: 1,
    ended: [{ bookingId: B2, ending: "cancelled", text: "Done." }],
    bookingUrl: (id) => `https://slate.example/b/${id}`,
  });
  const endings = (["reached", "cancelled", "moved-to-advisor", "rescheduled", "day-over", "gone"] as const).map((e) =>
    formatPlaceholderCallEnding({ ending: e, bookingId: booking().id, booking: booking(), callMs: NOW - 50 * MIN, url: "u" }),
  );
  const clear = formatPlaceholderCallsAllClear([]);
  for (const t of [page, clear, RETIRED_PLACEHOLDER_CALL_TEXT, ...endings]) assert(!DASHES.test(t), `no dash as punctuation: ${t.slice(0, 40)}`);
  for (const t of [page, clear, RETIRED_PLACEHOLDER_CALL_TEXT]) assert(!t.toLowerCase().startsWith("slate"), "an alert never opens with the word Slate");
  assert(page.startsWith("1 placeholder call today is"), "one call is said in the singular");
  void PLACEHOLDER_CALL_GRACE_MS;
}

finish();
