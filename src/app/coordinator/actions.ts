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
import { coordinatorDeskUser, requireCoordinatorDesk } from "@/lib/auth";
import { allowRequest } from "@/lib/rate-limit";
import { COORDINATOR_LOOKUP_RATE_RULES, COORDINATOR_PLACE_RATE_RULES, COORDINATOR_TRANSFER_RATE_RULES } from "@/lib/rate-limit-core";
import { log } from "@/lib/log";
import { lookupCustomer, type CustomerLookup } from "@/lib/coordinator/customer";
import { placeCall, refused, type PlaceCallOutcome, type PlaceCallRequest } from "@/lib/coordinator/place-call";
import { refusalSentence, type CoordinatorRefusal } from "@/lib/coordinator/coordinator-copy";
import { lookupDeps, placeCallDeps, transferDeps } from "@/lib/coordinator/live";
import { decideTransferOffer, type TransferOffer } from "@/lib/coordinator/transfer-queue";

type Refused = { ok: false; refusal: CoordinatorRefusal; sentence: string };
const refusedAnswer = (refusal: CoordinatorRefusal): Refused => ({ ok: false, refusal, sentence: refusalSentence(refusal) });

const text = (v: unknown): string => (typeof v === "string" ? v : "");

export type CoordinatorLookupAnswer = Exclude<CustomerLookup, { ok: false }> | Refused;

/** The per person limit on the lookup. */
function withinLookupLimit(userId: string): Promise<boolean> {
  return allowRequest({ kind: "opaque", key: `coordinator:${userId}` }, COORDINATOR_LOOKUP_RATE_RULES);
}

/**
 * Look up the customer on the phone from the Lead link or id: who they are, their zone
 * and bucket (from the Lead), their existing call and what will happen to it, and the
 * hours a call may start on `date` (their local YYYY-MM-DD; today there when absent).
 */
export async function lookupCoordinatorCustomer(input: { reference: string; date?: string }): Promise<CoordinatorLookupAnswer> {
  const me = await coordinatorDeskUser();
  if (!me) return refusedAnswer("not-authorized");
  if (!(await withinLookupLimit(me.id))) {
    return refusedAnswer("rate-limited");
  }
  try {
    const date = text(input?.date).trim();
    // Routing is the signed in coordinator's own: a test account (the drill) books
    // the partner test bucket whatever the Lead's score (Dan, 2026-10-27). Never read from the page.
    const out = await lookupCustomer({ reference: text(input?.reference), ...(date ? { date } : {}) }, lookupDeps(), {
      testCoordinator: me.is_test === true,
    });
    if (out.ok) return out;
    log.info("coordinator", { msg: "customer lookup refused", reason: out.refusal, user_id: me.id });
    return refusedAnswer(out.refusal);
  } catch (err) {
    log.error("coordinator", { msg: "customer lookup failed", user_id: me.id }, err);
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
      { id: me.id, isTest: me.is_test === true },
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

export type CoordinatorTransferAnswer = TransferOffer | { kind: "refused"; refusal: "not-authorized" | "rate-limited" };

/**
 * May the coordinator transfer the customer on the line to an advisor now? (#4380.) Asked
 * when the customer is found and again when Transfer now is pressed, since the count is
 * approximate and reserves nothing.
 *
 * WHO: `requireCoordinatorDesk` (a coordinator, or an admin), checked here, never trusted
 * to the page. WHOSE DATA: none of the customer's; it takes nothing from the browser. The
 * queue is chosen on the endpoint's side, and the threshold and line are the stored
 * settings, so the browser can neither pick a queue nor lower the bar. The agents'
 * browsers never call the endpoint; this server does, with a short timeout and a strict
 * parse (`transfer-queue.ts`), so a count it cannot read answers `unreadable`, never busy.
 * Records nothing: Slate cannot see whether a transfer happened.
 */
// outcome-ok: every answer is a typed outcome the page draws
export async function checkCoordinatorTransfer(): Promise<CoordinatorTransferAnswer> {
  let me: Awaited<ReturnType<typeof requireCoordinatorDesk>>;
  try {
    me = await requireCoordinatorDesk();
  } catch {
    return { kind: "refused", refusal: "not-authorized" };
  }
  if (!(await allowRequest({ kind: "opaque", key: `coordinator:${me.id}` }, COORDINATOR_TRANSFER_RATE_RULES))) {
    return { kind: "refused", refusal: "rate-limited" };
  }
  try {
    const deps = transferDeps();
    const [reading, settings] = await Promise.all([deps.readQueue(), deps.readSettings()]);
    const offer = decideTransferOffer(reading, settings);
    if (offer.kind === "unreadable") {
      log.warn("coordinator", {
        msg: "live transfer not checkable",
        why: offer.why,
        ...(reading.ok ? {} : { reason: reading.why, detail: reading.detail }),
        user_id: me.id,
      });
    } else {
      log.info("coordinator", { msg: "live transfer checked", offer: offer.kind, free: reading.ok ? reading.free : null, user_id: me.id });
    }
    return offer;
  } catch (err) {
    log.error("coordinator", { msg: "live transfer check failed", user_id: me.id }, err);
    return { kind: "unreadable", why: "count" };
  }
}
