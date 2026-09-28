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
  bookingIcs,
  bookingDetailExtras,
  cancelDirectBooking,
  listBookings,
  processPendingEventDeletions,
  PENDING_DELETION_ALERT_AFTER,
  BookingNotFoundError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  SlotUnavailableError,
  UnknownBucketError,
  RaceLostRefusalError,
  MAX_RACE_REASSIGNS,
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
import { PARTNER_KEYS } from "../src/lib/booking/partner-keys.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- bookViaApi: no existing appointment -> create (#357) ---
  {
    const apiInput: ApiBookingInput = { ...input, externalId: "ext-new", confirmReschedule: false };
    const { deps, calls } = makeDeps({ personBookings: [] });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "created", "bookViaApi: no match -> created");
    assert(calls.createEvent.length === 1, "bookViaApi create: a calendar event was created");
    // #2660: the person decision reads in the world of the bucket being booked,
    // so the canary's SMOKE bookings dedupe against SMOKE2's (both test) and never
    // against a real lead's.
    assert(
      calls.personWorlds.every((w) => w.isTest === false),
      "bookViaApi on a real bucket asks the person decision in the real world",
    );
  }
  {
    const apiInput: ApiBookingInput = {
      ...input,
      externalId: "ext-canary",
      confirmReschedule: false,
      allowTestBuckets: true,
    };
    const { deps, calls } = makeDeps({ personBookings: [], testBucket: true });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "created", "bookViaApi on a test bucket with permission -> created");
    assert(
      calls.personWorlds.length >= 1 && calls.personWorlds.every((w) => w.isTest === true),
      "bookViaApi on a test bucket asks the person decision in the test world",
    );
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

  // --- bookViaApi: SAME TIME, DIFFERENT bucket -> move, not a silent dedupe (#1465) ---
  //
  // A re-tiered lead confirming the time they already hold is the ordinary call:
  // the bot re-books them into the bucket their new debt profile routes to, at
  // the slot they already agreed. That used to come back 200 deduped with the
  // OLD booking in the OLD bucket, so the routing request was dropped and the
  // response said nothing about it. The instant is the same; the TEAM is not.
  {
    const existingB = makeBooking({
      id: "bk-existing",
      external_id: "ext-1",
      bucket_id: "bkt-OLD",
      manage_token: "tokX",
    });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: existingB.starts_at, // the SAME instant
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({
      personBookings: [existingB],
      existing: { booking: existingB, bucket, eventType },
    });
    const res = await bookViaApi(apiInput, deps);
    assert(
      res.outcome === "rescheduled",
      `bookViaApi same-time cross-bucket -> rescheduled (got ${res.outcome})`,
    );
    assert(
      res.booking.id === "bk-new",
      "bookViaApi same-time cross-bucket: returns the NEW booking in the requested bucket",
    );
    assert(
      calls.webhooks.some((w) => w.event === "booking.created"),
      "bookViaApi same-time cross-bucket: created in the target bucket FIRST",
    );
    assert(
      calls.webhooks.some((w) => w.event === "booking.cancelled"),
      "bookViaApi same-time cross-bucket: then the old appointment is cancelled",
    );
    assert(
      res.bucketChangeDeclined === undefined,
      "bookViaApi same-time cross-bucket: nothing was declined on the happy path",
    );
  }

  // --- and the SAME bucket at the same instant is still a plain dedupe ---
  //
  // The other half, or the rule above is satisfied by code that treats every
  // same-instant rebook as a move and quietly rebuilds a booking that was
  // already correct (L1).
  {
    const existingB = makeBooking({ id: "bk-existing", external_id: "ext-1", bucket_id: bucket.id });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: existingB.starts_at,
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({ personBookings: [existingB] });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "deduped", "same instant, same bucket -> still deduped");
    assert(calls.createEvent.length === 0, "and nothing is rebuilt");
  }

  // --- the move cannot be made: say so, never a bare 200 that reads as handled ---
  //
  // The new bucket may have nobody free at that instant, which is a normal "no"
  // rather than an error: the lead still holds a valid appointment, so answering
  // with a failure would say nothing is booked, which is false. It comes back as
  // a dedupe that NAMES the declined bucket change, so the caller can tell that
  // the bucket it asked for is not the bucket the lead is in (L11, L12).
  {
    const existingB = makeBooking({
      id: "bk-existing",
      external_id: "ext-1",
      bucket_id: "bkt-OLD",
      manage_token: "tokX",
    });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: existingB.starts_at,
      externalId: "ext-1",
      confirmReschedule: false,
    };
    // An empty pool in the target bucket, which is the shape the real refusal
    // takes: at the same instant the lead's own booking still holds their current
    // agent, so a bucket whose only free agent is that same person answers no.
    const { deps, calls } = makeDeps({
      personBookings: [existingB],
      existing: { booking: existingB, bucket, eventType },
      candidates: [],
    });

    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "deduped", `a refused move falls back to deduped (got ${res.outcome})`);
    assert(res.booking.id === "bk-existing", "and the lead keeps the appointment they had");
    assert(
      res.bucketChangeDeclined === "no_eligible_agents",
      `the response names WHY the bucket change was dropped (got ${String(res.bucketChangeDeclined)})`,
    );
    assert(
      !calls.webhooks.some((w) => w.event === "booking.cancelled"),
      "and the old appointment is never cancelled when its replacement did not land",
    );
  }

  // --- #2861: a lost overlap race on a cross bucket move reaches the race tally ---
  //
  // The move (#364, #1465) confirms through the same createBooking as a fresh
  // create, so it loses the overlap race the same way. Its refusal used to be
  // folded into a declined bucket change and its rescue into a plain reschedule,
  // so neither half ever reached the daily race whisper (#2838). The result now
  // names the tally row, and only for a booking this call's own insert made.
  {
    const moveFixture = (startIso: string) => {
      const existingB = makeBooking({
        id: "bk-existing",
        external_id: "ext-1",
        bucket_id: "bkt-OLD",
        manage_token: "tokX",
        starts_at: "2026-06-08T13:00:00.000Z",
      });
      const apiInput: ApiBookingInput = { ...input, startIso, externalId: "ext-1", confirmReschedule: false };
      return { existingB, apiInput };
    };
    const SAME_TIME = "2026-06-08T13:00:00.000Z";
    const NEW_TIME = "2026-06-09T14:00:00.000Z";

    // Rescued: the first advisor lost, the next one in the rung took it, on both
    // arms that move (the same time dedupe and the new time reschedule).
    for (const startIso of [SAME_TIME, NEW_TIME]) {
      const { existingB, apiInput } = moveFixture(startIso);
      const { deps } = makeDeps({
        personBookings: [existingB],
        existing: { booking: existingB, bucket, eventType },
        candidates: ["a", "b"],
        freeEmails: new Set(["a@x.com", "b@x.com"]),
        insertBookingConflictFor: new Set(["a"]),
      });
      const res = await bookViaApi(apiInput, deps);
      assert(res.outcome === "rescheduled", `race on a move at ${startIso}: still moved (got ${res.outcome})`);
      assert(
        res.booking.assigned_user_id === "b",
        `race on a move at ${startIso}: booked with the next advisor (got ${res.booking.assigned_user_id})`,
      );
      assert(
        res.raceOutcome === "race_reassigned",
        `race on a move at ${startIso}: the rescue is counted (got ${String(res.raceOutcome)})`,
      );
    }

    // Refused below the bound, on the same time arm that tolerates a refusal:
    // the contract is unchanged (a declined bucket change), and the race is named.
    {
      const { existingB, apiInput } = moveFixture(SAME_TIME);
      const { deps, calls } = makeDeps({
        personBookings: [existingB],
        existing: { booking: existingB, bucket, eventType },
        candidates: ["a", "b"],
        freeEmails: new Set(["a@x.com"]),
        insertBookingConflictFor: new Set(["a"]),
      });
      const res = await bookViaApi(apiInput, deps);
      assert(res.outcome === "deduped", `refused race on a move: still a dedupe (got ${res.outcome})`);
      assert(res.bucketChangeDeclined === "slot_taken", "refused race on a move: still a declined bucket change");
      assert(res.booking.id === "bk-existing", "refused race on a move: the lead keeps the appointment they had");
      assert(
        res.raceOutcome === "race_refused",
        `refused race on a move: the refusal is counted (got ${String(res.raceOutcome)})`,
      );
      assert(
        !calls.webhooks.some((w) => w.event === "booking.cancelled"),
        "refused race on a move: the old appointment is not cancelled",
      );
    }

    // Refused at the bound.
    {
      const all = ["a", "b", "c", "d", "e"];
      assert(MAX_RACE_REASSIGNS < all.length - 1, "fixture: more free advisors than the retry bound allows");
      const { existingB, apiInput } = moveFixture(SAME_TIME);
      const { deps } = makeDeps({
        personBookings: [existingB],
        existing: { booking: existingB, bucket, eventType },
        candidates: all,
        freeEmails: new Set(all.map((id) => `${id}@x.com`)),
        insertBookingConflictFor: new Set(all),
      });
      const res = await bookViaApi(apiInput, deps);
      assert(res.bucketChangeDeclined === "slot_taken", "bound hit on a move: still a declined bucket change");
      assert(
        res.raceOutcome === "race_refused_bound",
        `bound hit on a move: counted as the bound (got ${String(res.raceOutcome)})`,
      );
    }

    // Refused on the new time arm, which does not tolerate a refusal: the lost
    // race propagates as itself, so the route's own catch counts it exactly once.
    {
      const { existingB, apiInput } = moveFixture(NEW_TIME);
      const { deps } = makeDeps({
        personBookings: [existingB],
        existing: { booking: existingB, bucket, eventType },
        candidates: ["a", "b"],
        freeEmails: new Set(["a@x.com"]),
        insertBookingConflictFor: new Set(["a"]),
      });
      let err: unknown = null;
      try {
        await bookViaApi(apiInput, deps);
      } catch (e) {
        err = e;
      }
      assert(
        err instanceof RaceLostRefusalError && err.boundHit === false,
        `refused race on a new time move: propagates as the lost race refusal (got ${String(err)})`,
      );
    }

    // A move whose confirm replays a booking an earlier call made: that call
    // counted its race, so this one counts nothing.
    {
      const { existingB, apiInput } = moveFixture(SAME_TIME);
      const replayed = makeBooking({
        id: "bk-replayed",
        manage_token: "tok-replayed",
        routing_trace: {
          bucket_code: "411",
          bucket_id: "bkt1",
          considered: ["a", "b"],
          chosen_user_id: "b",
          fallback_applied: false,
          race_lost: ["a"],
        },
      });
      const { deps } = makeDeps({
        personBookings: [existingB],
        existing: { booking: existingB, bucket, eventType },
        existingByKey: replayed,
      });
      const res = await bookViaApi(apiInput, deps);
      assert(
        res.outcome === "rescheduled" && res.booking.id === "bk-replayed",
        `replayed move: the earlier booking is returned (got ${res.outcome} ${res.booking.id})`,
      );
      assert(
        res.raceOutcome === undefined,
        `replayed move: a race an earlier call made is not counted again (got ${String(res.raceOutcome)})`,
      );
    }

    // Controls: an uncontested move and a move refused for want of an agent
    // name no race, or the field is satisfied by a move that always claims one.
    {
      const { existingB, apiInput } = moveFixture(SAME_TIME);
      const { deps } = makeDeps({ personBookings: [existingB], existing: { booking: existingB, bucket, eventType } });
      const res = await bookViaApi(apiInput, deps);
      assert(res.outcome === "rescheduled", "uncontested move: moved");
      assert(res.raceOutcome === undefined, "uncontested move: no race is counted");
    }
    {
      const { existingB, apiInput } = moveFixture(SAME_TIME);
      const { deps } = makeDeps({
        personBookings: [existingB],
        existing: { booking: existingB, bucket, eventType },
        candidates: [],
      });
      const res = await bookViaApi(apiInput, deps);
      assert(res.bucketChangeDeclined === "no_eligible_agents", "empty pool move: declined for want of an agent");
      assert(res.raceOutcome === undefined, "empty pool move: no race is counted");
    }
  }

  // --- #2861: the fresh create arm names its race through the same field ---
  {
    const apiInput: ApiBookingInput = { ...input, externalId: "ext-new", confirmReschedule: false };
    const { deps } = makeDeps({
      personBookings: [],
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "created", "race on a create: created");
    assert(res.raceOutcome === "race_reassigned", `race on a create: counted (got ${String(res.raceOutcome)})`);
  }
  {
    const apiInput: ApiBookingInput = { ...input, externalId: "ext-new", confirmReschedule: false };
    const replayed = makeBooking({
      id: "bk-replayed",
      routing_trace: {
        bucket_code: "411",
        bucket_id: "bkt1",
        considered: ["a", "b"],
        chosen_user_id: "b",
        fallback_applied: false,
        race_lost: ["a"],
      },
    });
    const { deps } = makeDeps({ personBookings: [], existingByKey: replayed });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "created", "replayed create: still answers created");
    assert(res.raceOutcome === undefined, "replayed create: the earlier call's race is not counted again");
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
    // #1295 gate 1: the ORG is shut at T. Before this, every agent failed the gate,
    // the tier ladder reported itself exhausted and the caller was told `slot_taken`
    // (that the times had gone) about times nobody was ever offered. A distinct
    // cause gets a distinct answer.
    //
    // The agent here is FREE, so `slot_taken` is not merely a worse label: it would
    // be false. Only the org's own hours make this unbookable.
    const mondayAfternoonOnly = {
      zone: "America/New_York",
      rules: [{ weekday: 1, start_minute: 14 * 60, end_minute: 18 * 60 }], exceptions: [] };
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      businessHours: mondayAfternoonOnly,
    });
    // input.startIso is Monday 09:00 America/New_York, hours before the org opens.
    const r = await checkBookable({ bucketCode: "411", startIso: input.startIso }, deps);
    assert(
      r.bookable === false && r.reason === "closed",
      `checkBookable: org shut at T -> closed, not slot_taken (got ${r.reason})`,
    );
    assert(r.wouldAssign === null, "checkBookable: no agent named when the org is closed");
    assert(
      calls.roundRobinPreview.length === 0,
      "checkBookable: a closed org short-circuits before the routing pass runs at all",
    );
  }
  {
    // The same closed hour, but inside the org's day, still answers normally: the
    // gate must not swallow the busy-ladder case it sits in front of.
    const { deps } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(),
      businessHours: {
        zone: "America/New_York",
        rules: [{ weekday: 1, start_minute: 8 * 60, end_minute: 20 * 60 }], exceptions: [] },
    });
    const r = await checkBookable({ bucketCode: "411", startIso: input.startIso }, deps);
    assert(
      r.bookable === false && r.reason === "slot_taken",
      "checkBookable: open org with a busy ladder still answers slot_taken",
    );
  }
  {
    // An UNREADABLE stored week must throw, never answer. A confident "the org is
    // open" (or a confident "closed") off a read that never ran is exactly the
    // failure the loader's throw-don't-degrade rule exists to prevent.
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]), businessHoursReadFails: true });
    let err: unknown;
    try {
      await checkBookable({ bucketCode: "411", startIso: input.startIso }, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof Error && /unusable|connection reset/i.test(err.message),
      "checkBookable: an unreadable business week throws rather than guessing bookable",
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
    deps.roundRobinCandidates = async () =>
      ++rr === 1 ? { candidates: [], memberCount: 0 } : { candidates: ["a"], memberCount: 1 };
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
    deps.roundRobinCandidates = async () =>
      ++rr === 1 ? { candidates: [], memberCount: 0 } : { candidates: ["a"], memberCount: 1 };
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
    const views = await lookupPersonBookings({ externalId: "ext-1", salesforceId: null }, deps);
    assert(views.length === 1 && views[0].id === "bkL", "lookup returns one view");
    assert(views[0].manageUrl === "https://slate.test/booking/manage/tok1", "lookup view has manageUrl");
    assert(views[0].externalId === "ext-1" && views[0].status === "confirmed", "lookup view fields mapped");
    // #2660: the view says which WORLD the booking is in, so a host's confirmed
    // page can label a test booking. Read off the bucket at the fetch.
    assert(views[0].isTest === false, "lookup view says a real booking is real");
  }
  {
    const bk = makeBooking({ id: "bkT", external_id: "ext-t" });
    const { deps } = makeDeps({ personBookings: [bk], testBucket: true });
    const views = await lookupPersonBookings({ externalId: "ext-t", salesforceId: null }, deps);
    assert(views.length === 1 && views[0].isTest === true, "lookup view says a test booking is a test");
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
    assert(view.isTest === false, "get-by-id says a real booking is real (#2660)");
  }
  {
    // #2660: the by id view reads the world off the booking's own bucket, which
    // is what trypennie's confirmed page reads to label a test booking.
    const bk = makeBooking({ id: "bkT", external_id: "ext-t" });
    const ctx = { booking: bk, bucket: { ...bucket, is_test: true } as Bucket, eventType };
    const { deps } = makeDeps({ bookingById: ctx });
    const view = await getPersonBookingById(
      { bookingId: "bkT", identity: { externalId: "ext-t", salesforceId: null }, status: null },
      deps,
    );
    assert(view.isTest === true, "get-by-id says a test booking is a test");

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

  // --- #2643: the by id lookup carries what the booking confirmed page renders ---
  // The lead's contact (the Client rows and the text reminder card) and the four
  // add to calendar links. Safe to return here because this lookup already
  // requires a STRONG id (externalId / salesforceId) matching the booking.
  {
    const bk = makeBooking({ id: "bkC", external_id: "ext-1", status: "confirmed", manage_token: "tokC", agent_name: "Dana Lee" });
    const { deps } = makeDeps({ bookingById: { booking: bk, bucket, eventType } });
    const view = await getPersonBookingById(
      { bookingId: "bkC", identity: { externalId: "ext-1", salesforceId: null }, status: null },
      deps,
    );
    assert(
      view.contact.name === "Kris" && view.contact.email === "k@x.com" && view.contact.phone === "+12035615295",
      "the lookup returns the lead's own contact as stored",
    );
    assert(view.calendarLinks !== null, "an active booking carries calendar links");
    assert(
      view.calendarLinks?.ics === "https://slate.test/api/bookings/tokC/ics",
      "the ICS link is served by the manage token, so a browser can open it with no API key",
    );
    assert(
      new URL(view.calendarLinks!.google).searchParams.get("dates") === "20260608T130000Z/20260608T133000Z",
      "the Google link carries the booking's own time",
    );
    assert(view.calendarLinks!.google.includes("Dana"), "and names the advisor");
  }
  {
    // A cancelled call must not be offered as something to add to a calendar.
    const bk = makeBooking({ id: "bkD", external_id: "ext-1", status: "cancelled" });
    const { deps } = makeDeps({ bookingById: { booking: bk, bucket, eventType } });
    const view = await getPersonBookingById(
      { bookingId: "bkD", identity: { externalId: "ext-1", salesforceId: null }, status: null },
      deps,
    );
    assert(view.calendarLinks === null, "a cancelled booking carries no calendar links");
    assert(view.contact.name === "Kris", "but still carries the contact, which the page shows either way");
  }
  {
    // The ICS the manage token serves describes the SAME call the links do.
    const bk = makeBooking({ id: "bkI", manage_token: "tokI", agent_name: "Dana Lee", reschedule_seq: 3 });
    const ics = bookingIcs(bk, "https://slate.test", "2026-09-23T12:00:00.000Z").replace(/\r\n /g, "");
    assert(ics.includes("UID:bkI@slate.trypennie.app"), "the ICS is keyed on the booking");
    assert(ics.includes("DTSTART:20260608T130000Z") && ics.includes("DTEND:20260608T133000Z"), "at the booking's own time");
    assert(ics.includes("SEQUENCE:3"), "and carries the reschedule count");
    assert(ics.includes("URL:https://slate.test/booking/manage/tokI"), "and links back to the manage page");
    assert(ics.includes("Dana Lee"), "and names the advisor");
  }
  {
    // The links are built AFTER a booking or a move has committed, so a failure to
    // build them must never throw: a route would fall into its error branch and tell
    // the lead a call that exists did not happen (#2644, L12). They degrade to null.
    const bk = makeBooking({ id: "bkU", starts_at: "not a time", status: "confirmed" });
    let threw = false;
    let extras: ReturnType<typeof bookingDetailExtras> | null = null;
    try { extras = bookingDetailExtras(bk, "https://slate.test"); } catch { threw = true; }
    assert(!threw, "an unreadable stored time does not throw out of the builder");
    assert(extras?.calendarLinks === null, "it degrades to no calendar links");
    assert(extras?.contact.name === "Kris", "and the contact is still returned");
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

  // --- #2659: the partner join keys ride on EVERY view --------------------
  // `submissionId` and `regalProfileId` are read off the booking's own prefill
  // through one reader, on the lookup, the by id read, the list and the cancel,
  // null when the page passed none, so a caller can always read the field. The
  // lookup and list are what trypennie's confirmed page and the warehouse join
  // on; the direct API's own confirm response is pinned in its route test.
  {
    const prefill = { xbc: "411", [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU", [PARTNER_KEYS.regalProfileId]: "rp_01HZY3" };
    const bk = makeBooking({ id: "bkP", external_id: "ext-1", prefill });
    const { deps } = makeDeps({ personBookings: [bk], bookingById: { booking: bk, bucket, eventType } });

    const views = await lookupPersonBookings({ externalId: "ext-1", salesforceId: null }, deps);
    assert(views[0].submissionId === "a0G5x00000AbCdEQAU", "lookup view carries submissionId from prefill (#2659)");
    assert(views[0].regalProfileId === "rp_01HZY3", "lookup view carries regalProfileId from prefill (#2659)");

    const byId = await getPersonBookingById(
      { bookingId: "bkP", identity: { externalId: "ext-1", salesforceId: null }, status: null },
      deps,
    );
    assert(byId.submissionId === "a0G5x00000AbCdEQAU" && byId.regalProfileId === "rp_01HZY3", "by id view carries both keys (#2659)");
  }
  {
    const prefill = { xbc: "411", [PARTNER_KEYS.submissionId]: " a0G5x00000AbCdEQAU ", [PARTNER_KEYS.regalProfileId]: "" };
    const bk = makeBooking({ id: "bkQ", external_id: "ext-1", prefill });
    const { deps } = makeDeps({ personBookings: [bk] });
    const views = await lookupPersonBookings({ externalId: "ext-1", salesforceId: null }, deps);
    assert(views[0].submissionId === "a0G5x00000AbCdEQAU", "a padded submission id is trimmed on the view (#2659)");
    assert(views[0].regalProfileId === null, "an empty regal profile id reads as null, never an empty string (#2659)");
  }
  {
    const bk = makeBooking({ id: "bkN", external_id: "ext-1", prefill: { utm_source: "google" } });
    const { deps } = makeDeps({ personBookings: [bk] });
    const views = await lookupPersonBookings({ externalId: "ext-1", salesforceId: null }, deps);
    assert("submissionId" in views[0] && views[0].submissionId === null, "no submission id on the page: the field is present and null (#2659)");
    assert("regalProfileId" in views[0] && views[0].regalProfileId === null, "no regal profile id on the page: the field is present and null (#2659)");
  }
  {
    const prefill = { [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU", [PARTNER_KEYS.regalProfileId]: "rp_01HZY3" };
    const b1 = makeBooking({ id: "LP", bucket_id: "bkt1", prefill });
    const { deps } = makeDeps({ listResult: { rows: [b1], buckets: [bucket] } });
    const res = await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: null, agentEmail: null, limit: 10, offset: 0 },
      deps,
    );
    assert(res.items[0].submissionId === "a0G5x00000AbCdEQAU" && res.items[0].regalProfileId === "rp_01HZY3", "list item carries both keys (#2659)");
  }
  {
    const prefill = { [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU" };
    const bk = makeBooking({ id: "bkX", external_id: "ext-1", status: "confirmed", gcal_event_id: "g1", prefill });
    const ctx = { booking: bk, bucket, eventType };
    const { deps } = makeDeps({ bookingById: ctx, existing: ctx });
    const view = await cancelDirectBooking(
      { bookingId: "bkX", identity: { externalId: "ext-1", salesforceId: null }, reason: { code: "api_cancellation", detail: null } },
      deps,
    );
    assert(view.status === "cancelled" && view.submissionId === "a0G5x00000AbCdEQAU", "the cancelled view still carries the submission id (#2659)");
    assert(view.regalProfileId === null, "and null for the key the page never passed (#2659)");
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
    assert(res.items[0].isTest === false, "list item carries the world from the same join (#2660)");
    assert(res.nextCursor !== null, "full page (rows == limit) sets a nextCursor");
    assert((calls.queryBookings[0] as { orderBy: string }).orderBy === "starts_at",
      "default order is starts_at");
  }
  {
    const testBucket = { ...bucket, id: "bkt-t", code: "TESTX", is_test: true } as Bucket;
    const b1 = makeBooking({ id: "LT", bucket_id: "bkt-t" });
    const { deps } = makeDeps({ listResult: { rows: [b1], buckets: [testBucket] } });
    const res = await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: null, agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert(res.items[0].isTest === true, "a list item on a test bucket says so (#2660)");
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
      return rrCallCount === 1
        ? { candidates: [], memberCount: 0 }
        : { candidates: ["a"], memberCount: 1 };
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

  // --- #2842: a top tier lead's booking cascade stops at Medium and skips Low carriers ---
  //
  // Sales ops, 2026-09-28: an Ultra or Very High lead may cascade to Medium, never to
  // Low, and on every rung below their own tier "as long as the person ... isn't
  // also on Low". The booking cascade must ask the same rungs the display cascade
  // showed, with the same people removed, or a lead is shown a time nobody allowed
  // can take (or booked with somebody the display never offered).
  {
    const asked: { code: string; excludeLow: boolean | undefined }[] = [];
    const { deps } = makeDeps({ freeEmails: new Set(["a@x.com"]) });
    deps.resolveBucketByCode = async (code: string) => ({
      bucket: { ...bucket, id: `bkt${code}`, code } as unknown as Bucket,
      eventType,
    });
    deps.roundRobinCandidates = async (b, _e, _ms, _p, _only, excludeLow) => {
      asked.push({ code: b.code, excludeLow });
      // Only 211 has anybody free, and only once Low carriers are removed does the
      // free advisor remain: a fake that ignored the flag would answer the same.
      return b.code === "211" && excludeLow ? { candidates: ["a"], memberCount: 1 } : { candidates: [], memberCount: 3 };
    };
    const res = await createBooking({ ...input, bucketCode: "411" }, deps);
    assert(
      asked.map((a) => a.code).join(",") === "411,311,211",
      `top tier: the booking cascade asks 411, 311, 211 and never Low (got ${asked.map((a) => a.code).join(",")})`,
    );
    assert(asked[0].excludeLow !== true, "top tier: the lead's own tier keeps its whole pool");
    assert(
      asked.slice(1).every((a) => a.excludeLow === true),
      "top tier: every rung below the lead's own tier drops Low carriers",
    );
    assert(
      (res.booking as unknown as Record<string, unknown>).bucket_id === "bkt211",
      "top tier: the booking lands on the Medium rung",
    );
  }
  {
    // A High lead's cascade may reach Low and keeps Low carriers throughout.
    const asked: { code: string; excludeLow: boolean | undefined }[] = [];
    const { deps } = makeDeps({ freeEmails: new Set(["a@x.com"]) });
    deps.resolveBucketByCode = async (code: string) => ({
      bucket: { ...bucket, id: `bkt${code}`, code } as unknown as Bucket,
      eventType,
    });
    deps.roundRobinCandidates = async (b, _e, _ms, _p, _only, excludeLow) => {
      asked.push({ code: b.code, excludeLow });
      return b.code === "111" ? { candidates: ["a"], memberCount: 1 } : { candidates: [], memberCount: 3 };
    };
    await createBooking({ ...input, bucketCode: "311" }, deps);
    assert(asked.map((a) => a.code).join(",") === "311,211,111", "High: the cascade may reach Low");
    assert(asked.every((a) => a.excludeLow !== true), "High: no rung drops Low carriers");
  }
  {
    // Every allowed rung below is made of Low carriers only. That is the ordinary
    // "nobody can take this time" outcome, NOT an empty bucket: the last rung's
    // empty filtered pool must not page as a misconfigured bucket.
    const { deps } = makeDeps({ freeEmails: new Set(["a@x.com"]) });
    deps.resolveBucketByCode = async (code: string) => ({
      bucket: { ...bucket, id: `bkt${code}`, code } as unknown as Bucket,
      eventType,
    });
    deps.roundRobinCandidates = async (b, _e, _ms, _p, _only, excludeLow) =>
      b.code === "411" ? { candidates: [], memberCount: 3 } : excludeLow ? { candidates: [], memberCount: 0 } : { candidates: ["a"], memberCount: 1 };
    let err: unknown;
    try {
      await createBooking({ ...input, bucketCode: "411" }, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof SlotUnavailableError && !(err instanceof NoEligibleAgentsError),
      `top tier: a cascade with nobody allowed reads as a taken time, not an empty bucket (got ${String(err)})`,
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
