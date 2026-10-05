// A calendar Google has refused for good, and whose owner has LEFT, is a departure
// rather than an account to fix (#1630).
//
// What happened on 2026-10-05: an advisor was deactivated, the offboarding sweep
// moved four of their calls, and each move queued a deletion of the old invite on
// their calendar. Their Google licence was already gone, so every delete came back
// `403 notACalendarUser`, and the page said "Never given Google Calendar: a
// Workspace admin has to give this account Calendar" about somebody who had left
// three minutes earlier. It named 1 of the 4 invites, because each pass spent a
// Google call per row only to reach the same answer, and alerted on its own.
//
// Three things are pinned here, each with the control that keeps it honest:
//
//   1. the drain settles the rest of a refused calendar's queue in the SAME pass,
//      with no Google call per row, through the same holder check every row gets;
//   2. `describeRefusedDeletions` learns who each refused calendar belongs to, and
//      a failed read of that is an explicit unknown, never "active" or "departed";
//   3. the copy splits on it: a departed owner gets the departure wording and
//      never a remedy, an active or unknown owner gets today's page unchanged.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pending-deletion-departed.ts
import {
  describeRefusedDeletions,
  processPendingEventDeletions,
  PENDING_DELETION_GIVE_UP_AT,
  type RefusedEventDeletion,
} from "../src/lib/booking/orchestration.ts";
import {
  pendingDeletionDepartedNotice,
  pendingDeletionRefusedAlert,
  refusedDeletionNotices,
  type CalendarOwnerForAlert,
  type RefusedDeletionForAlert,
} from "../src/lib/booking/alert-copy.ts";
import {
  GONE,
  NOT_PROVISIONED,
  TRANSIENT,
  pendingDeletionQueue as queue,
  pendingRow as row,
} from "./lib/pending-deletion-queue.ts";
import { makeDeps } from "./lib/booking-fakes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// =================================================================================
// 1. The rest of a refused calendar's queue settles in the same pass
// =================================================================================

// --- the page: one Google call for the calendar, every row refused ---------------
{
  const q = queue(
    [row("a1", "left@x.com", "evt-1"), row("a2", "left@x.com", "evt-2"), row("a3", "left@x.com", "evt-3")],
    () => NOT_PROVISIONED(),
  );
  const res = await processPendingEventDeletions(q.deps, 50);

  eq(q.deletes.length, 1, "page: Google is asked once for a calendar it refused for good, not once per row");
  eq(res.refused.length, 3, "page: every row of the refused calendar is reported, so the message can count them all");
  eq(
    res.refused.map((r) => r.kind).join(","),
    "not-provisioned,not-provisioned,not-provisioned",
    "page: each settled row carries the kind the calendar was refused with",
  );
  eq(res.failed, 3, "page: every page row still counts toward the page the drain loaded (#888)");
  eq(res.stuck.length, 0, "page: none is stuck");
  for (const id of ["a1", "a2", "a3"]) {
    eq(q.table.get(id)?.attempts, PENDING_DELETION_GIVE_UP_AT, `page: ${id} is settled at the give-up count`);
    assert(q.table.has(id), `page: ${id} stays in the table as the record of the orphaned event`);
  }
  const sibling = q.table.get("a2")?.last_error ?? "";
  assert(sibling.startsWith("not-provisioned"), `page: a settled row's last_error names the kind, got "${sibling}"`);
  assert(
    /not attempted/i.test(sibling),
    `page: a settled row's last_error says it was not itself tried, so the record claims only what was measured, got "${sibling}"`,
  );
  assert(
    (q.table.get("a1")?.last_error ?? "").includes("403"),
    "page: the row that WAS tried keeps Google's message for forensics, as before",
  );

  await processPendingEventDeletions(q.deps, 50);
  eq(q.deletes.length, 1, "page: a second pass retries none of them");
}

