// #4202: the coordinator's one booking operation (`placeBooking`), driven through hand
// written fakes of everything it reads and calls.
//
// The decided rules (Sam and Dan, 2026-10-23), each with its failure path:
//   - kept: the org's business hours, the customer's calling window in the zone given (missing zone refused, never
//     defaulted), the horizon, and nothing in the past;
//   - a free real advisor first, through the normal create; only a refusal for want of
//     one falls to the placeholder, and a transient outage is reported as itself;
//   - the placeholder of the bucket's own org and world, or a refusal naming its absence;
//   - the go live switch gates ONLY the fall to the placeholder (Dan, 2026-10-26): off or
//     unreadable, a free real advisor still books (and a confirmed move still moves to
//     one); only a refusal for want of one is then refused by name, off or unreadable;
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
import { assert, eq, finish } from "./lib/harness.ts";

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
    // A free lock table of its own; the races below share one between two requests.
    customerLock: lockTable().deps,
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

  // --- the go live switch gates only the fall to the placeholder (Dan, 2026-10-26) --------------
  for (const [label, enabled] of [["off", false], ["unreadable", null]] as const) {
    const { deps, calls } = makeFake({ enabled });
    const out = await placeBooking(base, deps);
    assert(out.kind === "booked" && out.on === "advisor", `switch ${label}, a free advisor: the advisor is booked (got ${out.kind})`);
    assert(calls.create.length === 1 && calls.placeholderLookups.length === 0, `switch ${label}: through the normal create, never asking for the placeholder`);
  }
  for (const [label, enabled, reason] of [["off", false, "switch-off"], ["unreadable", null, "switch-unreadable"]] as const) {
    const { deps, calls } = makeFake({ enabled, createThrows: () => new SlotUnavailableError() });
    const out = await refusal(() => placeBooking(base, deps));
    assert(refusedFor(out) === reason, `switch ${label}, nobody free: refused as ${reason} (got ${refusedFor(out)})`);
    assert(calls.create.length === 1 && calls.placeholderCreate.length === 0 && calls.placeholderLookups.length === 0,
      `switch ${label}: the advisor path was tried, and nothing goes on the placeholder`);
  }
  {
    // A confirmed move with the switch off: a free advisor takes it; nobody free refuses.
    const reason = { code: "other", detail: null };
    const free = makeFake({ enabled: false, person: [booking()] });
    const moved = await placeBooking({ ...base, move: { bookingId: "bk-existing", reason } }, free.deps);
    assert(moved.kind === "moved" && moved.on === "advisor", "switch off, a confirmed move to a free advisor still moves the call");
    const full = makeFake({ enabled: false, person: [booking()], rescheduleThrows: () => new NoEligibleAgentsError() });
    const out = await refusal(() => placeBooking({ ...base, move: { bookingId: "bk-existing", reason } }, full.deps));
    assert(refusedFor(out) === "switch-off" && full.calls.reschedule.length === 1,
      `switch off, a move with nobody free is refused as switch-off, never moved onto the placeholder (got ${refusedFor(out)})`);
  }
  for (const enabled of [false, null] as const) {
    const first = booking({ id: "bk-first", kind: "staff_placed", idempotency_key: key, assigned_user_id: "p" });
    const { deps, calls } = makeFake({ enabled, replay: first });
    const out = await placeBooking(base, deps);
    assert(out.kind === "booked" && out.booking.id === "bk-first" && out.replayed === true,
      `switch ${enabled === null ? "unreadable" : "off"}: a repeat of a submission that already booked answers that booking`);
    assert(calls.create.length === 0, "and nothing is made again");
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
    // #4205: Slate stores whichever spelling of the Lead id a caller sent, so the
    // customer's call is found under the 15 character id and the 18 character one alike.
    const LONG = "00Q000000000001EAA"; // the Q is uppercase, so the first block's checksum is E
    for (const [label, stored, asked] of [
      ["stored long, asked short", LONG, "00Q000000000001"],
      ["stored short, asked long", "00Q000000000001", LONG],
    ] as const) {
      const { deps } = makeFake({ person: [booking({ salesforce_id: stored, attendee_email: "other@x.com", attendee_phone: null })] });
      const out = await placeBooking({ ...base, salesforceLeadId: asked }, deps);
      assert(out.kind === "existing-call", `${label}: the customer's call is their own, matched on the Lead id (got ${out.kind})`);
    }
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

  await races();
}

