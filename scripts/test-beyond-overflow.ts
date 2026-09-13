// #2228: the Beyond overflow is a PERIODIC COUNT, not a page per booking.
//
// #1909 gave a Beyond code an overflow rung: when no Beyond agent is free, an
// Achieve agent in the same debt tier takes the booking. That shipped with a
// notice per placement, throttled an hour per requested code across fifteen
// Beyond codes. Measured against production on 2026-09-10 and again on
// 2026-09-13, a Beyond bucket's pool is at most two people against 88 for
// Achieve, so the overflow is not the exception, it is what happens to a Beyond
// lead most of the time.
//
// Dan settled what that means on 2026-09-13: "we're moving off beyond entirely.
// So we really shouldn't be getting many beyond bookngs". So the overflow is
// expected behaviour, staffing is not the fix, and a page per booking is an
// alert nobody reads by the second week (L36).
//
// This drives the pure half: the two code lists the count is taken over, the
// verdict, and the wording. No database, no clock, no network.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-beyond-overflow.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BEYOND_CODES,
  ACHIEVE_CODES,
  BEYOND_OVERFLOW_NOTICE_KEY,
  BEYOND_OVERFLOW_WINDOW_HOURS,
  BEYOND_OVERFLOW_COOLDOWN_MS,
  beyondOverflowVerdict,
  beyondOverflowNoticeText,
} from "../src/lib/monitor/beyond-overflow.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import { BACKEND } from "../src/lib/xbc.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- anti-vacuity: the lists are really populated -----------------------------
// Empty lists would make every membership assertion below pass by default, and
// would ALSO make the live query count nothing while reading as a clean run (L98).
eq(BEYOND_CODES.length, 15, "five debt tiers times three legal digits of Beyond codes");
eq(ACHIEVE_CODES.length, 15, "and the same for Achieve");

// --- the lists are derived from the vocabulary, not typed out ----------------
for (const code of BEYOND_CODES) {
  eq(BACKEND[code[1]!]?.key, "beyond", `${code} is a Beyond code`);
}
for (const code of ACHIEVE_CODES) {
  eq(BACKEND[code[1]!]?.key, "achieve", `${code} is an Achieve code`);
}
assert(
  BEYOND_CODES.every((c) => !ACHIEVE_CODES.includes(c)),
  "no code is on both sides, or a Beyond lead booked in its own pool would count as an overflow",
);

// --- the booked-side list covers every Achieve rung a Beyond code can reach ---
//
// This is the invariant the count rests on, and it is asked of the REAL ladder
// rather than re-derived here, so the two can never disagree about what a rung is
// (L107). It matters for the case that is easy to forget: 522 to 432 dropped a
// debt tier AND overflowed, and it carries the same consequence as 522 to 532.
for (const code of BEYOND_CODES) {
  for (const rung of tierLadder(code)) {
    if (BACKEND[rung[1]!]?.key !== "achieve") continue;
    assert(
      ACHIEVE_CODES.includes(rung),
      `${code} can reach ${rung}, so the booked-side list must contain it`,
    );
  }
}

// And the control in the other direction: a Beyond rung is never on the booked
// side, so a Beyond lead who got a Beyond agent is not counted (L104).
for (const code of BEYOND_CODES) {
  for (const rung of tierLadder(code)) {
    if (BACKEND[rung[1]!]?.key !== "beyond") continue;
    assert(
      !ACHIEVE_CODES.includes(rung),
      `${rung} is a Beyond pool and must never count as an overflow`,
    );
  }
}

// --- the key, the window and the cooldown ------------------------------------
eq(BEYOND_OVERFLOW_NOTICE_KEY, "beyond_overflow_rate", "one constant for the key");
eq(BEYOND_OVERFLOW_WINDOW_HOURS, 24, "counted over a day");
assert(
  BEYOND_OVERFLOW_COOLDOWN_MS >= BEYOND_OVERFLOW_WINDOW_HOURS * 3600_000,
  "the cooldown is at least the window, so one report can never cover ground another already did",
);

