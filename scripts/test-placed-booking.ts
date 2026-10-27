// #4202: the coordinator's one booking operation (`placeBooking`), driven through hand
// written fakes of everything it reads and calls.
//
// The decided rules (Sam and Dan, 2026-10-23), each with its failure path:
//   - kept: the go live switch (unreadable and off refused by name), the org's business
//     hours, the customer's calling window in the zone given (missing zone refused, never
//     defaulted), the horizon, and nothing in the past;
//   - a free real advisor first, through the normal create; only a refusal for want of
//     one falls to the placeholder, and a transient outage is reported as itself;
//   - the placeholder of the bucket's own org and world, or a refusal naming its absence;
//   - one call per customer, matched on the Salesforce id only: without a confirmation the
//     call is shown, with one the SAME booking moves (a real advisor first, then the
//     placeholder), and a looser match is shown and refused;
//   - a double submit books once and answers the same outcome.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-placed-booking.ts
import {
  placeBooking,
  coordinatorKeyFor,
  PlacedBookingRefusedError,
  type PlacedBookingDeps,
  type PlacedBookingInput,
  type PlacedBookingOutcome,
} from "../src/lib/booking/placed-booking.ts";
import {
  ExistingCallCheckUnavailableError,
  NoEligibleAgentsError,
  OutsideCallingWindowError,
  RescheduleConflictError,
  SlotUnavailableError,
  UnknownBucketError,
  VerifyUnavailableError,
  type BookingResult,
  type CreateBookingInput,
  type PlaceholderBookingInput,
} from "../src/lib/booking/orchestration.ts";
import type { Booking, Bucket, EventType, User } from "../src/lib/db/types.ts";
import type { BusinessHoursRules } from "../src/lib/availability/compute.ts";
import { assert, finish } from "./lib/harness.ts";

// Tuesday 2026-06-09, 10:00 in Chicago (15:00Z); "now" is the Monday before, 09:00 Eastern.
const NOW = Date.parse("2026-06-08T13:00:00.000Z");
const START = "2026-06-09T15:00:00.000Z";
const SUBMISSION = "6f1c2d3e-0000-4000-8000-000000000001";
const bucket = { id: "bkt1", org_id: "org1", code: "411", is_test: false } as unknown as Bucket;
const testBucket = { ...bucket, id: "bkt-test", code: "T411", is_test: true } as Bucket;
const eventType = { id: "et1", name: "Call", duration_min: 30 } as unknown as EventType;
const placeholder = { id: "p", name: "Marcia", email: "marcia@x.com", is_placeholder: true, is_test: false } as unknown as User;
const testPlaceholder = { ...placeholder, id: "pt", is_test: true } as User;
/** Weekdays 08:00 to 18:00 in New York. */
const HOURS: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 18 * 60 })),
  exceptions: [],
};

const base: PlacedBookingInput = {
  salesforceLeadId: "00Q000000000001",
  bucketCode: "411",
  attendee: { name: "Kris Lead", email: "k@x.com", phone: "+12035615295" },
  timezone: "America/Chicago",
  startIso: START,
  coordinatorUserId: "coord-1",
  submissionId: SUBMISSION,
};

function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: "bk-existing",
    org_id: "org1",
    bucket_id: "bkt1",
    assigned_user_id: "a",
    agent_name: "Agent A",
    starts_at: "2026-06-10T15:00:00.000Z",
    timezone: "America/Chicago",
    status: "confirmed",
    salesforce_id: "00Q000000000001",
    external_id: null,
    attendee_email: "k@x.com",
    attendee_phone: "+12035615295",
    manage_token: "tok-existing",
    kind: "routed",
    ...over,
  } as unknown as Booking;
}

interface Fake {
  enabled?: boolean | null;
  horizon?: number | null;
  hoursThrow?: boolean;
  unknownBucket?: boolean;
  bucketIsTest?: boolean;
  replay?: Booking | null;
  person?: Booking[];
  personThrows?: boolean;
  placeholderFor?: (isTest: boolean) => User | null;
  /** What the normal create does: book an advisor, or throw. */
  create?: () => Booking;
  createThrows?: () => Error;
  /** What the normal reschedule does to a real advisor; the placeholder move always lands. */
  rescheduleThrows?: () => Error;
  rescheduleAnswer?: (token: string, startIso: string) => Booking;
}

