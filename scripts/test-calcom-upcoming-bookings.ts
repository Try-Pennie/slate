// Reading every upcoming cal.com booking in the org (#2933). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-calcom-upcoming-bookings.ts
//
// The cross system double booking check holds this list against Slate's upcoming
// bookings, so a short list would clear a real page and read as "nobody is booked
// twice". What this file pins:
//  - every page is read, at the size cal.com allows (250, measured 2026-10-01: 500
//    answers 400), and the read stops on a short page, never on cal.com's own
//    pagination block, which was measured reporting `totalItems: 1` beside twenty
//    rows on the same day;
//  - every request asks for `status=upcoming`: the same listing without it timed
//    out at 125 seconds with a 524 on 2026-10-01;
//  - a refused page, a body that is not a list, a row with no id, uid or start, and
//    a read that runs past its page budget are each REFUSED by name, never returned
//    as the rows read so far (L98, L211);
//  - the row is reduced to what the comparison needs: the submission id
//    (`metadata.sfdc_submission_id`, measured on 2026-10-01 to be the field the
//    known duplicate shares with Slate) and the attendee addresses, lower cased;
//  - a row read twice across a page boundary is counted once.
import {
  CALCOM_BOOKINGS_API_VERSION,
  CALCOM_BOOKINGS_PAGE_SIZE,
  CALCOM_BOOKINGS_PAGE_TIMEOUT_MS,
  readCalcomBookingByUid,
  readUpcomingCalcomBookings,
  readCalcomBookingsCreated,
  readCalcomListedBookingByUid,
  phoneKey,
  followRescheduleChains,
  CALCOM_WINDOW_PAGE_TIMEOUT_MS,
  type CalcomListedRead,
  type CalcomListedByUidRead,
  type CalcomListedBooking,
  type CalcomBookingRead,
  type CalcomUpcomingRead,
} from "../src/lib/calcom/upcoming-bookings.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const AFTER = "2026-10-01T14:00:00.000Z";

/** A raw cal.com row in the shape measured on 2026-10-01, names and addresses invented. */
function raw(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    uid: `uid${id}`,
    status: "accepted",
    start: "2026-10-01T22:00:00.000Z",
    hosts: [{ id: 1, username: "host-one", name: "Host One", email: "host.one@example.test" }],
    metadata: { sfdc_submission_id: `a04Ui00000SUB${id}` },
    attendees: [{ name: "Lead Person", email: ` Lead${id}@Example.test ` }],
    ...over,
  };
}

interface Call {
  path: string;
  version: string;
  timeoutMs: number;
}

/** An injected clock: every request advances it by `stepMs`, and nothing waits for real (L524). */
function clock(startMs = 1_000_000, stepMs = 1_000) {
  let t = startMs;
  return { now: () => t, advance: (ms = stepMs) => (t += ms) };
}

type Page = { status: number; json: unknown } | Error;

function getter(pages: Page[], clk = clock()) {
  const calls: Call[] = [];
  let i = 0;
  const get = async (path: string, version: string, timeoutMs: number) => {
    calls.push({ path, version, timeoutMs });
    clk.advance();
    const page = pages[i++];
    if (!page) throw new Error(`no page ${i} scripted`);
    if (page instanceof Error) throw page;
    return page;
  };
  return { get, calls };
}

const noSleep = async () => {};

async function read(
  pages: Page[],
  over: { pageSize?: number; maxPages?: number; budgetMs?: number; stepMs?: number } = {},
) {
  const clk = clock(1_000_000, over.stepMs ?? 1_000);
  const g = getter(pages, clk);
  const sleeps: number[] = [];
  const result: CalcomUpcomingRead = await readUpcomingCalcomBookings({
    get: g.get,
    org: "19474",
    afterStartIso: AFTER,
    paceMs: 300,
    sleep: async (ms) => {
      sleeps.push(ms);
      await noSleep();
    },
    clock: clk.now,
    deadlineAtMs: 1_000_000 + (over.budgetMs ?? 45_000),
    pageSize: over.pageSize,
    maxPages: over.maxPages,
  });
  return { result, calls: g.calls, sleeps };
}

