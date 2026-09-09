/**
 * Reading the "see our next available days" reply (#2155).
 *
 * The booker used to read a 200 as `{ slots?: string[] }` and do
 * `setNextDaySlots(res.data.slots ?? [])`, so a reply whose slots were missing,
 * null or not strings rendered as "we looked and there are no times". That is the
 * worst direction for this read in particular: it is the LAST thing offered to a
 * lead who has already found nothing nearby, so a confident nothing ends the
 * visit, and nothing logs or alerts because the code path that ran is the healthy
 * one. Its causes are ordinary ones: a half deployed API change, a proxy error
 * page answered 200, a payload rename, a page older than the server it is talking
 * to.
 *
 * The two failures are kept APART. They send a lead to do different things, and a
 * message answering for the other is how somebody is told to check a connection
 * that was never the problem (L11).
 */

/** Why the search could not produce an answer. Not an empty answer: an empty
 *  result is a real, healthy outcome with a sentence of its own. */
export const NEXT_DAYS_FAILURE = {
  /** The request never landed: offline, a timeout, an abort, a 5xx. Trying again
   *  is the right advice, and it might just work. */
  unreachable: "unreachable",
  /** It landed, answered 200, and carried something this page cannot read. Trying
   *  again will get the same reply, so the advice has to be different: the
   *  commonest cause is a page older than the server, which a reload fixes. */
  unreadable: "unreadable",
} as const;

export type NextDaysFailure =
  (typeof NEXT_DAYS_FAILURE)[keyof typeof NEXT_DAYS_FAILURE];

export type NextDaysReply = { slots: string[] };

/**
 * Whether a 200 is one this page can act on.
 *
 * Every slot has to be a string, not merely the list being an array: a list
 * carrying nulls or objects passes an `Array.isArray` check and then renders as
 * that many broken rows, which is the same defect wearing a different shape.
 */
export function isNextDaysReply(value: unknown): value is NextDaysReply {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const slots = (value as Record<string, unknown>).slots;
  return Array.isArray(slots) && slots.every((s) => typeof s === "string");
}

/**
 * The failure a reply amounts to, or null when there is none.
 *
 * Written as one function over the whole reply rather than as two checks at the
 * call site, so the two failures cannot be told apart in one place and conflated
 * in another.
 */
export function nextDaysFailureFor(
  res: { ok: false } | { ok: true; data: unknown },
): NextDaysFailure | null {
  if (!res.ok) return NEXT_DAYS_FAILURE.unreachable;
  return isNextDaysReply(res.data) ? null : NEXT_DAYS_FAILURE.unreadable;
}
