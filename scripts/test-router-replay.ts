// The router replay's judgement (#2240), driven offline with no network, no
// clock, and no database.
//
// What the command asks: cal.com has been routing every real lead for months, so
// for each one it recorded which agent it chose. Slate can be asked the same
// question about the same lead and the two answers compared. That is the only
// measurement of Slate's routing that exists before cutover, because Slate itself
// has routed nothing.
//
// What decides whether the measurement means anything is the BASELINE. With legal
// gone the big pools hold about 70 percent of the roster, so picking an agent at
// random agrees seven times in ten. Every case below therefore also pins the
// share, because an agreement rate with no baseline beside it is a number that
// cannot be read (L629).
//
// Run: node --experimental-strip-types scripts/test-router-replay.ts
import {
  classifyLead,
  prepareWorld,
  poolShare,
  summarise,
  replayOutcome,
  extractCode,
  freshBooking,
  splitBudget,
  BOOKING_STALE_MS,
  REPLAY_EXIT,
  type ReplayBucket,
  type ReplayLead,
  type ReplayUser,
} from "./lib/router-replay.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- A world small enough to reason about, shaped like the real matrix ---
//
// Codes are <debt tier><backend><legal>. `tierLadder("311")` walks 311, 211, 111,
// so a Medium lead can fall to Low. Everyone here is Achieve, which is what the
// real roster nearly all is.

const user = (over: Partial<ReplayUser> & { id: string; email: string }): ReplayUser => ({
  bookable: true,
  deactivated: false,
  isTest: false,
  attributes: {},
  ...over,
});

const USERS: ReplayUser[] = [
  user({ id: "u-high", email: "high@trypennie.com", attributes: { debt_team: ["high", "medium", "low"] } }),
  user({ id: "u-med", email: "med@trypennie.com", attributes: { debt_team: ["medium", "low"] } }),
  user({ id: "u-low", email: "low@trypennie.com", attributes: { debt_team: ["low"] } }),
  user({ id: "u-gone", email: "gone@trypennie.com", deactivated: true, attributes: { debt_team: ["high"] } }),
  user({ id: "u-held", email: "held@trypennie.com", bookable: false, attributes: { debt_team: ["high"] } }),
  user({ id: "u-admin", email: "admin@trypennie.com", attributes: { role: "Admin" } }),
  user({ id: "u-named", email: "named@trypennie.com", attributes: { role: "Sales" } }),
];

const BUCKETS: ReplayBucket[] = [
  { code: "111", criteria: { debt_team: "low" }, memberIds: [] },
  { code: "211", criteria: { debt_team: "medium" }, memberIds: [] },
  { code: "311", criteria: { debt_team: "high" }, memberIds: [] },
  { code: "411", criteria: { debt_team: "very_high" }, memberIds: [] },
  // Nobody matches, and nobody is named on it: the dead rung.
  { code: "511", criteria: { debt_team: "ultra_high" }, memberIds: [] },
];

const WORLD = prepareWorld({ users: USERS, buckets: BUCKETS });

const lead = (over: Partial<ReplayLead> = {}): ReplayLead => ({
  formId: "form-a",
  formName: "Completed Application Review",
  responseId: 1,
  createdAt: "2026-09-10T12:00:00.000Z",
  rawCode: "311",
  bookingUid: "uid-1",
  hostEmails: ["high@trypennie.com"],
  sampled: true,
  ...over,
});

// --- Agreement, and the two shapes it comes in ---

{
  const v = classifyLead(lead(), WORLD);
  eq(v.verdict, "agree", "the host is in the requested code's own pool");
  eq(v.effectiveCode, "311", "agreement is on the code the lead asked for");
  eq(v.rungsDropped, 0, "no rung was dropped");
}

{
  // The Medium agent can take a High lead only by Slate dropping a rung, which is
  // agreement of a weaker kind and must never be counted as the same thing.
  const v = classifyLead(lead({ hostEmails: ["med@trypennie.com"] }), WORLD);
  eq(v.verdict, "agree-via-ladder", "a host one rung down is agreement via the ladder");
  eq(v.effectiveCode, "211", "the rung that actually holds them is named");
  eq(v.rungsDropped, 1, "one rung was dropped");
}

{
  const v = classifyLead(lead({ hostEmails: ["low@trypennie.com"] }), WORLD);
  eq(v.rungsDropped, 2, "a host two rungs down is counted as two");
  eq(v.effectiveCode, "111", "and named by the rung that holds them");
}