// --- the CONTROL: another calendar in the same pass still gets its own call -------
// Without this, a change that ended every row after the first refusal would pass
// the case above while ending rows Google never refused (L1).
{
  const q = queue(
    [
      row("b1", "left@x.com", "evt-b1"),
      row("b2", "fine@x.com", "evt-b2"),
      row("b3", "left@x.com", "evt-b3"),
      row("b4", "ok@x.com", "evt-b4"),
    ],
    (email) => (email === "left@x.com" ? GONE() : email === "fine@x.com" ? TRANSIENT() : null),
  );
  const res = await processPendingEventDeletions(q.deps, 50);
  eq(q.deletes.sort().join(","), "evt-b1,evt-b2,evt-b4", "control: each other calendar is still asked about its own row");
  eq(res.deleted, 1, "control: the reachable calendar's row is deleted");
  eq(res.refused.map((r) => r.row.id).sort().join(","), "b1,b3", "control: only the refused calendar's rows are refused");
  eq(q.table.get("b2")?.attempts, 1, "control: a transient row on another calendar keeps its ordinary retry");
}

// --- the CONTROL: a transient failure settles nothing else ------------------------
{
  const q = queue(
    [row("c1", "blip@x.com", "evt-c1"), row("c2", "blip@x.com", "evt-c2"), row("c3", "blip@x.com", "evt-c3")],
    () => TRANSIENT(),
  );
  const res = await processPendingEventDeletions(q.deps, 50);
  eq(q.deletes.length, 3, "transient: every row of a calendar that only blipped is still tried");
  eq(res.refused.length, 0, "transient: nothing is refused");
  eq(q.calendarReads.length, 0, "transient: the calendar's other rows are not read, since nothing was refused");
  for (const id of ["c1", "c2", "c3"]) eq(q.table.get(id)?.attempts, 1, `transient: ${id} advances by one attempt`);
}

// --- a row a live booking now holds is dropped, never recorded as orphaned --------
// #3215 (L744): the holder check runs before anything else, for a settled row too.
// A row whose event a live booking holds is not an invite Slate failed to remove.
{
  const q = queue(
    [row("d1", "left@x.com", "evt-d1"), row("d2", "left@x.com", "evt-d2"), row("d3", "left@x.com", "evt-d3")],
    () => NOT_PROVISIONED(),
    { holders: new Map([["evt-d2", "bk-live"]]) },
  );
  const res = await processPendingEventDeletions(q.deps, 50);
  eq(res.refused.map((r) => r.row.id).join(","), "d1,d3", "holder: the held row is not refused");
  eq(res.held, 1, "holder: it is counted as held, as it always was");
  assert(!q.table.has("d2"), "holder: the obsolete row is removed, as before");
  eq(q.deletes.length, 1, "holder: still one Google call for the calendar");
}

// --- rows past the page settle in the same pass, through the same rules -----------
{
  const q = queue(
    [
      row("e1", "left@x.com", "evt-e1"),
      row("e2", "left@x.com", "evt-e2"),
      row("e3", "left@x.com", "evt-e3"),
      row("e4", "left@x.com", "evt-e4"),
    ],
    () => NOT_PROVISIONED(),
    { holders: new Map([["evt-e4", "bk-live"]]) },
  );
  const res = await processPendingEventDeletions(q.deps, 1);
  eq(q.deletes.length, 1, "beyond: one Google call, even with the calendar's rows past the page");
  eq(
    res.refused.map((r) => r.row.id).join(","),
    "e1,e2,e3",
    "beyond: the rows past the page are refused too, so the message counts every one",
  );
  eq(res.failed, 1, "beyond: only the page row counts in failed, so the saturation reading stays the page size (#888)");
  eq(res.held, 0, "beyond: a row past the page is not counted in the page's held either");
  eq(res.beyondPage, 3, "beyond: the pass says how many rows it settled past the page");
  assert(!q.table.has("e4"), "beyond: a held row past the page is dropped by the same holder check");
  eq(q.calendarReads.map((r) => r.email).join(","), "left@x.com", "beyond: the refused calendar's rows are read once");
  eq(q.table.get("e3")?.attempts, PENDING_DELETION_GIVE_UP_AT, "beyond: a row past the page is settled at the give-up count");
}

