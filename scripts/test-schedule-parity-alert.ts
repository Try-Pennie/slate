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
  pagingLabel,
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
        total: 160,
        compared: 95,
        findings: [
          { verdict: "days-differ", count: 6, agents: ["forellana@x", "jarias@x"] },
          { verdict: "hours-differ", count: 6, agents: ["z@x"] },
        ],
      }),
    ),
  );
  // It said "12 of 160 agents differ", and 160 is everybody either roster names,
  // departed users and staff included, so it understated the drift among the
  // agents a lead can be booked with. It cannot divide by the compared count
  // either: a roster finding (somebody who left and still hosts) is about a person
  // outside it. So it gives the count, then the scale, and makes no ratio.
  eq(
    text.split("\n")[0],
    "12 agents differ between Slate and cal.com. 95 bookable agents were compared.",
    "it leads with how many differ, then how many were compared",
  );
  assert(!/160/.test(text), "it does not divide by everybody either roster names");
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

// --- what the lane corrected itself (#2092) ---------------------------------------
//
// The daily lane re-imports drifted hours from cal.com before it sweeps, so the
// message has to say what it wrote. Two reasons it is not cosmetic. A reader who
// is told 4 agents differ and is not told the lane already fixed 17 has no idea
// whether this is a system holding steady or one falling apart. And the remedy
// line that used to say "re-import the hours" is advice that cannot work once the
// lane has just run that import: naming a command whose only effect is to repeat
// what already happened is a dead instruction (L111).
{
  const applied = classifyParitySweep(
    sweep({
      compared: 102,
      findings: [{ verdict: "hours-differ", count: 4, agents: ["a@x"] }],
      corrected: { count: 17, agents: ["b@x", "c@x"] },
    }),
  );
  const text = buildScheduleParityAlert(applied);
  assert(/17/.test(text), "the page says how many the lane corrected by itself");
  assert(/b@x/.test(text), "and names them, so the reader can check what was written to whom");
  assert(
    !/APPLY=1/.test(text),
    "and does NOT tell the reader to run the import the lane just ran (L111)",
  );
  assert(!/undefined|NaN|\[object/.test(text), "nothing leaks into the corrected line");
  assert(!/[\u2014\u2013]/.test(text), "no dashes as punctuation");
}
{
  // The lane did not apply at all: the apply step crashed, or somebody ran the
  // sweep by hand. `corrected` is ABSENT rather than zero, because those are
  // different facts and the remedy depends on which one it is. Absent keeps the
  // old instruction, since re-importing really is the fix and nothing has tried it.
  const text = buildScheduleParityAlert(
    classifyParitySweep(sweep({ findings: [{ verdict: "hours-differ", count: 4, agents: ["a@x"] }] })),
  );
  assert(
    /APPLY=1/.test(text),
    "with no apply reported, the page still names the command that fixes it",
  );
}
{
  // The lane applied and found nothing to write. That is a real and different
  // fact from not having applied, and it must not silently read as the latter:
  // it is the ordinary healthy morning, and the remedy line still has to go,
  // because the import HAS run and repeating it changes nothing.
  const text = buildScheduleParityAlert(
    classifyParitySweep(
      sweep({
        findings: [{ verdict: "hours-differ", count: 4, agents: ["a@x"] }],
        corrected: { count: 0, agents: [] },
      }),
    ),
  );
  assert(
    !/APPLY=1/.test(text),
    "a lane that applied and wrote nothing still does not tell the reader to run the import",
  );
  assert(
    /could not/.test(text) || /left/.test(text),
    `it says the import ran and did not fix these instead (${text})`,
  );
}
{
  // The all clear carries it too. A morning where the lane corrected twenty agents
  // and everything now agrees is NOT the same event as a morning where nothing had
  // drifted, and a message that renders both identically hides the whole thing the
  // lane is doing (L680).
  const clear = buildScheduleParityAllClear(
    classifyParitySweep(sweep({ corrected: { count: 20, agents: ["b@x"] } })),
  );
  assert(/20/.test(clear), "the all clear says how many the lane corrected on the way");
  const quiet = buildScheduleParityAllClear(classifyParitySweep(sweep()));
  assert(!/corrected/.test(quiet), "and a morning with nothing to correct does not mention it");
}
{
  // Over the wire, `corrected` is as untrusted as everything else the runner
  // sends: it is rendered into a message somebody reads on a phone and acts on.
  const good = parseParitySweep({
    total: 102,
    compared: 102,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: [],
    corrected: { count: 3, agents: ["a@x", "b@x"] },
  });
  assert(!("error" in good), "a well formed corrected block is accepted");
  if (!("error" in good)) eq(good.corrected?.count, 3, "and its count is carried");

  const absent = parseParitySweep({
    total: 102,
    compared: 102,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: [],
  });
  assert(!("error" in absent), "and it stays optional, so a hand run sweep is still accepted");
  if (!("error" in absent)) {
    eq(absent.corrected, undefined, "an absent block is absent, never a zero standing in for it");
  }

  const nonsense = parseParitySweep({
    total: 102,
    compared: 102,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: [],
    corrected: { count: -1, agents: [] },
  });
  assert("error" in nonsense, "a count that is not a count is refused rather than rendered");

  const impossible = parseParitySweep({
    total: 10,
    compared: 10,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: [],
    corrected: { count: 99, agents: [] },
  });
  assert(
    "error" in impossible,
    "and a lane claiming to have corrected more agents than it looked at is refused",
  );
}

// --- bookable in Slate and in no routing pool (#3963) -----------------------------
// tgill@ on 2026-10-20: bookable, {"role":"Sales"} only, no pool reaches them. The
// page said "Slate offers" them, which was false, and pointed nowhere useful.
{
  eq(PARITY_VERDICT_CLASS["bookable-in-no-pool"], "paging", "somebody bookable whom Slate offers nobody pages");
  const text = buildScheduleParityAlert(
    classifyParitySweep(sweep({ findings: [{ verdict: "bookable-in-no-pool", count: 1, agents: ["tgill@"] }] })),
  );
  assert(!/Slate offers/.test(text), `the page does not claim Slate offers them (${text})`);
  assert(/neither system offers them: tgill@$/m.test(text), `it names them (${text})`);
  assert(/Twilio/.test(text) && /debt tier/.test(text), `and says the fix is their debt tier in Twilio (${text})`);
  const other = buildScheduleParityAlert(
    classifyParitySweep(sweep({ findings: [{ verdict: "bookable-not-hosting", count: 1, agents: ["x@"] }] })),
  );
  assert(/Slate offers/.test(other), "an agent a pool does reach still reads as Slate offering them");
  assert(!/Twilio/.test(other), "and is not sent to Twilio, which would not fix it");

  // Routed by cal.com and in no Slate pool: the same fix, different words.
  eq(PARITY_VERDICT_CLASS["in-no-pool-still-routed"], "paging", "routed by cal.com and offered by no Slate pool pages");
  const routed = buildScheduleParityAlert(
    classifyParitySweep(sweep({ findings: [{ verdict: "in-no-pool-still-routed", count: 2, agents: ["a@", "b@"] }] })),
  );
  assert(/^2 are bookable in Slate and in no routing pool while cal\.com still routes them leads: a@, b@$/m.test(routed), `it says cal.com routes them (${routed})`);
  assert(!/neither system/.test(routed), "and never that neither system offers them");
  assert(/Twilio/.test(routed) && /debt tier/.test(routed), `and names the fix (${routed})`);
}

{
  // A sweep reporting EVERY verdict at once is accepted, so adding a verdict can
  // never push a real sweep over the findings cap and get the whole payload
  // refused. The cap was a literal 20 while the vocabulary grew to 19 (#3963).
  const every = Object.keys(PARITY_VERDICT_CLASS).map((verdict) => ({ verdict, count: 1, agents: ["a@x"] }));
  const parsed = parseParitySweep({
    total: 102,
    compared: 100,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: every,
  });
  assert(!("error" in parsed), `a sweep carrying every verdict once is accepted (${JSON.stringify(parsed).slice(0, 80)})`);
  const doubled = parseParitySweep({
    total: 102,
    compared: 100,
    runUrl: "https://github.com/x/y/actions/runs/1",
    findings: [...every, every[0]],
  });
  assert("error" in doubled, "and one carrying even one more finding than there are verdicts is refused");
}

// --- one agent reads as one agent (#3963) -----------------------------------------
//
// The 2026-10-20 page said "1 agent were corrected from cal.com automatically": the
// noun was counted and the verb was not. Every sentence here that puts a count in
// front of a verb is driven at one AND at many, so a hard coded plural cannot come
// back in any of them.
{
  const one = buildScheduleParityAlert(
    classifyParitySweep(
      sweep({
        findings: [
          { verdict: "hours-differ", count: 1, agents: ["a@x"] },
          { verdict: "calcom-unreachable", count: 1, agents: ["r@x"] },
        ],
        corrected: { count: 1, agents: ["b@x"] },
      }),
    ),
  );
  assert(/^1 agent was corrected from cal\.com automatically: b@x\.$/m.test(one), `one correction says was (${one})`);
  assert(!/1 agent were/.test(one), "and never were");
  assert(/^1 agent differs between Slate and cal\.com\. 102 bookable agents were compared\.$/m.test(one), `one difference says differs (${one})`);
  assert(/^1 works different hours: a@x$/m.test(one), `one agent works, not work (${one})`);
  const oneCompared = buildScheduleParityAlert(
    classifyParitySweep(sweep({ compared: 1, findings: [{ verdict: "hours-differ", count: 1, agents: ["a@x"] }] })),
  );
  assert(/ 1 bookable agent was compared\.$/m.test(oneCompared), `one compared says was (${oneCompared})`);
  assert(/could not fix this one, so it needs a person/.test(one), `the remedy speaks of one (${one})`);

  const many = buildScheduleParityAlert(
    classifyParitySweep(
      sweep({
        findings: [{ verdict: "hours-differ", count: 6, agents: ["a@x"] }],
        corrected: { count: 17, agents: ["b@x"] },
      }),
    ),
  );
  assert(/^17 agents were corrected from cal\.com automatically/m.test(many), `many corrections say were (${many})`);
  assert(/^6 agents differ between Slate and cal\.com\. 102 bookable agents were compared\.$/m.test(many), `many differences say differ (${many})`);
  assert(/^6 work different hours: a@x and 5 more$/m.test(many), `many agents work (${many})`);
  assert(/could not fix these, so they need a person/.test(many), `and of many (${many})`);

  const clearOne = buildScheduleParityAllClear(
    classifyParitySweep(
      sweep({
        findings: [{ verdict: "no-calcom-schedule", count: 1, agents: ["s@x"] }],
        corrected: { count: 1, agents: ["b@x"] },
      }),
    ),
  );
  assert(/^1 agent was corrected from cal\.com automatically/m.test(clearOne), `the all clear says was too (${clearOne})`);
  assert(/^1 has no week in cal\.com to compare\.$/m.test(clearOne), `one standing agent has (${clearOne})`);

  const clearMany = buildScheduleParityAllClear(
    classifyParitySweep(sweep({ findings: [{ verdict: "no-calcom-schedule", count: 2, agents: ["s@x"] }] })),
  );
  assert(/^2 have no week in cal\.com to compare\.$/m.test(clearMany), `many standing agents have (${clearMany})`);
}
{
  // The all clear of 2026-10-21, at its real counts. It said "95 of 160 agents
  // compared" and "21 still have no week to compare on one side", and both misled:
  // 160 is everybody either roster names (departed and staff included), every one
  // of the 95 bookable agents had a week on both sides, and the 21 were three
  // different things, none of them a missing week. So the denominator goes, and
  // each standing verdict is said in its own words.
  const clear = buildScheduleParityAllClear(
    classifyParitySweep(
      sweep({
        total: 160,
        compared: 95,
        findings: [
          { verdict: "hours-set-by-agent", count: 10, agents: ["a@x"] },
          { verdict: "staff-not-bookable", count: 10, agents: ["m@x"] },
          { verdict: "known-not-in-slate", count: 1, agents: ["k@x"] },
        ],
      }),
    ),
  );
  eq(
    clear,
    [
      "Both systems agree again: 95 agents compared, 85 identical.",
      "10 keep hours they set themselves, which the import leaves alone.",
      "Not compared, as expected: 10 managers or admins who host in cal.com, 1 cal.com host who is not in Slate.",
    ].join("\n"),
    "the 2026-10-21 all clear names each standing group for what it is",
  );
  assert(!/160/.test(clear), "it does not divide by everybody either roster names");

  const nothingOwn = buildScheduleParityAllClear(classifyParitySweep(sweep({ compared: 95 })));
  eq(nothingOwn, "Both systems agree again: 95 agents compared, no differences.", "a morning with nothing standing stays one line");

  // At one, each count picks its own verb.
  const one = buildScheduleParityAllClear(
    classifyParitySweep(
      sweep({
        compared: 95,
        findings: [
          { verdict: "hours-set-by-agent", count: 1, agents: ["a@x"] },
          { verdict: "staff-not-bookable", count: 1, agents: ["m@x"] },
        ],
      }),
    ),
  );
  assert(/^1 keeps hours they set themselves, which the import leaves alone\.$/m.test(one), `one own week keeps (${one})`);
  assert(/1 manager or admin who hosts in cal\.com\.$/m.test(one), `one staff host hosts (${one})`);

  // An agent the sweep lost is said, not dropped: the all clear may only claim the
  // ones it compared (L98).
  const lost = buildScheduleParityAllClear(
    classifyParitySweep(sweep({ compared: 93, findings: [{ verdict: "calcom-unreachable", count: 2, agents: ["u@x"] }] })),
  );
  assert(/^2 could not be read, so nothing is claimed about them\.$/m.test(lost), `unread agents are said (${lost})`);
}
{
  // Every standing verdict has its own words in the all clear, at one and at many.
  // Driven off the classification, so a standing verdict added tomorrow cannot fall
  // into a lump with somebody else's reason, which is the 2026-10-21 defect.
  const standing = Object.entries(PARITY_VERDICT_CLASS)
    .filter(([, cls]) => cls === "standing")
    .map(([v]) => v);
  const said = new Map<string, string>();
  for (const v of standing) {
    const clear = buildScheduleParityAllClear(
      classifyParitySweep(sweep({ findings: [{ verdict: v, count: 1, agents: ["s@x"] }] })),
    );
    const twin = said.get(clear);
    assert(twin === undefined, `${v} reads differently from ${twin} (${clear})`);
    said.set(clear, v);
  }
  for (const v of standing) {
    for (const count of [1, 2]) {
      const clear = buildScheduleParityAllClear(
        classifyParitySweep(sweep({ findings: [{ verdict: v, count, agents: ["s@x"] }] })),
      );
      assert(!clear.includes(v), `${v} at ${count} is said in words, not its name (${clear})`);
      assert(new RegExp(`(^|[:,] )${count} `, "m").test(clear), `${v} at ${count} is counted (${clear})`);
      assert(!/undefined|NaN/.test(clear), `${v} at ${count} leaks nothing (${clear})`);
    }
  }
}
{
  // Every paging verdict reads correctly at one. Driven off the classification
  // rather than a list written here, so a verdict added tomorrow is held to it too.
  const paging = Object.entries(PARITY_VERDICT_CLASS)
    .filter(([, cls]) => cls === "paging")
    .map(([v]) => v);
  const expectedOne: Record<string, string> = {
    "departed-still-hosting": "1 has left Slate and can still be booked in cal.com",
    "timezone-differs": "1 is in a different timezone",
    "days-differ": "1 works different days",
    "hours-differ": "1 works different hours",
    "absent-from-slate": "1 hosts in cal.com and has no Slate record",
    "bookable-in-no-pool": "1 is bookable in Slate and in no routing pool, so neither system offers them",
    "in-no-pool-still-routed": "1 is bookable in Slate and in no routing pool while cal.com still routes them leads",
  };
  for (const v of paging) {
    const one = pagingLabel(v, 1);
    const many = pagingLabel(v, 2);
    assert(one !== v && many !== v, `${v} has its own words at one and at many`);
    if (expectedOne[v]) eq(`1 ${one}`, expectedOne[v], `${v} at one`);
  }
}

finish();