{
  // The NEAREST rung wins. An agent who is in several pools must not be reported
  // as having dropped further than Slate would have gone.
  const v = classifyLead(lead({ rawCode: "311", hostEmails: ["high@trypennie.com"] }), WORLD);
  eq(v.rungsDropped, 0, "an agent in several pools is judged by the highest rung holding them");
}

// --- The pool is read per bucket, never as a union across buckets ---

{
  // Somebody named by hand on the Low bucket. They are in the Low pool and in no
  // other, so a High lead booked with them is a two rung drop and not agreement.
  // Reading a cross bucket union (`matchableAgentIds`) would call this `agree`,
  // which is the mistake #2240 names.
  const world = prepareWorld({
    users: USERS,
    buckets: BUCKETS.map((b) => (b.code === "111" ? { ...b, memberIds: ["u-named"] } : b)),
  });
  const high = classifyLead(lead({ rawCode: "311", hostEmails: ["named@trypennie.com"] }), world);
  eq(high.verdict, "agree-via-ladder", "a hand named Low member takes a High lead only via the ladder");
  eq(high.effectiveCode, "111", "on the bucket they are actually named on");

  const low = classifyLead(lead({ rawCode: "111", hostEmails: ["named@trypennie.com"] }), world);
  eq(low.verdict, "agree", "and is plain agreement on the bucket they are named on");

  // The other direction (L159): without the naming they are in no pool at all, so
  // the case above is about the member row rather than about their attributes.
  const bare = classifyLead(lead({ rawCode: "111", hostEmails: ["named@trypennie.com"] }), WORLD);
  eq(bare.verdict, "host-attributes-exclude", "with nobody naming them, no pool holds them");
}

// --- Every way a lead cannot be counted as agreement ---

{
  eq(
    classifyLead(lead({ hostEmails: ["stranger@example.com"] }), WORLD).verdict,
    "host-not-in-slate",
    "a host Slate has no user for",
  );
  eq(
    classifyLead(lead({ hostEmails: ["gone@trypennie.com"] }), WORLD).verdict,
    "host-departed",
    "a host who has left, even though their attributes still match",
  );
  eq(
    classifyLead(lead({ hostEmails: ["held@trypennie.com"] }), WORLD).verdict,
    "host-not-bookable",
    "a host Slate will not route to, even though their attributes still match",
  );
  eq(
    classifyLead(lead({ hostEmails: ["admin@trypennie.com"] }), WORLD).verdict,
    "host-attributes-exclude",
    "a bookable host no rung's criteria can match",
  );
  eq(
    classifyLead(lead({ hostEmails: [] }), WORLD).verdict,
    "host-unreadable",
    "a booking that named no host at all",
  );
  eq(
    classifyLead(lead({ hostEmails: null }), WORLD).verdict,
    "host-unreadable",
    "a booking cal.com would not answer for",
  );
}

{
  // Every rung empty is a finding about SLATE, not a disagreement about the host:
  // Slate could not have routed this lead anywhere. It is kept apart from
  // `host-attributes-exclude` because the two send different people to different
  // places (L11).
  const empty = prepareWorld({
    users: [user({ id: "u-x", email: "x@trypennie.com", attributes: { debt_team: ["nothing"] } })],
    buckets: BUCKETS,
  });
  eq(
    classifyLead(lead({ rawCode: "511", hostEmails: ["x@trypennie.com"] }), empty).verdict,
    "bucket-has-nobody",
    "no rung of the ladder holds anybody at all",
  );
  // And with the rungs populated, a host no rung selects is an EXCLUSION rather
  // than a dead ladder. The two must not be reachable by one fixture, or the
  // distinction is decoration (L11).
  eq(
    classifyLead(lead({ rawCode: "511", hostEmails: ["admin@trypennie.com"] }), WORLD).verdict,
    "host-attributes-exclude",
    "a populated ladder makes an unselected host an exclusion",
  );
}

// --- The code the lead carried ---

