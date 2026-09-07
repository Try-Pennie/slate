/**
 * Where a lead goes when their routing code is blank or unreadable (#1908).
 *
 * Pure: no database, no clock, no network, so `scripts/test-routing-catchall.ts`
 * drives every branch offline.
 *
 * WHAT WAS WRONG. Slate refused any `xbc` outside the sixty valid codes, and
 * `/book` with no `xbc` rendered "This booking link is missing its
 * configuration". The recorded assumption was that such leads never receive a
 * booking link. Measured 2026-09-04 across 6,000 cal.com routing form responses:
 * 105 carried a code Slate cannot route and 55 of them booked, the bulk being a
 * completely BLANK code from the portal and offerhub form (73 of 2,000 there, 44
 * booked, a 60 percent booking rate). cal.com catches every one with an explicit
 * catch-all route to the Low pool, so that rule is carrying roughly 2 percent of
 * all bookings and Slate's refusal would turn it into a dead end at cutover.
 *
 * THE TRADE, STATED. Sending an unreadable code to Low is a guess. A lead who is
 * genuinely Ultra High and whose code arrived mangled is booked with the Low team,
 * and nothing about the booking looks wrong. cal.com already makes that trade;
 * what Slate adds is that the guess is RECORDED, so the rate is countable and the
 * upstream cause can be chased rather than absorbed silently.
 */
import { bucketSpecForXbc } from "@/lib/xbc";

/**
 * The pool an unroutable lead lands in: Low, with no backend and no legal
 * constraint, because a lead who told us nothing cannot be narrowed on anything.
 * It mirrors cal.com's own catch-all, which routes to the Low pool.
 *
 * `scripts/test-routing-catchall.ts` asserts this is a routable code that the
 * bucket seeder owns, so it exists in every environment rather than depending on
 * somebody having created it by hand.
 */
export const CATCHALL_CODE = "100";

/** Why a lead had to be rescued. Same destination, different upstream cause, and
 *  they are kept apart because they send different people to different places:
 *  `absent` is the portal page forwarding no parameter at all when Salesforce
 *  holds no value, `unreadable` is a code that was mangled on the way (L11). */
export type CatchallReason = "absent" | "unreadable";

export type CodeResolution =
  /** The lead carried a code Slate routes. */
  | { kind: "valid"; code: string }
  /** The lead carried nothing usable and was sent to the Low pool. */
  | {
      kind: "catchall";
      code: typeof CATCHALL_CODE;
      reason: CatchallReason;
      /** Exactly what arrived, unnormalised. It is the only evidence of what the
       *  upstream page actually sent, and trimming or defaulting it would erase
       *  the difference between a blank field and a mangled one at the moment
       *  somebody is trying to find the cause. */
      requested: string;
    };

/**
 * The code to route on, and whether the catch-all had to be used.
 *
 * Called from BOTH the page (so the lead sees a working booker) and the booking
 * service (which is authoritative, and never trusts a resolved code supplied by
 * the client). Two call sites of one function rather than two implementations:
 * a second copy would let the times a lead is shown and the pool they are booked
 * into disagree.
 */
export function resolveRequestedCode(raw: string | null | undefined): CodeResolution {
  const requested = raw ?? "";
  const trimmed = requested.trim();
  if (trimmed === "") {
    return { kind: "catchall", code: CATCHALL_CODE, reason: "absent", requested };
  }
  // Judged by whether the code actually resolves to a bucket spec, not by a second
  // copy of the code shape. The shape lives in `bucketSpecForXbc`, and a regex
  // repeated here would be a second definition of what a valid code is, drifting
  // the first time the matrix changes (L41).
  if (bucketSpecForXbc(trimmed) === null) {
    return { kind: "catchall", code: CATCHALL_CODE, reason: "unreadable", requested };
  }
  return { kind: "valid", code: trimmed };
}

/** Whether a resolution used the catch-all, for the callers that only need the
 *  boolean. Kept here so no call site re-derives it by comparing to the code,
 *  which would wrongly count a lead who genuinely asked for the Low pool. */
export function isCatchall(r: CodeResolution): r is Extract<CodeResolution, { kind: "catchall" }> {
  return r.kind === "catchall";
}

/**
 * What to record about one booking's routing code.
 *
 * `catchallApplied` is only true when the rescue ACTUALLY happened, which means
 * the resolution has to agree with the bucket the booking really landed in. The
 * raw value reaches the server from the client, so without that check a caller
 * sending an unreadable code alongside an unrelated bucket would have its booking
 * recorded as a catch-all that never occurred, and the rate the alert watches is
 * exactly the number that would be wrong.
 *
 * `undefined` means the caller did not say, which is not the same as a lead who
 * arrived with no code: the first is an older embed that predates this field, the
 * second is the defect being measured. Only the second is a catch-all.
 */
export function catchallRecord(
  requested: string | undefined,
  bookedCode: string,
): { requestedCode: string | null; catchallApplied: boolean } {
  if (requested === undefined) return { requestedCode: null, catchallApplied: false };
  const resolved = resolveRequestedCode(requested);
  return {
    requestedCode: requested,
    catchallApplied: resolved.kind === "catchall" && resolved.code === bookedCode,
  };
}
