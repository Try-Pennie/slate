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
  readUpcomingCalcomBookings,
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
}

function getter(pages: Array<{ status: number; json: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const get = async (path: string, version: string) => {
    calls.push({ path, version });
    const page = pages[i++];
    if (!page) throw new Error(`no page ${i} scripted`);
    return page;
  };
  return { get, calls };
}

const noSleep = async () => {};

async function read(pages: Array<{ status: number; json: unknown }>, over: { pageSize?: number; maxPages?: number } = {}) {
  const g = getter(pages);
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
    ...over,
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

finish();
