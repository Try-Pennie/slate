// What the daily cal.com parity sweep says, and when it says nothing (#2031).
//
// `pnpm verify:calcom-parity` compares the two systems' rosters and the working
// week they each hold for it. It is hand run, so it finds what it finds on the day
// somebody remembers: 97 schedules were imported on 2026-09-02 and verified
// idempotent the same day, and five days later 21 of 102 agents had drifted, three
// of them not being offered a day they actually work. The sweep is too expensive
// for the Worker's cron budget (roughly one cal.com read per agent, against four
// lanes sharing one invocation), so it runs on a GitHub schedule and REPORTS here.
//
// This module is the judgement, kept pure and kept in src/ for two reasons. The
// alert has to go through the app's own dispatcher to get a cooldown and an all
// clear, since a runner has nowhere to remember what it said yesterday. And the
// endpoint that receives a sweep has to refuse a verdict it does not know: the
// classification below is that vocabulary, and `calcom-parity-outcome.ts` asserts
// against it at compile time, so a verdict renamed on the command's side fails the
// build rather than arriving as an unclassified finding nobody is paged about.

/** What a verdict is worth waking somebody for. */
export type ParityVerdictClass =
  /** It changes who a lead is booked with, or when. Worth a message. */
  | "paging"
  /** Real, and it will not clear on its own, so a daily page would be red forever. */
  | "standing"
  /** This agent could not be compared at all, which is not a finding about them. */
  | "unmeasured";

/**
 * Every verdict `pnpm verify:calcom-parity` can report, and what it is worth.
 *
 * The three classes exist because they need three different behaviours, not three
 * different words. A paging verdict is something to go and fix today. A standing
 * one is true, known, and unfixable by anyone in a hurry: `cfrank@` and `jsaminu@`
 * hold a cal.com schedule with no windows in it, so paging on that class would put
 * the check permanently red, and a permanently red check is one nobody reads by
 * the second week (L36). An unmeasured one is the absence of a comparison, and
 * counting it as agreement is how a blind check reads as a healthy one (L98).
 *
 * The order within `paging` follows `OUTCOME_ORDER`: the two roster findings that
 * put a real lead in front of the wrong person, then the three that change what a
 * lead is offered, then the ones where Slate and cal.com disagree about who is in
 * the pool at all, including the two (#3963) where no Slate routing pool reaches
 * somebody who is bookable.
 */
export const PARITY_VERDICT_CLASS = {
  "departed-still-hosting": "paging",
  "held-back-still-hosting": "paging",
  "timezone-differs": "paging",
  "days-differ": "paging",
  "hours-differ": "paging",
  "bookable-not-hosting": "paging",
  // Slate offers a lead somebody cal.com holds and has decided not to route to
  // (#2088). It pages for the same reason its neighbour does, and it is the louder
  // of the two: the incumbent made this decision explicitly.
  "bookable-not-routable": "paging",
  // The other direction (#3963): cal.com routes them, no Slate pool reaches them,
  // so at cutover they get no leads. It read as agreement before.
  "in-no-pool-still-routed": "paging",
  "absent-from-slate": "paging",
  // Bookable in Slate and in no routing pool, so neither system offers them
  // (#3963). It pages because it is fixable today and only by a person: their debt
  // tier is tagged in Twilio and the roster sync does the rest. It used to arrive
  // as `bookable-not-hosting`, which claimed Slate offers them.
  "bookable-in-no-pool": "paging",
  // Nine admins, managers and team leads who host in cal.com and are correctly not
  // bookable in Slate. It is the commonest non-agreement the sweep produces, and it
  // is deliberately absent from `OUTCOME_ORDER` because an exit code for it would
  // fail every run forever. It still has to be CLASSIFIED: the sweep sends every
  // verdict it produced, and a table keyed on the outcomes that can fail a run had
  // no entry for this one, so the endpoint refused the whole payload and the daily
  // check reported nothing while looking configured.
  "staff-not-bookable": "standing",
  // A cal.com host address that is deliberately not a Slate user, named with its
  // reason in `KNOWN_NON_SLATE_HOSTS` (scripts/lib/roster-parity.ts). It is
  // `absent-from-slate` with the one thing that makes that verdict actionable
  // removed: there is no missing row to create. Paging on it would leave this
  // check red for as long as the account exists, and it is still COUNTED in the
  // standing total, so the exemption is knowable rather than invisible.
  "known-not-in-slate": "standing",
  // Worth closing, never worth waking somebody for: they carry no routing
  // attributes, so no bucket could match them however long this sits.
  "not-bookable-by-design": "standing",
  "no-slate-schedule": "standing",
  "no-calcom-schedule": "standing",
  "no-calcom-user": "standing",
  // A real difference on a week the AGENT set for themselves (#2092). The daily
  // lane corrects hours from cal.com automatically now and deliberately refuses to
  // overwrite these, so nothing automatic will ever clear it: paging daily would
  // leave the check red for as long as the agent keeps their own hours, which is
  // from cutover onwards for everybody (#1454). Counted in the standing total, so
  // it is knowable rather than invisible.
  "hours-set-by-agent": "standing",
  "calcom-unreadable": "unmeasured",
  "calcom-unreachable": "unmeasured",
} as const satisfies Record<string, ParityVerdictClass>;

