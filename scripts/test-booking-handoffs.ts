// #2367: a booking that is waiting on a PERSON is recorded once, said once, and
// ends only when something measured says it is over.
//
// Two situations need somebody on the sales side to act: a duplicate booking Slate
// cannot safely cancel, and an owner reassign Slate refuses. A throttled Slack line
// could not carry either (transient, can post twice, silent while Slack is down), so
// they are durable rows, delivered by the monitor lane.
//
// Every outcome the check can produce is driven here through hand written fakes,
// in both directions wherever there are two, because a check that can only ever
// answer one way is satisfied by a function hard wired to that answer (L1, L151).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-handoffs.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  HANDOFF_KINDS,
  type HandoffInput,
} from "@/lib/handoffs/kinds";
import { recordHandoff, type HandoffWriter, type NewHandoffRow } from "@/lib/handoffs/record";
import { handoffWriter, loadHandoffChannel } from "@/lib/handoffs/store";
import {
  HANDOFF_CHANNEL_UNSET_KEY,
  HANDOFF_POSTS_PER_TICK,
  HANDOFF_UNDELIVERED_AFTER_MS,
  HANDOFF_UNDELIVERED_KEY,
  OPEN_HANDOFF_READ_LIMIT,
  handoffResolution,
  runHandoffCheck,
  type HandoffBooking,
  type HandoffCheckDeps,
  type HandoffResolution,
  type OpenHandoff,
} from "@/lib/handoffs/check";
import {
  formatHandoffChannelUnsetAlert,
  formatHandoffNotice,
  formatHandoffUndeliveredAlert,
} from "@/lib/handoffs/copy";

