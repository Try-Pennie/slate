// A placeholder call past its time with no Regal call to the customer (#4206). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-placeholder-calls.ts
//
// This file pins:
//   1. the verdict on one booking: not due until the booked end plus the grace, served
//      by any call to its Lead from 15 minutes before the start, unserved only once the
//      feed is alive past the due time, and an explicit unknown otherwise;
//   2. the check FIRING on a planted unserved call and staying quiet on a served one
//      (L1), keyed per booking and naming the booking as its subject;
//   3. the failure path: every read failing measures nothing, pages nothing and clears
//      nothing, and a feed that is behind clears nothing either;
//   4. every ending of a page in its own words (L11), and the watch closing before the
//      per booking prune would delete the page silently.
import {
  judgePlaceholderCall,
  placeholderCallDueMs,
  runPlaceholderCallCheck,
  formatPlaceholderCallAlert,
  formatPlaceholderCallEnding,
  placeholderCallAlertKey,
  PLACEHOLDER_CALL_EARLY_MS,
  PLACEHOLDER_CALL_GRACE_MS,
  PLACEHOLDER_CALL_LOOKBACK_MS,
  PLACEHOLDER_CALL_WATCH_MS,
  type PlaceholderBookingRow,
  type PlaceholderCallDeps,
  type PlaceholderCallRow,
} from "@/lib/monitor/placeholder-calls";
import { BOOKING_ALERT_PRUNE_GRACE_DAYS, BOOKING_KEYED_FAMILIES } from "@/lib/notify/alert-state-retention";
import { alertKindOf } from "@/lib/notify/alert-catalog";
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

// --- 2 and 3. the runner -------------------------------------------------------

interface Sent {
  key: string;
  text: string;
  subjects?: readonly string[];
}
interface HarnessOptions extends Partial<PlaceholderCallDeps> {
  bookings?: PlaceholderBookingRow[];
  calls?: PlaceholderCallRow[];
  firing?: string[];
  feed?: number | null;
}
function harness(over: HarnessOptions = {}) {
  const sent: Sent[] = [];
  const resolved: Sent[] = [];
  const asked: { since?: string; until?: string; keys?: string[]; callsSince?: string; byId?: string[] } = {};
  const all = over.bookings ?? [booking()];
  const deps: PlaceholderCallDeps = {
    loadCandidates: async (since, until) => {
      asked.since = since;
      asked.until = until;
      return all.filter((b) => b.starts_at >= since && b.starts_at <= until && b.kind === "staff_placed");
    },
    loadFiringIds: async () => over.firing ?? [],
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
  eq(h.sent[0]!.key, placeholderCallAlertKey(booking().id), "keyed per booking");
  eq(h.sent[0]!.subjects, [booking().id], "the booking is the page's subject, so a second unserved call posts at once");
  assert(h.sent[0]!.text.includes(`Lead ${LEAD_18}`), "the page names the Lead, an external id, so the customer can be found");
  assert(h.sent[0]!.text.includes("calBookingLink__c"), "the page says where the manage link is");
  eq(h.resolved.length, 0, "nothing was open, so nothing clears");
  eq(h.asked.since, new Date(NOW - PLACEHOLDER_CALL_LOOKBACK_MS).toISOString(), "new pages look back one day by start");
  eq(h.asked.keys, [LEAD_KEY], "calls are read by Lead key");
  eq(h.asked.callsSince, new Date(NOW - 60 * MIN - PLACEHOLDER_CALL_EARLY_MS).toISOString(), "from the early edge of the earliest start");
}
{
  const h = harness({ calls: [call(4)] });
  const r = await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 0, "a served call pages nobody");
  eq(r.status === "checked" && r.served, 1, "and is counted as served");
}
{
  const h = harness({ feed: NOW - 50 * MIN });
  const r = await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 0, "a feed behind the due time pages nobody");
  eq(r.status === "checked" && r.feedBehind, 1, "and is counted as an unknown, by name");
}
{
  const h = harness({ bookings: [booking({ salesforce_id: null })] });
  const r = await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 0, "a call with no Lead id cannot be matched, so it is not paged as unserved");
  eq(r.status === "checked" && r.noLeadId, [booking().id], "and is reported by id");
}
{
  const h = harness({ bookings: [booking({ status: "cancelled" }), booking({ id: "22222222-2222-4222-8222-222222222222", kind: "routed" })] });
  await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 0, "a cancelled call or one moved onto a real advisor is owed nothing");
}