{
  eq(extractCode({ f1: { label: "xbc", value: 112 } }), "112", "a numeric xbc is read as its digits");
  eq(extractCode({ f1: { label: "xbc", value: "312" } }), "312", "a string xbc is read as itself");
  eq(extractCode({ f1: { label: "XBC", value: "312" } }), "312", "the label is matched case insensitively");
  eq(
    extractCode({ a: { label: "leg", value: "" }, b: { label: "xbc", value: 12 }, c: { label: "bes", value: "" } }),
    "12",
    "the xbc field is picked out of a form carrying several",
  );
  eq(extractCode({ f1: { label: "xbc", value: "" } }), "", "a blank xbc is blank, not missing");
  eq(extractCode({ f1: { label: "adv", value: "3" } }), null, "a form with no xbc field at all");
  eq(extractCode(null), null, "an unreadable response");
}

{
  eq(
    classifyLead(lead({ rawCode: "" }), WORLD).verdict,
    "catchall-absent",
    "a lead that carried no code",
  );
  eq(
    classifyLead(lead({ rawCode: null }), WORLD).verdict,
    "catchall-absent",
    "a lead whose form has no xbc field",
  );
  eq(
    classifyLead(lead({ rawCode: 22 }), WORLD).verdict,
    "catchall-unreadable",
    "a two digit code cal.com stored as a number",
  );
  eq(
    classifyLead(lead({ rawCode: "999" }), WORLD).verdict,
    "catchall-unreadable",
    "a code outside the matrix",
  );
  // The catch-all classes are decided BEFORE the host is looked at, because Slate's
  // answer for such a lead is "the Low pool" whatever cal.com did, and counting
  // them as agreement is what a broken code lookup would exploit.
  eq(
    classifyLead(lead({ rawCode: "", hostEmails: ["stranger@example.com"] }), WORLD).verdict,
    "catchall-absent",
    "a catch-all lead is catch-all whoever it was booked with",
  );
}

// --- The chance baseline ---

{
  // Five bookable agents (gone and held are not), and the Low pool holds three of
  // them. Agreement at 60 percent on a Low lead is therefore worth nothing, which
  // is the whole reason this is reported beside the rate.
  eq(WORLD.bookableCount, 5, "the denominator is the bookable roster");
  eq(poolShare("111", WORLD), 0.6, "the Low pool's share of the bookable roster");
  eq(poolShare("311", WORLD), 0.2, "the High pool's share");
  eq(poolShare("511", WORLD), 0, "an empty pool has a zero share");
  eq(poolShare("nope", WORLD), null, "a code with no bucket has no share to report");
}

// --- The summary, per code and per form ---

{
  const leads: ReplayLead[] = [
    lead({ responseId: 1, rawCode: "311", hostEmails: ["high@trypennie.com"] }),
    lead({ responseId: 2, rawCode: "311", hostEmails: ["med@trypennie.com"] }),
    lead({ responseId: 3, rawCode: "111", hostEmails: ["low@trypennie.com"], formId: "form-b", formName: "Portal" }),
    lead({ responseId: 4, rawCode: "", hostEmails: ["low@trypennie.com"], formId: "form-b", formName: "Portal" }),
    lead({ responseId: 5, rawCode: "311", hostEmails: null }),
  ];
  const s = summarise(leads, WORLD);
  eq(s.leads, 5, "every lead is counted once");
  eq(
    s.byClass.agree + s.byClass["agree-via-ladder"] + s.byClass["catchall-absent"] + s.byClass["host-unreadable"],
    5,
    "and lands in exactly one class",
  );
  const code311 = s.byCode.find((c) => c.code === "311")!;
  eq(code311.leads, 3, "the per code rows count that code's leads");
  eq(code311.baseline, 0.2, "each code row carries its own chance baseline");
  const formB = s.byForm.find((f) => f.formId === "form-b")!;
  eq(formB.leads, 2, "the per form rows count that form's leads");
  eq(formB.formName, "Portal", "and name the form, since an id names nothing to a reader");

  // The two rates the exits are decided on, each over its own denominator.
  eq(s.judged, 3, "a lead is judged only once Slate's ladder got to decide about it");
  eq(s.resolution, 4 / 5, "resolution is the share of leads whose host could be read");
  eq(s.catchallShare, 1 / 5, "the catch-all share is over every lead");
  eq(s.agreement, 1, "agreement is over the JUDGED leads, ladder agreement included");
  eq(s.strictAgreement, 2 / 3, "and the strict rate counts only the requested code");
}