const NOW = Date.parse("2026-09-15T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

// --- the migration and the code hold ONE vocabulary ---------------------------
{
  const dir = join(import.meta.dirname, "..", "supabase", "migrations");
  const file = readdirSync(dir).find((f) => /_booking_handoffs\.sql$/.test(f));
  assert(Boolean(file), "a booking_handoffs migration exists");
  const sql = file ? readFileSync(join(dir, file), "utf8") : "";
  const check = /kind\s+text\s+not null\s+check\s*\(\s*kind\s+in\s*\(([^)]*)\)\s*\)/i.exec(sql);
  assert(check !== null, "the migration constrains kind with a CHECK");
  const inSql = [...(check?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  eq(inSql, [...HANDOFF_KINDS].sort(), "the CHECK lists exactly the kinds the code writes");
  assert(
    /create unique index\s+\w+\s+on booking_handoffs\s*\(\s*booking_id\s*,\s*kind\s*\)\s*where\s+status\s*=\s*'open'/i.test(sql),
    "one OPEN row per booking and kind is a database constraint, not application care",
  );
  assert(
    !/unique\s*\(\s*booking_id\s*,\s*kind\s*\)/i.test(sql),
    "and there is no full unique key, which would stop a recurrence after a resolve from being recorded",
  );
  assert(
    /alter table booking_handoffs\s+enable row level security/i.test(sql),
    "the table denies every client by default",
  );
  assert(
    /add column handoff_channel text/i.test(sql),
    "the handoff channel is a nullable setting",
  );
}

// --- recordHandoff: twice is one row, and a real error is loud ------------------

/** A writer with the constraint the database has: one OPEN row per (booking, kind),
 *  the partial unique index. `resolve` stands in for the monitor lane settling a row. */
function fakeWriter() {
  const rows: (NewHandoffRow & { status: "open" | "resolved" })[] = [];
  let failWith: Error | null = null;
  const writer: HandoffWriter = {
    async insertOnce(row) {
      if (failWith) throw failWith;
      if (rows.some((r) => r.status === "open" && r.booking_id === row.booking_id && r.kind === row.kind)) {
        return { inserted: false };
      }
      rows.push({ ...row, status: "open" });
      return { inserted: true };
    },
  };
  const resolve = (bookingId: string, kind: string) => {
    for (const r of rows) if (r.booking_id === bookingId && r.kind === kind) r.status = "resolved";
  };
  return { writer, rows, resolve, fail: (e: Error) => (failWith = e) };
}

const DUP: HandoffInput = {
  bookingId: "b-dup",
  kind: "duplicate-unresolved",
  detail: { finding: "no-other-call", weakerMatch: null, laterBookingStartsAt: null },
};
const OWNER: HandoffInput = {
  bookingId: "b-owner",
  kind: "owner-reassign-refused",
  detail: {
    refusal: "owner-not-bookable",
    requestedOwnerUserId: "u-owner",
    requestedOwnerEmail: "owner@trypennie.com",
  },
};

{
  const { writer, rows } = fakeWriter();
  eq(await recordHandoff(writer, DUP), "recorded", "the first call records the handoff");
  eq(await recordHandoff(writer, DUP), "already-recorded", "a second call says it was already there");
  eq(rows.length, 1, "and the table holds one row, not two");
  eq(await recordHandoff(writer, OWNER), "recorded", "another kind is its own row");
  eq(
    await recordHandoff(writer, { ...OWNER, bookingId: "b-dup" }),
    "recorded",
    "the same booking with a different kind is its own row",
  );
  eq(rows.length, 3, "three distinct (booking, kind) pairs, three rows");
  eq(rows[0].detail, DUP.detail, "the detail is written as given");
}
{
  // A situation that ends and then genuinely recurs on the same booking is a NEW
  // handoff: the resolved row is history, and the recurrence needs a person again.
  const { writer, rows, resolve } = fakeWriter();
  eq(await recordHandoff(writer, OWNER), "recorded", "recurrence: the first refusal is recorded");
  resolve(OWNER.bookingId, OWNER.kind);
  eq(await recordHandoff(writer, OWNER), "recorded", "recurrence: a refusal after the first resolved is recorded again");
  eq(rows.length, 2, "recurrence: two rows for the booking and kind");
  eq(rows.filter((r) => r.status === "open").length, 1, "recurrence: exactly one of them open");
  eq(
    await recordHandoff(writer, OWNER),
    "already-recorded",
    "recurrence: a retry of the recurrence is still one open row, not a third",
  );
  eq(rows.length, 2, "recurrence: still two rows after the retry");
}
{
  const { writer, fail } = fakeWriter();
  fail(new Error("permission denied for table booking_handoffs"));
  let threw: unknown = null;
  try {
    await recordHandoff(writer, DUP);
  } catch (err) {
    threw = err;
  }
  assert(
    threw instanceof Error && /permission denied/.test(threw.message),
    "a real write error throws with its own message, never a quiet already-recorded",
  );
}
{
  const { writer, rows } = fakeWriter();
  let threw: unknown = null;
  try {
    await recordHandoff(writer, { ...DUP, bookingId: "  " });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error && /booking/.test(threw.message), "a blank booking id is refused loudly");
  eq(rows.length, 0, "and nothing is written for it");
}

// --- the database writer: the unique key is the dedupe, and nothing else is -----
{
  type Reply = { error: { code?: string; message: string } | null };
  const fakeDb = (reply: Reply) => {
    const inserted: unknown[] = [];
    const db = {
      from: (table: string) => ({
        insert: async (row: unknown) => {
          inserted.push({ table, row });
          return reply;
        },
      }),
    };
    return { db: db as unknown as Parameters<typeof handoffWriter>[0], inserted };
  };
  const ok = fakeDb({ error: null });
  eq(await handoffWriter(ok.db).insertOnce({ booking_id: "b", kind: "duplicate-unresolved", detail: {} }), { inserted: true }, "a clean insert is a new row");
  eq((ok.inserted[0] as { table: string }).table, "booking_handoffs", "into booking_handoffs");

  const dup = fakeDb({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
  eq(
    await handoffWriter(dup.db).insertOnce({ booking_id: "b", kind: "duplicate-unresolved", detail: {} }),
    { inserted: false },
    "the partial unique index refusing a second OPEN row reads as already recorded",
  );

  const broken = fakeDb({ error: { code: "42501", message: "permission denied for table booking_handoffs" } });
  let threw: unknown = null;
  try {
    await handoffWriter(broken.db).insertOnce({ booking_id: "b", kind: "duplicate-unresolved", detail: {} });
  } catch (err) {
    threw = err;
  }
  assert(
    threw instanceof Error && /permission denied/.test(threw.message),
    "any other refusal throws, even one whose message mentions a key",
  );

  const dupWorded = fakeDb({ error: { code: "XX000", message: "duplicate key value violates unique constraint" } });
  threw = null;
  try {
    await handoffWriter(dupWorded.db).insertOnce({ booking_id: "b", kind: "duplicate-unresolved", detail: {} });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error, "a duplicate is recognised by its SQLSTATE, never by its wording");
}

// --- the channel read: unset and unreadable are different answers -----------------
{
  const cfgDb = (reply: { data: unknown; error: { message: string } | null }) =>
    ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => reply }) }) }),
    }) as unknown as Parameters<typeof loadHandoffChannel>[0];
  eq(await loadHandoffChannel(cfgDb({ data: { handoff_channel: " C-SALES " }, error: null })), "C-SALES", "a set channel is read, trimmed");
  eq(await loadHandoffChannel(cfgDb({ data: { handoff_channel: "  " }, error: null })), null, "a blank channel is unset");
  eq(await loadHandoffChannel(cfgDb({ data: null, error: null })), null, "no config row at all is unset");
  let threw = false;
  try {
    await loadHandoffChannel(cfgDb({ data: null, error: { message: "column handoff_channel does not exist" } }));
  } catch {
    threw = true;
  }
  eq(threw, true, "a failed read throws, so it can never be taken for unset");
}