// --- the request shape ----------------------------------------------------------
{
  eq(CALCOM_BOOKINGS_PAGE_SIZE, 250, "pages are read at the largest size cal.com accepts");
  const { result, calls } = await read([{ status: 200, json: { data: [raw(1)] } }]);
  assert(result.ok, "one short page is a complete read");
  eq(calls.length, 1, "a short first page ends the read");
  const url = new URL(`https://x.test${calls[0].path}`);
  eq(url.pathname, "/organizations/19474/bookings", "the org listing is read");
  eq(url.searchParams.get("status"), "upcoming", "status=upcoming on every request: without it the listing timed out");
  eq(url.searchParams.get("afterStart"), AFTER, "only bookings that have not started");
  eq(url.searchParams.get("take"), "250", "the page size");
  eq(url.searchParams.get("skip"), "0", "the first page starts at zero");
  eq(url.searchParams.get("sortStart"), "asc", "a stable order, so skip pages walk one list");
  eq(calls[0].version, CALCOM_BOOKINGS_API_VERSION, "the API version the measurement was taken at");
}

// --- the reduced row --------------------------------------------------------------
{
  const { result } = await read([{ status: 200, json: { data: [raw(26177051, { uid: "hSzsCyr9HbBcg92HpJXg3r", metadata: { sfdc_submission_id: " a04Ui00000NDRunIAH " } })] } }]);
  assert(result.ok, "read");
  if (result.ok) {
    eq(
      result.rows,
      [
        {
          id: 26177051,
          uid: "hSzsCyr9HbBcg92HpJXg3r",
          start: "2026-10-01T22:00:00.000Z",
          status: "accepted",
          host: "host-one",
          submissionId: "a04Ui00000NDRunIAH",
          attendeeEmails: ["lead26177051@example.test"],
        },
      ],
      "the known duplicate's cal.com half reduces to its submission id and a normalised address",
    );
  }
}
{
  // Measured 2026-10-01: 789 of 1,252 upcoming bookings (the `review` event type)
  // carry an EMPTY metadata object. That is a booking with no submission id, not an
  // unreadable one, so it is kept and can still be matched by address.
  const { result } = await read([{ status: 200, json: { data: [raw(2, { metadata: {} }), raw(3, { metadata: null }), raw(4, { metadata: { sfdc_submission_id: "  " } })] } }]);
  assert(result.ok, "rows without a submission id are a complete read");
  if (result.ok) eq(result.rows.map((r) => r.submissionId), [null, null, null], "no id, a null bag and a blank id all read as no id");
}
{
  const { result } = await read([{ status: 200, json: { data: [raw(5, { attendees: [], hosts: [] })] } }]);
  assert(result.ok, "a row with no attendee is still a row");
  if (result.ok) {
    eq(result.rows[0].attendeeEmails, [], "no attendee, no address");
    eq(result.rows[0].host, null, "no host reads as null, not a guess");
  }
}

// --- paging -----------------------------------------------------------------------
{
  const full = (from: number) => Array.from({ length: 2 }, (_, i) => raw(from + i));
  const { result, calls, sleeps } = await read(
    [
      { status: 200, json: { data: full(10), pagination: { totalItems: 1, hasNextPage: false } } },
      { status: 200, json: { data: full(12) } },
      { status: 200, json: { data: [raw(14)] } },
    ],
    { pageSize: 2 },
  );
  assert(result.ok, "three pages read");
  eq(calls.length, 3, "a full page is followed by another however the pagination block reads");
  eq(calls.map((c) => new URL(`https://x.test${c.path}`).searchParams.get("skip")), ["0", "2", "4"], "skip walks the list");
  if (result.ok) eq(result.rows.map((r) => r.id), [10, 11, 12, 13, 14], "every row from every page");
  eq(sleeps, [300, 300], "paced between pages, never before the first");
}
{
  const { result } = await read(
    [
      { status: 200, json: { data: [raw(20), raw(21)] } },
      { status: 200, json: { data: [raw(21)] } },
    ],
    { pageSize: 2 },
  );
  assert(result.ok, "a repeated row is not a failure");
  if (result.ok) eq(result.rows.map((r) => r.id), [20, 21], "a row seen on two pages is counted once");
}
{
  const { result } = await read([{ status: 200, json: { data: [] } }]);
  assert(result.ok, "an empty org listing is a complete, empty read");
  if (result.ok) eq(result.rows, [], "no rows");
}