// --- the read past the page is bounded ---------------------------------------------
{
  const rows = Array.from({ length: 6 }, (_, i) => row(`f${i}`, "left@x.com", `evt-f${i}`));
  const q = queue(rows, () => NOT_PROVISIONED());
  const res = await processPendingEventDeletions(q.deps, 1, { siblingLimit: 2 });
  eq(res.refused.length, 3, "bound: the page row plus at most siblingLimit rows past it");
  eq(res.beyondPage, 2, "bound: siblingLimit caps the rows settled past the page");
  eq(
    [...q.table.values()].filter((r) => r.attempts === 0).length,
    3,
    "bound: the rest wait for a later pass, untouched",
  );
}

// --- a failed read past the page keeps the page's result ----------------------------
{
  const q = queue(
    [row("g1", "left@x.com", "evt-g1"), row("g2", "left@x.com", "evt-g2")],
    () => NOT_PROVISIONED(),
    { calendarReadFails: true },
  );
  const res = await processPendingEventDeletions(q.deps, 1);
  eq(res.refused.map((r) => r.row.id).join(","), "g1", "read fails: the page's refusal is still reported");
  eq(res.beyondPage, 0, "read fails: nothing past the page was settled");
  eq(q.table.get("g2")?.attempts, 0, "read fails: the row past the page is left for a later pass, untouched");
}

// =================================================================================
// 2. Who a refused calendar belongs to
// =================================================================================

function refusedOf(id: string, email: string, eventId: string, bookingId: string | null, kind: RefusedEventDeletion["kind"] = "not-provisioned"): RefusedEventDeletion {
  return { row: row(id, email, eventId, PENDING_DELETION_GIVE_UP_AT, bookingId), kind };
}

const LEFT_AT = "2026-10-05T14:43:27.000Z";

function factsDeps(over: {
  owners?: (emails: readonly string[]) => Promise<{ id: string; email: string; name: string | null; deactivated_at: string | null }[]>;
  bookings?: (ids: readonly string[]) => Promise<{ id: string; assigned_user_id: string | null; status: "confirmed" | "rescheduled" | "cancelled" | "completed" }[]>;
}) {
  const asked = { owners: [] as string[][], bookings: [] as string[][] };
  const { deps } = makeDeps({});
  deps.loadCalendarOwners = async (emails) => {
    asked.owners.push([...emails]);
    return over.owners ? over.owners(emails) : [];
  };
  deps.loadBookingAssignees = async (ids) => {
    asked.bookings.push([...ids]);
    return over.bookings ? over.bookings(ids) : [];
  };
  return { deps, asked };
}

const OWNERS = async () => [
  { id: "u-left", email: "left@x.com", name: "Jane Doe", deactivated_at: LEFT_AT },
  { id: "u-new", email: "new@x.com", name: "New Hire", deactivated_at: null },
];