function makeFake(f: Fake = {}) {
  const calls = {
    create: [] as { input: CreateBookingInput }[],
    placeholderCreate: [] as PlaceholderBookingInput[],
    reschedule: [] as { token: string; startIso: string; zone: string; onto: User | undefined; actor: string }[],
    placeholderLookups: [] as { orgId: string; isTest: boolean }[],
    personWorlds: [] as boolean[],
    keys: [] as string[],
  };
  const made = (b: Booking): BookingResult => ({ booking: b, manageUrl: `https://slate.test/booking/manage/${b.manage_token}`, newlyInserted: true });
  const deps: PlacedBookingDeps = {
    now: () => NOW,
    manageUrl: (token) => `https://slate.test/booking/manage/${token}`,
    placeholderEnabled: async () => (f.enabled === undefined ? true : f.enabled),
    horizonDays: async () => (f.horizon === undefined ? 4 : f.horizon),
    businessHours: async () => {
      if (f.hoursThrow) throw new Error("business hours are unusable: connection reset");
      return HOURS;
    },
    resolveBucketByCode: async () => (f.unknownBucket ? null : { bucket: f.bucketIsTest ? testBucket : bucket, eventType }),
    findBookingByIdempotencyKey: async (key) => {
      calls.keys.push(key);
      return f.replay ?? null;
    },
    findActiveBookingsForPerson: async (_identity, world) => {
      calls.personWorlds.push(world.isTest);
      if (f.personThrows) throw new Error("statement timeout");
      return f.person ?? [];
    },
    findPlaceholder: async (orgId, isTest) => {
      calls.placeholderLookups.push({ orgId, isTest });
      return f.placeholderFor ? f.placeholderFor(isTest) : isTest ? testPlaceholder : placeholder;
    },
    createBooking: async (input) => {
      calls.create.push({ input });
      if (f.createThrows) throw f.createThrows();
      return made(f.create ? f.create() : booking({ id: "bk-new", starts_at: input.startIso, manage_token: "tok-new" }));
    },
    createPlaceholderBooking: async (input) => {
      calls.placeholderCreate.push(input);
      return made(booking({ id: "bk-new", assigned_user_id: input.placeholder.id, agent_name: "Marcia", kind: "staff_placed", starts_at: input.startIso, manage_token: "tok-new" }));
    },
    rescheduleBooking: async ({ token, startIso, zone, ontoPlaceholder, actorUserId }) => {
      calls.reschedule.push({ token, startIso, zone, onto: ontoPlaceholder, actor: actorUserId });
      if (ontoPlaceholder) {
        return made(booking({ starts_at: startIso, assigned_user_id: ontoPlaceholder.id, agent_name: "Marcia", kind: "staff_placed", status: "rescheduled" }));
      }
      if (f.rescheduleThrows) throw f.rescheduleThrows();
      return made(f.rescheduleAnswer ? f.rescheduleAnswer(token, startIso) : booking({ starts_at: startIso, assigned_user_id: "b", status: "rescheduled" }));
    },
  };
  return { deps, calls };
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (err) {
    return err;
  }
}
const refusedFor = (err: unknown) => (err instanceof PlacedBookingRefusedError ? err.reason : `not refused: ${String(err)}`);

