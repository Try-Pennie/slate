// The decision behind the daily cal.com parity alert (#2031). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-schedule-parity-alert.ts
//
// `pnpm verify:calcom-parity` is hand run, so it finds what it finds on the day
// somebody remembers. 97 schedules were imported on 2026-09-02 and verified
// idempotent the same day; five days later 21 of 102 agents had drifted, three of
// them not being offered a day they work. This is the scheduled version, and this
// file pins the two judgements a schedule cannot make for itself: which findings
// are worth waking somebody for, and when a quiet sweep has earned the right to
// say the drift is over.
import {
  parseParitySweep,
  classifyParitySweep,
  buildScheduleParityAlert,
  buildScheduleParityAllClear,
  PARITY_VERDICT_CLASS,
  type ParitySweep,
} from "@/lib/monitor/schedule-parity-alert";
import { ROSTER_VERDICT_RANK } from "./lib/roster-parity.ts";
import { VERDICT_RANK } from "./lib/schedule-parity.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A sweep with nothing in it, so each case below states only what it is about. */
function sweep(over: Partial<ParitySweep> = {}): ParitySweep {
  return { total: 102, compared: 102, findings: [], runUrl: "https://run", ...over };
}

// --- every verdict is classified, exactly once ----------------------------------
// Enumerated from what the two halves PRODUCE, not from the outcomes that can fail
// a run. Those are different sets, and keying on the second is what shipped the
// check inert: `staff-not-bookable` is deliberately absent from `OUTCOME_ORDER`
// (nine admins and managers host in cal.com and are correctly not bookable in
// Slate, so an exit code for them would fail every run forever), and a table built
// from that union therefore had no entry for the one verdict most of the roster
// carries. The sweep sent it, the endpoint refused the whole payload, and every
// daily run would have reported nothing while looking configured (L96, L129).
{
  const produced = [...Object.keys(ROSTER_VERDICT_RANK), ...Object.keys(VERDICT_RANK)].filter(
    (v) => v !== "agree",
  );
  for (const v of produced) {
    assert(v in PARITY_VERDICT_CLASS, `${v} is classified`);
  }
  for (const v of Object.keys(PARITY_VERDICT_CLASS)) {
    assert(produced.includes(v), `${v} is a verdict something actually produces`);
  }
}

// --- the shape that shipped the check inert ---------------------------------------
// The live sweep on 2026-09-07 carried nine of these, and the endpoint refused the
// whole payload over them. A run that agrees on everything except the staff who are
// correctly not bookable must be accepted, and must still clear.
{
  const accepted = parseParitySweep({
    total: 111,
    compared: 100,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: [{ verdict: "staff-not-bookable", count: 9, agents: ["admin@x"] }],
  });
  assert(!("error" in accepted), "a sweep carrying the quiet verdict is accepted, not refused");
  if (!("error" in accepted)) {
    const j = classifyParitySweep(accepted);
    eq(j.action, "all-clear", "and nine deliberately quiet rows still leave the sweep healthy");
    eq(j.standing, 9, "counted, so the roster can be read in full");
  }
}

// --- what pages ------------------------------------------------------------------
{
  const d = classifyParitySweep(sweep({ findings: [{ verdict: "days-differ", count: 6, agents: ["a@x"] }] }));
  eq(d.action, "page", "a day difference changes what a lead is offered, so it pages");

  const z = classifyParitySweep(sweep({ findings: [{ verdict: "departed-still-hosting", count: 1, agents: ["b@x"] }] }));
  eq(z.action, "page", "somebody who has left and can still be booked pages");
}

// --- what never pages, however long it sits --------------------------------------
// cfrank@ and jsaminu@ have a cal.com schedule carrying no windows. Nothing will
// change that on its own, so a check that paged on it would be red every morning
// forever, and a permanently red check is one nobody reads by the second week (L36).
{
  const s = classifyParitySweep(
    sweep({ findings: [{ verdict: "no-calcom-schedule", count: 2, agents: ["cfrank@x", "jsaminu@x"] }] }),
  );
  eq(s.action, "all-clear", "a standing condition alone leaves the sweep healthy");
  assert(s.standing === 2, "and is still counted, so it is knowable");
}