// --- refusals: each by name, none returns the rows read so far ---------------------
{
  const { result } = await read(
    [
      { status: 200, json: { data: [raw(30), raw(31)] } },
      { status: 429, json: { message: "rate limited" } },
    ],
    { pageSize: 2 },
  );
  eq(result, { ok: false, reason: "refused", status: 429, page: 1 }, "a refused second page refuses the whole read");
}
{
  const { result } = await read([{ status: 401, json: {} }]);
  eq(result, { ok: false, reason: "refused", status: 401, page: 0 }, "a refused key is named with its status");
}
{
  const { result } = await read([{ status: 200, json: { data: { not: "a list" } } }]);
  eq(result, { ok: false, reason: "unreadable", status: 200, page: 0 }, "a body that is not a list is unreadable");
}
{
  const { result } = await read([{ status: 200, json: null }]);
  eq(result, { ok: false, reason: "unreadable", status: 200, page: 0 }, "no body is unreadable");
}
for (const [what, row] of [
  ["no id", raw(40, { id: undefined })],
  ["a string id", raw(41, { id: "41" })],
  ["no uid", raw(42, { uid: "" })],
  ["no start", raw(43, { start: undefined })],
  ["an unreadable start", raw(44, { start: "tomorrow" })],
  ["attendees that are not a list", raw(45, { attendees: "lead@example.test" })],
] as const) {
  const { result } = await read([{ status: 200, json: { data: [raw(1), row] } }]);
  eq(result, { ok: false, reason: "row-unreadable", status: 200, page: 0 }, `a row with ${what} refuses the read rather than dropping a booking`);
}
{
  const { result, calls } = await read(
    [
      { status: 200, json: { data: [raw(50), raw(51)] } },
      { status: 200, json: { data: [raw(52), raw(53)] } },
      { status: 200, json: { data: [raw(54), raw(55)] } },
    ],
    { pageSize: 2, maxPages: 2 },
  );
  eq(result, { ok: false, reason: "too-many-pages", status: 200, page: 2 }, "a read past its page budget is refused, never cut short");
  eq(calls.length, 2, "and it stops asking");
}

// --- the deadline: the whole walk is bounded, not just each page (injected clock) ---
{
  eq(CALCOM_BOOKINGS_PAGE_TIMEOUT_MS, 20_000, "a page on its own gets at most twenty seconds");
  const full = (from: number) => [raw(from), raw(from + 1)];
  // Each request costs 25 simulated seconds against a 45 second budget: two pages
  // start, and the third may not.
  const { result, calls } = await read(
    [{ status: 200, json: { data: full(60) } }, { status: 200, json: { data: full(62) } }, { status: 200, json: { data: full(64) } }],
    { pageSize: 2, budgetMs: 45_000, stepMs: 25_000 },
  );
  eq(result, { ok: false, reason: "deadline", status: 0, page: 2 }, "a walk that runs out of time is refused by name, never returned short");
  eq(calls.length, 2, "and no page starts after the deadline");
  eq(calls.map((c) => c.timeoutMs), [20_000, 20_000], "each page waits at most the page timeout while there is room");
}
{
  // 30 seconds into a 45 second budget, the next page may wait only the 15 left.
  const { calls } = await read([{ status: 200, json: { data: [raw(70), raw(71)] } }, { status: 200, json: { data: [] } }], {
    pageSize: 2,
    budgetMs: 45_000,
    stepMs: 30_000,
  });
  eq(calls.map((c) => c.timeoutMs), [20_000, 15_000], "a page never waits past the walk's own deadline");
}
{
  const { result } = await read([{ status: 200, json: { data: [raw(80)] } }], { budgetMs: 0 });
  eq(result, { ok: false, reason: "deadline", status: 0, page: 0 }, "a budget already spent reads nothing");
}
{
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const { result } = await read([timeout], { budgetMs: 45_000, stepMs: 50_000 });
  eq(result, { ok: false, reason: "deadline", status: 0, page: 0 }, "a page aborted at the deadline is the deadline, by name");
}
{
  const { result } = await read([new Error("getaddrinfo ENOTFOUND api.cal.com")]);
  eq(result, { ok: false, reason: "unreachable", status: 0, page: 0 }, "a request that throws inside the budget is unreachable, never a short list");
}

