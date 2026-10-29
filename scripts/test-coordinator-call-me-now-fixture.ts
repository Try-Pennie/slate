// The live transfer design's frame as the coordinator page draws it (#4380). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coordinator-call-me-now-fixture.ts
//
// docs/design/coordinator-call-me-now.html is drawn over the coordinator page's settled
// "Sam found" frame (f-sam-empty of docs/design/coordinator-booking.html) from its own
// fixture, committed as docs/design/fixtures/coordinator-call-me-now.json. The page's
// `?frame=` preview draws the real component from the same two files, so the design match
// score compares like with like. Pinned: the frames the page answers are exactly the
// design's; each frame is REACHED through the reducer and the offer's own decision, never
// drawn; the fixture's customer is the one the booking frame finds; the card's words are
// the design's; and the copy the design shows is the page's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callMeNowFrame, CALL_ME_NOW_FRAMES, isCallMeNowFrame, type CallMeNowDesignFixture } from "../src/lib/coordinator/call-me-now-fixture.ts";
import { coordinatorBookingFrame, type CoordinatorBookingDesignFixture } from "../src/lib/coordinator/booking-page-fixture.ts";
import { pageView } from "../src/lib/coordinator/booking-page.ts";
import { COORDINATOR_PAGE_COPY as COPY, fillCopy } from "../src/lib/coordinator/booking-page-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const booking = JSON.parse(read("docs/design/fixtures/coordinator-booking.json")) as CoordinatorBookingDesignFixture;
const fixture = JSON.parse(read("docs/design/fixtures/coordinator-call-me-now.json")) as CallMeNowDesignFixture;
const design = read("docs/design/coordinator-call-me-now.html");
const block = (id: string) => {
  const m = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</script>`).exec(design);
  if (!m) throw new Error(`the design has no ${id} block`);
  return JSON.parse(m[1]!) as { frames: { id: string; width: number }[] };
};

// The frames: exactly the design's, and none of the booking design's.
const designFrames = block("design-frames").frames.map((f) => f.id);
eq(Object.keys(CALL_ME_NOW_FRAMES).sort(), [...designFrames].sort(), "the page answers exactly the design's frames");
for (const id of Object.keys(booking.frames)) assert(!isCallMeNowFrame(id), `the booking design's ${id} is not taken for this design's`);
assert(isCallMeNowFrame("f1") && !isCallMeNowFrame("toString"), "a frame is looked up as its own key, never an inherited one");

// The frame: the booking design's Sam found, with the offer the fixture's count earns.
const f = callMeNowFrame(booking, fixture, "f1");
const base = coordinatorBookingFrame(booking, CALL_ME_NOW_FRAMES.f1.from);
eq(f.theme, "light", "f1 is drawn light");
eq(f.nowMs, base.nowMs, "on the booking frame's own clock");
const view = pageView(f.state, { nowMs: f.nowMs, reasons: f.reasons });
eq(view.customer?.name, fixture.customer, "the customer found is the fixture's");
const card = view.transfer;
assert(card?.kind === "card", "the fixture's count reaches its threshold, so the card is drawn");
if (card?.kind === "card") {
  eq(card.line, fixture.transferLine, "the card shows the fixture's transfer line");
  eq(
    [card.heading, card.lead, card.button, card.fallback, card.status, card.pending],
    ["Advisors are free now", "Transfer Sam to an advisor while they're on the line.", "Transfer now", "If it doesn't connect, book a time below.", null, false],
    "in the design's words",
  );
}
assert(view.booking !== null, "and the booking card stays on screen below it");

// Reached, not drawn: one fewer free than the threshold draws no card.
const short = callMeNowFrame(booking, { ...fixture, freeAdvisors: fixture.threshold - 1 }, "f1");
eq(pageView(short.state, { nowMs: short.nowMs, reasons: short.reasons }).transfer, null, "one under the threshold, the same frame draws no card");

// The design's own words are the page's copy.
for (const words of [COPY.transfer.heading, fillCopy(COPY.transfer.lead, { first: "Sam" }), COPY.transfer.button, COPY.transfer.fallback]) {
  assert(design.includes(words.replace(/'/g, "'")) || design.includes(words.replace(/'/g, "&#39;")) || design.includes(words.replace(/'/g, "\\u0027")), `the design shows "${words}"`);
}

let threw = false;
try {
  callMeNowFrame(booking, fixture, "f-sam-empty");
} catch {
  threw = true;
}
assert(threw, "a frame the design does not have is refused by name");

finish();