// --- judging nothing is never a pass -----------------------------------------
for (const w of [
  { overflowed: 0, beyondBooked: 0, why: "nothing was booked on a Beyond code" },
  { overflowed: 0, beyondBooked: Number.NaN, why: "the total could not be read" },
  { overflowed: Number.NaN, beyondBooked: 4, why: "the overflow count could not be read" },
  { overflowed: -1, beyondBooked: 4, why: "a negative count" },
  { overflowed: 5, beyondBooked: 4, why: "more overflows than bookings, which is a broken read" },
]) {
  const v = beyondOverflowVerdict({
    overflowed: w.overflowed,
    beyondBooked: w.beyondBooked,
    windowHours: BEYOND_OVERFLOW_WINDOW_HOURS,
  });
  eq(v.kind, "unmeasured", `unmeasured: ${w.why}`);
  if (v.kind === "unmeasured") {
    assert(v.reason.length > 10, `and says why: ${w.why}`);
  }
}

// Each unmeasured state says something DIFFERENT, so one can never answer for
// another (L11).
{
  const reasons = [
    { overflowed: 0, beyondBooked: 0 },
    { overflowed: Number.NaN, beyondBooked: 4 },
    { overflowed: 5, beyondBooked: 4 },
  ].map((w) => {
    const v = beyondOverflowVerdict({ ...w, windowHours: 24 });
    return v.kind === "unmeasured" ? v.reason : "";
  });
  eq(new Set(reasons).size, reasons.length, "no two unmeasured reasons share their wording");
}

// --- a measured window with no overflow says nothing --------------------------
{
  const v = beyondOverflowVerdict({ overflowed: 0, beyondBooked: 6, windowHours: 24 });
  eq(v.kind, "quiet", "six Beyond bookings, none overflowed, is nothing to report");
}

// --- a measured window with overflow reports ---------------------------------
{
  const v = beyondOverflowVerdict({ overflowed: 9, beyondBooked: 11, windowHours: 24 });
  eq(v.kind, "report", "nine of eleven is worth one line a day");
  if (v.kind !== "report") throw new Error("unreachable");
  eq(v.overflowed, 9, "carries the count");
  eq(v.beyondBooked, 11, "and the total it was out of");
}

// --- the wording ------------------------------------------------------------
const report = (overflowed: number, beyondBooked: number) => {
  const v = beyondOverflowVerdict({ overflowed, beyondBooked, windowHours: 24 });
  if (v.kind !== "report") throw new Error(`expected a report, got ${v.kind}`);
  return beyondOverflowNoticeText(v, BEYOND_OVERFLOW_WINDOW_HOURS);
};

{
  // The realistic shape, not one example: most of a day's Beyond leads overflowing.
  const text = report(9, 11);
  assert(/\b9 of 11\b/.test(text), `names both numbers (got ${text})`);
  assert(/Beyond bookings/.test(text), "plural where it is plural");
  assert(/\bwere taken\b/.test(text), "and the verb agrees");
  assert(!/^Slate\b/.test(text), "never opens with the app's own name; Slack already says it");
  assert(
    /expected/i.test(text),
    `it says the overflow is expected rather than implying a fault (got ${text})`,
  );
  assert(
    /2026-09-13/.test(text) && /Dan/.test(text),
    `it attributes the decision and dates it, so a reader can re-check the premise (got ${text})`,
  );
  assert(
    /no staffing action/i.test(text),
    "and says outright that it is not asking for staffing, which is the fix it is NOT",
  );

  // The one consequence that is not routine, kept visible rather than folded into
  // the count and lost. Slate holds no geography for the lead, so it can name the
  // exposure and must not claim to have measured it (L11).
  assert(/Colorado/.test(text), "names Colorado");
  assert(/West Virginia/.test(text), "names West Virginia");
  // Stated as the RULE, never as a measurement. Nothing here read the lead's
  // state, so a sentence saying one of these leads IS in Colorado would be a claim
  // the check never made (L11).
  assert(
    /so an overflowed lead in either state has been booked/.test(text),
    `the Colorado sentence is conditional on the rule, not asserted as observed (got ${text})`,
  );
  assert(
    /cannot say which of the 9/.test(text),
    `and says plainly that it cannot tell which ones (got ${text})`,
  );

  // The copy rules the repo enforces everywhere.
  // Written as escapes so the file holds no literal dash: the pre-push style hook
  // cannot tell a line that BANS the character from one that uses it.
  assert(!/[\u2014\u2013]/.test(text), "no em or en dash");
  assert(!/\b(undefined|NaN|null)\b/.test(text), "nothing leaked into the sentence");
}

