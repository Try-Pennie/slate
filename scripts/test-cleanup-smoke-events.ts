// Unit test (#524) for the smoke-test calendar cleanup filter.
//
// The booking smoke test (scripts/smoke-booking-api.ts) books and cancels real
// bookings on the smoketest@/smoketest2@ mailboxes. Per #166 a cancel can leave a
// lingering Google event, so those calendars accumulate orphaned busy blocks; the
// reschedule hot path reads LIVE from Google, so that clutter makes the lone test
// agent read busy and smoke runs flake. This exercises the pure identification
// filter that decides which events are safe to delete. Deleting from a REAL
// mailbox, so the filter must be conservative: only smoke-marked, already-ended,
// timed events; never an all-day or unmarked (possibly real) event.
//
// Run: node --experimental-strip-types scripts/test-cleanup-smoke-events.ts
import {
  isStaleSmokeEvent,
  partitionSmokeEvents,
  sweepMailbox,
  sweepMailboxes,
  sweepQuietly,
  makeGoogleCalendarClient,
  type CalEvent,
  type CalendarClient,
} from "./lib/smoke-event-cleanup.ts";
import { PUBLIC_TEST_EVENT_TYPE_NAME } from "./smoke-seed.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// Fixed reference clock so the test never touches Date.now().
const NOW = Date.parse("2026-07-17T18:00:00Z");
const PAST_START = "2026-07-10T14:00:00Z";
const PAST_END = "2026-07-10T14:30:00Z";
const FUTURE_START = "2026-07-24T14:00:00Z";
const FUTURE_END = "2026-07-24T14:30:00Z";

function timed(over: Partial<CalEvent> & { id: string }): CalEvent {
  return {
    start: { dateTime: PAST_START },
    end: { dateTime: PAST_END },
    ...over,
  };
}

// --- single-event verdicts ----------------------------------------------------

assert(
  isStaleSmokeEvent(timed({ id: "a", summary: "Intro call with Smoke Test" }), NOW),
  "past timed event with a Smoke Test summary is a stale orphan",
);

assert(
  isStaleSmokeEvent(
    timed({ id: "b", summary: "Consultation", attendees: [{ email: "smoketest+intro-1@trypennie.com" }] }),
    NOW,
  ),
  "past timed event with a smoketest+ attendee alias is a stale orphan even without a summary marker",
);

assert(
  !isStaleSmokeEvent(
    timed({ id: "c", summary: "Intro call with Smoke Test", start: { dateTime: FUTURE_START }, end: { dateTime: FUTURE_END } }),
    NOW,
  ),
  "future smoke event is NOT swept (a concurrent smoke run may be using it)",
);

assert(
  !isStaleSmokeEvent(timed({ id: "d", summary: "Team standup" }), NOW),
  "past unmarked (real) event is never swept",
);

// #2660: a partner's test booking lands on the same mailbox under the public
// test bucket's own event type, with the tester's real address as the attendee,
// so neither existing marker sees it. The title carries the event type name,
// which is the marker.
assert(
  isStaleSmokeEvent(
    timed({
      id: "p",
      summary: `${PUBLIC_TEST_EVENT_TYPE_NAME} with Jane Partner`,
      attendees: [{ email: "jane@agency.example" }],
    }),
    NOW,
  ),
  "a past partner test call, with a stranger's address and no smoke alias, is a stale orphan",
);
assert(
  !isStaleSmokeEvent(
    timed({
      id: "q",
      summary: `${PUBLIC_TEST_EVENT_TYPE_NAME} with Jane Partner`,
      start: { dateTime: FUTURE_START },
      end: { dateTime: FUTURE_END },
    }),
    NOW,
  ),
  "a partner test call still to come is never swept: the tester may be about to join it",
);
assert(
  !isStaleSmokeEvent(timed({ id: "r", summary: "Partner review with the agency" }), NOW),
  "a real meeting that merely mentions a partner is not the test event type and is kept",
);

