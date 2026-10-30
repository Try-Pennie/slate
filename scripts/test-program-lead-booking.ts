// #4391: booking and moving a program lead, the decisions `program-lead-booking.ts` makes.
//
//   - a start the bucket's cache serves books a real advisor through the normal create,
//     marked program_lead; a lost race there falls to the placeholder;
//   - a start the cache does not serve goes STRAIGHT to the placeholder, so the normal
//     create (and with it the refused routing decision and the offer judgement) never runs;
//   - the placeholder path runs in the order the plan fixes: the hours and horizon check,
//     the day claim, then the reservation and invite (`createPlaceholderBooking`), so an
//     over limit lead is never invited;
//   - a double submit is answered with the first booking, whichever path made it;
//   - the go live switch off or unreadable means no placeholder, ever;
//   - a move tries a real advisor first through the shared reschedule, and only then
//     claims the new day with the booking's own id and moves onto the placeholder.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-program-lead-booking.ts
import {
  bookProgramLead,
  moveProgramLead,
  PlaceholderDayFullError,
  type ProgramLeadBookingDeps,
  type ProgramLeadMoveDeps,
} from "../src/lib/booking/program-lead-booking.ts";
import { placeholderCallDay, placeholderStarts } from "../src/lib/booking/program-lead-times.ts";
import {
  ExistingCallError,
  NoEligibleAgentsError,
  OutsideCallingWindowError,
  SlotUnavailableError,
  UnknownBucketError,
  VerifyUnavailableError,
  stableKeyFor,
  type BookingResult,
  type CreateBookingInput,
  type PlaceholderBookingInput,
} from "../src/lib/booking/orchestration.ts";
import type { BusinessHoursRules } from "../src/lib/availability/compute.ts";
import type { Booking, Bucket, EventType, User } from "../src/lib/db/types.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

// Monday 2026-06-08, 10:00 Eastern. Pennie is open 09:00 to 21:00 Eastern every weekday.
const NOW = Date.parse("2026-06-08T14:00:00.000Z");
const START = "2026-06-09T15:00:00.000Z"; // Tuesday 11:00 Eastern
const HOURS: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 21 * 60 })),
  exceptions: [],
} as unknown as BusinessHoursRules;

const bucket = { id: "bkt1", org_id: "org1", code: "411", is_test: false, criteria: {} } as unknown as Bucket;
const eventType = { id: "et1", name: "Call", duration_min: 30, slot_interval_min: 30, min_notice_min: 60 } as unknown as EventType;
const placeholder = { id: "p", name: "Marcia", email: "marcia@x.com", is_placeholder: true, is_test: false } as unknown as User;

const input: CreateBookingInput = {
  bucketCode: "411",
  requestedCode: "411",
  startIso: START,
  timezone: "America/Chicago",
  salesforceId: "00Q000000000001",
  attendee: { name: "Kris Lead", email: "k@x.com", phone: "+12035615295" },
  prefill: { source: "booking", partnerSubmissionId: "sub-9" },
  referrerOrigin: "https://www.trypennie.com",
  refuseIfPersonHasCall: true,
};
const KEY = stableKeyFor(input)!;

function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: "bk-new",
    kind: "routed",
    assigned_user_id: "a",
    agent_name: "Agent A",
    starts_at: START,
    manage_token: "tok-new",
    program_lead: true,
    salesforce_id: "00Q000000000001",
    timezone: "America/Chicago",
    ...over,
  } as unknown as Booking;
}

interface Opts {
  enabled?: boolean | null;
  served?: boolean | null;
  createThrows?: unknown;
  replay?: Booking | null;
  existingCall?: boolean;
  claim?: boolean | "throws";
  placeholder?: User | null;
  horizon?: number | null;
  bucket?: Bucket;
  /** The limit refusal count fails (`bump_program_lead_outcome`, 0215). */
  countThrows?: boolean;
}

