// `selectAllPages` over a table another writer changes mid read (2026-10-25).
//
// The buffer breach check paged "LaRenzo Binns: overlapping by 20 minutes" naming
// one booking twice. The read cut its pages with OFFSET, each page its own request
// with no shared snapshot, so a booking inserted between page 1 and page 2 with an
// id below the boundary pushed the boundary row onto page 2 as well: 1,040 rows
// examined, 1,039 distinct. A row REMOVED between the pages does the opposite and
// one row is never read, which can hide a real clash for a tick.
//
// Keyset paging (order by the unique key, ask for `key > the last key seen`) holds
// for any row present for the whole read: it can be neither repeated nor skipped.
// A row inserted mid read may be missed, which is the same as it arriving after the
// read. These cases assert exactly that, for a single key and for a composite one.

import { selectAllPages, PAGE_SIZE, type PageableQuery } from "../src/lib/supabase/paginate.ts";
import { liveTable, parseLogicTree, type FakeRow } from "./lib/fake-live-pageable-table.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const hex = (n: number) => n.toString(16).padStart(8, "0");

/** 1,039 rows keyed so that index 999 (the last row of page 1) is a known id. */
function bookingRows(): FakeRow[] {
  const rows: FakeRow[] = [];
  for (let i = 0; i < 1039; i++) {
    const id = i === 999 ? "f2f68932-boundary" : i < 999 ? `a${hex(i)}` : `f9${hex(i)}`;
    rows.push({ id, starts_at: "2026-10-26T17:20:00.000Z" });
  }
  return rows;
}

const idsOf = (rows: FakeRow[], keys: string[]) => rows.map((r) => keys.map((k) => String(r[k])).join("|"));
const repeats = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);

async function readAll(table: ReturnType<typeof liveTable>, keys: string | string[]) {
  try {
    return { rows: await selectAllPages<FakeRow>("live table", keys, table.build), error: null };
  } catch (err) {
    return { rows: [] as FakeRow[], error: err as Error };
  }
}

// --- 1. a row INSERTED below the boundary between page 1 and page 2 -------------
{
  const t = liveTable(bookingRows(), (page, table) => {
    if (page === 0) table.rows.push({ id: "8d8f8b7d-new", starts_at: "2026-10-27T18:30:00.000Z" });
  });
  const before = new Set(idsOf(t.rows, ["id"]));
  const { rows, error } = await readAll(t, "id");
  assert(error === null, `insert mid read: the read completes (${error?.message ?? "ok"})`);
  const ids = idsOf(rows, ["id"]);
  eq(repeats(ids), [], "insert mid read: no key is returned twice (the boundary row was read twice under OFFSET)");
  assert([...before].every((id) => ids.includes(id)), "insert mid read: every row present for the whole read is returned");
  assert(t.requests.length >= 2, `insert mid read: positive control, a page boundary was crossed (${t.requests.length} requests)`);
}

// --- 2. a row DELETED below the boundary between page 1 and page 2 --------------
{
  const deleted = `a${hex(5)}`;
  const t = liveTable(bookingRows(), (page, table) => {
    if (page === 0) table.rows.splice(table.rows.findIndex((r) => r.id === deleted), 1);
  });
  const presentThroughout = idsOf(t.rows, ["id"]).filter((id) => id !== deleted);
  const { rows, error } = await readAll(t, "id");
  assert(error === null, `delete mid read: the read completes (${error?.message ?? "ok"})`);
  const ids = idsOf(rows, ["id"]);
  eq(repeats(ids), [], "delete mid read: no key is returned twice");
  const missing = presentThroughout.filter((id) => !ids.includes(id));
  eq(missing, [], "delete mid read: no row present for the whole read is skipped (OFFSET skipped the first row of page 2)");
}