// --- a departed owner, and where each of their calls went ---------------------------
{
  const { deps, asked } = factsDeps({
    owners: OWNERS,
    bookings: async () => [
      { id: "bk-1", assigned_user_id: "u-other", status: "confirmed" },
      { id: "bk-2", assigned_user_id: "u-left", status: "confirmed" },
      { id: "bk-3", assigned_user_id: "u-other", status: "cancelled" },
    ],
  });
  const refused = [
    refusedOf("r1", "left@x.com", "evt-1", "bk-1"),
    refusedOf("r2", "left@x.com", "evt-2", "bk-2"),
    refusedOf("r3", "left@x.com", "evt-3", "bk-3"),
    refusedOf("r4", "left@x.com", "evt-4", null),
    refusedOf("r5", "new@x.com", "evt-5", "bk-5"),
  ];
  const facts = await describeRefusedDeletions(deps, refused);
  assert(facts.owners !== null, "facts: the owner read landed");
  eq(facts.owners?.get("left@x.com"), { name: "Jane Doe", deactivatedAt: LEFT_AT }, "facts: the departed owner carries when they left");
  eq(facts.owners?.get("new@x.com"), { name: "New Hire", deactivatedAt: null }, "facts: an active owner carries no departure");
  eq(asked.owners, [["left@x.com", "new@x.com"]], "facts: the owners are read once, by distinct address");
  eq(asked.bookings, [["bk-1", "bk-2", "bk-3"]], "facts: only the departed owner's calls are looked up");
  const moved = new Map(facts.rows.map((r) => [r.eventId, r.movedToAnotherAdvisor]));
  eq(moved.get("evt-1"), true, "facts: a live call now with somebody else was moved");
  eq(moved.get("evt-2"), false, "facts: a call still with the departed owner was not moved");
  eq(moved.get("evt-3"), false, "facts: a cancelled call was not moved");
  eq(moved.get("evt-4"), false, "facts: an invite with no booking behind it was not a moved call");
  eq(moved.get("evt-5") ?? null, null, "facts: an active owner's rows carry no move claim");
  eq(facts.rows.map((r) => r.kind).join(","), refused.map((r) => r.kind).join(","), "facts: every row keeps its kind");
}

// --- a failed owner read is an explicit unknown --------------------------------------
{
  const { deps, asked } = factsDeps({
    owners: async () => {
      throw new Error("users read: canceling statement due to statement timeout");
    },
  });
  const facts = await describeRefusedDeletions(deps, [refusedOf("s1", "left@x.com", "evt-1", "bk-1")]);
  eq(facts.owners, null, "unread owner: the owners are unknown, never an empty map that reads as nobody departed");
  eq(asked.bookings.length, 0, "unread owner: no call is looked up for an owner nobody could read");
  eq(facts.rows[0]?.movedToAnotherAdvisor ?? null, null, "unread owner: no move is claimed");
}

// --- a failed booking read keeps the departure and claims no move ---------------------
{
  const { deps } = factsDeps({
    owners: OWNERS,
    bookings: async () => {
      throw new Error("bookings read: connection reset");
    },
  });
  const facts = await describeRefusedDeletions(deps, [refusedOf("t1", "left@x.com", "evt-1", "bk-1")]);
  eq(facts.owners?.get("left@x.com")?.deactivatedAt, LEFT_AT, "unread calls: the departure is still known");
  eq(facts.rows[0]?.movedToAnotherAdvisor, null, "unread calls: whether the call moved is unknown, not false");
}

// --- an address two users answer to belongs to nobody we can name (L521) --------------
{
  const { deps } = factsDeps({
    owners: async () => [
      { id: "u-1", email: "dup@x.com", name: "One", deactivated_at: LEFT_AT },
      { id: "u-2", email: "dup@x.com", name: "Two", deactivated_at: null },
    ],
  });
  const facts = await describeRefusedDeletions(deps, [refusedOf("u1", "dup@x.com", "evt-1", null)]);
  assert(facts.owners !== null, "ambiguous: the read itself landed");
  eq(facts.owners?.has("dup@x.com"), false, "ambiguous: an address matching two users names no owner");
}

// --- the address is looked up the way users stores it ----------------------------------
{
  const { deps, asked } = factsDeps({ owners: OWNERS });
  const facts = await describeRefusedDeletions(deps, [refusedOf("v1", " Left@X.com", "evt-1", null)]);
  eq(asked.owners, [["left@x.com"]], "case: a mixed case calendar address is looked up normalised (#1663)");
  eq(facts.owners?.get("left@x.com")?.deactivatedAt, LEFT_AT, "case: and its owner is found");
}

// =================================================================================
// 3. The copy splits on it
// =================================================================================

const OWNER_MAP = new Map<string, CalendarOwnerForAlert>([
  ["left@x.com", { name: "Jane Doe", deactivatedAt: LEFT_AT }],
  ["new@x.com", { name: "New Hire", deactivatedAt: null }],
]);

