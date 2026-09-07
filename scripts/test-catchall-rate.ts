// The catch-all rate page (#1908). Run:
//   node --experimental-strip-types scripts/test-catchall-rate.ts
//
// WHY THE ALERT EXISTS AT ALL. Routing a lead with no code to the Low pool is the
// right behaviour and also a defect absorber: every rescue is an upstream page
// that failed to send a routing code. cal.com has been doing exactly this
// silently, and it turned out to be carrying roughly 2 percent of all bookings
// with nobody aware. Shipping the rescue without the count would reproduce the
// condition it was written to end.
//
// THE THRESHOLD IS CALIBRATED, NOT GUESSED. cal.com's own catch-all runs at 1.75
// percent (105 of 6,000 responses) and 2 percent (4 of the newest 200, measured
// 2026-09-07). Five percent is about two and a half times that.
import {
  catchallVerdict,
  catchallPageText,
  catchallClearText,
  CATCHALL_RATE_THRESHOLD,
  CATCHALL_MIN_COUNT,
  CATCHALL_SATURATION_SHARE,
  CATCHALL_RATE_ALERT_KEY,
} from "../src/lib/monitor/catchall-rate.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const W = 24;
const w = (catchall: number, total: number) => ({ catchall, total, windowHours: W });

// --- nothing to judge is never a pass ---------------------------------------------
{
  // The state Slate is in TODAY, and for as long as no leads reach it. If this
  // read as healthy, the alert would spend the whole parallel run reporting an
  // all clear about a rate it has never once measured (L98).
  const r = catchallVerdict(w(0, 0));
  eq(r.kind, "unmeasured", "no bookings at all is unmeasured, not healthy");
  if (r.kind === "unmeasured") assert(r.reason.includes("24h"), "and says over what window it found nothing");
}
{
  // A count bigger than the total is a broken read, not a very high rate.
  // Reporting 300 percent would send somebody hunting for an upstream fault that
  // is actually ours.
  const r = catchallVerdict(w(7, 3));
  eq(r.kind, "unmeasured", "more rescues than bookings is refused rather than reported as a rate");
  if (r.kind === "unmeasured") assert(r.reason.includes("cannot be right"), "and says so plainly");
}
{
  eq(catchallVerdict(w(-1, 50)).kind, "unmeasured", "a negative count is refused");
  eq(catchallVerdict(w(Number.NaN, 50)).kind, "unmeasured", "and so is one that could not be read");
  eq(catchallVerdict(w(2, Number.NaN)).kind, "unmeasured", "an unreadable total too");
}

// --- the healthy day ----------------------------------------------------------------
{
  // The incumbent's own rate. This is what a normal day looks like, and it must
  // not page or the alert is noise from the first morning.
  const r = catchallVerdict(w(4, 200));
  eq(r.kind, "healthy", "2 percent, which is what cal.com runs at, is healthy");
  if (r.kind === "healthy") eq(Number(r.share.toFixed(3)), 0.02, "and the share is reported");
}
{
  eq(catchallVerdict(w(0, 500)).kind, "healthy", "no rescues at all is healthy");
  eq(catchallVerdict(w(10, 200)).kind, "healthy", "5 percent exactly is not yet over the line");
}

// --- the rate trigger ------------------------------------------------------------------
{
  const r = catchallVerdict(w(11, 200));
  eq(r.kind, "page", "5.5 percent pages");
  if (r.kind === "page") eq(r.trigger, "rate", "as a rate finding");
}
{
  // The floor. A proportion over one or two bookings is noise, and paging on it
  // is how somebody learns to ignore the alert.
  const r = catchallVerdict(w(2, 3));
  assert(r.kind !== "healthy", "2 of 3 is not healthy");
  const under = catchallVerdict(w(1, 4));
  eq(under.kind, "healthy", "1 of 4 is under the count floor, so the rate cannot page on it");
  assert(CATCHALL_MIN_COUNT >= 3, "and the floor is at least three, so a single stray cannot page");
}

// --- the saturation trigger, which the floor would otherwise silence ------------------
{
  // L139: a floor added so a rate is not noisy at small samples also silences the
  // case where EVERYTHING is broken, because a proportion cannot tell one bad out
  // of two from twelve out of twelve. Two of two must page even though two is
  // under the count floor.
  const r = catchallVerdict(w(2, 2));
  eq(r.kind, "page", "everything in the window being rescued pages, even under the count floor");
  if (r.kind === "page") eq(r.trigger, "saturation", "and it is named as saturation, not as drift");
}
{
  const r = catchallVerdict(w(1, 2));
  eq(r.kind, "page", "half of a tiny window still pages");
  if (r.kind === "page") eq(r.trigger, "saturation", "as saturation");
}
{
  // The two triggers must be distinguishable, because they mean different things:
  // drift is a page that started sending fewer codes, saturation is one that
  // stopped entirely.
  const drift = catchallVerdict(w(20, 200));
  const sat = catchallVerdict(w(60, 100));
  if (drift.kind === "page" && sat.kind === "page") {
    assert(drift.trigger !== sat.trigger, "10 percent is drift and 60 percent is saturation");
  } else {
    assert(false, "both of those should page");
  }
}

// --- the wording somebody reads on a phone ------------------------------------------
{
  const v = catchallVerdict(w(20, 200));
  if (v.kind === "page") {
    const text = catchallPageText(v, W);
    assert(text.includes("10.0%"), "the page names the rate");
    assert(text.includes("20 of 200"), "and the counts behind it, so the reader can judge the sample");
    assert(text.includes("24h"), "and the window");
    assert(text.includes("upstream"), "and says where the cause is, since the fix is never in Slate");
    assert(text.includes("requested_code"), "and names what to look at");
    assert(!/undefined|NaN|\[object/.test(text), "and leaks nothing");
    assert(!text.startsWith("Slate"), "and does not open with the product name, which Slack already shows");
  } else assert(false, "that should page");
}
{
  const text = catchallClearText(0.018, W);
  assert(text.includes("1.8%"), "the all clear names where the rate landed");
  assert(!/undefined|NaN/.test(text), "and leaks nothing");
}
{
  // A dash in alert copy is banned repo-wide, and this is copy.
  for (const text of [catchallPageText({ kind: "page", share: 0.1, catchall: 20, total: 200, trigger: "rate" }, W), catchallClearText(0.01, W)]) {
    // Written as escapes, not literals: the repo's own style gate scans added
    // lines for these characters and cannot tell a line banning one from a line
    // using one, which is the gate working correctly.
    assert(!/[\u2014\u2013]/.test(text), "no dashes in the copy");
  }
}

// --- the key is one constant ------------------------------------------------------
{
  // The page and its all clear must key on the same row, or a page is sent that
  // nothing can ever clear.
  eq(CATCHALL_RATE_ALERT_KEY, "catchall_rate", "the alert key is stable");
  assert(CATCHALL_RATE_THRESHOLD > 0 && CATCHALL_RATE_THRESHOLD < 1, "the threshold is a share, not a percentage");
  assert(
    CATCHALL_SATURATION_SHARE > CATCHALL_RATE_THRESHOLD,
    "saturation is above the drift threshold, or the two triggers would be indistinguishable",
  );
}

finish();
