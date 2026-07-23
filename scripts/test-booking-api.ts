// The key-authed booking API: bookViaApi, preview, lookup, list, cancel, routing traces.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-api.ts
import {
  createBooking,
  cancelBooking,
  bookViaApi,
  previewBooking,
  checkBookable,
  nearestSlots,
  lookupPersonBookings,
  getPersonBookingById,
  cancelDirectBooking,
  listBookings,
  processPendingEventDeletions,
  PENDING_DELETION_ALERT_AFTER,
  BookingNotFoundError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
  type ApiBookingInput,
  type PendingEventDeletion,
} from "../src/lib/booking/orchestration.ts";
import type {
  Bucket,
} from "../src/lib/db/types.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  input,
  NOW,
  CR,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- bookViaApi: no existing appointment -> create (#357) ---
  {
    const apiInput: ApiBookingInput = { ...input, externalId: "ext-new", confirmReschedule: false };
    const { deps, calls } = makeDeps({ personBookings: [] });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "created", "bookViaApi: no match -> created");
    assert(calls.createEvent.length === 1, "bookViaApi create: a calendar event was created");
  }

  // --- bookViaApi: same person, SAME slot -> dedupe (no new booking) ---
  {
    const existingB = makeBooking({ id: "bk-existing", external_id: "ext-1", manage_token: "tokX" });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: existingB.starts_at,
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({ personBookings: [existingB] });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "deduped", "bookViaApi: external_id + same slot -> deduped");
    assert(res.booking.id === "bk-existing", "bookViaApi dedupe: returns the existing booking");
    assert(calls.createEvent.length === 0, "bookViaApi dedupe: creates no new calendar event");
  }

  // --- bookViaApi: same person (strong id), DIFFERENT time -> auto-reschedule ---
  {
    const existingB = makeBooking({ id: "bk-existing", external_id: "ext-1", starts_at: "2026-06-08T13:00:00.000Z" });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: "2026-06-09T14:00:00.000Z",
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({
      personBookings: [existingB],
      existing: { booking: existingB, bucket, eventType },
    });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "rescheduled", "bookViaApi: strong match + new time -> rescheduled");
    assert(
      res.booking.starts_at === "2026-06-09T14:00:00.000Z",
      "bookViaApi reschedule: moved to the requested time",
    );
    assert(
      calls.webhooks.some((w) => w.event === "booking.rescheduled"),
      "bookViaApi reschedule: emits booking.rescheduled",
    );
  }

  // --- bookViaApi: CROSS-BUCKET rebook -> move to the new bucket (#364) ---
  {
    // Existing appointment in a DIFFERENT bucket than the incoming request
    // (resolveBucketByCode resolves to bkt1; the existing booking is in bkt-OLD).
    const existingB = makeBooking({
      id: "bk-existing",
      external_id: "ext-1",
      bucket_id: "bkt-OLD",
      starts_at: "2026-06-08T13:00:00.000Z",
    });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: "2026-06-09T14:00:00.000Z",
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({
      personBookings: [existingB],
      existing: { booking: existingB, bucket, eventType },
    });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "rescheduled", "bookViaApi cross-bucket -> rescheduled outcome");
    assert(
      res.booking.id === "bk-new",
      "bookViaApi cross-bucket: returns the NEW booking created in the new bucket",
    );
    assert(
      calls.webhooks.some((w) => w.event === "booking.created"),
      "bookViaApi cross-bucket: a new booking is created in the target bucket",
    );
    assert(
      calls.webhooks.some((w) => w.event === "booking.cancelled"),
      "bookViaApi cross-bucket: the old appointment is cancelled",
    );
  }

  // --- bookViaApi: WEAK match (email only), different time -> confirm_required ---
  {
    const existingB = makeBooking({
      id: "bk-existing",
      external_id: null,
      salesforce_id: "sf-other",
      attendee_email: "k@x.com",
      attendee_phone: "+19999999999",
      starts_at: "2026-06-08T13:00:00.000Z",
    });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: "2026-06-09T14:00:00.000Z",
      externalId: "ext-new",
      salesforceId: "sf-different",
      attendee: { name: "Kris", email: "k@x.com", phone: "+12035615295" },
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({ personBookings: [existingB] });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "confirm_required", "bookViaApi: weak match + new time -> confirm_required");
    assert(
      calls.createEvent.length === 0 && calls.commitReschedule.length === 0,
      "bookViaApi confirm_required: makes NO changes (no silent move of the wrong person)",
    );
  }

  // --- previewBooking (#380 dry run): preview WITHOUT any side effects ---
  {
    // No existing booking -> would create; returns the would-be agent, writes nothing.
    const dry: ApiBookingInput = { ...input, externalId: "ext-dry", confirmReschedule: false };
    const { deps, calls } = makeDeps({ personBookings: [] });
    const preview = await previewBooking(dry, deps);
    assert(preview.dryRun === true && preview.outcome === "created", "previewBooking: no match -> would create");
    assert(preview.wouldAssign?.email === "a@x.com", "previewBooking: returns the agent who WOULD be assigned");
    assert(
      calls.createEvent.length === 0 && calls.webhooks.length === 0,
      "previewBooking: creates NO calendar event and fires NO webhook",
    );
    assert(
      calls.roundRobinPreview.at(-1) === true,
      "previewBooking: routes in PREVIEW mode (so it skips the #321 shadow-study log + unfair-ordering alert)",
    );
  }
  {
    // Existing same-slot match -> would dedupe; no routing, no writes.
    const existingB = makeBooking({ id: "bk-existing", external_id: "ext-1", manage_token: "tokX" });
    const dry: ApiBookingInput = {
      ...input,
      startIso: existingB.starts_at,
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({ personBookings: [existingB] });
    const preview = await previewBooking(dry, deps);
    assert(preview.outcome === "deduped", "previewBooking: same slot -> would dedupe");
    assert(preview.existingBookingId === "bk-existing", "previewBooking dedupe: names the existing booking");
    assert(calls.createEvent.length === 0, "previewBooking dedupe: no side effects");
  }
  {
    // Empty pool -> the dry run still surfaces the routing failure.
    const dry: ApiBookingInput = { ...input, externalId: "ext-dry2", confirmReschedule: false };
    const { deps } = makeDeps({ personBookings: [], candidates: [] });
    let err: unknown;
    try {
      await previewBooking(dry, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof NoEligibleAgentsError, "previewBooking: surfaces NoEligibleAgentsError for a dead bucket");
  }

  // --- checkBookable (#1017): identity-free validate-only "is this time bookable?" ---
  {
    // A bucket with a free agent -> bookable:true, names who WOULD be assigned, writes nothing.
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const r = await checkBookable({ bucketCode: "411", startIso: input.startIso }, deps);
    assert(r.bookable === true && r.reason === "available", "checkBookable: free slot -> bookable");
    assert(r.wouldAssign?.email === "a@x.com", "checkBookable: returns the agent who WOULD be assigned");
    assert(
      r.effectiveBucketCode === "411" && r.tierFallback === false && r.rungsDropped === 0,
      "checkBookable: effective bucket = requested when the top tier serves",
    );
    assert(
      calls.createEvent.length === 0 && calls.webhooks.length === 0,
      "checkBookable: creates NO calendar event and fires NO webhook",
    );
  }
  {
    // Candidates exist but none free -> bookable:false slot_taken (a normal 200 answer, not an error).
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set() });
    const r = await checkBookable({ bucketCode: "411", startIso: input.startIso }, deps);
    assert(r.bookable === false && r.reason === "slot_taken", "checkBookable: no free agent -> not bookable (slot_taken)");
    assert(r.wouldAssign === null, "checkBookable: no agent named on a not-bookable answer");
  }
  {
    // Empty pool -> bookable:false no_eligible_agents.
    const { deps } = makeDeps({ candidates: [] });
    const r = await checkBookable({ bucketCode: "411", startIso: input.startIso }, deps);
    assert(
      r.bookable === false && r.reason === "no_eligible_agents",
      "checkBookable: empty pool -> not bookable (no_eligible_agents)",
    );
  }
  {
    // Unknown bucket -> UnknownBucketError (the route maps this to 422).
    const { deps } = makeDeps({ unknownBucket: true });
    let err: unknown;
    try {
      await checkBookable({ bucketCode: "999", startIso: input.startIso }, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof UnknownBucketError, "checkBookable: an unknown bucket throws UnknownBucketError");
  }
  {
    // A hidden smoke-test bucket is invisible when test buckets are disallowed.
    const { deps } = makeDeps({ testBucket: true });
    let err: unknown;
    try {
      await checkBookable({ bucketCode: "411", startIso: input.startIso, allowTestBuckets: false }, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof UnknownBucketError, "checkBookable: a test bucket is invisible when test buckets are disallowed");
  }
  {
    // A verify outage must surface transiently, NEVER as a false "not bookable".
    const { deps } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(),
      unverifiedEmails: new Set(["a@x.com"]),
    });
    let err: unknown;
    try {
      await checkBookable({ bucketCode: "411", startIso: input.startIso }, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof VerifyUnavailableError,
      "checkBookable: a verify outage surfaces transiently (never a false not-bookable)",
    );
  }

  {
    // #1017 regression: a dry-run preview must cascade the SAME way the real book
    // does. Requested tier "411" is empty; a lower rung "311" has a free agent.
    // Before the fix previewBooking used a plain single-bucket assign and wrongly
    // reported the bucket dead; now it routes through the tier cascade.
    const bucket311 = { ...bucket, id: "bkt311", code: "311" } as unknown as Bucket;
    const dry: ApiBookingInput = { ...input, externalId: "ext-cascade", confirmReschedule: false };
    const { deps, calls } = makeDeps({ personBookings: [], freeEmails: new Set(["a@x.com"]) });
    let rr = 0;
    deps.roundRobinCandidates = async () => (++rr === 1 ? [] : ["a"]);
    deps.resolveBucketByCode = async (code: string) =>
      code === "411" ? { bucket, eventType } : code === "311" ? { bucket: bucket311, eventType } : null;
    const preview = await previewBooking(dry, deps);
    assert(
      preview.outcome === "created" && preview.wouldAssign?.email === "a@x.com",
      "previewBooking: cascades to a lower tier (matches the real book) instead of reporting the bucket dead",
    );
    assert(
      calls.createEvent.length === 0 && calls.webhooks.length === 0,
      "previewBooking cascade: still writes nothing",
    );
  }
  {
    // checkBookable cascades too: requested tier busy -> served by a lower rung,
    // with tier_fallback + rungsDropped reported and the effective bucket named.
    const bucket311 = { ...bucket, id: "bkt311", code: "311" } as unknown as Bucket;
    const { deps } = makeDeps({ freeEmails: new Set(["a@x.com"]) });
    let rr = 0;
    deps.roundRobinCandidates = async () => (++rr === 1 ? [] : ["a"]);
    deps.resolveBucketByCode = async (code: string) =>
      code === "411" ? { bucket, eventType } : code === "311" ? { bucket: bucket311, eventType } : null;
    const r = await checkBookable({ bucketCode: "411", startIso: input.startIso }, deps);
    assert(
      r.bookable === true && r.effectiveBucketCode === "311" && r.tierFallback === true && r.rungsDropped === 1,
      "checkBookable: cascades to the lower tier and reports the fallback",
    );
  }

  // --- nearestSlots (#1017): before/after hints from the cached slot list ---
  {
    const slots = [
      "2026-06-10T13:00:00.000Z",
      "2026-06-10T15:00:00.000Z",
      "2026-06-10T17:00:00.000Z",
    ];
    const around = "2026-06-10T15:00:00.000Z"; // exact match is skipped, not returned
    const r = nearestSlots(slots, around);
    assert(r.before === "2026-06-10T13:00:00.000Z", "nearestSlots: nearest slot strictly before");
    assert(r.after === "2026-06-10T17:00:00.000Z", "nearestSlots: nearest slot strictly after");
  }
  {
    // Unsorted input + an unparseable entry; nothing after the requested time.
    const slots = ["2026-06-10T17:00:00.000Z", "not-a-date", "2026-06-10T09:00:00.000Z", "2026-06-10T13:00:00.000Z"];
    const r = nearestSlots(slots, "2026-06-10T18:00:00.000Z");
    assert(r.before === "2026-06-10T17:00:00.000Z", "nearestSlots: picks the closest earlier slot from an unsorted list");
    assert(r.after === null, "nearestSlots: null when no slot is after the requested time");
  }
  {
    const r = nearestSlots([], "2026-06-10T18:00:00.000Z");
    assert(r.before === null && r.after === null, "nearestSlots: empty slot list -> no hints");
  }

  // --- bookViaApi: WEAK match but bot confirmed -> reschedule ---
  {
    const existingB = makeBooking({
      id: "bk-existing",
      external_id: null,
      salesforce_id: "sf-other",
      attendee_email: "k@x.com",
      attendee_phone: "+19999999999",
      starts_at: "2026-06-08T13:00:00.000Z",
    });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: "2026-06-09T14:00:00.000Z",
      externalId: "ext-new",
      salesforceId: "sf-different",
      attendee: { name: "Kris", email: "k@x.com", phone: "+12035615295" },
      confirmReschedule: true,
    };
    const { deps } = makeDeps({
      personBookings: [existingB],
      existing: { booking: existingB, bucket, eventType },
    });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "rescheduled", "bookViaApi: weak match + confirmReschedule -> rescheduled");
  }

  // --- lookupPersonBookings (#386): maps active rows to API views ---
  {
    const bk = makeBooking({ id: "bkL", external_id: "ext-1", salesforce_id: "sf-9" });
    const { deps } = makeDeps({ personBookings: [bk] });
    const views = await lookupPersonBookings(
      { externalId: "ext-1", salesforceId: null, email: null, phone: null },
      deps,
    );
    assert(views.length === 1 && views[0].id === "bkL", "lookup returns one view");
    assert(views[0].manageUrl === "https://slate.test/booking/manage/tok1", "lookup view has manageUrl");
    assert(views[0].externalId === "ext-1" && views[0].status === "confirmed", "lookup view fields mapped");
  }

  // --- getPersonBookingById (#386) ---
  {
    const bk = makeBooking({ id: "bkG", external_id: "ext-1", status: "cancelled" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps } = makeDeps({ bookingById: ctx });
    const view = await getPersonBookingById(
      { bookingId: "bkG", identity: { externalId: "ext-1", salesforceId: null }, status: null },
      deps,
    );
    assert(view.id === "bkG" && view.status === "cancelled", "get-by-id returns any status when no filter");

    let threw = false;
    try {
      await getPersonBookingById(
        { bookingId: "bkG", identity: { externalId: "ext-1", salesforceId: null }, status: "confirmed" },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "get-by-id status filter mismatch → BookingNotFoundError");

    let threwOwner = false;
    try {
      await getPersonBookingById(
        { bookingId: "bkG", identity: { externalId: "stranger", salesforceId: null }, status: null },
        deps,
      );
    } catch (e) { threwOwner = e instanceof BookingNotFoundError; }
    assert(threwOwner, "get-by-id wrong owner → BookingNotFoundError");
  }
  {
    const { deps } = makeDeps({ bookingById: null });
    let threw = false;
    try {
      await getPersonBookingById(
        { bookingId: "nope", identity: { externalId: "ext-1", salesforceId: null }, status: null },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "get-by-id missing booking → BookingNotFoundError");
  }

  // --- #401: cancel enqueues the event deletion when Google delete fails ---
  {
    const bk = makeBooking({ id: "bkX", status: "confirmed", gcal_event_id: "gE", agent_email: "a@x.com" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, deleteEventThrows: true });
    await cancelBooking("tok1", CR, "customer", deps, NOW);
    assert(calls.enqueueEventDeletion.length === 1, "cancel enqueues a deletion when deleteEvent fails");
    assert(calls.enqueueEventDeletion[0].eventId === "gE" && calls.enqueueEventDeletion[0].bookingId === "bkX",
      "enqueue carries the event id + booking id");
  }
  {
    // success path: no enqueue
    const bk = makeBooking({ id: "bkY", status: "confirmed", gcal_event_id: "gE2", agent_email: "a@x.com" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", CR, "customer", deps, NOW);
    assert(calls.enqueueEventDeletion.length === 0, "cancel does NOT enqueue when deleteEvent succeeds");
  }

  // --- cancelDirectBooking (#386) ---
  {
    const bk = makeBooking({ id: "bkC", external_id: "ext-1", status: "confirmed", gcal_event_id: "g1" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, existing: ctx });
    const view = await cancelDirectBooking(
      { bookingId: "bkC", identity: { externalId: "ext-1", salesforceId: null }, reason: { code: "api_cancellation", detail: null } },
      deps,
    );
    assert(view.status === "cancelled", "cancel returns the cancelled view");
    // #402: assert the calendar side effect, not just the API verdict, a cancel
    // that returns {cancelled} but skips the gcal delete is exactly the #401
    // orphan bug. The booking's event id is "g1".
    assert(calls.deleteEvent.some((d) => d.id === "g1"), "cancel actually deletes the agent's calendar event");
    assert(calls.webhooks.some((w) => w.event === "booking.cancelled"), "cancel fires booking.cancelled");
    assert(calls.bookingEvents.some((e) => e.action === "cancelled" && e.initiator === "customer"),
      "cancel records a customer-initiated history row");
  }
  {
    const bk = makeBooking({ id: "bkD", external_id: "ext-1", status: "completed" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps } = makeDeps({ bookingById: ctx });
    let threw = false;
    try {
      await cancelDirectBooking(
        { bookingId: "bkD", identity: { externalId: "ext-1", salesforceId: null }, reason: { code: "api_cancellation", detail: null } },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "cancel of a non-active booking → BookingNotFoundError");
  }
  {
    // Concurrent double-cancel (#398): both callers pass the active pre-check,
    // but the loser re-reads an already-cancelled row inside cancelBooking. It
    // must surface 404, not a second 200 { cancelled }.
    const active = makeBooking({ id: "bkE", external_id: "ext-1", status: "confirmed", gcal_event_id: "g1" });
    const cancelled = makeBooking({ id: "bkE", external_id: "ext-1", status: "cancelled", gcal_event_id: "g1" });
    const { deps, calls } = makeDeps({
      bookingById: { booking: active, bucket, eventType },   // pre-check sees active
      existing: { booking: cancelled, bucket, eventType },   // cancelBooking re-load sees cancelled
    });
    let threw = false;
    try {
      await cancelDirectBooking(
        { bookingId: "bkE", identity: { externalId: "ext-1", salesforceId: null }, reason: { code: "api_cancellation", detail: null } },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "concurrent double-cancel: losing racer → BookingNotFoundError (not 200)");
    assert(calls.webhooks.length === 0, "losing racer fires no second booking.cancelled webhook");
  }

  {
    // Atomic double-cancel (#413): BOTH callers load an active context (neither
    // saw the other's write), so the read-then-write guard can't separate them.
    // The atomic claim must: exactly one wins (true), the other loses (false),
    // and the side effects (webhook, history) fire exactly once.
    const active = makeBooking({ id: "bkRace", status: "confirmed", gcal_event_id: "g1" });
    const ctx = { booking: active, bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    const first = await cancelBooking("tokRace", CR, "customer", deps, NOW);
    const second = await cancelBooking("tokRace", CR, "customer", deps, NOW);
    assert(first === true, "atomic cancel: first caller wins the claim (true)");
    assert(second === false, "atomic cancel: second caller loses the claim (false), not a second success");
    assert(calls.webhooks.filter((w) => w.event === "booking.cancelled").length === 1,
      "atomic cancel: booking.cancelled fires exactly once");
    assert(calls.bookingEvents.filter((e) => e.action === "cancelled").length === 1,
      "atomic cancel: exactly one cancelled history row");
  }

  // --- listBookings (#392) ---
  {
    const b1 = makeBooking({ id: "L1", bucket_id: "bkt1", starts_at: "2026-06-08T13:00:00.000Z" });
    const b2 = makeBooking({ id: "L2", bucket_id: "bkt1", starts_at: "2026-06-08T14:00:00.000Z" });
    const { deps, calls } = makeDeps({ listResult: { rows: [b1, b2], buckets: [bucket] } });
    const res = await listBookings(
      { status: "confirmed", afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: null, agentEmail: null, limit: 2, offset: 0 },
      deps,
    );
    assert(res.items.length === 2 && res.items[0].id === "L1", "list returns the rows as views");
    assert(res.items[0].bucketCode === "411", "list item carries bucketCode from the buckets join");
    assert(res.nextCursor !== null, "full page (rows == limit) sets a nextCursor");
    assert((calls.queryBookings[0] as { orderBy: string }).orderBy === "starts_at",
      "default order is starts_at");
  }
  {
    const b1 = makeBooking({ id: "L3", bucket_id: "bkt1" });
    const { deps } = makeDeps({ listResult: { rows: [b1], buckets: [bucket] } });
    const res = await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: null, agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert(res.nextCursor === null, "partial page (rows < limit) -> nextCursor null");
  }
  {
    // updatedSince switches the order key
    const { deps, calls } = makeDeps({ listResult: { rows: [], buckets: [] } });
    await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: "2026-06-01T00:00:00Z",
        bucketCode: null, agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert((calls.queryBookings[0] as { orderBy: string }).orderBy === "updated_at",
      "updatedSince selects updated_at order");
  }
  {
    // unknown bucket -> empty, no queryBookings scan
    const { deps, calls } = makeDeps({ unknownBucket: true });
    const res = await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: "999", agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert(res.items.length === 0 && res.nextCursor === null, "unknown bucket -> empty page");
    assert(calls.queryBookings.length === 0, "unknown bucket -> no DB scan");
  }
  // --- routing_trace explainability stamping: excluded + tier fields on a criteria bucket ---
  // Asserts the core wiring added in feat/routing-explainability: a successful booking
  // stamps all explainability fields on the persisted booking's routing_trace.
  // recordRoutingDecision is injected through BookingDeps (#504), so its
  // invocation is asserted directly below (payload derived from the same
  // routing_trace fields checked here), not only inferred from the trace.
  {
    const criteriasBucket = {
      ...bucket,
      criteria: { debt_team: "T1" },
    } as unknown as Bucket;
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    // Override resolveBucketByCode to return a bucket with debt_team criteria.
    // Plan 2: requested_tier is now derived from tierKeyOf(input.bucketCode), not criteria.
    deps.resolveBucketByCode = async () => ({ bucket: criteriasBucket, eventType });
    const res = await createBooking(input, deps);

    const rt = res.booking.routing_trace;
    assert(
      rt != null && Array.isArray(rt.excluded),
      "routing_trace: excluded is present and is an array on a successful booking",
    );
    assert(
      rt?.requested_tier === "very_high",
      "routing_trace: requested_tier reflects the tier key for bucketCode '411' (very_high)",
    );
    assert(
      rt?.tier_fallback === false,
      "routing_trace: tier_fallback is false on a normal direct booking",
    );
    assert(
      rt?.rungs_dropped === 0,
      "routing_trace: rungs_dropped is 0 on a normal direct booking",
    );
    assert(
      rt?.chosen_user_id === "a",
      "routing_trace: chosen_user_id matches the assigned agent",
    );
    // The booking must still complete successfully and fire the creation webhook.
    assert(
      res.booking.id === "bk-new" && calls.webhooks.some((w) => w.event === "booking.created"),
      "routing_trace: booking succeeds and booking.created fires (recordRoutingDecision is best-effort, does not block)",
    );
    // #504: the decision-log call is now observable directly. Its payload mirrors
    // the routing_trace fields asserted above (requested_tier, tier_fallback, etc.).
    const dec = calls.recordRoutingDecision.at(-1);
    assert(
      dec != null &&
        dec.outcome === "booked" &&
        dec.bookingId === res.booking.id &&
        dec.chosenUserId === "a" &&
        dec.requestedTier === "very_high" &&
        dec.tierFallback === false &&
        dec.rungsDropped === 0,
      "routing_trace: records a 'booked' decision whose payload matches the stamped trace",
    );
  }

  // --- routing_trace explainability: no-criteria bucket still gets requested_tier from tierKeyOf ---
  {
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    // Plan 2: requested_tier comes from tierKeyOf(bucketCode), not criteria.
    // bucketCode "411" -> "very_high" regardless of whether the bucket has criteria.
    const res = await createBooking(input, deps);
    const rt = res.booking.routing_trace;
    assert(
      rt != null && "requested_tier" in (rt as object) && rt?.requested_tier === "very_high",
      "routing_trace: requested_tier is tier key (very_high) for '411' even with no criteria",
    );
    assert(
      rt?.tier_fallback === false && rt?.rungs_dropped === 0,
      "routing_trace: tier_fallback and rungs_dropped are set to defaults when no criteria",
    );
  }

  // --- tier-drop cascade (Plan 2 Task 5): requested bucket empty -> cascade to lower tier ---
  {
    // "411" is the requested bucket (very_high tier). Make it appear empty so the cascade
    // drops one rung to "311" (high tier), which has a free agent.
    const bucket311 = { ...bucket, id: "bkt311", code: "311" } as unknown as Bucket;
    const { deps, calls } = makeDeps({ freeEmails: new Set(["a@x.com"]) });
    let rrCallCount = 0;
    // First roundRobinCandidates call is for "411" (no candidates), second for "311" (agent a).
    deps.roundRobinCandidates = async () => {
      rrCallCount++;
      return rrCallCount === 1 ? [] : ["a"];
    };
    deps.resolveBucketByCode = async (code: string) => {
      if (code === "411") return { bucket, eventType };
      if (code === "311") return { bucket: bucket311, eventType };
      return null;
    };
    const res = await createBooking(input, deps);
    const rt = res.booking.routing_trace;
    assert(rt?.tier_fallback === true, "tier-drop: tier_fallback is true on a cascade booking");
    assert(rt?.rungs_dropped === 1, "tier-drop: rungs_dropped is 1 for a single-rung drop");
    assert(rt?.requested_tier === "very_high", "tier-drop: requested_tier reflects the original bucket code (411 -> very_high)");
    assert(rt?.booked_tier === "high", "tier-drop: booked_tier reflects the lower bucket code (311 -> high)");
    assert(
      (res.booking as unknown as Record<string, unknown>).bucket_id === "bkt311",
      "tier-drop: booking is placed in the lower (booked) bucket, not the requested one",
    );
    // Regression: booking.created webhook must attribute to the BOOKED bucket (311),
    // not the requested one (411). A mismatch here means completeReservation resolved
    // the wrong bucket for fire().
    const tierDropWebhook = calls.webhooks.find((w) => w.event === "booking.created");
    assert(
      tierDropWebhook?.bucket_code === "311",
      `tier-drop: booking.created webhook bucket_code is the booked bucket ("311"), got "${tierDropWebhook?.bucket_code}"`,
    );
  }

  // --- tier-drop: VerifyUnavailableError is NOT a cascade trigger (outage guard) ---
  {
    const { deps } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(),
      unverifiedEmails: new Set(["a@x.com"]),
    });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof VerifyUnavailableError,
      "tier-drop: VerifyUnavailableError propagates without cascading (outage not masked as tier-drop)",
    );
  }

  // --- #401 drain ---
  {
    const rows: PendingEventDeletion[] = [
      { id: "p1", calendar_email: "a@x.com", gcal_event_id: "e1", booking_id: null, attempts: 0, last_error: null, created_at: "2026-06-23T00:00:00.000Z", updated_at: "2026-06-23T00:00:00.000Z" },
      { id: "p2", calendar_email: "b@x.com", gcal_event_id: "e2", booking_id: null, attempts: 0, last_error: null, created_at: "2026-06-23T00:00:00.000Z", updated_at: "2026-06-23T00:00:00.000Z" },
    ];
    const { deps, calls } = makeDeps({ pending: rows }); // deleteEvent succeeds
    const res = await processPendingEventDeletions(deps, 50);
    assert(res.deleted === 2 && res.failed === 0, "drain deletes all and removes them");
    assert(calls.removePendingEventDeletion.length === 2, "successful deletes remove the rows");
  }
  {
    const rows: PendingEventDeletion[] = [{ id: "p3", calendar_email: "a@x.com", gcal_event_id: "e3", booking_id: null, attempts: PENDING_DELETION_ALERT_AFTER - 1, last_error: "x", created_at: "2026-06-23T00:00:00.000Z", updated_at: "2026-06-23T00:00:00.000Z" }];
    const { deps, calls } = makeDeps({ pending: rows, deleteEventThrows: true });
    const res = await processPendingEventDeletions(deps, 50);
    assert(res.failed === 1 && res.deleted === 0, "a failing delete is counted, not removed");
    assert(calls.bumpPendingEventDeletion[0].attempts === PENDING_DELETION_ALERT_AFTER, "bump records attempts+1");
    assert(res.stuck.length === 1, "a row crossing the alert threshold is reported as stuck");
    assert(calls.removePendingEventDeletion.length === 0, "a failing delete is NOT removed");
  }
}

await run();
finish();
