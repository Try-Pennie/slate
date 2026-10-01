// Parking a verdict detector that cannot conclude yet (#1561).
//
// The verdict freshness watch (#1394) does the right thing and pages when a
// detector has stopped reaching a verdict. Before cutover two of them CANNOT
// reach one: the availability truth probe finds no bucket offering times while
// the roster is dark (#1272), and the booking failure rate needs 20 attempts in
// a rolling hour, where every attempt production has is the canary's and one full
// canary pass records exactly 16 of them. So both paged every 24 hours naming an
// action nobody could take (L111), which is how a channel gets ignored (L36).
//
// Parking is the answer, and it has three ways to go wrong, all tested here. A
// park that is INVISIBLE is the #1394 defect again, one level up: the safety net
// is off and nothing says so. A park that cannot END outlives its reason, so the
// detector stays off after the very cutover it was waiting for. And a park that
// ends on the WRONG evidence pages for an accident: #1562 found that four or five
// canary passes a day means two occasionally land inside one hour and clear the
// floor between them, which is a two minute coincidence rather than the arrival of
// customers, and judging it against the four day blindness bound turned that into
// a daily page for four days.
//
// THE FAILURE RATE WATCH IS ARMED AGAIN (#2513, 2026-10-01). It was parked by
// #2499 because the smoke canary can never reach its floor (the outcome mix read
// passes `p_include_test: false`, #1637), so it could only conclude once real Low
// leads booked. The Low pilot went live on 2026-09-29, 82 real leads booked
// through the production site on 2026-10-01 alone, and the detector stamped a
// verdict on the monitor tick of 2026-10-01 13:51 UTC. The park's reason stopped
// being true, so the entry came out, as the truth probe's did in #1831.
//
// So the shipped registry is EMPTY again, and every rule below is driven through
// a synthetic entry. A mechanism whose every test rode on the one live entry would
// break silently the day that entry went (L535, L29), which is this day.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-detector-park.ts
import { VERDICT_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import {
  AVAILABILITY_TRUTH_VERDICT_LANE,
  FAILURE_RATE_VERDICT_LANE,
  LOW_VOLUME_VERDICT_LANE,
  OOO_PROTECTION_VERDICT_LANE,
  PARKED_VERDICT_DETECTORS,
  REGAL_CALLS_VERDICT_LANE,
  parkedDetector,
  detectorParkState,
} from "../src/lib/monitor/verdict-freshness.ts";
import { SHIPPED_FAILURE_RATE_THRESHOLDS } from "../src/lib/monitor/failure-rate-thresholds.ts";
import {
  verdictParkedInfoText,
  verdictUnparkAlertText,
  verdictUnparkLapsedText,
  verdictUnparkRecoveryText,
} from "../src/lib/monitor/lane-copy.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

// --- the registry is a declaration, not a shrug --------------------------------
// Every parked detector has to say why it cannot conclude and name the issue that
// arms it again. Without the issue the park is a note to nobody: #1459 already
// made the same rule for a deliberately unsubscribed webhook event, for the same
// reason, and the guard there rejects an entry with no issue number.
/**
 * A park entry that is not in the shipped registry, so the rules below are driven
 * even while nothing is really parked. It borrows a REAL lane so the bound lookup
 * it is checked against is a real one.
 */
const FIXTURE_LANE = FAILURE_RATE_VERDICT_LANE;
const FIXTURE_REGISTRY = {
  [FIXTURE_LANE]: {
    reason:
      "a synthetic entry, so the park mechanism is exercised while the shipped registry is empty",
    issue: 2484,
    unparkWithinMs: 60 * 60_000,
  },
};

{
  const lanes = Object.keys(PARKED_VERDICT_DETECTORS);
  // Deliberately allowed to be empty: see the header. What every entry must
  // SATISFY is what is under test, and the fixture below drives those rules when
  // the shipped registry has nothing in it.
  for (const lane of [...lanes]) {
    assert(
      lane in VERDICT_STALE_BOUNDS_MS,
      `${lane} is parked but is not a watched verdict lane, so the park does nothing`,
    );
    const entry = PARKED_VERDICT_DETECTORS[lane as keyof typeof PARKED_VERDICT_DETECTORS];
    assert(!!entry, `${lane} has an entry`);
    assert(
      (entry?.reason.length ?? 0) > 30,
      `${lane} says why it cannot conclude, in a sentence a reader can act on`,
    );
    assert(
      Number.isInteger(entry?.issue) && (entry?.issue ?? 0) > 0,
      `${lane} names the issue that arms it again`,
    );
    assert(!DASHES.test(entry?.reason ?? ""), `${lane}'s reason has no dashes`);

    // #1562: the freshness that counts as "this detector is concluding NOW", and
    // it must be TIGHTER than the blindness bound it sits inside. Reusing that
    // bound is what shipped the defect this replaces: for the failure rate check
    // it meant "concluded at some point in the last four days", which a single
    // two minute coincidence in the smoke canary satisfies, so one accidental
    // verdict held a daily page open for four days.
    const bound = VERDICT_STALE_BOUNDS_MS[lane];
    assert(
      Number.isInteger(entry?.unparkWithinMs) && (entry?.unparkWithinMs ?? 0) > 0,
      `${lane} says how fresh a verdict has to be to end its park`,
    );
    assert(
      (entry?.unparkWithinMs ?? Infinity) < bound,
      `${lane}'s un-park window (${entry?.unparkWithinMs}ms) must be tighter than its ` +
        `blindness bound (${bound}ms), or it means "concluded at some point" rather than ` +
        `"concluding now"`,
    );
  }

  // #2513. The failure rate watch is ARMED: real Low leads are booking, so it
  // concludes on essentially every tick. Asserting it parked would defend a
  // decision that has been reversed (L252).
  assert(
    !parkedDetector(FAILURE_RATE_VERDICT_LANE),
    "the failing bookings verdict watch is armed now that real Low leads book through Slate (#2513)",
  );

  // The shape rules, driven through the fixture so they are exercised rather than
  // vacuous: an empty registry satisfies a `for` loop over it perfectly.
  const fixture = parkedDetector(FIXTURE_LANE, FIXTURE_REGISTRY);
  assert(!!fixture, "the fixture registry really parks its lane");
  assert((fixture?.reason.length ?? 0) > 30, "and its reason is a sentence a reader can act on");
  assert(
    (fixture?.unparkWithinMs ?? Infinity) < VERDICT_STALE_BOUNDS_MS[FIXTURE_LANE],
    "and its un-park window is tighter than the blindness bound it sits inside",
  );

  // And the ones that CAN conclude are not, because parking a working detector
  // would take a live safety net off and look identical to this.
  //
  // The truth probe is here rather than above since #1831. Its park said the
  // roster was dark, so the bucket it picks each tick offers no times to check,
  // and the 2026-09-02 roster flip (#1739) ended that: 57 of the 60 non test
  // buckets are offering times, and on 2026-09-07 it stamped a verdict on two
  // consecutive monitor ticks, in lockstep with the time off check that concludes
  // on every readable tick. A park whose reason has expired is a safety net left
  // off for a condition that no longer holds, which is the #1394 defect this whole
  // family exists to catch.
  assert(
    !parkedDetector(AVAILABILITY_TRUTH_VERDICT_LANE),
    "the truth probe concludes on essentially every tick since the roster flip, so it is armed (#1831)",
  );
  assert(
    !parkedDetector(LOW_VOLUME_VERDICT_LANE),
    "the low volume check concludes on every in-hours tick, so it stays armed",
  );
  assert(
    !parkedDetector(OOO_PROTECTION_VERDICT_LANE),
    "the time off protection check concludes whenever the database is readable, so it stays armed",
  );
  assert(
    !parkedDetector(REGAL_CALLS_VERDICT_LANE),
    "Regal's reporting webhook has pointed at Slate since 2026-09-24 and human calls arrive every few seconds, so the Regal calls detector is armed (#2695)",
  );
}

// --- three states, and the one that ends the park ------------------------------
{
  const window = FIXTURE_REGISTRY[FIXTURE_LANE]!.unparkWithinMs;
  const bound = VERDICT_STALE_BOUNDS_MS[FIXTURE_LANE];

  // An unparked lane is never touched by any of this, whatever its stamp says.
  // The truth probe is one of these since #1831, which is the whole change: a
  // detector holding a fresh verdict must read as ARMED rather than as asking to
  // be armed, or the page that asked never ends.
  for (const lane of [
    LOW_VOLUME_VERDICT_LANE,
    OOO_PROTECTION_VERDICT_LANE,
    AVAILABILITY_TRUTH_VERDICT_LANE,
    // Armed again since #2513, after being parked between #2499 and 2026-10-01.
    FAILURE_RATE_VERDICT_LANE,
  ]) {
    for (const stamp of [null, NOW, NOW - 10 * bound, 0]) {
      assert(
        detectorParkState(lane, stamp, NOW) === "armed",
        `an unparked detector (${lane}) is armed regardless of its stamp`,
      );
    }
  }

  // Parked and blind, which is the whole point: no page.
  assert(
    detectorParkState(FIXTURE_LANE, null, NOW, FIXTURE_REGISTRY) === "parked",
    "a parked detector that has never concluded stays parked",
  );
  assert(
    detectorParkState(FIXTURE_LANE, NOW - 10 * bound, NOW, FIXTURE_REGISTRY) === "parked",
    "a parked detector whose last verdict has aged out stays parked",
  );

  // An unreadable stamp (the epoch-0 sentinel, #1172) is NOT evidence of a
  // verdict. Reading it as one would un-park a detector off a corrupt record.
  assert(
    detectorParkState(FIXTURE_LANE, 0, NOW, FIXTURE_REGISTRY) === "parked",
    "an unreadable verdict record does not un-park anything",
  );

  // The state that ends the park. A parked detector reaching a verdict means the
  // reason it was parked has stopped being true, and holding it parked past that
  // is how the safety net stays off after the cutover it was waiting for. This is
  // not hypothetical any more: it is exactly what happened to the truth probe on
  // 2026-09-03, and it is why that lane is armed above rather than parked here.
  assert(
    detectorParkState(FIXTURE_LANE, NOW - 1, NOW, FIXTURE_REGISTRY) === "unpark",
    "a parked detector that has just concluded asks to be armed again",
  );
  assert(
    detectorParkState(FIXTURE_LANE, NOW - window + 1, NOW, FIXTURE_REGISTRY) === "unpark",
    "a verdict inside the un-park window counts, right up to the edge",
  );

  // #1562. A verdict that has aged past the un-park window is NOT evidence the
  // detector is concluding, even while it sits comfortably inside the blindness
  // bound. Judging it against that bound instead is what production did: the
  // failure rate check concluded once, at 2026-08-29T01:25Z, off two smoke canary
  // passes landing inside one hour, and then concluded nothing for the next two
  // and a half days while a daily page asked for it to be armed.
  assert(
    detectorParkState(FIXTURE_LANE, NOW - window - 1, NOW, FIXTURE_REGISTRY) === "parked",
    "a verdict older than the un-park window leaves the park standing",
  );
  assert(
    bound > 2.5 * 24 * HOUR,
    "the blindness bound really is wide enough to have covered that stale verdict",
  );
  assert(
    detectorParkState(FIXTURE_LANE, NOW - 2.5 * 24 * HOUR, NOW, FIXTURE_REGISTRY) === "parked",
    "the measured production case (a verdict 2.5 days old, bound 4 days) stays parked",
  );
}

// --- the un-park window for the failure rate check, if it is ever parked again --
// The decision #2499 made is still the one to copy: the window that counts as
// "concluding now" is the check's OWN rolling window, read from the shipped
// thresholds rather than restated (L63). Driven through a fixture built the same
// way, so the rule survives the shipped entry's removal.
{
  const shippedWindow = SHIPPED_FAILURE_RATE_THRESHOLDS.windowMs;
  const bound = VERDICT_STALE_BOUNDS_MS[FAILURE_RATE_VERDICT_LANE];
  const registry = {
    [FAILURE_RATE_VERDICT_LANE]: {
      reason: "a synthetic park built the way #2499 built the real one, from the shipped window",
      issue: 2513,
      unparkWithinMs: shippedWindow,
    },
  };
  assert(
    bound > shippedWindow,
    "the blindness bound is wider than the check's own window, so a stale verdict can sit inside it",
  );
  assert(
    detectorParkState(FAILURE_RATE_VERDICT_LANE, NOW - shippedWindow - 1, NOW, registry) === "parked",
    "a verdict older than the check's own window would leave such a park standing",
  );
  assert(
    detectorParkState(FAILURE_RATE_VERDICT_LANE, NOW - 5 * 60_000, NOW, registry) === "unpark",
    "and a verdict from one monitor tick ago would end it",
  );
}

// --- the bound's reasoning names the constant, never the numbers (#2499) --------
// `health.ts` carried "20 attempts inside a rolling hour" for three weeks after
// #2484 made it 10 in four. A sentence restating a constant is a second copy of it
// that nothing compares (L63), and this bound's own comment is the place a reader
// goes to understand why four days is right.
{
  const health = readFileSync(
    join(import.meta.dirname, "..", "src", "lib", "monitor", "health.ts"),
    "utf8",
  );
  assert(
    health.includes("failure-rate-thresholds"),
    "the bound's reasoning points at the module the floor and the window really live in",
  );
  assert(
    !/\d+\s+attempts/.test(health),
    "and it does not restate the floor as a number, which is what went stale",
  );
  assert(
    !/rolling hour/.test(health),
    "nor the window, which moved to four hours in #2484 and left the sentence behind",
  );
}

// --- the park is visible, and says how it ends ---------------------------------
{
  const parked = Object.keys(PARKED_VERDICT_DETECTORS);
  // The SHIPPED whisper, rendered from the shipped registry whenever anything is in
  // it: this is the message a person really reads while a safety net is off. The
  // registry is empty since #2513, which is allowed, so the shipped half only runs
  // while something is parked and the fixture below carries the coverage.
  if (parked.length > 0) {
    const shippedInfo = verdictParkedInfoText(parked);
    for (const lane of parked) {
      const entry = PARKED_VERDICT_DETECTORS[lane as keyof typeof PARKED_VERDICT_DETECTORS];
      assert(
        shippedInfo.includes(entry?.reason ?? "no entry"),
        `the whisper carries ${lane}'s reason`,
      );
      assert(
        shippedInfo.includes(`#${entry?.issue}`),
        `the whisper names the issue that arms ${lane}`,
      );
    }
    assert(!/\bundefined\b/.test(shippedInfo), "the shipped whisper renders no missing value");
    assert(!DASHES.test(shippedInfo), "and it carries no dashes either");
  }

  // The same call driven through the FIXTURE, so the rendering stays exercised for a
  // lane this file controls: the shipped entry is temporary by design and its removal
  // must not take the mechanism's coverage with it (L535).
  const info = verdictParkedInfoText([FIXTURE_LANE], FIXTURE_REGISTRY);
  assert(info.length > 120, "the whisper says what is off, not just that something is");
  assert(!DASHES.test(info), "the whisper has no dashes");
  assert(
    !/^Slate\b/.test(info),
    "the whisper does not open by repeating the app name Slack already shows",
  );

  // A parked detector reaching a verdict is good news that needs an edit, so the
  // page has to name the file as well as the fact.
  //
  // Every message here is built for a lane that is REALLY parked, and since #1831
  // that is the failure rate check rather than the truth probe. Asking for the
  // truth probe's un-park copy now would compare "#undefined" against
  // "#undefined": the copy reads the registry through an optional chain, so both
  // sides of the assertion go missing together and it passes while proving nothing
  // (L1, L70). The explicit no-undefined check below is what keeps that from
  // coming back the next time a lane is armed.
  // It is rendered through the FIXTURE registry as well as the shipped one, so the
  // copy stays covered on the day the shipped entry goes away again.
  for (const lane of parked) {
    const shippedAlert = verdictUnparkAlertText(lane);
    assert(/reached a verdict/i.test(shippedAlert), "the shipped page says what changed");
    assert(
      shippedAlert.includes(`#${PARKED_VERDICT_DETECTORS[lane as keyof typeof PARKED_VERDICT_DETECTORS]?.issue}`),
      "and names the issue that takes the park back out",
    );
    assert(!/\bundefined\b/.test(shippedAlert), "and renders no missing value");
    assert(!DASHES.test(shippedAlert), "and carries no dashes");
  }

  const alert = verdictUnparkAlertText(FIXTURE_LANE, FIXTURE_REGISTRY);
  assert(/reached a verdict/i.test(alert), "the page says what changed");
  assert(
    alert.includes(`#${FIXTURE_REGISTRY[FIXTURE_LANE]!.issue}`),
    "the page names the issue that arms it",
  );
  assert(!DASHES.test(alert), "the un-park page has no dashes");
  assert(
    new Set(parked.map((l) => verdictUnparkAlertText(l))).size === parked.length,
    "each detector's un-park page describes that detector",
  );

  // Every message this file renders is read by a person, so none of them may carry
  // a missing value. This is also the guard on the assertion above: it is the half
  // that cannot be satisfied by the registry lookup and the copy failing together.
  for (const [what, text] of [
    ["the parked whisper", info],
    ["the un-park page", alert],
  ] as const) {
    assert(!/\bundefined\b/.test(text), `${what} renders no missing value`);
  }

  const recovery = verdictUnparkRecoveryText(FIXTURE_LANE);
  assert(/no action is needed/i.test(recovery), "the all-clear closes the loop");
  assert(!DASHES.test(recovery), "the un-park all-clear has no dashes");

  // #1562: the un-park page has TWO endings, and only one of them is "somebody
  // armed it". The other is the detector going quiet again, which is what a
  // coincidence in the canary looks like an hour later. Before this they shared
  // one all-clear, so a lapsed park would have announced that the detector was
  // armed and being watched when it was neither (L11).
  const lapsed = verdictUnparkLapsedText(FIXTURE_LANE, FIXTURE_REGISTRY);
  assert(lapsed !== recovery, "the two endings of an un-park page are different messages");
  // The claim, not the word. "Nothing was armed" is the sentence this ending needs;
  // what it must never carry is the armed all-clear's assertion that the detector
  // is now on and being watched, which is what sharing one message would have said.
  assert(
    !/is armed|being watched/i.test(lapsed),
    "the lapsed all-clear must not claim the detector is armed or watched, because it is neither",
  );
  assert(
    /nothing was armed/i.test(recovery) === false && /nothing was armed/i.test(lapsed),
    "the lapsed all-clear says outright that nobody armed anything, and its sibling does not",
  );
  assert(
    /parked/i.test(lapsed),
    "the lapsed all-clear says the park is still standing, which is the state it leaves behind",
  );
  assert(/no action is needed/i.test(lapsed), "the lapsed all-clear closes the loop");
  assert(!DASHES.test(lapsed), "the lapsed all-clear has no dashes");
  assert(!/^Slate\b/.test(lapsed), "the lapsed all-clear does not open with the app name");
}

// --- built is not wired (L3) ---------------------------------------------------
// Every assertion above holds if the watchdog never consults any of it, and the
// symptom would be the exact daily page this issue is about, with a green suite.
{
  const src = readFileSync(
    join(import.meta.dirname, "..", "src", "lib", "monitor", "lane-watchdog.ts"),
    "utf8",
  );
  // Strip comments first: a check satisfied by a comment ABOUT the call, including
  // one explaining it was removed, is indistinguishable from one that works (L103).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(code.includes("detectorParkState("), "the watchdog asks for each detector's park state");
  assert(
    code.includes("verdictParkedInfoText(") && code.includes("verdictUnparkAlertText("),
    "the watchdog speaks both halves: the park is visible and the un-park pages",
  );
  assert(
    code.includes("verdictUnparkRecoveryText("),
    "the un-park page can end, which is what makes it a condition rather than noise",
  );
  assert(
    code.includes("verdictUnparkLapsedText("),
    "the un-park page's OTHER ending is wired too, or a lapsed park pages forever (#1562)",
  );
}

finish();
