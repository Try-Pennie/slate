// The lookup API resolves a strong id against EITHER id column (#2657).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-lookup-identity.ts
//
// A booking made through the embed (`/book?external_id=<lead id>`) is written with
// the lead's id in `salesforce_id` and `external_id` null: the page maps the query
// value into the Booker's `salesforceId` prop (#2166) and the confirm inserts it
// under that name. A booking made through POST /api/bookings carries whichever ids
// the caller sent. The caller of GET /api/bookings?externalId=… cannot know which
// route made the booking, and `docs/booking-api.md` tells it to send the lead's id
// as `externalId`, so trypennie's booking confirmed page got a 404 for every embed
// booking. The tests for #2647 used an API made booking, which carries BOTH
// columns, so the production call site's shape was never exercised (L718). Every
// fixture here is built the way the embed writes it.
//
// Decided by Dan, 2026-09-24: a supplied strong id matches a booking whose
// `external_id` OR `salesforce_id` equals it, in the by id mode, the list mode
// and the cancel, which asks the same ownership question. A different lead's id
// still gets a 404 or an empty list.
//
// Scoped to those three by #2657. #2663 then took the same rule onto the one call
// per person dedupe (#357); the last block pins that.
import {
  bookViaApi,
  cancelDirectBooking,
  lookupPersonBookings,
  getPersonBookingById,
  BookingNotFoundError,
  type ApiBookingInput,
} from "../src/lib/booking/orchestration.ts";
import { findPersonMatch } from "../src/lib/booking/person-dedupe.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  input,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** The lead id trypennie holds: a Salesforce Lead id, the value `/book?external_id=` carries. */
const LEAD = "00Q5e00000AbCdEEAU";
/** Somebody else's lead id, which must never reach LEAD's booking. */
const STRANGER = "00Q5e00000ZzZzZEAU";

/** A booking exactly as the embed's confirm writes it: the lead id in salesforce_id only. */
const embedBooking = (over: Record<string, unknown> = {}) =>
  makeBooking({ id: "bk-embed", external_id: null, salesforce_id: LEAD, manage_token: "tok-embed", ...over });
/** The mirror: an API caller that sent only externalId. */
const apiBooking = (over: Record<string, unknown> = {}) =>
  makeBooking({ id: "bk-api", external_id: LEAD, salesforce_id: null, manage_token: "tok-api", ...over });

async function expectNotFound(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (e) {
    return e instanceof BookingNotFoundError;
  }
}