// --- handoffResolution: each rule in both directions -----------------------------

const handoff = (over: Partial<OpenHandoff> = {}): OpenHandoff => ({
  id: "h1",
  bookingId: "b1",
  kind: "duplicate-unresolved",
  detail: DUP.detail,
  createdAt: iso(NOW - 5 * MIN),
  notifiedAt: null,
  notifyAttempts: 0,
  lastNotifyError: null,
  ...over,
});
const booking = (over: Partial<HandoffBooking> = {}): HandoffBooking => ({
  id: "b1",
  status: "confirmed",
  startsAt: iso(NOW + 24 * 60 * MIN),
  timezone: "America/New_York",
  assignedUserId: "u-agent",
  agentName: "Dana Whitfield",
  agentEmail: "dana@trypennie.com",
  attendeeName: "Jordan Lee",
  ...over,
});
const ownerHandoff = (over: Partial<OpenHandoff> = {}) =>
  handoff({ kind: "owner-reassign-refused", detail: OWNER.detail, ...over });

{
  eq(handoffResolution(handoff(), booking(), NOW), null, "duplicate: an upcoming active call stays open");
  eq(
    handoffResolution(handoff(), booking({ status: "rescheduled" }), NOW),
    null,
    "duplicate: rescheduled is still active, so it stays open",
  );
  eq(
    handoffResolution(handoff(), booking({ status: "cancelled" }), NOW),
    "booking-not-active",
    "duplicate: a cancelled booking resolves it",
  );
  eq(
    handoffResolution(handoff(), booking({ status: "completed" }), NOW),
    "booking-not-active",
    "duplicate: a completed booking resolves it",
  );
  eq(
    handoffResolution(handoff(), booking({ startsAt: iso(NOW - MIN) }), NOW),
    "booking-started",
    "duplicate: a call that has started resolves it",
  );
  eq(
    handoffResolution(handoff(), booking({ startsAt: iso(NOW) }), NOW),
    "booking-started",
    "duplicate: a call starting this instant counts as started",
  );
  eq(
    handoffResolution(handoff(), booking({ startsAt: "not a time" }), NOW),
    null,
    "an unreadable start time resolves nothing (it stays open and keeps asking)",
  );
  eq(
    handoffResolution(handoff(), booking({ assignedUserId: "u-owner" }), NOW),
    null,
    "duplicate: the owner rule does not apply to a duplicate",
  );
  eq(handoffResolution(handoff(), undefined, NOW), null, "no booking row read resolves nothing");
}
{
  eq(handoffResolution(ownerHandoff(), booking(), NOW), null, "owner: still with another agent stays open");
  eq(
    handoffResolution(ownerHandoff(), booking({ assignedUserId: "u-owner" }), NOW),
    "assigned-to-requested-owner",
    "owner: now assigned to the requested owner resolves it",
  );
  eq(
    handoffResolution(ownerHandoff(), booking({ status: "cancelled" }), NOW),
    "booking-not-active",
    "owner: a cancelled booking resolves it",
  );
  eq(
    handoffResolution(ownerHandoff(), booking({ startsAt: iso(NOW - MIN) }), NOW),
    "booking-started",
    "owner: a started call resolves it",
  );
  eq(
    handoffResolution(
      ownerHandoff({ detail: { ...OWNER.detail, refusal: "owner-not-found", requestedOwnerUserId: null } }),
      booking({ assignedUserId: null }),
      NOW,
    ),
    null,
    "owner: an unknown owner never matches an unassigned booking (null is not a match)",
  );
  eq(
    handoffResolution(ownerHandoff({ detail: { nonsense: true } }), booking({ assignedUserId: "u-owner" }), NOW),
    null,
    "owner: a detail this code cannot read resolves nothing by owner",
  );
}