// --- an all clear has to have measured something ---------------------------------
// A sweep that compared nobody is not a sweep that found nothing (L98). Both of
// these look identical in Slack unless the difference is made here.
{
  const nothing = classifyParitySweep(sweep({ compared: 0 }));
  eq(nothing.action, "unmeasured", "no agent compared is not an all clear");

  const blind = classifyParitySweep(
    sweep({ compared: 0, findings: [{ verdict: "calcom-unreachable", count: 102, agents: [] }] }),
  );
  eq(blind.action, "unmeasured", "a sweep cal.com refused outright is not an all clear");

  const partial = classifyParitySweep(
    sweep({ compared: 100, findings: [{ verdict: "calcom-unreachable", count: 2, agents: ["c@x"] }] }),
  );
  eq(partial.action, "all-clear", "two agents unread out of a hundred compared still clears");
  eq(partial.unmeasured, 2, "and says how many it could not read");
}

// --- the copy ---------------------------------------------------------------------
{
  const text = buildScheduleParityAlert(
    classifyParitySweep(
      sweep({
        findings: [
          { verdict: "days-differ", count: 6, agents: ["forellana@x", "jarias@x"] },
          { verdict: "hours-differ", count: 6, agents: ["z@x"] },
        ],
      }),
    ),
  );
  assert(/12 of 102/.test(text), "it leads with how many agents drifted out of how many");
  assert(/days/.test(text) && /hours/.test(text), "and names each kind of difference");
  assert(/forellana@x/.test(text), "and names agents so the reader can go and look");
  assert(!/^Slate/.test(text), "it does not open with the word Slate: Slack already says who sent it");
  assert(!/[\u2014\u2013]/.test(text), "no dashes as punctuation");
  assert(!/undefined|NaN|\[object/.test(text), "nothing leaks into the copy");

  const clear = buildScheduleParityAllClear(classifyParitySweep(sweep()));
  assert(/102/.test(clear), "the all clear says how many agents it actually compared");
  assert(!/^Slate/.test(clear), "the all clear does not open with the word Slate either");
}

// --- what the endpoint will accept -----------------------------------------------
// The sweep arrives over the wire from a GitHub runner holding the booking key, and
// the alert built from it is read on a phone. So the verdict is a vocabulary and not
// a text box (L611): a name outside the table is refused rather than passed through
// into copy, and the run link may only point at GitHub, because a clickable link in
// an alert is the one part a reader acts on without checking.
{
  const good = parseParitySweep({
    total: 102,
    compared: 100,
    runUrl: "https://github.com/Try-Pennie/slate/actions/runs/1",
    findings: [{ verdict: "hours-differ", count: 2, agents: ["a@x", "b@x"] }],
  });
  assert(!("error" in good), "a well formed sweep is accepted");

  const bad = parseParitySweep({
    total: 1,
    compared: 1,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: [{ verdict: "made-up", count: 1, agents: [] }],
  });
  assert("error" in bad, "a verdict outside the table is refused, never rendered");

  const offsite = parseParitySweep({
    total: 1,
    compared: 1,
    runUrl: "https://example.com/phish",
    findings: [],
  });
  assert("error" in offsite, "a run link that is not a GitHub run is refused");

  const overcounted = parseParitySweep({
    total: 5,
    compared: 9,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: [],
  });
  assert("error" in overcounted, "more agents compared than looked at cannot be true");

  const trimmed = parseParitySweep({
    total: 9,
    compared: 9,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: [
      { verdict: "days-differ", count: 9, agents: Array.from({ length: 50 }, (_, i) => `a${i}@x`) },
    ],
  });
  assert(!("error" in trimmed), "a long agent list is trimmed rather than refused");
  if (!("error" in trimmed)) {
    assert(trimmed.findings[0].agents.length <= 8, "and it is trimmed to something a phone can hold");
  }
}

finish();
