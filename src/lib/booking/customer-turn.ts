/**
 * One coordinator at a time per customer (#4261).
 *
 * `placeBooking` reads the customer's existing calls and then creates one, so two
 * coordinators booking the same Salesforce Lead at the same moment, under different
 * submission ids, could each read "no call" before either had made one, and the
 * customer would hold two calls. The submission id cannot help (each page mints its
 * own), and the confirm line serialises one bucket and instant, not one person.
 *
 * So the whole placement, from the replay check through the create or the move, runs
 * holding a claim on the customer in `sync_locks` (`claimSyncLock`), the table every
 * cross request lock in Slate already uses. A second placement for the same customer
 * waits for the first to finish and then runs its own reads, so it finds the call
 * the first just made and is answered with it, exactly as if it had come a minute
 * later. A double submit of one press finds its own booking under its key the same
 * way, and is answered as the replay it is.
 *
 * WHY A LOCK AND NOT A DATABASE RULE. A unique rule on the bookings row would refuse
 * the second call only at its commit, after verify on book and after the calendar
 * event (and the customer's invite) had been written, so the customer would get an
 * invite and its cancellation, and the refusal would arrive inside the create as a
 * lost race the real advisor path walks on from. Deciding before anything is read is
 * the first step that can answer (L667).
 *
 * WHAT IT DOES NOT COVER. The lead's own booker and the direct booking API keep the
 * one call per person check they have (#1337, #1641), with the confirmation screen's
 * duplicate warning as their backstop; this serialises coordinator placements against
 * each other, which is the race the coordinator page opened.
 *
 * Every outcome of the claim is its own answer (L11): claimed, still held by another
 * placement when the wait runs out (`customer-busy`), or the claim could not be made
 * at all (`customer-lock-unavailable`). The release is in a `finally` and never
 * replaces the outcome; a release that could not run is freed by the TTL.
 *
 * Pure apart from the injected deps (relative imports), so `scripts/test-placed-booking.ts`
 * races two placements through it.
 */
import { leadIdKey } from "../salesforce/lead-xbc.ts";
import { log } from "@/lib/log";

/**
 * How long a claim stands if its holder dies without releasing it. Several times the
 * longest a placement can run: a booking request's worst case is 14 seconds
 * (`BOOKING_CONFIRM_WORST_CASE_MS`), and a confirmed move that falls to the placeholder
 * runs two reschedules. A placement only loses its claim to another by outliving that.
 */
export const CUSTOMER_TURN_TTL_MS = 60_000;

/**
 * How long a second placement waits for the first. Long enough for an ordinary
 * placement to finish, short enough that the coordinator is told, inside the booking
 * request, that somebody else is booking this customer rather than left waiting.
 */
export const CUSTOMER_TURN_WAIT_MS = 10_000;

/** How often a waiting placement asks again. */
export const CUSTOMER_TURN_POLL_MS = 250;

/** The `sync_locks` key for one customer: the 15 character Lead id, so both spellings are one key. */
export function customerTurnKey(salesforceLeadId: string): string {
  return `coordinator_customer:${leadIdKey(salesforceLeadId.trim())}`;
}

/** What one claim did (`claimSyncLock` in `src/lib/locks.ts`). */
export type CustomerClaim = { kind: "claimed"; token: string } | { kind: "held" } | { kind: "refused" };

export interface CustomerTurnDeps {
  claim(key: string): Promise<CustomerClaim>;
  release(key: string, token: string): Promise<"released" | "not-held" | "refused">;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Why a placement could not take its turn. Each is its own refusal. */
export type CustomerTurnRefusal = "customer-busy" | "customer-lock-unavailable";

export class CustomerTurnRefusedError extends Error {
  readonly reason: CustomerTurnRefusal;
  constructor(reason: CustomerTurnRefusal) {
    super(reason === "customer-busy" ? "another placement for this customer is still running" : "the customer's claim could not be made");
    this.name = "CustomerTurnRefusedError";
    this.reason = reason;
  }
}

/**
 * Run `work` holding the customer's claim, waiting up to `CUSTOMER_TURN_WAIT_MS` for a
 * placement already holding it. THROWS `CustomerTurnRefusedError` when the turn cannot
 * be had, before `work` has read or written anything.
 */
export async function inCustomerTurn<T>(key: string, deps: CustomerTurnDeps, work: () => Promise<T>): Promise<T> {
  const deadline = deps.now() + CUSTOMER_TURN_WAIT_MS;
  let token: string | null = null;
  for (;;) {
    // A claim that throws (the fetch failing) is a claim that could not be made.
    const claim: CustomerClaim = await deps.claim(key).catch((err: unknown) => {
      log.warn("placed-booking", { msg: "the customer's claim threw", key }, err);
      return { kind: "refused" } as const;
    });
    if (claim.kind === "claimed") {
      token = claim.token;
      break;
    }
    if (claim.kind === "refused") {
      log.warn("placed-booking", { msg: "the customer's claim could not be made, so nothing was placed", key });
      throw new CustomerTurnRefusedError("customer-lock-unavailable");
    }
    if (deps.now() >= deadline) {
      log.warn("placed-booking", { msg: "another placement for this customer was still running when the wait ran out", key });
      throw new CustomerTurnRefusedError("customer-busy");
    }
    await deps.sleep(CUSTOMER_TURN_POLL_MS);
  }
  try {
    return await work();
  } finally {
    const released = await deps.release(key, token).catch(() => "refused" as const);
    if (released !== "released") {
      // Freed by the TTL either way; said, because a claim left standing makes the next
      // placement for this customer wait for nothing.
      log.warn("placed-booking", { msg: "the customer's claim was not released", key, released });
    }
  }
}