// --- one booking by uid, for the all clear (#2933 review) ----------------------------
async function byUid(page: Page, over: { budgetMs?: number; stepMs?: number } = {}) {
  const clk = clock(1_000_000, over.stepMs ?? 1_000);
  const g = getter([page], clk);
  const result: CalcomBookingRead = await readCalcomBookingByUid({
    get: g.get,
    uid: "hSzs/Cyr9",
    clock: clk.now,
    deadlineAtMs: 1_000_000 + (over.budgetMs ?? 45_000),
  });
  return { result, calls: g.calls };
}
{
  // Measured live 2026-10-01: GET /bookings/hSzsCyr9HbBcg92HpJXg3r answered 200 with
  // the booking under `data`, at the same API version as the listing.
  const { result, calls } = await byUid({ status: 200, json: { data: raw(26177051, { uid: "hSzs/Cyr9", status: "cancelled" }) } });
  eq(calls[0].path, "/bookings/hSzs%2FCyr9", "the uid is read directly, escaped");
  eq(calls[0].version, CALCOM_BOOKINGS_API_VERSION, "at the listing's API version");
  assert(result.ok && result.row.status === "cancelled" && result.row.id === 26177051, "the booking reduces to the same row shape");
}
{
  // Measured live 2026-10-01: an unknown uid answers 404. That is not "cancelled":
  // nothing was measured about the booking, so it is a refusal.
  const { result } = await byUid({ status: 404, json: { status: "error" } });
  eq(result, { ok: false, reason: "refused", status: 404 }, "a 404 is a refusal, not a cancellation");
}
{
  const { result } = await byUid({ status: 200, json: { data: [raw(1)] } });
  eq(result, { ok: false, reason: "unreadable", status: 200 }, "a list where one booking belongs is unreadable");
}
{
  const { result } = await byUid({ status: 200, json: { data: raw(1, { start: "soon" }) } });
  eq(result, { ok: false, reason: "unreadable", status: 200 }, "a booking whose start cannot be read is unreadable");
}
{
  const { result } = await byUid(new Error("socket hang up"));
  eq(result, { ok: false, reason: "unreachable", status: 0 }, "a thrown request is unreachable");
}
{
  const { result, calls } = await byUid({ status: 200, json: { data: raw(1) } }, { budgetMs: 0 });
  eq(result, { ok: false, reason: "deadline", status: 0 }, "no direct read starts after the deadline");
  eq(calls.length, 0, "and nothing is asked");
}

