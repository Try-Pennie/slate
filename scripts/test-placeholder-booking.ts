// #4202, #4203: the booking machinery the coordinator's placeholder booking runs on.
//
//   - `createPlaceholderBooking`: a call placed on the placeholder advisor through the
//     SAME reservation and one call save every booking uses, skipping only what the
//     placeholder never needs (verify on book, the confirm line, the slot cache);
//   - `createBooking` from the coordinator page records its source and who placed it;
//   - `rescheduleBooking` never keeps a call on the placeholder (#4203): the manage page,
//     the direct API's person dedupe and Marcia's MCP channel all move it to a real
//     advisor, routed, with `left_placeholder` on the event; and its `ontoPlaceholder`
//     move commits through 0208's function;
//   - `reassignBooking` moves a call off the placeholder the same way, refuses one onto
//     it, and refuses a staff placed call for the owner automation.
//
// Run: node --experimental-strip-types scripts/test-placeholder-booking.ts
import {
  createBooking,
  createPlaceholderBooking,
  rescheduleBooking,
  reassignBooking,
  bookViaApi,
  AgentNotAvailableError,
  NoEligibleAgentsError,
  ReassignAcrossWorldsError,
  SlotUnavailableError,
  StaffPlacedReassignRefusedError,
  type ApiBookingInput,
} from "../src/lib/booking/orchestration.ts";
import type { Booking, Bucket, User } from "../src/lib/db/types.ts";
import { placeholderReplyLine } from "../src/lib/booking/manage-copy.ts";
import { createAsserter, makeDeps, makeBooking, bucket, eventType, input, users, NOW, RR, SYS } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const placeholder = users.p;
const START = "2026-06-08T15:00:00.000Z";
const KEY = "coordinator:6f1c2d3e-0000-4000-8000-000000000001";
const placedInput = {
  bucket,
  eventType,
  placeholder,
  startIso: START,
  timezone: "America/Chicago",
  salesforceId: "00Q000000000001",
  attendee: { name: "Kris Lead", email: "k@x.com", phone: "+12035615295" },
  idempotencyKey: KEY,
  placedByUserId: "coord-1",
};

/** A staff placed call on the placeholder, as 0207 and 0208 store one. */
function onPlaceholder(over: Partial<Booking> = {}): Booking {
  return makeBooking({
    assigned_user_id: "p",
    agent_name: "Marcia",
    agent_email: "marcia@x.com",
    kind: "staff_placed",
    allow_double_book: true,
    ...over,
  });
}