function alertRows(email: string, n: number, moved: boolean | null, kind: RefusedDeletionForAlert["kind"] = "not-provisioned"): RefusedDeletionForAlert[] {
  return Array.from({ length: n }, (_, i) => ({ calendarEmail: email, eventId: `evt-${email[0]}${i + 1}`, kind, movedToAnotherAdvisor: moved }));
}

// --- an active or unknown owner gets today's page, word for word ----------------------
{
  const active = alertRows("new@x.com", 2, null);
  const split = refusedDeletionNotices(active, OWNER_MAP);
  eq(split.page, pendingDeletionRefusedAlert(active), "active: the page is today's page, unchanged");
  eq(split.departed, null, "active: no departure notice");

  const unread = alertRows("left@x.com", 2, null);
  const fallback = refusedDeletionNotices(unread, null);
  eq(fallback.page, pendingDeletionRefusedAlert(unread), "unread owners: a departed calendar falls back to today's page");
  eq(fallback.departed, null, "unread owners: the departure wording is never used on an unknown");
  assert((fallback.page ?? "").includes("Workspace admin"), "unread owners: the page keeps its remedy");

  const unknown = refusedDeletionNotices(alertRows("stranger@x.com", 1, null), OWNER_MAP);
  assert(unknown.page !== null && unknown.departed === null, "no users row: the page, since nobody is known to have left");
}

// --- a departed owner gets the departure, never a remedy -------------------------------
{
  const left = alertRows("left@x.com", 4, true);
  const split = refusedDeletionNotices(left, OWNER_MAP);
  eq(split.page, null, "departed: no page, since nobody can act on it");
  const text = split.departed ?? "";
  assert(text.includes("Jane Doe") && text.includes("left@x.com"), `departed: names who left, got "${text}"`);
  assert(text.includes("left on Mon, Oct 5 at 10:43am ET"), `departed: says when, in ET, got "${text}"`);
  assert(/no longer has Google Calendar/.test(text), `departed: says why the invites cannot be removed, got "${text}"`);
  assert(text.includes("4 old invites"), `departed: counts every invite, got "${text}"`);
  assert(text.includes("All 4 calls were moved to other advisors"), `departed: says the calls were moved, got "${text}"`);
  assert(text.includes("No account needs fixing"), `departed: says no account needs fixing, got "${text}"`);
  assert(!/Workspace admin|re-authenticate|out of the pool|Never given/i.test(text), `departed: carries neither remedy, got "${text}"`);
  assert(text.includes("pending_event_deletions"), "departed: says where the record is");
  assert(text.includes("evt-l1, evt-l2, evt-l3 and 1 more"), `departed: names event ids, capped, got "${text}"`);

  const gone = refusedDeletionNotices(alertRows("left@x.com", 1, true, "gone"), OWNER_MAP);
  assert(gone.departed !== null && gone.page === null, "departed: any definitive kind counts for an owner who left, not only not-provisioned");
}

// --- a mix sends both, each about its own calendars --------------------------------------
{
  const mix = [...alertRows("left@x.com", 2, true), ...alertRows("new@x.com", 1, null)];
  const split = refusedDeletionNotices(mix, OWNER_MAP);
  assert(split.page !== null && split.departed !== null, "mix: a page and a departure notice");
  eq(split.page, pendingDeletionRefusedAlert(alertRows("new@x.com", 1, null)), "mix: the page is today's page about the active calendar alone");
  assert(!(split.page ?? "").includes("left@x.com"), "mix: the page does not name the departed calendar");
  assert(!(split.departed ?? "").includes("new@x.com"), "mix: the departure notice does not name the active calendar");
}