{
  // A host Slate's ROSTER rules out is not a ladder disagreement, and the first
  // live run is the reason this is a separate number: 34 of 328 leads were
  // `host-not-bookable`, not one lead disagreed about the ladder, and folding them
  // together put the headline at 89.6 percent and would have failed the run for a
  // finding `verify:calcom-parity` already owns.
  const leads: ReplayLead[] = [
    lead({ responseId: 1, hostEmails: ["high@trypennie.com"] }),
    lead({ responseId: 2, hostEmails: ["held@trypennie.com"] }),
    lead({ responseId: 3, hostEmails: ["gone@trypennie.com"] }),
    lead({ responseId: 4, hostEmails: ["stranger@example.com"] }),
  ];
  const s = summarise(leads, WORLD);
  eq(s.judged, 1, "only the lead whose host Slate would route to is judged");
  eq(s.agreement, 1, "so the agreement rate is not dragged down by the roster");
  eq(s.roster, 3, "and the roster differences are counted in their own right");
  eq(s.rosterShare, 3 / 4, "as a share of the leads whose host could be read");
  eq(
    replayOutcome({ leads: 4, judged: 1, resolution: 1, catchallShare: 0, agreement: 1 }).exit,
    0,
    "a run whose only misses are roster differences still passes, since another command owns them",
  );
  // The other direction (L159): a genuine ladder miss DOES count.
  const ladder = summarise(
    [lead({ responseId: 5, rawCode: "311", hostEmails: ["admin@trypennie.com"] }), leads[0]!],
    WORLD,
  );
  eq(ladder.judged, 2, "an attribute exclusion is the ladder deciding, so it is judged");
  eq(ladder.agreement, 0.5, "and it lowers the agreement rate");
  eq(ladder.roster, 0, "without being counted as a roster difference");
}

{
  // A lead this run never asked cal.com about moves NOTHING. The first live run
  // is why: a cap of 150 against a window of 1,400 reported "only 10.5 percent of
  // leads had a readable host", which reads as a broken cal.com and was a
  // measurement of the cap (L209). It is counted, because a sample nobody can see
  // the size of is not a sample.
  const leads: ReplayLead[] = [
    lead({ responseId: 1, hostEmails: ["high@trypennie.com"] }),
    lead({ responseId: 2, sampled: false, hostEmails: null }),
    lead({ responseId: 3, sampled: false, hostEmails: null }),
  ];
  const s = summarise(leads, WORLD);
  eq(s.leadsInWindow, 3, "the window's volume is still reported");
  eq(s.leads, 1, "but only the sampled lead is a denominator");
  eq(s.notSampled, 2, "and the unsampled ones are counted out loud");
  eq(s.resolution, 1, "resolution is over what was asked about, not over the window");
  eq(s.byClass["host-unreadable"], 0, "an unsampled lead is not an unreadable host");
  eq(s.agreement, 1, "and the agreement rate is unmoved by the cap");
  // The other direction (L159): the same leads, sampled and unreadable, DO move it.
  const asked = summarise(
    leads.map((l) => ({ ...l, sampled: true })),
    WORLD,
  );
  eq(asked.resolution, 1 / 3, "a lead that WAS asked about and came back empty lowers resolution");
}

// --- What a run exits on ---

const base = {
  leads: 100,
  judged: 95,
  resolution: 0.95,
  catchallShare: 0.05,
  agreement: 1,
  strictAgreement: 1,
  byClass: {} as Record<string, number>,
};

{
  eq(replayOutcome({ ...base }).exit, 0, "a run that agrees everywhere exits zero");
  eq(
    replayOutcome({ ...base, leads: 0 }).exit,
    REPLAY_EXIT["nothing-judged"],
    "no leads at all is never a pass",
  );
  eq(
    replayOutcome({ ...base, judged: 0 }).exit,
    REPLAY_EXIT["nothing-judged"],
    "leads nothing could judge is never a pass either",
  );
  eq(
    replayOutcome({ ...base, resolution: 0.8 }).exit,
    REPLAY_EXIT["resolution-too-low"],
    "too few hosts resolved to trust the rate",
  );
  eq(
    replayOutcome({ ...base, catchallShare: 0.2 }).exit,
    REPLAY_EXIT["catchall-too-high"],
    "too many leads in the catch-all, which is what a broken code lookup looks like",
  );
  eq(
    replayOutcome({ ...base, agreement: 0.5 }).exit,
    REPLAY_EXIT.disagreement,
    "a real disagreement",
  );
  // Ranked: a run that cannot be trusted must not report the disagreement it
  // computed from untrustworthy input.
  eq(
    replayOutcome({ ...base, resolution: 0.5, agreement: 0.5 }).exit,
    REPLAY_EXIT["resolution-too-low"],
    "an untrustworthy run reports why it is untrustworthy, not what it computed",
  );
  // Every exit code is distinct, or one outcome answers for another (L11). The
  // table covers the wiring outcomes too, which is the point of keeping it here
  // rather than in the command.
  const codes = Object.values(REPLAY_EXIT);
  eq(new Set(codes).size, codes.length, "no two outcomes share an exit code");
  assert(codes.every((c) => c > 0), "every non-agreement outcome exits non-zero");
  for (const named of [
    "not-configured",
    "slate-unreadable",
    "calcom-unreadable",
    "hosts-unreadable",
  ] as const) {
    assert(typeof REPLAY_EXIT[named] === "number", `${named} has a code of its own`);
  }
}