async function run() {
  // --- a call placed on the placeholder: one reservation, one save, no live check -----------
  {
    const { deps, calls } = makeDeps({ candidates: [] });
    const res = await createPlaceholderBooking(placedInput, deps);
    assert(res.booking.id === "bk-new" && res.newlyInserted === true, "the placeholder booking is saved, newly, by this call");
    assert(calls.reservations.length === 1 && calls.reservations[0].pinned_user_id === "p" && calls.reservations[0].idempotency_key === KEY,
      "it reserves first, pinned to the placeholder, under the submission's key");
    assert(calls.createEvent.length === 1 && calls.createEvent[0].email === "marcia@x.com", "the invite goes on the placeholder's own calendar");
    assert(calls.createEvent[0].args.summary.includes("Marcia") && calls.createEvent[0].args.timezone === "America/Chicago",
      `the invite names the placeholder and is in the customer's own zone (got ${calls.createEvent[0].args.summary})`);
    // #4206: the seat's inbox is not read, so the invite sends the customer to our texts.
    assert(String(calls.createEvent[0].args.description).endsWith(placeholderReplyLine("invite")),
      `the placeholder's invite ends with the reply to our texts line (got ${calls.createEvent[0].args.description})`);
    const row = calls.insertBooking[0] ?? {};
    assert(row.kind === "staff_placed" && row.allow_double_book === true, "the row is staff placed and stacks");
    assert(row.assigned_user_id === "p" && row.agent_name === "Marcia" && row.agent_email === "marcia@x.com", "on the placeholder");
    assert(row.source === "coordinator" && row.placed_by_user_id === "coord-1", "from the coordinator page, naming who placed it");
    assert(row.routing_trace === null, "with no routing trace: nothing was routed onto the placeholder");
    assert(row.bucket_id === bucket.id && row.timezone === "America/Chicago" && row.salesforce_id === "00Q000000000001",
      "in the customer's own bucket and zone, under their Lead id");
    assert(row.starts_at === START && row.ends_at === "2026-06-08T15:30:00.000Z", "at the time the customer named, for the event type's length");
    assert(calls.verifyFree.length === 0 && calls.roundRobinPreview.length === 0, "verify on book and the round robin read are skipped for the placeholder");
    assert(calls.recordRoutingDecision.length === 0, "no routing decision is recorded: nothing was routed");
    assert(calls.invalidateSlots.length === 0, "the slot cache is left alone: the placeholder serves no pool");
    assert(calls.moveBusyBlock.length === 1 && calls.moveBusyBlock[0].userId === "p", "the busy block is written for the placeholder, as for every booking");
    const created = calls.webhooks.find((w) => w.event === "booking.created");
    assert(created?.bookingKind === "staff_placed", `booking.created goes out as staff placed (got ${created?.bookingKind})`);
    assert(calls.deletedReservations.includes("resv-1"), "and the reservation is deleted once the webhook is in");
  }

  // --- a double submit answers the booking the first made, writing nothing ----------------
  {
    const first = onPlaceholder({ id: "bk-first", idempotency_key: KEY });
    const { deps, calls } = makeDeps({ existingByKey: first });
    const res = await createPlaceholderBooking(placedInput, deps);
    assert(res.booking.id === "bk-first" && res.newlyInserted === undefined, "a repeat of the submission is answered with the booking it made");
    assert(calls.idempotencyLookups.includes(KEY), "found by the submission's key");
    assert(calls.reservations.length === 0 && calls.createEvent.length === 0 && calls.insertBooking.length === 0, "and nothing is reserved, invited or written again");
  }

  // --- a test bucket's call goes on the TEST placeholder only --------------------------------
  {
    const { deps } = makeDeps({});
    const testBucket = { ...bucket, is_test: true } as Bucket;
    let refused: unknown = null;
    try {
      await createPlaceholderBooking({ ...placedInput, bucket: testBucket }, deps);
    } catch (err) {
      refused = err;
    }
    assert(refused instanceof ReassignAcrossWorldsError, `a real placeholder is refused for a test bucket's call (got ${String(refused)})`);
  }

  // --- the coordinator's call to a REAL advisor records its source and who placed it --------
  {
    const { deps, calls } = makeDeps({ candidates: ["a"] });
    const res = await createBooking({ ...input, idempotencyKey: KEY, placedByUserId: "coord-1", prefill: {} }, deps);
    const row = calls.insertBooking[0] ?? {};
    assert(res.booking.id === "bk-new" && row.assigned_user_id === "a", "a free advisor takes the coordinator's call through the normal create");
    assert(row.source === "coordinator" && row.placed_by_user_id === "coord-1" && row.kind === "routed",
      `it is routed, from the coordinator page, naming who placed it (got ${String(row.source)}, ${String(row.placed_by_user_id)})`);
    assert(row.allow_double_book === undefined, "and it does not stack: the column keeps its default");
    assert(calls.verifyFree.length === 1, "verify on book ran for the real advisor");
    const plain = makeDeps({ candidates: ["a"] });
    await createBooking(input, plain.deps);
    const plainRow = plain.calls.insertBooking[0] ?? {};
    assert(plainRow.placed_by_user_id === undefined && plainRow.source !== "coordinator", "control: a lead's own booking names nobody and is not from the coordinator page");
  }

  // --- #4203: the manage page never keeps a call on the placeholder -------------------------
  for (const placeholderFree of [false, true]) {
    const ctx = { booking: onPlaceholder(), bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      candidates: ["a"],
      freeEmails: new Set(["a@x.com", ...(placeholderFree ? ["marcia@x.com"] : [])]),
    });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW, undefined, undefined, { leadZone: "America/New_York" });
    const label = placeholderFree ? " (the placeholder's calendar reads free)" : "";
    assert(calls.updateEventTime.length === 0, `the move never patches the placeholder's invite in place${label}`);
    assert(calls.busyIntervalsForAgent.length === 0, `nor reads the placeholder's calendar to keep it${label}`);
    assert(calls.createEvent.length === 1 && calls.createEvent[0].email === "a@x.com", `the call goes to a real advisor in the bucket${label}`);
    const commit = calls.commitReschedule[0];
    assert(commit?.patch.assigned_user_id === "a" && commit.ontoPlaceholder === undefined, `committed by the ordinary reschedule onto the advisor${label}`);
    assert((commit?.outbox?.payload as { leftPlaceholder?: boolean } | undefined)?.leftPlaceholder === true, `the outbox row records that the move left the placeholder${label}`);
    assert(ctx.booking.kind === "routed" && ctx.booking.allow_double_book === false, `the stored call is routed and no longer stacks${label}`);
    assert(res.booking.kind === "routed" && res.booking.assigned_user_id === "a", `and the answer says so${label}`);
    const moved = calls.webhooks.find((w) => w.event === "booking.rescheduled");
    assert(moved?.leftPlaceholder === true && moved.bookingKind === "routed", `booking.rescheduled carries left_placeholder, as routed${label}`);
    assert(calls.deleteEvent.some((d) => d.id === "gcal-old"), `and the placeholder's old invite is removed${label}`);
  }
  // Nobody free: refused for that reason, and the call stays exactly where it was.
  {
    const ctx = { booking: onPlaceholder(), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx, candidates: [], freeEmails: new Set(["marcia@x.com"]) });
    let refused: unknown = null;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW, undefined, undefined, { leadZone: "America/New_York" });
    } catch (err) {
      refused = err;
    }
    assert(refused instanceof SlotUnavailableError || refused instanceof NoEligibleAgentsError, `with no real advisor free the move is refused, never kept on the placeholder (got ${String(refused)})`);
    assert(calls.commitReschedule.length === 0 && ctx.booking.assigned_user_id === "p" && ctx.booking.kind === "staff_placed", "and the call is untouched");
  }
  // Control: a routed call whose advisor is free is still kept in place.
  {
    const ctx = { booking: makeBooking({ kind: "routed" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx, freeEmails: new Set(["a@x.com"]) });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(calls.updateEventTime.length === 1 && calls.createEvent.length === 0, "control: a routed call keeps its free advisor in place");
    const payload = calls.commitReschedule[0]?.outbox?.payload as { leftPlaceholder?: boolean } | undefined;
    assert(payload?.leftPlaceholder === undefined, "control: and records no left_placeholder");
    assert(calls.webhooks.find((w) => w.event === "booking.rescheduled")?.leftPlaceholder === undefined, "control: nor sends one");
  }

  // --- #4203: the direct API's person dedupe and Marcia's MCP channel reach the same rule ---
  for (const channel of ["api", "mcp"] as const) {
    const existingB = onPlaceholder({ id: "bk-existing", salesforce_id: "sf1" });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: "2026-06-09T14:00:00.000Z",
      confirmReschedule: false,
      ...(channel === "mcp" ? { mcpChannel: "marcia" as const } : {}),
    };
    const ctx = { booking: existingB, bucket, eventType };
    const { deps, calls } = makeDeps({ personBookings: [existingB], existing: ctx, bookingById: ctx, candidates: ["a"], freeEmails: new Set(["a@x.com", "marcia@x.com"]) });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "rescheduled", `${channel}: a strong match at a new time is rescheduled`);
    assert(calls.updateEventTime.length === 0 && calls.createEvent[0]?.email === "a@x.com", `${channel}: onto a real advisor, never kept on the placeholder`);
    assert(res.booking.kind === "routed", `${channel}: and the moved call is routed`);
    assert(!String(calls.createEvent[0]?.args.description).includes(placeholderReplyLine("invite")),
      `${channel}: and its new invite is a routed one, with no reply to our texts line`);
    assert(calls.webhooks.find((w) => w.event === "booking.rescheduled")?.leftPlaceholder === true, `${channel}: with left_placeholder on the event`);
  }

  // --- the coordinator's move ONTO the placeholder ----------------------------------------
  {
    const ctx = { booking: makeBooking({ kind: "routed" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx, candidates: [] });
    const res = await rescheduleBooking("tok1", START, RR, "admin", deps, NOW, { userId: "coord-1" }, undefined, { leadZone: "America/Chicago", ontoPlaceholder: placeholder });
    assert(calls.verifyFree.length === 0 && calls.roundRobinPreview.length === 0 && calls.busyIntervalsForAgent.length === 0, "the move onto the placeholder asks no advisor and no calendar");
    assert(calls.createEvent.length === 1 && calls.createEvent[0].email === "marcia@x.com", "a new invite goes on the placeholder's calendar");
    assert(String(calls.createEvent[0].args.description).endsWith(placeholderReplyLine("invite")),
      "written as the placeholder's invite, ending with the reply to our texts line (#4206)");
    const commit = calls.commitReschedule[0];
    assert(commit?.ontoPlaceholder === true && commit.patch.assigned_user_id === "p", "committed through the placeholder's own function, onto the placeholder");
    assert((commit?.outbox?.payload as { leftPlaceholder?: boolean }).leftPlaceholder === undefined, "it records no left_placeholder: the call went ONTO it");
    assert(ctx.booking.kind === "staff_placed" && ctx.booking.allow_double_book === true, "the stored call is staff placed and stacks");
    assert(res.booking.kind === "staff_placed" && res.booking.assigned_user_id === "p" && res.booking.id === "bk1", "the SAME booking moved, and the answer says it is on the placeholder");
    assert(calls.deleteEvent.some((d) => d.id === "gcal-old"), "the old advisor's invite is removed");
    assert(calls.webhooks.filter((w) => w.event === "booking.rescheduled").length === 1, "one booking.rescheduled");
    assert(calls.bookingEvents[0]?.initiator === "admin", "the history row names the move as staff");
  }
  // A placeholder call moved to another time on the placeholder patches its own invite.
  {
    const ctx = { booking: onPlaceholder(), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx, candidates: [] });
    await rescheduleBooking("tok1", START, RR, "admin", deps, NOW, { userId: "coord-1" }, undefined, { leadZone: "America/Chicago", ontoPlaceholder: placeholder });
    assert(calls.updateEventTime.length === 1 && calls.updateEventTime[0].id === "gcal-old" && calls.createEvent.length === 0, "the placeholder's own invite is moved in place");
    assert(calls.commitReschedule[0]?.ontoPlaceholder === true, "through the placeholder's function, which keeps it stacking");
    assert(ctx.booking.kind === "staff_placed", "and it stays staff placed");
  }

  // --- a manager's reassign off the placeholder, and none onto it ----------------------------
  {
    const ctx = { booking: onPlaceholder(), bucket, eventType };
    const owner = { id: "b", name: "Agent B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    const res = await reassignBooking("bk1", "b@x.com", { code: "coverage", detail: null }, deps, { initiator: "admin", allowNonBookable: true });
    assert(res.booking.assigned_user_id === "b" && res.booking.kind === "routed", "a reassign off the placeholder answers a routed call");
    assert(ctx.booking.kind === "routed", "and the stored call is routed");
    const notified = calls.webhooks.find((w) => w.event === "booking.reassigned");
    assert(notified?.leftPlaceholder === true, "booking.reassigned carries left_placeholder");
  }
  {
    const ctx = { booking: makeBooking({ kind: "routed" }), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: placeholder });
    let refused: unknown = null;
    try {
      await reassignBooking("bk1", "marcia@x.com", SYS, deps, { initiator: "admin", allowNonBookable: true });
    } catch (err) {
      refused = err;
    }
    assert(refused instanceof AgentNotAvailableError, `a reassign onto the placeholder is refused, even with a manager's override (got ${String(refused)})`);
    assert(calls.createEvent.length === 0 && calls.reassignSwaps.length === 0, "and nothing is created or swapped");
  }
  // The owner automation refuses a staff placed call; a routed one still moves.
  {
    const ctx = { booking: onPlaceholder(), bucket, eventType };
    const owner = { id: "b", name: "Agent B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    let refused: unknown = null;
    try {
      await reassignBooking("bk1", "b@x.com", SYS, deps, { refuseStaffPlaced: true });
    } catch (err) {
      refused = err;
    }
    assert(refused instanceof StaffPlacedReassignRefusedError, `the owner automation refuses a staff placed call (got ${String(refused)})`);
    assert(calls.createEvent.length === 0 && calls.reassignSwaps.length === 0 && ctx.booking.assigned_user_id === "p", "and the call stays on the placeholder");
    const routedCtx = { booking: makeBooking({ kind: "routed" }), bucket, eventType };
    const control = makeDeps({ bookingById: routedCtx, agentByEmail: owner });
    const moved = await reassignBooking("bk1", "b@x.com", SYS, control.deps, { refuseStaffPlaced: true });
    assert(moved.booking.assigned_user_id === "b", "control: the owner automation still moves a routed call");
  }
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});