assert(
  !isStaleSmokeEvent(
    { id: "e", summary: "Smoke Test all-day block", start: { date: "2026-07-10" }, end: { date: "2026-07-11" } },
    NOW,
  ),
  "all-day event is never swept even with a smoke marker (booking events are timed)",
);

assert(
  !isStaleSmokeEvent(timed({ id: "f", summary: "Intro call with Smoke Test", status: "cancelled" }), NOW),
  "already-cancelled smoke event is not swept (nothing to delete; freeBusy ignores it)",
);

// --- partition over a mixed calendar ------------------------------------------

const events: CalEvent[] = [
  timed({ id: "keep-real", summary: "1:1 with a real person" }),
  timed({ id: "del-summary", summary: "Intro call with Smoke Test" }),
  timed({ id: "del-attendee", summary: "", attendees: [{ email: "smoketest+resched-2@trypennie.com" }] }),
  timed({ id: "keep-future", summary: "with Smoke Test", start: { dateTime: FUTURE_START }, end: { dateTime: FUTURE_END } }),
  { id: "keep-allday", summary: "Smoke Test", start: { date: "2026-07-10" }, end: { date: "2026-07-11" } },
];

const { toDelete, kept } = partitionSmokeEvents(events, NOW);
eq(toDelete.map((e) => e.id).sort().join(","), "del-attendee,del-summary", "partition selects only the two stale smoke orphans");
eq(kept.length, 3, "partition keeps the real, future, and all-day events");

// --- sweep orchestration (fake calendar client, no real Google) ---------------

function fakeClient(
  list: CalEvent[],
  opts: { failListOn?: string; failDelOn?: string } = {},
): { client: CalendarClient; deleted: string[] } {
  const deleted: string[] = [];
  const client: CalendarClient = {
    async list(email) {
      if (opts.failListOn === email) throw new Error("boom-list");
      return list;
    },
    async del(email, id) {
      if (opts.failDelOn === id) throw new Error("boom-del");
      deleted.push(id);
    },
  };
  return { client, deleted };
}

async function rejects(p: Promise<unknown>, needle: string, msg: string): Promise<void> {
  try {
    await p;
    assert(false, `${msg} (expected throw, got resolve)`);
  } catch (err) {
    assert(err instanceof Error && err.message.includes(needle), `${msg} (threw "${err instanceof Error ? err.message : err}")`);
  }
}

{
  // dry run: matches but never calls delete.
  const { client, deleted } = fakeClient(events);
  const r = await sweepMailbox("smoketest@x", { apply: false, now: NOW }, client);
  eq(r.matched, 2, "dry-run sweep matches the two orphans");
  eq(r.deleted, 0, "dry-run sweep deletes nothing");
  assert(r.dryRun === true && deleted.length === 0, "dry-run sweep never calls the delete client");
}
{
  // apply: deletes exactly the matched orphans.
  const { client, deleted } = fakeClient(events);
  const r = await sweepMailbox("smoketest@x", { apply: true, now: NOW }, client);
  eq(r.deleted, 2, "apply sweep deletes the two orphans");
  eq(deleted.sort().join(","), "del-attendee,del-summary", "apply sweep deletes exactly the matched orphan ids");
}
{
  // fail loud: a list error propagates (not swallowed).
  const { client } = fakeClient(events, { failListOn: "smoketest@x" });
  await rejects(sweepMailbox("smoketest@x", { apply: true, now: NOW }, client), "boom-list", "sweepMailbox rethrows a list failure (fail loud)");
}
{
  // fail loud: a delete error propagates.
  const { client } = fakeClient(events, { failDelOn: "del-summary" });
  await rejects(sweepMailbox("smoketest@x", { apply: true, now: NOW }, client), "boom-del", "sweepMailbox rethrows a delete failure (fail loud)");
}
{
  // sweepMailboxes aggregates across mailboxes.
  const { client } = fakeClient(events);
  const rs = await sweepMailboxes(["a@x", "b@x"], { apply: true, now: NOW }, client);
  eq(rs.length, 2, "sweepMailboxes returns one result per mailbox");
  eq(rs.reduce((n, r) => n + r.deleted, 0), 4, "sweepMailboxes deletes the orphans on every mailbox");
}
{
  // sweepQuietly: success reports the count.
  const { client } = fakeClient(events);
  const ok = await sweepQuietly(["a@x"], { now: NOW }, client);
  assert(ok.ok === true && ok.deleted === 2, "sweepQuietly reports the deleted count on success");
}
{
  // sweepQuietly: a failure is swallowed (never throws) so the smoke run survives.
  const { client } = fakeClient(events, { failListOn: "a@x" });
  const bad = await sweepQuietly(["a@x"], { now: NOW }, client);
  assert(bad.ok === false && (bad.error ?? "").includes("boom-list"), "sweepQuietly swallows a failure and returns ok=false with the error");
}

