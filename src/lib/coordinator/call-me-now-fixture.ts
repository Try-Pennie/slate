/**
 * The live transfer design's frames as the coordinator page renders them (#4380).
 *
 * docs/design/coordinator-call-me-now.html draws its offer over the coordinator page's
 * settled "Sam found" screen (frame f-sam-empty of docs/design/coordinator-booking.html),
 * from its own fixture, committed as docs/design/fixtures/coordinator-call-me-now.json.
 * The page's `?frame=` preview draws the real component from both files, so the design
 * match score compares like with like. Each frame is REACHED, not drawn: the booking
 * frame's own events, then the offer the fixture's count earns through the real decision
 * (`decideTransferOffer`), answered as the transfer check would answer it. Only ever
 * reached behind `designFixturesEnabled`. scripts/test-coordinator-call-me-now-fixture.ts
 * holds the frames to the design's. Pure: JSON in, the frame's state out.
 */
import { coordinatorBookingFrame, type CoordinatorBookingDesignFixture, type CoordinatorBookingFrame } from "./booking-page-fixture.ts";
import { reducePage, transferRequest, type TransferAnswer } from "./booking-page.ts";
import { decideTransferOffer } from "./transfer-queue.ts";
import { designFixtureFrame } from "../admin/design-fixture-frame.ts";

/** The design's fixture, exactly as the settled file drew its frames from it. */
export interface CallMeNowDesignFixture {
  customer: string;
  transferLine: string;
  freeAdvisors: number;
  threshold: number;
}

/** The design's frames, each over the booking design's frame it was drawn on. */
export const CALL_ME_NOW_FRAMES = {
  f1: { theme: "light", from: "f-sam-empty" },
} as const;

export function isCallMeNowFrame(id: string): id is keyof typeof CALL_ME_NOW_FRAMES {
  return Object.prototype.hasOwnProperty.call(CALL_ME_NOW_FRAMES, id);
}

export function callMeNowFrame(booking: CoordinatorBookingDesignFixture, fixture: CallMeNowDesignFixture, frameId: string): CoordinatorBookingFrame {
  const frame = designFixtureFrame<{ theme: string; from: string }>(CALL_ME_NOW_FRAMES, frameId);
  const base = coordinatorBookingFrame(booking, frame.from);
  const ask = transferRequest(base.state);
  if (!ask) throw new Error(`frame "${frameId}" is drawn over ${frame.from}, which has found no customer`);
  const offer = decideTransferOffer({ ok: true, free: fixture.freeAdvisors }, { threshold: fixture.threshold, line: fixture.transferLine });
  const answer: TransferAnswer = offer.kind === "offer" ? offer : offer.kind === "busy" ? { kind: "busy" } : { kind: "unreadable" };
  return { ...base, theme: frame.theme, state: reducePage(base.state, { type: "transferAnswered", seq: ask.seq, answer }) };
}