// --- bookings CREATED in a window, every status (#2946) ----------------------------
// The pilot comparison reads each status by when a booking was MADE, a day at a
// time. What it needs on top of the upcoming row: when it was made, its event type,
// both ends of a reschedule, the host's address, and a phone key for matching.
{
  const created = (id: number, over: Record<string, unknown> = {}) =>
    raw(id, {
      createdAt: "2026-10-02T15:00:00.000Z",
      end: "2026-10-02T22:30:00.000Z",
      eventTypeId: 1314152,
      attendees: [{ name: "Lead Person", email: "lead@example.test", phoneNumber: "+1 (555) 010-0199" }],
      ...over,
    });
  async function readCreated(pages: Page[], over: { retries?: number; budgetMs?: number } = {}) {
    const clk = clock();
    const g = getter(pages, clk);
    const result: CalcomListedRead = await readCalcomBookingsCreated({
      get: g.get,
      org: "19474",
      status: "past",
      afterCreatedIso: "2026-10-02T04:00:00.000Z",
      beforeCreatedIso: "2026-10-03T04:00:00.000Z",
      paceMs: 0,
      sleep: noSleep,
      clock: clk.now,
      deadlineAtMs: 1_000_000 + (over.budgetMs ?? 600_000),
      retries: over.retries,
    });
    return { result, calls: g.calls };
  }
  {
    const { result, calls } = await readCreated([
      {
        status: 200,
        json: { data: [created(1, { rescheduledToUid: "uid9", status: "cancelled", hosts: [{ email: " Adv@Pennie.test " }] })] },
      },
    ]);
    const url = new URL(`https://x.test${calls[0].path}`);
    eq(url.searchParams.get("status"), "past", "the status asked for is the one sent");
    eq(url.searchParams.get("afterCreatedAt"), "2026-10-02T04:00:00.000Z", "bounded below on when it was made");
    eq(url.searchParams.get("beforeCreatedAt"), "2026-10-03T04:00:00.000Z", "and above");
    eq(url.searchParams.get("afterStart"), null, "never by start: a cohort is judged on when the booking was made");
    eq(calls[0].timeoutMs, CALCOM_WINDOW_PAGE_TIMEOUT_MS, "a page may take the measured slow first page, not twenty seconds");
    assert(result.ok, "one short page is a complete read");
    if (result.ok) {
      const row = result.rows[0];
      eq(row.createdAt, "2026-10-02T15:00:00.000Z", "when it was made is kept");
      eq(row.eventTypeId, 1314152, "the event type is kept");
      eq(row.rescheduledToUid, "uid9", "the forward reschedule link is kept");
      eq(row.rescheduledFromUid, null, "a missing back link reads as null");
      eq(row.attendeePhone10, "5550100199", "the phone is reduced to its last ten digits");
      eq(row.hostEmail, "adv@pennie.test", "the host address is trimmed and lower cased");
    }
  }
  {
    // The phone lives on the attendee on most rows and only in the answers on some.
    const { result } = await readCreated([
      {
        status: 200,
        json: {
          data: [
            created(2, { attendees: [{ email: "x@example.test" }], bookingFieldsResponses: { attendeePhoneNumber: "15550100777" } }),
            created(3, { attendees: [{ email: "y@example.test", phoneNumber: "12345" }] }),
          ],
        },
      },
    ]);
    if (result.ok) {
      eq(result.rows[0].attendeePhone10, "5550100777", "a phone only in the answers is read from there");
      eq(result.rows[1].attendeePhone10, null, "a phone too short to be one reads as none, never a partial key");
    } else assert(false, "both rows read");
  }
  {
    const { result } = await readCreated([{ status: 200, json: { data: [created(4, { createdAt: undefined })] } }]);
    eq(
      result,
      { ok: false, reason: "row-unreadable", status: 200, page: 0 },
      "a row with no creation time refuses the read: it cannot be placed in a cohort",
    );
  }
  {
    // Measured: the first page of a past listing answered in 6 s once and 117 s once.
    const { result, calls } = await readCreated([new Error("timed out"), { status: 200, json: { data: [created(5)] } }]);
    assert(result.ok, "a first page that throws is tried once more and the read completes");
    eq(calls.length, 2, "the page was asked twice");
  }
  {
    const { result, calls } = await readCreated([new Error("timed out"), new Error("timed out again")]);
    eq(result, { ok: false, reason: "unreachable", status: 0, page: 0 }, "two throws on one page refuse the read rather than return nothing");
    eq(calls.length, 2, "one retry, not a loop");
  }
  {
    const { result, calls } = await readCreated([{ status: 503, json: {} }]);
    eq(result, { ok: false, reason: "refused", status: 503, page: 0 }, "a page cal.com answered with an error is refused");
    eq(calls.length, 1, "an answer is not retried");
  }
  {
    const { result } = await readCreated([new Error("timed out")], { budgetMs: 500 });
    eq(result, { ok: false, reason: "deadline", status: 0, page: 0 }, "a throw past the deadline is the deadline, and not retried");
  }
}
{
  // The upcoming read keeps its own rule: no retry on a throw.
  const { result, calls } = await read([new Error("socket hang up"), { status: 200, json: { data: [] } }]);
  eq(result, { ok: false, reason: "unreachable", status: 0, page: 0 }, "the upcoming read does not retry");
  eq(calls.length, 1, "it asked once");
}
{
  const clk = clock();
  const g = getter([{ status: 200, json: { data: raw(7, { createdAt: "2026-10-02T15:00:00.000Z", rescheduledFromUid: "uid6" }) } }], clk);
  const r = await readCalcomListedBookingByUid({ get: g.get, uid: "uid7", clock: clk.now, deadlineAtMs: 2_000_000 });
  assert(r.ok && r.row.rescheduledFromUid === "uid6", "one booking by uid reads in the listed shape");
}
{
  // Both by uid reads share one implementation: the listed one maps every refusal the
  // same way the upcoming one does.
  const one = async (page: Page, budgetMs = 60_000) => {
    const clk = clock();
    const g = getter([page], clk);
    return readCalcomListedBookingByUid({ get: g.get, uid: "u1", clock: clk.now, deadlineAtMs: 1_000_000 + budgetMs });
  };
  eq(await one({ status: 404, json: {} }), { ok: false, reason: "refused", status: 404 }, "listed by uid: a 404 is a refusal");
  eq(await one({ status: 200, json: { data: [raw(1)] } }), { ok: false, reason: "unreadable", status: 200 }, "listed by uid: a list is unreadable");
  eq(await one(new Error("down")), { ok: false, reason: "unreachable", status: 0 }, "listed by uid: a throw is unreachable");
  eq(await one({ status: 200, json: { data: raw(1) } }, 0), { ok: false, reason: "deadline", status: 0 }, "listed by uid: nothing starts after the deadline");
}

