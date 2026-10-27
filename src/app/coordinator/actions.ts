"use server";

/**
 * The coordinator booking page's server functions (#4205, Phase 7 of milestone 75). The
 * page itself gets its look in a design round with Dan; these are what it will call.
 *
 * EACH ONE CHECKS THE ROLE ITSELF (`coordinatorDeskUser`: a coordinator, or an admin) and
 * never trusts the page, because a server action is a public endpoint whoever renders
 * the form. Each answers a typed result with a sentence rather than throwing, so the page
 * always has something to draw, and each is rate limited per signed in person through the
 * shared database limiter (`allowRequest`, the pattern the webhook test send uses), which
 * fails open and loud like every other limiter here.
 *
 * Plan: https://claude.ai/artifact/XbByMLoaMrBufMr6Chmct1
 */
import { coordinatorDeskUser } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { COORDINATOR_LOOKUP_RATE_RULES, COORDINATOR_PLACE_RATE_RULES } from "@/lib/rate-limit-core";
import { log } from "@/lib/log";
import { lookupCustomer, type CustomerLookup } from "@/lib/coordinator/customer";
import { placeholderCallsAt, type PlaceholderCalls } from "@/lib/coordinator/placeholder-calls";
import { placeCall, refused, type PlaceCallOutcome, type PlaceCallRequest } from "@/lib/coordinator/place-call";
import { refusalSentence, type CoordinatorRefusal } from "@/lib/coordinator/coordinator-copy";
import { lookupDeps, placeCallDeps, placeholderCallsDeps } from "@/lib/coordinator/live";

type Refused = { ok: false; refusal: CoordinatorRefusal; sentence: string };
const refusedAnswer = (refusal: CoordinatorRefusal): Refused => ({ ok: false, refusal, sentence: refusalSentence(refusal) });

const text = (v: unknown): string => (typeof v === "string" ? v : "");

export type CoordinatorLookupAnswer = Exclude<CustomerLookup, { ok: false }> | Refused;

/**
 * Look up the customer on the phone from the Lead link or id: who they are, their zone
 * and bucket (from the Lead), their existing call and what will happen to it, and the
 * hours a call may start on `date` (their local YYYY-MM-DD; today there when absent).
 */
export async function lookupCoordinatorCustomer(input: { reference: string; date?: string }): Promise<CoordinatorLookupAnswer> {
  const me = await coordinatorDeskUser();
  if (!me) return refusedAnswer("not-authorized");
  if (!(await allowRequest({ kind: "opaque", key: `coordinator:${me.id}` }, COORDINATOR_LOOKUP_RATE_RULES))) {
    return refusedAnswer("rate-limited");
  }
  try {
    const date = text(input?.date).trim();
    const out = await lookupCustomer({ reference: text(input?.reference), ...(date ? { date } : {}) }, lookupDeps());
    if (out.ok) return out;
    log.info("coordinator", { msg: "customer lookup refused", reason: out.refusal, user_id: me.id });
    return refusedAnswer(out.refusal);
  } catch (err) {
    log.error("coordinator", { msg: "customer lookup failed", user_id: me.id }, err);
    return refusedAnswer("internal");
  }
}

export type PlaceholderCallsAnswer = Extract<PlaceholderCalls, { ok: true }> | Refused;

/** How many calls already sit on the placeholder advisor over the call's time. */
export async function countPlaceholderCalls(input: { bucketCode: string; startIso: string }): Promise<PlaceholderCallsAnswer> {
  const me = await coordinatorDeskUser();
  if (!me) return refusedAnswer("not-authorized");
  if (!(await allowRequest({ kind: "opaque", key: `coordinator:${me.id}` }, COORDINATOR_LOOKUP_RATE_RULES))) {
    return refusedAnswer("rate-limited");
  }
  try {
    const out = await placeholderCallsAt({ bucketCode: text(input?.bucketCode), startIso: text(input?.startIso) }, placeholderCallsDeps());
    if (out.ok) return out;
    return refusedAnswer(out.reason);
  } catch (err) {
    // A failed count is never zero: the page says it could not count.
    log.error("coordinator", { msg: "placeholder count failed", user_id: me.id }, err);
    return refusedAnswer("internal");
  }
}

/**
 * Book, or move, the customer's call at the time they named, as the signed in person.
 * The customer is re-read from Salesforce here, so the zone and bucket are the Lead's,
 * never the page's. A double press books once: send the same `submissionId` again (the
 * answer always carries the one used).
 */
// outcome-ok: every answer is a typed outcome the page draws, its sentence included
export async function placeCoordinatorCall(input: PlaceCallRequest): Promise<PlaceCallOutcome> {
  const submissionId = text(input?.submissionId);
  const me = await coordinatorDeskUser();
  if (!me) return refused("not-authorized", submissionId);
  if (!(await allowRequest({ kind: "opaque", key: `coordinator:${me.id}` }, COORDINATOR_PLACE_RATE_RULES))) {
    return refused("rate-limited", submissionId);
  }
  const move = input?.move
    ? { bookingId: text(input.move.bookingId), reasonCode: text(input.move.reasonCode), reasonDetail: text(input.move.reasonDetail) }
    : undefined;
  try {
    const out = await placeCall(
      { reference: text(input?.reference), startIso: text(input?.startIso), ...(submissionId ? { submissionId } : {}), ...(move ? { move } : {}) },
      { id: me.id },
      placeCallDeps(),
    );
    if (out.kind === "refused") {
      log.info("coordinator", { msg: "call not placed", reason: out.reason, user_id: me.id });
    } else {
      log.info("coordinator", { msg: "call placed", outcome: out.kind, user_id: me.id });
    }
    return out;
  } catch (err) {
    log.error("coordinator", { msg: "placing a call failed", user_id: me.id }, err);
    return refused("internal", submissionId);
  }
}