// --- #4261: two coordinators booking one customer at the same moment ---------------------------
//
// `placeBooking` reads the customer's calls and then creates, so two submissions under
// different ids could each read "no call" before either created one. One lock table and
// one bookings store are shared by both requests here, the create yields to the event
// loop the way a real one does while it waits on Google, and the two run concurrently,
// so the interleaving that made two calls is the one actually driven.

/** A `sync_locks` stand in with the table's semantics: a key is claimed by whoever inserts it first. */
function lockTable() {
  const held = new Map<string, string>();
  let n = 0;
  const log: string[] = [];
  let clock = NOW;
  return {
    held,
    log,
    deps: {
      claim: async (key: string) => {
        if (held.has(key)) {
          log.push(`held ${key}`);
          return { kind: "held" as const };
        }
        const token = `t${++n}`;
        held.set(key, token);
        log.push(`claimed ${key}`);
        return { kind: "claimed" as const, token };
      },
      release: async (key: string, token: string) => {
        if (held.get(key) !== token) return "not-held" as const;
        held.delete(key);
        log.push(`released ${key}`);
        return "released" as const;
      },
      // A virtual clock: each wait moves it by the wait asked for, and yields so the
      // other request runs meanwhile. No real time passes (L524).
      sleep: async (ms: number) => {
        clock += ms;
        await new Promise((r) => setImmediate(r));
      },
      now: () => clock,
    },
  };
}

const yields = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Deps for one request over a shared store and lock table. */
function racer(store: Booking[], locks: ReturnType<typeof lockTable>, created: string[]) {
  const { deps } = makeFake();
  return {
    ...deps,
    customerLock: locks.deps,
    findBookingByIdempotencyKey: async (key: string) => store.find((b) => b.idempotency_key === key) ?? null,
    findActiveBookingsForPerson: async (identity: { salesforceId: string | null }) => {
      await yields(1);
      return store.filter((b) => b.salesforce_id?.slice(0, 15) === identity.salesforceId?.slice(0, 15));
    },
    createBooking: async (input: CreateBookingInput) => {
      // The create's own reads and Google calls, during which the other request runs.
      await yields(5);
      const made = booking({
        id: `bk-${input.idempotencyKey}`,
        idempotency_key: input.idempotencyKey,
        salesforce_id: input.salesforceId,
        starts_at: input.startIso,
        manage_token: `tok-${input.idempotencyKey}`,
      });
      store.push(made);
      created.push(made.id);
      return { booking: made, manageUrl: `https://slate.test/booking/manage/${made.manage_token}`, newlyInserted: true };
    },
  } as PlacedBookingDeps;
}