export type ParityVerdict = keyof typeof PARITY_VERDICT_CLASS;

type StandingVerdict = {
  [V in ParityVerdict]: (typeof PARITY_VERDICT_CLASS)[V] extends "standing" ? V : never;
}[ParityVerdict];

/**
 * How each standing verdict is said in the all clear, and which line it joins.
 *
 * Every one has its own words because the all clear of 2026-10-21 summed them into
 * "21 still have no week to compare on one side", which was true of none of the
 * 21: ten were agents keeping their own hours, ten were staff who host in cal.com,
 * and one was a host who is deliberately not in Slate. Keyed on the classification,
 * so a standing verdict added tomorrow fails the build until it is given words.
 *
 * `own` is compared and differs on purpose, `missing` could not be compared for a
 * reason worth fixing, and `expected` is somebody nobody should compare.
 */
const STANDING_WORDS: Record<StandingVerdict, { line: "own" | "missing" | "expected"; one: string; many: string }> = {
  "staff-not-bookable": {
    line: "expected",
    one: "manager or admin who hosts in cal.com",
    many: "managers or admins who host in cal.com",
  },
  "known-not-in-slate": {
    line: "expected",
    one: "cal.com host who is not in Slate",
    many: "cal.com hosts who are not in Slate",
  },
  "not-bookable-by-design": {
    line: "expected",
    one: "cal.com host no pool could route to",
    many: "cal.com hosts no pool could route to",
  },
  "no-slate-schedule": { line: "missing", one: "has no week in Slate to compare", many: "have no week in Slate to compare" },
  "no-calcom-schedule": { line: "missing", one: "has no week in cal.com to compare", many: "have no week in cal.com to compare" },
  "no-calcom-user": { line: "missing", one: "has no cal.com account to compare", many: "have no cal.com account to compare" },
  "hours-set-by-agent": {
    line: "own",
    one: "keeps hours they set themselves, which the import leaves alone",
    many: "keep hours they set themselves, which the import leaves alone",
  },
};

/**
 * How each paging verdict is said to a person, in the vocabulary of the roster, at
 * one agent and at many. Both forms are written out because the verb is what
 * changes ("1 works", "6 work"), and a sentence that counts its noun but not its
 * verb is what shipped "1 agent were corrected" (#3963).
 */
