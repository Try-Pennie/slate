// A booking the API moved to another bucket keeps its old links working (#3672).
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-moved-booking-links-follow.ts
//
// WHAT THIS EXISTS TO STOP. A booking API call naming a different bucket than the
// lead's existing call (#364 at a new time, #1465 at the same one) is honoured by
// `moveToRequestedBucket`, which creates a NEW booking (new id, new manage token) and
// cancels the old one. Every copy of the old token already handed out (the manage
// link in the webhook Regal texts the lead from, the calendar file, a rebook link)
// still named the cancelled row, so the manage page told a lead who still had a call
// "This booking is cancelled". Nothing linked the two rows.
//
// THE RULE (Dan, 2026-10-23): the old links FOLLOW to the booking that replaced it.
// The cancelled row records its successor in the SAME statement that cancels it, and
// the lookup behind the manage page, the calendar file and the rebook route follows
// the chain to its end, bounded, refusing a cycle.
//
// THE CONTROL is a booking cancelled any other way: it records no successor and its
// link still says cancelled, because for that lead it is.
import {
  bookViaApi,
  cancelBooking,
  getBookingByToken,
  MAX_REPLACEMENT_HOPS,
  type ApiBookingInput,
  type BookingContext,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
import type { Booking } from "../src/lib/db/types.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  input,
  CR,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/**
 * A tiny bookings table behind the fake deps, so a token is looked up the way the
 * real read does it (by `manage_token`) and the cancel writes what the real
 * statement writes. The shared fake ignores the token, which is exactly the
 * difference this suite has to see.
 */
function store(deps: BookingDeps, rows: Booking[]) {
  const byId = new Map(rows.map((b) => [b.id, b]));
  const claims: { id: string; replacedBy: string | undefined }[] = [];
  const ctxOf = (b: Booking | undefined): BookingContext | null =>
    b ? { booking: { ...b }, bucket, eventType } : null;
  deps.loadBookingContext = async (token) => ctxOf([...byId.values()].find((b) => b.manage_token === token));
  deps.loadBookingById = async (id) => ctxOf(byId.get(id));
  deps.claimCancellation = async (id: string, replacedBy?: string) => {
    claims.push({ id, replacedBy });
    const row = byId.get(id);
    if (!row || (row.status !== "confirmed" && row.status !== "rescheduled")) return false;
    // ONE write: the status and the successor land together or not at all.
    byId.set(id, { ...row, status: "cancelled", replaced_by_booking_id: replacedBy ?? null });
    return true;
  };
  return {
    claims,
    put: (b: Booking) => byId.set(b.id, b),
    get: (id: string) => byId.get(id),
  };
}

/** The lead's existing call, in a bucket other than the one the request names. */
function oldBooking(over: Partial<Booking> = {}): Booking {
  return makeBooking({
    id: "bk-old",
    external_id: "ext-1",
    bucket_id: "bkt-OLD",
    manage_token: "tok-old",
    starts_at: "2026-06-08T13:00:00.000Z",
    replaced_by_booking_id: null,
    ...over,
  });
}

async function moveByApi(startIso: string) {
  const existing = oldBooking();
  const { deps } = makeDeps({ personBookings: [existing], existing: { booking: existing, bucket, eventType } });
  const db = store(deps, [existing]);
  const apiInput: ApiBookingInput = { ...input, startIso, externalId: "ext-1", confirmReschedule: false };
  const res = await bookViaApi(apiInput, deps);
  // The new row is what the create wrote; the table holds it from here on.
  db.put(res.booking);
  return { deps, db, res };
}

async function run() {
  // --- both arms of the move: the old token opens the NEW booking ----------------
  for (const [label, startIso] of [
    ["a move to a new time (#364)", "2026-06-09T14:00:00.000Z"],
    ["a move at the same time (#1465)", "2026-06-08T13:00:00.000Z"],
  ] as const) {
    const { deps, db, res } = await moveByApi(startIso);
    assert(res.outcome === "rescheduled", `${label}: the API answers rescheduled (got ${res.outcome})`);
    const newId = res.booking.id;
    const newToken = res.booking.manage_token;
    assert(newId !== "bk-old" && newToken !== "tok-old", `${label}: the move made a new booking under a new token`);

    // The successor is written by the cancel itself, never by a second write after it.
    assert(
      db.claims.length === 1 && db.claims[0].id === "bk-old" && db.claims[0].replacedBy === newId,
      `${label}: the cancel of the old booking names its successor in the same statement (got ${JSON.stringify(db.claims)})`,
    );
    assert(
      db.get("bk-old")?.status === "cancelled" && db.get("bk-old")?.replaced_by_booking_id === newId,
      `${label}: the old row is cancelled AND points at the new one`,
    );

    // The lookup behind the manage page and the calendar file (and the rebook
    // route, which hands a replaced row to it).
    const opened = await getBookingByToken("tok-old", deps);
    assert(opened !== null, `${label}: the old token still opens something`);
    assert(
      opened?.booking.id === newId && opened.booking.status !== "cancelled",
      `${label}: the old token opens the LIVE booking, not "cancelled" (got ${opened?.booking.id} ${opened?.booking.status})`,
    );
    assert(
      opened?.followedToToken === newToken,
      `${label}: and says which token it followed to, so the page can open it (got ${opened?.followedToToken})`,
    );

    // The new token is an ordinary booking: nothing followed.
    const direct = await getBookingByToken(newToken, deps);
    assert(
      direct?.booking.id === newId && direct.followedToToken === undefined,
      `${label}: the new token opens its own booking with nothing followed`,
    );
  }

  // --- CONTROL: a booking cancelled any other way still says cancelled -----------
  {
    const b = oldBooking({ bucket_id: "bkt1" });
    const { deps } = makeDeps({ existing: { booking: b, bucket, eventType } });
    const db = store(deps, [b]);
    await cancelBooking("tok-old", CR, "customer", deps);
    assert(
      db.claims.length === 1 && db.claims[0].replacedBy === undefined,
      "control: a lead's own cancel records no successor",
    );
    assert(db.get("bk-old")?.replaced_by_booking_id === null, "control: the row points at nothing");
    const opened = await getBookingByToken("tok-old", deps);
    assert(
      opened?.booking.id === "bk-old" && opened.booking.status === "cancelled" && opened.followedToToken === undefined,
      "control: its link still opens the cancelled booking itself",
    );
  }

  // --- the chain: followed through repeated moves, bounded, never round a loop ---
  const chainWorld = (rows: Booking[]) => {
    const { deps } = makeDeps({});
    store(deps, rows);
    return deps;
  };
  const moved = (id: string, to: string | null) =>
    makeBooking({ id, manage_token: `tok-${id}`, status: "cancelled", replaced_by_booking_id: to });
  {
    // Moved twice: A to B to C, and C is the call the lead has.
    const deps = chainWorld([
      moved("a", "b"),
      moved("b", "c"),
      makeBooking({ id: "c", manage_token: "tok-c", status: "rescheduled", replaced_by_booking_id: null }),
    ]);
    const opened = await getBookingByToken("tok-a", deps);
    assert(
      opened?.booking.id === "c" && opened.followedToToken === "tok-c",
      `a booking moved twice: the first token opens the last booking (got ${opened?.booking.id})`,
    );
  }
  {
    // The successor was itself cancelled by the lead: follow to it, and it says so.
    const deps = chainWorld([
      moved("a", "b"),
      makeBooking({ id: "b", manage_token: "tok-b", status: "cancelled", replaced_by_booking_id: null }),
    ]);
    const opened = await getBookingByToken("tok-a", deps);
    assert(
      opened?.booking.id === "b" && opened.booking.status === "cancelled" && opened.followedToToken === "tok-b",
      "a successor the lead cancelled since: the old token opens THAT booking, cancelled",
    );
  }
  {
    // A loop never comes from a move (the successor is always brand new), so one
    // is a corrupt row: refused, never walked forever, never a guess at which to show.
    const deps = chainWorld([moved("a", "b"), moved("b", "a")]);
    assert((await getBookingByToken("tok-a", deps)) === null, "a cycle is refused, not followed");
  }
  {
    // A chain longer than the bound is refused rather than walked.
    const ids = Array.from({ length: MAX_REPLACEMENT_HOPS + 2 }, (_, i) => `n${i}`);
    const rows = ids.map((id, i) => (i === ids.length - 1
      ? makeBooking({ id, manage_token: `tok-${id}`, status: "confirmed", replaced_by_booking_id: null })
      : moved(id, ids[i + 1])));
    const deps = chainWorld(rows);
    let reads = 0;
    const byId = deps.loadBookingById;
    deps.loadBookingById = async (id) => {
      reads += 1;
      return byId(id);
    };
    assert((await getBookingByToken("tok-n0", deps)) === null, "a chain past the bound is refused");
    assert(reads <= MAX_REPLACEMENT_HOPS, `and stops reading at the bound (${reads} reads)`);
    // Exactly at the bound is still followed.
    const atBound = ids.slice(0, MAX_REPLACEMENT_HOPS + 1);
    const okRows = atBound.map((id, i) => (i === atBound.length - 1
      ? makeBooking({ id, manage_token: `tok-${id}`, status: "confirmed", replaced_by_booking_id: null })
      : moved(id, atBound[i + 1])));
    const ok = await getBookingByToken("tok-n0", chainWorld(okRows));
    assert(ok?.booking.id === atBound[atBound.length - 1], `a chain of exactly ${MAX_REPLACEMENT_HOPS} moves is followed`);
  }
  {
    // A successor that cannot be read is not answered with the cancelled row, which
    // is the very sentence this fixes; it reads as not found, as a failed read of
    // the token itself always has.
    const deps = chainWorld([moved("a", "gone")]);
    assert((await getBookingByToken("tok-a", deps)) === null, "an unreadable successor is not shown as cancelled");
  }
  {
    // Only a CANCELLED row is followed: a live booking is always its own answer.
    const deps = chainWorld([
      makeBooking({ id: "a", manage_token: "tok-a", status: "confirmed", replaced_by_booking_id: "b" }),
      makeBooking({ id: "b", manage_token: "tok-b", status: "confirmed", replaced_by_booking_id: null }),
    ]);
    const opened = await getBookingByToken("tok-a", deps);
    assert(opened?.booking.id === "a" && opened.followedToToken === undefined, "a live booking is never followed away from");
  }

  finish();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