function makeBookDeps(o: Opts = {}) {
  const steps: string[] = [];
  const calls = {
    create: [] as CreateBookingInput[],
    claims: [] as { day: string; key: string; bookingId: string | null }[],
    placed: [] as PlaceholderBookingInput[],
    limitRefused: [] as string[],
  };
  const deps: ProgramLeadBookingDeps = {
    now: () => NOW,
    placeholderEnabled: async () => (o.enabled === undefined ? true : o.enabled),
    isServedSlot: async () => {
      steps.push("served");
      return o.served === undefined ? false : o.served;
    },
    createBooking: async (i) => {
      steps.push("create");
      calls.create.push(i);
      if (o.createThrows) throw o.createThrows;
      return { booking: booking(), manageUrl: "https://x/manage/tok-new", newlyInserted: true };
    },
    findBookingByIdempotencyKey: async (key) => {
      steps.push(`replay:${key === KEY ? "key" : key}`);
      return o.replay ?? null;
    },
    manageUrl: (token) => `https://x/manage/${token}`,
    resolveBucketByCode: async () => ({ bucket: o.bucket ?? bucket, eventType }),
    findExistingCall: async () => {
      steps.push("existing-call");
      return o.existingCall ? { disclose: false } : null;
    },
    businessHours: async () => {
      steps.push("hours");
      return HOURS;
    },
    horizonDays: async () => {
      steps.push("horizon");
      return o.horizon === undefined ? 10 : o.horizon;
    },
    findPlaceholder: async () => (o.placeholder === undefined ? placeholder : o.placeholder),
    claimPlaceholderDay: async (day, key, bookingId) => {
      steps.push("claim");
      calls.claims.push({ day, key, bookingId });
      if (o.claim === "throws") throw new Error("rpc down");
      return o.claim === undefined ? true : o.claim;
    },
    countLimitRefusal: async (day) => {
      calls.limitRefused.push(day);
      if (o.countThrows) throw new Error("bump_program_lead_outcome failed: rpc down");
    },
    createPlaceholderBooking: async (i) => {
      steps.push("placeholder-create");
      calls.placed.push(i);
      return { booking: booking({ kind: "staff_placed", assigned_user_id: "p", agent_name: "Marcia" }), manageUrl: "https://x/manage/tok-new", newlyInserted: true };
    },
  };
  return { deps, steps, calls };
}