async function run() {
  const key = coordinatorKeyFor(SUBMISSION);
  assert(key === `coordinator:${SUBMISSION}`, "the idempotency key is the submission's, never the person and the start (#3291)");

  // --- a free real advisor takes it through the normal create --------------------------------
  {
    const { deps, calls } = makeFake();
    const out = await placeBooking(base, deps);
    assert(out.kind === "booked" && out.on === "advisor" && out.replayed === false, `booked with a real advisor (got ${JSON.stringify(out.kind)})`);
    const input = calls.create[0]?.input;
    assert(input?.idempotencyKey === key && input.placedByUserId === "coord-1", "through the create, keyed on the submission and naming the coordinator");
    assert(input?.timezone === "America/Chicago" && input.salesforceId === "00Q000000000001" && input.bucketCode === "411",
      "in the customer's own zone, Lead and bucket");
    assert(input?.refuseIfPersonHasCall !== true && input?.allowTestBuckets === false, "the one call per customer rule is this operation's own, and a real bucket stays real");
    assert(calls.placeholderCreate.length === 0 && calls.placeholderLookups.length === 0, "and the placeholder is never asked for");
  }

  // --- only a refusal for want of a free advisor falls to the placeholder ---------------------
  for (const [label, err] of [["taken", () => new SlotUnavailableError()], ["nobody eligible", () => new NoEligibleAgentsError()]] as const) {
    const { deps, calls } = makeFake({ createThrows: err });
    const out = await placeBooking(base, deps);
    assert(out.kind === "booked" && out.on === "placeholder", `${label}: the call goes on the placeholder`);
    const placed = calls.placeholderCreate[0];
    assert(placed?.placeholder.id === "p" && placed.idempotencyKey === key && placed.placedByUserId === "coord-1",
      `${label}: on the real placeholder, under the same submission key, naming the coordinator`);
    assert(placed?.bucket.id === "bkt1" && placed.timezone === "America/Chicago" && placed.startIso === START,
      `${label}: in the customer's own bucket and zone, at the time they named`);
    assert(calls.placeholderLookups[0]?.orgId === "org1" && calls.placeholderLookups[0]?.isTest === false, `${label}: the placeholder of the bucket's org and world`);
  }
  for (const [label, err] of [
    ["a verify outage", () => new VerifyUnavailableError()],
    ["an unexpected fault", () => new Error("boom")],
  ] as const) {
    const { deps, calls } = makeFake({ createThrows: err });
    const out = await refusal(() => placeBooking(base, deps));
    assert(out instanceof Error && out.constructor === err().constructor, `${label} is reported as itself (got ${String(out)})`);
    assert(calls.placeholderCreate.length === 0 && calls.placeholderLookups.length === 0, `${label} never falls to the placeholder`);
  }
  {
    const { deps, calls } = makeFake({ createThrows: () => new SlotUnavailableError(), placeholderFor: () => null });
    const out = await refusal(() => placeBooking(base, deps));
    assert(refusedFor(out) === "no-placeholder", `no placeholder in the org is its own refusal (got ${refusedFor(out)})`);
    assert(calls.placeholderCreate.length === 0, "and nothing is placed");
  }
  {
    const { deps, calls } = makeFake({ bucketIsTest: true, createThrows: () => new SlotUnavailableError() });
    const out = await placeBooking({ ...base, bucketCode: "T411" }, deps);
    assert(out.kind === "booked" && out.on === "placeholder" && calls.placeholderCreate[0]?.placeholder.id === "pt",
      "a test bucket's call goes on the TEST placeholder");
    assert(calls.create[0]?.input.allowTestBuckets === true && calls.personWorlds[0] === true, "booked and checked for an existing call in the test world");
  }

  // --- the kept gates, each refused by name before anything is read or written ---------------
  const gates: [string, Fake, Partial<PlacedBookingInput>, string][] = [
    ["an unreadable switch", { enabled: null }, {}, "switch-unreadable"],
    ["the switch off", { enabled: false }, {}, "switch-off"],
    ["no zone", {}, { timezone: "" }, "zone-missing"],
    ["a zone that is not a zone", {}, { timezone: "Central" }, "zone-missing"],
    ["no Lead id", {}, { salesforceLeadId: "  " }, "lead-id-missing"],
    ["a submission id that is not one", {}, { submissionId: "click-1" }, "submission-id-invalid"],
    ["an unreadable start", {}, { startIso: "tomorrow at ten" }, "start-unreadable"],
    ["a start in the past", {}, { startIso: "2026-06-08T12:00:00.000Z" }, "start-in-past"],
    // Saturday: Pennie is closed, whatever the advisors' calendars say.
    ["a time Pennie is closed", {}, { startIso: "2026-06-13T15:00:00.000Z" }, "outside-business-hours"],
    // 18:30 Eastern is after the org's close.
    ["after the org closes", {}, { startIso: "2026-06-09T22:30:00.000Z" }, "outside-business-hours"],
    ["an unreadable horizon", { horizon: null }, {}, "horizon-unreadable"],
    // Open days counted from today (Monday): Mon, Tue with a horizon of 2, so Wednesday is past it.
    ["a start past the horizon", { horizon: 2 }, { startIso: "2026-06-10T15:00:00.000Z" }, "beyond-horizon"],
  ];
  for (const [label, fake, over, reason] of gates) {
    const { deps, calls } = makeFake(fake);
    const out = await refusal(() => placeBooking({ ...base, ...over }, deps));
    assert(refusedFor(out) === reason, `${label} is refused as ${reason} (got ${refusedFor(out)})`);
    assert(calls.create.length === 0 && calls.placeholderCreate.length === 0 && calls.reschedule.length === 0, `${label}: nothing is booked or moved`);
  }
  {
    // 08:30 Eastern is inside the org's day but 07:30 in Chicago, before the customer's window.
    const { deps, calls } = makeFake();
    const out = await refusal(() => placeBooking({ ...base, startIso: "2026-06-09T12:30:00.000Z" }, deps));
    assert(out instanceof OutsideCallingWindowError && out.zone === "America/Chicago",
      `outside the customer's calling window, judged in THEIR zone, is the existing refusal (got ${String(out)})`);
    assert(calls.create.length === 0 && calls.placeholderCreate.length === 0, "and nothing is booked");
    const control = makeFake();
    const ok = await placeBooking({ ...base, startIso: "2026-06-09T13:30:00.000Z" }, control.deps);
    assert(ok.kind === "booked", "control: 08:30 in Chicago, inside both windows, books");
  }
  {
    const { deps } = makeFake({ hoursThrow: true });
    const out = await refusal(() => placeBooking(base, deps));
    assert(out instanceof Error && /business hours/.test(out.message), "an unreadable week is the failure it is, never read as open");
  }
  {
    const { deps } = makeFake({ unknownBucket: true });
    assert((await refusal(() => placeBooking(base, deps))) instanceof UnknownBucketError, "an unknown bucket is the existing refusal");
  }

  // --- a double submit books once and answers the same ---------------------------------------
  for (const kind of ["routed", "staff_placed"] as const) {
    const first = booking({ id: "bk-first", kind, idempotency_key: key, assigned_user_id: kind === "routed" ? "a" : "p" });
    const { deps, calls } = makeFake({ replay: first, person: [first] });
    const out = await placeBooking(base, deps);
    assert(out.kind === "booked" && out.booking.id === "bk-first" && out.replayed === true && out.on === (kind === "routed" ? "advisor" : "placeholder"),
      `a repeat of a submission that booked ${kind === "routed" ? "an advisor" : "the placeholder"} answers that booking, never "already has a call"`);
    assert(calls.keys[0] === key && calls.create.length === 0 && calls.placeholderCreate.length === 0, "found by the submission key, and nothing is made again");
  }

  // --- one call per customer, on the Salesforce id ----------------------------------------
  {
    const existing = booking();
    const { deps, calls } = makeFake({ person: [existing] });
    const out = await placeBooking(base, deps);
    assert(out.kind === "existing-call" && out.call.bookingId === "bk-existing" && out.call.startsAt === existing.starts_at && out.call.onPlaceholder === false,
      `without a confirmation the customer's call is shown for the coordinator to confirm (got ${out.kind})`);
    assert(calls.create.length === 0 && calls.reschedule.length === 0, "and nothing is booked or moved");
  }
  {
    const existing = booking();
    const { deps, calls } = makeFake({ person: [existing] });
    const reason = { code: "schedule_conflict", detail: null };
    const out = await placeBooking({ ...base, move: { bookingId: "bk-existing", reason } }, deps);
    assert(out.kind === "moved" && out.on === "advisor" && out.booking.id === "bk-existing", "confirmed: the SAME booking moves to a real advisor");
    const r = calls.reschedule[0];
    assert(r?.token === "tok-existing" && r.startIso === START && r.zone === "America/Chicago" && r.onto === undefined && r.actor === "coord-1",
      "through the normal reschedule, in the customer's zone, as the coordinator");
    assert(calls.create.length === 0 && calls.reschedule.length === 1, "never a second booking");
  }
  for (const [label, err] of [["taken", () => new SlotUnavailableError()], ["nobody eligible", () => new NoEligibleAgentsError()]] as const) {
    const existing = booking();
    const { deps, calls } = makeFake({ person: [existing], rescheduleThrows: err });
    const out = await placeBooking({ ...base, move: { bookingId: "bk-existing", reason: { code: "other", detail: "moved by phone" } } }, deps);
    assert(out.kind === "moved" && out.on === "placeholder" && out.booking.id === "bk-existing", `${label}: the same booking moves onto the placeholder`);
    assert(calls.reschedule.length === 2 && calls.reschedule[1].onto?.id === "p" && calls.reschedule[1].token === "tok-existing",
      `${label}: a real advisor was asked first, then the move onto the placeholder`);
  }
  {
    const existing = booking();
    const { deps, calls } = makeFake({ person: [existing], rescheduleThrows: () => new VerifyUnavailableError() });
    const out = await refusal(() => placeBooking({ ...base, move: { bookingId: "bk-existing", reason: { code: "other", detail: null } } }, deps));
    assert(out instanceof VerifyUnavailableError && calls.reschedule.length === 1, "a transient outage on the move is reported, never falls to the placeholder");
  }
  {
    // A double submit of the move: the first already moved it, so it sits at the start now.
    const moved = booking({ starts_at: START, status: "rescheduled", assigned_user_id: "b" });
    const { deps, calls } = makeFake({ person: [moved], rescheduleAnswer: () => moved });
    const out = await placeBooking({ ...base, move: { bookingId: "bk-existing", reason: { code: "other", detail: null } } }, deps);
    assert(out.kind === "moved" && out.booking.id === "bk-existing", "a repeat of a move answers the same moved booking");
    assert(calls.create.length === 0, "and books nothing");
  }
  {
    // The reschedule handed back the call where it was (a move of it to this time still in flight).
    const { deps } = makeFake({ person: [booking()], rescheduleAnswer: () => booking() });
    const out = await refusal(() => placeBooking({ ...base, move: { bookingId: "bk-existing", reason: { code: "other", detail: null } } }, deps));
    assert(out instanceof RescheduleConflictError, `a move answered with the call still at its old time is the conflict it is, never "moved" (got ${String(out)})`);
  }
  {
    // A confirmation for a call that is no longer the customer's active one.
    const { deps, calls } = makeFake({ person: [booking({ id: "bk-other" })] });
    const out = await placeBooking({ ...base, move: { bookingId: "bk-existing", reason: { code: "other", detail: null } } }, deps);
    assert(out.kind === "existing-call" && out.call.bookingId === "bk-other" && calls.reschedule.length === 0,
      "a confirmation naming another call shows the customer's current call again, moving nothing");
    const gone = makeFake({ person: [] });
    const refused = await refusal(() => placeBooking({ ...base, move: { bookingId: "bk-existing", reason: { code: "other", detail: null } } }, gone.deps));
    assert(refusedFor(refused) === "confirmed-call-changed", `a confirmation for a call that is no longer active is refused, never a new booking (got ${refusedFor(refused)})`);
    assert(gone.calls.create.length === 0, "and books nothing");
  }
  for (const [label, over, matchedOn] of [
    ["email and phone", { salesforce_id: "00Q000000000999" }, "email-and-phone"],
    ["the phone only", { salesforce_id: null, attendee_email: "other@x.com" }, "email-or-phone"],
  ] as const) {
    const { deps, calls } = makeFake({ person: [booking(over)] });
    const out = await placeBooking({ ...base, move: { bookingId: "bk-existing", reason: { code: "other", detail: null } } }, deps);
    assert(out.kind === "possible-match" && out.matchedOn === matchedOn && out.call.bookingId === "bk-existing",
      `a call matching on ${label} but not the Lead id is shown (got ${out.kind})`);
    assert(calls.create.length === 0 && calls.reschedule.length === 0, `a ${label} match is refused: nothing booked or moved, even when confirmed`);
  }
  {
    const { deps, calls } = makeFake({ personThrows: true });
    const out = await refusal(() => placeBooking(base, deps));
    assert(out instanceof ExistingCallCheckUnavailableError && calls.create.length === 0, "an unreadable existing call check refuses, never books blind");
  }
  {
    const onIt = booking({ assigned_user_id: "p", kind: "staff_placed", agent_name: "Marcia" });
    const { deps } = makeFake({ person: [onIt] });
    const out: PlacedBookingOutcome = await placeBooking(base, deps);
    assert(out.kind === "existing-call" && out.call.onPlaceholder === true, "a call already on the placeholder is shown as one");
  }
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});