// --- following a reschedule chain to its end (#2946) ----------------------------------
// The created window listing can lack a chain's later links (a page shifts under a live
// walk), and a link read by uid can name a further one the listing lacked too.
{
  const link = (n: number, to: string | null, from: string | null): CalcomListedBooking =>
    ({
      id: n,
      uid: `r${n}`,
      start: "2026-10-03T15:00:00.000Z",
      status: to === null ? "accepted" : "cancelled",
      host: null,
      submissionId: null,
      attendeeEmails: [],
      createdAt: "2026-10-02T15:00:00.000Z",
      end: null,
      eventTypeId: 1314152,
      rescheduledFromUid: from,
      rescheduledToUid: to,
      attendeePhone10: null,
      hostEmail: null,
    });
  const store = new Map<string, CalcomListedByUidRead>([
    ["r2", { ok: true, row: { ...link(2, "r3", "r1") } }],
    ["r3", { ok: true, row: { ...link(3, null, "r2") } }],
  ]);
  const asked: string[] = [];
  const fetchOne = async (uid: string): Promise<CalcomListedByUidRead> => {
    asked.push(uid);
    return store.get(uid) ?? { ok: false, reason: "refused", status: 404 };
  };
  const followed = await followRescheduleChains([{ ...link(1, "r2", null) }], fetchOne);
  assert(followed.ok, "a chain two links past the listing is followed");
  if (followed.ok) {
    eq(followed.rows.map((r) => r.uid).sort(), ["r1", "r2", "r3"], "to its last link, including the one only the fetched link named");
    eq(followed.notFound, [], "nothing was missing");
  }
  eq(asked, ["r2", "r3"], "each missing link is asked for once");

  const gone = await followRescheduleChains([{ ...link(1, "r9", null) }], fetchOne);
  assert(gone.ok && gone.notFound.length === 1 && gone.notFound[0] === "r9", "a link cal.com does not hold is reported missing, and the chain stays unresolved");

  const down = await followRescheduleChains([{ ...link(1, "r2", null) }], async () => ({ ok: false, reason: "unreachable", status: 0 }));
  eq(down, { ok: false, reason: "unreachable", uid: "r2", status: 0 }, "a link that could not be read refuses by uid, never a shorter chain");

  // A chain that never ends (each link names a new one) stops at the bound, by name.
  let n = 100;
  const endless = await followRescheduleChains([{ ...link(1, "r100", null) }], async (uid) => ({ ok: true, row: { ...link(++n, `r${n + 1}`, uid) } }), 5);
  eq(endless.ok, false, "a chain longer than the bound refuses");
  if (!endless.ok) eq(endless.reason, "too-many-hops", "and says it was too long");
}
{
  eq(phoneKey("(555) 010-0199"), "5550100199", "a ten digit phone is its own key");
  eq(phoneKey(undefined), null, "no phone, no key");
}

finish();
