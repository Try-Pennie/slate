// #2370: the MACHINE contact-owner reassign refuses, and says so durably, when the
// owner Slate is asked to move a call to cannot take it.
//
// Three refusals (the owner is not in Slate, is not bookable, or has approved time
// off covering the call), each recorded as an `owner-reassign-refused` handoff so
// somebody on the sales side decides what happens next. Before this the same three
// situations were one silent 404, and a read that FAILED was that 404 too, which is
// the same defect wearing two faces: a refusal nobody hears, and an outage that
// reads as a refusal.
//
// Everything here is driven through hand written fakes, and every outcome the
// decision can reach is produced by a case rather than merely passed over (L151).
// Both directions wherever there are two: a check that can only answer one way is
// satisfied by a function hard wired to that answer (L1).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-owner-reassign-guard.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { OWNER_REFUSALS, type OwnerRefusal } from "@/lib/handoffs/kinds";
import type { HandoffWriter, NewHandoffRow } from "@/lib/handoffs/record";
import {
  OWNER_GUARD_STAGES,
  OWNER_REFUSAL_CODE,
  OWNER_REFUSAL_MESSAGE,
  OWNER_REFUSAL_STATUS,
  OwnerReassignRefusedError,
  OwnerReassignUnavailableError,
  decideOwnerReassign,
  reassignForContactOwner,
  type OwnerCandidate,
  type OwnerReassignBooking,
  type OwnerReassignGuardDeps,
} from "@/lib/booking/owner-reassign-guard";

const STARTS = "2026-09-20T15:00:00.000Z";
const ENDS = "2026-09-20T15:30:00.000Z";

const booking = (over: Partial<OwnerReassignBooking> = {}): OwnerReassignBooking => ({
  id: "bk-1",
  status: "confirmed",
  startsAt: STARTS,
  endsAt: ENDS,
  assignedUserId: "agent-a",
  ...over,
});

const owner = (over: Partial<OwnerCandidate> = {}): OwnerCandidate => ({
  id: "owner-1",
  email: "owner@trypennie.com",
  bookable: true,
  deactivatedAt: null,
  ...over,
});

/** A writer with the constraint the database has: one OPEN row per (booking, kind). */
function fakeWriter() {
  const rows: NewHandoffRow[] = [];
  let failWith: Error | null = null;
  const writer: HandoffWriter = {
    async insertOnce(row) {
      if (failWith) throw failWith;
      if (rows.some((r) => r.booking_id === row.booking_id && r.kind === row.kind)) {
        return { inserted: false };
      }
      rows.push(row);
      return { inserted: true };
    },
  };
  return {
    writer,
    rows,
    failWrites(err: Error) {
      failWith = err;
    },
  };
}

interface Calls {
  loadBooking: string[];
  findOwner: string[];
  timeOff: { userId: string; startsAt: string; endsAt: string }[];
}

function makeDeps(
  over: {
    booking?: OwnerReassignBooking | null;
    owner?: OwnerCandidate | null;
    onTimeOff?: boolean;
    loadBookingThrows?: Error;
    findOwnerThrows?: Error;
    timeOffThrows?: Error;
    writer?: HandoffWriter;
  } = {},
) {
  const calls: Calls = { loadBooking: [], findOwner: [], timeOff: [] };
  const deps: OwnerReassignGuardDeps = {
    async loadBooking(id) {
      calls.loadBooking.push(id);
      if (over.loadBookingThrows) throw over.loadBookingThrows;
      return over.booking === undefined ? booking() : over.booking;
    },
    async findOwner(email) {
      calls.findOwner.push(email);
      if (over.findOwnerThrows) throw over.findOwnerThrows;
      return over.owner === undefined ? owner() : over.owner;
    },
    async hasApprovedTimeOff(userId, startsAt, endsAt) {
      calls.timeOff.push({ userId, startsAt, endsAt });
      if (over.timeOffThrows) throw over.timeOffThrows;
      return over.onTimeOff ?? false;
    },
    handoffWriter: over.writer ?? fakeWriter().writer,
  };
  return { deps, calls };
}

const INPUT = { bookingId: "bk-1", ownerEmail: "owner@trypennie.com" };