async function races() {
  const SECOND = "6f1c2d3e-0000-4000-8000-000000000002";
  {
    const store: Booking[] = [];
    const locks = lockTable();
    const created: string[] = [];
    const [a, b] = await Promise.all([
      placeBooking({ ...base, coordinatorUserId: "coord-1", submissionId: SUBMISSION }, racer(store, locks, created)),
      placeBooking({ ...base, coordinatorUserId: "coord-2", submissionId: SECOND }, racer(store, locks, created)),
    ]);
    eq(created.length, 1, "#4261: two coordinators booking one customer at once make exactly ONE call");
    const kinds = [a.kind, b.kind].sort().join(",");
    eq(kinds, "booked,existing-call", "one is booked and the other is answered with the call that now exists");
    const winner = a.kind === "booked" ? a : b;
    const loser = a.kind === "booked" ? b : a;
    assert(
      winner.kind === "booked" && loser.kind === "existing-call" && loser.call.bookingId === winner.booking.id,
      "the existing call the second coordinator is shown is the one the first just booked",
    );
    assert(locks.log.some((l) => l.startsWith("held")), "the second really waited on the first's claim (the race was driven, not sequential)");
    eq(locks.held.size, 0, "and every claim was released afterwards");
  }
  {
    // The same race under the other spelling of the Lead id: one customer is one key.
    const store: Booking[] = [];
    const locks = lockTable();
    const created: string[] = [];
    await Promise.all([
      placeBooking({ ...base, salesforceLeadId: "00Q000000000001", submissionId: SUBMISSION }, racer(store, locks, created)),
      placeBooking({ ...base, salesforceLeadId: "00Q000000000001EAA", submissionId: SECOND }, racer(store, locks, created)),
    ]);
    eq(created.length, 1, "the 15 and the 18 character spellings of one Lead are one customer, so still one call");
  }
  {
    // CONTROL: two different customers at the same moment both book; neither waits on the other.
    const store: Booking[] = [];
    const locks = lockTable();
    const created: string[] = [];
    const [a, b] = await Promise.all([
      placeBooking({ ...base, salesforceLeadId: "00Q000000000001", submissionId: SUBMISSION }, racer(store, locks, created)),
      placeBooking({ ...base, salesforceLeadId: "00Q000000000777", attendee: { name: "Other", email: "o@x.com", phone: "+12035550100" }, submissionId: SECOND }, racer(store, locks, created)),
    ]);
    eq(created.length, 2, "control: two different customers booked at the same moment both get a call");
    assert(a.kind === "booked" && b.kind === "booked", "control: and both are answered as booked");
    assert(!locks.log.some((l) => l.startsWith("held")), "control: neither waited on the other's claim");
  }
  {
    // A double submit racing itself (the same submission id) still answers the first's booking.
    const store: Booking[] = [];
    const locks = lockTable();
    const created: string[] = [];
    const [a, b] = await Promise.all([
      placeBooking(base, racer(store, locks, created)),
      placeBooking(base, racer(store, locks, created)),
    ]);
    eq(created.length, 1, "a double submit racing itself books once");
    assert(a.kind === "booked" && b.kind === "booked" && [a.replayed, b.replayed].sort().join(",") === "false,true",
      "and the repeat is answered with the first's booking, as a replay, never as an existing call");
  }
  {
    // A claim held for longer than the wait: refused as busy, nothing read or booked.
    const locks = lockTable();
    locks.held.set("coordinator_customer:00Q000000000001", "someone-else");
    const { deps, calls } = makeFake();
    const out = await refusal(() => placeBooking(base, { ...deps, customerLock: locks.deps } as PlacedBookingDeps));
    eq(refusedFor(out), "customer-busy", "a customer another coordinator is still booking is refused as busy once the wait runs out");
    assert(calls.create.length === 0 && calls.personWorlds.length === 0 && calls.keys.length === 0, "and nothing was read or booked");
    eq(locks.held.get("coordinator_customer:00Q000000000001"), "someone-else", "and the other coordinator's claim is left alone");
  }
  {
    // The lock table could not answer: an outage, said as one, never as "busy".
    const locks = lockTable();
    const { deps, calls } = makeFake();
    const out = await refusal(() =>
      placeBooking(base, { ...deps, customerLock: { ...locks.deps, claim: async () => ({ kind: "refused" as const }) } } as PlacedBookingDeps),
    );
    eq(refusedFor(out), "customer-lock-unavailable", "a claim that could not be made is refused as the outage it is (L11)");
    assert(calls.create.length === 0, "and books nothing");
  }
  {
    // A booking that throws still releases the claim, so the customer is not held for the TTL.
    const locks = lockTable();
    const { deps } = makeFake({ createThrows: () => new VerifyUnavailableError() });
    const out = await refusal(() => placeBooking(base, { ...deps, customerLock: locks.deps } as PlacedBookingDeps));
    assert(out instanceof VerifyUnavailableError, "the booking's own failure is what the coordinator is told");
    eq(locks.held.size, 0, "and the claim was released on the way out");
  }
  {
    // A release that could not run changes nothing about the answer: the TTL frees it.
    const locks = lockTable();
    const { deps } = makeFake();
    const out = await placeBooking(base, { ...deps, customerLock: { ...locks.deps, release: async () => "refused" as const } } as PlacedBookingDeps);
    eq(out.kind, "booked", "a refused release still answers the booking that was made");
  }
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});