// Every read failing, one at a time: unmeasured, nothing sent, nothing cleared.
for (const which of ["loadCandidates", "loadFiringIds", "loadBookingsById", "loadCalls", "feedNewestReceivedMs"] as const) {
  const h = harness({ firing: [booking().id] });
  (h.deps as unknown as Record<string, unknown>)[which] = async () => {
    throw new Error(`${which} read failed`);
  };
  const r = await runPlaceholderCallCheck(h.deps);
  eq(r.status, "unreadable", `an unreadable ${which} is unmeasured, never "no calls"`);
  eq(h.sent.length, 0, `an unreadable ${which} pages nobody`);
  eq(h.resolved.length, 0, `an unreadable ${which} clears nothing`);
}
{
  // An open page whose call still has not come, with the feed behind: left open.
  const h = harness({ firing: [booking().id], feed: NOW - 50 * MIN });
  const r = await runPlaceholderCallCheck(h.deps);
  eq(h.resolved.length, 0, "a feed that is behind ends nothing");
  eq(r.status === "checked" && r.settled, [], "nothing settled");
}
{
  // An open page still unserved is handed to the dispatcher again, which owns the repeat.
  const h = harness({ firing: [booking().id] });
  await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 1, "an open page still unserved is sent again for the dispatcher to judge");
  eq(h.resolved.length, 0, "and is not cleared");
}
{
  // An open page past the one day lookback is still judged by id, so its reminder runs.
  const old = booking({ starts_at: new Date(NOW - 30 * 60 * MIN).toISOString(), ends_at: new Date(NOW - 29.5 * 60 * MIN).toISOString() });
  const h = harness({ bookings: [old], firing: [old.id] });
  await runPlaceholderCallCheck(h.deps);
  eq(h.sent.length, 1, "an open page older than the lookback is still judged and sent");
}

// --- 4. the endings ---------------------------------------------------------------

async function ending(b: PlaceholderBookingRow | null, calls: PlaceholderCallRow[] = []): Promise<Sent[]> {
  const id = b?.id ?? "33333333-3333-4333-8333-333333333333";
  const h = harness({ bookings: b ? [b] : [], firing: [id], calls });
  await runPlaceholderCallCheck(h.deps);
  return h.resolved;
}
{
  const reached = await ending(booking(), [call(22)]);
  eq(reached.length, 1, "a call found closes the page");
  assert(reached[0]!.text.startsWith("Regal reached the customer"), "as a recovery");
  assert(reached[0]!.text.includes("22 minutes after the booked time"), "saying how late the call was");
  const ai = await ending(booking(), [call(3, { is_ai_agent: true })]);
  assert(ai[0]!.text.startsWith("Regal's AI agent reached the customer"), "an AI call is said as one");
  const cancelled = await ending(booking({ status: "cancelled" }));
  assert(
    cancelled[0]!.text.includes("was cancelled") && cancelled[0]!.text.includes("Nothing says the customer was reached"),
    "a cancel is not a recovery",
  );
  const moved = await ending(booking({ kind: "routed", agent_name: "Sam Davis" }));
  assert(moved[0]!.text.includes("is now with Sam Davis"), "a move onto a real advisor names them");
  const later = await ending(booking({ starts_at: new Date(NOW + 60 * MIN).toISOString(), ends_at: new Date(NOW + 90 * MIN).toISOString() }));
  assert(later[0]!.text.includes("was moved to") && later[0]!.text.includes("watched again"), "a move to a later time restarts the watch");
  assert(!later[0]!.text.includes("booked for"), "and names the new time as where the call went, never as the time paged about");
  const staleStart = NOW - PLACEHOLDER_CALL_WATCH_MS - MIN;
  const stale = booking({ starts_at: new Date(staleStart).toISOString(), ends_at: new Date(staleStart + 30 * MIN).toISOString() });
  const stopped = await ending(stale);
  assert(stopped[0]!.text.includes("no longer watched") && stopped[0]!.text.includes("Nothing was fixed"), "the watch ends as a stand down, never a recovery");
  const gone = await ending(null);
  assert(gone[0]!.text.includes("no longer in Slate"), "a booking that is gone says so");

  const sameBooking = (["reached", "cancelled", "moved-to-advisor", "rescheduled", "stopped-watching", "gone"] as const).map((e) =>
    formatPlaceholderCallEnding({ ending: e, bookingId: booking().id, booking: booking(), callMs: NOW - 50 * MIN }),
  );
  eq(new Set(sameBooking).size, 6, "six endings of one booking, six different sentences (L11)");
  const insideStart = NOW - PLACEHOLDER_CALL_WATCH_MS + 60 * MIN;
  const notYet = await ending(booking({ starts_at: new Date(insideStart).toISOString(), ends_at: new Date(insideStart + 30 * MIN).toISOString() }));
  eq(notYet.length, 0, "inside the watch, an unserved page stays open");
}
{
  assert(
    PLACEHOLDER_CALL_WATCH_MS < BOOKING_ALERT_PRUNE_GRACE_DAYS * 24 * 60 * MIN,
    "the watch closes the page before the per booking prune would remove it with no message",
  );
  assert(BOOKING_KEYED_FAMILIES.includes("placeholder_call_unserved"), "the family is pruned as a booking keyed one");
  eq(alertKindOf(placeholderCallAlertKey(booking().id)), "condition", "classified as a condition");
}
{
  const page = formatPlaceholderCallAlert(booking(), "https://slate.example/b");
  const endings = (["reached", "cancelled", "moved-to-advisor", "rescheduled", "stopped-watching", "gone"] as const).map((e) =>
    formatPlaceholderCallEnding({ ending: e, bookingId: booking().id, booking: booking(), callMs: NOW - 50 * MIN, url: "u" }),
  );
  for (const t of [page, ...endings]) assert(!DASHES.test(t), `no dash as punctuation: ${t.slice(0, 40)}`);
  assert(!page.toLowerCase().startsWith("slate"), "an alert never opens with the word Slate");
}

finish();
