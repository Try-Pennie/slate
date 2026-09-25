// Retention for the per booking rows in alert_state (#2726). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-alert-state-retention.ts
//
// alert_state was on the capped read guard's SAFE_TABLES as roster bounded, and
// stopped being so the day an alert was keyed by booking: an incident never
// resolves, so its cooldown row and firing marker stayed for ever and the table
// grew with booking volume. Two things keep that from recurring, and this pins
// both:
//
//   1. every `:*` family in the alert catalog declares what its suffix is, so a
//      new family cannot ship without somebody deciding whether it grows (L96);
//   2. the prune's family list is DERIVED from those declarations, and it deletes
//      a booking's rows only once that booking both started and was made more
//      than the grace window ago, which is when no check can read it again.
import {
  ALERT_CATALOG,
  ALERT_KEY_SUFFIXES,
  alertEntry,
} from "@/lib/notify/alert-catalog";
import {
  BOOKING_ALERT_PRUNE_GRACE_DAYS,
  BOOKING_KEYED_FAMILIES,
  bookingAlertPruneCutoffIso,
  parseBookingAlertKey,
  pruneBookingAlertState,
  type BookingTimes,
} from "@/lib/notify/alert-state-retention";
import { OFFSITE_ORIGIN_LOOKBACK_MS } from "@/lib/monitor/offsite-origin";
import { assert, eq, finish } from "./lib/harness.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 25, 3, 5, 0);
const iso = (ms: number) => new Date(ms).toISOString();

// --- 1. every family declares its suffix ------------------------------------------

const families = ALERT_CATALOG.filter((e) => e.key.endsWith(":*"));
assert(families.length >= 20, `the catalog still has its families (got ${families.length}), so the check below is not vacuous`);
for (const e of families) {
  assert(
    e.suffix !== undefined && (ALERT_KEY_SUFFIXES as readonly string[]).includes(e.suffix),
    `alert family "${e.key}" declares what its suffix is (one of ${ALERT_KEY_SUFFIXES.join(", ")}), ` +
      `because a family keyed by booking grows alert_state with booking volume and must be pruned`,
  );
}
for (const e of ALERT_CATALOG.filter((x) => !x.key.endsWith(":*"))) {
  assert(e.suffix === undefined, `"${e.key}" is a single key, so it has no suffix to declare`);
}

// Measured 2026-09-25 against the live table and the send sites, so a wrong
// declaration on the families the issue named is caught rather than trusted.
// The issue said misroute and external_double_book were keyed by booking; they
// are keyed by bucket code and by agent, which the roster bounds.
for (const k of ["booking_offsite_origin:*", "stale_phone_invite:*", "booking_below_lead_tier:*"]) {
  eq(alertEntry(k)?.suffix, "booking", `${k} is keyed by a booking id`);
}
for (const k of ["misroute:*", "external_double_book:*", "cron_lane_stale:*", "webhook_dead:*"]) {
  eq(alertEntry(k)?.suffix, "bounded", `${k} is keyed by something the roster or the code bounds`);
}

// The prune list is the catalog's booking families, not a list kept beside it (L41).
eq(
  [...BOOKING_KEYED_FAMILIES].sort(),
  families.filter((e) => e.suffix === "booking").map((e) => e.key.slice(0, -2)).sort(),
  "the prune covers exactly the families the catalog declares as keyed by booking",
);

// --- 2. the grace window is long enough that no check re-reads a pruned booking ----

// The off site check stamps a booking once and skips it while the stamp exists,
// over bookings CREATED inside its lookback. A booking pruned while still inside
// that lookback would page twice, so the grace must outlast it.
assert(
  BOOKING_ALERT_PRUNE_GRACE_DAYS * DAY > OFFSITE_ORIGIN_LOOKBACK_MS,
  "the grace outlasts the off site lookback, so a pruned booking is never re-read and re-paged",
);
eq(bookingAlertPruneCutoffIso(NOW), iso(NOW - BOOKING_ALERT_PRUNE_GRACE_DAYS * DAY), "the cutoff is the grace back from now");

// --- 3. the key parser ----------------------------------------------------------------

const B1 = "11111111-1111-4111-8111-111111111111";
eq(parseBookingAlertKey(`booking_offsite_origin:${B1}`), { key: `booking_offsite_origin:${B1}`, family: "booking_offsite_origin", bookingId: B1 }, "reads a cooldown row");
eq(
  parseBookingAlertKey(`alert_firing:stale_phone_invite:${B1}`),
  { key: `alert_firing:stale_phone_invite:${B1}`, family: "stale_phone_invite", bookingId: B1 },
  "reads a firing marker",
);
eq(parseBookingAlertKey(`booking_offsite_origin:not-a-uuid`), null, "a suffix that is not a booking id is never read as one");
eq(parseBookingAlertKey(`booking_below_lead_tierX:${B1}`), null, "a lookalike family is not the family");
eq(parseBookingAlertKey(`misroute:${B1}`), null, "a family not keyed by booking is never touched");
eq(parseBookingAlertKey(`alert_firing:alert_firing:booking_offsite_origin:${B1}`), null, "only one marker prefix is read");

// --- 4. what the sweep deletes, and what it keeps ---------------------------------