// --- HTTP client error handling (fake fetch + token) --------------------------

function resp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
const token = async () => "tok";

{
  // list paginates and projects across pages.
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? resp({ items: [{ id: "p1" }], nextPageToken: "n" })
      : resp({ items: [{ id: "p2" }] });
  }) as unknown as typeof fetch;
  const client = makeGoogleCalendarClient({ fetch: fetchFn, getToken: token });
  const out = await client.list("a@x", "t0", "t1");
  eq(out.map((e) => e.id).join(","), "p1,p2", "list follows nextPageToken and aggregates every page");
}
{
  // list throws loud on a non-ok response.
  const fetchFn = (async () => resp("nope", 500)) as unknown as typeof fetch;
  const client = makeGoogleCalendarClient({ fetch: fetchFn, getToken: token });
  await rejects(client.list("a@x", "t0", "t1"), "events.list failed", "list throws on a non-ok response");
}
{
  // delete tolerates 404/410 (already gone) but throws on a real error.
  const okStatuses = [404, 410];
  for (const s of okStatuses) {
    const client = makeGoogleCalendarClient({ fetch: (async () => resp("", s)) as unknown as typeof fetch, getToken: token });
    let threw = false;
    try {
      await client.del("a@x", "id");
    } catch {
      threw = true;
    }
    assert(!threw, `delete tolerates ${s} (already gone)`);
  }
  const client = makeGoogleCalendarClient({ fetch: (async () => resp("nope", 500)) as unknown as typeof fetch, getToken: token });
  await rejects(client.del("a@x", "id"), "events.delete failed", "delete throws on a real (non-404/410) error");
}
{
  // #3144 (L742): a cached token Google refuses is replaced and the call resent
  // once, so a stale token cannot fail the sweep; a second refusal still throws.
  const refusedSeen: (string | undefined)[] = [];
  const rotating = async (_email: string, refused?: string) => {
    refusedSeen.push(refused);
    return refused ? "fresh" : "stale";
  };
  const auths: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("authorization") ?? "";
    auths.push(auth);
    return auth === "Bearer stale" ? resp("Invalid Credentials", 401) : resp({ items: [{ id: "p1" }] });
  }) as unknown as typeof fetch;
  const client = makeGoogleCalendarClient({ fetch: fetchFn, getToken: rotating });
  const out = await client.list("a@x", "t0", "t1");
  eq(out.map((e) => e.id).join(","), "p1", "list survives a refused cached token by resending on a fresh one");
  eq(auths.join(","), "Bearer stale,Bearer fresh", "the resend carries the fresh token, once");
  eq(refusedSeen.join(","), ",stale", "the refresh names the refused token");

  let sends = 0;
  const alwaysRefused = (async () => {
    sends++;
    return resp("unauthorized", 401);
  }) as unknown as typeof fetch;
  const refusing = makeGoogleCalendarClient({ fetch: alwaysRefused, getToken: rotating });
  await rejects(refusing.list("a@x", "t0", "t1"), "events.list failed", "a second refusal still throws");
  eq(sends, 2, "a second refusal is not resent again");
}

finish();
