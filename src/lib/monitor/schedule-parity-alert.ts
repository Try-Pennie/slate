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
 * lead is offered, then the two where Slate and cal.com disagree about who is in
 * the pool at all.
 */
export const PARITY_VERDICT_CLASS = {
  "departed-still-hosting": "paging",
  "held-back-still-hosting": "paging",
  "timezone-differs": "paging",
  "days-differ": "paging",
  "hours-differ": "paging",
  "bookable-not-hosting": "paging",
  "absent-from-slate": "paging",
  // Worth closing, never worth waking somebody for: they carry no routing
  // attributes, so no bucket could match them however long this sits.
  "not-bookable-by-design": "standing",
  "no-slate-schedule": "standing",
  "no-calcom-schedule": "standing",
  "no-calcom-user": "standing",
  // A zone NAME that keeps the same clock. Denver against Boise differs on 0 of
  // 9,600 sampled hours, so it changes nothing a lead sees; reported so drift is
  // knowable, and never allowed to bury something real.
  "timezone-name-differs": "standing",
  "calcom-unreadable": "unmeasured",
  "calcom-unreachable": "unmeasured",
} as const satisfies Record<string, ParityVerdictClass>;

export type ParityVerdict = keyof typeof PARITY_VERDICT_CLASS;

/** How each paging verdict is said to a person, in the vocabulary of the roster. */
const PAGING_LABEL: Record<string, string> = {
  "departed-still-hosting": "have left Slate and can still be booked in cal.com",
  "held-back-still-hosting": "Slate will not route to and cal.com still can",
  "timezone-differs": "are in a different timezone",
  "days-differ": "work different days",
  "hours-differ": "work different hours",
  "bookable-not-hosting": "Slate offers and cal.com never routes to",
  "absent-from-slate": "host in cal.com and have no Slate record",
};

/** One verdict's share of a sweep, as the run reported it. */
export interface ParityFinding {
  verdict: string;
  count: number;
  /** Who, so the reader can go and look. Capped by the sender, trimmed again here. */
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
}

export interface ParityJudgement {
  action: "page" | "all-clear" | "unmeasured";
  total: number;
  compared: number;
  /** Agents carrying a paging verdict. */
  drifted: number;
  /** Agents in a standing condition, counted so it is knowable and never paged. */
  standing: number;
  /** Agents nothing could be learned about. */
  unmeasured: number;
  /** Only the paging findings, worst first, in `PARITY_VERDICT_CLASS` order. */
  paging: ParityFinding[];
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
  let standing = 0;
  let unmeasured = 0;
  for (const f of sweep.findings) {
    const cls = PARITY_VERDICT_CLASS[f.verdict as ParityVerdict];
    if (cls === "paging") paging.push(f);
    else if (cls === "standing") standing += f.count;
    else if (cls === "unmeasured") unmeasured += f.count;
  }
  paging.sort((a, b) => CLASS_ORDER.indexOf(a.verdict) - CLASS_ORDER.indexOf(b.verdict));
  const drifted = paging.reduce((n, f) => n + f.count, 0);
  const action: ParityJudgement["action"] =
    sweep.compared <= 0 ? "unmeasured" : paging.length > 0 ? "page" : "all-clear";
  return {
    action,
    total: sweep.total,
    compared: sweep.compared,
    drifted,
    standing,
    unmeasured,
    paging,
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
  return n === 1 ? "agent" : "agents";
}

/**
 * The page. Headline, then one line per kind of difference, then what to run.
 *
 * The remedy is named because it is one command for the commonest case by far:
 * every hours, days and zone difference on 2026-09-07 was fixed by re-importing.
 * The roster findings have no such command and deliberately get none here, since
 * the answer to somebody who has left is a person deciding which system is wrong.
 */
export function buildScheduleParityAlert(j: ParityJudgement): string {
  const head = `${j.drifted} of ${j.total} ${agentWord(j.total)} differ between Slate and cal.com.`;
  const lines = j.paging.map(
    (f) => `${f.count} ${PAGING_LABEL[f.verdict] ?? f.verdict}${agentList(f)}`,
  );
  const tail: string[] = [];
  if (j.unmeasured > 0) {
    tail.push(`${j.unmeasured} could not be read, so nothing is claimed about them.`);
  }
  const hoursDrift = j.paging.some((f) =>
    f.verdict === "hours-differ" || f.verdict === "days-differ" || f.verdict === "timezone-differs",
  );
  if (hoursDrift) tail.push("Re-import the hours with APPLY=1 pnpm import:calcom-schedules");
  return [head, ...lines, ...tail, j.runUrl].join("\n");
}

/**
 * The all clear, which may only be built from a sweep that actually compared
 * agents. `classifyParitySweep` is what enforces that; this states the number it
 * compared so a reader can tell a full sweep from a thin one at a glance, rather
 * than having to trust the word "all" (#1152).
 */
export function buildScheduleParityAllClear(j: ParityJudgement): string {
  const parts = [
    `Both systems agree again: ${j.compared} of ${j.total} ${agentWord(j.total)} compared, no differences.`,
  ];
  if (j.standing > 0) {
    parts.push(`${j.standing} still have no week to compare on one side, unchanged.`);
  }
  return parts.join("\n");
}

// --- reading a sweep off the wire -------------------------------------------------

/** How many agents one finding may name before the rest are dropped. */
const WIRE_AGENT_CAP = 8;
/** How many distinct verdicts one sweep may report. There are fourteen in total. */
const WIRE_FINDING_CAP = 20;
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
 * The verdict is a vocabulary, refused unless it is one of the fourteen the sweep
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
  return { total, compared, findings, runUrl };
}

function wholeNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : null;
}

/** A refused verdict is echoed back to the caller, so it may not carry its own text. */
function safeLabel(v: string): string {
  return v.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "(empty)";
}