// --- the runner ---------------------------------------------------------------

interface World {
  open: OpenHandoff[] | Error;
  bookings: HandoffBooking[] | Error;
  channel: string | null | Error;
  postReply?: (text: string, n: number) => { ok: boolean; error?: string };
  resolveError?: Error;
  stampError?: Error;
}

function harness(world: World) {
  const calls = {
    loadOpenLimit: [] as number[],
    loadBookingsIds: [] as string[][],
    resolved: [] as { ids: string[]; reason: HandoffResolution }[],
    posts: [] as { channel: string; text: string }[],
    stamped: [] as string[],
    failures: [] as { id: string; attempts: number; reason: string }[],
    paged: [] as { key: string; text: string }[],
    cleared: [] as string[],
  };
  const deps: HandoffCheckDeps = {
    nowMs: NOW,
    loadOpen: async (limit) => {
      calls.loadOpenLimit.push(limit);
      if (world.open instanceof Error) throw world.open;
      return world.open;
    },
    loadBookings: async (ids) => {
      calls.loadBookingsIds.push(ids);
      if (world.bookings instanceof Error) throw world.bookings;
      return world.bookings;
    },
    loadChannel: async () => {
      if (world.channel instanceof Error) throw world.channel;
      return world.channel;
    },
    resolve: async (ids, reason) => {
      if (world.resolveError) throw world.resolveError;
      calls.resolved.push({ ids, reason });
    },
    post: async (channel, text) => {
      calls.posts.push({ channel, text });
      return world.postReply ? world.postReply(text, calls.posts.length) : { ok: true };
    },
    markNotified: async (id) => {
      if (world.stampError) throw world.stampError;
      calls.stamped.push(id);
    },
    recordNotifyFailure: async (id, attempts, reason) => {
      calls.failures.push({ id, attempts, reason });
    },
    bookingUrl: (id) => `https://slate.test/admin/bookings/${id}`,
    settingsUrl: "https://slate.test/admin/alerts",
    notify: async (key, _ms, text) => {
      calls.paged.push({ key, text });
    },
    clearAlert: async (key) => {
      calls.cleared.push(key);
    },
    cooldownMs: { channelUnset: 60 * MIN, undelivered: 60 * MIN },
  };
  return { deps, calls };
}

// Healthy delivery: posted once to the handoff channel, stamped, both pages clear.
{
  const { deps, calls } = harness({ open: [handoff()], bookings: [booking()], channel: "C-SALES" });
  const out = await runHandoffCheck(deps);
  eq(calls.loadOpenLimit, [OPEN_HANDOFF_READ_LIMIT], "the open rows are read once, with the named bound");
  eq(calls.loadBookingsIds, [["b1"]], "the bookings are read once, for exactly the ids the rows name");
  eq(calls.posts.length, 1, "one open unnotified row is posted once");
  eq(calls.posts[0]?.channel, "C-SALES", "to the handoff channel, not the alerts channel");
  eq(calls.stamped, ["h1"], "and stamped as notified after the post succeeded");
  eq(calls.failures.length, 0, "no failure is recorded for a successful post");
  eq(calls.paged.length, 0, "a healthy tick pages about nothing");
  eq(
    [...calls.cleared].sort(),
    [HANDOFF_CHANNEL_UNSET_KEY, HANDOFF_UNDELIVERED_KEY].sort(),
    "and clears both conditions, because it measured them healthy",
  );
  eq(out.posted, 1, "the result counts the post");
  eq(out.measured, true, "and says it measured");
}

// An already notified row is never posted again.
{
  const { deps, calls } = harness({
    open: [handoff({ notifiedAt: iso(NOW - 60 * MIN), createdAt: iso(NOW - 90 * MIN) })],
    bookings: [booking()],
    channel: "C-SALES",
  });
  await runHandoffCheck(deps);
  eq(calls.posts.length, 0, "a row already delivered is not posted a second time");
  eq(calls.paged.length, 0, "and a delivered row, however old, is not undelivered");
}