async function refusal(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

async function run() {
  assert(placeholderCallDay(Date.parse("2026-06-10T02:30:00.000Z")) === "2026-06-09", "the call day is the Eastern date of the start (22:30 Eastern on the 9th)");
  assert(placeholderCallDay(Date.parse("2026-06-09T04:30:00.000Z")) === "2026-06-09", "and 00:30 Eastern is that same Eastern day, not the UTC one");

  // --- a real cached slot books a real advisor, marked as a program lead's ------------------
  {
    const { deps, steps, calls } = makeBookDeps({ served: true });
    const res = await bookProgramLead(input, deps);
    assert(res.path === "real-slot" && !res.onPlaceholder && res.result.booking.id === "bk-new", "a served start books a real advisor");
    assert(calls.create.length === 1 && calls.create[0].programLead === true, "through the normal create, marked program_lead");
    assert(calls.claims.length === 0 && calls.placed.length === 0, "and claims no place on the day's limit");
    assert(!steps.includes("hours"), "nor reads the placeholder's checks");
  }
  // An unreadable cache is read as a real slot: a real advisor is always asked first.
  {
    const { deps, calls } = makeBookDeps({ served: null });
    const res = await bookProgramLead(input, deps);
    assert(res.path === "real-slot" && calls.create.length === 1, "a cache that could not be read sends the confirm through the normal create");
  }

  // --- a lost race on a real slot falls to the placeholder -----------------------------------
  for (const lost of [new SlotUnavailableError(), new NoEligibleAgentsError()]) {
    const { deps, steps, calls } = makeBookDeps({ served: true, createThrows: lost });
    const res = await bookProgramLead(input, deps);
    assert(res.path === "lost-race" && res.onPlaceholder, `a ${lost.name} on a served start falls to the placeholder`);
    assert(calls.claims.length === 1 && calls.claims[0].key === KEY && calls.claims[0].bookingId === null && calls.claims[0].day === "2026-06-09",
      `it claims the call's Eastern day under the booker's own key (got ${JSON.stringify(calls.claims[0])})`);
    assert(calls.placed[0]?.idempotencyKey === KEY && calls.placed[0]?.placedByUserId === undefined, "and places the call under that key, placed by nobody");
    assert(calls.placed[0]?.programLead?.prefill.partnerSubmissionId === "sub-9" && calls.placed[0]?.programLead?.referrerOrigin === "https://www.trypennie.com",
      "carrying the link's prefill and the framing page");
    assert(steps.indexOf("hours") < steps.indexOf("claim") && steps.indexOf("claim") < steps.indexOf("placeholder-create"), `in order: hours, claim, then the reservation (got ${steps.join(",")})`);
  }
  // An outage is not a lost race: reported as itself, never parked on the placeholder.
  {
    const outage = new VerifyUnavailableError();
    const { deps, calls } = makeBookDeps({ served: true, createThrows: outage });
    const err = await refusal(() => bookProgramLead(input, deps));
    assert(err === outage && calls.placed.length === 0 && calls.claims.length === 0, "an outage on the normal create is answered as the outage");
  }

  // --- a start the cache does not serve goes STRAIGHT to the placeholder --------------------
  {
    const { deps, steps, calls } = makeBookDeps({ served: false });
    const res = await bookProgramLead(input, deps);
    assert(res.path === "straight" && res.onPlaceholder, "a placeholder only start books the placeholder");
    assert(calls.create.length === 0, "and the normal create never runs, so no refused routing decision or offer judgement is written");
    assert(steps.includes("existing-call") && steps.indexOf("existing-call") < steps.indexOf("claim"), "the one call per person rule runs before the claim");
    assert(steps[0] === "served" && steps[1] === "replay:key", `a replay read comes first (got ${steps.join(",")})`);
  }
  // Double submit: answered with the first booking, nothing claimed or written again.
  {
    const first = booking({ id: "bk-first", kind: "staff_placed", manage_token: "tok-first" });
    const { deps, calls } = makeBookDeps({ served: false, replay: first });
    const res = await bookProgramLead(input, deps);
    assert(res.result.booking.id === "bk-first" && res.result.manageUrl === "https://x/manage/tok-first", "a repeat of the submit answers the first booking");
    assert(calls.claims.length === 0 && calls.placed.length === 0, "and claims and writes nothing");
    // The first went to a real advisor; the repeat now finds its slot taken (by itself).
    const routedFirst = booking({ id: "bk-first", kind: "routed", manage_token: "tok-first" });
    const again = makeBookDeps({ served: false, replay: routedFirst });
    const res2 = await bookProgramLead(input, again.deps);
    assert(res2.result.booking.id === "bk-first" && !res2.onPlaceholder, "a repeat of a submit that booked a real advisor answers that booking");
  }
  // The lead already has a call: refused as the ordinary booker refuses, before the claim.
  {
    const { deps, calls } = makeBookDeps({ served: false, existingCall: true });
    const err = await refusal(() => bookProgramLead(input, deps));
    assert(err instanceof ExistingCallError && calls.claims.length === 0, "a lead holding a call is refused before any claim");
  }

  // --- over the day's limit: its own refusal, and nobody invited ------------------------------
  for (const served of [false, true]) {
    const { deps, calls } = makeBookDeps({ served, claim: false, ...(served ? { createThrows: new SlotUnavailableError() } : {}) });
    const err = await refusal(() => bookProgramLead(input, deps));
    assert(err instanceof PlaceholderDayFullError && err.callDay === "2026-06-09", `a full day refuses with its own error (${served ? "after a lost race" : "straight"})`);
    assert(!(err instanceof SlotUnavailableError), "never the time just taken refusal");
    assert(calls.placed.length === 0, "and no reservation or invite is made");
    assert(calls.limitRefused.length === 1 && calls.limitRefused[0] === "2026-06-09", `and the refusal is counted once, handed the call's day for its log (bump_program_lead_outcome counts it on the day it happened) (got ${JSON.stringify(calls.limitRefused)})`);
  }
  {
    const { deps, calls } = makeBookDeps({ served: false });
    await bookProgramLead(input, deps);
    assert(calls.limitRefused.length === 0, "control: a granted claim counts no refusal");
  }
  // A count that fails is logged and never changes what the lead is told.
  {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const { deps, calls } = makeBookDeps({ served: false, claim: false, countThrows: true });
      const err = await refusal(() => bookProgramLead(input, deps));
      assert(err instanceof PlaceholderDayFullError && calls.limitRefused.length === 1, `a failed count still answers the full day (got ${String(err)})`);
      assert(errors.some((l) => l.includes("program-lead-day-full") && l.includes("could not be counted")), `and the failed count is logged as an error (got ${JSON.stringify(errors)})`);
    } finally {
      console.error = original;
    }
  }
  // The claim itself failing is the retryable outage, never a booking or a full day.
  {
    const { deps, calls } = makeBookDeps({ served: false, claim: "throws" });
    const err = await refusal(() => bookProgramLead(input, deps));
    assert(err instanceof VerifyUnavailableError && calls.placed.length === 0, "a claim that could not be made is the retryable outage");
  }
  // A test bucket's call never takes a place on the real day's limit.
  {
    const testBucket = { ...bucket, is_test: true } as Bucket;
    const { deps, calls } = makeBookDeps({ served: false, bucket: testBucket, placeholder: { ...placeholder, is_test: true } as User });
    await bookProgramLead({ ...input, allowTestBuckets: true }, deps);
    assert(calls.claims.length === 0 && calls.placed.length === 1, "a test booking is placed without a claim");
    const hidden = makeBookDeps({ served: false, bucket: testBucket });
    const err = await refusal(() => bookProgramLead(input, hidden.deps));
    assert(err instanceof UnknownBucketError && hidden.calls.placed.length === 0, "and a test bucket without the test pass is unknown, as on the normal create");
  }

  // --- the placeholder's own checks -------------------------------------------------------
  const refusedStarts: [string, Partial<CreateBookingInput>, (e: unknown) => boolean][] = [
    ["in the past", { startIso: "2026-06-08T13:00:00.000Z" }, (e) => e instanceof SlotUnavailableError],
    ["inside the minimum notice", { startIso: "2026-06-08T14:30:00.000Z" }, (e) => e instanceof SlotUnavailableError],
    // Saturday 11:00 Eastern: Pennie is shut, and 10:00 is inside a Chicago lead's window.
    ["outside Pennie's hours", { startIso: "2026-06-13T15:00:00.000Z" }, (e) => e instanceof SlotUnavailableError],
    // 07:30 for a Los Angeles lead, while Pennie is open (10:30 Eastern).
    ["outside the lead's calling window", { startIso: "2026-06-09T14:30:00.000Z", timezone: "America/Los_Angeles" }, (e) => e instanceof OutsideCallingWindowError],
    ["beyond the horizon", { startIso: "2026-07-21T15:00:00.000Z" }, (e) => e instanceof SlotUnavailableError],
    // #4390's grid: 11:10 Eastern sits between two of the event type's 30 minute starts,
    // so the times never offered it and the confirm must not take it either.
    ["off the slot interval's grid", { startIso: "2026-06-09T15:10:00.000Z" }, (e) => e instanceof SlotUnavailableError],
  ];
  // The confirm takes exactly the placeholder starts the lead is shown (one predicate):
  // the main start is one of #4390's `placeholderStarts` for this lead.
  {
    const shown = placeholderStarts({ hours: HOURS, zone: input.timezone, nowMs: NOW, horizonDays: 10, eventType });
    assert(shown.includes(START), `the start the suite books is one the times offer (${shown.length} starts offered)`);
    assert(!shown.includes("2026-06-09T15:10:00.000Z"), "and the off grid start is not");
  }
  for (const [label, over, expected] of refusedStarts) {
    const { deps, calls } = makeBookDeps({ served: false });
    const err = await refusal(() => bookProgramLead({ ...input, ...over }, deps));
    assert(expected(err), `a start ${label} is refused (got ${String(err)})`);
    assert(calls.claims.length === 0 && calls.placed.length === 0, `and claims nothing (${label})`);
  }
  {
    const { deps, calls } = makeBookDeps({ served: false, horizon: null });
    const err = await refusal(() => bookProgramLead(input, deps));
    assert(err instanceof VerifyUnavailableError && calls.claims.length === 0, "an unreadable horizon is the retryable outage");
  }

  // --- the go live switch -----------------------------------------------------------------
  for (const enabled of [false, null]) {
    const { deps, steps, calls } = makeBookDeps({ enabled, served: false, createThrows: new SlotUnavailableError() });
    const err = await refusal(() => bookProgramLead(input, deps));
    assert(err instanceof SlotUnavailableError && calls.create.length === 1 && calls.create[0].programLead === true,
      `with the switch ${enabled === null ? "unreadable" : "off"} the confirm is the normal create, still marked`);
    assert(calls.placed.length === 0 && calls.claims.length === 0 && !steps.includes("served"), "and never reaches the placeholder");
  }

  // --- no placeholder to hold the call ----------------------------------------------------
  {
    const lost = new SlotUnavailableError();
    const { deps } = makeBookDeps({ served: true, createThrows: lost, placeholder: null });
    const err = await refusal(() => bookProgramLead(input, deps));
    assert(err === lost, "with no placeholder a lost race is answered as the lost race it was");
    const straight = makeBookDeps({ served: false, placeholder: null });
    const err2 = await refusal(() => bookProgramLead(input, straight.deps));
    assert(err2 instanceof SlotUnavailableError && straight.calls.claims.length === 0, "and a placeholder only start is refused before any claim");
  }

  // --- moves ------------------------------------------------------------------------------
  const moving = booking({ id: "bk-move", kind: "routed", starts_at: "2026-06-11T15:00:00.000Z", manage_token: "tok-move" });
  function makeMoveDeps(o: Opts & { rescheduleThrows?: unknown } = {}) {
    const book = makeBookDeps(o);
    const reschedules: { ontoPlaceholder?: User }[] = [];
    const deps: ProgramLeadMoveDeps = {
      now: book.deps.now,
      placeholderEnabled: book.deps.placeholderEnabled,
      isServedSlot: book.deps.isServedSlot,
      businessHours: book.deps.businessHours,
      horizonDays: book.deps.horizonDays,
      findPlaceholder: book.deps.findPlaceholder,
      claimPlaceholderDay: book.deps.claimPlaceholderDay,
      countLimitRefusal: book.deps.countLimitRefusal,
      reschedule: async (args) => {
        book.steps.push(args.ontoPlaceholder ? "move-onto-placeholder" : "move");
        reschedules.push(args);
        if (!args.ontoPlaceholder && o.rescheduleThrows) throw o.rescheduleThrows;
        const moved = booking({ id: "bk-move", starts_at: START, ...(args.ontoPlaceholder ? { kind: "staff_placed", assigned_user_id: "p" } : {}) });
        return { booking: moved, manageUrl: "https://x/manage/tok-move" } as BookingResult;
      },
    };
    return { deps, steps: book.steps, calls: book.calls, reschedules };
  }
  const move = { booking: moving, bucket, eventType, startIso: START, zone: "America/Chicago" };
  {
    const { deps, calls, reschedules } = makeMoveDeps({ served: true });
    const res = await moveProgramLead(move, deps);
    assert(res.path === "real-slot" && !res.onPlaceholder && reschedules.length === 1 && reschedules[0].ontoPlaceholder === undefined,
      "a move to a served start is the ordinary move");
    assert(calls.claims.length === 0, "and claims nothing");
  }
  {
    const { deps, steps, calls, reschedules } = makeMoveDeps({ served: true, rescheduleThrows: new NoEligibleAgentsError() });
    const res = await moveProgramLead(move, deps);
    assert(res.path === "lost-race" && res.onPlaceholder, "a move nobody real can take falls onto the placeholder");
    assert(calls.claims[0]?.bookingId === "bk-move" && calls.claims[0]?.day === "2026-06-09" && calls.claims[0]?.key === "program-move:bk-move",
      `it claims the NEW day with the moving booking's own id (got ${JSON.stringify(calls.claims[0])})`);
    assert(reschedules[1]?.ontoPlaceholder?.id === "p", "then moves onto the placeholder");
    assert(steps.indexOf("hours") < steps.indexOf("claim") && steps.indexOf("claim") < steps.indexOf("move-onto-placeholder"), `in order: hours, claim, move (got ${steps.join(",")})`);
  }
  {
    const { deps, reschedules } = makeMoveDeps({ served: false });
    const res = await moveProgramLead(move, deps);
    assert(res.path === "straight" && reschedules.length === 1 && reschedules[0].ontoPlaceholder?.id === "p", "a move to a placeholder only start goes straight onto the placeholder");
  }
  {
    const { deps, reschedules } = makeMoveDeps({ served: false, claim: false });
    const err = await refusal(() => moveProgramLead(move, deps));
    assert(err instanceof PlaceholderDayFullError && reschedules.length === 0, "a move onto a full day is refused with its own error, and nothing moves");
  }
  for (const enabled of [false, null]) {
    const lost = new SlotUnavailableError();
    const { deps, reschedules } = makeMoveDeps({ enabled, served: false, rescheduleThrows: lost });
    const err = await refusal(() => moveProgramLead(move, deps));
    assert(err === lost && reschedules.length === 1 && reschedules[0].ontoPlaceholder === undefined, `with the switch ${enabled === null ? "unreadable" : "off"} a move is only ever the ordinary one`);
  }
  {
    // A "move" onto the time the call already holds is the ordinary no-op, never a claim.
    const { deps, calls, reschedules } = makeMoveDeps({ served: false });
    await moveProgramLead({ ...move, startIso: moving.starts_at }, deps);
    assert(calls.claims.length === 0 && reschedules[0]?.ontoPlaceholder === undefined, "a move onto the call's own time claims nothing");
  }
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});
