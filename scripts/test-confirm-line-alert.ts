// When the shared confirm line cannot be used, what is logged and what pages (#3325).
//
// A fallback to the isolate's own line is always safe (the bookings indexes and
// verify on book still decide), so one fallback is a log line, not a page. A deploy
// restarts every object and answers `gone`, which is expected and never pages (L36).
// What pages is the shared line failing again and again for real: a missing binding
// or calls not answered, several times within a minute on one isolate. Off the
// Workers runtime (a dev server, a node script) nothing pages at all.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-line-alert.ts
import {
  makeReachFailureReporter,
  confirmLineUnreachableAlert,
  CONFIRM_LINE_PAGE_AFTER,
  CONFIRM_LINE_PAGE_WINDOW_MS,
  CONFIRM_LINE_ALERT_COOLDOWN_MS,
} from "../src/lib/booking/confirm-line-alert.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

function reporter(onWorkers = true) {
  let now = 1_000;
  const logs: Record<string, unknown>[] = [];
  const pages: string[] = [];
  const report = makeReachFailureReporter({ now: () => now, onWorkers: () => onWorkers, log: (f) => logs.push(f), page: (t) => pages.push(t) });
  return { report, logs, pages, move: (ms: number) => (now += ms) };
}

// --- one fallback is logged, never paged ------------------------------------------
{
  const r = reporter();
  r.report("reach-timeout", new Error("no answer within 1500ms"));
  assert(r.logs.length === 1 && r.pages.length === 0, "one: a single fallback is logged and does not page");
  assert(r.logs[0]?.reason === "reach-timeout", "one: the log names the reason");
}

// --- repeated real failures inside the window page, once ---------------------------
{
  const r = reporter();
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER; i++) r.report("reach-timeout", null);
  assert(r.pages.length === 1, `repeated: ${CONFIRM_LINE_PAGE_AFTER} failures inside the window page once (got ${r.pages.length})`);
  r.report("enter-error", null);
  assert(r.pages.length === 1, "repeated: further failures do not page again from this isolate (the alert store throttles across isolates)");
}

// --- #3349: a later, separate outage on the same isolate pages again ----------------
// The first page used to latch for the isolate's whole life, so a long lived isolate
// that paged once never paged about a second outage hours later. A page now waits only
// as long as the alert's own cooldown.
{
  const r = reporter();
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER; i++) r.report("reach-timeout", null);
  assert(r.pages.length === 1, "first outage: pages");
  r.move(CONFIRM_LINE_ALERT_COOLDOWN_MS - CONFIRM_LINE_PAGE_WINDOW_MS);
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER; i++) r.report("reach-timeout", null);
  assert(r.pages.length === 1, `a burst inside the cooldown does not page again (got ${r.pages.length})`);
  r.move(CONFIRM_LINE_ALERT_COOLDOWN_MS);
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER; i++) r.report("reach-timeout", null);
  assert(r.pages.length === 2, `a separate outage after the cooldown pages again from the same isolate (got ${r.pages.length})`);
}

// --- failures spread out past the window do not add up ----------------------------
{
  const r = reporter();
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER; i++) {
    r.report("reach-timeout", null);
    r.move(CONFIRM_LINE_PAGE_WINDOW_MS);
  }
  assert(r.pages.length === 0, "spread: failures a window apart never page");
}

// --- a deploy's `gone` is counted, never paged -------------------------------------
{
  const r = reporter();
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER * 3; i++) r.report("gone", null);
  assert(r.pages.length === 0, "gone: a deploy restarting the object never pages");
  assert(r.logs.length > 0, "gone: but it is logged");
}

// --- a missing binding pages on the same rule ---------------------------------------
{
  const r = reporter();
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER; i++) r.report("unbound", null);
  assert(r.pages.length === 1, "unbound: a switch that is on with no binding pages");
  assert(r.pages[0]!.includes("binding"), `unbound: and says it is the binding (got ${r.pages[0]})`);
}

// --- #3351: an answer the client cannot read pages on the same rule ------------------
// It is a protocol fault, not a deploy, so it is never folded into `gone`.
{
  const r = reporter();
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER; i++) r.report("bad-answer", null);
  assert(r.pages.length === 1, `bad answer: repeated answers the client cannot read page (got ${r.pages.length})`);
}

// --- #3351: a page worded from the WHOLE window, never only the failure that tipped it --
// Two timeouts and one unreadable reply must not page as "replies they cannot read",
// which claims a cause only one of the three showed (L11).
{
  const r = reporter();
  r.report("reach-timeout", null);
  r.report("reach-timeout", null);
  r.report("bad-answer", null);
  assert(r.pages.length === 1, "mixed: three failures of two kinds page once");
  const text = r.pages[0] ?? "";
  assert(/2 could not reach it/.test(text) && /1 got a reply it could not read/.test(text), `mixed: the page counts each kind (got ${text})`);
  const same = reporter();
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER; i++) same.report("reach-timeout", null);
  assert(same.pages[0] === confirmLineUnreachableAlert("reach-timeout"), "uniform: one kind keeps that kind's own wording");
}

// --- off the Workers runtime nothing pages ------------------------------------------
{
  const r = reporter(false);
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER * 2; i++) r.report("unbound", null);
  assert(r.pages.length === 0, "off platform: a dev server or script never pages");
  assert(r.logs.length > 0, "off platform: but it is logged");
}

// --- the copy: what happened, what it means for a lead, and who acts ------------------
{
  const DASHES = new RegExp("[\\u2013\\u2014]");
  const timeout = confirmLineUnreachableAlert("reach-timeout");
  assert(!/^Slate/.test(timeout), "copy: does not open with the app's own name");
  assert(/still/i.test(timeout) && /double book/i.test(timeout), `copy: says bookings still go through and nothing is double booked (got ${timeout})`);
  assert(!DASHES.test(timeout + confirmLineUnreachableAlert("unbound") + confirmLineUnreachableAlert("bad-answer")), "copy: no dashes");
  // #3351: the line answered, so the page must not claim it could not be reached (L11).
  const unreadable = confirmLineUnreachableAlert("bad-answer");
  assert(!/cannot reach/i.test(unreadable) && /cannot read/i.test(unreadable), `copy: a bad answer says the replies could not be read, not that the line was unreachable (got ${unreadable})`);
  // #3560: the line answered, and said it is older than the app: the page says so and
  // names the remedy, a redeploy of the line Worker, which neither other wording does.
  const older = confirmLineUnreachableAlert("version");
  assert(!DASHES.test(older), "copy: no dashes in the version wording");
  assert(!/cannot reach/i.test(older) && /older/i.test(older) && /redeploy/i.test(older), `copy: a version mismatch says the line is older than the app and to redeploy it (got ${older})`);
}

// --- #3560: an object older than the app pages, and is counted as itself in a mix -----
{
  const r = reporter();
  for (let i = 0; i < CONFIRM_LINE_PAGE_AFTER; i++) r.report("version", null);
  assert(r.pages.length === 1 && r.pages[0] === confirmLineUnreachableAlert("version"), `version: repeated version mismatches page in their own words (got ${JSON.stringify(r.pages)})`);
  const mixed = reporter();
  mixed.report("reach-timeout", null);
  mixed.report("version", null);
  mixed.report("version", null);
  const text = mixed.pages[0] ?? "";
  assert(/1 could not reach it/.test(text) && /2 found it running an older build than this app/.test(text), `version: a mix counts the mismatches as themselves, never as unreachable (got ${text})`);
}

finish();