// Auto resolve: a resolved row is written resolved and NOT posted.
{
  const { deps, calls } = harness({
    open: [
      handoff({ id: "h-cancelled", bookingId: "b-cancelled" }),
      handoff({ id: "h-live", bookingId: "b-live" }),
      ownerHandoff({ id: "h-owner", bookingId: "b-owner" }),
    ],
    bookings: [
      booking({ id: "b-cancelled", status: "cancelled" }),
      booking({ id: "b-live" }),
      booking({ id: "b-owner", assignedUserId: "u-owner" }),
    ],
    channel: "C-SALES",
  });
  const out = await runHandoffCheck(deps);
  const byReason = Object.fromEntries(calls.resolved.map((r) => [r.reason, r.ids]));
  eq(byReason["booking-not-active"], ["h-cancelled"], "the cancelled booking's row is resolved");
  eq(byReason["assigned-to-requested-owner"], ["h-owner"], "the owner row is resolved once the owner holds it");
  eq(calls.resolved.length, 2, "one write per reason, not one per row");
  eq(calls.posts.map((p) => p.text.includes("Jordan Lee")).length, 1, "only the live row is posted");
  eq(calls.stamped, ["h-live"], "and only the live row is stamped");
  eq(out.resolved, 2, "the result counts the resolutions");
}

// A failed booking read resolves nothing, and delivers nothing it cannot describe.
{
  const { deps, calls } = harness({
    open: [handoff({ createdAt: iso(NOW - 45 * MIN) })],
    bookings: new Error("read failed [bookings]"),
    channel: "C-SALES",
  });
  const out = await runHandoffCheck(deps);
  eq(calls.resolved.length, 0, "a failed booking read resolves NOTHING");
  eq(calls.posts.length, 0, "and posts nothing, since it cannot say what the booking is");
  eq(out.bookingsReadable, false, "the result says the bookings were unreadable");
  assert(
    calls.paged.some((p) => p.key === HANDOFF_UNDELIVERED_KEY),
    "a row that has now waited past 30 minutes still pages: the wait is measured from the handoff itself",
  );
}

// The delivery cap: the rest wait for the next tick, oldest first.
{
  const open = Array.from({ length: HANDOFF_POSTS_PER_TICK + 4 }, (_, i) =>
    handoff({ id: `h${i}`, bookingId: `b${i}`, createdAt: iso(NOW - (20 - i) * MIN) }),
  );
  const { deps, calls } = harness({
    open,
    bookings: open.map((h) => booking({ id: h.bookingId })),
    channel: "C-SALES",
  });
  const out = await runHandoffCheck(deps);
  eq(calls.posts.length, HANDOFF_POSTS_PER_TICK, `no more than ${HANDOFF_POSTS_PER_TICK} posts in one tick`);
  eq(calls.stamped[0], "h0", "the oldest row goes first");
  eq(out.waitingToPost, 4, "and the result says how many are left for the next tick");
  assert(HANDOFF_POSTS_PER_TICK > 0 && HANDOFF_POSTS_PER_TICK <= 20, "the cap is a small positive number");
}

// A row that keeps failing does not stand in front of the others for ever.
{
  const open = [
    handoff({ id: "h-poison", bookingId: "b-poison", createdAt: iso(NOW - 25 * MIN), notifyAttempts: 3 }),
    handoff({ id: "h-fresh", bookingId: "b-fresh", createdAt: iso(NOW - 5 * MIN) }),
  ];
  const { deps, calls } = harness({
    open,
    bookings: open.map((h) => booking({ id: h.bookingId })),
    channel: "C-SALES",
  });
  await runHandoffCheck(deps);
  eq(calls.stamped[0], "h-fresh", "a row with fewer failed attempts is tried before one that keeps failing");
}