const PAGING_LABEL: Record<string, { one: string; many: string }> = {
  "departed-still-hosting": {
    one: "has left Slate and can still be booked in cal.com",
    many: "have left Slate and can still be booked in cal.com",
  },
  "held-back-still-hosting": {
    one: "Slate will not route to and cal.com still can",
    many: "Slate will not route to and cal.com still can",
  },
  "timezone-differs": { one: "is in a different timezone", many: "are in a different timezone" },
  "days-differ": { one: "works different days", many: "work different days" },
  "hours-differ": { one: "works different hours", many: "work different hours" },
  "bookable-not-hosting": {
    one: "Slate offers and cal.com does not list at all",
    many: "Slate offers and cal.com does not list at all",
  },
  "bookable-not-routable": {
    one: "Slate offers and cal.com withholds from routing",
    many: "Slate offers and cal.com withholds from routing",
  },
  "absent-from-slate": {
    one: "hosts in cal.com and has no Slate record",
    many: "host in cal.com and have no Slate record",
  },
  "bookable-in-no-pool": {
    one: "is bookable in Slate and in no routing pool, so neither system offers them",
    many: "are bookable in Slate and in no routing pool, so neither system offers them",
  },
  "in-no-pool-still-routed": {
    one: "is bookable in Slate and in no routing pool while cal.com still routes them leads",
    many: "are bookable in Slate and in no routing pool while cal.com still routes them leads",
  },
};

/**
 * The words after the count for one paging verdict. Exported for
 * `pnpm verify:parallel-run-readiness` (#2089), so its drift line and this page
 * name a difference in the same words at the same count.
 */
export function pagingLabel(verdict: string, count: number): string {
  const label = PAGING_LABEL[verdict];
  if (!label) return verdict;
  return count === 1 ? label.one : label.many;
}