// --- Which cached booking readings a run may trust ---------------------------

{
  const NOW = Date.parse("2026-09-11T12:00:00.000Z");
  const past = "2026-09-01T15:00:00.000Z";
  const entry = (over: Partial<{ start: string | null; fetchedAt: string }> = {}) => ({
    start: past,
    fetchedAt: "2026-09-11T11:00:00.000Z",
    ...over,
  });

  assert(freshBooking(entry(), NOW), "a recent reading of a call that has happened is trusted");
  assert(!freshBooking(undefined, NOW), "nothing cached is not fresh");
  assert(
    !freshBooking(entry({ fetchedAt: "2026-09-08T11:00:00.000Z" }), NOW),
    "a reading older than the stale bound is re-read",
  );
  assert(
    !freshBooking(entry({ start: "2026-09-20T15:00:00.000Z" }), NOW),
    "a call that has not happened yet is re-read, since it can still move or be cancelled",
  );
  // The unreadable cases. NaN compares false against every bound, so a stamp
  // nothing can read would otherwise land on whichever branch the comparison's
  // shape happens to give it, and here that branch is TRUST (L50).
  assert(!freshBooking(entry({ start: null }), NOW), "an entry with no start is not vouched for");
  assert(!freshBooking(entry({ start: "not a date" }), NOW), "nor one whose start cannot be read");
  assert(
    !freshBooking(entry({ fetchedAt: "not a date" }), NOW),
    "nor one whose own read stamp cannot be read",
  );
  // The bound is a parameter, so the case above is about the rule and not about
  // the constant (L401).
  assert(
    freshBooking(entry({ fetchedAt: "2026-09-08T11:00:00.000Z" }), NOW, 10 * 86_400_000),
    "the stale bound really is what decides it",
  );
  eq(BOOKING_STALE_MS, 2 * 86_400_000, "the default bound is two days");
}

// --- How a capped run divides its budget between the two windows --------------

{
  // The plain case: both windows have more than half a budget's worth waiting.
  eq(splitBudget(500, 500, 300), { recent: 150, older: 150 }, "an even split when both have work");
  // The case the first live run got wrong: everything newest-first, so the older
  // window was never sampled and reported a copy of the newer one.
  assert(splitBudget(25000, 24000, 300).older > 0, "the older window is always sampled");
  // An idle half hands its remainder over rather than leaving reads unspent, which
  // is the ordinary case once the older window has been cached by earlier runs.
  eq(splitBudget(500, 0, 300), { recent: 300, older: 0 }, "nothing older to ask about");
  eq(splitBudget(0, 500, 300), { recent: 0, older: 300 }, "nothing newer to ask about");
  eq(splitBudget(40, 500, 300), { recent: 40, older: 260 }, "a small newer half hands the rest over");
  eq(splitBudget(500, 40, 300), { recent: 260, older: 40 }, "and so does a small older half");
  // Never more than the budget, whatever is waiting.
  for (const [r, o] of [[0, 0], [1, 1], [9, 9], [1000, 1000], [3, 1000]] as const) {
    const s = splitBudget(r, o, 300);
    assert(s.recent + s.older <= 300, `the split never exceeds the budget (${r}, ${o})`);
    assert(s.recent <= r && s.older <= o, `and never asks for more than is waiting (${r}, ${o})`);
  }
  eq(splitBudget(100, 100, 0), { recent: 0, older: 0 }, "a zero budget asks about nothing");
}

finish();