const OLD = NOW - (BOOKING_ALERT_PRUNE_GRACE_DAYS + 1) * DAY;
const ids = {
  past: "22222222-2222-4222-8222-222222222222",
  future: "33333333-3333-4333-8333-333333333333",
  // Started long ago but CREATED recently: a check reading by creation time could
  // still see it, so it is kept.
  lateMade: "44444444-4444-4444-8444-444444444444",
  // Rows for a booking that does not exist (a test fixture cleanup): not a booking
  // already past, so not this sweep's to delete.
  missing: "55555555-5555-4555-8555-555555555555",
  unreadable: "66666666-6666-4666-8666-666666666666",
  pastBelow: "77777777-7777-4777-8777-777777777777",
};
const bookings = new Map<string, BookingTimes>([
  [ids.past, { startsAt: iso(OLD), createdAt: iso(OLD - DAY) }],
  [ids.future, { startsAt: iso(NOW + DAY), createdAt: iso(OLD) }],
  [ids.lateMade, { startsAt: iso(OLD), createdAt: iso(NOW - DAY) }],
  [ids.unreadable, { startsAt: "not a time", createdAt: iso(OLD) }],
  [ids.pastBelow, { startsAt: iso(OLD), createdAt: iso(OLD - 3 * DAY) }],
]);

function table(): Set<string> {
  return new Set([
    `booking_offsite_origin:${ids.past}`,
    `alert_firing:booking_offsite_origin:${ids.past}`,
    `stale_phone_invite:${ids.future}`,
    `alert_firing:stale_phone_invite:${ids.future}`,
    `booking_offsite_origin:${ids.lateMade}`,
    `booking_offsite_origin:${ids.missing}`,
    `stale_phone_invite:${ids.unreadable}`,
    `booking_below_lead_tier:${ids.pastBelow}`,
    `alert_firing:booking_below_lead_tier:${ids.pastBelow}`,
    // Neighbours no sweep of booking families may touch.
    "sync_failures",
    "alert_firing:sync_failures",
    `misroute:${ids.past}`,
    "external_double_book:88888888-8888-4888-8888-888888888888",
  ]);
}

function fakeDeps(rows: Set<string>, overrides: Partial<Parameters<typeof pruneBookingAlertState>[0]> = {}) {
  const asked: string[][] = [];
  const bookingReads: string[][] = [];
  return {
    asked,
    bookingReads,
    deps: {
      nowMs: NOW,
      listFamilyKeys: async (family: string) =>
        [...rows].filter((k) => k.startsWith(`${family}:`) || k.startsWith(`alert_firing:${family}:`)),
      loadBookings: async (want: string[]) => {
        bookingReads.push(want);
        return new Map([...bookings].filter(([id]) => want.includes(id)));
      },
      deleteKeys: async (keys: string[]) => {
        asked.push(keys);
        let n = 0;
        for (const k of keys) if (rows.delete(k)) n++;
        return n;
      },
      ...overrides,
    },
  };
}

{
  const rows = table();
  const { deps, asked } = fakeDeps(rows);
  const report = await pruneBookingAlertState(deps);
  eq(
    new Set(asked.flat()),
    new Set([
      `booking_offsite_origin:${ids.past}`,
      `alert_firing:booking_offsite_origin:${ids.past}`,
      `booking_below_lead_tier:${ids.pastBelow}`,
      `alert_firing:booking_below_lead_tier:${ids.pastBelow}`,
    ]),
    "deletes both rows of every booking that started and was made before the cutoff, and nothing else",
  );
  eq(report.deleted, 4, "reports the rows the database says it deleted");
  eq(report.scanned, 9, "counts every per booking row it read");
  eq(
    Object.entries(report.byFamily).sort(),
    [["booking_below_lead_tier", 2], ["booking_offsite_origin", 2]],
    "says which families the rows came from",
  );
  eq(report.kept, { notYetPast: 3, noBooking: 1, unreadable: 1 }, "says why each kept row was kept");
  assert(rows.has("sync_failures") && rows.has(`misroute:${ids.past}`), "neighbouring keys are untouched");
  assert(rows.has(`stale_phone_invite:${ids.future}`), "an upcoming booking keeps its rows");
  assert(rows.has(`booking_offsite_origin:${ids.lateMade}`), "a booking made inside the grace keeps its rows");

  // Idempotent: a second run over what is left deletes nothing and asks for nothing.
  const again = fakeDeps(rows);
  const second = await pruneBookingAlertState(again.deps);
  eq(second.deleted, 0, "a second run deletes nothing");
  eq(again.asked.length, 0, "a second run sends no delete at all");
}

// Nothing to prune: no booking read and no delete, and a zero that is measured.
{
  const rows = new Set(["sync_failures"]);
  const { deps, asked, bookingReads } = fakeDeps(rows);
  const report = await pruneBookingAlertState(deps);
  eq(report.scanned, 0, "an empty family set scans nothing");
  eq(bookingReads.length + asked.length, 0, "and spends no read or delete on it");
}

// --- 5. every failure throws, and none deletes anything ------------------------------

async function throws(label: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run();
    assert(false, `${label}: expected a throw`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(pattern.test(msg), `${label}: throws its own reason (got "${msg}")`);
  }
}

{
  const rows = table();
  const { deps, asked } = fakeDeps(rows, {
    listFamilyKeys: async () => {
      throw new Error("alert_state family read failed: statement timeout");
    },
  });
  await throws("a failed key read", () => pruneBookingAlertState(deps), /statement timeout/);
  eq(asked.length, 0, "a failed key read deletes nothing");
}
{
  const rows = table();
  const { deps, asked } = fakeDeps(rows, {
    loadBookings: async () => {
      throw new Error("bookings read failed: connection reset");
    },
  });
  // An unreadable booking list must never read as "no such booking", which keeps
  // everything here, but it must not read as success either.
  await throws("a failed booking read", () => pruneBookingAlertState(deps), /connection reset/);
  eq(asked.length, 0, "a failed booking read deletes nothing");
}
{
  const rows = table();
  const { deps } = fakeDeps(rows, {
    deleteKeys: async () => {
      throw new Error("alert_state prune delete failed: permission denied");
    },
  });
  await throws("a failed delete", () => pruneBookingAlertState(deps), /permission denied/);
}

finish();