// A failed post records the attempt with a short reason, stamps nothing, and stops.
{
  const open = [handoff({ id: "hA", bookingId: "bA" }), handoff({ id: "hB", bookingId: "bB" })];
  const { deps, calls } = harness({
    open,
    bookings: open.map((h) => booking({ id: h.bookingId })),
    channel: "C-SALES",
    postReply: () => ({ ok: false, error: "channel_not_found" }),
  });
  const out = await runHandoffCheck(deps);
  eq(calls.stamped.length, 0, "a failed post stamps nothing, so the next tick retries it");
  eq(calls.failures.length, 1, "the attempt is recorded on the row that failed");
  eq(calls.failures[0]?.id, "hA", "on that row, not on one never attempted");
  eq(calls.failures[0]?.attempts, 1, "and the attempt count goes up by one");
  eq(calls.failures[0]?.reason, "channel_not_found", "with Slack's short reason");
  eq(calls.posts.length, 1, "delivery stops at the first failure rather than spending the budget on more");
  eq(out.postFailed, 1, "the result counts the failure");
  assert(
    !calls.cleared.includes(HANDOFF_UNDELIVERED_KEY) || out.undelivered === 0,
    "clearing the undelivered page is only ever done with nothing undelivered",
  );
}
{
  const longBody = `upstream said ${"x".repeat(50)} ${"word ".repeat(80)}\nsecond line`;
  const { deps, calls } = harness({
    open: [handoff()],
    bookings: [booking()],
    channel: "C-SALES",
    postReply: () => ({ ok: false, error: longBody }),
  });
  await runHandoffCheck(deps);
  const reason = calls.failures[0]?.reason ?? "";
  assert(reason.length > 0 && reason.length < 200, `a long error is stored short (got ${reason.length} chars)`);
  assert(!reason.includes("\n"), "and on one line");
}

// A stamp that fails after a successful post stops delivery (the next tick would
// post everything after it twice).
{
  const open = [handoff({ id: "hA", bookingId: "bA" }), handoff({ id: "hB", bookingId: "bB" })];
  const { deps, calls } = harness({
    open,
    bookings: open.map((h) => booking({ id: h.bookingId })),
    channel: "C-SALES",
    stampError: new Error("write failed"),
  });
  const out = await runHandoffCheck(deps);
  eq(calls.posts.length, 1, "delivery stops once a stamp cannot be written");
  eq(out.stampFailed, 1, "and the result says a posted row is unstamped");
}

// An unset channel pages the alerts channel, and clears only on a measured result.
{
  const open = [handoff({ id: "hA", bookingId: "bA" }), handoff({ id: "hB", bookingId: "bB" })];
  const unset = harness({ open, bookings: open.map((h) => booking({ id: h.bookingId })), channel: null });
  const out = await runHandoffCheck(unset.deps);
  eq(unset.calls.posts.length, 0, "nothing is posted with no channel");
  const page = unset.calls.paged.find((p) => p.key === HANDOFF_CHANNEL_UNSET_KEY);
  assert(Boolean(page), "open rows with no handoff channel page the alerts channel");
  assert(/\b2\b/.test(page?.text ?? ""), `the page says how many are waiting (got: ${page?.text})`);
  assert(!unset.calls.cleared.includes(HANDOFF_CHANNEL_UNSET_KEY), "and does not clear in the same tick");
  eq(out.channel, "unset", "the result says the channel is unset");

  // Later: the channel is set. That is a measured healthy result and clears it.
  const set = harness({ open, bookings: open.map((h) => booking({ id: h.bookingId })), channel: "C-SALES" });
  await runHandoffCheck(set.deps);
  assert(set.calls.cleared.includes(HANDOFF_CHANNEL_UNSET_KEY), "setting the channel clears the page");

  // Nothing waiting, channel still unset: also healthy, since nobody is waiting.
  const empty = harness({ open: [], bookings: [], channel: null });
  await runHandoffCheck(empty.deps);
  assert(empty.calls.cleared.includes(HANDOFF_CHANNEL_UNSET_KEY), "no open rows at all clears it too");
  eq(empty.calls.loadBookingsIds.length, 0, "and no booking read is spent on nothing");

  // An unreadable setting is NOT unset and NOT set: it neither pages nor clears.
  const unreadable = harness({
    open,
    bookings: open.map((h) => booking({ id: h.bookingId })),
    channel: new Error("read failed [monitor_alert_config]"),
  });
  const u = await runHandoffCheck(unreadable.deps);
  assert(
    !unreadable.calls.paged.some((p) => p.key === HANDOFF_CHANNEL_UNSET_KEY),
    "an unreadable channel setting does not page as unset",
  );
  assert(
    !unreadable.calls.cleared.includes(HANDOFF_CHANNEL_UNSET_KEY),
    "and does not clear the unset page either",
  );
  eq(unreadable.calls.posts.length, 0, "and posts nothing, since it does not know where to");
  eq(u.channel, "unreadable", "the result says it could not read the setting");
}