// --- 3. a composite key, with values carrying PostgREST's reserved characters ---
// frame_origin_daily is keyed (day, origin, surface) and an origin holds dots and
// colons; a value parsed as filter syntax is the failure the quoting exists to stop.
function compositeRows(): FakeRow[] {
  const rows: FakeRow[] = [];
  const awkward = ['https://a.example,b', 'o"quoted', "back\\slash", "paren)(", "x.y:z"];
  for (let i = 0; i < 2300; i++) {
    rows.push({
      day: `2026-10-${String(1 + (i % 20)).padStart(2, "0")}`,
      origin: `${awkward[i % awkward.length]}-${i}`,
      surface: i % 2 === 0 ? "book" : "manage",
      loads: i,
    });
  }
  return rows;
}
const KEY3 = ["day", "origin", "surface"];
{
  const t = liveTable(compositeRows(), (page, table) => {
    // Insert a row sorting first, and delete one sorting early, between pages.
    if (page === 0) table.rows.push({ day: "2026-09-30", origin: "new", surface: "book", loads: -1 });
    if (page === 1) table.rows.splice(table.rows.findIndex((r) => r.loads === 7), 1);
  });
  const presentThroughout = idsOf(t.rows.filter((r) => r.loads !== 7), KEY3);
  const { rows, error } = await readAll(t, KEY3);
  assert(error === null, `composite key: the read completes (${error?.message ?? "ok"})`);
  const ids = idsOf(rows, KEY3);
  eq(repeats(ids), [], "composite key: no key tuple is returned twice");
  eq(presentThroughout.filter((id) => !ids.includes(id)), [], "composite key: no row present for the whole read is skipped");
  assert(t.requests.length === 3, `composite key: positive control, three pages were cut (${t.requests.length})`);
}

// The quoting round trips through the grammar itself, not only through the fake.
{
  const tree = parseLogicTree('a.gt."x,y.z",and(a.eq."q\\"uo\\\\te",b.gt."p)(")');
  const flat = JSON.stringify(tree);
  assert(flat.includes('"value":"x,y.z"') && flat.includes('"value":"q\\"uo\\\\te"') && flat.includes('"value":"p)("'),
    `the fake's grammar reads quoted values with reserved characters and escapes (${flat})`);
}

// --- 4. belt and braces: a key repeated across pages THROWS ----------------------
// A source that ignores the keyset filter (or any other way a page repeats a row)
// must fail the read, never hand a repeated row to an aggregate.
{
  const rows = bookingRows();
  const ignoringFilter = (): PageableQuery => {
    const q: PageableQuery = {
      order: () => q,
      gt: () => q,
      or: () => q,
      range: () => Promise.resolve({ data: rows.slice(0, PAGE_SIZE), error: null }),
    };
    return q;
  };
  let err: Error | null = null;
  try {
    await selectAllPages<FakeRow>("repeating source", "id", ignoringFilter);
  } catch (e) {
    err = e as Error;
  }
  assert(err !== null && /repeating source/.test(err.message) && /twice|repeat/i.test(err.message),
    `a key returned on two pages throws, naming the read (${err?.message ?? "no throw"})`);
}

// --- 5. a row that does not carry its key THROWS -------------------------------
// Keyset paging needs every row's key; a select that leaves it out cannot be paged.
{
  const t = liveTable([{ schedule_id: "s1" }, { schedule_id: "s2" }]);
  const { error } = await readAll(t, "id");
  assert(error !== null && /id/.test(error.message), `a row without its key column throws (${error?.message ?? "no throw"})`);
}

// --- 6. a query that orders ITSELF is refused ------------------------------------
// The helper owns the order: a caller's own leading order would make `key > last`
// skip rows. A real PostgREST builder carries its parameters on `url`.
{
  const withOwnOrder = (): PageableQuery => {
    const q = {
      url: new URL("https://x.supabase.co/rest/v1/bookings?select=id&order=starts_at.asc"),
      order: () => q,
      gt: () => q,
      or: () => q,
      range: () => Promise.resolve({ data: [], error: null }),
    };
    return q as PageableQuery;
  };
  let err: Error | null = null;
  try {
    await selectAllPages<FakeRow>("self ordered", "id", withOwnOrder);
  } catch (e) {
    err = e as Error;
  }
  assert(err !== null && /order/.test(err.message), `a query carrying its own order is refused (${err?.message ?? "no throw"})`);
}

finish();