// --- the move sentence says only what is true ---------------------------------------------
{
  const one = (rows: RefusedDeletionForAlert[]) => refusedDeletionNotices(rows, OWNER_MAP).departed ?? "";
  const single = one(alertRows("left@x.com", 1, true));
  assert(single.includes("the old invite"), `moves: one invite reads singular, got "${single}"`);
  assert(single.includes("The call was moved to another advisor"), `moves: one moved call, got "${single}"`);
  assert(single.includes("event id evt-l1"), `moves: singular event id label, got "${single}"`);
  assert(one(alertRows("left@x.com", 2, true)).includes("Both calls were moved to other advisors"), "moves: two moved calls");
  const partial = one([...alertRows("left@x.com", 3, true), { calendarEmail: "left@x.com", eventId: "evt-x", kind: "not-provisioned", movedToAnotherAdvisor: false }]);
  assert(partial.includes("3 of the 4 calls were moved to other advisors"), `moves: some moved, got "${partial}"`);
  const oneOf = one([...alertRows("left@x.com", 1, true), ...alertRows("left@x.com", 1, false)]);
  assert(oneOf.includes("1 of the 2 calls was moved to another advisor"), `moves: one of several moved, got "${oneOf}"`);
  const none = one(alertRows("left@x.com", 2, false));
  assert(!/moved/.test(none), `moves: nothing moved claims nothing, got "${none}"`);
  const unread = one(alertRows("left@x.com", 2, null));
  assert(!/moved/.test(unread), `moves: an unread move claims nothing, got "${unread}"`);

  const nameless = pendingDeletionDepartedNotice([
    { calendarEmail: "left@x.com", name: null, deactivatedAt: LEFT_AT, events: [{ eventId: "evt-1", movedToAnotherAdvisor: true }] },
  ]);
  assert(nameless.startsWith("left@x.com left on"), `moves: a person with no name is named by address, got "${nameless}"`);
}

// --- several people who left -----------------------------------------------------------------
{
  const two = pendingDeletionDepartedNotice([
    {
      calendarEmail: "left@x.com",
      name: "Jane Doe",
      deactivatedAt: LEFT_AT,
      events: [1, 2, 3, 4].map((i) => ({ eventId: `evt-${i}`, movedToAnotherAdvisor: true })),
    },
    {
      calendarEmail: "gone@x.com",
      name: "Bob Roe",
      deactivatedAt: "2026-10-04T19:10:00.000Z",
      events: [{ eventId: "evt-9", movedToAnotherAdvisor: false }],
    },
  ]);
  assert(two.startsWith("2 people who have left"), `several: counts the people, got "${two}"`);
  assert(two.includes("their accounts no longer have Google Calendar"), `several: plural reason, got "${two}"`);
  assert(two.includes("Jane Doe (left@x.com) left on Mon, Oct 5 at 10:43am ET"), `several: each person and when, got "${two}"`);
  assert(two.includes("Bob Roe (gone@x.com) left on Sun, Oct 4 at 3:10pm ET"), `several: the second person, got "${two}"`);
  assert(two.includes("all 4 calls were moved to other advisors"), `several: per person moves, got "${two}"`);
  assert(two.includes("Each row stays"), "several: plural record sentence");

  const all = [
    two,
    pendingDeletionDepartedNotice([{ calendarEmail: "left@x.com", name: "Jane Doe", deactivatedAt: LEFT_AT, events: [{ eventId: "e", movedToAnotherAdvisor: null }] }]),
    refusedDeletionNotices(alertRows("left@x.com", 4, true), OWNER_MAP).departed ?? "",
  ];
  for (const text of all) {
    assert(text.length > 0, "copy: rendered");
    assert(!/^\s*Slate\b/i.test(text), `copy: does not open with the word Slate, got "${text}"`);
    assert(!/undefined|NaN|\[object Object\]|null/.test(text), `copy: nothing leaks, got "${text}"`);
    assert(!text.includes("(s)"), "copy: no lazy plural");
    assert(!new RegExp("[\\u2013\\u2014]").test(text), "copy: no dashes as punctuation");
    assert(!/\b403\b|notACalendarUser|\{"error"/.test(text), `copy: no raw Google error, got "${text}"`);
  }
}

finish();