// Undelivered past 30 minutes pages; a measured clean tick clears.
{
  const stale = handoff({ createdAt: iso(NOW - HANDOFF_UNDELIVERED_AFTER_MS - MIN), notifyAttempts: 4 });
  const failing = harness({
    open: [stale],
    bookings: [booking()],
    channel: "C-SALES",
    postReply: () => ({ ok: false, error: "rate_limited" }),
  });
  const out = await runHandoffCheck(failing.deps);
  const page = failing.calls.paged.find((p) => p.key === HANDOFF_UNDELIVERED_KEY);
  assert(Boolean(page), "a row unnotified for more than 30 minutes pages");
  assert(!failing.calls.cleared.includes(HANDOFF_UNDELIVERED_KEY), "and does not clear in the same tick");
  eq(out.undelivered, 1, "the result counts it");

  const young = harness({
    open: [handoff({ createdAt: iso(NOW - HANDOFF_UNDELIVERED_AFTER_MS + MIN) })],
    bookings: [booking()],
    channel: "C-SALES",
    postReply: () => ({ ok: false, error: "rate_limited" }),
  });
  await runHandoffCheck(young.deps);
  assert(
    !young.calls.paged.some((p) => p.key === HANDOFF_UNDELIVERED_KEY),
    "a row under 30 minutes old does not page yet",
  );

  // Delivered this tick: no longer undelivered, so a stale-but-now-posted row clears.
  const delivered = harness({ open: [stale], bookings: [booking()], channel: "C-SALES" });
  await runHandoffCheck(delivered.deps);
  assert(
    !delivered.calls.paged.some((p) => p.key === HANDOFF_UNDELIVERED_KEY),
    "a row delivered in this tick is not reported as undelivered",
  );
  assert(delivered.calls.cleared.includes(HANDOFF_UNDELIVERED_KEY), "and the page clears");

  // An unreadable created_at is the fail safe side: treated as waiting too long.
  const unreadableAge = harness({
    open: [handoff({ createdAt: "garbage" })],
    bookings: [booking()],
    channel: "C-SALES",
    postReply: () => ({ ok: false, error: "rate_limited" }),
  });
  await runHandoffCheck(unreadableAge.deps);
  assert(
    unreadableAge.calls.paged.some((p) => p.key === HANDOFF_UNDELIVERED_KEY),
    "a row whose age cannot be read pages rather than reading as fresh",
  );

  // With no channel set, the unset page carries it: one cause, one page (L36).
  const unsetStale = harness({ open: [stale], bookings: [booking()], channel: null });
  await runHandoffCheck(unsetStale.deps);
  eq(
    unsetStale.calls.paged.map((p) => p.key),
    [HANDOFF_CHANNEL_UNSET_KEY],
    "an unset channel pages once, not once for the channel and again for the wait",
  );
  assert(
    !unsetStale.calls.cleared.includes(HANDOFF_UNDELIVERED_KEY),
    "and the undelivered page is not cleared while rows are in fact undelivered",
  );
}

// A truncated read cannot clear anything: an unseen row may be the stale one.
{
  const open = Array.from({ length: OPEN_HANDOFF_READ_LIMIT }, (_, i) =>
    handoff({ id: `h${i}`, bookingId: `b${i}`, notifiedAt: iso(NOW - MIN) }),
  );
  const { deps, calls } = harness({ open, bookings: open.map((h) => booking({ id: h.bookingId })), channel: "C-SALES" });
  const out = await runHandoffCheck(deps);
  eq(out.truncated, true, "a read that filled its bound says it was truncated");
  assert(!calls.cleared.includes(HANDOFF_UNDELIVERED_KEY), "and does not clear the undelivered page");
}

// A failed resolve write does not deliver a situation measured as over.
{
  const { deps, calls } = harness({
    open: [handoff()],
    bookings: [booking({ status: "cancelled" })],
    channel: "C-SALES",
    resolveError: new Error("write failed"),
  });
  const out = await runHandoffCheck(deps);
  eq(calls.posts.length, 0, "a row measured resolved is not posted even when the resolve write failed");
  eq(out.resolved, 0, "and is not counted as resolved");
}

