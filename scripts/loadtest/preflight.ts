// The positive control, run BEFORE a booking load run (#2243, #2244).
//
// WHY. Everything the judge concludes rests on two things it cannot check about
// itself: that a booking made through the API really leaves the rows it looks for,
// and that its overlap check really sees them. A judge whose database read is
// scoped wrongly, or whose overlap comparison is inverted, reports a clean run
// over a branch full of double bookings and nothing about the output says so
// (L1: a guard is only real once it has been seen to fail).
//
// So this makes ONE real booking and checks what it left behind, then PLANTS an
// overlapping pair that the judge's own predicate must go RED on, and removes it.
// Both halves, or it proves nothing: a judge hard wired to report no overlaps
// satisfies a check that only plants a clean pair.
//
// It writes to the BRANCH only and refuses production by name.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { overlaps, type JudgedBooking } from "./judge-booking-run.ts";
import { stubShapedEventId } from "./preflight-checks.ts";

const PROD_REF = "drukfvgaynzrralbzkzj";
const PROD_HOST = "slate.trypennie.app";

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was attempted.`);
    process.exit(1);
  }
  return v;
}

const SLATE_BASE = need("SLATE_BASE").replace(/\/$/, "");
const API_KEY = need("BOOKING_API_KEY");
const SUPA_URL = need("SUPABASE_URL");
const SUPA_KEY = need("SUPABASE_SECRET_KEY");
const RUN_ID = need("RUN_ID");
// env-ok: PREFLIGHT_CODE (optional; defaults to 112, the busiest real code, and a
// hand run would only change it to reach a different pool)
// env-ok: PREFLIGHT_OUT (optional; defaults to results/preflight.json, which is
// where the workflow uploads it from)
const CODE = process.env.PREFLIGHT_CODE ?? "112";

// This one WRITES, so both refusals are by name and neither is a flag somebody
// could set wrong at 2am.
if (SUPA_URL.includes(PROD_REF) || SLATE_BASE.includes(PROD_HOST)) {
  console.error("FAILED: this points at production. The preflight writes rows and plants a clash.");
  process.exit(1);
}

const SUPA = `${SUPA_URL.replace(/\/$/, "")}/rest/v1`;
const H = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "content-type": "application/json" };

async function rows(path: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${SUPA}/${path}`, { headers: H });
  if (!res.ok) throw new Error(`read ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>[];
}

function fail(why: string): never {
  console.error(`\nPREFLIGHT FAILED: ${why}`);
  process.exit(2);
}

// --- half one: one real booking leaves the rows the judge looks for ------------

const externalId = `${RUN_ID}-preflight`;
const avail = await fetch(`${SLATE_BASE}/api/availability?bucket=${CODE}`);
const slots = ((await avail.json().catch(() => ({}))) as { slots?: { start?: string }[] }).slots ?? [];
if (slots.length === 0) {
  // Nothing to book is not a pass: the run that follows would have nothing to book
  // either, and its empty result would look like a booking path that refused
  // everything rather than a branch offering no times (L98).
  fail(`bucket ${CODE} is offering no times, so the control could not make a booking`);
}

const res = await fetch(`${SLATE_BASE}/api/bookings`, {
  method: "POST",
  headers: { Authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    bucketCode: CODE,
    start: slots[0]!.start,
    timezone: "America/New_York",
    externalId,
    attendee: {
      name: "Loadtest Preflight",
      email: `${externalId}@loadtest.local`,
      phone: "+15555550100",
    },
  }),
});
if (res.status !== 200) {
  fail(`the control booking was answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// cap-safe: external_id is this control's own unique id, so this returns at most one row
const booked = await rows(
  `bookings?select=id,gcal_event_id,idempotency_key,assigned_user_id,starts_at,ends_at,status&external_id=eq.${externalId}`,
);
if (booked.length !== 1) fail(`the control booking left ${booked.length} rows, expected exactly one`);
const row = booked[0]!;

// The event id must be the STUB'S shape, not a real Google one. If it is not, the
// run is about to make six hundred real calendar events and send six hundred real
// invitations, which is the single most expensive way this can go wrong.
// The RULE lives in `preflight-checks.ts` and is pinned offline; this is the read.
const eventId = String(row.gcal_event_id ?? "");
if (!stubShapedEventId(eventId)) {
  fail(
    `the control booking's gcal_event_id is ${JSON.stringify(eventId)}, which is not the stub's ` +
      "shape. SLATE_LOADTEST is not on for this deployment, so the run would create real calendar " +
      "events and send real invitations.",
  );
}
if (!row.idempotency_key) fail("the control booking carries no idempotency key");

// cap-safe: one booking's blocks, and the assertion is only that there is at least one
const blocks = await rows(`busy_blocks?select=id&booking_id=eq.${row.id}`);
if (blocks.length === 0) fail("the control booking wrote no busy_blocks row, so its slot still reads free");

// The reservation is deleted on success, so its ABSENCE is the assertion. A row
// still sitting there means the confirm path did not complete its own cleanup.
// cap-safe: idempotency_key is unique, so this returns at most one row
const reservations = await rows(`booking_reservations?select=id&idempotency_key=eq.${row.idempotency_key}`);
if (reservations.length !== 0) {
  fail(`${reservations.length} booking_reservations rows survived a successful booking`);
}
console.log(`ok: one booking, stub shaped event id (${eventId.slice(0, 12)}...), busy block written, reservation gone`);

// --- half two: the judge's own overlap check really goes red -------------------

const clash: JudgedBooking = {
  id: "planted",
  external_id: `${RUN_ID}-planted`,
  idempotency_key: "planted",
  assigned_user_id: String(row.assigned_user_id),
  starts_at: String(row.starts_at),
  ends_at: String(row.ends_at),
  status: "confirmed",
};
const real: JudgedBooking = {
  id: String(row.id),
  external_id: externalId,
  idempotency_key: String(row.idempotency_key),
  assigned_user_id: String(row.assigned_user_id),
  starts_at: String(row.starts_at),
  ends_at: String(row.ends_at),
  status: "confirmed",
};
if (!overlaps(real, clash)) {
  fail("the judge's overlap predicate did NOT flag an identical window, so it can find nothing");
}
// And the other direction, or the predicate could simply be returning true (L1).
const after: JudgedBooking = {
  ...clash,
  starts_at: String(row.ends_at),
  ends_at: new Date(Date.parse(String(row.ends_at)) + 20 * 60_000).toISOString(),
};
if (overlaps(real, after)) {
  fail("the judge's overlap predicate flagged two back to back calls, so it would report every run red");
}
console.log("ok: the overlap predicate goes red on a clash and stays quiet on a back to back pair");

// --- and the database really refuses one, which is the thing being relied on ----

const planted = await fetch(`${SUPA}/bookings`, {
  method: "POST",
  headers: { ...H, Prefer: "return=representation" },
  body: JSON.stringify([
    {
      org_id: row.org_id ?? undefined,
      external_id: `${RUN_ID}-planted`,
      assigned_user_id: row.assigned_user_id,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      status: "confirmed",
    },
  ]),
});
const slotUniqueIndexEnforced = !planted.ok;
if (planted.ok) {
  const inserted = (await planted.json()) as { id: string }[];
  // It was ACCEPTED, which means `bookings_active_slot_uniq` is not doing its job
  // on this branch. Removed first so the run is not left with a planted clash, then
  // reported: the run that follows would otherwise report a double booking this
  // control created.
  for (const r of inserted) {
    await fetch(`${SUPA}/bookings?id=eq.${r.id}`, { method: "DELETE", headers: H });
  }
  fail(
    "the database ACCEPTED a second active booking on the same agent at the same time, so " +
      "bookings_active_slot_uniq is not enforcing on this branch and the run could prove nothing",
  );
}
console.log(`ok: the database refused a planted clash (${planted.status}), so the unique index is live`);

// The judge reads THIS rather than the catalogue, and that is the point.
//
// It used to ask PostgREST for `pg_indexes`, which PostgREST does not expose:
// measured 2026-09-11, that read answers 404 on every environment, so the bar
// reported "bookings_active_slot_uniq is NOT on the branch" on EVERY run. A
// permanently red check is one nobody reads by the second week (L36).
//
// Proving it by BEHAVIOUR is also the stronger proof (L63): an index present in
// the catalogue but not enforcing (invalid, or not the predicate anybody thinks it
// is) reads as fine to a name lookup, and the thing the run actually depends on is
// the database refusing a second active booking on one agent at one time. This
// control just asked it to, so its answer is the measurement.
const OUT = process.env.PREFLIGHT_OUT ?? "results/preflight.json";
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ runId: RUN_ID, slotUniqueIndexEnforced, plantedStatus: planted.status }, null, 2),
  "utf8",
);
console.log(`\nPREFLIGHT PASSED (wrote ${OUT})`);
