import { DUPLICATE_FINDINGS, type DuplicateFinding, type DuplicateUnresolvedDetail } from "@/lib/handoffs/kinds";

/**
 * What Slate answers when Regal asks it to cancel a lead's earlier call as a
 * duplicate (#2369, #2307 phase 3), and how each answer reaches the caller.
 *
 * The DECISION is not here. It is one database call, `cancel_duplicate_booking`
 * (migration 0124), because checking whether a call is really a duplicate and
 * cancelling it have to be one transaction: two steps could leave a lead with no call
 * at all, and the loaders this route would otherwise reach swallow a read error to
 * null, which on this path reads as "this lead has no other call" and stops Regal
 * retrying a real duplicate (L215, #1641). This module holds the vocabulary, the HTTP
 * contract and the reading of the function's reply, all pure, so every outcome is
 * driven by a test rather than by a database nobody has.
 *
 * Two rules hold the contract together:
 *
 *  - **A refusal and a failure are different answers.** Every refusal is a 409 naming
 *    what Slate measured. A call that could not be MADE, a reply that could not be
 *    READ, and a refusal that could not be RECORDED are each a 503 naming the stage,
 *    so the caller retries rather than reading an outage as a decision (L11).
 *  - **A retry after success is success.** The function reports `already-cancelled`
 *    when the named booking is already cancelled AS a duplicate, and that is a 200:
 *    a journey that retried after a reply it never saw has got what it asked for.
 */

/** Every answer the database function can give. */
export const DUPLICATE_OUTCOMES = [
  "cancelled",
  "already-cancelled",
  "not-found",
  "not-active",
  "started",
  "identity-conflict",
  "named-is-newest",
  "no-other-call",
] as const;
export type DuplicateOutcome = (typeof DUPLICATE_OUTCOMES)[number];