// The step never throws the lane, and an unreadable worklist says nothing at all.
{
  const { deps, calls } = harness({
    open: new Error("PostgREST down"),
    bookings: new Error("down"),
    channel: new Error("down"),
  });
  let threw = false;
  let out: Awaited<ReturnType<typeof runHandoffCheck>> | null = null;
  try {
    out = await runHandoffCheck(deps);
  } catch {
    threw = true;
  }
  eq(threw, false, "a throwing read does not throw out of the check");
  eq(out?.measured, false, "it reports the tick as unmeasured");
  eq(calls.paged.length, 0, "it pages nothing");
  eq(calls.cleared.length, 0, "and clears nothing, because it learned nothing");
}
{
  const { deps } = harness({ open: [handoff()], bookings: [booking()], channel: "C-SALES" });
  let threw = false;
  try {
    await runHandoffCheck({
      ...deps,
      post: async () => {
        throw new Error("fetch exploded");
      },
      recordNotifyFailure: async () => {
        throw new Error("and so did the write");
      },
      notify: async () => {
        throw new Error("alert dispatch down");
      },
      clearAlert: async () => {
        throw new Error("alert dispatch down");
      },
    });
  } catch {
    threw = true;
  }
  eq(threw, false, "throwing post, failure write and alert dispatch do not throw out of the check");
}

// --- copy -------------------------------------------------------------------------

const DASHES = /[\u2012\u2013\u2014\u2015]| - /;
{
  const b = booking();
  const url = "https://slate.test/admin/bookings/b1";
  const texts = [
    formatHandoffNotice({ kind: "duplicate-unresolved", detail: DUP.detail }, b, url),
    formatHandoffNotice(
      {
        kind: "duplicate-unresolved",
        detail: { finding: "no-other-call", weakerMatch: "phone-only", laterBookingStartsAt: iso(NOW + 2 * 24 * 60 * MIN) },
      },
      b,
      url,
    ),
    formatHandoffNotice(
      { kind: "duplicate-unresolved", detail: { finding: "named-is-newest", weakerMatch: null, laterBookingStartsAt: null } },
      b,
      url,
    ),
    formatHandoffNotice(
      { kind: "duplicate-unresolved", detail: { finding: "identity-conflict", weakerMatch: null, laterBookingStartsAt: null } },
      b,
      url,
    ),
    formatHandoffNotice({ kind: "owner-reassign-refused", detail: OWNER.detail }, b, url),
    formatHandoffNotice(
      { kind: "owner-reassign-refused", detail: { ...OWNER.detail, refusal: "owner-on-time-off" } },
      b,
      url,
    ),
    formatHandoffNotice(
      { kind: "owner-reassign-refused", detail: { ...OWNER.detail, refusal: "owner-not-found", requestedOwnerUserId: null } },
      b,
      url,
    ),
    formatHandoffNotice({ kind: "duplicate-unresolved", detail: { garbage: 1 } }, booking({ attendeeName: null }), url),
    formatHandoffChannelUnsetAlert({ waiting: 3, oldestWaitMs: 50 * MIN, settingsUrl: "https://slate.test/admin/alerts" }),
    formatHandoffUndeliveredAlert({
      count: 1,
      oldestWaitMs: 95 * MIN,
      thresholdMs: HANDOFF_UNDELIVERED_AFTER_MS,
      lastError: "channel_not_found",
      settingsUrl: "https://slate.test/admin/alerts",
    }),
  ];
  for (const t of texts) {
    assert(t.trim().length > 0, "every handoff message renders text");
    assert(!DASHES.test(t), `no dash used as punctuation: ${t}`);
    assert(!/manage|token/i.test(t), `no manage link or token: ${t}`);
    assert(!/undefined|NaN|null|\[object/.test(t), `nothing leaks: ${t}`);
    assert(!/probably|cal\.com/i.test(t), `no guess about where the other call is: ${t}`);
  }
  for (const t of texts.slice(0, 8)) {
    assert(t.includes(url), `a handoff links the admin booking page: ${t}`);
  }
  assert(texts[0].includes("Jordan Lee"), "a notice names the lead");
  assert(texts[1].includes("phone"), "a weaker match found is stated as what it is");
  assert(texts[7].includes("A lead") || texts[7].includes("a lead"), "a redacted name reads as a lead, not a blank");
  assert(texts[4].includes("owner@trypennie.com"), "an owner refusal names the requested owner");
  assert(texts[5] !== texts[4], "each refusal reason reads differently");
  assert(texts[6] !== texts[4], "including an owner Slate has no account for");
}

finish();