async function run() {
  // --- By id mode: GET /api/bookings?externalId=<lead>&bookingId=<id> ---
  {
    const { deps } = makeDeps({ bookingById: { booking: embedBooking(), bucket, eventType } });
    const view = await getPersonBookingById(
      { bookingId: "bk-embed", identity: { externalId: LEAD, salesforceId: null }, status: null },
      deps,
    );
    assert(view.id === "bk-embed", "by id: externalId alone finds an embed booking, whose lead id sits in salesforce_id");
    assert(view.salesforceId === LEAD && view.externalId === null, "by id: the view reports the columns as stored");
  }
  {
    const { deps } = makeDeps({ bookingById: { booking: apiBooking(), bucket, eventType } });
    const view = await getPersonBookingById(
      { bookingId: "bk-api", identity: { externalId: null, salesforceId: LEAD }, status: null },
      deps,
    );
    assert(view.id === "bk-api", "by id: salesforceId alone finds a booking whose id sits in external_id");
  }
  {
    const { deps } = makeDeps({ bookingById: { booking: embedBooking(), bucket, eventType } });
    assert(
      await expectNotFound(() =>
        getPersonBookingById(
          { bookingId: "bk-embed", identity: { externalId: STRANGER, salesforceId: null }, status: null },
          deps,
        ),
      ),
      "by id: a different lead's externalId is refused with not found",
    );
    assert(
      await expectNotFound(() =>
        getPersonBookingById(
          { bookingId: "bk-embed", identity: { externalId: STRANGER, salesforceId: STRANGER }, status: null },
          deps,
        ),
      ),
      "by id: a different lead's id in both fields is still refused",
    );
    assert(
      await expectNotFound(() =>
        getPersonBookingById(
          { bookingId: "bk-embed", identity: { externalId: null, salesforceId: null }, status: null },
          deps,
        ),
      ),
      "by id: no strong id at all proves nothing and is refused",
    );
  }
  {
    // The status assertion still applies after the wider ownership match.
    const { deps } = makeDeps({ bookingById: { booking: embedBooking({ status: "cancelled" }), bucket, eventType } });
    assert(
      await expectNotFound(() =>
        getPersonBookingById(
          { bookingId: "bk-embed", identity: { externalId: LEAD, salesforceId: null }, status: "confirmed" },
          deps,
        ),
      ),
      "by id: an owned embed booking in another status is refused when a status is asserted",
    );
  }

  // --- List mode: GET /api/bookings?externalId=<lead> ---
  {
    const { deps, calls } = makeDeps({ personBookings: [embedBooking()] });
    const views = await lookupPersonBookings({ externalId: LEAD, salesforceId: null }, deps);
    assert(views.length === 1 && views[0].id === "bk-embed", "list: externalId alone lists an embed booking");
    assert(
      calls.findActiveBookingsByStrongIds.length === 1 && calls.findActiveBookingsByStrongIds[0].join() === LEAD,
      "list: the rows were fetched by the lead id against either column, not by external_id alone",
    );
    assert(calls.findActiveBookingsForPerson.length === 0, "list: the dedupe path's person fetch was not used");
  }
  {
    const { deps } = makeDeps({ personBookings: [apiBooking()] });
    const views = await lookupPersonBookings({ externalId: null, salesforceId: LEAD }, deps);
    assert(views.length === 1 && views[0].id === "bk-api", "list: salesforceId alone lists a booking whose id sits in external_id");
  }
  {
    // What the fetch hands back is judged again: a row that matches neither id
    // is never returned, so a fetch that over reads cannot disclose a stranger.
    const { deps } = makeDeps({
      personBookings: [embedBooking(), embedBooking({ id: "bk-stranger", salesforce_id: STRANGER, manage_token: "tok-s" })],
    });
    const views = await lookupPersonBookings({ externalId: LEAD, salesforceId: null }, deps);
    assert(views.map((v) => v.id).join() === "bk-embed", "list: a fetched row belonging to another lead is not returned");
  }
  {
    const { deps } = makeDeps({ personBookings: [embedBooking()] });
    const views = await lookupPersonBookings({ externalId: STRANGER, salesforceId: null }, deps);
    assert(views.length === 0, "list: a different lead's externalId lists nothing");
  }
  {
    // Two different ids: each may sit in either column, blanks are dropped, and
    // a repeated value is asked for once.
    const { deps, calls } = makeDeps({ personBookings: [embedBooking({ salesforce_id: "sf-other" })] });
    const views = await lookupPersonBookings({ externalId: LEAD, salesforceId: "sf-other" }, deps);
    assert(views.length === 1 && views[0].id === "bk-embed", "list: the second supplied id matches on its own");
    assert(calls.findActiveBookingsByStrongIds[0].join() === `${LEAD},sf-other`, "list: both ids were fetched");
    const { deps: deps2, calls: calls2 } = makeDeps({ personBookings: [] });
    await lookupPersonBookings({ externalId: LEAD, salesforceId: LEAD }, deps2);
    assert(calls2.findActiveBookingsByStrongIds[0].join() === LEAD, "list: the same id in both fields is fetched once");
    const { deps: deps3, calls: calls3 } = makeDeps({ personBookings: [] });
    await lookupPersonBookings({ externalId: "  ", salesforceId: null }, deps3);
    assert(calls3.findActiveBookingsByStrongIds.length === 0, "list: a blank id fetches nothing rather than matching a blank column");
  }
  {
    // A failed read must not read as "this lead has no call" (#1641 on this path).
    const { deps } = makeDeps({ personBookingsThrows: true });
    let threw = false;
    try { await lookupPersonBookings({ externalId: LEAD, salesforceId: null }, deps); } catch { threw = true; }
    assert(threw, "list: a failed bookings read throws rather than listing nothing");
  }

  // --- Cancel: DELETE /api/bookings and POST /api/bookings/cancel ---
  // The cancel asks the same ownership question the by id lookup does, so it
  // resolves identity the same way: a caller who can READ an embed booking by
  // externalId can cancel it by the same id (Dan, 2026-09-24).
  const CANCEL = { code: "api_cancellation", detail: null } as const;
  {
    const ctx = { booking: embedBooking({ gcal_event_id: "g-embed" }), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, existing: ctx });
    const view = await cancelDirectBooking(
      { bookingId: "bk-embed", identity: { externalId: LEAD, salesforceId: null }, reason: CANCEL },
      deps,
    );
    assert(view.status === "cancelled", "cancel: externalId alone cancels an embed booking");
    assert(calls.deleteEvent.some((d) => d.id === "g-embed"), "cancel: and the calendar event really goes");
  }
  {
    const ctx = { booking: apiBooking({ gcal_event_id: "g-api" }), bucket, eventType };
    const { deps } = makeDeps({ bookingById: ctx, existing: ctx });
    const view = await cancelDirectBooking(
      { bookingId: "bk-api", identity: { externalId: null, salesforceId: LEAD }, reason: CANCEL },
      deps,
    );
    assert(view.status === "cancelled", "cancel: salesforceId alone cancels a booking whose id sits in external_id");
  }
  {
    const ctx = { booking: embedBooking({ gcal_event_id: "g-embed" }), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, existing: ctx });
    assert(
      await expectNotFound(() =>
        cancelDirectBooking(
          { bookingId: "bk-embed", identity: { externalId: STRANGER, salesforceId: null }, reason: CANCEL },
          deps,
        ),
      ),
      "cancel: a different lead's externalId is refused with not found",
    );
    assert(
      await expectNotFound(() =>
        cancelDirectBooking(
          { bookingId: "bk-embed", identity: { externalId: null, salesforceId: null }, reason: CANCEL },
          deps,
        ),
      ),
      "cancel: no strong id at all is refused",
    );
    assert(calls.deleteEvent.length === 0, "cancel: a refused cancel leaves the calendar event alone");
    assert(!calls.webhooks.some((w) => w.event === "booking.cancelled"), "cancel: and fires no booking.cancelled");
  }

  // --- The dedupe path matches either column too (#2663) ---
  // #2657 pinned the dedupe as column to column and said to delete that block
  // in the change that widened it on purpose. #2663 is that change: an API
  // caller sending only `externalId` now sees the lead's embed booking as the
  // same person by strong id, so a same slot request dedupes instead of booking
  // a second call. The grading itself is driven in scripts/test-person-dedupe.ts.
  {
    const identity = { externalId: LEAD, salesforceId: null, email: null, phone: null };
    const m = findPersonMatch(identity, [embedBooking()]);
    assert(m?.strength === "strong", "dedupe: an externalId only caller grades the embed booking strong");
    assert(
      findPersonMatch({ ...identity, externalId: STRANGER }, [embedBooking()]) === null,
      "dedupe: a different lead's id still matches nothing",
    );
  }
  {
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: embedBooking().starts_at,
      externalId: LEAD,
      salesforceId: null,
      attendee: { name: "Kris", email: "other@x.com", phone: "+12035550000" },
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({ personBookings: [embedBooking()] });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "deduped", "dedupe: bookViaApi with only externalId dedupes onto the embed booking");
    assert(calls.insertBooking.length === 0, "dedupe: and creates no second booking");
    assert(calls.findActiveBookingsByStrongIds.length === 0, "dedupe: bookViaApi still fetches through its own person read");
  }
}

await run();
finish();