/** One or many, by count: the one place a sentence here picks its verb (#3963). */
function byCount(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** One verdict's share of a sweep, as the run reported it. */
export interface ParityFinding {
  verdict: string;
  count: number;
  /** Who, so the reader can go and look. Capped by the sender, trimmed again here. */
  agents: string[];
}

/**
 * What the daily lane repaired by itself before it swept (#2092).
 *
 * ABSENT and zero are different facts and are kept apart. Absent means no apply
 * ran at all (the step crashed, or somebody swept by hand), so re-importing is
 * still the remedy and the message says so. Zero means the import ran and found
 * nothing to write, so naming that command would be advice that cannot work
 * (L111). Collapsing the two would make the commonest healthy morning
 * indistinguishable from a broken apply step.
 */
export interface ParityCorrection {
  count: number;
  /** Who, so the reader can check what was written to whom. Capped by the sender. */
  agents: string[];
}

/** A finished sweep, as the runner reports it. */
export interface ParitySweep {
  /** Agents looked at. */
  total: number;
  /** Agents that had a week on BOTH sides, so a difference could be seen. */
  compared: number;
  findings: ParityFinding[];
  runUrl: string;
  /** Absent when no apply ran. See `ParityCorrection`. */
  corrected?: ParityCorrection;
}

export interface ParityJudgement {
  action: "page" | "all-clear" | "unmeasured";
  total: number;
  compared: number;
  /** Agents carrying a paging verdict. */
  drifted: number;
  /** Agents in a standing condition, counted so it is knowable and never paged. */
  standing: number;
  /** The standing findings one by one, in `PARITY_VERDICT_CLASS` order, so the all
   *  clear can say what each one is rather than one sum of unlike things. */
  standingFindings: ParityFinding[];
  /** Agents nothing could be learned about. */
  unmeasured: number;
  /** Only the paging findings, worst first, in `PARITY_VERDICT_CLASS` order. */
  paging: ParityFinding[];
  /** Carried through untouched: what the lane repaired is a fact about the run,
   *  not a verdict, so it takes no part in deciding whether anybody is paged. */
  corrected?: ParityCorrection;
  runUrl: string;
}

const CLASS_ORDER = Object.keys(PARITY_VERDICT_CLASS);

/**
 * Which of the three things a sweep is.
 *
 * The order of the tests matters. "Nothing was compared" is asked FIRST, because a
 * sweep that reached nobody has no findings either, and reading that as agreement
 * is the exact shape a fail safe detector goes blind in: silence and health render
 * identically (#1394). A sweep that compared most of the roster and lost a couple
 * of agents to a rate limit still clears, and says how many it lost.
 */
export function classifyParitySweep(sweep: ParitySweep): ParityJudgement {
  const paging: ParityFinding[] = [];
  const standingFindings: ParityFinding[] = [];
  let standing = 0;
  let unmeasured = 0;
  for (const f of sweep.findings) {
    const cls = PARITY_VERDICT_CLASS[f.verdict as ParityVerdict];
    if (cls === "paging") paging.push(f);
    else if (cls === "standing") {
      standing += f.count;
      standingFindings.push(f);
    }
    else if (cls === "unmeasured") unmeasured += f.count;
  }
  const byClassOrder = (a: ParityFinding, b: ParityFinding) =>
    CLASS_ORDER.indexOf(a.verdict) - CLASS_ORDER.indexOf(b.verdict);
  paging.sort(byClassOrder);
  standingFindings.sort(byClassOrder);
  const drifted = paging.reduce((n, f) => n + f.count, 0);
  const action: ParityJudgement["action"] =
    sweep.compared <= 0 ? "unmeasured" : paging.length > 0 ? "page" : "all-clear";
  return {
    action,
    total: sweep.total,
    compared: sweep.compared,
    drifted,
    standing,
    standingFindings,
    unmeasured,
    paging,
    corrected: sweep.corrected,
    runUrl: sweep.runUrl,
  };
}

/** How many agents a line names before it points at the run instead. */
const NAMED_AGENT_CAP = 4;

function agentList(f: ParityFinding): string {
  const named = f.agents.slice(0, NAMED_AGENT_CAP);
  if (named.length === 0) return "";
  const rest = f.count - named.length;
  return `: ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

function agentWord(n: number): string {
  return byCount(n, "agent", "agents");
}

/** What the lane wrote this morning, or nothing when no apply ran (#2092). */
function correctionLine(c: ParityCorrection | undefined): string | null {
  if (!c || c.count === 0) return null;
  const named = c.agents.slice(0, NAMED_AGENT_CAP);
  const rest = c.count - named.length;
  const who = named.length > 0 ? `: ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}` : "";
  return `${c.count} ${agentWord(c.count)} ${byCount(c.count, "was", "were")} corrected from cal.com automatically${who}.`;
}

/**
 * The page. Headline, what the lane fixed, one line per kind of difference left,
 * then what a person still has to do.
 *
 * THE REMEDY LINE DEPENDS ON WHETHER THE LANE APPLIED. It used to be unconditional,
 * because re-importing was the fix for every hours, days and zone difference seen
 * on 2026-09-07. Since #2092 the lane runs that import itself before it sweeps, so
 * telling the reader to run it is naming a command whose only effect is to repeat
 * what already happened, which is a dead instruction (L111). What is left after an
 * apply is what the import REFUSED (a week the agent owns, a week Slate's validator
 * will not take) or could not write, and that needs a person rather than a re-run.
 *
 * The roster findings have no command either way, deliberately: the answer to
 * somebody who has left is a person deciding which system is wrong.
 */
export function buildScheduleParityAlert(j: ParityJudgement): string {
  // Count, then scale, and no ratio between them. The sweep's total is everybody
  // either roster names, departed users and staff included, so "12 of 160" read as
  // a small drift among the bookable agents; and the compared count cannot be the
  // denominator either, since a roster finding (somebody who left and still
  // hosts) is about a person outside it.
  const head =
    `${j.drifted} ${agentWord(j.drifted)} ${byCount(j.drifted, "differs", "differ")} between Slate and cal.com. ` +
    `${j.compared} bookable ${agentWord(j.compared)} ${byCount(j.compared, "was", "were")} compared.`;
  const lines = j.paging.map(
    (f) => `${f.count} ${pagingLabel(f.verdict, f.count)}${agentList(f)}`,
  );
  const tail: string[] = [];
  const corrected = correctionLine(j.corrected);
  if (corrected) tail.push(corrected);
  if (j.unmeasured > 0) {
    tail.push(`${j.unmeasured} could not be read, so nothing is claimed about them.`);
  }
  const hoursDrift = j.paging
    .filter((f) => f.verdict === "hours-differ" || f.verdict === "days-differ" || f.verdict === "timezone-differs")
    .reduce((n, f) => n + f.count, 0);
  if (hoursDrift > 0) {
    tail.push(
      j.corrected === undefined
        ? "Re-import the hours with APPLY=1 pnpm import:calcom-schedules"
        : `The import already ran this morning and could not fix ${byCount(hoursDrift, "this one, so it needs", "these, so they need")} a person. The run says which it refused.`,
    );
  }
  // #3963: the fix for somebody in no pool is in Twilio, not in either system the
  // comparison reads, so the page says where rather than leaving it to be guessed.
  if (j.paging.some((f) => f.verdict === "bookable-in-no-pool" || f.verdict === "in-no-pool-still-routed")) {
    tail.push("Tag their debt tier in Twilio, and the roster sync gives them the attributes a pool matches.");
  }
  return [head, ...lines, ...tail, j.runUrl].join("\n");
}

/**
 * The all clear, which may only be built from a sweep that actually compared
 * agents. `classifyParitySweep` is what enforces that; this states the number it
 * compared so a reader can tell a full sweep from a thin one at a glance, rather
 * than having to trust the word "all" (#1152).
 *
 * It does NOT state the sweep's total. That is everybody either roster names,
 * departed users and staff included, so "95 of 160 compared" read as 59% coverage
 * on a morning every bookable agent was compared. What was not compared is said
 * instead, each group for what it is.
 */
export function buildScheduleParityAllClear(j: ParityJudgement): string {
  const said = j.standingFindings.flatMap((f) => {
    const words = STANDING_WORDS[f.verdict as StandingVerdict];
    return words ? [{ ...words, count: f.count }] : [];
  });
  const own = said.filter((w) => w.line === "own").reduce((n, w) => n + w.count, 0);
  const parts = [
    own > 0
      ? `Both systems agree again: ${j.compared} ${agentWord(j.compared)} compared, ${Math.max(0, j.compared - own)} identical.`
      : `Both systems agree again: ${j.compared} ${agentWord(j.compared)} compared, no differences.`,
  ];
  // A morning where the lane repaired twenty agents and a morning where nothing
  // had drifted are not the same event, and rendering them identically hides the
  // whole thing the lane does (L680).
  const corrected = correctionLine(j.corrected);
  if (corrected) parts.push(corrected);
  for (const w of said) {
    if (w.line !== "expected") parts.push(`${w.count} ${byCount(w.count, w.one, w.many)}.`);
  }
  // The all clear claims only the agents it compared, so the ones it lost are
  // said rather than left out of the count (L98).
  if (j.unmeasured > 0) {
    parts.push(`${j.unmeasured} could not be read, so nothing is claimed about them.`);
  }
  const expected = said
    .filter((w) => w.line === "expected")
    .map((w) => `${w.count} ${byCount(w.count, w.one, w.many)}`);
  if (expected.length > 0) parts.push(`Not compared, as expected: ${expected.join(", ")}.`);
  return parts.join("\n");
}

// --- reading a sweep off the wire -------------------------------------------------

/** How many agents one finding may name before the rest are dropped. */
const WIRE_AGENT_CAP = 8;
/**
 * How many findings one sweep may report: one per verdict, since the sweep sends
 * each verdict once. DERIVED from the vocabulary rather than written as a number,
 * because it was a literal 20 while the verdicts grew to 19 (#3963), and the next
 * one would have had the endpoint refuse every sweep carrying them all.
 */
const WIRE_FINDING_CAP = Object.keys(PARITY_VERDICT_CLASS).length;
/** Long enough for an email plus a name, short enough that one cannot fill a page. */
const WIRE_AGENT_CHARS = 120;
/** The only place a run link may point. */
const RUN_URL_PREFIX = "https://github.com/";

/**
 * Turn an untrusted body into a sweep, or say why not.
 *
 * The caller holds the booking API key, which makes this a trusted CALLER and not
 * trusted CONTENT: what it sends is rendered into an alert somebody reads on a
 * phone and acts on. Two things are therefore closed rather than validated loosely.
 * The verdict is a vocabulary, refused unless it is one in `PARITY_VERDICT_CLASS`, the ones the sweep
 * can actually produce, so no name reaches the copy that the classification does
 * not know what to do with. And the run link may only be a GitHub URL, because it
 * is the one part of the message a reader clicks without reading.
 *
 * A long agent list is TRIMMED rather than refused: the sender already caps it, the
 * cap here is a second one, and refusing a sweep over a cosmetic overrun would lose
 * a real finding to a formatting detail.
 */
export function parseParitySweep(body: unknown): ParitySweep | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body is not an object" };
  const b = body as Record<string, unknown>;

  const total = wholeNumber(b.total);
  if (total === null) return { error: "total is not a count" };
  const compared = wholeNumber(b.compared);
  if (compared === null) return { error: "compared is not a count" };
  if (compared > total) return { error: "compared is greater than total" };

  const runUrl = typeof b.runUrl === "string" ? b.runUrl.trim() : "";
  if (!runUrl.startsWith(RUN_URL_PREFIX) || runUrl.length > 300) {
    return { error: "runUrl is not a GitHub run link" };
  }

  if (!Array.isArray(b.findings)) return { error: "findings is not a list" };
  if (b.findings.length > WIRE_FINDING_CAP) return { error: "too many findings" };

  const findings: ParityFinding[] = [];
  for (const raw of b.findings) {
    if (typeof raw !== "object" || raw === null) return { error: "a finding is not an object" };
    const f = raw as Record<string, unknown>;
    const verdict = typeof f.verdict === "string" ? f.verdict : "";
    if (!(verdict in PARITY_VERDICT_CLASS)) return { error: `unknown verdict: ${safeLabel(verdict)}` };
    const count = wholeNumber(f.count);
    if (count === null) return { error: `${verdict} has no count` };
    const agents = Array.isArray(f.agents)
      ? f.agents
          .filter((a): a is string => typeof a === "string")
          .slice(0, WIRE_AGENT_CAP)
          .map((a) => a.slice(0, WIRE_AGENT_CHARS))
      : [];
    findings.push({ verdict, count, agents });
  }

  // What the lane repaired (#2092). OPTIONAL, so a hand run sweep and every
  // deployment that predates the apply step are still accepted; present and
  // malformed is REFUSED rather than dropped, because a number rendered into a
  // message somebody acts on may not be a guess.
  let corrected: ParityCorrection | undefined;
  if (b.corrected !== undefined) {
    if (typeof b.corrected !== "object" || b.corrected === null || Array.isArray(b.corrected)) {
      return { error: "corrected is not an object" };
    }
    const c = b.corrected as Record<string, unknown>;
    const count = wholeNumber(c.count);
    if (count === null) return { error: "corrected has no count" };
    // A lane cannot have repaired more agents than the sweep looked at. It is the
    // same refusal `compared > total` gets above and for the same reason: a count
    // that cannot be true makes every other number in the message unreadable.
    if (count > total) return { error: "corrected is greater than total" };
    const agents = Array.isArray(c.agents)
      ? c.agents
          .filter((a): a is string => typeof a === "string")
          .slice(0, WIRE_AGENT_CAP)
          .map((a) => a.slice(0, WIRE_AGENT_CHARS))
      : [];
    corrected = { count, agents };
  }

  return { total, compared, findings, runUrl, corrected };
}

function wholeNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : null;
}

/** A refused verdict is echoed back to the caller, so it may not carry its own text. */
function safeLabel(v: string): string {
  return v.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "(empty)";
}