export function isDuplicateOutcome(value: unknown): value is DuplicateOutcome {
  return typeof value === "string" && (DUPLICATE_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The status each outcome answers with.
 *
 * **Every refusal is a 409, including a booking Slate cannot find, and that is
 * deliberate.** A 404 from an endpoint addressed by id is indistinguishable from a
 * 404 for the URL itself, and the caller here is a journey, not a person reading a
 * response. So the status says "your request was understood and Slate declined it"
 * and the `code` says which decline it was.
 */
export const DUPLICATE_CANCEL_STATUS: Record<DuplicateOutcome, number> = {
  cancelled: 200,
  "already-cancelled": 200,
  "not-found": 409,
  "not-active": 409,
  started: 409,
  "identity-conflict": 409,
  "named-is-newest": 409,
  "no-other-call": 409,
};

/** The machine readable code beside each outcome. */
export const DUPLICATE_CANCEL_CODE: Record<DuplicateOutcome, string> = {
  cancelled: "CANCELLED",
  "already-cancelled": "ALREADY_CANCELLED",
  "not-found": "BOOKING_NOT_FOUND",
  "not-active": "BOOKING_NOT_ACTIVE",
  started: "BOOKING_STARTED",
  "identity-conflict": "IDENTITY_CONFLICT",
  "named-is-newest": "NAMED_IS_NEWEST",
  "no-other-call": "NO_OTHER_CALL",
};

/** What the caller is told, in words that say what was measured and nothing more. */
export const DUPLICATE_CANCEL_MESSAGE: Record<DuplicateOutcome, string> = {
  cancelled: "The earlier call was cancelled as a duplicate.",
  "already-cancelled": "That call was already cancelled as a duplicate.",
  "not-found": "Slate has no booking with that id, so nothing was cancelled.",
  "not-active": "That booking is not active, so nothing was cancelled.",
  started: "That call has already started, so it was not cancelled.",
  "identity-conflict":
    "Slate holds another upcoming call with the same email and phone under a different Salesforce id, so it did not cancel this one.",
  "named-is-newest":
    "Every other upcoming call Slate holds for this lead was booked before this one, so it did not cancel it.",
  "no-other-call": "Slate holds no other upcoming call for this lead, so it did not cancel this one.",
};

/**
 * Which outcomes leave somebody waiting on a person, and what the handoff records.
 *
 * Keyed as a total map over the outcomes so `tsc` names the omission when the
 * vocabulary grows: a new refusal with no entry cannot quietly record nothing
 * (L113). The three that DO record are exactly `DUPLICATE_FINDINGS`, and the check
 * below holds the two lists against each other rather than trusting them to agree.
 */
const FINDING_BY_OUTCOME: Record<DuplicateOutcome, DuplicateFinding | null> = {
  cancelled: null,
  "already-cancelled": null,
  // Slate looked the booking up and there was nothing to look at: a wrong id in a
  // journey, not a lead waiting on anybody.
  "not-found": null,
  "not-active": null,
  started: null,
  "identity-conflict": "identity-conflict",
  "named-is-newest": "named-is-newest",
  "no-other-call": "no-other-call",
};

export function duplicateFindingFor(outcome: DuplicateOutcome): DuplicateFinding | null {
  return FINDING_BY_OUTCOME[outcome];
}

/** Every finding is produced by an outcome, and every outcome maps into the union. */
export const DUPLICATE_OUTCOMES_WITH_FINDING = DUPLICATE_OUTCOMES.filter(
  (o) => FINDING_BY_OUTCOME[o] !== null,
);

export type WeakerMatch = "phone-only" | "email-only" | null;

/** The function's reply, once read. */
export interface DuplicateCancelResult {
  outcome: DuplicateOutcome;
  /** The `booking_outbox` row the function wrote in the same transaction, on a
   *  cancel. Null on every other outcome: nothing was enqueued. */
  outboxId: string | null;
  /** The bookings it judged to be the same person, so a log can say what it saw. */
  candidateIds: string[];
  weakerMatch: WeakerMatch;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Read the function's jsonb reply, or null for a shape this cannot read.
 *
 * Null is never treated as an outcome: the caller answers 503, because a reply it
 * cannot read is a reply it learned nothing from, and guessing at one would be the
 * defensive normalisation that destroys the evidence (L340).
 */
export function parseDuplicateCancelResult(raw: unknown): DuplicateCancelResult | null {
  if (!isRecord(raw)) return null;
  const outcome = raw.outcome;
  if (!isDuplicateOutcome(outcome)) return null;
  const outboxId = typeof raw.outboxId === "string" && raw.outboxId.trim() ? raw.outboxId : null;
  // A cancel with no outbox row would mean the side effects were never enqueued, so
  // it is not a readable cancel.
  if (outcome === "cancelled" && !outboxId) return null;
  const candidateIds = Array.isArray(raw.candidateIds)
    ? raw.candidateIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  const weaker = raw.weakerMatch;
  return {
    outcome,
    outboxId,
    candidateIds,
    weakerMatch: weaker === "phone-only" || weaker === "email-only" ? weaker : null,
  };
}

/**
 * The detail the handoff row carries, or null when this outcome records none.
 *
 * `laterBookingStartsAt` is stored exactly as the caller sent it, and is never
 * re-derived or defaulted: it is the one thing Slate knows only because Regal said
 * so, and a value Slate made up would read in the notice as something it measured.
 */
export function duplicateHandoffDetail(input: {
  outcome: DuplicateOutcome;
  weakerMatch: WeakerMatch;
  laterBookingStartsAt: string | null;
}): DuplicateUnresolvedDetail | null {
  const finding = duplicateFindingFor(input.outcome);
  if (!finding) return null;
  return {
    finding,
    weakerMatch: input.weakerMatch,
    laterBookingStartsAt: input.laterBookingStartsAt,
  };
}

/** Which step could not be completed. Each sends a reader somewhere different. */
export const DUPLICATE_CANCEL_STAGES = ["rpc", "result", "handoff"] as const;
export type DuplicateCancelStage = (typeof DUPLICATE_CANCEL_STAGES)[number];

const STAGE_SENTENCE: Record<DuplicateCancelStage, string> = {
  rpc: "the duplicate check could not be run",
  result: "the duplicate check answered with something Slate could not read",
  handoff: "the finding could not be recorded",
};

/** Nothing was decided, or the decision could not be handed to anybody. Retriable. */
export class DuplicateCancelUnavailableError extends Error {
  readonly stage: DuplicateCancelStage;
  constructor(stage: DuplicateCancelStage, cause?: unknown) {
    super(`duplicate cancel incomplete: ${STAGE_SENTENCE[stage]}`, { cause });
    this.name = "DuplicateCancelUnavailableError";
    this.stage = stage;
  }
}

/** Re-exported so the route and the docs take the finding vocabulary from one place. */
export { DUPLICATE_FINDINGS };
export type { DuplicateFinding };