{
  // The state that embarrassed the 2026-07-28 page: "1 of 97 bookable agent".
  const text = report(1, 1);
  assert(/\b1 of 1 Beyond booking\b/.test(text), `singular noun (got ${text})`);
  assert(!/1 of 1 Beyond bookings/.test(text), "never a plural noun on one");
  assert(/\bwas taken\b/.test(text), `singular verb (got ${text})`);
  assert(!/which of the 1\b/.test(text), `and never "which of the 1" (got ${text})`);
}

{
  // The mixed case: one of several. The noun follows the total, the verb the count.
  const text = report(1, 7);
  assert(/\b1 of 7 Beyond bookings\b/.test(text), `plural noun on the total (got ${text})`);
  assert(/\bwas taken\b/.test(text), `singular verb on the count (got ${text})`);
}

// --- deterministic ----------------------------------------------------------
eq(report(9, 11), report(9, 11), "the same window renders the same words, so a diff means the copy moved");

// --- the wiring on the monitor lane -----------------------------------------
//
// The verdict above can be perfect and still reach nobody, or reach the wrong
// channel. The three properties that decide what this change actually IS live in
// the route, not in this module, so they are read out of the route's own source:
// it must go to the INFO channel (a page is the thing #2228 removed), it must sit
// inside its own failure boundary like every other check on the lane (#1281), and
// it must never resolve, because it is classified `info` and an all-clear for it
// would say the expected thing stopped happening for a day.
//
// Each assertion carries a positive control that sabotages the source in memory,
// because a scan whose pattern stopped matching reports a clean file exactly as a
// correct one does (L1, L98).
{
  const route = readFileSync(join(import.meta.dirname, "..", "src/app/api/cron/monitor/route.ts"), "utf8");
  assert(route.length > 20_000, `read the monitor route (${route.length} chars)`);

  const stepLine = (src: string) => new RegExp(`steps\\.run\\("${BEYOND_OVERFLOW_NOTICE_KEY}"`).test(src);
  assert(stepLine(route), "the count runs inside its own steps.run boundary");
  assert(
    !stepLine(route.replace(`steps.run("${BEYOND_OVERFLOW_NOTICE_KEY}"`, "runBeyondOverflow(")),
    "and the check would notice a step lifted out of the runner",
  );

  // The step's own body, so a neighbouring step's dispatcher cannot answer for it:
  // from this step's marker to the next step's. Comments are stripped, so prose
  // ABOUT a dispatcher can never satisfy or break a check on one (L103).
  const body = (route.split(`steps.run("${BEYOND_OVERFLOW_NOTICE_KEY}"`)[1] ?? "")
    .split("steps.run(")[0]!
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert(body.length > 100, `read the step's body (${body.length} chars)`);
  assert(/sendThrottledInfo\(/.test(body), "it sends on the info channel");
  assert(
    !/sendThrottledAlert\(/.test(body),
    "and never pages, which is the whole of what #2228 changed about who hears it",
  );
  assert(
    !/resolveAlert\(|resolveRecovered\(/.test(body),
    "and never resolves, because an info notice has no condition to end",
  );
  assert(
    /sendThrottledAlert\(/.test(`${body}\n await sendThrottledAlert(KEY, MS, text);`),
    "the page check really would catch a page put back here",
  );
}

finish();