async function run() {
  // --- the move happens, and records nothing -----------------------------------
  {
    const w = fakeWriter();
    const { deps, calls } = makeDeps({ writer: w.writer });
    const decision = await decideOwnerReassign(INPUT, deps);
    eq(decision.decision, "proceed", "a bookable owner who is not away: the call moves");
    eq(
      decision.decision === "proceed" ? decision.reason : "",
      "owner-can-take-it",
      "and the reason names what was measured",
    );
    eq(w.rows.length, 0, "a successful move records no handoff: nobody is waiting on a person");
    eq(
      calls.timeOff[0],
      { userId: "owner-1", startsAt: STARTS, endsAt: ENDS },
      "time off is asked about the booking's OWN window, so leave elsewhere in the day cannot refuse it",
    );
  }

  // `reassignForContactOwner` is the composition the machine path uses: the guard
  // runs FIRST and the move runs only on proceed. Tested here rather than left in
  // the service wrapper, because "did it move" is the whole question (L3).
  {
    const w = fakeWriter();
    const { deps } = makeDeps({ writer: w.writer });
    let moved = 0;
    const result = await reassignForContactOwner(INPUT, deps, async () => {
      moved++;
      return "moved";
    });
    eq(result, "moved", "the move's own result is returned untouched");
    eq(moved, 1, "the move runs exactly once when the owner may take the call");
  }

  // --- each refusal, in both the recorded and already-recorded states -----------
  const refusalCases: {
    refusal: OwnerRefusal;
    over: Parameters<typeof makeDeps>[0];
    expectOwnerId: string | null;
    why: string;
  }[] = [
    {
      refusal: "owner-not-found",
      over: { owner: null },
      expectOwnerId: null,
      why: "Slate holds no user for the owner the caller named",
    },
    {
      refusal: "owner-not-bookable",
      over: { owner: owner({ bookable: false }) },
      expectOwnerId: "owner-1",
      why: "the owner is out of the bookable pool",
    },
    {
      refusal: "owner-on-time-off",
      over: { onTimeOff: true },
      expectOwnerId: "owner-1",
      why: "the owner has approved time off covering the call",
    },
  ];

  for (const c of refusalCases) {
    const w = fakeWriter();
    const { deps, calls } = makeDeps({ ...c.over, writer: w.writer });
    const first = await decideOwnerReassign(INPUT, deps);
    eq(first.decision, "refused", `${c.refusal}: refused, because ${c.why}`);
    eq(
      first.decision === "refused" ? first.refusal : "",
      c.refusal,
      `${c.refusal}: the refusal names which of the three it is`,
    );
    eq(
      first.decision === "refused" ? first.handoff : "",
      "recorded",
      `${c.refusal}: the first refusal records the handoff`,
    );
    eq(w.rows.length, 1, `${c.refusal}: exactly one row`);
    eq(w.rows[0].kind, "owner-reassign-refused", `${c.refusal}: recorded under the owner kind`);
    eq(w.rows[0].booking_id, "bk-1", `${c.refusal}: against the booking that did not move`);
    eq(
      w.rows[0].detail,
      {
        refusal: c.refusal,
        requestedOwnerUserId: c.expectOwnerId,
        requestedOwnerEmail: "owner@trypennie.com",
      } as unknown as Record<string, unknown>,
      `${c.refusal}: the detail carries the reason, the owner's id when Slate has one, and the email`,
    );

    // A retried caller (Regal re-posts the same refusal) must never open a second row.
    const second = await decideOwnerReassign(INPUT, deps);
    eq(
      second.decision === "refused" ? second.handoff : "",
      "already-recorded",
      `${c.refusal}: a retry is told the handoff was already open`,
    );
    eq(w.rows.length, 1, `${c.refusal}: a retry never opens a second row`);
    eq(second.decision, "refused", `${c.refusal}: and it is still a refusal, not a silent pass`);
    assert(calls.loadBooking.length === 2, `${c.refusal}: both attempts really ran the check`);
  }

  // A refusal must leave the booking exactly where it is.
  for (const c of refusalCases) {
    const w = fakeWriter();
    const { deps } = makeDeps({ ...c.over, writer: w.writer });
    let moved = 0;
    let caught: unknown = null;
    try {
      await reassignForContactOwner(INPUT, deps, async () => {
        moved++;
        return "moved";
      });
    } catch (err) {
      caught = err;
    }
    eq(moved, 0, `${c.refusal}: the booking is not moved`);
    assert(
      caught instanceof OwnerReassignRefusedError,
      `${c.refusal}: the caller gets a refusal it can map, not a generic fault`,
    );
    const refused = caught as OwnerReassignRefusedError;
    eq(refused.refusal, c.refusal, `${c.refusal}: the thrown refusal names the reason`);
    eq(refused.handoff, "recorded", `${c.refusal}: and whether the handoff was recorded now`);
  }

  // --- two owners who are not bookable for different reasons --------------------
  {
    const w = fakeWriter();
    const { deps } = makeDeps({ owner: owner({ deactivatedAt: "2026-09-01T00:00:00Z" }), writer: w.writer });
    const d = await decideOwnerReassign(INPUT, deps);
    eq(
      d.decision === "refused" ? d.refusal : "",
      "owner-not-bookable",
      "a deactivated owner is refused: a person who has left is never routable, whatever the bookable flag says",
    );
  }
  {
    const w = fakeWriter();
    const { deps } = makeDeps({ owner: owner({ email: null }), writer: w.writer });
    const d = await decideOwnerReassign(INPUT, deps);
    eq(
      d.decision === "refused" ? d.refusal : "",
      "owner-not-bookable",
      "an owner row with no address is refused: nothing can be put on a calendar Slate cannot name",
    );
    eq(
      (w.rows[0].detail as { requestedOwnerEmail: string }).requestedOwnerEmail,
      "owner@trypennie.com",
      "and the handoff names the address the CALLER used, which is the only one anybody can look up",
    );
  }

  // --- the three proceeds that record nothing ----------------------------------
  {
    const w = fakeWriter();
    const { deps, calls } = makeDeps({ booking: booking({ assignedUserId: "owner-1" }), writer: w.writer });
    const d = await decideOwnerReassign(INPUT, deps);
    eq(d.decision, "proceed", "the owner already holds the call: still a proceed, so the no-op stays a 200");
    eq(
      d.decision === "proceed" ? d.reason : "",
      "owner-already-assigned",
      "and the reason says the owner already has it",
    );
    eq(w.rows.length, 0, "the no-op records nothing: nobody is waiting on anybody");
    eq(
      calls.timeOff.length,
      0,
      "and time off is never read for it, so an owner away today cannot turn their OWN call into a refusal",
    );
  }
  {
    const w = fakeWriter();
    const { deps, calls } = makeDeps({ booking: null, writer: w.writer });
    const d = await decideOwnerReassign(INPUT, deps);
    eq(d.decision, "proceed", "an unknown booking proceeds, so the existing 404 keeps ONE owner (L11)");
    eq(d.decision === "proceed" ? d.reason : "", "booking-unknown", "and says why it did not judge");
    eq(calls.findOwner.length, 0, "the owner is never looked up for a booking that does not exist");
    eq(w.rows.length, 0, "and nothing is recorded against a booking id no row can reference");
  }
  for (const status of ["cancelled", "completed"]) {
    const w = fakeWriter();
    const { deps } = makeDeps({ booking: booking({ status }), writer: w.writer });
    const d = await decideOwnerReassign(INPUT, deps);
    eq(d.decision, "proceed", `a ${status} booking proceeds, so it stays the existing 409, not a refusal`);
    eq(d.decision === "proceed" ? d.reason : "", "booking-not-active", `and names the ${status} state`);
    eq(w.rows.length, 0, `nothing is recorded about a ${status} booking nobody can move anyway`);
  }

  // --- a failed READ is not a refusal ------------------------------------------
  // The whole point: an empty or null answer from a read that FAILED is
  // indistinguishable from "no such owner" and from "nobody is away" (#277, #1152).
  const readFailures: { stage: string; over: Parameters<typeof makeDeps>[0] }[] = [
    { stage: "booking", over: { loadBookingThrows: new Error("bookings read failed") } },
    { stage: "owner", over: { findOwnerThrows: new Error("users read failed") } },
    { stage: "time-off", over: { timeOffThrows: new Error("ooo_requests read failed") } },
  ];
  for (const f of readFailures) {
    const w = fakeWriter();
    const { deps } = makeDeps({ ...f.over, writer: w.writer });
    let moved = 0;
    let caught: unknown = null;
    try {
      await reassignForContactOwner(INPUT, deps, async () => {
        moved++;
        return "moved";
      });
    } catch (err) {
      caught = err;
    }
    assert(
      caught instanceof OwnerReassignUnavailableError,
      `a failed ${f.stage} read is an unavailability, never a refusal`,
    );
    eq((caught as OwnerReassignUnavailableError).stage, f.stage, `and it names the ${f.stage} read`);
    eq(moved, 0, `a failed ${f.stage} read does not move the booking`);
    eq(w.rows.length, 0, `a failed ${f.stage} read records no handoff: nothing was measured`);
    assert(
      (caught as Error).cause instanceof Error,
      `the ${f.stage} failure keeps its cause, so the log says what actually broke`,
    );
  }

  // --- a failed handoff WRITE is not swallowed ---------------------------------
  {
    const w = fakeWriter();
    w.failWrites(new Error("booking handoff write failed: connection terminated"));
    const { deps } = makeDeps({ owner: null, writer: w.writer });
    let moved = 0;
    let caught: unknown = null;
    try {
      await reassignForContactOwner(INPUT, deps, async () => {
        moved++;
        return "moved";
      });
    } catch (err) {
      caught = err;
    }
    assert(
      caught instanceof OwnerReassignUnavailableError,
      "a failed handoff write is retriable, not a refusal the caller is told was handed over",
    );
    eq((caught as OwnerReassignUnavailableError).stage, "handoff", "and it names the write, not a read");
    eq(moved, 0, "and the booking still does not move");
  }

  // --- the HTTP vocabulary is complete, and no two refusals share a code --------
  {
    const codes = OWNER_REFUSALS.map((r) => OWNER_REFUSAL_CODE[r]);
    eq(new Set(codes).size, OWNER_REFUSALS.length, "every refusal has its own machine code");
    eq(
      codes.slice().sort(),
      ["OWNER_NOT_BOOKABLE", "OWNER_NOT_FOUND", "OWNER_ON_TIME_OFF"],
      "the codes are the documented ones, so docs/api.md and the route cannot drift",
    );
    for (const r of OWNER_REFUSALS) {
      assert(
        typeof OWNER_REFUSAL_MESSAGE[r] === "string" && OWNER_REFUSAL_MESSAGE[r].trim().length > 0,
        `${r}: has a sentence a person can read`,
      );
      assert(
        !/[\u2014\u2013]/.test(OWNER_REFUSAL_MESSAGE[r]),
        `${r}: its message carries no dash punctuation`,
      );
      assert(
        OWNER_REFUSAL_STATUS[r] === 404 || OWNER_REFUSAL_STATUS[r] === 409,
        `${r}: answers a status the reassign contract already defines`,
      );
    }
    eq(
      OWNER_REFUSAL_STATUS["owner-not-found"],
      404,
      "an owner Slate has never heard of is bad input, which is what 404 means here",
    );
    eq(
      OWNER_REFUSAL_STATUS["owner-not-bookable"],
      409,
      "an owner who exists and may not take it is a conflict, not bad input",
    );
    eq(OWNER_REFUSAL_STATUS["owner-on-time-off"], 409, "so is an owner who is away");
    eq(
      new Set(OWNER_REFUSAL_MESSAGE ? OWNER_REFUSALS.map((r) => OWNER_REFUSAL_MESSAGE[r]) : []).size,
      OWNER_REFUSALS.length,
      "no two refusals say the same sentence, so the reader is never sent to look for the wrong thing (L11)",
    );
  }
  {
    const messages = OWNER_GUARD_STAGES.map((s) => new OwnerReassignUnavailableError(s, new Error("x")).message);
    eq(
      new Set(messages).size,
      OWNER_GUARD_STAGES.length,
      "each stage that can fail says so in its own words (L11)",
    );
  }

  // --- admin, bulk and coverage reassigns cannot reach any of this --------------
  // They all go through orchestration.reassignBooking, so the proof is that the
  // shared engine cannot see the guard at all: a scan, because a behaviour every
  // call site has to opt out of is the wrong shape (L621).
  {
    const src = (rel: string) => readFileSync(join(import.meta.dirname, "..", "src", rel), "utf8");
    const orchestration = src("lib/booking/orchestration.ts");
    assert(
      !/owner-reassign-guard/.test(orchestration),
      "orchestration (the engine admin, bulk and coverage all use) does not import the owner guard",
    );
    assert(
      !/approved-overlap|userIdsOnApprovedTimeOff/.test(orchestration),
      "and it reads no approved time off, so no admin or bulk move can be refused for it",
    );
    const service = src("lib/booking/service.ts");
    const uses = service.match(/reassignForContactOwner\(/g) ?? [];
    eq(uses.length, 1, "exactly one call site composes the guard with the move");
    assert(
      /export function reassignBooking\([\s\S]{0,600}?reassignForContactOwner\(/.test(service),
      "and it is the machine contact-owner wrapper, not the admin or system one",
    );
    for (const fn of ["adminReassignBooking", "systemReassignBooking"]) {
      const body = new RegExp(`export function ${fn}\\(([\\s\\S]*?)\\n}`).exec(service)?.[1] ?? "";
      assert(body.length > 0, `${fn} was found in service.ts`);
      assert(
        !/reassignForContactOwner|assertOwnerMayTakeBooking/.test(body),
        `${fn} still moves a booking without the owner guard`,
      );
    }
  }
}

await run();
finish();
